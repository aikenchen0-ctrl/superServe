use std::{
    collections::HashMap,
    io,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{StreamExt, stream};
use http_range::HttpRange;
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, RwLock, Semaphore};
use tower_http::timeout::TimeoutLayer;
use vs_core::{
    DomainError,
    catalog::{MediaAsset, PublicCatalog},
    grouped_recall::GroupedRecall,
    profile::{MAX_PROFILE_SUBJECTS, ProfileEvent, ProfileEventFacts, ProfileState},
    recall::CatalogRecall,
    recommendation::RecommendationRequest,
};
use vs_storage::{HttpMetricsSnapshot, MediaStore};

mod profile_client;
mod profile_consensus;
pub use profile_consensus::ProfileConsensusConfig;
#[cfg(test)]
mod profile_commit_tests;
mod profile_log;
mod upstream;
pub use profile_client::ProfileRemoteConfig;
use profile_client::{HistoryRequest, HistoryResponse, ProjectionRequest, ProjectionResponse};
mod profile_shards;
use profile_log::{AppendResult, ProfileEventLog};
pub use profile_log::{
    ProfileBackupReceipt, backup_profile_log, restore_profile_backup, verify_profile_backup,
};
pub use profile_log::{ProfileHistoryCheckpoint, ProfileHistoryHandoff, handoff_profile_log};
pub use profile_log::{ProfileLogMigration, migrate_legacy_profile_log};
use profile_shards::ProfileBackend;
pub use profile_shards::{ProfileShard, ProfileShardRemote, ProfileShardsConfig};
pub mod consumption;
pub mod consumption_access;
pub mod consumption_replay;
pub mod delivery;
pub mod deployment;
pub mod domain_audit;
pub mod evidence_replay;
pub mod feed_access;
pub mod feedback_evidence;
pub mod feedback_log;
pub mod hls;
pub mod learning_evidence;
mod learning_journal;
pub mod model_recall_probe;
mod trace_context;
pub use learning_journal::LearningCommitMode;
pub mod playback_access;
pub mod playback_policy;
pub mod publication;
pub mod qdrant_model_recall;
pub mod qdrant_recall;
pub mod rank_model;
pub mod s3_catalog;
pub mod s3_publication;
pub mod slate;
pub mod temporal_replay;
pub mod video;
use qdrant_recall::{QdrantConfig, QdrantRecall, RecallReadiness};

const PROFILE_WRITE_CONCURRENCY: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Api,
    Media,
    All,
    Profile,
    Feedback,
}

#[derive(Default)]
pub struct Counters {
    pub recommendations: AtomicU64,
    pub media_bytes_yielded: AtomicU64,
    pub overloads: AtomicU64,
    pub profile_events: AtomicU64,
    pub duplicate_profile_events: AtomicU64,
    pub recall_queries: AtomicU64,
    pub recall_degraded: AtomicU64,
    pub grouped_queries: AtomicU64,
    pub grouped_groups_scored: AtomicU64,
    pub grouped_candidates_examined: AtomicU64,
}

pub struct AppState {
    catalog: Arc<PublicCatalog>,
    catalog_sha256: String,
    assets: HashMap<String, MediaAsset>,
    candidates: HashMap<String, vs_core::catalog::Candidate>,
    store: Option<MediaStore>,
    token_hash: [u8; 32],
    profiles: Arc<RwLock<HashMap<String, ProfileState>>>,
    profile_log: Option<Arc<ProfileEventLog>>,
    profile_commit_gate: Arc<Mutex<()>>,
    profile_write_slots: Arc<Semaphore>,
    profile_remote: Option<ProfileBackend>,
    profile_access_audience: Option<String>,
    profile_shard: Option<ProfileShard>,
    profile_rpc_slots: Arc<Semaphore>,
    profile_authority: bool,
    rank_slots: Arc<Semaphore>,
    recall: Option<Arc<QdrantRecall>>,
    recall_readiness: Option<RecallReadiness>,
    deployment: Option<deployment::DeploymentSelection>,
    recall_index: Option<Arc<CatalogRecall>>,
    grouped_recall: Option<Arc<GroupedRecall>>,
    rank_model: Option<Arc<rank_model::RankModelState>>,
    model_selection: rank_model::ModelSelection,
    slate_policy: Option<vs_core::slate::SlatePolicy>,
    learning_journal: Option<Arc<learning_journal::LearningJournal>>,
    feedback_log: Option<Arc<feedback_log::IggyFeedbackLog>>,
    consumption_access: Option<Arc<consumption_access::ConsumptionAccess>>,
    feed_access: Option<Arc<feed_access::FeedAccess>>,
    pub media_slots: Arc<Semaphore>,
    pub counters: Arc<Counters>,
    delivery: Option<Arc<delivery::DeliveryCounters>>,
    playback_policy: vs_core::playback::PlaybackPolicy,
    playback_access: Option<playback_access::PlaybackAccess>,
}

