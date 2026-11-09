use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    io::{self, Read},
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use openraft::{
    BasicNode, Config,
    raft::{AppendEntriesRequest, InstallSnapshotRequest, VoteRequest},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tower_http::timeout::TimeoutLayer;
use vs_coordination::{
    NodeId, Raft, RoomCommand, SNAPSHOT_LIMIT, TypeConfig,
    media_registry::{AuthorityCommand, MediaNodeCommand, MediaNodeReply, MediaRegistryPolicy},
    media_release::{MediaRelease, MediaReleaseConfig},
    network::Network,
    profile_access::{ProfileAccess, ProfileAccessConfig},
    profile_authority::{ProfileCommand, ProfilePolicy},
    storage::{self, StateStore},
    tls::{ClientRole, POLICY_MODE, TlsSettings, TlsTransport, allowed_endpoint},
};
use vs_core::room_assignment::{AssignmentRecord, AssignmentView, MediaTarget};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    cluster_id: String,
    node_id: NodeId,
    bind: SocketAddr,
    data_dir: PathBuf,
    peers: BTreeMap<NodeId, SocketAddr>,
    voters: BTreeSet<NodeId>,
    service_token: String,
    #[serde(default)]
    media_control: Option<MediaReleaseConfig>,
    #[serde(default)]
    tls: Option<TlsSettings>,
    #[serde(default)]
    profile_catalog: Option<PathBuf>,
    #[serde(default)]
    profile_shard_count: Option<u16>,
    #[serde(default)]
    profile_read_token: Option<String>,
    #[serde(default)]
    profile_access: Option<ProfileAccessConfig>,
}

struct App {
    raft: Raft,
    store: StateStore,
    settings: Settings,
    slots: tokio::sync::Semaphore,
    writes: Arc<tokio::sync::Semaphore>,
    media_release: Option<MediaRelease>,
    profile_access: Option<Arc<ProfileAccess>>,
    policy: String,
    authority: String,
}

