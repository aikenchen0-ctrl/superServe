// SPDX-License-Identifier: MIT
// 改编atm0s的SDP创建、资源地址、删除和增量候选命令结构；鉴权和预算由本项目维护。
// Copyright (c) 2023 8xFF
use std::sync::Arc;

use axum::{
    Extension, Router,
    body::Bytes,
    extract::{Path, Request, State, rejection::BytesRejection},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use str0m::change::SdpOffer;
use vs_live::{PeerRole, SessionGrant, access::AccessError};

use crate::{WebState, error};

pub fn routes(state: Arc<WebState>) -> Router<Arc<WebState>> {
    let mut routes = Router::new()
        .route("/whip", get(empty).post(publish).options(endpoint_options))
        .route(
            "/whep",
            get(empty).post(subscribe).options(endpoint_options),
        )
        .route(
            "/whip/sessions/{id}",
            get(inspect_publisher)
                .patch(trickle_publisher)
                .delete(remove_publisher)
                .options(session_options),
        )
        .route(
            "/whep/sessions/{id}",
            get(inspect_subscriber)
                .patch(trickle_subscriber)
                .delete(remove_subscriber)
                .options(session_options),
        );
    if state.access.is_some() {
        routes = routes.merge(
            Router::new()
                .route(
                    "/whip/sessions/{id}/renew",
                    post(renew_publisher).options(renew_options),
                )
                .route(
                    "/whep/sessions/{id}/renew",
                    post(renew_subscriber).options(renew_options),
                ),
        );
    }
    routes.route_layer(middleware::from_fn_with_state(state, authorize))
}

async fn renew_options() -> Response {
    (
        [
            (header::ALLOW, "POST, OPTIONS"),
            (header::ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS"),
            (header::ACCESS_CONTROL_ALLOW_HEADERS, "Authorization"),
        ],
        "",
    )
        .into_response()
}

async fn renew_publisher(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    grant: Extension<SessionGrant>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    renew(&state, &id, PeerRole::Publisher, grant.0, body).await
}

async fn renew_subscriber(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    grant: Extension<SessionGrant>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    renew(&state, &id, PeerRole::Subscriber, grant.0, body).await
}

async fn renew(
    state: &WebState,
    id: &str,
    role: PeerRole,
    grant: SessionGrant,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match body {
        Ok(body) if body.is_empty() => {}
        Ok(_) => return (StatusCode::BAD_REQUEST, "续权请求正文必须为空").into_response(),
        Err(reason) => return (reason.status(), "续权正文读取失败").into_response(),
    }
    match state.relay.renew(id, role, grant).await {
        Ok(reply) => (StatusCode::OK, axum::Json(reply)).into_response(),
        Err(reason) => error(reason),
    }
}

async fn authorize(
    State(state): State<Arc<WebState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let endpoint = matches!(request.uri().path(), "/whip" | "/whep");
    let ice = request
        .extensions()
        .get::<Arc<crate::client_ice::ClientIce>>()
        .cloned();
    // 预检只核对浏览器来源与方法，不读取或签发TURN凭据。
    let preflight = request
        .headers()
        .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
        || request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_HEADERS);
    let discovery = endpoint && request.method() == Method::OPTIONS && !preflight && ice.is_some();
    if request.method() == Method::OPTIONS && !discovery
        || endpoint && matches!(*request.method(), Method::GET | Method::HEAD)
        || state.access.is_none()
    {
        return next.run(request).await;
    }
    let role = if request.uri().path().starts_with("/whip") {
        PeerRole::Publisher
    } else {
        PeerRole::Subscriber
    };
    let mut headers = request.headers().get_all(header::AUTHORIZATION).iter();
    let token = headers
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let Some(token) = token.filter(|_| headers.next().is_none()) else {
        return error(vs_live::RelayError::Denied);
    };
    match state
        .access
        .as_ref()
        .unwrap()
        .authenticate(token.to_owned(), role)
        .await
    {
        Ok(grant) => {
            if discovery && let Err(reason) = state.relay.check_access(grant.clone()).await {
                return error(reason);
            }
            let expose = discovery || endpoint && request.method() == Method::POST;
            if expose
                && let Some(ice) = &ice
                && let Err(reason) = ice.check()
            {
                return error(reason);
            }
            request.extensions_mut().insert(grant.clone());
            let mut response = next.run(request).await;
            if expose
                && response.status().is_success()
                && let Some(ice) = ice
            {
                // 请求正文或处理器可能跨过到期、撤权或房间切换；返回凭据前重新询问原权威。
                let authorized = if discovery {
                    state.relay.check_access(grant.clone()).await
                } else {
                    let protocol = if role == PeerRole::Publisher {
                        "whip"
                    } else {
                        "whep"
                    };
                    let prefix =
                        format!("{}{}/{protocol}/sessions/", state.origin, state.base_path);
                    let id = response
                        .headers()
                        .get(header::LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.strip_prefix(&prefix))
                        .filter(|id| id.len() == 22 && vs_core::valid_id(id));
                    match id {
                        Some(id) => match state.relay.exists_owned(id, role, grant.clone()).await {
                            Ok(true) => Ok(()),
                            Ok(false) => Err(vs_live::RelayError::NotFound),
                            Err(reason) => Err(reason),
                        },
                        None => Err(vs_live::RelayError::Unavailable),
                    }
                };
                if let Err(reason) = authorized.and_then(|_| ice.check()) {
                    return error(reason);
                }
                ice.append(response.headers_mut(), grant.expires_unix_seconds);
            }
            response
        }
        Err(AccessError::Denied) => error(vs_live::RelayError::Denied),
        Err(AccessError::Busy) => error(vs_live::RelayError::Busy),
        Err(AccessError::Unavailable) => error(vs_live::RelayError::Unavailable),
    }
}

async fn empty() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn endpoint_options() -> Response {
    (
        [
            (header::ALLOW, "GET, HEAD, POST, OPTIONS"),
            (
                header::ACCESS_CONTROL_ALLOW_METHODS,
                "GET, HEAD, POST, OPTIONS",
            ),
            (
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                "Content-Type, Authorization",
            ),
            (
                header::HeaderName::from_static("accept-post"),
                "application/sdp",
            ),
        ],
        "",
    )
        .into_response()
}

async fn session_options() -> Response {
    (
        [
            (header::ALLOW, "GET, HEAD, PATCH, DELETE, OPTIONS"),
            (
                header::ACCESS_CONTROL_ALLOW_METHODS,
                "GET, HEAD, PATCH, DELETE, OPTIONS",
            ),
            (
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                "Content-Type, If-Match, Authorization",
            ),
            (
                header::HeaderName::from_static("accept-patch"),
                "application/trickle-ice-sdpfrag",
            ),
        ],
        "",
    )
        .into_response()
}

async fn publish(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    grant: Option<Extension<SessionGrant>>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    create(
        &state,
        PeerRole::Publisher,
        headers,
        body,
        grant.map(|Extension(grant)| grant),
    )
    .await
}

async fn subscribe(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    grant: Option<Extension<SessionGrant>>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    create(
        &state,
        PeerRole::Subscriber,
        headers,
        body,
        grant.map(|Extension(grant)| grant),
    )
    .await
}

async fn create(
    state: &WebState,
    role: PeerRole,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
    grant: Option<SessionGrant>,
) -> Response {
    let sdp_type = headers.get_all(header::CONTENT_TYPE).iter().count() == 1
        && headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<mime::Mime>().ok())
            .is_some_and(|value| value.essence_str() == "application/sdp");
    if !sdp_type {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "协商正文必须为application/sdp",
        )
            .into_response();
    }
    let body = match body {
        Ok(body) => body,
        Err(reason) => return (reason.status(), "协商正文读取失败或超出64KiB").into_response(),
    };
    let Some(offer) = std::str::from_utf8(&body)
        .ok()
        .and_then(|text| SdpOffer::from_sdp_string(text).ok())
    else {
        return (StatusCode::BAD_REQUEST, "SDP协商正文无效").into_response();
    };
    // mDNS候选可能不保留为IP；完整ICE客户端仍可向服务端候选发起检查，不在HTTP层误拒绝。
    let outcome = if let Some(grant) = grant {
        state.relay.offer_authorized(role, offer, grant).await
    } else if state.access.is_some() {
        return error(vs_live::RelayError::Denied);
    } else {
        state.relay.offer(role, offer).await
    };
    match outcome {
        Ok(reply) => {
            let protocol = match role {
                PeerRole::Publisher => "whip",
                PeerRole::Subscriber => "whep",
            };
            // 只处理固定上游的序列化结果，为每个媒体节标记候选齐备；输入仍由str0m解析。
            let mut answer = String::new();
            let mut in_media = false;
            for line in reply.answer.to_sdp_string().lines() {
                if line == "a=end-of-candidates" {
                    continue;
                }
                if line.starts_with("m=") {
                    if in_media {
                        answer.push_str("a=end-of-candidates\r\n");
                    }
                    in_media = true;
                }
                answer.push_str(line);
                answer.push_str("\r\n");
            }
            answer.push_str("a=end-of-candidates\r\n");
            (
                StatusCode::CREATED,
                [
                    (header::CONTENT_TYPE, "application/sdp".to_owned()),
                    (header::ETAG, format!("\"{}\"", reply.id)),
                    (
                        header::HeaderName::from_static("accept-patch"),
                        "application/trickle-ice-sdpfrag".to_owned(),
                    ),
                    (
                        header::LOCATION,
                        format!(
                            "{}{}/{protocol}/sessions/{}",
                            state.origin, state.base_path, reply.id
                        ),
                    ),
                    (
                        header::HeaderName::from_static("x-vs-session-lease"),
                        reply.lease_seconds.to_string(),
                    ),
                ],
                answer,
            )
                .into_response()
        }
        Err(reason) => error(reason),
    }
}