impl AppState {
    pub fn new(
        catalog_bytes: &[u8],
        store: Option<MediaStore>,
        token: &str,
        rank_concurrency: usize,
        media_concurrency: usize,
    ) -> Result<Self, &'static str> {
        Self::new_with_profile_log(
            catalog_bytes,
            store,
            token,
            rank_concurrency,
            media_concurrency,
            None,
        )
        .map_err(|_| "service_state_initialization_failed")
    }

    pub fn new_with_profile_log(
        catalog_bytes: &[u8],
        store: Option<MediaStore>,
        token: &str,
        rank_concurrency: usize,
        media_concurrency: usize,
        profile_log_path: Option<&std::path::Path>,
    ) -> Result<Self, String> {
        Self::new_with_profile_layout(
            catalog_bytes,
            store,
            token,
            rank_concurrency,
            media_concurrency,
            (profile_log_path, None),
        )
    }

    pub fn new_with_profile_shard(
        catalog_bytes: &[u8],
        token: &str,
        profile_log_path: &std::path::Path,
        shard: ProfileShard,
    ) -> Result<Self, String> {
        shard.validate()?;
        Self::new_with_profile_layout(
            catalog_bytes,
            None,
            token,
            1,
            1,
            (Some(profile_log_path), Some(shard)),
        )?
        .into_profile_authority()
    }

    fn new_with_profile_layout(
        catalog_bytes: &[u8],
        store: Option<MediaStore>,
        token: &str,
        rank_concurrency: usize,
        media_concurrency: usize,
        layout: (Option<&std::path::Path>, Option<ProfileShard>),
    ) -> Result<Self, String> {
        let (profile_log_path, shard) = layout;
        if token.len() < 32 || token.len() > 256 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("service_token_must_be_32_to_256_printable_ascii_bytes".into());
        }
        if !(1..=128).contains(&rank_concurrency) || !(1..=1024).contains(&media_concurrency) {
            return Err("concurrency_out_of_bounds".into());
        }
        if catalog_bytes.len() > 8 * 1024 * 1024 {
            return Err("catalog_too_large".into());
        }
        let catalog: PublicCatalog = serde_json::from_slice(catalog_bytes)
            .map_err(|_| "catalog_json_invalid".to_string())?;
        catalog
            .validate()
            .map_err(|_| "catalog_invalid".to_string())?;
        let candidates: HashMap<_, _> = catalog
            .items
            .iter()
            .cloned()
            .map(|candidate| (candidate.id.clone(), candidate))
            .collect();
        let catalog_sha256 = format!("{:x}", Sha256::digest(catalog_bytes));
        let profile_log = profile_log_path
            .map(|path| match &shard {
                Some(shard) => ProfileEventLog::open_shard(path, &catalog_sha256, shard),
                None => ProfileEventLog::open(path, &catalog_sha256),
            })
            .transpose()?
            .map(|(log, events)| (Arc::new(log), events));
        let mut profiles: HashMap<String, ProfileState> = HashMap::new();
        if let Some((_, events)) = &profile_log {
            for observed in events {
                let event = &observed.payload.event;
                let is_new = !profiles.contains_key(&event.subject);
                if is_new && profiles.len() >= MAX_PROFILE_SUBJECTS {
                    return Err("profile_store_full".into());
                }
                profiles
                    .entry(event.subject.clone())
                    .or_default()
                    .apply_observed(event, &observed.payload.facts)
                    .map_err(|_| "profile_log_replay_failed".to_string())?;
            }
        }
        Ok(Self {
            assets: catalog
                .assets
                .iter()
                .map(|a| (a.sha256.clone(), a.clone()))
                .collect(),
            candidates,
            catalog: Arc::new(catalog),
            catalog_sha256,
            store,
            token_hash: Sha256::digest(token.as_bytes()).into(),
            rank_slots: Arc::new(Semaphore::new(rank_concurrency)),
            media_slots: Arc::new(Semaphore::new(media_concurrency)),
            counters: Arc::new(Counters::default()),
            delivery: None,
            playback_policy: Default::default(),
            playback_access: None,
            profiles: Arc::new(RwLock::new(profiles)),
            profile_log: profile_log.map(|(log, _)| log),
            profile_commit_gate: Arc::new(Mutex::new(())),
            profile_write_slots: Arc::new(Semaphore::new(PROFILE_WRITE_CONCURRENCY)),
            profile_remote: None,
            profile_access_audience: None,
            profile_shard: shard,
            profile_rpc_slots: Arc::new(Semaphore::new(64)),
            profile_authority: false,
            recall: None,
            recall_readiness: None,
            deployment: None,
            recall_index: None,
            grouped_recall: None,
            rank_model: None,
            model_selection: Default::default(),
            slate_policy: None,
            learning_journal: None,
            feedback_log: None,
            consumption_access: None,
            feed_access: None,
        })
    }

    pub fn with_delivery_observation(mut self) -> Self {
        self.delivery = Some(Arc::new(delivery::DeliveryCounters::default()));
        self
    }

    pub fn with_playback_access(mut self, key: &[u8], audience: &str) -> Result<Self, String> {
        if <[u8; 32]>::from(Sha256::digest(key)) == self.token_hash {
            return Err("播放签名密钥不能复用内部服务令牌".into());
        }
        self.playback_access = Some(playback_access::PlaybackAccess::new(
            key,
            audience,
            &self.catalog_sha256,
        )?);
        Ok(self)
    }

    pub fn with_playback_linkage_v2(mut self) -> Result<Self, &'static str> {
        self.playback_access
            .as_mut()
            .ok_or("启用播放关联令牌前必须先配置播放签名")?
            .enable_linkage_v2();
        Ok(self)
    }

    pub fn with_playback_policy(
        mut self,
        policy: vs_core::playback::PlaybackPolicy,
    ) -> Result<Self, String> {
        policy.validate().map_err(|_| "播放策略无效")?;
        self.playback_policy = policy;
        Ok(self)
    }

    pub fn into_profile_authority(mut self) -> Result<Self, String> {
        if self.profile_log.is_none() || self.profile_remote.is_some() {
            return Err("profile_authority_requires_exclusive_local_log".into());
        }
        if self.recall.is_some()
            || self.grouped_recall.is_some()
            || self.rank_model.is_some()
            || self.learning_journal.is_some()
            || self.feedback_log.is_some()
            || self.slate_policy.is_some()
        {
            return Err("画像权威服务不能同时持有召回后端".into());
        }
        self.profile_authority = true;
        Ok(self)
    }

    pub fn with_profile_remote(mut self, config: ProfileRemoteConfig) -> Result<Self, String> {
        if self.profile_log.is_some()
            || self.profile_authority
            || self.profile_remote.is_some()
            || self.feedback_log.is_some()
        {
            return Err("local_and_remote_profiles_are_exclusive".into());
        }
        self.profile_remote = Some(ProfileBackend::single(config, self.catalog_sha256.clone())?);
        Ok(self)
    }

    pub fn with_profile_shards(mut self, config: ProfileShardsConfig) -> Result<Self, String> {
        if self.profile_log.is_some()
            || self.profile_authority
            || self.profile_remote.is_some()
            || self.feedback_log.is_some()
            || self.deployment.is_some()
        {
            return Err("分片画像不能与本地日志、单入口或固定部署选择混用".into());
        }
        self.profile_remote = Some(ProfileBackend::sharded(
            config,
            self.catalog_sha256.clone(),
        )?);
        Ok(self)
    }

    pub fn with_profile_consensus(
        mut self,
        config: ProfileConsensusConfig,
    ) -> Result<Self, String> {
        if self.profile_log.is_some()
            || self.profile_authority
            || self.profile_remote.is_some()
            || self.feedback_log.is_some()
            || self.deployment.is_some()
        {
            return Err("共识画像只读实验不能与本地/单入口/分片画像或固定部署混用".into());
        }
        self.profile_access_audience = config.profile_access_audience.clone();
        self.profile_remote = Some(ProfileBackend::consensus(
            config,
            self.catalog_sha256.clone(),
        )?);
        Ok(self)
    }

    pub(crate) fn profile_authorization_audience(&self) -> Option<&str> {
        self.profile_access_audience.as_deref()
    }

    pub fn with_profile_history(
        mut self,
        checkpoint: ProfileHistoryCheckpoint,
    ) -> Result<Self, String> {
        let remote = self
            .profile_remote
            .take()
            .ok_or("历史水位只能绑定远端画像权威")?;
        self.profile_remote = Some(remote.with_history(checkpoint)?);
        Ok(self)
    }

    pub fn profile_history_checkpoint(&self) -> Result<ProfileHistoryCheckpoint, String> {
        let _commit = self
            .profile_commit_gate
            .try_lock()
            .map_err(|_| "画像提交进行中，暂不能读取一致历史水位")?;
        self.profile_log
            .as_ref()
            .ok_or("画像历史需要持久事件日志")?
            .checkpoint()
    }

    pub fn with_qdrant_recall(mut self, config: QdrantConfig) -> Result<Self, String> {
        if self.rank_model.is_some() || self.feedback_log.is_some() {
            return Err("旧标签召回尚未验证学习排序的召回质量，不能同时启用".into());
        }
        if self.profile_authority {
            return Err("profile_role_cannot_rank".into());
        }
        if self.grouped_recall.is_some() {
            return Err("Qdrant 与本地分组召回不能同时启用".into());
        }
        self.recall = Some(Arc::new(QdrantRecall::new(
            config,
            self.catalog_sha256.clone(),
        )?));
        self.recall_readiness = None;
        self.recall_index = Some(Arc::new(CatalogRecall::new(&self.catalog)));
        Ok(self)
    }

    pub async fn verify_recall_publication(&mut self, catalog_bytes: &[u8]) -> Result<(), String> {
        if let Some(recall) = &self.recall {
            self.recall_readiness = None;
            self.recall_readiness = Some(recall.verify_published(catalog_bytes).await?);
        }
        Ok(())
    }

    pub async fn verify_profile_readiness(&self) -> Result<(), String> {
        if let Some(remote) = &self.profile_remote {
            remote
                .ready()
                .await
                .map_err(|_| "画像权威未就绪或目录版本不符")?;
        }
        Ok(())
    }

    pub fn with_deployment_snapshot(
        mut self,
        snapshot: &deployment::DeploymentSnapshot,
    ) -> Result<Self, String> {
        if self.slate_policy.is_some() {
            return Err("固定部署记录尚未绑定列表策略，不能额外启用".into());
        }
        if snapshot.record().target.catalog_sha256 != self.catalog_sha256 {
            return Err("部署选择与实例目录指纹不符".into());
        }
        let target = &snapshot.record().target;
        if target.rank_model_sha256.as_deref()
            != self.rank_model.as_ref().map(|model| model.sha256.as_str())
        {
            return Err("部署选择与实例排序模型指纹不符".into());
        }
        let profile_endpoint =
            reqwest::Url::parse(&target.profile_authority).map_err(|_| "部署画像入口无效")?;
        if self.profile_remote.as_ref().is_none_or(|client| {
            client.endpoint() != Some(profile_endpoint.as_str().trim_end_matches('/'))
                || client.history() != snapshot.record().profile_checkpoint.as_ref()
        }) {
            return Err("部署选择与实例画像入口不符".into());
        }
        let matched = match &target.recall {
            deployment::DeploymentRecall::Catalog => {
                self.recall.is_none()
                    && self.grouped_recall.is_none()
                    && !self.model_selection.enabled()
            }
            deployment::DeploymentRecall::ModelTopK => {
                self.model_selection.backend() == "model-topk"
                    && self.rank_model.is_some()
                    && self.recall.is_none()
                    && self.grouped_recall.is_none()
            }
            deployment::DeploymentRecall::ModelPruned => {
                self.model_selection.backend() == "model-pruned"
                    && self.rank_model.is_some()
                    && self.recall.is_none()
                    && self.grouped_recall.is_none()
            }
            deployment::DeploymentRecall::Grouped => {
                self.recall.is_none() && self.grouped_recall.is_some()
            }
            deployment::DeploymentRecall::ModelBlockMax => {
                self.model_selection.backend() == "model-blockmax"
                    && self.rank_model.is_some()
                    && self.recall.is_none()
                    && self.grouped_recall.is_none()
            }
            deployment::DeploymentRecall::Qdrant { endpoint, scoring } => {
                self.recall.as_ref().is_some_and(|recall| {
                    reqwest::Url::parse(endpoint).is_ok_and(|endpoint| {
                        recall.endpoint() == endpoint.as_str().trim_end_matches('/')
                    }) && recall.scoring().name() == scoring
                        && self.recall_readiness.is_some()
                })
            }
        };
        if !matched {
            return Err("部署选择与实例召回配置不符".into());
        }
        self.deployment = Some(snapshot.selection());
        Ok(self)
    }

    pub fn with_grouped_recall(mut self) -> Result<Self, String> {
        if self.rank_model.is_some() || self.feedback_log.is_some() {
            return Err("旧分组召回尚未验证学习排序的召回质量，不能同时启用".into());
        }
        if self.profile_authority || self.recall.is_some() {
            return Err("本地分组召回不能用于画像权威服务或与 Qdrant 同时启用".into());
        }
        self.grouped_recall = Some(Arc::new(
            GroupedRecall::new(self.catalog.clone()).map_err(|_| "分组索引构建失败")?,
        ));
        Ok(self)
    }

    pub fn profile_count(&self) -> usize {
        self.profiles
            .try_read()
            .map(|profiles| profiles.len())
            .unwrap_or(0)
    }

    pub async fn drain_profile_writes(&self) {
        // 一次持有全部许可后关闭入口，保证已接纳提交完成再结束运行时。
        if let Ok(_permit) = self
            .profile_write_slots
            .acquire_many(PROFILE_WRITE_CONCURRENCY as u32)
            .await
        {
            self.profile_write_slots.close();
        }
    }
}