async fn boundary(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    if app.settings.tls.is_some() {
        let permitted = match request.extensions().get::<ClientRole>() {
            Some(ClientRole::Node(id)) => {
                request.uri().path().starts_with("/raft/") && app.settings.peers.contains_key(id)
            }
            Some(ClientRole::Operator) => !request.uri().path().starts_with("/raft/"),
            Some(ClientRole::MediaReader(_)) => {
                request.method() == Method::GET
                    && request.uri().path().starts_with("/v1/room-assignments/")
            }
            Some(ClientRole::ProfileReader(_)) => {
                app.settings.profile_catalog.is_some()
                    && matches!(
                        (request.method(), request.uri().path()),
                        (&Method::POST, "/internal/lab/profile/projection")
                            | (&Method::GET, "/internal/lab/profile/ready")
                    )
            }
            _ => false,
        };
        if !permitted {
            return (StatusCode::FORBIDDEN, "协调证书身份或角色不允许此操作").into_response();
        }
    }
    if request.uri().path().starts_with("/raft/")
        && request
            .headers()
            .get("x-vs-room-policy")
            .and_then(|value| value.to_str().ok())
            != Some(app.policy.as_str())
    {
        return (StatusCode::CONFLICT, "协调节点的业务或传输策略不一致").into_response();
    }
    let mut auth = request.headers().get_all(header::AUTHORIZATION).iter();
    let token = auth
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let expected_token = if matches!(
        request.extensions().get::<ClientRole>(),
        Some(ClientRole::ProfileReader(_))
    ) {
        app.settings.profile_read_token.as_deref()
    } else {
        Some(app.settings.service_token.as_str())
    };
    if request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(app.authority.as_str())
        || request.headers().contains_key(header::ORIGIN)
        || auth.next().is_some()
        || !token.zip(expected_token).is_some_and(|(token, expected)| {
            bool::from(token.as_bytes().ct_eq(expected.as_bytes()))
        })
    {
        return (StatusCode::UNAUTHORIZED, "协调接口仅允许固定地址的可信服务").into_response();
    }
    let Ok(_permit) = app.slots.try_acquire() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "协调请求预算已满").into_response();
    };
    let mut response = next.run(request).await;
    if matches!(
        response.status(),
        StatusCode::BAD_REQUEST
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::PAYLOAD_TOO_LARGE
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
    ) {
        response = (response.status(), "协调请求格式、正文类型或大小不符合契约").into_response();
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

async fn append(
    State(app): State<Arc<App>>,
    role: Option<Extension<ClientRole>>,
    Json(request): Json<AppendEntriesRequest<TypeConfig>>,
) -> Response {
    if !sender_matches(&app, role, request.vote.leader_id.node_id) {
        return (StatusCode::FORBIDDEN, "共识发送者与证书身份不匹配").into_response();
    }
    if request.entries.len() > 16 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "单批共识日志超出预算").into_response();
    }
    Json(app.raft.append_entries(request).await).into_response()
}
async fn vote(
    State(app): State<Arc<App>>,
    role: Option<Extension<ClientRole>>,
    Json(request): Json<VoteRequest<NodeId>>,
) -> Response {
    if !sender_matches(&app, role, request.vote.leader_id.node_id) {
        return (StatusCode::FORBIDDEN, "共识发送者与证书身份不匹配").into_response();
    }
    Json(app.raft.vote(request).await).into_response()
}
async fn snapshot(
    State(app): State<Arc<App>>,
    role: Option<Extension<ClientRole>>,
    Json(request): Json<InstallSnapshotRequest<TypeConfig>>,
) -> Response {
    if !sender_matches(&app, role, request.vote.leader_id.node_id) {
        return (StatusCode::FORBIDDEN, "共识发送者与证书身份不匹配").into_response();
    }
    if request.offset.saturating_add(request.data.len() as u64) > SNAPSHOT_LIMIT as u64 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "接收快照超出预算").into_response();
    }
    Json(app.raft.install_snapshot(request).await).into_response()
}
fn sender_matches(app: &App, role: Option<Extension<ClientRole>>, sender: NodeId) -> bool {
    app.settings.tls.is_none()
        || role.is_some_and(|Extension(role)| role == ClientRole::Node(sender))
}
async fn initialize(State(app): State<Arc<App>>) -> Response {
    let nodes = app
        .settings
        .voters
        .iter()
        .map(|id| (*id, BasicNode::new(app.settings.peers[id].to_string())))
        .collect::<BTreeMap<_, _>>();
    match app.raft.initialize(nodes).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => (StatusCode::CONFLICT, "协调集群已有状态或不能初始化").into_response(),
    }
}
async fn metrics(State(app): State<Arc<App>>) -> Response {
    Json(app.raft.metrics().borrow().clone()).into_response()
}
async fn force_snapshot(State(app): State<Arc<App>>) -> Response {
    match app.raft.trigger().snapshot().await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(_) => uncertain(&app),
    }
}
fn uncertain(app: &App) -> Response {
    let leader = app.raft.metrics().borrow().current_leader;
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error":"未获多数派确认，请读取权威状态核对，勿自动重试写入","leader_id":leader
        })),
    )
        .into_response()
}
async fn write(State(app): State<Arc<App>>, Json(command): Json<RoomCommand>) -> Response {
    if app.settings.profile_catalog.is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !command.valid() {
        return (StatusCode::BAD_REQUEST, "房间操作无效").into_response();
    }
    let Ok(permit) = app.writes.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "尚未确认的房间提案预算已满",
        )
            .into_response();
    };
    let pending = app.clone();
    // HTTP等待取消不代表提案已撤销；许可由实际Raft完成结果释放。
    let outcome = tokio::spawn(async move {
        let _permit = permit;
        if let Some(media) = &pending.media_release
            && media
                .before_release(
                    &pending.raft,
                    &pending.store,
                    &pending.settings.cluster_id,
                    &command,
                )
                .await
                .is_err()
        {
            return None;
        }
        Some(
            pending
                .raft
                .client_write(AuthorityCommand::Room(command))
                .await,
        )
    })
    .await;
    match outcome {
        Ok(Some(Ok(result))) => {
            let reply = result.data;
            let status = match reply.outcome.as_str() {
                "applied" | "duplicate" => StatusCode::OK,
                "capacity" => StatusCode::INSUFFICIENT_STORAGE,
                _ => StatusCode::CONFLICT,
            };
            (status, Json(reply)).into_response()
        }
        _ => uncertain(&app),
    }
}

