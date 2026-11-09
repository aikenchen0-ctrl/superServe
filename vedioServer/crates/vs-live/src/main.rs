use std::{
    env,
    io::{self, Read},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State, rejection::JsonRejection},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
};
use str0m::change::SdpOffer;
use tower_http::timeout::TimeoutLayer;
use vs_live::access::{LiveAccess, LiveAccessConfig};
use vs_live::room_control::{RoomControl, RoomControlConfig};
use vs_live::{OfferReply, PeerRole, Relay, RelayError};

mod client_ice;
mod drain_tls;
mod room_http;
mod rooms_http;
mod sdp_http;
mod signaling_tls;

#[derive(Clone)]
struct WebState {
    relay: Relay,
    authority: String,
    origin: String,
    base_path: String,
    access: Option<Arc<LiveAccess>>,
    room_control: Option<Arc<RoomControl>>,
}

fn error(error: RelayError) -> Response {
    let (status, message) = match error {
        RelayError::Busy => (StatusCode::SERVICE_UNAVAILABLE, "实时媒体容量或队列已满"),
        RelayError::Conflict => (StatusCode::CONFLICT, "发布者或订阅状态冲突"),
        RelayError::Invalid => (
            StatusCode::BAD_REQUEST,
            "仅接受一路VP8或H264视频、可选单路Opus音频和固定方向协商",
        ),
        RelayError::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "实时媒体工作线程不可用"),
        RelayError::Denied => (StatusCode::UNAUTHORIZED, "直播权限已失效"),
        RelayError::NotFound => (StatusCode::NOT_FOUND, "实时媒体会话不存在"),
        RelayError::Precondition => (StatusCode::PRECONDITION_FAILED, "ICE会话代次不匹配"),
        RelayError::IceRestartUnsupported => (StatusCode::UNPROCESSABLE_ENTITY, "暂不支持ICE重启"),
    };
    let mut response = (status, message).into_response();
    if status == StatusCode::UNAUTHORIZED {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, "Bearer".parse().unwrap());
    }
    response
}

fn router(state: Arc<WebState>) -> Router {
    let mut app = Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("../../../labs/webrtc/index.html")) }),
        )
        .route(
            "/ice-config.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../../../labs/webrtc/ice-config.js"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../../../labs/webrtc/app.js"),
                )
            }),
        )
        .route("/lab/metrics", get(metrics))
        .route("/lab/node", get(node));
    // 启用凭据后不保留匿名诊断写入口，避免绕过同一房间的权限检查。
    if state.access.is_none() {
        app = app
            .route("/lab/offer/{role}", post(offer))
            .route("/lab/peers/{id}", delete(remove));
    }
    app.merge(sdp_http::routes(state.clone()))
        .merge(room_http::routes(state.clone()))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(8),
        ))
        .layer(middleware::from_fn_with_state(state.clone(), local_only))
        .with_state(state)
}

async fn node(State(state): State<Arc<WebState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "access_required": state.access.is_some(),
        "binding": state.access.as_ref().map(|access| access.binding()),
        "assignment_cluster":state.room_control.as_ref().map(|control|control.cluster_id()),
    }))
}

async fn local_only(State(state): State<Arc<WebState>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(&state.authority)
        || headers
            .get(header::ORIGIN)
            .is_some_and(|value| value.to_str().ok() != Some(&state.origin))
        || headers
            .get("sec-fetch-site")
            .is_some_and(|value| !matches!(value.to_str(), Ok("same-origin" | "none")))
    {
        return (StatusCode::FORBIDDEN, "仅允许同源回环实验").into_response();
    }
    let mut response = next.run(request).await;
    if matches!(
        response.status(),
        StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::PAYLOAD_TOO_LARGE
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
    ) {
        response = (response.status(), "媒体请求格式、正文类型或大小不符合契约").into_response();
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        state.origin.parse().unwrap(),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        "Location, ETag, Accept-Patch, X-VS-Session-Lease"
            .parse()
            .unwrap(),
    );
    response
}

async fn metrics(State(state): State<Arc<WebState>>) -> Response {
    match state.relay.stats() {
        Ok(stats) => Json(stats).into_response(),
        Err(_) => error(RelayError::Unavailable),
    }
}

async fn offer(
    State(state): State<Arc<WebState>>,
    Path(role): Path<String>,
    payload: Result<Json<SdpOffer>, JsonRejection>,
) -> Response {
    let role = match role.as_str() {
        "publisher" => PeerRole::Publisher,
        "subscriber" => PeerRole::Subscriber,
        _ => return (StatusCode::NOT_FOUND, "实时媒体角色不存在").into_response(),
    };
    let Ok(Json(offer)) = payload else {
        return (StatusCode::BAD_REQUEST, "SDP协商正文无效或超出64KiB").into_response();
    };
    match state.relay.offer(role, offer).await {
        Ok(reply) => (StatusCode::CREATED, Json::<OfferReply>(reply)).into_response(),
        Err(reason) => error(reason),
    }
}