pub fn router(state: Arc<AppState>, role: Role) -> Router {
    let mut protected = Router::new()
        .route(
            "/readyz",
            if role == Role::Feedback {
                get(feedback_log::ready)
            } else {
                get(ready)
            },
        )
        .route("/v1/metrics", get(metrics));
    if role == Role::Feedback {
        protected = protected.route("/internal/v1/learning/events", post(feedback_log::ingest));
        protected = protected.route(
            "/internal/v1/consumption/events",
            post(feedback_log::ingest_consumption),
        );
    }
    if matches!(role, Role::Api | Role::All) {
        protected = protected.route("/v1/recommendations", post(recommendations));
        protected = protected.route("/v1/feed", post(feed));
        protected = protected.route("/v1/playback/policy", get(playback_policy::get_policy));
        if state.playback_access.is_some() {
            protected =
                protected.route("/internal/v1/playback/grants", post(playback_access::issue));
        }
    }
    if matches!(role, Role::Api | Role::All) {
        protected = protected.route("/v1/profile/events", post(profile_events));
    }
    if state.feed_access.is_some() && matches!(role, Role::Api | Role::All) {
        let delegated_feed = Router::new()
            .route("/internal/v2/feed", post(feed_access::feed))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                feed_access::authenticate,
            ));
        protected = protected.merge(delegated_feed);
    }
    if role == Role::Profile {
        protected = protected.route("/internal/v1/profile/events", post(profile_events));
        protected = protected.route("/internal/v1/profile/projection", post(profile_projection));
        protected = protected.route("/internal/v1/profile/history", post(profile_history));
    }
    if matches!(role, Role::Media | Role::All) {
        let media_routes = Router::new()
            .route("/v1/media/{sha256}", get(media))
            .route("/v1/media/{sha256}/{filename}", get(named_media))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                delivery::observe,
            ));
        protected = protected.merge(media_routes);
    }
    let protected = protected
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .merge(Router::new().route("/healthz", get(|| async { "ok" })));
    let protected = if state.playback_access.is_some() && matches!(role, Role::Media | Role::All) {
        let playback_routes = Router::new()
            .route(
                "/v1/playback/{token}/{sha256}/{filename}",
                get(playback_access::read),
            )
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                delivery::observe,
            ));
        protected.merge(playback_routes)
    } else {
        protected
    };
    let protected = if role == Role::Feedback && state.consumption_access.is_some() {
        let client_routes = Router::new()
            .route(
                "/v1/client/consumption/events",
                post(consumption_access::ingest),
            )
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                consumption_access::authenticate,
            ));
        protected.merge(client_routes)
    } else {
        protected
    };
    protected
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(10),
        ))
        .with_state(state)
}