async fn profile_command(
    State(app): State<Arc<App>>,
    Json(command): Json<ProfileCommand>,
) -> Response {
    let Some(ledger) = app.store.profile_ledger().await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !command.valid(&ledger.policy) {
        return (StatusCode::BAD_REQUEST, "画像提案、主体归属或固定候选无效").into_response();
    }
    let Ok(permit) = app.writes.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "画像尚未确认提案预算已满").into_response();
    };
    let pending = app.clone();
    // 沿用原OpenRaft提案寿命；请求取消不会取消已接纳提案或提前释放预算。
    match tokio::spawn(async move {
        let _permit = permit;
        pending
            .raft
            .client_write(AuthorityCommand::Profile(command))
            .await
    })
    .await
    {
        Ok(Ok(result)) => {
            let Some(reply) = result.data.profile else {
                return uncertain(&app);
            };
            let status = match reply.outcome.as_str() {
                "applied" | "duplicate" => StatusCode::OK,
                "capacity" => StatusCode::INSUFFICIENT_STORAGE,
                _ => StatusCode::CONFLICT,
            };
            (status, Json(reply)).into_response()
        }
        _ => uncertain(&app),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileProjectionRequest {
    subject: String,
    domains: Vec<String>,
}

async fn profile_projection(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(request): Json<ProfileProjectionRequest>,
) -> Response {
    if let Some(access) = &app.profile_access {
        let mut values = headers.get_all("x-profile-access-grant").iter();
        let token = values
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty());
        if values.next().is_some() {
            return (StatusCode::UNAUTHORIZED, "画像主体授权凭据重复").into_response();
        }
        let Some(token) = token else {
            return (StatusCode::UNAUTHORIZED, "缺少画像主体授权凭据").into_response();
        };
        let verifier = access.clone();
        let token = token.to_owned();
        let claims = match tokio::task::spawn_blocking(move || verifier.authenticate(&token)).await
        {
            Ok(Ok(claims)) => claims,
            _ => {
                return (StatusCode::UNAUTHORIZED, "画像主体授权凭据无效").into_response();
            }
        };
        if claims.subject != request.subject
            || request
                .domains
                .iter()
                .any(|domain| !claims.domains.iter().any(|allowed| allowed == domain))
        {
            return (StatusCode::FORBIDDEN, "画像主体或领域超出授权范围").into_response();
        }
    }
    if app.settings.profile_catalog.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if app.raft.ensure_linearizable().await.is_err() {
        return uncertain(&app);
    }
    let Some((ledger, applied_index)) = app.store.profile_read_view().await else {
        return uncertain(&app);
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return uncertain(&app);
    };
    match ledger.projection(
        &request.subject,
        request.domains.clone(),
        now.as_secs() + 60,
    ) {
        Ok(profile) => Json(serde_json::json!({
            "schema":"profile-consensus-projection-v1",
            "cluster_id":app.settings.cluster_id,
            "catalog_sha256":ledger.policy.catalog_sha256,
            "shard_count":ledger.policy.shard_count,
            "applied_index":applied_index,
            "subject":request.subject,"domains":request.domains,
            "profile":profile
        }))
        .into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, "画像投影请求无效").into_response(),
    }
}

async fn profile_writer(State(app): State<Arc<App>>, Path(shard): Path<u16>) -> Response {
    if app.settings.profile_catalog.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if app.raft.ensure_linearizable().await.is_err() {
        return uncertain(&app);
    }
    let Some((ledger, applied_index)) = app.store.profile_read_view().await else {
        return uncertain(&app);
    };
    if shard >= ledger.policy.shard_count {
        return StatusCode::BAD_REQUEST.into_response();
    }
    Json(serde_json::json!({
        "schema":"profile-consensus-writer-v1","cluster_id":app.settings.cluster_id,
        "catalog_sha256":ledger.policy.catalog_sha256,"shard":shard,
        "shard_count":ledger.policy.shard_count,"applied_index":applied_index,
        "writer":ledger.writers.get(&shard),"events":ledger.event_count()
    }))
    .into_response()
}

