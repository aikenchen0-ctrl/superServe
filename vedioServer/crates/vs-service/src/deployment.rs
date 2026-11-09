// 改编OpenDAL 0.59.5 FutureWrite::if_match的条件替换示例；
// 复用锁定SDK签名与传输，部署记录、先决校验和不确定结果核对为本项目适配。
use std::{future::IntoFuture, sync::Arc, time::Duration};

use futures_util::StreamExt;
use opendal::{ErrorKind, Operator};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vs_core::{catalog::PublicCatalog, recall::RecallScoring, valid_id};
use vs_storage::S3Config;

use crate::{
    ProfileHistoryCheckpoint, ProfileRemoteConfig,
    profile_client::ProfileClient,
    qdrant_recall::{QdrantConfig, QdrantRecall},
    rank_model::{MAX_RANK_MODEL_BYTES, validate_rank_model},
    s3_catalog::S3CatalogRepository,
    s3_publication::s3_operator,
};

const MAX_RECORD: usize = 8192;
const SCHEMA: &str = "deployment-activation-v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "backend", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeploymentRecall {
    Catalog,
    #[serde(rename = "model-topk")]
    ModelTopK,
    #[serde(rename = "model-pruned")]
    ModelPruned,
    #[serde(rename = "model-blockmax")]
    ModelBlockMax,
    Grouped,
    Qdrant {
        endpoint: String,
        scoring: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentTarget {
    pub catalog_version: String,
    pub catalog_sha256: String,
    pub profile_authority: String,
    pub recall: DeploymentRecall,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_minimum: Option<ProfileHistoryCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank_model_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRecord {
    pub schema: String,
    pub channel: String,
    pub generation: u64,
    pub operation_id: String,
    pub previous_sha256: Option<String>,
    pub target: DeploymentTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_checkpoint: Option<ProfileHistoryCheckpoint>,
}

#[derive(Clone)]
pub struct DeploymentSnapshot {
    record: DeploymentRecord,
    sha256: String,
    etag: String,
    scope: [u8; 32],
}

impl DeploymentSnapshot {
    pub fn record(&self) -> &DeploymentRecord {
        &self.record
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Clone, Serialize)]
pub struct DeploymentSelection {
    pub channel: String,
    pub generation: u64,
    pub sha256: String,
    pub operation_id: String,
}

impl DeploymentSnapshot {
    pub fn selection(&self) -> DeploymentSelection {
        DeploymentSelection {
            channel: self.record.channel.clone(),
            generation: self.record.generation,
            sha256: self.sha256.clone(),
            operation_id: self.record.operation_id.clone(),
        }
    }
}

pub struct DeploymentCredentials {
    pub profile_token: String,
    pub qdrant_api_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentFailure {
    InvalidInput,
    Busy,
    Storage,
    TimedOut,
    Prerequisite,
    Conflict,
    Uncertain,
}

#[derive(Debug, Serialize)]
pub struct DeploymentError {
    pub kind: DeploymentFailure,
    pub stage: &'static str,
    pub activation_may_have_succeeded: bool,
}

impl DeploymentError {
    fn new(kind: DeploymentFailure, stage: &'static str) -> Self {
        Self {
            kind,
            stage,
            activation_may_have_succeeded: false,
        }
    }
}

impl std::fmt::Display for DeploymentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let description = match self.kind {
            DeploymentFailure::InvalidInput => "部署参数无效",
            DeploymentFailure::Busy => "部署操作预算已满",
            DeploymentFailure::Storage => "部署存储操作失败",
            DeploymentFailure::TimedOut => "部署存储操作超时",
            DeploymentFailure::Prerequisite => "部署先决校验失败",
            DeploymentFailure::Conflict => "部署前一版本已变化",
            DeploymentFailure::Uncertain => "部署提交结果尚未确认",
        };
        write!(f, "{description}，阶段：{}", self.stage)
    }
}
impl std::error::Error for DeploymentError {}

#[derive(Debug, Serialize)]
pub struct DeploymentActivation {
    pub record: DeploymentRecord,
    pub sha256: String,
    pub write_acknowledged: bool,
    pub reconciled_by_readback: bool,
}

#[derive(Debug, Serialize)]
pub struct RankModelPublication {
    pub sha256: String,
    pub catalog_sha256: String,
    pub bytes: usize,
    pub write_acknowledged: bool,
    pub reconciled_by_readback: bool,
}

#[derive(Clone)]
pub struct S3DeploymentRepository {
    operator: Operator,
    catalogs: S3CatalogRepository,
    scope: [u8; 32],
    timeout: Duration,
    slots: Arc<Semaphore>,
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn channel_valid(value: &str) -> bool {
    valid_id(value) && value != "." && value != ".."
}
fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn endpoint_valid(value: &str) -> bool {
    if value.len() > 2048 {
        return false;
    }
    reqwest::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

impl DeploymentTarget {
    fn validate(&self) -> bool {
        valid_id(&self.catalog_version)
            && hash_valid(&self.catalog_sha256)
            && endpoint_valid(&self.profile_authority)
            && self
                .profile_minimum
                .as_ref()
                .is_none_or(|checkpoint| checkpoint.validate().is_ok())
            && self.rank_model_sha256.as_ref().is_none_or(|hash| {
                hash_valid(hash)
                    && matches!(
                        self.recall,
                        DeploymentRecall::Catalog
                            | DeploymentRecall::ModelTopK
                            | DeploymentRecall::ModelPruned
                            | DeploymentRecall::ModelBlockMax
                    )
            })
            && match &self.recall {
                DeploymentRecall::Catalog | DeploymentRecall::Grouped => true,
                DeploymentRecall::ModelTopK
                | DeploymentRecall::ModelPruned
                | DeploymentRecall::ModelBlockMax => self.rank_model_sha256.is_some(),
                DeploymentRecall::Qdrant { endpoint, scoring } => {
                    endpoint_valid(endpoint) && RecallScoring::parse(scoring).is_ok()
                }
            }
    }
}

impl S3DeploymentRepository {
    pub fn new(config: S3Config, operation_timeout_ms: u64) -> Result<Self, DeploymentError> {
        if !(100..=30_000).contains(&operation_timeout_ms) {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "limits",
            ));
        }
        let scope = Sha256::digest(
            serde_json::to_vec(&(&config.endpoint, &config.region, &config.bucket))
                .map_err(|_| DeploymentError::new(DeploymentFailure::InvalidInput, "scope"))?,
        )
        .into();
        let catalogs = S3CatalogRepository::new(
            S3Config {
                endpoint: config.endpoint.clone(),
                region: config.region.clone(),
                bucket: config.bucket.clone(),
                access_key_id: config.access_key_id.clone(),
                secret_access_key: config.secret_access_key.clone(),
            },
            Default::default(),
        )
        .map_err(|_| DeploymentError::new(DeploymentFailure::InvalidInput, "catalog_config"))?;
        Ok(Self {
            operator: s3_operator(config)
                .map_err(|_| DeploymentError::new(DeploymentFailure::InvalidInput, "s3_config"))?,
            catalogs,
            scope,
            timeout: Duration::from_millis(operation_timeout_ms),
            slots: Arc::new(Semaphore::new(2)),
        })
    }

    async fn operation<T, E>(
        &self,
        stage: &'static str,
        future: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, DeploymentError> {
        tokio::time::timeout(self.timeout, future.into_future())
            .await
            .map_err(|_| DeploymentError::new(DeploymentFailure::TimedOut, stage))?
            .map_err(|_| DeploymentError::new(DeploymentFailure::Storage, stage))
    }

    async fn read_object(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, DeploymentError> {
        self.read_object_limited(key, MAX_RECORD).await
    }

    async fn read_object_limited(
        &self,
        key: &str,
        maximum: usize,
    ) -> Result<Option<(Vec<u8>, String)>, DeploymentError> {
        let metadata = match tokio::time::timeout(self.timeout, self.operator.stat(key)).await {
            Ok(Ok(metadata)) => metadata,
            Ok(Err(error)) if error.kind() == ErrorKind::NotFound => return Ok(None),
            _ => return Err(DeploymentError::new(DeploymentFailure::Storage, "metadata")),
        };
        let length = metadata.content_length();
        let etag = metadata
            .etag()
            .filter(|etag| !etag.is_empty() && *etag != "*")
            .ok_or_else(|| DeploymentError::new(DeploymentFailure::Storage, "missing_etag"))?
            .to_owned();
        if length == 0 || length > maximum as u64 {
            return Err(DeploymentError::new(
                DeploymentFailure::Storage,
                "record_length",
            ));
        }
        let reader = self
            .operation(
                "reader",
                self.operator.reader_with(key).if_match(&etag).concurrent(1),
            )
            .await?;
        let mut stream = self
            .operation("stream", reader.into_bytes_stream(0..length))
            .await?;
        let mut bytes = Vec::with_capacity(length as usize);
        while let Some(part) = self
            .operation("body", async { stream.next().await.transpose() })
            .await?
        {
            if part.len() > length as usize - bytes.len() {
                return Err(DeploymentError::new(
                    DeploymentFailure::Storage,
                    "record_length",
                ));
            }
            bytes.extend_from_slice(&part);
        }
        if bytes.len() != length as usize {
            return Err(DeploymentError::new(
                DeploymentFailure::Storage,
                "record_length",
            ));
        }
        Ok(Some((bytes, etag)))
    }

    async fn load_inner(
        &self,
        channel: &str,
    ) -> Result<Option<DeploymentSnapshot>, DeploymentError> {
        if !channel_valid(channel) {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "channel",
            ));
        }
        let Some((bytes, etag)) = self
            .read_object(&format!("deployments/{channel}/active.json"))
            .await?
        else {
            return Ok(None);
        };
        let record: DeploymentRecord = serde_json::from_slice(&bytes)
            .map_err(|_| DeploymentError::new(DeploymentFailure::Storage, "record_decode"))?;
        if record.schema != SCHEMA
            || record.channel != channel
            || record.generation == 0
            || !valid_id(&record.operation_id)
            || !record.target.validate()
            || (record.generation == 1) != record.previous_sha256.is_none()
            || record
                .previous_sha256
                .as_ref()
                .is_some_and(|hash| !hash_valid(hash))
            || record
                .profile_checkpoint
                .as_ref()
                .is_some_and(|checkpoint| checkpoint.validate().is_err())
        {
            return Err(DeploymentError::new(
                DeploymentFailure::Storage,
                "record_validate",
            ));
        }
        let sha256 = fingerprint(&bytes);
        let history = self
            .read_object(&format!("deployments/{channel}/records/{sha256}.json"))
            .await?;
        if history
            .as_ref()
            .is_none_or(|(history, _)| history != &bytes)
        {
            return Err(DeploymentError::new(
                DeploymentFailure::Storage,
                "history_mismatch",
            ));
        }
        Ok(Some(DeploymentSnapshot {
            record,
            sha256,
            etag,
            scope: self.scope,
        }))
    }

    pub async fn load(&self, channel: &str) -> Result<Option<DeploymentSnapshot>, DeploymentError> {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| DeploymentError::new(DeploymentFailure::Busy, "admission"))?;
        self.load_inner(channel).await
    }

    pub async fn load_catalog(
        &self,
        snapshot: &DeploymentSnapshot,
    ) -> Result<Vec<u8>, DeploymentError> {
        if snapshot.scope != self.scope {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "scope",
            ));
        }
        let bytes = self
            .catalogs
            .load(&snapshot.record.target.catalog_version)
            .await
            .map_err(|_| DeploymentError::new(DeploymentFailure::Prerequisite, "catalog"))?;
        if fingerprint(&bytes) != snapshot.record.target.catalog_sha256 {
            return Err(DeploymentError::new(
                DeploymentFailure::Prerequisite,
                "catalog_fingerprint",
            ));
        }
        Ok(bytes)
    }

    pub async fn ensure_current(
        &self,
        snapshot: &DeploymentSnapshot,
    ) -> Result<(), DeploymentError> {
        if snapshot.scope != self.scope {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "scope",
            ));
        }
        let current = self.load(&snapshot.record.channel).await?;
        if current.as_ref().map(DeploymentSnapshot::sha256) != Some(snapshot.sha256()) {
            return Err(DeploymentError::new(
                DeploymentFailure::Conflict,
                "selection_changed",
            ));
        }
        Ok(())
    }

    /// 模型对象只按完整内容指纹寻址，不提供可变latest或任意模型URL。
    pub async fn publish_rank_model(
        &self,
        catalog_bytes: &[u8],
        model_bytes: &[u8],
    ) -> Result<RankModelPublication, DeploymentError> {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| DeploymentError::new(DeploymentFailure::Busy, "admission"))?;
        if catalog_bytes.len() > 8 * 1024 * 1024 || model_bytes.len() > MAX_RANK_MODEL_BYTES {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "model_size",
            ));
        }
        let catalog_hash = fingerprint(catalog_bytes);
        let model_hash = fingerprint(model_bytes);
        verify_model_bytes(catalog_bytes, &catalog_hash, model_bytes, &model_hash)?;
        let key = format!("rank-models/{model_hash}.json");
        let result = self
            .operation(
                "rank_model_write",
                self.operator
                    .write_with(&key, model_bytes.to_vec())
                    .if_not_exists(true),
            )
            .await;
        if result.is_ok() {
            return Ok(RankModelPublication {
                sha256: model_hash,
                catalog_sha256: catalog_hash,
                bytes: model_bytes.len(),
                write_acknowledged: true,
                reconciled_by_readback: false,
            });
        }
        // 响应丢失或同内容重试只核对既有对象，禁止覆盖、删除或无条件重试。
        let existing = self.read_object_limited(&key, MAX_RANK_MODEL_BYTES).await;
        match existing {
            Ok(Some((existing, _))) if existing == model_bytes => Ok(RankModelPublication {
                sha256: model_hash,
                catalog_sha256: catalog_hash,
                bytes: model_bytes.len(),
                write_acknowledged: false,
                reconciled_by_readback: true,
            }),
            Ok(Some(_)) => Err(DeploymentError::new(
                DeploymentFailure::Conflict,
                "rank_model_content",
            )),
            _ => Err(DeploymentError::new(
                DeploymentFailure::Uncertain,
                "rank_model_write",
            )),
        }
    }

    async fn read_rank_model(
        &self,
        expected: &str,
        catalog_bytes: &[u8],
        catalog_hash: &str,
    ) -> Result<Vec<u8>, DeploymentError> {
        if !hash_valid(expected) {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "rank_model_hash",
            ));
        }
        let (bytes, _) = self
            .read_object_limited(
                &format!("rank-models/{expected}.json"),
                MAX_RANK_MODEL_BYTES,
            )
            .await?
            .ok_or_else(|| {
                DeploymentError::new(DeploymentFailure::Prerequisite, "rank_model_missing")
            })?;
        verify_model_bytes(catalog_bytes, catalog_hash, &bytes, expected)?;
        Ok(bytes)
    }

    pub async fn load_rank_model(
        &self,
        snapshot: &DeploymentSnapshot,
        catalog_bytes: &[u8],
    ) -> Result<Option<Vec<u8>>, DeploymentError> {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| DeploymentError::new(DeploymentFailure::Busy, "admission"))?;
        if snapshot.scope != self.scope
            || fingerprint(catalog_bytes) != snapshot.record.target.catalog_sha256
        {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "model_scope",
            ));
        }
        match &snapshot.record.target.rank_model_sha256 {
            Some(expected) => self
                .read_rank_model(
                    expected,
                    catalog_bytes,
                    &snapshot.record.target.catalog_sha256,
                )
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    /// 只替换部署选择；不撤回旧实例请求，也不接管画像日志的单写者所有权。
    pub async fn activate(
        &self,
        channel: &str,
        expected: Option<&DeploymentSnapshot>,
        operation_id: &str,
        target: DeploymentTarget,
        credentials: DeploymentCredentials,
    ) -> Result<DeploymentActivation, DeploymentError> {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| DeploymentError::new(DeploymentFailure::Busy, "admission"))?;
        if !channel_valid(channel)
            || !valid_id(operation_id)
            || !target.validate()
            || expected.is_some_and(|old| {
                old.scope != self.scope
                    || old.record.channel != channel
                    || old.record.operation_id == operation_id
            })
        {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "input",
            ));
        }
        let generation = expected
            .map_or(Some(1), |old| old.record.generation.checked_add(1))
            .ok_or_else(|| DeploymentError::new(DeploymentFailure::InvalidInput, "generation"))?;
        let mut record = DeploymentRecord {
            schema: SCHEMA.into(),
            channel: channel.into(),
            generation,
            operation_id: operation_id.into(),
            previous_sha256: expected.map(|old| old.sha256.clone()),
            target,
            profile_checkpoint: None,
        };
        let current = self.load_inner(channel).await?;
        if let Some(current) = current.as_ref().filter(|current| {
            current.record.operation_id == record.operation_id
                && current.record.target == record.target
                && current.record.previous_sha256 == record.previous_sha256
                && current.record.generation == record.generation
        }) {
            return Ok(DeploymentActivation {
                record: current.record.clone(),
                sha256: current.sha256.clone(),
                write_acknowledged: false,
                reconciled_by_readback: true,
            });
        }
        if current.as_ref().map(|current| current.sha256())
            != expected.map(DeploymentSnapshot::sha256)
        {
            return Err(DeploymentError::new(
                DeploymentFailure::Conflict,
                "preflight",
            ));
        }
        if expected.is_some_and(|old| {
            old.record.target.profile_authority != record.target.profile_authority
        }) && record.target.profile_minimum.is_none()
        {
            return Err(DeploymentError::new(
                DeploymentFailure::Prerequisite,
                "handoff_checkpoint_required",
            ));
        }
        let catalog_bytes = self
            .catalogs
            .load(&record.target.catalog_version)
            .await
            .map_err(|_| DeploymentError::new(DeploymentFailure::Prerequisite, "catalog"))?;
        if fingerprint(&catalog_bytes) != record.target.catalog_sha256 {
            return Err(DeploymentError::new(
                DeploymentFailure::Prerequisite,
                "catalog_fingerprint",
            ));
        }
        if let Some(expected) = &record.target.rank_model_sha256 {
            self.read_rank_model(expected, &catalog_bytes, &record.target.catalog_sha256)
                .await?;
        }
        let profile = ProfileClient::new(
            ProfileRemoteConfig {
                endpoint: record.target.profile_authority.clone(),
                token: credentials.profile_token,
            },
            record.target.catalog_sha256.clone(),
        )
        .map_err(|_| DeploymentError::new(DeploymentFailure::InvalidInput, "profile_config"))?;
        profile
            .ready()
            .await
            .map_err(|_| DeploymentError::new(DeploymentFailure::Prerequisite, "profile"))?;
        if let Some(old) = expected.and_then(|old| old.record.profile_checkpoint.as_ref()) {
            profile.checkpoint(Some(old)).await.map_err(|_| {
                DeploymentError::new(DeploymentFailure::Prerequisite, "profile_history")
            })?;
        }
        record.profile_checkpoint = Some(
            profile
                .checkpoint(record.target.profile_minimum.as_ref())
                .await
                .map_err(|_| {
                    DeploymentError::new(DeploymentFailure::Prerequisite, "profile_history")
                })?,
        );
        if let DeploymentRecall::Qdrant { endpoint, scoring } = &record.target.recall {
            let recall = QdrantRecall::new(
                QdrantConfig {
                    endpoint: endpoint.clone(),
                    api_key: credentials.qdrant_api_key,
                    scoring: RecallScoring::parse(scoring).map_err(|_| {
                        DeploymentError::new(DeploymentFailure::InvalidInput, "scoring")
                    })?,
                },
                record.target.catalog_sha256.clone(),
            )
            .map_err(|_| DeploymentError::new(DeploymentFailure::InvalidInput, "recall_config"))?;
            recall
                .verify_published(&catalog_bytes)
                .await
                .map_err(|_| DeploymentError::new(DeploymentFailure::Prerequisite, "recall"))?;
        } else if credentials.qdrant_api_key.is_some() {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "unexpected_recall_key",
            ));
        }
        let bytes = serde_json::to_vec(&record)
            .map_err(|_| DeploymentError::new(DeploymentFailure::InvalidInput, "encode"))?;
        if bytes.len() > MAX_RECORD {
            return Err(DeploymentError::new(
                DeploymentFailure::InvalidInput,
                "record_length",
            ));
        }
        let sha256 = fingerprint(&bytes);
        let history_key = format!("deployments/{channel}/records/{sha256}.json");
        let history = self
            .operation(
                "history_write",
                self.operator
                    .write_with(&history_key, bytes.clone())
                    .if_not_exists(true),
            )
            .await;
        if history.is_err()
            && self
                .read_object(&history_key)
                .await?
                .is_none_or(|(existing, _)| existing != bytes)
        {
            return Err(DeploymentError::new(
                DeploymentFailure::Storage,
                "history_write",
            ));
        }
        let key = format!("deployments/{channel}/active.json");
        let mut write = self.operator.write_with(&key, bytes.clone());
        if let Some(previous) = expected {
            write = write.if_match(&previous.etag);
        } else {
            write = write.if_not_exists(true);
        }
        // 改编上游条件写示例：只尝试一次，冲突不改用新ETag自动重试。
        let outcome = tokio::time::timeout(self.timeout, write.into_future()).await;
        if matches!(outcome, Ok(Ok(_))) {
            return Ok(DeploymentActivation {
                record,
                sha256,
                write_acknowledged: true,
                reconciled_by_readback: false,
            });
        }
        let rejected = matches!(&outcome, Ok(Err(error)) if matches!(error.kind(), ErrorKind::ConditionNotMatch | ErrorKind::AlreadyExists));
        if let Ok(Some(current)) = self.load_inner(channel).await
            && current.sha256 == sha256
        {
            return Ok(DeploymentActivation {
                record,
                sha256,
                write_acknowledged: false,
                reconciled_by_readback: true,
            });
        }
        Err(DeploymentError {
            kind: if rejected {
                DeploymentFailure::Conflict
            } else {
                DeploymentFailure::Uncertain
            },
            stage: "activation_commit",
            activation_may_have_succeeded: !rejected,
        })
    }
}

fn verify_model_bytes(
    catalog_bytes: &[u8],
    catalog_hash: &str,
    model_bytes: &[u8],
    model_hash: &str,
) -> Result<(), DeploymentError> {
    if catalog_bytes.len() > 8 * 1024 * 1024 || fingerprint(catalog_bytes) != catalog_hash {
        return Err(DeploymentError::new(
            DeploymentFailure::Prerequisite,
            "model_catalog",
        ));
    }
    let catalog: PublicCatalog = serde_json::from_slice(catalog_bytes)
        .map_err(|_| DeploymentError::new(DeploymentFailure::Prerequisite, "model_catalog"))?;
    validate_rank_model(model_bytes, model_hash, &catalog, catalog_hash)
        .map_err(|_| DeploymentError::new(DeploymentFailure::Prerequisite, "rank_model"))?;
    Ok(())
}