async fn authenticate(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    let valid = token.is_some_and(|token| {
        let incoming: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        bool::from(state.token_hash.ct_eq(&incoming))
    });
    if !valid {
        return ApiError(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    if state.profile_authority
        && request.method() == Method::POST
        && request
            .headers()
            .get("x-catalog-sha256")
            .and_then(|h| h.to_str().ok())
            != Some(state.catalog_sha256.as_str())
    {
        return ApiError(StatusCode::CONFLICT, "profile_catalog_mismatch").into_response();
    }
    let shard_guard = state.profile_shard.as_ref().map(ProfileShard::guard);
    if state.profile_authority
        && request.method() == Method::POST
        && request
            .headers()
            .get("x-profile-shard-guard")
            .and_then(|value| value.to_str().ok())
            != shard_guard.as_deref()
    {
        return ApiError(StatusCode::CONFLICT, "画像分片身份不符").into_response();
    }
    let history_guard = if state.profile_authority {
        match request.headers().get("x-profile-history-guard") {
            Some(value) => match value.to_str() {
                Ok(guard)
                    if state
                        .profile_log
                        .as_ref()
                        .is_some_and(|log| log.accepts_guard(guard)) =>
                {
                    Some(value.clone())
                }
                _ => {
                    return ApiError(StatusCode::CONFLICT, "画像历史凭据未注册或已失效")
                        .into_response();
                }
            },
            None => None,
        }
    } else {
        None
    };
    let mut response = next.run(request).await;
    if state.profile_authority {
        if let Some(shard) = &state.profile_shard {
            response.headers_mut().insert(
                "x-profile-shard-guard",
                HeaderValue::from_str(&shard.guard()).unwrap(),
            );
        }
        if let Some(guard) = history_guard {
            response
                .headers_mut()
                .insert("x-profile-history-guard", guard);
        }
        response.headers_mut().insert(
            "x-catalog-sha256",
            HeaderValue::from_str(&state.catalog_sha256).unwrap(),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

pub(crate) fn request_trace_context(
    headers: &HeaderMap,
) -> Option<trace_context::TracePropagation> {
    trace_context::TracePropagation::from_headers(headers)
}

pub fn observation_trace_id(headers: &HeaderMap) -> Option<String> {
    trace_context::trace_id_from_headers(headers)
}

pub fn observation_request_id(headers: &HeaderMap) -> Option<String> {
    trace_context::request_id_from_headers(headers)
}

#[derive(Debug)]
struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.0, Json(serde_json::json!({"error": self.1}))).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if self.0 == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        }
        response
    }
}

fn overload(state: &AppState) -> ApiError {
    state.counters.overloads.fetch_add(1, Ordering::Relaxed);
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy")
}

async fn recommendations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut request): Json<RecommendationRequest>,
) -> Result<Response, ApiError> {
    let trace_id = observation_trace_id(&headers);
    let permit = state
        .rank_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| overload(&state))?;
    let catalog = state.catalog.clone();
    let rank_model = state.rank_model.clone();
    let model_selection = state.model_selection.clone();
    let started = Instant::now();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "clock_unavailable"))?
        .as_secs();
    let learning_snapshot = learning_journal::snapshot(
        &state,
        &request,
        request
            .profile
            .as_ref()
            .map(|profile| profile.subject.as_str()),
        now,
    );
    let slate_state = state.clone();
    // 计算任务持有许可直到真正结束，HTTP 超时不会造成无界的后台任务。
    let mut result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let limit = slate::prepare(&mut request, slate_state.slate_policy.as_ref())?;
        let mut result = rank_model::recommend(
            &catalog,
            &request,
            now,
            rank_model.as_deref(),
            &model_selection,
        )?;
        slate::finish(&slate_state, &mut result, limit)?;
        Ok::<_, DomainError>(result)
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "rank_failed"))?
    .map_err(|error| match error {
        DomainError::Invalid(_) => ApiError(StatusCode::BAD_REQUEST, "invalid_request"),
        DomainError::Expired => ApiError(StatusCode::FORBIDDEN, "projection_expired"),
        DomainError::ScopeDenied => ApiError(StatusCode::FORBIDDEN, "projection_scope_denied"),
        DomainError::Capacity => {
            ApiError(StatusCode::INSUFFICIENT_STORAGE, "profile_capacity_reached")
        }
    })?;
    state
        .counters
        .recommendations
        .fetch_add(1, Ordering::Relaxed);
    tracing::info!(
        operation = "recommend",
        elapsed_us = started.elapsed().as_micros() as u64,
        considered = result.considered
    );
    resolve_playback_paths(&state, &mut result);
    let receipt_identity = learning_snapshot.as_ref().map(|snapshot| {
        (
            snapshot.subject.clone(),
            snapshot
                .request
                .profile
                .as_ref()
                .map_or(now + 60, |profile| profile.expires_at),
        )
    });
    let decision_id = learning_journal::capture(&state, learning_snapshot, &result).await?;
    let receipt = playback_access::decision_receipt(
        &state,
        receipt_identity,
        &result,
        decision_id.as_deref(),
    )?;
    let request_id = HeaderValue::from_str(&result.request_id)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_request_id"))?;
    let mut response = Json(result).into_response();
    if let Some(receipt) = receipt {
        response
            .headers_mut()
            .insert("x-playback-decision-receipt", receipt);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response.headers_mut().insert("x-request-id", request_id);
    response.headers_mut().insert(
        "x-catalog-sha256",
        HeaderValue::from_str(&state.catalog_sha256).unwrap(),
    );
    rank_model::insert_model_header(&state, &mut response);
    slate::insert_header(&state, &mut response);
    if state.model_selection.enabled() {
        response.headers_mut().insert(
            "x-recall-mode",
            HeaderValue::from_static(state.model_selection.backend()),
        );
    }
    if let Some(id) = decision_id {
        response.headers_mut().insert(
            "x-learning-decision-id",
            HeaderValue::from_str(&id).unwrap(),
        );
    }
    insert_trace_id_header(&mut response, trace_id.as_deref());
    Ok(response)
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedRequest {
    pub(crate) request_id: String,
    pub(crate) subject: String,
    pub(crate) domains: Vec<String>,
    pub(crate) limit: usize,
}

async fn feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<FeedRequest>,
) -> Result<Response, ApiError> {
    let trace_context = request_trace_context(&headers);
    feed_for_subject_with_profile_access_and_trace(state, request, None, trace_context.as_ref())
        .await
}