async fn profile_ready(State(app): State<Arc<App>>) -> Response {
    if app.settings.profile_catalog.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if app.raft.ensure_linearizable().await.is_err() {
        return uncertain(&app);
    }
    let Some((ledger, applied_index)) = app.store.profile_read_view().await else {
        return uncertain(&app);
    };
    Json(serde_json::json!({
        "schema":"profile-consensus-ready-v1","cluster_id":app.settings.cluster_id,
        "catalog_sha256":ledger.policy.catalog_sha256,
        "shard_count":ledger.policy.shard_count,"applied_index":applied_index
    }))
    .into_response()
}

async fn write_media(
    State(app): State<Arc<App>>,
    Json(command): Json<MediaNodeCommand>,
) -> Response {
    if !app
        .media_release
        .as_ref()
        .is_some_and(MediaRelease::registry_required)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if matches!(&command, MediaNodeCommand::SetMediaDraining { .. })
        && !app
            .media_release
            .as_ref()
            .is_some_and(MediaRelease::node_draining_enabled)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !app
        .media_release
        .as_ref()
        .is_some_and(|media| media.registry_accepts(&command))
    {
        return (StatusCode::BAD_REQUEST, "媒体节点登记操作无效").into_response();
    }
    let Ok(permit) = app.writes.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "尚未确认的节点提案预算已满",
        )
            .into_response();
    };
    let pending = app.clone();
    // 与房间提案共用4许可；HTTP取消不能提前释放仍可能提交的提案预算。
    match tokio::spawn(async move {
        let _permit = permit;
        pending
            .raft
            .client_write(AuthorityCommand::Media(command))
            .await
    })
    .await
    {
        Ok(Ok(result)) => {
            let reply = MediaNodeReply {
                outcome: result.data.outcome,
                record: result.data.media_node,
            };
            let status = match reply.outcome.as_str() {
                "applied" | "duplicate" => StatusCode::OK,
                "capacity" => StatusCode::INSUFFICIENT_STORAGE,
                _ => StatusCode::CONFLICT,
            };
            (status, Json(reply)).into_response()
        }
        _ => uncertain(&app),
    }
}

