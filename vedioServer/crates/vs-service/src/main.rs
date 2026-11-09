use std::{
    env,
    error::Error,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::{net::TcpListener, signal};
use vs_service::deployment::{DeploymentRecall, S3DeploymentRepository};
use vs_service::qdrant_recall::QdrantConfig;
use vs_service::{
    AppState, ProfileConsensusConfig, ProfileRemoteConfig, ProfileShard, ProfileShardsConfig, Role,
    router,
};
use vs_storage::{MediaCacheConfig, MediaCachePolicy, MediaStore, ReadMode, S3Config};

mod shutdown;

fn required(name: &str) -> Result<String, io::Error> {
    env::var(name).map_err(|_| io::Error::other(format!("缺少环境配置：{name}")))
}

fn count(name: &str, fallback: usize) -> Result<usize, Box<dyn Error>> {
    Ok(match env::var(name) {
        Ok(value) => value.parse()?,
        Err(_) => fallback,
    })
}

fn s3_config() -> Result<S3Config, io::Error> {
    Ok(S3Config {
        endpoint: required("VS_S3_ENDPOINT")?,
        region: required("VS_S3_REGION")?,
        bucket: required("VS_S3_BUCKET")?,
        access_key_id: required("VS_S3_ACCESS_KEY_ID")?,
        secret_access_key: required("VS_S3_SECRET_ACCESS_KEY")?,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vs_service=info".into()),
        )
        .init();
    let role = match env::var("VS_ROLE").as_deref().unwrap_or("all") {
        "api" => Role::Api,
        "media" => Role::Media,
        "all" => Role::All,
        "profile" => Role::Profile,
        "feedback" => Role::Feedback,
        _ => return Err(io::Error::other("角色必须为api、media、all、profile或feedback").into()),
    };
    let publication_root = env::var_os("VS_PUBLICATION_ROOT").map(PathBuf::from);
    let channel = env::var("VS_DEPLOYMENT_CHANNEL")
        .map(Some)
        .or_else(|error| match error {
            env::VarError::NotPresent => Ok(None),
            _ => Err(io::Error::other("部署通道编码无效")),
        })?;
    let deployment = if let Some(channel) = channel {
        if role != Role::Api
            || [
                "VS_CATALOG",
                "VS_CATALOG_RELEASE",
                "VS_PUBLICATION_ROOT",
                "VS_PUBLICATION_BACKEND",
                "VS_PROFILE_EVENT_LOG",
                "VS_PROFILE_AUTHORITY_URL",
                "VS_PROFILE_SHARD",
                "VS_PROFILE_SHARDS_CONFIG",
                "VS_PROFILE_CONSENSUS_CONFIG",
                "VS_QDRANT_URL",
                "VS_RECALL_BACKEND",
                "VS_QDRANT_SCORING",
                "VS_RANK_MODEL",
                "VS_RANK_MODEL_SHA256",
                "VS_SLATE_POLICY",
            ]
            .iter()
            .any(|name| env::var_os(name).is_some())
        {
            return Err(io::Error::other(
                "部署选择仅用于API角色，目录/画像/召回配置由记录提供，不能重复设置",
            )
            .into());
        }
        let repository = S3DeploymentRepository::new(s3_config()?, 5000)?;
        let snapshot = repository
            .load(&channel)
            .await?
            .ok_or_else(|| io::Error::other("部署通道尚未激活"))?;
        if required("VS_DEPLOYMENT_SHA256")? != snapshot.sha256() {
            return Err(io::Error::other("部署选择与指定指纹不符").into());
        }
        Some((repository, snapshot))
    } else {
        if env::var_os("VS_DEPLOYMENT_SHA256").is_some() {
            return Err(io::Error::other("部署通道与指纹必须同时设置").into());
        }
        None
    };
    let release = env::var("VS_CATALOG_RELEASE")
        .map(Some)
        .or_else(|error| match error {
            env::VarError::NotPresent => Ok(None),
            _ => Err(io::Error::other("发布版本配置编码无效")),
        })?;
    let publication_backend = env::var("VS_PUBLICATION_BACKEND")
        .map(Some)
        .or_else(|error| match error {
            env::VarError::NotPresent => Ok(None),
            _ => Err(io::Error::other("发布后端配置编码无效")),
        })?;
    let catalog = if role == Role::Feedback {
        if publication_root.is_some()
            || release.is_some()
            || publication_backend.is_some()
            || env::var_os("VS_CATALOG").is_some()
        {
            return Err(io::Error::other("反馈角色不绑定推荐目录或媒体发布").into());
        }
        br#"{"version":"feedback-ingress-v1","items":[],"assets":[]}"#.to_vec()
    } else if let Some((repository, snapshot)) = &deployment {
        repository.load_catalog(snapshot).await?
    } else {
        match (
            publication_root.as_deref(),
            release.as_deref(),
            publication_backend.as_deref(),
        ) {
            (Some(root), Some(version), None | Some("fs")) => {
                if env::var_os("VS_CATALOG").is_some() {
                    return Err(io::Error::other("固定发布版本与VS_CATALOG不能同时配置").into());
                }
                if matches!(role, Role::Media | Role::All) {
                    if env::var("VS_STORAGE").as_deref().unwrap_or("fs") != "fs" {
                        return Err(
                            io::Error::other("当前发布版本的媒体入口仅支持本地文件存储").into()
                        );
                    }
                    let media_root = PathBuf::from(required("VS_MEDIA_ROOT")?).canonicalize()?;
                    if media_root != root.canonicalize()? {
                        return Err(io::Error::other("媒体根目录必须与发布根目录一致").into());
                    }
                }
                vs_service::publication::load_catalog_release(root, version)?
            }
            (None, Some(version), Some("s3")) => {
                if env::var_os("VS_CATALOG").is_some() {
                    return Err(io::Error::other("固定发布版本与VS_CATALOG不能同时配置").into());
                }
                if matches!(role, Role::Media | Role::All)
                    && env::var("VS_STORAGE").as_deref() != Ok("s3")
                {
                    return Err(io::Error::other("S3发布版本的媒体入口必须使用同一S3配置").into());
                }
                vs_service::s3_catalog::S3CatalogRepository::new(s3_config()?, Default::default())?
                    .load(version)
                    .await?
            }
            (None, None, None) => {
                let path =
                    env::var("VS_CATALOG").unwrap_or_else(|_| "examples/catalog.json".into());
                let mut bytes = Vec::new();
                std::fs::File::open(path)?
                    .take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                bytes
            }
            _ => {
                return Err(io::Error::other(
                "VS_PUBLICATION_ROOT与VS_CATALOG_RELEASE必须同时有效配置；S3发布需显式设置VS_PUBLICATION_BACKEND=s3",
            )
            .into());
            }
        }
    };
    let store = if matches!(role, Role::Api | Role::Profile | Role::Feedback) {
        None
    } else {
        let read_mode = match env::var("VS_MEDIA_READ_MODE") {
            Ok(value) => value.parse::<ReadMode>().map_err(io::Error::other)?,
            Err(env::VarError::NotPresent) => ReadMode::default(),
            Err(_) => return Err(io::Error::other("invalid_media_read_mode_encoding").into()),
        };
        let store = match env::var("VS_STORAGE").as_deref().unwrap_or("fs") {
            "fs" => {
                let root = required("VS_MEDIA_ROOT")?;
                let root = Path::new(&root).canonicalize()?;
                MediaStore::filesystem(
                    root.to_str()
                        .ok_or_else(|| io::Error::other("invalid_root_encoding"))?,
                )
                .map_err(|_| io::Error::other("filesystem_storage_configuration_failed"))?
            }
            "s3" => MediaStore::s3(s3_config()?)
                .map_err(|_| io::Error::other("s3_storage_configuration_failed"))?,
            _ => return Err(io::Error::other("invalid_storage:expected_fs_s3").into()),
        }
        .with_read_mode(read_mode);
        let capacity = count("VS_MEDIA_CACHE_BYTES", 0)?;
        let cache_policy = match env::var("VS_MEDIA_CACHE_POLICY") {
            Ok(value) => value,
            Err(env::VarError::NotPresent) => "exact".into(),
            Err(_) => return Err(io::Error::other("媒体缓存策略配置编码无效").into()),
        }
        .parse::<MediaCachePolicy>()
        .map_err(io::Error::other)?;
        if capacity == 0 && cache_policy != MediaCachePolicy::Exact {
            return Err(io::Error::other("启用块缓存策略必须配置非零缓存容量").into());
        }
        Some(if capacity == 0 {
            store
        } else {
            store.with_media_cache_policy(
                MediaCacheConfig {
                    capacity_bytes: capacity as u64,
                    max_entry_bytes: count("VS_MEDIA_CACHE_ENTRY_BYTES", 64 * 1024)?,
                    max_fill_concurrency: count("VS_MEDIA_CACHE_FILLS", 4)?,
                },
                cache_policy,
            )?
        })
    };
    let profile_log_path = env::var_os("VS_PROFILE_EVENT_LOG").map(PathBuf::from);
    let profile_shard = match env::var("VS_PROFILE_SHARD") {
        Ok(raw) if role == Role::Profile && raw.len() <= 512 => {
            let shard: ProfileShard =
                serde_json::from_str(&raw).map_err(|_| io::Error::other("画像分片JSON无效"))?;
            shard.validate().map_err(io::Error::other)?;
            Some(shard)
        }
        Err(env::VarError::NotPresent) => None,
        _ => return Err(io::Error::other("分片身份仅允许画像角色，且须为有界JSON").into()),
    };
    let shards_config = match env::var_os("VS_PROFILE_SHARDS_CONFIG") {
        Some(path) if matches!(role, Role::Api | Role::All) && profile_log_path.is_none() => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err(io::Error::other("画像分片配置须为绝对路径").into());
            }
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(16_385)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 16_384 {
                return Err(io::Error::other("画像分片配置超出16KiB").into());
            }
            Some(
                serde_json::from_slice::<ProfileShardsConfig>(&bytes)
                    .map_err(|_| io::Error::other("画像分片配置JSON无效"))?,
            )
        }
        None => None,
        _ => return Err(io::Error::other("分片入口仅用于不含本地画像日志的API角色").into()),
    };
    let remote_profile_url = if let Some((_, snapshot)) = &deployment {
        Some(snapshot.record().target.profile_authority.clone())
    } else {
        match env::var("VS_PROFILE_AUTHORITY_URL") {
            Ok(endpoint) => Some(endpoint),
            Err(env::VarError::NotPresent) => None,
            Err(_) => return Err(io::Error::other("invalid_profile_endpoint_encoding").into()),
        }
    };
    let consensus_config = match env::var_os("VS_PROFILE_CONSENSUS_CONFIG") {
        None => None,
        Some(path)
            if matches!(role, Role::Api | Role::All)
                && profile_log_path.is_none()
                && remote_profile_url.is_none()
                && shards_config.is_none() =>
        {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err(io::Error::other("共识画像配置须为绝对路径").into());
            }
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(8193)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 8192 {
                return Err(io::Error::other("共识画像配置超过8KiB").into());
            }
            Some(
                serde_json::from_slice::<ProfileConsensusConfig>(&bytes)
                    .map_err(|_| io::Error::other("共识画像配置JSON无效"))?,
            )
        }
        _ => return Err(io::Error::other("共识画像只读实验仅用于无其他画像后端的API角色").into()),
    };
    if role == Role::Profile && (profile_log_path.is_none() || remote_profile_url.is_some()) {
        return Err(io::Error::other("profile_role_requires_local_event_log_only").into());
    }
    if matches!(role, Role::Media | Role::Feedback)
        && (profile_log_path.is_some() || remote_profile_url.is_some())
    {
        return Err(io::Error::other("media_role_cannot_own_profiles").into());
    }
    if remote_profile_url.is_some() && profile_log_path.is_some() {
        return Err(io::Error::other("local_and_remote_profiles_are_exclusive").into());
    }
    if shards_config.is_some() && remote_profile_url.is_some() {
        return Err(io::Error::other("分片入口不能与单画像入口混用").into());
    }
    let sharded_authority = profile_shard.is_some();
    let mut state = if let Some(shard) = profile_shard {
        AppState::new_with_profile_shard(
            &catalog,
            &required("VS_SERVICE_TOKEN")?,
            profile_log_path
                .as_deref()
                .ok_or_else(|| io::Error::other("分片需要本地日志"))?,
            shard,
        )
    } else {
        AppState::new_with_profile_log(
            &catalog,
            store,
            &required("VS_SERVICE_TOKEN")?,
            count("VS_RANK_CONCURRENCY", 4)?,
            count("VS_MEDIA_CONCURRENCY", 64)?,
            profile_log_path.as_deref(),
        )
    }
    .map_err(io::Error::other)?;
    if role == Role::Profile && !sharded_authority {
        state = state.into_profile_authority().map_err(io::Error::other)?;
    }
    if let Some(config) = shards_config {
        state = state
            .with_profile_shards(config)
            .map_err(io::Error::other)?;
        state
            .verify_profile_readiness()
            .await
            .map_err(io::Error::other)?;
    }
    if let Some(config) = consensus_config {
        state = state
            .with_profile_consensus(config)
            .map_err(io::Error::other)?;
        state
            .verify_profile_readiness()
            .await
            .map_err(io::Error::other)?;
    }
    if let Some(endpoint) = remote_profile_url {
        state = state
            .with_profile_remote(ProfileRemoteConfig {
                endpoint,
                token: required("VS_PROFILE_AUTHORITY_TOKEN")?,
            })
            .map_err(io::Error::other)?;
        if let Some((_, snapshot)) = &deployment
            && let Some(checkpoint) = &snapshot.record().profile_checkpoint
        {
            state = state
                .with_profile_history(checkpoint.clone())
                .map_err(io::Error::other)?;
        }
    }
    let qdrant_url = if let Some((_, snapshot)) = &deployment {
        match &snapshot.record().target.recall {
            DeploymentRecall::Qdrant { endpoint, .. } => Some(endpoint.clone()),
            _ => None,
        }
    } else {
        match env::var("VS_QDRANT_URL") {
            Ok(endpoint) => Some(endpoint),
            Err(env::VarError::NotPresent) => None,
            Err(_) => return Err(io::Error::other("invalid_recall_endpoint_encoding").into()),
        }
    };
    let recall_backend = if let Some((_, snapshot)) = &deployment {
        match snapshot.record().target.recall {
            DeploymentRecall::Catalog => "catalog",
            DeploymentRecall::ModelTopK => "model-topk",
            DeploymentRecall::ModelPruned => "model-pruned",
            DeploymentRecall::ModelBlockMax => "model-blockmax",
            DeploymentRecall::Grouped => "grouped",
            DeploymentRecall::Qdrant { .. } => "qdrant",
        }
        .to_string()
    } else {
        match env::var("VS_RECALL_BACKEND") {
            Ok(value) => value,
            Err(env::VarError::NotPresent) => if qdrant_url.is_some() {
                "qdrant"
            } else {
                "catalog"
            }
            .into(),
            Err(_) => return Err(io::Error::other("召回后端配置编码无效").into()),
        }
    };
    if recall_backend != "qdrant" && qdrant_url.is_some() {
        return Err(io::Error::other("仅 qdrant 召回后端允许设置 VS_QDRANT_URL").into());
    }
    match recall_backend.as_str() {
        "catalog" => {}
        "model-topk" | "model-pruned" | "model-blockmax" => {
            if !matches!(role, Role::Api | Role::All) {
                return Err(io::Error::other("精确模型选择仅用于 api 或 all 角色").into());
            }
            // 模型先完成指纹校验，随后才能启用依赖模型的选择器。
        }
        "grouped" => {
            if !matches!(role, Role::Api | Role::All) {
                return Err(io::Error::other("分组召回仅用于 api 或 all 角色").into());
            }
            state = state.with_grouped_recall().map_err(io::Error::other)?;
        }
        "qdrant" => {
            if !matches!(role, Role::Api | Role::All) {
                return Err(io::Error::other("recall_requires_api_role").into());
            }
            state = state
                .with_qdrant_recall(QdrantConfig {
                    endpoint: qdrant_url
                        .ok_or_else(|| io::Error::other("qdrant 后端缺少 VS_QDRANT_URL"))?,
                    api_key: env::var("VS_QDRANT_API_KEY").ok(),
                    scoring: if let Some((_, snapshot)) = &deployment {
                        match &snapshot.record().target.recall {
                            DeploymentRecall::Qdrant { scoring, .. } => {
                                vs_core::recall::RecallScoring::parse(scoring)
                                    .map_err(|_| io::Error::other("部署召回评分无效"))?
                            }
                            _ => unreachable!(),
                        }
                    } else {
                        match env::var("VS_QDRANT_SCORING") {
                            Ok(value) => {
                                vs_core::recall::RecallScoring::parse(&value).map_err(|_| {
                                    io::Error::other("召回评分必须为 positive 或 signed")
                                })?
                            }
                            Err(env::VarError::NotPresent) => Default::default(),
                            Err(_) => return Err(io::Error::other("召回评分配置编码无效").into()),
                        }
                    },
                })
                .map_err(io::Error::other)?;
        }
        _ => {
            return Err(io::Error::other(
                "召回后端必须为 catalog、model-topk、model-pruned、model-blockmax、grouped 或 qdrant",
            )
            .into());
        }
    }
    match (
        env::var_os("VS_RANK_MODEL"),
        env::var("VS_RANK_MODEL_SHA256"),
    ) {
        (None, Err(env::VarError::NotPresent)) => {}
        (Some(path), Ok(expected))
            if matches!(role, Role::Api | Role::All) && deployment.is_none() =>
        {
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(vs_service::rank_model::MAX_RANK_MODEL_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            state = state
                .with_rank_model(&bytes, &expected)
                .map_err(io::Error::other)?;
        }
        _ => {
            return Err(io::Error::other(
                "排序模型路径与指纹必须同时配置，且仅用于独立的api或all角色",
            )
            .into());
        }
    }
    state
        .verify_recall_publication(&catalog)
        .await
        .map_err(io::Error::other)?;
    if let Some((repository, snapshot)) = &deployment
        && let Some(bytes) = repository.load_rank_model(snapshot, &catalog).await?
    {
        state = state
            .with_rank_model(
                &bytes,
                snapshot
                    .record()
                    .target
                    .rank_model_sha256
                    .as_deref()
                    .ok_or_else(|| io::Error::other("部署模型指纹缺失"))?,
            )
            .map_err(io::Error::other)?;
    }
    if recall_backend == "model-topk" {
        state = state.with_model_top_k().map_err(io::Error::other)?;
    } else if recall_backend == "model-pruned" {
        state = state.with_model_pruned().map_err(io::Error::other)?;
    } else if recall_backend == "model-blockmax" {
        state = state.with_model_blockmax().map_err(io::Error::other)?;
    }
    if let Some((repository, snapshot)) = &deployment {
        state
            .verify_profile_readiness()
            .await
            .map_err(io::Error::other)?;
        repository.ensure_current(snapshot).await?;
        state = state
            .with_deployment_snapshot(snapshot)
            .map_err(io::Error::other)?;
    }
    match env::var("VS_DELIVERY_OBSERVATION").as_deref() {
        Ok("1") => {
            if !matches!(role, Role::Media | Role::All) {
                return Err(io::Error::other("交付观测仅用于media或all角色").into());
            }
            state = state.with_delivery_observation();
        }
        Ok("0") | Err(env::VarError::NotPresent) => {}
        _ => return Err(io::Error::other("VS_DELIVERY_OBSERVATION必须为0或1").into()),
    }
    if let Some(raw) = env::var_os("VS_SLATE_POLICY") {
        if !matches!(role, Role::Api | Role::All) {
            return Err(io::Error::other("列表重排策略仅用于api或all角色").into());
        }
        let raw = raw
            .to_str()
            .filter(|raw| raw.len() <= 512)
            .ok_or_else(|| io::Error::other("列表策略编码或长度无效"))?;
        let policy = serde_json::from_str(raw).map_err(|_| io::Error::other("列表策略JSON无效"))?;
        state = state.with_slate_policy(policy).map_err(io::Error::other)?;
    }
    if let Some(raw) = env::var_os("VS_PLAYBACK_POLICY") {
        if !matches!(role, Role::Api | Role::All) {
            return Err(io::Error::other("播放策略配置仅用于api或all角色").into());
        }
        let raw = raw
            .to_str()
            .filter(|raw| raw.len() <= 1024)
            .ok_or_else(|| io::Error::other("播放策略配置编码或长度无效"))?;
        let policy = serde_json::from_str(raw).map_err(|_| io::Error::other("播放策略JSON无效"))?;
        state = state
            .with_playback_policy(policy)
            .map_err(io::Error::other)?;
    }
    match (
        env::var("VS_PLAYBACK_SIGNING_KEY"),
        env::var("VS_PLAYBACK_AUDIENCE"),
    ) {
        (Err(env::VarError::NotPresent), Err(env::VarError::NotPresent)) => {}
        (Ok(encoded), Ok(audience)) if matches!(role, Role::Api | Role::Media | Role::All) => {
            use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
            let key = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| io::Error::other("播放签名密钥须为Base64URL无填充编码"))?;
            state = state
                .with_playback_access(&key, &audience)
                .map_err(io::Error::other)?;
        }
        _ => {
            return Err(io::Error::other(
                "播放签名密钥与受众须成对配置，且仅用于api、media或all角色",
            )
            .into());
        }
    }
    match env::var("VS_PLAYBACK_LINKAGE_V2").as_deref() {
        Ok("1") if matches!(role, Role::Api | Role::All) => {
            state = state.with_playback_linkage_v2().map_err(io::Error::other)?;
        }
        Ok("0") | Err(env::VarError::NotPresent) => {}
        _ => {
            return Err(io::Error::other(
                "VS_PLAYBACK_LINKAGE_V2仅接受0或1，且1仅用于api或all角色并要求播放签名",
            )
            .into());
        }
    }
    match (
        env::var_os("VS_LEARNING_JOURNAL"),
        env::var("VS_LEARNING_SOURCE_ID"),
    ) {
        (None, Err(env::VarError::NotPresent))
            if env::var_os("VS_LEARNING_COMMIT_MODE").is_none() => {}
        (Some(path), Ok(source)) if matches!(role, Role::Api | Role::All) => {
            let mode = match env::var("VS_LEARNING_COMMIT_MODE") {
                Ok(value) => {
                    vs_service::LearningCommitMode::parse(&value).map_err(io::Error::other)?
                }
                Err(env::VarError::NotPresent) => Default::default(),
                Err(_) => return Err(io::Error::other("学习日志提交配置编码无效").into()),
            };
            state = state
                .with_learning_journal_mode(Path::new(&path), &source, mode)
                .map_err(io::Error::other)?;
        }
        _ => {
            return Err(io::Error::other(
                "学习日志路径与副本标识必须同时配置，且仅用于api或all角色",
            )
            .into());
        }
    }
    match (
        role,
        env::var_os("VS_FEEDBACK_CONFIG"),
        env::var("VS_FEEDBACK_IGGY_TOKEN"),
    ) {
        (Role::Feedback, Some(path), Ok(token)) => {
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(64 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 64 * 1024 {
                return Err(io::Error::other("反馈配置超过64KiB").into());
            }
            let config =
                serde_json::from_slice(&bytes).map_err(|_| io::Error::other("反馈配置JSON无效"))?;
            state = state
                .with_feedback_log(config, token)
                .map_err(io::Error::other)?;
            state.verify_feedback_readiness().await?;
        }
        (_, None, Err(env::VarError::NotPresent)) if role != Role::Feedback => {}
        _ => {
            return Err(io::Error::other(
                "feedback角色必须同时指定反馈配置和Iggy凭证，其他角色不得配置",
            )
            .into());
        }
    }
    if let Some(path) = env::var_os("VS_CONSUMPTION_ACCESS_CONFIG") {
        if role != Role::Feedback {
            return Err(io::Error::other("消费认证配置仅用于feedback角色").into());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 16 * 1024 {
            return Err(io::Error::other("消费认证配置超过16KiB").into());
        }
        let config =
            serde_json::from_slice(&bytes).map_err(|_| io::Error::other("消费认证配置JSON无效"))?;
        state = state
            .with_consumption_access(config)
            .map_err(io::Error::other)?;
    }
    if let Some(path) = env::var_os("VS_FEED_ACCESS_CONFIG") {
        if !matches!(role, Role::Api | Role::All) {
            return Err(io::Error::other("推荐访问凭据配置仅用于api或all角色").into());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 16 * 1024 {
            return Err(io::Error::other("推荐访问凭据配置超过16KiB").into());
        }
        let config = serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::other("推荐访问凭据配置JSON无效"))?;
        state = state.with_feed_access(config).map_err(io::Error::other)?;
    }
    let state = Arc::new(state);
    let bind = env::var("VS_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = TcpListener::bind(&bind).await?;
    tracing::info!(address = %listener.local_addr()?, "service_started");

    // 改编 Axum 官方 graceful-shutdown 示例；增加固定排空期限避免慢流阻塞退出。
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, router(state.clone(), role))
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .into_future();
    tokio::pin!(server);
    let result = tokio::select! {
        outcome = &mut server => {
            shutdown::finish(
                tokio::time::Instant::now() + shutdown::DRAIN_BUDGET,
                async { outcome },
                state.drain_profile_writes(),
                state.drain_learning_writes(),
                state.drain_feedback_writes(),
            ).await
        }
        () = shutdown_signal() => {
            let _ = shutdown_tx.send(());
            shutdown::finish(
                tokio::time::Instant::now() + shutdown::DRAIN_BUDGET,
                &mut server,
                state.drain_profile_writes(),
                state.drain_learning_writes(),
                state.drain_feedback_writes(),
            ).await
        }
    };
    if let Err(reason) = &result {
        tracing::error!(error = %reason, "service_shutdown_incomplete");
    } else {
        tracing::info!("service_shutdown_completed");
    }
    result.map_err(Into::into)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