#[cfg(test)]
pub(crate) async fn feed_for_subject(
    state: Arc<AppState>,
    request: FeedRequest,
) -> Result<Response, ApiError> {
    feed_for_subject_with_profile_access_and_trace(state, request, None, None).await
}

pub(crate) async fn feed_for_subject_with_profile_access_and_trace(
    state: Arc<AppState>,
    request: FeedRequest,
    profile_access: Option<String>,
    trace_context: Option<&trace_context::TracePropagation>,
) -> Result<Response, ApiError> {
    if !vs_core::valid_id(&request.subject)
        || !vs_core::valid_id(&request.request_id)
        || request.domains.is_empty()
        || request.domains.len() > 16
        || request
            .domains
            .iter()
            .any(|domain| !vs_core::valid_id(domain))
        || !(1..=50).contains(&request.limit)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_feed_request"));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "clock_unavailable"))?
        .as_secs();
    let profile = if let Some(remote) = &state.profile_remote {
        let _permit = state
            .profile_rpc_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| overload(&state))?;
        remote
            .projection_with_trace_context(
                &request.subject,
                &request.domains,
                profile_access.as_deref(),
                trace_context,
            )
            .await
            .map_err(|error| ApiError(error.status, error.code))?
    } else {
        state
            .profiles
            .read()
            .await
            .get(&request.subject)
            .map(|profile| profile.projection(&request.subject, request.domains.clone(), now + 60))
    };
    let rank_request = RecommendationRequest {
        request_id: request.request_id,
        domains: request.domains,
        limit: request.limit,
        profile,
    };
    let learning_snapshot = if state.learning_journal.is_some() {
        learning_journal::snapshot(
            &state,
            &rank_request,
            Some(&request.subject),
            learning_journal::unix_time()?,
        )
    } else {
        None
    };
    let permit = state
        .rank_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| overload(&state))?;
    let catalog = state.catalog.clone();
    let recall = state.recall.clone();
    let recall_index = state.recall_index.clone();
    let grouped_recall = state.grouped_recall.clone();
    let rank_model = state.rank_model.clone();
    let model_selection = state.model_selection.clone();
    let counters = state.counters.clone();
    let slate_state = state.clone();
    // 召回和排序共用一个请求预算，外部等待不会形成无界待排任务。
    let result = tokio::spawn(async move {
        let mut rank_request = rank_request;
        let limit = slate::prepare(&mut rank_request, slate_state.slate_policy.as_ref())?;
        let query_now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(u64::MAX, |duration| duration.as_secs());
        let context = vs_core::recommendation::RequestContext::new(&rank_request, query_now)?;
        let mut mode = "catalog";
        let mut subset = None;
        if let (Some(recall), Some(recall_index)) = (recall, recall_index) {
            let prior = recall_index.prior_with_scoring(&catalog, &context, recall.scoring());
            let (indices, values) = recall_index.query_with_scoring(&context, recall.scoring());
            let ids = if prior.neutral_first {
                // 所有权重非正时，非负目录向量不可能得到正分，无需发起 RPC。
                mode = "prior-nonpositive";
                Vec::new()
            } else if indices.is_empty() {
                mode = "prior-cold";
                Vec::new()
            } else {
                counters.recall_queries.fetch_add(1, Ordering::Relaxed);
                match recall.query(&rank_request, indices, values).await {
                    Ok(ids) => {
                        mode = match recall.scoring() {
                            vs_core::recall::RecallScoring::Positive => "qdrant-tags+prior",
                            vs_core::recall::RecallScoring::Signed => "qdrant-signed-tags+prior",
                        };
                        ids
                    }
                    Err(_) => {
                        mode = "prior-degraded";
                        counters.recall_degraded.fetch_add(1, Ordering::Relaxed);
                        Vec::new()
                    }
                }
            };
            subset = Some(recall_index.merge(&catalog, &context, prior.indices, &ids));
        }
        drop(context);
        let rank_now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(u64::MAX, |duration| duration.as_secs());
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let result = if let Some(grouped) = grouped_recall {
                // 分组遍历与归并均在阻塞任务内执行，沿用同一个有界排序许可。
                let context =
                    vs_core::recommendation::RequestContext::new(&rank_request, rank_now)?;
                let selected = grouped.select(&context);
                counters.grouped_queries.fetch_add(1, Ordering::Relaxed);
                counters
                    .grouped_groups_scored
                    .fetch_add(selected.groups_scored as u64, Ordering::Relaxed);
                counters
                    .grouped_candidates_examined
                    .fetch_add(selected.candidates_examined as u64, Ordering::Relaxed);
                mode = "grouped-tags";
                let completed_at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(u64::MAX, |duration| duration.as_secs());
                vs_core::recommendation::recommend_subset(
                    &catalog,
                    &rank_request,
                    completed_at,
                    &selected.indices,
                )
            } else if let Some(indices) = subset {
                vs_core::recommendation::recommend_subset(
                    &catalog,
                    &rank_request,
                    rank_now,
                    &indices,
                )
            } else {
                if model_selection.enabled() {
                    mode = model_selection.backend();
                }
                rank_model::recommend(
                    &catalog,
                    &rank_request,
                    rank_now,
                    rank_model.as_deref(),
                    &model_selection,
                )
            };
            result.and_then(|mut result| {
                slate::finish(&slate_state, &mut result, limit)?;
                Ok((result, mode))
            })
        })
        .await
        .map_err(|_| DomainError::Invalid("rank_failed"))?
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "rank_failed"))?
    .map_err(|error| match error {
        DomainError::Invalid(_) => ApiError(StatusCode::BAD_REQUEST, "invalid_request"),
        DomainError::Expired => ApiError(StatusCode::FORBIDDEN, "projection_expired"),
        DomainError::ScopeDenied => ApiError(StatusCode::FORBIDDEN, "projection_scope_denied"),
        DomainError::Capacity => {
            ApiError(StatusCode::INSUFFICIENT_STORAGE, "profile_capacity_reached")
        }
    })?;
    let (mut result, recall_mode) = result;
    resolve_playback_paths(&state, &mut result);
    let receipt_identity = learning_snapshot.as_ref().map(|snapshot| {
        (
            snapshot.subject.clone(),
            snapshot
                .request
                .profile
                .as_ref()
                .map_or(now + 60, |profile| profile.expires_at),
        )
    });
    let decision_id = learning_journal::capture(&state, learning_snapshot, &result).await?;
    let receipt = playback_access::decision_receipt(
        &state,
        receipt_identity,
        &result,
        decision_id.as_deref(),
    )?;
    let request_id = HeaderValue::from_str(&result.request_id)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_request_id"))?;
    state
        .counters
        .recommendations
        .fetch_add(1, Ordering::Relaxed);
    let mut response = Json(result).into_response();
    if let Some(receipt) = receipt {
        response
            .headers_mut()
            .insert("x-playback-decision-receipt", receipt);
    }
    rank_model::insert_model_header(&state, &mut response);
    slate::insert_header(&state, &mut response);
    if let Some(id) = decision_id {
        response.headers_mut().insert(
            "x-learning-decision-id",
            HeaderValue::from_str(&id).unwrap(),
        );
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response.headers_mut().insert(
        "x-catalog-sha256",
        HeaderValue::from_str(&state.catalog_sha256).unwrap(),
    );
    response
        .headers_mut()
        .insert("x-recall-mode", HeaderValue::from_static(recall_mode));
    response.headers_mut().insert("x-request-id", request_id);
    insert_trace_id_header(
        &mut response,
        trace_context.and_then(|context| context.trace_id()),
    );
    Ok(response)
}