async fn remove(State(state): State<Arc<WebState>>, Path(id): Path<String>) -> Response {
    match state.relay.remove(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, "实时媒体会话不存在").into_response(),
        Err(reason) => error(reason),
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();
    let bind: SocketAddr = env::var("VS_LIVE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:0".into())
        .parse()
        .map_err(|_| io::Error::other("实时媒体监听地址无效"))?;
    if !bind.ip().is_loopback() {
        return Err(io::Error::other("实时媒体实验仅允许回环监听"));
    }
    let seconds: u64 = env::var("VS_LIVE_RUN_SECONDS")
        .unwrap_or_else(|_| "300".into())
        .parse()
        .map_err(|_| io::Error::other("实时媒体运行期限无效"))?;
    if !(30..=900).contains(&seconds) {
        return Err(io::Error::other("实时媒体实验期限须为30至900秒"));
    }
    let node_rooms = env::var_os("VS_LIVE_ROOMS_CONFIG");
    if node_rooms.is_some() && env::var_os("VS_LIVE_ACCESS_CONFIG").is_some() {
        return Err(io::Error::other("多房间配置与旧单房间凭据配置不能同时启用"));
    }
    let access = env::var_os("VS_LIVE_ACCESS_CONFIG")
        .map(|path| {
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(16 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 16 * 1024 {
                return Err(io::Error::other("直播凭据配置超出16KiB"));
            }
            let config: LiveAccessConfig = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::other("直播凭据配置格式无效"))?;
            LiveAccess::new(config)
                .map(Arc::new)
                .map_err(io::Error::other)
        })
        .transpose()?;
    let room_control = env::var_os("VS_LIVE_ROOM_CONTROL_CONFIG")
        .map(|path| {
            if access.is_none() && node_rooms.is_none() {
                return Err(io::Error::other("房间控制要求先配置直播凭据"));
            }
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(16385)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 16384 {
                return Err(io::Error::other("房间控制配置超出16KiB"));
            }
            let config: RoomControlConfig = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::other("房间控制配置格式无效"))?;
            RoomControl::new(config)
                .map(Arc::new)
                .map_err(io::Error::other)
        })
        .transpose()?;
    let drain = env::var_os("VS_LIVE_DRAIN_TLS_CONFIG")
        .map(|path| {
            if room_control.is_none() {
                return Err(io::Error::other("TLS排空必须先配置受控媒体身份"));
            }
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(16385)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 16384 {
                return Err(io::Error::other("TLS排空配置超出16KiB"));
            }
            let config = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::other("TLS排空配置格式无效"))?;
            drain_tls::DrainTls::load(config)
        })
        .transpose()?;
    let drain_control = room_control.clone();
    let signaling = env::var_os("VS_LIVE_SIGNALING_TLS_CONFIG")
        .map(|path| {
            if room_control.is_none() || access.is_none() && node_rooms.is_none() {
                return Err(io::Error::other("HTTPS信令要求受控房间及直播JWT凭据"));
            }
            let path = std::path::PathBuf::from(path);
            if !path.is_absolute() {
                return Err(io::Error::other("HTTPS信令配置须为绝对路径"));
            }
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(16385)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 16384 {
                return Err(io::Error::other("HTTPS信令配置超出16KiB"));
            }
            let config = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::other("HTTPS信令配置格式无效"))?;
            signaling_tls::SignalingTls::load(config)
        })
        .transpose()?;
    let media_network = signaling
        .as_ref()
        .and_then(|signal| signal.config.media.clone());
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let address = listener.local_addr()?;
    let drain_listener = if let Some(drain) = &drain {
        Some(tokio::net::TcpListener::bind(drain.bind).await?)
    } else {
        None
    };
    let signal_listener = if let Some(signal) = &signaling {
        Some(tokio::net::TcpListener::bind(signal.config.bind).await?)
    } else {
        None
    };
    let (app, drain_app, signal_app, worker) = if let Some(path) = node_rooms {
        let control = room_control.ok_or_else(|| io::Error::other("多房间节点必须配置房间控制"))?;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(16385)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 16384 {
            return Err(io::Error::other("多房间配置超出16KiB"));
        }
        let config =
            serde_json::from_slice(&bytes).map_err(|_| io::Error::other("多房间配置格式无效"))?;
        let (registry, worker) = rooms_http::RoomRegistry::start_network(
            config,
            control,
            address.to_string(),
            media_network,
        )?;
        println!(
            "{}",
            serde_json::json!({
                "schema": "live-node-rooms-v1", "pid": std::process::id(),
                "url": format!("http://{address}"), "run_seconds": seconds,
                "capacity": vs_live::MAX_ROOMS, "media_workers": 1,
                "drain_url": drain.as_ref().map(|drain| drain.url()),
                "signaling_url": signaling.as_ref().map(|signal| signal.url()),
            })
        );
        let drain_app = Router::new()
            .route("/admin/room/drain", post(rooms_http::drain))
            .with_state(registry.clone());
        let signal_app = signaling
            .as_ref()
            .map(|signal| registry.signaling_routes(signal))
            .transpose()?;
        (rooms_http::routes(registry), drain_app, signal_app, worker)
    } else {
        let (relay, worker) = if let Some(network) = media_network {
            let (mut relays, worker) = Relay::start_rooms_private(1, network)?;
            (relays.remove(0), worker)
        } else if room_control.is_some() {
            Relay::start_guarded()?
        } else {
            Relay::start()?
        };
        let state = Arc::new(WebState {
            relay,
            authority: address.to_string(),
            origin: format!("http://{address}"),
            base_path: String::new(),
            access,
            room_control,
        });
        println!(
            "{}",
            serde_json::json!({
                "schema":"live-sfu-lab-v1","pid":std::process::id(),
                "url":state.origin,"udp_port":state.relay.stats()?.udp_port,"run_seconds":seconds,
                "access_required":state.access.is_some(),
                "binding":state.access.as_ref().map(|access| access.binding()),
                "assignment_cluster":state.room_control.as_ref().map(|control|control.cluster_id()),
                "drain_url":drain.as_ref().map(|drain|drain.url())
                ,"signaling_url":signaling.as_ref().map(|signal|signal.url())
            })
        );
        let drain_app = Router::new()
            .route("/admin/room/drain", post(room_http::drain))
            .with_state(state.clone());
        let signal_app = signaling
            .as_ref()
            .map(|signal| signal.router(&state))
            .transpose()?;
        (router(state), drain_app, signal_app, worker)
    };
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let mut servers = tokio::task::JoinSet::new();
    let mut http_stop = stopped.clone();
    servers.spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = http_stop.changed().await;
            })
            .await
    });
    if let (Some(drain), Some(listener), Some(control)) = (drain, drain_listener, drain_control) {
        let mut tls_stop = stopped.clone();
        servers.spawn(async move {
            drain
                .serve(listener, drain_app, control, async move {
                    let _ = tls_stop.changed().await;
                })
                .await
        });
    }
    if let (Some(signal), Some(listener), Some(app)) = (signaling, signal_listener, signal_app) {
        let mut tls_stop = stopped;
        servers.spawn(async move {
            signal
                .serve(listener, app, async move {
                    let _ = tls_stop.changed().await;
                })
                .await
        });
    }
    let outcome = tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => Ok(()),
        result = servers.join_next() => server_result(result),
    };
    let _ = stop.send(true);
    let drained = tokio::time::timeout(Duration::from_secs(10), async {
        let mut result = Ok(());
        while let Some(server) = servers.join_next().await {
            let next = server_result(Some(server));
            if result.is_ok() {
                result = next;
            }
        }
        result
    })
    .await;
    let outcome = outcome.and(match drained {
        Ok(result) => result,
        Err(_) => {
            servers.shutdown().await;
            Err(io::Error::other("媒体监听停机排空超时"))
        }
    });
    let cleanup = tokio::task::spawn_blocking(move || worker.shutdown())
        .await
        .map_err(|_| io::Error::other("实时媒体清理任务异常"))?;
    cleanup?;
    outcome
}

