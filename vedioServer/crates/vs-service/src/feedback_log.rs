// SPDX-License-Identifier: Apache-2.0
// 改编Apache Iggy固定提交71f29618ba04917fded0ef5cd085c206fef0ee49的
// HTTP messages客户端调用；保留持久化声明，增加固定坐标、预算和不确定结果边界。
use std::{
    collections::HashSet,
    io::{self, Write},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use vs_core::{learning::TrainingDataKind, valid_id};

use crate::{
    ApiError, AppState,
    consumption::{ConsumptionBatch, ConsumptionSummary},
    feedback_evidence::{
        FeedbackEvidenceArchive, FeedbackEvidenceMessage, MAX_BATCH_BYTES,
        MAX_FEEDBACK_EVIDENCE_BYTES, MAX_SNAPSHOT_MESSAGES, project_payload,
    },
    learning_evidence::GatewayLearningArchive,
    upstream::{atomic_create::atomic_create, iggy_topic::TopicDetails},
};

const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const IN_FLIGHT: usize = 4;
const MAX_TOPIC_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_ENDPOINTS: usize = 4;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IggyFeedbackConfig {
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallback_endpoints: Vec<String>,
    pub stream_id: u32,
    pub topic_id: u32,
    pub partition_id: u32,
    pub source_id: String,
    pub data_kind: TrainingDataKind,
    pub operation_timeout_ms: u64,
}

#[derive(Clone)]
pub struct IggyFeedbackLog {
    config: IggyFeedbackConfig,
    endpoints: Arc<Vec<String>>,
    active_endpoint: Arc<AtomicUsize>,
    topic_identity: Arc<Mutex<Option<(u64, u64)>>>,
    client: Client,
    token: String,
    slots: Arc<Semaphore>,
    probe_slots: Arc<Semaphore>,
    confirmed: Arc<AtomicU64>,
    uncertain: Arc<AtomicU64>,
}

#[derive(Debug, Serialize)]
pub struct FeedbackConfirmation {
    pub batch_sha256: String,
    pub stream_id: u32,
    pub topic_id: u32,
    pub partition_id: u32,
    pub base_offset: u64,
    pub durability: &'static str,
    pub events: usize,
    pub payload_bytes: usize,
    pub request_bytes: usize,
}

#[derive(Debug, Serialize)]
pub struct FeedbackUncertain {
    pub batch_sha256: String,
    pub commit_state: &'static str,
}

#[derive(Deserialize)]
struct Confirmations {
    confirmations: Vec<Confirmation>,
}

#[derive(Deserialize)]
struct Confirmation {
    stream_id: u32,
    topic_id: u32,
    partition_id: u32,
    base_offset: u64,
}

#[derive(Deserialize)]
struct Polled {
    partition_id: u32,
    count: usize,
    messages: Vec<PolledMessage>,
}

#[derive(Deserialize)]
struct PolledMessage {
    header: MessageHeader,
    payload: String,
}

#[derive(Deserialize)]
struct MessageHeader {
    id: u128,
    offset: u64,
    payload_length: usize,
}

#[derive(Serialize)]
pub struct FeedbackSnapshotReceipt {
    pub schema: &'static str,
    pub archive_sha256: String,
    pub stream_id: u32,
    pub topic_id: u32,
    pub partition_id: u32,
    pub start_offset: u64,
    pub end_offset_exclusive: u64,
    pub messages: u64,
    pub events: usize,
    pub archive_bytes: usize,
    pub auto_commit: bool,
    pub consumption_batches: u64,
    pub consumption_events: usize,
    pub source_payload_sha256: Vec<String>,
}

#[derive(Serialize)]
pub struct FeedbackEvidenceReceipt {
    pub schema: &'static str,
    pub archive_sha256: String,
    pub archive_bytes: usize,
    pub stream_id: u32,
    pub topic_id: u32,
    pub partition_id: u32,
    pub start_offset: u64,
    pub end_offset_exclusive: u64,
    pub messages: usize,
    pub projected_learning_events: usize,
    pub consumption_batches: u64,
    pub consumption_events: usize,
    pub auto_commit: bool,
    pub raw_payloads_preserved: bool,
}

struct CapturedSnapshot {
    learning: GatewayLearningArchive,
    evidence: FeedbackEvidenceArchive,
    consumption_batches: u64,
    consumption_events: usize,
    source_payload_sha256: Vec<String>,
    // 读取结束后仍占用许可，直到单文件发布完成，避免慢磁盘绕过任务预算。
    _permit: OwnedSemaphorePermit,
}

#[derive(Debug, Serialize)]
pub struct FeedbackReadiness {
    pub endpoint_index: usize,
    pub stream_id: u32,
    pub topic_id: u32,
    pub partition_id: u32,
    pub topic_created_at: u64,
    pub partition_created_at: u64,
    pub durability: &'static str,
    pub durability_explicit: bool,
    pub metadata_consistency: &'static str,
    pub checked_at: u64,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn message_id(bytes: &[u8]) -> u128 {
    u128::from_be_bytes(Sha256::digest(bytes)[..16].try_into().unwrap())
}

fn now() -> Result<u64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "反馈服务时钟不可用"))
}