fn insert_trace_id_header(response: &mut Response, trace_id: Option<&str>) {
    if let Some(trace_id) = trace_id {
        response.headers_mut().insert(
            "x-vs-trace-id",
            HeaderValue::from_str(trace_id).expect("validated trace id"),
        );
    }
}

fn resolve_playback_paths(
    state: &AppState,
    result: &mut vs_core::recommendation::RecommendationResponse,
) {
    // 只访问返回候选的现有索引；清单后缀帮助播放器选择HLS媒体源，不增加全目录扫描。
    for item in &mut result.items {
        if let Some(hash) = state
            .candidates
            .get(&item.id)
            .and_then(|candidate| candidate.media_sha256.as_ref())
            && state
                .assets
                .get(hash)
                .is_some_and(|asset| asset.content_type == "application/vnd.apple.mpegurl")
        {
            item.media_path = Some(format!("/v1/media/{hash}/index.m3u8"));
        }
    }
}

async fn profile_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(event): Json<ProfileEvent>,
) -> Result<Json<vs_core::profile::ProfileEventResult>, ApiError> {
    let trace_context = request_trace_context(&headers);
    if !vs_core::valid_id(&event.subject) || !vs_core::valid_id(&event.event_id) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_profile_event"));
    }
    if state
        .profile_shard
        .as_ref()
        .is_some_and(|shard| !shard.owns(&event.subject))
    {
        return Err(ApiError(StatusCode::CONFLICT, "主体不属于当前画像分片"));
    }
    let candidate = state
        .candidates
        .get(&event.candidate_id)
        .cloned()
        .ok_or(ApiError(StatusCode::NOT_FOUND, "candidate_not_published"))?;
    if let Some(remote) = &state.profile_remote {
        let _permit = state
            .profile_rpc_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| overload(&state))?;
        return remote
            .event_with_trace_context(&event, trace_context.as_ref())
            .await
            .map(Json)
            .map_err(|error| ApiError(error.status, error.code));
    }
    let permit = state
        .profile_write_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| overload(&state))?;
    // 许可与提交任务同寿命；HTTP 取消不能中断已接纳事件的落盘和投影更新。
    let commit = tokio::spawn(async move {
        let _permit = permit;
        commit_profile_event(state, event, candidate).await
    });
    commit
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "profile_commit_failed"))?
        .map(Json)
}

async fn commit_profile_event(
    state: Arc<AppState>,
    event: ProfileEvent,
    candidate: vs_core::catalog::Candidate,
) -> Result<vs_core::profile::ProfileEventResult, ApiError> {
    // 串行化整个提交，但落盘期间允许读取上一份已提交投影。
    let _commit = state.profile_commit_gate.lock().await;
    let mut next = {
        let profiles = state.profiles.read().await;
        if !profiles.contains_key(&event.subject) && profiles.len() >= MAX_PROFILE_SUBJECTS {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "profile_store_full",
            ));
        }
        profiles.get(&event.subject).cloned().unwrap_or_default()
    };
    if let Some(log) = &state.profile_log
        && log.contains(&event).map_err(|error| {
            if error == "profile_event_id_conflict" {
                ApiError(StatusCode::CONFLICT, "profile_event_id_conflict")
            } else {
                ApiError(StatusCode::SERVICE_UNAVAILABLE, "profile_log_unavailable")
            }
        })?
    {
        state
            .counters
            .duplicate_profile_events
            .fetch_add(1, Ordering::Relaxed);
        return Ok(vs_core::profile::ProfileEventResult {
            accepted: false,
            duplicate: true,
            profile_version: next.version(),
        });
    }
    let previous_version = next.version();
    let result = next
        .apply(&event, &candidate)
        .map_err(|error| match error {
            DomainError::Capacity => {
                ApiError(StatusCode::INSUFFICIENT_STORAGE, "profile_capacity_reached")
            }
            DomainError::Invalid("profile_event_id_conflict") => {
                ApiError(StatusCode::CONFLICT, "profile_event_id_conflict")
            }
            _ => ApiError(StatusCode::BAD_REQUEST, "invalid_profile_event"),
        })?;
    if result.duplicate {
        state
            .counters
            .duplicate_profile_events
            .fetch_add(1, Ordering::Relaxed);
    } else {
        if let Some(log) = &state.profile_log {
            let log = log.clone();
            let event_for_log = event.clone();
            let facts = ProfileEventFacts::from(&candidate);
            let append = tokio::task::spawn_blocking(move || log.append(&event_for_log, &facts))
                .await
                .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "profile_log_failed"))?
                .map_err(|error| {
                    if error == "profile_event_id_conflict" {
                        ApiError(StatusCode::CONFLICT, "profile_event_id_conflict")
                    } else {
                        ApiError(StatusCode::SERVICE_UNAVAILABLE, "profile_log_unavailable")
                    }
                })?;
            if append == AppendResult::Duplicate {
                state
                    .counters
                    .duplicate_profile_events
                    .fetch_add(1, Ordering::Relaxed);
                return Ok(vs_core::profile::ProfileEventResult {
                    accepted: false,
                    duplicate: true,
                    profile_version: previous_version,
                });
            }
        }
        // 成功落盘后才短暂加写锁；确认前必须完成投影发布。
        state.profiles.write().await.insert(event.subject, next);
        state
            .counters
            .profile_events
            .fetch_add(1, Ordering::Relaxed);
    }
    Ok(result)
}

