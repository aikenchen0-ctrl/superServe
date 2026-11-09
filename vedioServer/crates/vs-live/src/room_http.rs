use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use vs_core::room_assignment::{MediaControlReceipt, MediaFence, MediaPhase};
use vs_live::RelayError;
use vs_live::{PeerRole, access::AccessError};

use crate::{WebState, error};

pub fn routes(state: Arc<WebState>) -> Router<Arc<WebState>> {
    Router::new()
        .route("/admin/room/activate", post(activate))
        .route("/admin/room/drain", post(drain))
        .route("/admin/room/revoke-token", post(revoke_token))
        .route_layer(middleware::from_fn_with_state(state, authenticate))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TokenRevocation {
    pub(crate) fence: MediaFence,
    role: PeerRole,
    token: String,
}

async fn revoke_token(
    State(state): State<Arc<WebState>>,
    Json(request): Json<TokenRevocation>,
) -> Response {
    revoke(&state, request).await
}

pub(crate) async fn revoke(state: &WebState, request: TokenRevocation) -> Response {
    let (Some(control), Some(access)) = (&state.room_control, &state.access) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !control.matches(access.binding(), &request.fence) {
        return error(RelayError::Conflict);
    }
    let grant = match access.authenticate(request.token, request.role).await {
        Ok(grant) => grant,
        Err(AccessError::Denied) => return error(RelayError::Denied),
        Err(AccessError::Busy) => return error(RelayError::Busy),
        Err(AccessError::Unavailable) => return error(RelayError::Unavailable),
    };
    match state.relay.revoke(request.fence.revision, grant).await {
        Ok(reply) => Json(serde_json::json!({
            "fence": request.fence,
            "revoked_tokens": reply.revoked_tokens,
            "removed_sessions": reply.removed_sessions,
        }))
        .into_response(),
        Err(reason) => error(reason),
    }
}

pub(crate) async fn authenticate(
    State(state): State<Arc<WebState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(control) = &state.room_control else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut values = request.headers().get_all(header::AUTHORIZATION).iter();
    let token = values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if values.next().is_some()
        || request.headers().contains_key(header::ORIGIN)
        || !token.is_some_and(|token| control.authenticate(token))
    {
        return (StatusCode::UNAUTHORIZED, "房间控制凭据无效").into_response();
    }
    next.run(request).await
}

async fn activate(State(state): State<Arc<WebState>>, Json(fence): Json<MediaFence>) -> Response {
    operation(&state, fence, true).await
}

pub(crate) async fn drain(
    State(state): State<Arc<WebState>>,
    Json(fence): Json<MediaFence>,
) -> Response {
    operation(&state, fence, false).await
}

pub(crate) async fn operation(state: &WebState, fence: MediaFence, activate: bool) -> Response {
    let (Some(control), Some(access)) = (&state.room_control, &state.access) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !control.matches(access.binding(), &fence) {
        return error(RelayError::Conflict);
    }
    if activate && let Err(reason) = control.verify_activation(&fence).await {
        return error(reason);
    }
    let result = if activate {
        state.relay.activate(fence.revision).await
    } else {
        state.relay.drain_room(fence.revision).await
    };
    match result {
        Ok(active_peers) => Json(MediaControlReceipt {
            fence,
            phase: if activate {
                MediaPhase::Active
            } else {
                MediaPhase::Drained
            },
            active_peers,
        })
        .into_response(),
        Err(reason) => error(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, routing::get};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use tower::ServiceExt;
    use vs_core::room_assignment::{AssignmentRecord, AssignmentView, MediaTarget};
    use vs_live::{
        Relay,
        access::{AccessKey, LiveAccess, LiveAccessConfig},
        room_control::{RoomControl, RoomControlConfig},
    };

    #[tokio::test]
    async fn delayed_authority_response_cannot_reactivate_a_drained_revision() {
        let key = Ed25519KeyPair::from_seed_unchecked(&[17; 32]).unwrap();
        let access = Arc::new(
            LiveAccess::new(LiveAccessConfig {
                issuer: "https://test.invalid".into(),
                audience: "live".into(),
                tenant_id: "tenant".into(),
                room_id: "room".into(),
                node_id: "media".into(),
                keys: vec![AccessKey {
                    kid: "key".into(),
                    public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
                }],
            })
            .unwrap(),
        );
        let binding = access.binding();
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
        let view = AssignmentView {
            cluster_id: "cluster".into(),
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            record: Some(AssignmentRecord {
                revision: 3,
                owner: Some(fence.target.clone()),
            }),
        };
        let authority = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", authority.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                authority,
                Router::new().route(
                    "/v1/room-assignments/tenant/room",
                    get(move || {
                        let value = view.clone();
                        async move { Json(value) }
                    }),
                ),
            )
            .await
            .unwrap()
        });
        let secret = "test-control-token-with-at-least-32-bytes";
        let control = Arc::new(
            RoomControl::new(RoomControlConfig {
                cluster_id: "cluster".into(),
                coordination_endpoints: vec![endpoint],
                coordination_token: secret.into(),
                control_token: secret.into(),
                coordination_tls: None,
            })
            .unwrap(),
        );
        let (relay, worker) = Relay::start_guarded().unwrap();
        let app = crate::router(Arc::new(WebState {
            relay,
            authority: "127.0.0.1:32001".into(),
            origin: "http://127.0.0.1:32001".into(),
            base_path: String::new(),
            access: Some(access),
            room_control: Some(control),
        }));
        for (path, token, expected) in [
            ("/admin/room/activate", "wrong", StatusCode::UNAUTHORIZED),
            ("/admin/room/activate", secret, StatusCode::OK),
            ("/admin/room/drain", secret, StatusCode::OK),
            ("/admin/room/activate", secret, StatusCode::CONFLICT),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header("host", "127.0.0.1:32001")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(serde_json::to_vec(&fence).unwrap()))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                expected
            );
        }
        worker.shutdown().unwrap();
        server.abort();
        let _ = server.await;
    }
}