fn server_result(result: Option<Result<io::Result<()>, tokio::task::JoinError>>) -> io::Result<()> {
    match result {
        Some(Ok(result)) => result,
        _ => Err(io::Error::other("媒体监听任务异常结束")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[tokio::test]
    async fn local_http_boundary_rejects_wrong_host_origin_and_cross_site_requests() {
        let (relay, worker) = Relay::start().unwrap();
        let state = Arc::new(WebState {
            relay,
            authority: "127.0.0.1:32100".into(),
            origin: "http://127.0.0.1:32100".into(),
            base_path: String::new(),
            access: None,
            room_control: None,
        });
        let app = router(state);
        for (host, origin, site) in [
            ("evil.example", "http://127.0.0.1:32100", "same-origin"),
            ("127.0.0.1:32100", "http://evil.example", "same-origin"),
            ("127.0.0.1:32100", "http://127.0.0.1:32100", "cross-site"),
        ] {
            let request = axum::http::Request::builder()
                .uri("/lab/metrics")
                .header("host", host)
                .header("origin", origin)
                .header("sec-fetch-site", site)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        let request = axum::http::Request::builder()
            .uri("/lab/metrics")
            .header("host", "127.0.0.1:32100")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn invalid_offer_and_missing_peer_are_rejected_without_creating_a_session() {
        let (relay, worker) = Relay::start().unwrap();
        let state = Arc::new(WebState {
            relay: relay.clone(),
            authority: "127.0.0.1:32100".into(),
            origin: "http://127.0.0.1:32100".into(),
            base_path: String::new(),
            access: None,
            room_control: None,
        });
        let app = router(state);
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/lab/offer/publisher")
            .header("host", "127.0.0.1:32100")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"type":"offer","sdp":"invalid"}"#))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        let request = axum::http::Request::builder()
            .method("DELETE")
            .uri("/lab/peers/42")
            .header("host", "127.0.0.1:32100")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(request).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(relay.stats().unwrap().accepted_sessions, 0);
        worker.shutdown().unwrap();
    }
}