async fn profile_projection(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProjectionRequest>,
) -> Result<Json<ProjectionResponse>, ApiError> {
    if !state.profile_authority
        || !vs_core::valid_id(&request.subject)
        || request.domains.is_empty()
        || request.domains.len() > 16
        || request
            .domains
            .iter()
            .any(|domain| !vs_core::valid_id(domain))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_projection_request",
        ));
    }
    if state
        .profile_shard
        .as_ref()
        .is_some_and(|shard| !shard.owns(&request.subject))
    {
        return Err(ApiError(StatusCode::CONFLICT, "主体不属于当前画像分片"));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "clock_unavailable"))?
        .as_secs();
    let profile = state
        .profiles
        .read()
        .await
        .get(&request.subject)
        .map(|profile| profile.projection(&request.subject, request.domains, now + 60));
    Ok(Json(ProjectionResponse { profile }))
}

async fn profile_history(
    State(state): State<Arc<AppState>>,
    Json(request): Json<HistoryRequest>,
) -> Result<Json<HistoryResponse>, ApiError> {
    let _permit = state
        .profile_rpc_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| overload(&state))?;
    let log = state
        .profile_log
        .clone()
        .ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "画像历史不可用"))?;
    // 屏障覆盖落盘与投影发布，且随核对任务持有到结束。
    let lock = state.profile_commit_gate.clone().lock_owned().await;
    tokio::task::spawn_blocking(move || {
        let _permit = _permit;
        let _lock = lock;
        let current = log
            .checkpoint()
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "画像历史不可用"))?;
        let minimum = request.minimum.as_ref().unwrap_or(&current);
        let guard = log
            .verify_checkpoint(minimum)
            .map_err(|_| ApiError(StatusCode::CONFLICT, "画像历史前缀不匹配或校验预算已满"))?;
        Ok(Json(HistoryResponse {
            checkpoint: current,
            guard,
        }))
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "画像历史校验任务失败"))?
}

async fn ready(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, ApiError> {
    learning_journal::check_ready(&state)?;
    if let Some(recall) = &state.recall {
        if state.recall_readiness.is_none() {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "召回索引尚未完成发布校验",
            ));
        }
        recall
            .probe_ready()
            .await
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "召回索引状态不可用"))?;
    }
    if let Some(remote) = &state.profile_remote {
        let _permit = state
            .profile_rpc_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| overload(&state))?;
        remote
            .ready()
            .await
            .map_err(|error| ApiError(error.status, error.code))?;
    }
    let mut storage = "not_required_or_no_assets";
    if let (Some(store), Some(asset)) = (&state.store, state.catalog.assets.first()) {
        let actual = tokio::time::timeout(Duration::from_secs(5), store.size(&asset.object_key()))
            .await
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "storage_timeout"))?
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?;
        if actual != asset.bytes {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "asset_length_mismatch",
            ));
        }
        storage = "first_asset_readable";
    }
    let profile_history = if let Some(log) = &state.profile_log {
        let permit = state
            .profile_rpc_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| overload(&state))?;
        let log = log.clone();
        let commit = state.profile_commit_gate.clone().lock_owned().await;
        Some(
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let _commit = commit;
                log.checkpoint()
            })
            .await
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "画像历史读取任务失败"))?
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "画像历史不可用"))?,
        )
    } else {
        None
    };
    Ok(Json(serde_json::json!({
        "ready": true,
        "catalog_version": state.catalog.version,
        "catalog_sha256": state.catalog_sha256,
        "storage_probe": storage
        , "profile_authority": state.profile_authority
        , "profile_shard": state.profile_shard
        , "profile_log_enabled": state.profile_log.is_some()
        , "profile_store": if state.profile_remote.is_some() { "remote" } else { "local" }
        , "profile_read_only": state.profile_remote.as_ref().is_some_and(ProfileBackend::read_only)
        , "recall_readiness": state.recall_readiness
        , "deployment": state.deployment
        , "profile_history": profile_history
        , "ranker": if state.rank_model.is_some() { "ftrl-ranker-v1" } else { "tag-affinity-v1" }
        , "rank_model_sha256": state.rank_model.as_ref().map(|model| &model.sha256)
        , "slate_policy": state.slate_policy
        , "rank_training_data_kind": state.rank_model.as_ref().map(|model| model.data_kind)
        , "learning_capture_enabled": state.learning_journal.is_some()
        , "learning_journal": learning_journal::metrics(&state)
    })))
}

#[derive(Serialize)]
struct Metrics {
    feedback_log: Option<serde_json::Value>,
    learning_journal: Option<learning_journal::LearningJournalMetrics>,
    delivery: Option<delivery::DeliveryMetrics>,
    recommendations: u64,
    media_bytes_yielded: u64,
    overloads: u64,
    media_slots_available: usize,
    storage_http: Option<HttpMetricsSnapshot>,
    storage_read_mode: Option<vs_storage::ReadMode>,
    media_cache: Option<vs_storage::MediaCacheMetrics>,
    profile_subjects: usize,
    profile_events: u64,
    duplicate_profile_events: u64,
    profile_log_enabled: bool,
    profile_store: &'static str,
    profile_rpc_slots_available: usize,
    recall_enabled: bool,
    recall_queries: u64,
    recall_degraded: u64,
    recall_backend: &'static str,
    rank_model_sha256: Option<String>,
    model_index: Option<vs_core::grouped_recall::GroupedIndexLayout>,
    grouped_queries: u64,
    grouped_groups_scored: u64,
    grouped_candidates_examined: u64,
}