async fn trickle_publisher(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    grant: Option<Extension<SessionGrant>>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    trickle(&state, &id, PeerRole::Publisher, headers, grant, body).await
}

async fn trickle_subscriber(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    grant: Option<Extension<SessionGrant>>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    trickle(&state, &id, PeerRole::Subscriber, headers, grant, body).await
}

async fn trickle(
    state: &WebState,
    id: &str,
    role: PeerRole,
    headers: HeaderMap,
    grant: Option<Extension<SessionGrant>>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if headers.get_all(header::CONTENT_TYPE).iter().count() != 1
        || headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<mime::Mime>().ok())
            .is_none_or(|value| value.essence_str() != "application/trickle-ice-sdpfrag")
    {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "候选正文必须为application/trickle-ice-sdpfrag",
        )
            .into_response();
    }
    if headers.get_all(header::IF_MATCH).iter().count() != 1 {
        return (
            StatusCode::PRECONDITION_REQUIRED,
            "候选请求必须携带单一If-Match",
        )
            .into_response();
    }
    let Some(etag) = headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 128)
    else {
        return error(vs_live::RelayError::Precondition);
    };
    let body = match body {
        Ok(body) if body.len() <= vs_live::ice::MAX_FRAGMENT_BYTES => body,
        Ok(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "候选片段超过8KiB").into_response(),
        Err(reason) => return (reason.status(), "候选正文读取失败").into_response(),
    };
    let fragment = match std::str::from_utf8(&body)
        .ok()
        .and_then(|text| vs_live::ice::IceFragment::parse(text).ok())
    {
        Some(fragment) => fragment,
        None => {
            return (StatusCode::BAD_REQUEST, "候选片段无效或不属于UDP地址候选").into_response();
        }
    };
    let outcome = state
        .relay
        .trickle(id, role, grant.map(|grant| grant.0), etag.into(), fragment)
        .await;
    match outcome {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(reason) => error(reason),
    }
}

