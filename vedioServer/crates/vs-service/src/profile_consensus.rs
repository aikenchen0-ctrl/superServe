use std::{
    collections::HashSet,
    net::SocketAddr,
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::http::StatusCode;
use serde::{Deserialize, de::DeserializeOwned};
use vs_core::{
    joint_workload::TraceContext,
    recommendation::{ProfileProjection, RecommendationRequest, RequestContext},
    valid_id,
};

use crate::profile_client::ProfileClientError;

const MAX_INDEX: u64 = 9_007_199_254_740_991;

/// 显式只读实验；明文限回环，固定私网目标必须使用双向TLS。
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileConsensusConfig {
    pub cluster_id: String,
    pub endpoints: Vec<SocketAddr>,
    pub service_token: String,
    pub shard_count: u16,
    pub minimum_applied_index: u64,
    #[serde(default)]
    pub profile_access_audience: Option<String>,
    #[serde(default)]
    pub tls: Option<vs_tls::FixedClientTls>,
}

pub(crate) struct ProfileConsensusClient {
    config: ProfileConsensusConfig,
    client: reqwest::Client,
    catalog_sha256: String,
    preferred: AtomicUsize,
    observed_index: AtomicU64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionResponse {
    schema: String,
    cluster_id: String,
    catalog_sha256: String,
    shard_count: u16,
    applied_index: u64,
    subject: String,
    domains: Vec<String>,
    #[serde(deserialize_with = "required_profile")]
    profile: Option<ProfileProjection>,
}

fn required_profile<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ProfileProjection>, D::Error> {
    Option::<ProfileProjection>::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriterResponse {
    schema: String,
    cluster_id: String,
    catalog_sha256: String,
    shard_count: u16,
    applied_index: u64,
    shard: u16,
    writer: Option<serde_json::Value>,
    events: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyResponse {
    schema: String,
    cluster_id: String,
    catalog_sha256: String,
    shard_count: u16,
    applied_index: u64,
}

fn unavailable() -> ProfileClientError {
    ProfileClientError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "共识画像读取不可用",
    }
}

fn mismatch() -> ProfileClientError {
    ProfileClientError {
        status: StatusCode::CONFLICT,
        code: "共识画像身份或水位不符",
    }
}

impl ProfileConsensusClient {
    pub(crate) fn new(
        config: ProfileConsensusConfig,
        catalog_sha256: String,
    ) -> Result<Self, String> {
        if !valid_id(&config.cluster_id)
            || config
                .profile_access_audience
                .as_ref()
                .is_some_and(|audience| !valid_id(audience))
            || (config.profile_access_audience.is_some() && config.tls.is_none())
            || !(1..=5).contains(&config.endpoints.len())
            || config.endpoints.iter().collect::<HashSet<_>>().len() != config.endpoints.len()
            || config
                .endpoints
                .iter()
                .any(|address| !vs_tls::allowed_endpoint(*address, config.tls.is_some()))
            || !(32..=256).contains(&config.service_token.len())
            || !config
                .service_token
                .bytes()
                .all(|byte| byte.is_ascii_graphic())
            || !(2..=16).contains(&config.shard_count)
            || !config.shard_count.is_power_of_two()
            || !(1..=MAX_INDEX).contains(&config.minimum_applied_index)
        {
            return Err("共识画像实验要求固定受限端点、有效集群/凭据/分片及非零水位".into());
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let builder = match &config.tls {
            Some(tls) => tls
                .client_builder(&config.endpoints)
                .map_err(|_| "共识画像TLS材料或固定名称无效")?,
            None => reqwest::Client::builder(),
        };
        let client = builder
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_millis(200))
            .timeout(Duration::from_millis(600))
            .pool_max_idle_per_host(4)
            .build()
            .map_err(|_| "共识画像客户端初始化失败")?;
        let observed_index = AtomicU64::new(config.minimum_applied_index);
        Ok(Self {
            config,
            client,
            catalog_sha256,
            preferred: AtomicUsize::new(0),
            observed_index,
        })
    }

    fn identity(
        &self,
        cluster: &str,
        catalog: &str,
        shard_count: u16,
        applied_index: u64,
    ) -> Result<(), ProfileClientError> {
        if cluster != self.config.cluster_id
            || catalog != self.catalog_sha256
            || shard_count != self.config.shard_count
            || !(1..=MAX_INDEX).contains(&applied_index)
            || applied_index < self.observed_index.load(Ordering::Acquire)
        {
            return Err(mismatch());
        }
        Ok(())
    }

    fn remember(&self, applied_index: u64) -> Result<(), ProfileClientError> {
        // 进程内最低已观察水位只防回退，不冒充跨API持久历史或防重建集群证明。
        if self
            .observed_index
            .fetch_max(applied_index, Ordering::AcqRel)
            > applied_index
        {
            return Err(mismatch());
        }
        Ok(())
    }

    async fn read<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<&serde_json::Value>,
        profile_access: Option<&str>,
    ) -> Result<T, ProfileClientError> {
        self.read_with_trace_context(path, body, profile_access, None)
            .await
    }

    async fn read_with_trace_context<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<&serde_json::Value>,
        profile_access: Option<&str>,
        trace_context: Option<&TraceContext>,
    ) -> Result<T, ProfileClientError> {
        tokio::time::timeout(Duration::from_secs(2), async {
            let start = self.preferred.load(Ordering::Relaxed);
            for offset in 0..self.config.endpoints.len() {
                let index = (start + offset) % self.config.endpoints.len();
                let address = self.config.endpoints[index];
                let url = match &self.config.tls {
                    Some(tls) => format!(
                        "https://{}:{}{path}",
                        tls.server_names[&address],
                        address.port()
                    ),
                    None => format!("http://{address}{path}"),
                };
                let builder = match body {
                    Some(body) => self.client.post(url).json(body),
                    None => self.client.get(url),
                }
                .bearer_auth(&self.config.service_token);
                let builder = match profile_access {
                    Some(token) => {
                        builder.header("x-profile-access-grant", format!("Bearer {token}"))
                    }
                    None => builder,
                };
                let builder =
                    if let Some(value) = trace_context.and_then(TraceContext::to_traceparent) {
                        builder.header("traceparent", value)
                    } else {
                        builder
                    };
                // 只切换只读请求，永不读取响应Location/leader地址或重发画像事件。
                let Ok(mut response) = builder.send().await else {
                    continue;
                };
                if matches!(
                    response.status(),
                    StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
                ) {
                    continue;
                }
                if response.status() != StatusCode::OK {
                    return Err(mismatch());
                }
                if response
                    .content_length()
                    .is_some_and(|length| length > 65_536)
                {
                    return Err(mismatch());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
                    if chunk.len() > 65_536 - bytes.len() {
                        return Err(mismatch());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let result = serde_json::from_slice(&bytes).map_err(|_| mismatch())?;
                self.preferred.store(index, Ordering::Relaxed);
                return Ok(result);
            }
            Err(unavailable())
        })
        .await
        .map_err(|_| unavailable())?
    }

    pub(crate) async fn ready(&self) -> Result<(), ProfileClientError> {
        // 新TLS路径不读取写者元数据；原明文实验保留旧服务兼容。
        if self.config.tls.is_some() {
            let view: ReadyResponse = self.read("/internal/lab/profile/ready", None, None).await?;
            if view.schema != "profile-consensus-ready-v1" {
                return Err(mismatch());
            }
            self.identity(
                &view.cluster_id,
                &view.catalog_sha256,
                view.shard_count,
                view.applied_index,
            )?;
            return self.remember(view.applied_index);
        }
        let view: WriterResponse = self
            .read("/internal/lab/profile/writers/0", None, None)
            .await?;
        if view.schema != "profile-consensus-writer-v1"
            || view.shard != 0
            || view.events > 256
            || view
                .writer
                .as_ref()
                .is_some_and(|writer| !writer.is_object())
        {
            return Err(mismatch());
        }
        self.identity(
            &view.cluster_id,
            &view.catalog_sha256,
            view.shard_count,
            view.applied_index,
        )?;
        self.remember(view.applied_index)
    }

    pub(crate) async fn projection_with_trace_context(
        &self,
        subject: &str,
        domains: &[String],
        profile_access: Option<&str>,
        trace_context: Option<&TraceContext>,
    ) -> Result<Option<ProfileProjection>, ProfileClientError> {
        if !valid_id(subject)
            || domains.is_empty()
            || domains.len() > 16
            || domains.iter().any(|domain| !valid_id(domain))
            || domains.iter().collect::<HashSet<_>>().len() != domains.len()
        {
            return Err(mismatch());
        }
        if self.config.profile_access_audience.is_some() && profile_access.is_none() {
            return Err(ProfileClientError {
                status: StatusCode::UNAUTHORIZED,
                code: "共识画像请求缺少主体授权凭据",
            });
        }
        let view: ProjectionResponse = self
            .read_with_trace_context(
                "/internal/lab/profile/projection",
                Some(&serde_json::json!({"subject":subject,"domains":domains})),
                profile_access,
                trace_context,
            )
            .await?;
        self.identity(
            &view.cluster_id,
            &view.catalog_sha256,
            view.shard_count,
            view.applied_index,
        )?;
        if view.schema != "profile-consensus-projection-v1"
            || view.subject != subject
            || view.domains != domains
            || view
                .profile
                .as_ref()
                .is_some_and(|profile| profile.subject != subject || profile.scopes != domains)
        {
            return Err(mismatch());
        }
        if let Some(profile) = &view.profile {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| unavailable())?
                .as_secs();
            if profile.expires_at > now.saturating_add(60)
                || profile
                    .version
                    .strip_prefix("memory-")
                    .and_then(|value| value.parse::<u64>().ok())
                    .is_none_or(|value| value == 0 || value > view.applied_index)
            {
                return Err(mismatch());
            }
            let request = RecommendationRequest {
                request_id: "consensus-validation".into(),
                domains: domains.to_vec(),
                limit: 1,
                profile: Some(profile.clone()),
            };
            RequestContext::new(&request, now).map_err(|_| mismatch())?;
        }
        self.remember(view.applied_index)?;
        Ok(view.profile)
    }
}