async fn metrics(State(state): State<Arc<AppState>>) -> Json<Metrics> {
    Json(Metrics {
        feedback_log: state.feedback_log.as_ref().map(|log| log.metrics()),
        learning_journal: learning_journal::metrics(&state),
        delivery: state.delivery.as_ref().map(|delivery| delivery.snapshot()),
        recommendations: state.counters.recommendations.load(Ordering::Relaxed),
        media_bytes_yielded: state.counters.media_bytes_yielded.load(Ordering::Relaxed),
        overloads: state.counters.overloads.load(Ordering::Relaxed),
        media_slots_available: state.media_slots.available_permits(),
        storage_http: state.store.as_ref().and_then(MediaStore::http_metrics),
        storage_read_mode: state.store.as_ref().map(MediaStore::read_mode),
        media_cache: state
            .store
            .as_ref()
            .and_then(MediaStore::media_cache_metrics),
        profile_subjects: state.profile_count(),
        profile_events: state.counters.profile_events.load(Ordering::Relaxed),
        duplicate_profile_events: state
            .counters
            .duplicate_profile_events
            .load(Ordering::Relaxed),
        profile_log_enabled: state.profile_log.is_some(),
        profile_store: if state.profile_remote.is_some() {
            "remote"
        } else {
            "local"
        },
        profile_rpc_slots_available: state.profile_rpc_slots.available_permits(),
        recall_enabled: state.recall.is_some()
            || state.grouped_recall.is_some()
            || state.model_selection.enabled(),
        recall_queries: state.counters.recall_queries.load(Ordering::Relaxed),
        recall_degraded: state.counters.recall_degraded.load(Ordering::Relaxed),
        recall_backend: if state.model_selection.enabled() {
            state.model_selection.backend()
        } else if state.grouped_recall.is_some() {
            "grouped"
        } else if state.recall.is_some() {
            "qdrant"
        } else {
            "catalog"
        },
        rank_model_sha256: state.rank_model.as_ref().map(|model| model.sha256.clone()),
        model_index: state.model_selection.index_layout(),
        grouped_queries: state.counters.grouped_queries.load(Ordering::Relaxed),
        grouped_groups_scored: state.counters.grouped_groups_scored.load(Ordering::Relaxed),
        grouped_candidates_examined: state
            .counters
            .grouped_candidates_examined
            .load(Ordering::Relaxed),
    })
}

async fn named_media(
    State(state): State<Arc<AppState>>,
    Path((hash, filename)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let asset = state
        .assets
        .get(&hash)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "asset_not_published"))?;
    let valid = match filename.as_str() {
        "index.m3u8" => asset.content_type == "application/vnd.apple.mpegurl",
        "media.mp4" => matches!(asset.content_type.as_str(), "video/mp4" | "audio/mp4"),
        _ => false,
    };
    if !valid {
        return Err(ApiError(StatusCode::NOT_FOUND, "媒体名称与资产类型不匹配"));
    }
    media(State(state), Path(hash), method, headers).await
}

async fn media(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let asset = state
        .assets
        .get(&hash)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "asset_not_published"))?;
    let store = state.store.as_ref().ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "storage_not_configured",
    ))?;
    let permit = state
        .media_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| overload(&state))?;
    let etag = format!("\"{}\"", asset.sha256);
    let mut response = Response::new(Body::empty());
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&asset.content_type).unwrap(),
    );
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',').any(|tag| {
                let tag = tag.trim();
                tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
            })
        });
    if not_modified {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        return Ok(response);
    }
    let actual = tokio::time::timeout(Duration::from_secs(5), store.size(&asset.object_key()))
        .await
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "storage_timeout"))?
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?;
    if actual != asset.bytes {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "asset_length_mismatch",
        ));
    }
    let mut selected = 0..asset.bytes;
    // HEAD 忽略 Range；If-Range 不匹配时返回完整表示。
    let use_range = method != Method::HEAD
        && headers
            .get(header::IF_RANGE)
            .is_none_or(|value| value.as_bytes() == etag.as_bytes());
    if use_range && let Some(value) = headers.get(header::RANGE) {
        let parsed = value
            .to_str()
            .ok()
            .and_then(|v| HttpRange::parse(v, asset.bytes).ok());
        if let Some(ranges) = parsed.filter(|ranges| ranges.len() == 1) {
            let range = &ranges[0];
            selected = range.start..range.start + range.length;
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!(
                    "bytes {}-{}/{}",
                    selected.start,
                    selected.end - 1,
                    asset.bytes
                ))
                .unwrap(),
            );
        } else {
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{}", asset.bytes)).unwrap(),
            );
            return Ok(response);
        }
    }
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&(selected.end - selected.start).to_string()).unwrap(),
    );
    if method == Method::HEAD {
        return Ok(response);
    }
    let source = tokio::time::timeout(
        Duration::from_secs(5),
        store.published_stream(&asset.sha256, asset.bytes, selected),
    )
    .await
    .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "storage_timeout"))?
    .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?;
    // 许可跟随响应体而非处理函数；慢客户端和取消请求都不能绕过并发上限。
    let counters = state.counters.clone();
    let body = stream::unfold(
        (source, permit, counters),
        |(mut source, permit, counters)| async move {
            let next = match tokio::time::timeout(Duration::from_secs(5), source.next()).await {
                Ok(Some(Ok(bytes))) => {
                    counters
                        .media_bytes_yielded
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    Ok(bytes)
                }
                Ok(None) => return None,
                _ => Err(io::Error::other("media_read_failed")),
            };
            Some((next, (source, permit, counters)))
        },
    );
    *response.body_mut() = Body::from_stream(body);
    Ok(response)
}

#[cfg(test)]
mod trace_context_tests {
    use super::*;

    #[test]
    fn forwards_one_traceparent_and_only_attributes_valid_v00() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "traceparent",
            HeaderValue::from_static("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        );
        headers.insert("tracestate", HeaderValue::from_static("vendor=value"));
        let context = request_trace_context(&headers).unwrap();
        assert_eq!(
            context.traceparent(),
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        assert_eq!(context.tracestate(), Some("vendor=value"));

        headers.insert("traceparent", HeaderValue::from_static("00-malformed"));
        let malformed = request_trace_context(&headers).unwrap();
        assert_eq!(malformed.traceparent(), "00-malformed");
        assert_eq!(malformed.trace_id(), None);

        headers.insert(
            "traceparent",
            HeaderValue::from_static("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        );
        headers.append(
            "traceparent",
            HeaderValue::from_static("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        );
        assert!(request_trace_context(&headers).is_none());

        let mut bridge = HeaderMap::new();
        bridge.insert(
            "x-vs-trace-id",
            HeaderValue::from_static("4bf92f3577b34da6a3ce929d0e0e4736"),
        );
        assert_eq!(
            trace_context::trace_id_from_headers(&bridge).as_deref(),
            Some("4bf92f3577b34da6a3ce929d0e0e4736")
        );
        for value in [
            "4BF92F3577B34DA6A3CE929D0E0E4736",
            "00000000000000000000000000000000",
            "short",
        ] {
            bridge.insert("x-vs-trace-id", HeaderValue::from_static(value));
            assert!(trace_context::trace_id_from_headers(&bridge).is_none());
        }
    }
}
