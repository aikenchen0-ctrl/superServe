use std::{future::Future, io, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Extension, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use vs_live::network::PrivateMediaNetwork;
use vs_tls::FixedServerTls;

use crate::{WebState, sdp_http};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignalingTlsConfig {
    pub bind: SocketAddr,
    pub server: FixedServerTls,
    pub allowed_origins: Vec<String>,
    #[serde(default)]
    pub media: Option<PrivateMediaNetwork>,
    #[serde(default)]
    pub client_ice: Option<crate::client_ice::ClientIceConfig>,
}

pub struct SignalingTls {
    pub config: SignalingTlsConfig,
    tls: Arc<rustls::ServerConfig>,
    ice: Option<Arc<crate::client_ice::ClientIce>>,
}

fn valid_origin(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.origin().ascii_serialization() == value
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https"
            || url.scheme() == "http"
                && url.host_str().is_some_and(|host| {
                    host.trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
                }))
}

impl SignalingTls {
    pub fn load(mut config: SignalingTlsConfig) -> io::Result<Self> {
        if !vs_tls::allowed_endpoint(config.bind, true)
            || config.allowed_origins.len() > 8
            || config
                .allowed_origins
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != config.allowed_origins.len()
            || config
                .allowed_origins
                .iter()
                .any(|origin| !valid_origin(origin))
        {
            return Err(io::Error::other(
                "信令须使用明确私网或回环端点及最多8个唯一精确来源",
            ));
        }
        if let Some(media) = &config.media {
            media.check()?;
        }
        let ice = config
            .client_ice
            .take()
            .map(crate::client_ice::ClientIce::load)
            .transpose()?
            .map(Arc::new);
        let tls = config.server.load_https()?;
        Ok(Self { config, tls, ice })
    }

    pub fn url(&self) -> String {
        format!("https://{}", self.authority())
    }

    fn authority(&self) -> String {
        if self.config.bind.port() == 443 {
            self.config.server.server_name.clone()
        } else {
            format!(
                "{}:{}",
                self.config.server.server_name,
                self.config.bind.port()
            )
        }
    }

    pub fn router(&self, state: &Arc<WebState>) -> io::Result<Router> {
        if state.access.is_none() || state.room_control.is_none() {
            return Err(io::Error::other(
                "客户端HTTPS入口禁止匿名或无房间控制的媒体状态",
            ));
        }
        let mut endpoint = state.as_ref().clone();
        endpoint.authority = self.authority();
        endpoint.origin = self.url();
        let endpoint = Arc::new(endpoint);
        let policy = Arc::new(SignalingBoundary {
            authority: endpoint.authority.clone(),
            origins: self.config.allowed_origins.clone(),
        });
        // 客户端入口不合并诊断和管理路由；其认证仍由原会话中间件执行。
        let mut routes = sdp_http::routes(endpoint.clone());
        if let Some(ice) = &self.ice {
            routes = routes.layer(Extension(ice.clone()));
        }
        Ok(routes
            .layer(DefaultBodyLimit::max(64 * 1024))
            .layer(tower_http::timeout::TimeoutLayer::with_status_code(
                StatusCode::REQUEST_TIMEOUT,
                Duration::from_secs(8),
            ))
            .layer(middleware::from_fn_with_state(policy, boundary))
            .with_state(endpoint))
    }

    pub async fn serve(
        self,
        listener: tokio::net::TcpListener,
        app: Router,
        shutdown: impl Future<Output = ()>,
    ) -> io::Result<()> {
        vs_tls::serve_https(self.tls, listener, app, shutdown).await
    }
}

struct SignalingBoundary {
    authority: String,
    origins: Vec<String>,
}

async fn boundary(
    State(policy): State<Arc<SignalingBoundary>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if headers.get_all(header::HOST).iter().count() != 1
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(policy.authority.as_str())
        || headers.get_all(header::ORIGIN).iter().count() > 1
        || headers.contains_key(header::ORIGIN)
            && !origin.is_some_and(|origin| policy.origins.iter().any(|allowed| allowed == origin))
        || origin.is_none()
            && headers
                .get("sec-fetch-site")
                .is_some_and(|value| value != "none" && value != "same-origin")
    {
        return (StatusCode::FORBIDDEN, "信令主机或浏览器来源不在允许范围").into_response();
    }
    let origin = origin.map(str::to_owned);
    let mut response = next.run(request).await;
    if matches!(
        response.status(),
        StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::PAYLOAD_TOO_LARGE
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
    ) {
        response = (response.status(), "信令请求格式、类型或正文大小不符合契约").into_response();
    }
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert(header::VARY, "Origin".parse().unwrap());
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.parse().unwrap());
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Location, ETag, Accept-Patch, X-VS-Session-Lease, Link, X-VS-ICE-Expires"
                .parse()
                .unwrap(),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get};
    use tower::ServiceExt;

    #[test]
    fn exact_origin_validation_rejects_wildcards_credentials_paths_and_insecure_remote_hosts() {
        for origin in [
            "https://app.example",
            "https://app.example:8443",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(valid_origin(origin), "{origin}");
        }
        for origin in [
            "*",
            "null",
            "http://app.example",
            "https://app.example/",
            "https://user@app.example",
            "https://app.example?a=1",
            "https://app.example#x",
            "https://app.example/path",
            "https://app.example:443",
        ] {
            assert!(!valid_origin(origin), "{origin}");
        }
    }

    #[tokio::test]
    async fn browser_origin_cannot_be_forged_by_forwarded_headers_or_fetch_metadata() {
        let policy = Arc::new(SignalingBoundary {
            authority: "media.signal.test:7443".into(),
            origins: vec!["https://app.example".into()],
        });
        let app = Router::new()
            .route("/whip", get(|| async { StatusCode::NO_CONTENT }))
            .layer(middleware::from_fn_with_state(policy, boundary));
        for (host, origin, site, status) in [
            (
                "media.signal.test:7443",
                Some("https://app.example"),
                Some("cross-site"),
                StatusCode::NO_CONTENT,
            ),
            ("media.signal.test:7443", None, None, StatusCode::NO_CONTENT),
            (
                "media.signal.test:7443",
                None,
                Some("cross-site"),
                StatusCode::FORBIDDEN,
            ),
            (
                "media.signal.test:7443",
                Some("https://evil.example"),
                Some("same-origin"),
                StatusCode::FORBIDDEN,
            ),
            (
                "127.0.0.1:7443",
                Some("https://app.example"),
                None,
                StatusCode::FORBIDDEN,
            ),
        ] {
            let mut request = axum::http::Request::builder()
                .uri("/whip")
                .header(header::HOST, host)
                .header("x-forwarded-host", "media.signal.test:7443")
                .header("x-forwarded-proto", "https");
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            if let Some(site) = site {
                request = request.header("sec-fetch-site", site);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            if status == StatusCode::NO_CONTENT {
                assert_eq!(
                    response
                        .headers()
                        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                        .and_then(|v| v.to_str().ok()),
                    origin
                );
            }
        }
    }
}