async fn bounded_body(mut response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, ()> {
    if response
        .content_length()
        .is_some_and(|size| size > maximum as u64)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if chunk.len() > maximum - bytes.len() {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

impl IggyFeedbackLog {
    pub fn new(config: IggyFeedbackConfig, token: String) -> Result<Self, String> {
        if config.fallback_endpoints.len() >= MAX_ENDPOINTS {
            return Err("反馈日志最多允许四个固定地址".into());
        }
        let mut endpoints = Vec::with_capacity(1 + config.fallback_endpoints.len());
        let mut seen = HashSet::new();
        let mut scheme = None;
        for value in std::iter::once(&config.endpoint).chain(&config.fallback_endpoints) {
            let endpoint = reqwest::Url::parse(value).map_err(|_| "反馈日志地址无效")?;
            if !matches!(endpoint.scheme(), "http" | "https")
                || endpoint.host_str().is_none()
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
                || endpoint.path() != "/"
                || endpoint.query().is_some()
                || endpoint.fragment().is_some()
            {
                return Err("反馈日志地址无效".into());
            }
            if scheme
                .as_deref()
                .is_some_and(|first| first != endpoint.scheme())
            {
                return Err("反馈日志固定地址必须使用相同协议".into());
            }
            scheme = Some(endpoint.scheme().to_owned());
            let normalized = endpoint.as_str().trim_end_matches('/').to_owned();
            if !seen.insert(normalized.clone()) {
                return Err("反馈日志地址重复".into());
            }
            endpoints.push(normalized);
        }
        if !valid_id(&config.source_id)
            || !(100..=5_000).contains(&config.operation_timeout_ms)
            || !(1..=4096).contains(&token.len())
            || !token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("反馈日志坐标、凭证或预算无效".into());
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_millis(config.operation_timeout_ms))
            .timeout(Duration::from_millis(config.operation_timeout_ms))
            .pool_max_idle_per_host(IN_FLIGHT)
            .build()
            .map_err(|_| "反馈日志客户端构建失败")?;
        let mut normalized_config = config;
        normalized_config.endpoint = endpoints[0].clone();
        normalized_config.fallback_endpoints = endpoints[1..].to_vec();
        let initial_endpoint = if endpoints.len() == 1 { 0 } else { usize::MAX };
        Ok(Self {
            config: normalized_config,
            endpoints: Arc::new(endpoints),
            active_endpoint: Arc::new(AtomicUsize::new(initial_endpoint)),
            topic_identity: Arc::new(Mutex::new(None)),
            client,
            token,
            slots: Arc::new(Semaphore::new(IN_FLIGHT)),
            probe_slots: Arc::new(Semaphore::new(1)),
            confirmed: Arc::new(AtomicU64::new(0)),
            uncertain: Arc::new(AtomicU64::new(0)),
        })
    }

    fn endpoint_order(&self) -> impl Iterator<Item = usize> + '_ {
        let preferred = self.endpoint_index().unwrap_or(0);
        std::iter::once(preferred)
            .chain((0..self.endpoints.len()).filter(move |index| *index != preferred))
    }

    fn path_at(&self, endpoint_index: usize) -> String {
        format!(
            "{}/streams/{}/topics/{}/messages",
            self.endpoints[endpoint_index], self.config.stream_id, self.config.topic_id
        )
    }

    fn endpoint_index(&self) -> Option<usize> {
        let index = self.active_endpoint.load(Ordering::Acquire);
        (index < self.endpoints.len()).then_some(index)
    }

    /// 只在就绪探测未收到响应头时轮询固定地址；不会重发写入。
    async fn probe_endpoint(&self, deadline: Instant) -> io::Result<(usize, reqwest::Response)> {
        for (attempt, endpoint_index) in self.endpoint_order().enumerate() {
            let mut url = reqwest::Url::parse(&format!(
                "{}/streams/{}/topics/{}",
                self.endpoints[endpoint_index], self.config.stream_id, self.config.topic_id
            ))
            .map_err(|_| io::Error::other("反馈主题读取地址无效"))?;
            url.query_pairs_mut()
                .append_pair("consistency", "linearizable");
            // 为剩余地址保留等待时间，全部探测及正文校验仍受同一总期限约束。
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let attempt_budget = remaining / (self.endpoints.len() - attempt) as u32;
            match self
                .client
                .get(url)
                .bearer_auth(&self.token)
                .timeout(attempt_budget)
                .send()
                .await
            {
                Ok(response) => return Ok((endpoint_index, response)),
                Err(error) if error.is_connect() || error.is_timeout() => {}
                Err(_) => {
                    return Err(io::Error::other("反馈读取失败或超时"));
                }
            }
        }
        Err(io::Error::other("固定反馈地址均无法在预算内返回响应头"))
    }

    /// 改编Iggy HTTP get_topic；只查询有效策略，不写探针消息或变更消费位点。
    pub async fn verify_readiness(&self) -> io::Result<FeedbackReadiness> {
        let _permit = self
            .probe_slots
            .try_acquire()
            .map_err(|_| io::Error::other("反馈就绪检查预算已满"))?;
        let deadline = Instant::now() + Duration::from_millis(self.config.operation_timeout_ms);
        let result = tokio::time::timeout_at(deadline, self.select_ready_endpoint(deadline))
            .await
            .map_err(|_| io::Error::other("反馈就绪检查超过总预算"))
            .and_then(|result| result);
        if result.is_err() {
            self.active_endpoint.store(usize::MAX, Ordering::Release);
        }
        result
    }

    async fn select_ready_endpoint(&self, deadline: Instant) -> io::Result<FeedbackReadiness> {
        let (endpoint_index, response) = self.probe_endpoint(deadline).await?;
        if response.status() != StatusCode::OK {
            return Err(io::Error::other(
                "反馈主题不存在、权限不足或未在元数据主节点",
            ));
        }
        let bytes = bounded_body(response, MAX_TOPIC_RESPONSE_BYTES)
            .await
            .map_err(|_| io::Error::other("反馈主题响应超限或读取失败"))?;
        let topic: TopicDetails =
            serde_json::from_slice(&bytes).map_err(|_| io::Error::other("反馈主题响应格式无效"))?;
        let mut ids = HashSet::new();
        if topic.id != self.config.topic_id
            || topic.created_at == 0
            || topic.partitions_count == 0
            || topic.partitions_count as usize != topic.partitions.len()
            || topic
                .partitions
                .iter()
                .any(|part| part.created_at == 0 || !ids.insert(part.id))
        {
            return Err(io::Error::other("反馈主题或分区元数据不一致"));
        }
        let partition = topic
            .partitions
            .iter()
            .find(|part| part.id == self.config.partition_id)
            .ok_or_else(|| io::Error::other("反馈目标分区不存在"))?;
        let policy = topic
            .options
            .get("durability")
            .filter(|policy| policy.value == "persisted" && policy.explicit)
            .ok_or_else(|| io::Error::other("反馈消息主题未显式声明persisted持久性"))?;
        let readiness = FeedbackReadiness {
            endpoint_index,
            stream_id: self.config.stream_id,
            topic_id: topic.id,
            partition_id: partition.id,
            topic_created_at: topic.created_at,
            partition_created_at: partition.created_at,
            durability: "persisted",
            durability_explicit: policy.explicit,
            metadata_consistency: "linearizable",
            checked_at: now().map_err(|_| io::Error::other("反馈就绪检查时钟不可用"))?,
        };
        let identity = (topic.created_at, partition.created_at);
        let mut pinned = self
            .topic_identity
            .lock()
            .map_err(|_| io::Error::other("反馈主题身份状态不可用"))?;
        if pinned.is_some_and(|previous| previous != identity) {
            return Err(io::Error::other("反馈主题或分区创建身份已变化"));
        }
        *pinned = Some(identity);
        // HTTP成功不等于可路由；完整校验后才改变后续写入使用的地址。
        self.active_endpoint
            .store(endpoint_index, Ordering::Release);
        Ok(readiness)
    }

    fn validate(&self, archive: &GatewayLearningArchive, at: u64) -> Result<(), ApiError> {
        crate::feedback_evidence::validate_gateway(
            archive,
            &self.config.source_id,
            self.config.data_kind,
            at,
        )
    }

    async fn publish(
        &self,
        events: usize,
        payload: Vec<u8>,
    ) -> Result<FeedbackConfirmation, FeedbackUncertain> {
        let batch_sha256 = hash(&payload);
        let unknown = || FeedbackUncertain {
            batch_sha256: batch_sha256.clone(),
            commit_state: "unknown",
        };
        let body = serde_json::to_vec(&json!({
            "partitioning":{"kind":"partition_id","value":STANDARD.encode(self.config.partition_id.to_le_bytes())},
            "messages":[{"id":message_id(&payload).to_string(),"payload":STANDARD.encode(&payload)}],
        })).map_err(|_| unknown())?;
        let request_bytes = body.len();
        let outcome = async {
            let endpoint_index = self.endpoint_index().ok_or(())?;
            let response = self
                .client
                .post(self.path_at(endpoint_index))
                .bearer_auth(&self.token)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|_| ())?;
            if response.status() != StatusCode::CREATED
                || response
                    .headers()
                    .get("iggy-durability")
                    .and_then(|h| h.to_str().ok())
                    .is_none_or(|value| !value.eq_ignore_ascii_case("persisted"))
            {
                return Err(());
            }
            let bytes = bounded_body(response, 4096).await?;
            let confirmations: Confirmations = serde_json::from_slice(&bytes).map_err(|_| ())?;
            let [confirmation] = confirmations.confirmations.as_slice() else {
                return Err(());
            };
            if confirmation.stream_id != self.config.stream_id
                || confirmation.topic_id != self.config.topic_id
                || confirmation.partition_id != self.config.partition_id
            {
                return Err(());
            }
            Ok(FeedbackConfirmation {
                batch_sha256: batch_sha256.clone(),
                stream_id: confirmation.stream_id,
                topic_id: confirmation.topic_id,
                partition_id: confirmation.partition_id,
                base_offset: confirmation.base_offset,
                durability: "persisted",
                events,
                payload_bytes: payload.len(),
                request_bytes,
            })
        }
        .await;
        match outcome {
            Ok(receipt) => {
                self.confirmed.fetch_add(1, Ordering::Relaxed);
                Ok(receipt)
            }
            Err(()) => {
                self.uncertain.fetch_add(1, Ordering::Relaxed);
                Err(unknown())
            }
        }
    }

    pub async fn snapshot(
        &self,
        start: u64,
        end: u64,
        target: &Path,
    ) -> io::Result<FeedbackSnapshotReceipt> {
        let captured = self.capture_snapshot(start, end, false).await?;
        let bytes = serde_json::to_vec(&captured.learning).map_err(io::Error::other)?;
        atomic_create(target, |writer| writer.write_all(&bytes))?;
        Ok(FeedbackSnapshotReceipt {
            schema: "iggy-feedback-snapshot-v1",
            archive_sha256: hash(&bytes),
            stream_id: self.config.stream_id,
            topic_id: self.config.topic_id,
            partition_id: self.config.partition_id,
            start_offset: start,
            end_offset_exclusive: end,
            messages: end - start,
            events: captured.learning.events.len(),
            archive_bytes: bytes.len(),
            auto_commit: false,
            consumption_batches: captured.consumption_batches,
            consumption_events: captured.consumption_events,
            source_payload_sha256: captured.source_payload_sha256,
        })
    }

    pub async fn snapshot_evidence(
        &self,
        start: u64,
        end: u64,
        target: &Path,
    ) -> io::Result<FeedbackEvidenceReceipt> {
        let captured = self.capture_snapshot(start, end, true).await?;
        let bytes = serde_json::to_vec(&captured.evidence).map_err(io::Error::other)?;
        if bytes.len() > MAX_FEEDBACK_EVIDENCE_BYTES {
            return Err(io::Error::other("原始反馈证据超过8MiB"));
        }
        // 单文件提交同时保留坐标和原始载荷，不引入多文件部分成功状态。
        atomic_create(target, |writer| writer.write_all(&bytes))?;
        Ok(FeedbackEvidenceReceipt {
            schema: "iggy-feedback-evidence-snapshot-v1",
            archive_sha256: hash(&bytes),
            archive_bytes: bytes.len(),
            stream_id: self.config.stream_id,
            topic_id: self.config.topic_id,
            partition_id: self.config.partition_id,
            start_offset: start,
            end_offset_exclusive: end,
            messages: captured.evidence.messages.len(),
            projected_learning_events: captured.learning.events.len(),
            consumption_batches: captured.consumption_batches,
            consumption_events: captured.consumption_events,
            auto_commit: false,
            raw_payloads_preserved: true,
        })
    }

    async fn capture_snapshot(
        &self,
        start: u64,
        end: u64,
        preserve_raw: bool,
    ) -> io::Result<CapturedSnapshot> {
        if end <= start || end - start > MAX_SNAPSHOT_MESSAGES {
            return Err(io::Error::other(
                "反馈快照必须指定1至128条消息的固定排他区间",
            ));
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| io::Error::other("反馈读取预算已满"))?;
        // 多地址快照先核对主题身份，整份归档固定一个入口，不拼接跨入口分页。
        let endpoint_index = if self.endpoints.len() > 1 {
            self.verify_readiness().await?.endpoint_index
        } else {
            0
        };
        let mut archive = GatewayLearningArchive {
            schema: "gateway-learning-events-v1".into(),
            source_id: self.config.source_id.clone(),
            data_kind: self.config.data_kind,
            events: Vec::new(),
        };
        let mut offset = start;
        let mut consumption_batches = 0;
        let mut consumption_events = 0;
        let mut source_payload_sha256 = Vec::new();
        let captured_at = now().map_err(|_| io::Error::other("反馈时钟不可用"))?;
        let mut evidence = FeedbackEvidenceArchive {
            schema: "feedback-evidence-v1".into(),
            source_id: self.config.source_id.clone(),
            data_kind: self.config.data_kind,
            stream_id: self.config.stream_id,
            topic_id: self.config.topic_id,
            partition_id: self.config.partition_id,
            start_offset: start,
            end_offset_exclusive: end,
            captured_at,
            messages: Vec::new(),
        };
        while offset < end {
            let count = (end - offset).min(8);
            let mut url = reqwest::Url::parse(&self.path_at(endpoint_index))
                .map_err(|_| io::Error::other("反馈读取地址无效"))?;
            url.query_pairs_mut().extend_pairs([
                ("consumer_id", "1".into()),
                ("partition_id", self.config.partition_id.to_string()),
                ("kind", "offset".into()),
                ("value", offset.to_string()),
                ("count", count.to_string()),
                ("auto_commit", "false".into()),
            ]);
            let response = self
                .client
                .get(url)
                .bearer_auth(&self.token)
                .send()
                .await
                .map_err(|_| io::Error::other("反馈快照读取失败"))?;
            if !response.status().is_success() {
                return Err(io::Error::other("反馈快照读取被拒绝"));
            }
            let bytes = bounded_body(response, MAX_RESPONSE_BYTES)
                .await
                .map_err(|_| io::Error::other("反馈响应超限或读取失败"))?;
            let polled: Polled = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::other("反馈消息响应格式无效"))?;
            if polled.partition_id != self.config.partition_id
                || polled.count != polled.messages.len()
                || polled.count == 0
                || polled.count > count as usize
            {
                return Err(io::Error::other("反馈消息区间缺失、错分区或数量无效"));
            }
            for message in polled.messages {
                let payload = STANDARD
                    .decode(&message.payload)
                    .map_err(|_| io::Error::other("反馈消息编码无效"))?;
                if payload.len() > MAX_BATCH_BYTES
                    || message.header.offset != offset
                    || message.header.payload_length != payload.len()
                    || message.header.id != message_id(&payload)
                {
                    return Err(io::Error::other("反馈消息偏移、长度或内容标识不符"));
                }
                let payload_sha256 = hash(&payload);
                source_payload_sha256.push(payload_sha256.clone());
                let projected = project_payload(
                    &payload,
                    &self.config.source_id,
                    self.config.data_kind,
                    captured_at,
                )?;
                if let Some(events) = projected.consumption_events {
                    consumption_batches += 1;
                    consumption_events += events;
                }
                if preserve_raw {
                    evidence.messages.push(FeedbackEvidenceMessage {
                        offset,
                        message_id: message.header.id.to_string(),
                        payload_length: payload.len(),
                        payload_sha256,
                        payload_base64: message.payload,
                    });
                }
                let batch = projected.learning;
                if batch.schema == "gateway-learning-events-v2" && !batch.events.is_empty() {
                    archive.schema = "gateway-learning-events-v2".into();
                }
                archive.events.extend(batch.events);
                offset += 1;
            }
        }
        Ok(CapturedSnapshot {
            learning: archive,
            evidence,
            consumption_batches,
            consumption_events,
            source_payload_sha256,
            _permit: permit,
        })
    }

    pub(crate) fn metrics(&self) -> serde_json::Value {
        json!({"backend":"iggy-http", "source_id":self.config.source_id,
            "stream_id":self.config.stream_id,"topic_id":self.config.topic_id,
            "partition_id":self.config.partition_id,
            "endpoint_count":self.endpoints.len(),
            "active_endpoint_index":self.endpoint_index(),
            "confirmed_batches":self.confirmed.load(Ordering::Relaxed),
            "uncertain_batches":self.uncertain.load(Ordering::Relaxed),
            "available_slots":self.slots.available_permits(),
            "available_probe_slots":self.probe_slots.available_permits()})
    }

    pub(crate) async fn drain(&self) {
        if let Ok(_permit) = self.slots.acquire_many(IN_FLIGHT as u32).await {
            self.slots.close();
        }
    }
}

