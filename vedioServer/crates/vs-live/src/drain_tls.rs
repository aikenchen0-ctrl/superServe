use std::{collections::BTreeSet, future::Future, io, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tokio::{net::TcpListener, sync::Semaphore};
use tower_http::timeout::TimeoutLayer;
use vs_live::room_control::RoomControl;
use vs_tls::{FixedServerTls, VerifiedPeer, allowed_endpoint};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DrainTlsConfig {
    pub bind: SocketAddr,
    pub server: FixedServerTls,
    pub coordinator_sha256: Vec<String>,
}

pub struct DrainTls {
    pub bind: SocketAddr,
    authority: String,
    server: Arc<rustls::ServerConfig>,
    peers: Arc<BTreeSet<String>>,
}

#[derive(Clone)]
struct Boundary {
    authority: String,
    peers: Arc<BTreeSet<String>>,
    control: Arc<RoomControl>,
    slots: Arc<Semaphore>,
}

impl DrainTls {
    pub fn load(config: DrainTlsConfig) -> io::Result<Self> {
        if !allowed_endpoint(config.bind, true)
            || !(1..=5).contains(&config.coordinator_sha256.len())
            || config
                .coordinator_sha256
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != config.coordinator_sha256.len()
            || config.coordinator_sha256.iter().any(|hash| {
                hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    || hash == &config.server.certificate_sha256
            })
        {
            return Err(io::Error::other("TLS排空监听地址或协调证书名单无效"));
        }
        let server = config.server.load()?;
        Ok(Self {
            bind: config.bind,
            authority: format!("{}:{}", config.server.server_name, config.bind.port()),
            server,
            peers: Arc::new(config.coordinator_sha256.into_iter().collect()),
        })
    }

    pub fn url(&self) -> String {
        format!("https://{}", self.authority)
    }

    pub async fn serve(
        self,
        listener: TcpListener,
        app: Router,
        control: Arc<RoomControl>,
        shutdown: impl Future<Output = ()>,
    ) -> io::Result<()> {
        let boundary = Boundary {
            authority: self.authority,
            peers: self.peers,
            control,
            slots: Arc::new(Semaphore::new(4)),
        };
        let app = app
            .layer(DefaultBodyLimit::max(8192))
            .layer(TimeoutLayer::with_status_code(
                StatusCode::GATEWAY_TIMEOUT,
                Duration::from_secs(3),
            ))
            .layer(middleware::from_fn_with_state(boundary, authenticate));
        vs_tls::serve_mtls(self.server, listener, app, shutdown).await
    }
}

async fn authenticate(State(state): State<Boundary>, request: Request, next: Next) -> Response {
    if request.method() != Method::POST
        || request.uri().path() != "/admin/room/drain"
        || request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(state.authority.as_str())
        || request.headers().contains_key(header::ORIGIN)
        || !request
            .extensions()
            .get::<VerifiedPeer>()
            .is_some_and(|peer| state.peers.contains(peer.sha256()))
    {
        return (StatusCode::FORBIDDEN, "TLS排空仅允许固定协调身份和目标接口").into_response();
    }
    let mut auth = request.headers().get_all(header::AUTHORIZATION).iter();
    let token = auth
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if auth.next().is_some() || !token.is_some_and(|token| state.control.authenticate(token)) {
        return (StatusCode::UNAUTHORIZED, "TLS排空控制凭据无效").into_response();
    }
    let Ok(_permit) = state.slots.try_acquire() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "TLS排空请求预算已满").into_response();
    };
    let mut response = next.run(request).await;
    if matches!(
        response.status(),
        StatusCode::BAD_REQUEST
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::PAYLOAD_TOO_LARGE
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
    ) {
        response = (response.status(), "排空请求格式、正文类型或大小不符合契约").into_response();
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