async fn inspect_publisher(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    grant: Option<Extension<SessionGrant>>,
) -> Response {
    session(&state, &id, PeerRole::Publisher, false, grant).await
}

async fn inspect_subscriber(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    grant: Option<Extension<SessionGrant>>,
) -> Response {
    session(&state, &id, PeerRole::Subscriber, false, grant).await
}

async fn remove_publisher(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    grant: Option<Extension<SessionGrant>>,
) -> Response {
    session(&state, &id, PeerRole::Publisher, true, grant).await
}

async fn remove_subscriber(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    grant: Option<Extension<SessionGrant>>,
) -> Response {
    session(&state, &id, PeerRole::Subscriber, true, grant).await
}

async fn session(
    state: &WebState,
    id: &str,
    role: PeerRole,
    remove: bool,
    grant: Option<Extension<SessionGrant>>,
) -> Response {
    let outcome = if let Some(Extension(grant)) = grant {
        if remove {
            state.relay.remove_owned(id, role, grant).await
        } else {
            state.relay.exists_owned(id, role, grant).await
        }
    } else if state.access.is_some() {
        return error(vs_live::RelayError::Denied);
    } else if remove {
        state.relay.remove_for_role(id, role).await
    } else {
        state.relay.exists(id, role).await
    };
    match outcome {
        Ok(true) if remove => StatusCode::OK.into_response(),
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, "实时媒体会话不存在").into_response(),
        Err(reason) => error(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };
    use serde_json::{Value, json};
    use std::time::Instant;
    use std::time::{SystemTime, UNIX_EPOCH};
    use str0m::{
        Candidate, Output, Rtc,
        change::SdpAnswer,
        media::{Direction, MediaKind},
    };
    use tower::ServiceExt;
    use vs_live::access::{AccessKey, LiveAccess, LiveAccessConfig, TOKEN_TYPE};

    fn fragment_from_offer(text: &str) -> String {
        let parsed = SdpOffer::from_sdp_string(text).unwrap();
        let media = &parsed.media_lines[0];
        let credentials = media
            .ice_creds()
            .or_else(|| parsed.session.ice_creds())
            .unwrap();
        format!(
            "a=ice-ufrag:{}\r\na=ice-pwd:{}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:{}\r\na=candidate:1 1 UDP 2130706431 127.0.0.1 32000 typ host\r\n",
            credentials.ufrag,
            credentials.pass,
            media.mid()
        )
    }

    async fn patch(
        app: &Router,
        resource: &str,
        etag: Option<&str>,
        token: Option<&str>,
        content_type: &str,
        body: &str,
    ) -> Response {
        let mut request = Request::builder()
            .method("PATCH")
            .uri(resource)
            .header("host", "127.0.0.1:32100")
            .header("content-type", content_type);
        if let Some(etag) = etag {
            request = request.header("if-match", etag);
        }
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        app.clone()
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn trickle_http_enforces_generation_type_budget_restart_and_resource_lifetime() {
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = app(relay.clone());
        let offer = offer(Direction::SendOnly, false);
        let response = request(
            &app,
            "POST",
            "/whip",
            "application/sdp",
            Body::from(offer.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response.headers()["accept-patch"],
            "application/trickle-ice-sdpfrag"
        );
        let resource = response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .strip_prefix("http://127.0.0.1:32100")
            .unwrap()
            .to_string();
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();
        let fragment = fragment_from_offer(&offer);
        for _ in 0..2 {
            assert_eq!(
                patch(
                    &app,
                    &resource,
                    Some(&etag),
                    None,
                    "application/trickle-ice-sdpfrag",
                    &fragment
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
        }
        for (tag, kind, text, expected) in [
            (
                None,
                "application/trickle-ice-sdpfrag",
                fragment.clone(),
                StatusCode::PRECONDITION_REQUIRED,
            ),
            (
                Some("\"stale\""),
                "application/trickle-ice-sdpfrag",
                fragment.clone(),
                StatusCode::PRECONDITION_FAILED,
            ),
            (
                Some(&etag),
                "application/sdp",
                fragment.clone(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                Some(&etag),
                "application/trickle-ice-sdpfrag",
                "a".repeat(8193),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            (
                Some(&etag),
                "application/trickle-ice-sdpfrag",
                "invalid".into(),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            assert_eq!(
                patch(&app, &resource, tag, None, kind, &text)
                    .await
                    .status(),
                expected
            );
        }
        let restart = fragment.replace("a=ice-ufrag:", "a=ice-ufrag:restart");
        assert_eq!(
            patch(
                &app,
                &resource,
                Some(&etag),
                None,
                "application/trickle-ice-sdpfrag",
                &restart
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let wrong_role = resource.replacen("/whip/", "/whep/", 1);
        assert_eq!(
            patch(
                &app,
                &wrong_role,
                Some(&etag),
                None,
                "application/trickle-ice-sdpfrag",
                &fragment
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(relay.stats().unwrap().accepted_sessions, 1);
        request(&app, "DELETE", &resource, "text/plain", Body::empty()).await;
        assert_eq!(
            patch(
                &app,
                &resource,
                Some(&etag),
                None,
                "application/trickle-ice-sdpfrag",
                &fragment
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn trickle_http_reuses_verified_owner_and_does_not_bypass_live_credentials() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay.clone());
        let alice = issuer.sign(&issuer.claims("alice", PeerRole::Publisher, 120));
        let bob = issuer.sign(&issuer.claims("bob", PeerRole::Publisher, 120));
        let offer = offer(Direction::SendOnly, false);
        let response = authorized(&app, "POST", "/whip", &alice, Body::from(offer.clone())).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let resource = response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .strip_prefix("http://127.0.0.1:32100")
            .unwrap()
            .to_string();
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();
        let fragment = fragment_from_offer(&offer);
        assert_eq!(
            patch(
                &app,
                &resource,
                Some(&etag),
                None,
                "application/trickle-ice-sdpfrag",
                &fragment
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            patch(
                &app,
                &resource,
                Some(&etag),
                Some(&bob),
                "application/trickle-ice-sdpfrag",
                &fragment
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            patch(
                &app,
                &resource,
                Some(&etag),
                Some(&alice),
                "application/trickle-ice-sdpfrag",
                &fragment
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        worker.shutdown().unwrap();
    }

    struct Issuer {
        key: Ed25519KeyPair,
        access: Arc<LiveAccess>,
    }

    impl Issuer {
        fn new() -> Self {
            let bytes = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
            let key = Ed25519KeyPair::from_pkcs8(bytes.as_ref()).unwrap();
            let access = Arc::new(
                LiveAccess::new(LiveAccessConfig {
                    issuer: "https://live-test.invalid".into(),
                    audience: "live".into(),
                    tenant_id: "tenant-a".into(),
                    room_id: "room-a".into(),
                    node_id: "node-a".into(),
                    keys: vec![AccessKey {
                        kid: "test-key".into(),
                        public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
                    }],
                })
                .unwrap(),
            );
            Self { key, access }
        }

        fn claims(&self, subject: &str, role: PeerRole, lifetime: u64) -> Value {
            let at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let binding = self.access.binding();
            json!({
                "iss":"https://live-test.invalid","aud":"live","sub":subject,
                "iat":at,"nbf":at,"exp":at+lifetime,"role":role,
                "tenant_id":binding.tenant_id,"room_id":binding.room_id,
                "node_id":binding.node_id,"incarnation":binding.incarnation
            })
        }

        fn sign_header(&self, claims: &Value, header: &Value) -> String {
            let input = format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(header).unwrap()),
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap())
            );
            format!(
                "{input}.{}",
                URL_SAFE_NO_PAD.encode(self.key.sign(input.as_bytes()).as_ref())
            )
        }

        fn sign(&self, claims: &Value) -> String {
            self.sign_header(
                claims,
                &json!({"alg":"EdDSA","typ":TOKEN_TYPE,"kid":"test-key"}),
            )
        }

        fn app(&self, relay: vs_live::Relay) -> Router {
            crate::router(Arc::new(WebState {
                relay,
                authority: "127.0.0.1:32100".into(),
                origin: "http://127.0.0.1:32100".into(),
                base_path: String::new(),
                access: Some(self.access.clone()),
                room_control: None,
            }))
        }
    }

    async fn authorized(
        app: &Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Body,
    ) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("host", "127.0.0.1:32100")
                    .header("content-type", "application/sdp")
                    .header("authorization", format!("Bearer {token}"))
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn authorized_create(
        app: &Router,
        endpoint: &str,
        token: &str,
        direction: Direction,
    ) -> String {
        let response = authorized(
            app,
            "POST",
            endpoint,
            token,
            Body::from(offer(direction, true)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .strip_prefix("http://127.0.0.1:32100")
            .unwrap()
            .into()
    }

    fn ice_for_test() -> Arc<crate::client_ice::ClientIce> {
        Arc::new(
            crate::client_ice::ClientIce::load(crate::client_ice::ClientIceConfig {
                expires_unix_seconds: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
                    + 120,
                servers: vec![crate::client_ice::IceServer {
                    url: "turn:127.0.0.1:3478?transport=udp".into(),
                    username: "test-user".into(),
                    credential: "test-password-with-at-least-32-bytes".into(),
                }],
            })
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn ice_discovery_separates_preflight_from_role_fence_and_revocation() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start_guarded().unwrap();
        relay.activate(3).await.unwrap();
        let app = issuer.app(relay.clone()).layer(Extension(ice_for_test()));
        let mut claims = issuer.claims("alice", PeerRole::Publisher, 120);
        claims["assignment_revision"] = json!(3);
        let token = issuer.sign(&claims);
        for (endpoint, token, expected) in [
            ("/whip", "", StatusCode::UNAUTHORIZED),
            ("/whep", token.as_str(), StatusCode::UNAUTHORIZED),
            ("/whip", token.as_str(), StatusCode::OK),
        ] {
            let response = authorized(&app, "OPTIONS", endpoint, token, Body::empty()).await;
            assert_eq!(response.status(), expected);
            assert_eq!(
                response.headers().contains_key(header::LINK),
                expected == StatusCode::OK
            );
            if expected == StatusCode::OK {
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            }
        }
        let preflight = Request::builder()
            .method("OPTIONS")
            .uri("/whip")
            .header("host", "127.0.0.1:32100")
            .header("origin", "http://127.0.0.1:32100")
            .header("access-control-request-method", "OPTIONS")
            .header("access-control-request-headers", "authorization")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(preflight).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key(header::LINK));
        assert!(!response.headers().contains_key("x-vs-ice-expires"));
        let mut stale = claims.clone();
        stale["assignment_revision"] = json!(2);
        let response = authorized(
            &app,
            "OPTIONS",
            "/whip",
            &issuer.sign(&stale),
            Body::empty(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(!response.headers().contains_key(header::LINK));
        let grant = issuer
            .access
            .authenticate(token.clone(), PeerRole::Publisher)
            .await
            .unwrap();
        relay.revoke(3, grant).await.unwrap();
        let response = authorized(&app, "OPTIONS", "/whip", &token, Body::empty()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!response.headers().contains_key(header::LINK));
        assert_eq!(relay.stats().unwrap().active_peers, 0);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn ice_links_only_accompany_live_creation_and_not_resource_reads_or_errors() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay.clone()).layer(Extension(ice_for_test()));
        let publisher = issuer.sign(&issuer.claims("alice", PeerRole::Publisher, 120));
        let bob = issuer.sign(&issuer.claims("bob", PeerRole::Subscriber, 120));
        let carol = issuer.sign(&issuer.claims("carol", PeerRole::Subscriber, 120));
        let response = authorized(
            &app,
            "POST",
            "/whip",
            &publisher,
            Body::from(offer(Direction::SendOnly, true)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(response.headers().contains_key(header::LINK));
        let response = authorized(
            &app,
            "POST",
            "/whep",
            &bob,
            Body::from(offer(Direction::RecvOnly, true)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(response.headers().contains_key(header::LINK));
        let resource = response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .strip_prefix("http://127.0.0.1:32100")
            .unwrap()
            .to_string();
        for (method, uri, token, expected) in [
            (
                "GET",
                resource.as_str(),
                bob.as_str(),
                StatusCode::NO_CONTENT,
            ),
            (
                "GET",
                resource.as_str(),
                carol.as_str(),
                StatusCode::NOT_FOUND,
            ),
            ("OPTIONS", resource.as_str(), "", StatusCode::OK),
            ("POST", "/whip", publisher.as_str(), StatusCode::BAD_REQUEST),
        ] {
            let response = authorized(&app, method, uri, token, Body::from("invalid")).await;
            assert_eq!(response.status(), expected);
            assert!(!response.headers().contains_key(header::LINK));
        }
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn ice_response_rechecks_actual_resource_owner_and_revocation_after_handler() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start_guarded().unwrap();
        relay.activate(3).await.unwrap();
        let scoped = |subject: &str, role| {
            let mut claims = issuer.claims(subject, role, 120);
            claims["assignment_revision"] = json!(3);
            issuer.sign(&claims)
        };
        let original = issuer.app(relay.clone());
        let publisher = scoped("alice", PeerRole::Publisher);
        authorized_create(&original, "/whip", &publisher, Direction::SendOnly).await;
        let bob = scoped("bob", PeerRole::Subscriber);
        let resource = authorized_create(&original, "/whep", &bob, Direction::RecvOnly).await;
        let state = Arc::new(WebState {
            relay: relay.clone(),
            authority: "127.0.0.1:32100".into(),
            origin: "http://127.0.0.1:32100".into(),
            base_path: String::new(),
            access: Some(issuer.access.clone()),
            room_control: None,
        });
        let location = format!("http://127.0.0.1:32100{resource}");
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let app = Router::new()
            .route(
                "/whep",
                post({
                    let started = started.clone();
                    let release = release.clone();
                    move || {
                        let location = location.clone();
                        let started = started.clone();
                        let release = release.clone();
                        async move {
                            started.notify_one();
                            release.notified().await;
                            (StatusCode::CREATED, [(header::LOCATION, location)])
                        }
                    }
                }),
            )
            .route_layer(middleware::from_fn_with_state(state.clone(), authorize))
            .layer(Extension(ice_for_test()))
            .with_state(state);
        // 即使处理器错误返回另一个主体的Location，也不能随成功状态泄漏凭据。
        let carol = scoped("carol", PeerRole::Subscriber);
        release.notify_one();
        let response = authorized(&app, "POST", "/whep", &carol, Body::empty()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!response.headers().contains_key(header::LINK));
        let _ = started.notified().await;
        let request_app = app.clone();
        let request_token = bob.clone();
        let task = tokio::spawn(async move {
            authorized(&request_app, "POST", "/whep", &request_token, Body::empty()).await
        });
        started.notified().await;
        let grant = issuer
            .access
            .authenticate(bob, PeerRole::Subscriber)
            .await
            .unwrap();
        relay.revoke(3, grant).await.unwrap();
        release.notify_one();
        let response = task.await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!response.headers().contains_key(header::LINK));
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn live_credentials_reject_cross_scope_type_headers_and_invalid_signatures() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay.clone());
        let claims = issuer.claims("alice", PeerRole::Publisher, 120);
        for (field, value) in [
            ("iss", json!("https://other.invalid")),
            ("aud", json!("consumption")),
            ("sub", json!("")),
            ("tenant_id", json!("other-tenant")),
            ("room_id", json!("other-room")),
            ("node_id", json!("other-node")),
            ("incarnation", json!("old-process")),
            ("role", json!("subscriber")),
            ("exp", json!(1)),
            ("nbf", json!(claims["exp"].as_u64().unwrap() + 1)),
            ("iat", json!(claims["exp"].as_u64().unwrap() + 1)),
            ("exp", json!(claims["iat"].as_u64().unwrap() + 301)),
            ("unknown_claim", json!(true)),
        ] {
            let mut changed = claims.clone();
            changed[field] = value;
            assert_eq!(
                authorized(
                    &app,
                    "POST",
                    "/whip",
                    &issuer.sign(&changed),
                    Body::from("invalid")
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED,
                "{field}"
            );
        }
        for header in [
            json!({"alg":"HS256","kid":"test-key","typ":TOKEN_TYPE}),
            json!({"alg":"EdDSA","kid":"test-key","typ":"vs-consumption+jwt"}),
            json!({"alg":"EdDSA","kid":"missing-key","typ":TOKEN_TYPE}),
            json!({"alg":"EdDSA","kid":"test-key","typ":TOKEN_TYPE,"jku":"https://evil.invalid/key"}),
        ] {
            assert_eq!(
                authorized(
                    &app,
                    "POST",
                    "/whip",
                    &issuer.sign_header(&claims, &header),
                    Body::empty()
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let mut token = issuer.sign(&claims);
        let signature = token.rfind('.').unwrap() + 1;
        token.replace_range(
            signature..signature + 1,
            if &token[signature..signature + 1] == "A" {
                "B"
            } else {
                "A"
            },
        );
        assert_eq!(
            authorized(&app, "POST", "/whip", &token, Body::empty())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, "POST", "/whip", "application/sdp", Body::empty())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for path in ["/lab/offer/publisher", "/lab/peers/missing"] {
            assert_eq!(
                request(&app, "POST", path, "application/json", Body::empty())
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(relay.stats().unwrap().accepted_sessions, 0);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn live_session_resources_require_the_owner_and_correct_role() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay);
        let alice = issuer.sign(&issuer.claims("alice", PeerRole::Publisher, 120));
        let bob = issuer.sign(&issuer.claims("bob", PeerRole::Subscriber, 120));
        let carol = issuer.sign(&issuer.claims("carol", PeerRole::Subscriber, 120));
        let publisher = authorized_create(&app, "/whip", &alice, Direction::SendOnly).await;
        let viewer = authorized_create(&app, "/whep", &bob, Direction::RecvOnly).await;
        for method in ["GET", "DELETE"] {
            assert_eq!(
                authorized(&app, method, &viewer, &carol, Body::empty())
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
            assert_eq!(
                authorized(&app, method, &viewer, &alice, Body::empty())
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            authorized(&app, "GET", &viewer, &bob, Body::empty())
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            authorized(&app, "DELETE", &viewer, &bob, Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            authorized(&app, "GET", &publisher, &alice, Body::empty())
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn renewal_http_reuses_verified_grants_and_never_recreates_removed_sessions() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay.clone());
        let original = issuer.claims("alice", PeerRole::Publisher, 120);
        let old = issuer.sign(&original);
        let publisher = authorized_create(&app, "/whip", &old, Direction::SendOnly).await;
        let endpoint = format!("{publisher}/renew");
        let mut claims = original.clone();
        claims["exp"] = json!(original["exp"].as_u64().unwrap() + 30);
        let new = issuer.sign(&claims);
        assert_eq!(
            request(&app, "POST", &endpoint, "text/plain", Body::empty())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let stranger = issuer.sign(&issuer.claims("bob", PeerRole::Publisher, 150));
        assert_eq!(
            authorized(&app, "POST", &endpoint, &stranger, Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            authorized(&app, "POST", &endpoint, &new, Body::from("invalid"))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let response = authorized(&app, "POST", &endpoint, &new, Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let reply: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(reply["expires_unix_seconds"], claims["exp"]);
        assert!(reply["lease_milliseconds"].as_u64().unwrap() <= 60000);
        assert_eq!(
            authorized(&app, "POST", &endpoint, &new, Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            authorized(&app, "POST", &endpoint, &old, Body::empty())
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(relay.stats().unwrap().accepted_sessions, 1);
        assert_eq!(
            authorized(&app, "DELETE", &publisher, &new, Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            authorized(&app, "POST", &endpoint, &new, Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn internal_token_revocation_requires_control_identity_and_blocks_valid_signed_replays() {
        use vs_core::room_assignment::{MediaFence, MediaTarget};
        use vs_live::room_control::{RoomControl, RoomControlConfig};
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start_guarded().unwrap();
        relay.activate(3).await.unwrap();
        let secret = "revocation-control-secret-with-at-least-32-bytes";
        let control = Arc::new(
            RoomControl::new(RoomControlConfig {
                cluster_id: "cluster".into(),
                coordination_endpoints: vec!["http://127.0.0.1:1".into()],
                coordination_token: secret.into(),
                control_token: secret.into(),
                coordination_tls: None,
            })
            .unwrap(),
        );
        let binding = issuer.access.binding();
        let fence = MediaFence {
            cluster_id: "cluster".into(),
            tenant_id: binding.tenant_id.clone(),
            room_id: binding.room_id.clone(),
            target: MediaTarget {
                node_id: binding.node_id.clone(),
                incarnation: binding.incarnation.clone(),
            },
            revision: 3,
        };
        let app = crate::router(Arc::new(WebState {
            relay: relay.clone(),
            authority: "127.0.0.1:32100".into(),
            origin: "http://127.0.0.1:32100".into(),
            base_path: String::new(),
            access: Some(issuer.access.clone()),
            room_control: Some(control),
        }));
        let claims = |subject, role, lifetime| {
            let mut claims = issuer.claims(subject, role, lifetime);
            claims["assignment_revision"] = json!(3);
            issuer.sign(&claims)
        };
        let alice = claims("alice", PeerRole::Publisher, 120);
        let bob = claims("bob", PeerRole::Subscriber, 120);
        authorized_create(&app, "/whip", &alice, Direction::SendOnly).await;
        let viewer = authorized_create(&app, "/whep", &bob, Direction::RecvOnly).await;
        let body = json!({"fence": fence, "role": "subscriber", "token": bob});
        for (token, change, expected) in [
            (alice.as_str(), None, StatusCode::UNAUTHORIZED),
            (
                secret,
                Some(("role", json!("publisher"))),
                StatusCode::UNAUTHORIZED,
            ),
            (
                secret,
                Some((
                    "fence",
                    json!({"cluster_id":"other","tenant_id":binding.tenant_id,"room_id":binding.room_id,"target":fence.target,"revision":3}),
                )),
                StatusCode::CONFLICT,
            ),
            (secret, None, StatusCode::OK),
            (secret, None, StatusCode::OK),
        ] {
            let mut payload = body.clone();
            if let Some((field, value)) = change {
                payload[field] = value;
            }
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/admin/room/revoke-token")
                        .header("host", "127.0.0.1:32100")
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        for (method, endpoint, payload) in [
            ("GET", viewer.clone(), Body::empty()),
            ("DELETE", viewer.clone(), Body::empty()),
            ("POST", format!("{viewer}/renew"), Body::empty()),
            (
                "POST",
                "/whep".into(),
                Body::from(offer(Direction::RecvOnly, true)),
            ),
        ] {
            assert_eq!(
                authorized(&app, method, &endpoint, &bob, payload)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let dave = claims("dave", PeerRole::Subscriber, 120);
        let pending_token = dave.clone();
        let pending_app = app.clone();
        let sdp = offer(Direction::RecvOnly, true);
        let (started, observed) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let pending = tokio::spawn(async move {
            let stream = futures_util::stream::once(async move {
                started.send(()).unwrap();
                held.await.unwrap();
                Ok::<_, std::io::Error>(sdp)
            });
            authorized(
                &pending_app,
                "POST",
                "/whep",
                &pending_token,
                Body::from_stream(stream),
            )
            .await
        });
        observed.await.unwrap();
        let grant = issuer
            .access
            .authenticate(dave, PeerRole::Subscriber)
            .await
            .unwrap();
        relay.revoke(3, grant).await.unwrap();
        release.send(()).unwrap();
        assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let fresh = claims("bob", PeerRole::Subscriber, 180);
        authorized_create(&app, "/whep", &fresh, Direction::RecvOnly).await;
        assert_eq!(relay.stats().unwrap().accepted_sessions, 3);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn expiry_removes_only_the_expired_subscriber_and_rejects_replay() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay.clone());
        let alice = issuer.sign(&issuer.claims("alice", PeerRole::Publisher, 120));
        let bob = issuer.sign(&issuer.claims("bob", PeerRole::Subscriber, 2));
        let publisher = authorized_create(&app, "/whip", &alice, Direction::SendOnly).await;
        let viewer = authorized_create(&app, "/whep", &bob, Direction::RecvOnly).await;
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            loop {
                if relay.stats().unwrap().removed_sessions == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            authorized(&app, "GET", &viewer, &bob, Body::empty())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            authorized(&app, "GET", &publisher, &alice, Body::empty())
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        let replacement = issuer.sign(&issuer.claims("bob", PeerRole::Subscriber, 120));
        assert_eq!(
            authorized(&app, "GET", &viewer, &replacement, Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            authorized(
                &app,
                "POST",
                &format!("{viewer}/renew"),
                &replacement,
                Body::empty()
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(relay.stats().unwrap().active_peers, 1);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn publisher_expiry_tears_down_the_room_without_expiring_subscriber_credentials() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay.clone());
        let alice = issuer.sign(&issuer.claims("alice", PeerRole::Publisher, 2));
        let bob = issuer.sign(&issuer.claims("bob", PeerRole::Subscriber, 120));
        authorized_create(&app, "/whip", &alice, Direction::SendOnly).await;
        let viewer = authorized_create(&app, "/whep", &bob, Direction::RecvOnly).await;
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            loop {
                if relay.stats().unwrap().removed_sessions == 2 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            authorized(&app, "GET", &viewer, &bob, Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(relay.stats().unwrap().active_peers, 0);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn credential_expiring_while_reading_the_body_cannot_create_a_session() {
        let issuer = Issuer::new();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = issuer.app(relay.clone());
        let token = issuer.sign(&issuer.claims("alice", PeerRole::Publisher, 2));
        let sdp = offer(Direction::SendOnly, true);
        let stream = futures_util::stream::once(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            Ok::<_, std::io::Error>(sdp)
        });
        assert_eq!(
            authorized(&app, "POST", "/whip", &token, Body::from_stream(stream))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(relay.stats().unwrap().accepted_sessions, 0);
        worker.shutdown().unwrap();
    }

    fn app(relay: vs_live::Relay) -> Router {
        crate::router(Arc::new(WebState {
            relay,
            authority: "127.0.0.1:32100".into(),
            origin: "http://127.0.0.1:32100".into(),
            base_path: String::new(),
            access: None,
            room_control: None,
        }))
    }

    fn offer(direction: Direction, candidates: bool) -> String {
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .clear_codecs()
            .enable_vp8(true)
            .build(Instant::now());
        if candidates {
            rtc.add_local_candidate(
                Candidate::host("127.0.0.1:32000".parse().unwrap(), "udp").unwrap(),
            );
            while !matches!(rtc.poll_output().unwrap(), Output::Timeout(_)) {}
        }
        let mut changes = rtc.sdp_api();
        changes.add_media(MediaKind::Video, direction, None, None, None);
        let (offer, _) = changes.apply().unwrap();
        offer.to_sdp_string()
    }

    async fn request(
        app: &Router,
        method: &str,
        uri: &str,
        content_type: &str,
        body: Body,
    ) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("host", "127.0.0.1:32100")
                    .header("content-type", content_type)
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn create(app: &Router, endpoint: &str, direction: Direction) -> String {
        let response = request(
            app,
            "POST",
            endpoint,
            "application/sdp; charset=utf-8",
            Body::from(offer(direction, true)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/sdp");
        assert_eq!(response.headers()["x-vs-session-lease"], "60");
        let resource = response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .strip_prefix("http://127.0.0.1:32100")
            .unwrap()
            .to_owned();
        assert!(resource.starts_with(&format!("{endpoint}/sessions/")));
        assert_eq!(resource.rsplit('/').next().unwrap().len(), 22);
        let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        let answer = SdpAnswer::from_sdp_string(text).unwrap();
        assert_eq!(answer.media_lines.len(), 1);
        assert_eq!(
            answer.media_lines[0].direction(),
            if endpoint == "/whip" {
                Direction::RecvOnly
            } else {
                Direction::SendOnly
            }
        );
        assert!(answer.session.ice_lite());
        assert!(answer.media_lines[0].ice_candidates().next().is_some());
        assert!(answer.media_lines[0].end_of_candidates());
        assert!(text.contains("a=ice-options:trickle"));
        resource
    }

    #[tokio::test]
    async fn dual_track_http_answers_all_media_sections_and_reclaims_both_tracks_together() {
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = app(relay.clone());
        for (endpoint, direction) in [
            ("/whip", Direction::SendOnly),
            ("/whep", Direction::RecvOnly),
        ] {
            let mut rtc = Rtc::builder()
                .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
                .clear_codecs()
                .enable_h264(true)
                .enable_opus(true, false)
                .build(Instant::now());
            let mut changes = rtc.sdp_api();
            changes.add_media(MediaKind::Audio, direction, None, None, None);
            changes.add_media(MediaKind::Video, direction, None, None, None);
            let (offer, _) = changes.apply().unwrap();
            while !matches!(rtc.poll_output().unwrap(), Output::Timeout(_)) {}
            let response = request(
                &app,
                "POST",
                endpoint,
                "application/sdp",
                Body::from(offer.to_sdp_string()),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CREATED);
            let resource = response.headers()[header::LOCATION]
                .to_str()
                .unwrap()
                .strip_prefix("http://127.0.0.1:32100")
                .unwrap()
                .to_owned();
            let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
            let text = std::str::from_utf8(&bytes).unwrap();
            let answer = SdpAnswer::from_sdp_string(text).unwrap();
            assert_eq!(answer.media_lines.len(), 2);
            assert!(answer.media_lines.iter().all(|media| !media.disabled
                && media.end_of_candidates()
                && media.direction() == direction.invert()));
            assert!(text.contains("a=ice-options:trickle"));
            if endpoint == "/whep" {
                assert_eq!(
                    request(&app, "DELETE", &resource, "text/plain", Body::empty())
                        .await
                        .status(),
                    StatusCode::OK
                );
            }
        }
        assert_eq!(relay.stats().unwrap().accepted_sessions, 2);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn sdp_resources_enforce_direction_role_and_cascading_teardown() {
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = app(relay.clone());
        let publisher = create(&app, "/whip", Direction::SendRecv).await;
        let first = create(&app, "/whep", Direction::SendRecv).await;
        let second = create(&app, "/whep", Direction::RecvOnly).await;
        let wrong_role = first.replacen("/whep/", "/whip/", 1);
        for method in ["GET", "DELETE"] {
            assert_eq!(
                request(&app, method, &wrong_role, "text/plain", Body::empty())
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            request(
                &app,
                "PATCH",
                &first,
                "application/trickle-ice-sdpfrag",
                Body::from("invalid")
            )
            .await
            .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        for resource in [&publisher, &first, &second] {
            let response = request(&app, "GET", resource, "text/plain", Body::empty()).await;
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert!(to_bytes(response.into_body(), 1).await.unwrap().is_empty());
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(&first)
                    .header("host", "127.0.0.1:32100")
                    .header("if-match", "\"unrelated\"")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            request(&app, "GET", &second, "text/plain", Body::empty())
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            request(&app, "DELETE", &publisher, "text/plain", Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "GET", &second, "text/plain", Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(&app, "DELETE", &first, "text/plain", Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(relay.stats().unwrap().accepted_sessions, 3);
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn invalid_http_does_not_reserve_media_capacity() {
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let app = app(relay.clone());
        for (content_type, body, expected) in [
            (
                "application/json",
                Body::from("{}"),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "application/sdpx",
                Body::empty(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "application/sdp",
                Body::from(vec![255]),
                StatusCode::BAD_REQUEST,
            ),
            (
                "application/sdp",
                Body::from("invalid"),
                StatusCode::BAD_REQUEST,
            ),
            (
                "application/sdp",
                Body::from(vec![b'v'; 65537]),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            (
                "application/sdp",
                Body::from(offer(Direction::RecvOnly, true)),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            assert_eq!(
                request(&app, "POST", "/whip", content_type, body)
                    .await
                    .status(),
                expected
            );
        }
        assert_eq!(relay.stats().unwrap().accepted_sessions, 0);
        create(&app, "/whip", Direction::SendOnly).await;
        worker.shutdown().unwrap();
    }

    #[tokio::test]
    async fn mdns_or_missing_explicit_candidates_do_not_block_full_ice_clients() {
        for text in [
            offer(Direction::SendOnly, false),
            offer(Direction::SendOnly, true).replace("127.0.0.1 32000", "peer.local 32000"),
        ] {
            let parsed = SdpOffer::from_sdp_string(&text).unwrap();
            assert_eq!(parsed.media_lines[0].ice_candidates().count(), 0);
            let (relay, worker) = vs_live::Relay::start().unwrap();
            let response = request(
                &app(relay),
                "POST",
                "/whip",
                "application/sdp",
                Body::from(text),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CREATED);
            worker.shutdown().unwrap();
        }
    }

    #[tokio::test]
    async fn endpoint_discovery_and_old_process_resources_are_safe() {
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let first_app = app(relay);
        for endpoint in ["/whip", "/whep"] {
            let response =
                request(&first_app, "OPTIONS", endpoint, "text/plain", Body::empty()).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["accept-post"], "application/sdp");
            assert!(!response.headers().contains_key("accept-patch"));
            assert_eq!(
                request(&first_app, "GET", endpoint, "text/plain", Body::empty())
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
        let old = create(&first_app, "/whip", Direction::SendOnly).await;
        worker.shutdown().unwrap();
        let (relay, worker) = vs_live::Relay::start().unwrap();
        let next_app = app(relay);
        let current = create(&next_app, "/whip", Direction::SendOnly).await;
        assert_ne!(old, current);
        assert_eq!(
            request(&next_app, "DELETE", &old, "text/plain", Body::empty())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(&next_app, "GET", &current, "text/plain", Body::empty())
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        worker.shutdown().unwrap();
    }
}