impl AppState {
    pub fn with_feedback_log(
        mut self,
        config: IggyFeedbackConfig,
        token: String,
    ) -> Result<Self, String> {
        if self.feedback_log.is_some()
            || self.profile_authority
            || self.profile_log.is_some()
            || self.profile_remote.is_some()
            || self.rank_model.is_some()
            || self.recall.is_some()
            || self.grouped_recall.is_some()
            || self.learning_journal.is_some()
            || self.deployment.is_some()
            || self.slate_policy.is_some()
        {
            return Err("反馈收集实例不能同时承担画像、模型或部署职责".into());
        }
        self.feedback_log = Some(Arc::new(IggyFeedbackLog::new(config, token)?));
        Ok(self)
    }

    pub async fn drain_feedback_writes(&self) {
        if let Some(log) = &self.feedback_log {
            log.drain().await;
        }
    }

    pub async fn verify_feedback_readiness(&self) -> io::Result<FeedbackReadiness> {
        self.feedback_log
            .as_ref()
            .ok_or_else(|| io::Error::other("反馈持久日志未配置"))?
            .verify_readiness()
            .await
    }
}

pub(crate) async fn ingest(
    State(state): State<Arc<AppState>>,
    Json(archive): Json<GatewayLearningArchive>,
) -> Result<Response, ApiError> {
    let log = state.feedback_log.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "反馈持久日志未配置",
    ))?;
    log.validate(&archive, now()?)?;
    let payload = serde_json::to_vec(&archive)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "反馈批次序列化失败"))?;
    if payload.len() > MAX_BATCH_BYTES {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "反馈批次超过32KiB"));
    }
    let permit = log
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "反馈写入预算已满"))?;
    // HTTP取消后仍持有许可至远端等待结束；确认丢失不能当作未写入或无限重发。
    let result = tokio::spawn(async move {
        let _permit = permit;
        log.publish(archive.events.len(), payload).await
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "反馈提交任务失败，结果未知",
        )
    })?;
    let mut response = match result {
        Ok(receipt) => (StatusCode::ACCEPTED, Json(receipt)).into_response(),
        Err(unknown) => (StatusCode::SERVICE_UNAVAILABLE, Json(unknown)).into_response(),
    };
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