async fn read_media(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    if !app
        .media_release
        .as_ref()
        .is_some_and(MediaRelease::registry_required)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !vs_core::valid_id(&id) {
        return (StatusCode::BAD_REQUEST, "媒体节点标识无效").into_response();
    }
    if app.raft.ensure_linearizable().await.is_err() {
        return uncertain(&app);
    }
    Json(serde_json::json!({
        "cluster_id": app.settings.cluster_id,
        "node_id": id,
        "record": app.store.media_node(&id).await,
    }))
    .into_response()
}
async fn media_maintenance(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    if !app
        .media_release
        .as_ref()
        .is_some_and(MediaRelease::registry_required)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !vs_core::valid_id(&id) || matches!(id.as_str(), "." | "..") {
        return (StatusCode::BAD_REQUEST, "媒体节点标识无效").into_response();
    }
    if app.raft.ensure_linearizable().await.is_err() {
        return uncertain(&app);
    }
    // 节点与所有所属房间在同一状态锁下读取，避免逐房查询拼接出不同时点的预览。
    Json(
        app.store
            .media_maintenance(&app.settings.cluster_id, &id)
            .await,
    )
    .into_response()
}
async fn assignment(
    State(app): State<Arc<App>>,
    role: Option<Extension<ClientRole>>,
    Path((tenant, room)): Path<(String, String)>,
) -> Response {
    if !vs_core::valid_id(&tenant) || !vs_core::valid_id(&room) {
        return (StatusCode::BAD_REQUEST, "房间标识无效").into_response();
    }
    if app.raft.ensure_linearizable().await.is_err() {
        return uncertain(&app);
    }
    let record = app.store.room(&format!("{tenant}/{room}")).await;
    if let Some(Extension(ClientRole::MediaReader(id))) = role
        && record
            .as_ref()
            .and_then(|entry| entry.owner.as_ref())
            .is_none_or(|owner| owner.node_id != id)
    {
        return (
            StatusCode::FORBIDDEN,
            "媒体证书只允许核验当前分配给本节点的房间",
        )
            .into_response();
    }
    Json(AssignmentView {
        cluster_id: app.settings.cluster_id.clone(),
        tenant_id: tenant,
        room_id: room,
        record: record.map(|record| AssignmentRecord {
            revision: record.revision,
            owner: record.owner.map(|owner| MediaTarget {
                node_id: owner.node_id,
                incarnation: owner.incarnation,
            }),
        }),
    })
    .into_response()
}
async fn read_room(
    State(app): State<Arc<App>>,
    Path((tenant, room)): Path<(String, String)>,
) -> Response {
    if tenant.len() > 64 || room.len() > 64 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if app.raft.ensure_linearizable().await.is_err() {
        return uncertain(&app);
    }
    Json(app.store.room(&format!("{tenant}/{room}")).await).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MembershipChange {
    nodes: BTreeSet<NodeId>,
}

async fn learner(State(app): State<Arc<App>>, Path(id): Path<NodeId>) -> Response {
    let Some(addr) = app.settings.peers.get(&id) else {
        return (StatusCode::BAD_REQUEST, "节点不在固定名册").into_response();
    };
    match app
        .raft
        .add_learner(id, BasicNode::new(addr.to_string()), true)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => uncertain(&app),
    }
}
async fn membership(State(app): State<Arc<App>>, Json(change): Json<MembershipChange>) -> Response {
    if change.nodes.is_empty()
        || !change
            .nodes
            .iter()
            .all(|id| app.settings.peers.contains_key(id))
    {
        return (StatusCode::BAD_REQUEST, "成员集合无效").into_response();
    }
    match app.raft.change_membership(change.nodes, false).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => uncertain(&app),
    }
}

fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/raft/append", post(append))
        .route("/raft/vote", post(vote))
        .route("/raft/snapshot", post(snapshot))
        .route("/admin/initialize", post(initialize))
        .route("/admin/snapshot", post(force_snapshot))
        .route("/admin/learners/{id}", post(learner))
        .route("/admin/membership", post(membership))
        .route("/metrics", get(metrics))
        .route("/v1/rooms/commands", post(write))
        .route("/internal/lab/profile/commands", post(profile_command))
        .route("/internal/lab/profile/projection", post(profile_projection))
        .route("/internal/lab/profile/ready", get(profile_ready))
        .route("/internal/lab/profile/writers/{shard}", get(profile_writer))
        .route("/v1/media-nodes/commands", post(write_media))
        .route("/v1/media-nodes/{id}", get(read_media))
        .route("/v1/media-nodes/{id}/maintenance", get(media_maintenance))
        .route("/v1/rooms/{tenant}/{room}", get(read_room))
        .route("/v1/room-assignments/{tenant}/{room}", get(assignment))
        .layer(DefaultBodyLimit::max(SNAPSHOT_LIMIT))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(3),
        ))
        .layer(middleware::from_fn_with_state(app.clone(), boundary))
        .with_state(app)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(io::stderr)
        .init();
    let path = env::var_os("VS_COORDINATION_CONFIG")
        .ok_or_else(|| io::Error::other("未指定协调节点配置"))?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(16385)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16384 {
        return Err(io::Error::other("协调配置超出16KiB"));
    }
    let mut settings: Settings =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("协调配置格式无效"))?;
    if settings.cluster_id.is_empty()
        || settings.cluster_id.len() > 64
        || !settings.cluster_id.is_ascii()
        || settings.node_id == 0
        || settings.bind.port() == 0
        || !allowed_endpoint(settings.bind, settings.tls.is_some())
        || settings.peers.get(&settings.node_id) != Some(&settings.bind)
        || !(1..=5).contains(&settings.peers.len())
        || settings.voters.is_empty()
        || !settings
            .voters
            .iter()
            .all(|id| settings.peers.contains_key(id))
        || !settings
            .peers
            .values()
            .all(|addr| allowed_endpoint(*addr, settings.tls.is_some()))
        || settings.peers.values().collect::<BTreeSet<_>>().len() != settings.peers.len()
        || !(32..=256).contains(&settings.service_token.len())
        || !settings
            .service_token
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
        || !settings.data_dir.is_absolute()
    {
        return Err(io::Error::other(
            "协调节点身份、传输模式、固定名册、凭据或数据目录无效",
        ));
    }
    let tls = settings
        .tls
        .as_ref()
        .map(|config| TlsTransport::load(config, settings.node_id, &settings.peers))
        .transpose()?;
    let profile_policy = match (&settings.profile_catalog, settings.profile_shard_count) {
        (None, None) => None,
        (Some(path), Some(count)) if path.is_absolute() && settings.media_control.is_none() => {
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            Some(ProfilePolicy::from_catalog(&bytes, count).map_err(io::Error::other)?)
        }
        _ => {
            return Err(io::Error::other(
                "画像实验必须成对指定绝对目录路径和分片数，不能混用媒体控制",
            ));
        }
    };
    let has_readers = settings
        .tls
        .as_ref()
        .is_some_and(|tls| !tls.profile_reader_sha256.is_empty());
    if has_readers && settings.profile_access.is_none() {
        return Err(io::Error::other(
            "画像只读TLS角色必须配置独立主体授权签名公钥",
        ));
    }
    if settings.profile_access.is_some()
        && (profile_policy.is_none()
            || tls.is_none()
            || !has_readers
            || settings.profile_read_token.is_none())
    {
        return Err(io::Error::other(
            "画像主体授权必须同时配置画像共识、只读TLS身份和独立读取令牌",
        ));
    }
    let profile_access_config = settings.profile_access.clone();
    let profile_access = profile_access_config
        .clone()
        .map(ProfileAccess::new)
        .transpose()
        .map_err(io::Error::other)?
        .map(Arc::new);
    match (&settings.profile_read_token, has_readers) {
        (None, false) => {}
        (Some(token), true)
            if profile_policy.is_some()
                && (32..=256).contains(&token.len())
                && token.bytes().all(|byte| byte.is_ascii_graphic())
                && !bool::from(token.as_bytes().ct_eq(settings.service_token.as_bytes())) => {}
        _ => {
            return Err(io::Error::other(
                "画像读取角色须在画像TLS模式配对独立令牌，不能复用控制令牌",
            ));
        }
    }
    let seconds: u64 = env::var("VS_COORDINATION_RUN_SECONDS")
        .unwrap_or_else(|_| "300".into())
        .parse()
        .map_err(|_| io::Error::other("运行期限无效"))?;
    if !(30..=900).contains(&seconds) {
        return Err(io::Error::other("实验期限须为30至900秒"));
    }
    std::fs::create_dir_all(&settings.data_dir)?;
    let registry_policy = settings
        .media_control
        .as_ref()
        .map(MediaReleaseConfig::registry_policy)
        .transpose()
        .map_err(io::Error::other)?
        .unwrap_or(MediaRegistryPolicy::Disabled);
    let (logs, store) = match &profile_policy {
        Some(policy) => storage::open_with_profile_policy(
            &settings.data_dir.join("authority.redb"),
            &settings.cluster_id,
            settings.node_id,
            policy.clone(),
        ),
        None => storage::open_with_registry_policy(
            &settings.data_dir.join("authority.redb"),
            &settings.cluster_id,
            settings.node_id,
            registry_policy,
        ),
    }
    .map_err(io::Error::other)?;
    let config = Config {
        cluster_name: settings.cluster_id.clone(),
        heartbeat_interval: 500,
        election_timeout_min: 1500,
        election_timeout_max: 3000,
        max_payload_entries: 16,
        snapshot_policy: openraft::SnapshotPolicy::LogsSinceLast(16),
        snapshot_max_chunk_size: 64 * 1024,
        max_in_snapshot_log_to_keep: 0,
        purge_batch_size: 1,
        ..Config::default()
    }
    .validate()
    .map_err(io::Error::other)?;
    // 持久化业务与传输模式，不绑定可轮换证书；明文模式保持既有策略字节兼容。
    let media_policy = settings
        .media_control
        .as_ref()
        .map(MediaReleaseConfig::policy);
    let policy_bytes = if let Some(profile_policy) = &profile_policy {
        serde_json::to_vec(&serde_json::json!({
            "profile_authority":profile_policy,
            "profile_access":profile_access_config,
            "transport":if tls.is_some() { POLICY_MODE } else { "loopback-http" }
        }))
    } else if tls.is_some() {
        serde_json::to_vec(&serde_json::json!({
            "media_control": media_policy, "transport": POLICY_MODE
        }))
    } else {
        serde_json::to_vec(&media_policy)
    }
    .map_err(io::Error::other)?;
    let policy = format!("{:x}", Sha256::digest(policy_bytes));
    // 先确认客户端材料可用，再固定不可静默迁移的业务策略。
    let media_release = settings
        .media_control
        .take()
        .map(MediaRelease::new)
        .transpose()
        .map_err(io::Error::other)?;
    logs.pin_policy(&policy).map_err(io::Error::other)?;
    let mut network = Network::new(
        settings.service_token.clone(),
        settings.peers.clone(),
        policy.clone(),
    )
    .map_err(io::Error::other)?;
    if let Some(tls) = &tls {
        network = network.with_tls(tls);
    }
    let raft = Raft::new(
        settings.node_id,
        Arc::new(config),
        network,
        logs,
        store.clone(),
    )
    .await
    .map_err(io::Error::other)?;
    let listener = tokio::net::TcpListener::bind(settings.bind).await?;
    #[derive(Serialize)]
    struct Ready<'a> {
        schema: &'a str,
        pid: u32,
        node_id: NodeId,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tls_identity_policy_sha256: Option<String>,
    }
    println!(
        "{}",
        serde_json::to_string(&Ready {
            schema: "room-authority-lab-v1",
            pid: std::process::id(),
            node_id: settings.node_id,
            url: if let Some(tls) = &tls {
                format!(
                    "https://{}",
                    tls.authority(settings.node_id, settings.bind)?
                )
            } else {
                format!("http://{}", settings.bind)
            },
            tls_identity_policy_sha256: tls
                .as_ref()
                .map(|tls| {
                    serde_json::to_vec(tls.identity_policy())
                        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                })
                .transpose()
                .map_err(io::Error::other)?,
        })
        .unwrap()
    );
    let authority = if let Some(tls) = &tls {
        tls.authority(settings.node_id, settings.bind)?
    } else {
        settings.bind.to_string()
    };
    let app = Arc::new(App {
        raft: raft.clone(),
        store,
        settings,
        slots: tokio::sync::Semaphore::new(8),
        writes: Arc::new(tokio::sync::Semaphore::new(4)),
        media_release,
        profile_access,
        policy,
        authority,
    });
    let shutdown = async move {
        tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = tokio::time::sleep(Duration::from_secs(seconds))=>{}}
    };
    let result = if let Some(tls) = &tls {
        tls.serve(listener, router(app), shutdown).await
    } else {
        axum::serve(listener, router(app))
            .with_graceful_shutdown(shutdown)
            .await
    };
    raft.shutdown().await.map_err(io::Error::other)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonloopback_coordination_requires_tls_and_an_explicit_private_address() {
        for (address, plain, tls) in [
            ("127.0.0.1:31000", true, true),
            ("[::1]:31000", true, true),
            ("10.1.2.3:31000", false, true),
            ("192.168.1.2:31000", false, true),
            ("[fd00::1]:31000", false, true),
            ("0.0.0.0:31000", false, false),
            ("[::]:31000", false, false),
            ("192.0.2.1:31000", false, false),
            ("169.254.1.1:31000", false, false),
            ("224.0.0.1:31000", false, false),
            ("127.0.0.1:0", false, false),
        ] {
            let address = address.parse().unwrap();
            assert_eq!(allowed_endpoint(address, false), plain);
            assert_eq!(allowed_endpoint(address, true), tls);
        }
    }
}