pub(crate) async fn ready(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let log = state.feedback_log.as_ref().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "反馈持久日志未配置",
    ))?;
    let readiness = log.verify_readiness().await.map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "反馈主题或持久化策略未就绪",
        )
    })?;
    Ok(Json(json!({
        "ready":true,"feedback":log.metrics(),"broker_checked":true,
        "topic_readiness":readiness,"append_permission_checked":false,
        "quorum_health_checked":false,"durability_crash_tested":false,
    })))
}

impl IggyFeedbackLog {
    fn validate_consumption(
        &self,
        batch: &ConsumptionBatch,
        at: u64,
    ) -> Result<crate::consumption::NormalizedConsumption, ApiError> {
        crate::feedback_evidence::validate_consumption(
            batch,
            &self.config.source_id,
            self.config.data_kind,
            at,
        )
        .map_err(|message| ApiError(StatusCode::BAD_REQUEST, message))
    }
}

#[derive(Serialize)]
struct ConsumptionConfirmation {
    schema: &'static str,
    commit: FeedbackConfirmation,
    summary: ConsumptionSummary,
    evidence_boundary: &'static str,
}

pub(crate) async fn ingest_consumption(
    State(state): State<Arc<AppState>>,
    Json(batch): Json<ConsumptionBatch>,
) -> Result<Response, ApiError> {
    let log = state.feedback_log.clone().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "反馈持久日志未配置",
    ))?;
    let normalized = log.validate_consumption(&batch, now()?)?;
    let payload = serde_json::to_vec(&batch)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "消费批次序列化失败"))?;
    if payload.len() > MAX_BATCH_BYTES {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "消费批次超过32KiB"));
    }
    let permit = log
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "反馈写入预算已满"))?;
    let events = normalized.summary.unique_events;
    // 沿用同一持久化确认协议；请求取消后写入任务与许可一起存活至有界等待结束。
    let result = tokio::spawn(async move {
        let _permit = permit;
        log.publish(events, payload).await
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "消费提交任务失败，结果未知",
        )
    })?;
    let mut response = match result {
        Ok(commit) => (
            StatusCode::ACCEPTED,
            Json(ConsumptionConfirmation {
                schema: "consumption-confirmation-v1",
                commit,
                summary: normalized.summary,
                evidence_boundary: "可信网关转交的客户端声明；持久化不证明真实观看，不自动修改画像",
            }),
        )
            .into_response(),
        Err(unknown) => (StatusCode::SERVICE_UNAVAILABLE, Json(unknown)).into_response(),
    };
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}
