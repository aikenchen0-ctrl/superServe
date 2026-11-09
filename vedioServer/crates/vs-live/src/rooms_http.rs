// 参考atm0s按应用和房间路由的机制；固定名册保留各房间排空下界，不复制其SDN。
use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use vs_core::room_assignment::MediaFence;
use vs_live::{
    MAX_ROOMS, Relay, RelayWorker,
    access::{AccessKey, LiveAccess, LiveAccessConfig},
    room_control::RoomControl,
};

use crate::{WebState, local_only, room_http, router};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoomName {
    tenant_id: String,
    room_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRoomsConfig {
    issuer: String,
    audience: String,
    node_id: String,
    keys: Vec<AccessKey>,
    rooms: Vec<RoomName>,
}

pub struct RoomRegistry {
    rooms: BTreeMap<(String, String), Arc<WebState>>,
}

impl RoomRegistry {
    #[cfg(test)]
    pub fn start(
        config: NodeRoomsConfig,
        control: Arc<RoomControl>,
        authority: String,
    ) -> Result<(Arc<Self>, RelayWorker), std::io::Error> {
        Self::start_network(config, control, authority, None)
    }

    pub fn start_network(
        config: NodeRoomsConfig,
        control: Arc<RoomControl>,
        authority: String,
        network: Option<vs_live::network::PrivateMediaNetwork>,
    ) -> Result<(Arc<Self>, RelayWorker), std::io::Error> {
        if !(1..=MAX_ROOMS).contains(&config.rooms.len()) {
            return Err(std::io::Error::other("媒体节点的房间数量须为1至8"));
        }
        let first = &config.rooms[0];
        let root = LiveAccess::new(LiveAccessConfig {
            issuer: config.issuer,
            audience: config.audience,
            node_id: config.node_id,
            keys: config.keys,
            tenant_id: first.tenant_id.clone(),
            room_id: first.room_id.clone(),
        })
        .map_err(std::io::Error::other)?;
        let mut accesses = BTreeMap::new();
        for name in config.rooms {
            let access = root
                .for_room(name.tenant_id.clone(), name.room_id.clone())
                .map_err(std::io::Error::other)?;
            if accesses
                .insert((name.tenant_id, name.room_id), Arc::new(access))
                .is_some()
            {
                return Err(std::io::Error::other("媒体节点配置包含重复房间"));
            }
        }
        let (relays, worker) = if let Some(network) = network {
            Relay::start_rooms_private(accesses.len(), network)?
        } else {
            Relay::start_rooms(accesses.len(), true)?
        };
        let rooms = accesses
            .into_iter()
            .zip(relays)
            .map(|(((tenant, room), access), relay)| {
                let state = Arc::new(WebState {
                    relay,
                    authority: authority.clone(),
                    origin: format!("http://{authority}"),
                    base_path: format!("/live/{tenant}/{room}"),
                    access: Some(access),
                    room_control: Some(control.clone()),
                });
                ((tenant, room), state)
            })
            .collect();
        Ok((Arc::new(Self { rooms }), worker))
    }

    fn select(&self, fence: &MediaFence) -> Option<&Arc<WebState>> {
        self.rooms
            .get(&(fence.tenant_id.clone(), fence.room_id.clone()))
    }

    pub fn signaling_routes(
        &self,
        signaling: &crate::signaling_tls::SignalingTls,
    ) -> std::io::Result<Router> {
        let mut app = Router::new();
        for state in self.rooms.values() {
            app = app.nest(&format!("{}/", state.base_path), signaling.router(state)?);
        }
        Ok(app)
    }
}

pub fn routes(registry: Arc<RoomRegistry>) -> Router {
    let boundary = registry.rooms.first_key_value().unwrap().1.clone();
    let mut app = Router::new();
    for state in registry.rooms.values() {
        app = app.nest(&format!("{}/", state.base_path), router(state.clone()));
    }
    let root = Router::new()
        .route("/lab/rooms", get(list))
        .route("/admin/room/activate", post(activate))
        .route("/admin/room/drain", post(drain))
        .route("/admin/room/revoke-token", post(revoke))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .route_layer(middleware::from_fn_with_state(
            boundary.clone(),
            room_http::authenticate,
        ))
        .layer(middleware::from_fn_with_state(boundary, local_only))
        .with_state(registry);
    app.merge(root)
}

async fn list(State(registry): State<Arc<RoomRegistry>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "schema": "live-node-rooms-v1",
        "capacity": MAX_ROOMS,
        "media_workers": 1,
        "worker": registry.rooms.first_key_value().unwrap().1.relay.worker_stats().ok(),
        "rooms": registry.rooms.values().map(|state| serde_json::json!({
            "path": state.base_path,
            "binding": state.access.as_ref().unwrap().binding(),
            "stats": state.relay.stats().ok(),
        })).collect::<Vec<_>>(),
    }))
}

async fn activate(
    State(registry): State<Arc<RoomRegistry>>,
    Json(fence): Json<MediaFence>,
) -> Response {
    operation(registry, fence, true).await
}

pub(crate) async fn drain(
    State(registry): State<Arc<RoomRegistry>>,
    Json(fence): Json<MediaFence>,
) -> Response {
    operation(registry, fence, false).await
}

async fn operation(registry: Arc<RoomRegistry>, fence: MediaFence, activate: bool) -> Response {
    let Some(state) = registry.select(&fence) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    room_http::operation(state, fence, activate).await
}

async fn revoke(
    State(registry): State<Arc<RoomRegistry>>,
    Json(request): Json<room_http::TokenRevocation>,
) -> Response {
    let Some(state) = registry.select(&request.fence) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    room_http::revoke(state, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, header},
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};
    use str0m::{
        Rtc,
        media::{Direction, MediaKind},
    };
    use tower::ServiceExt;
    use vs_core::room_assignment::MediaTarget;
    use vs_live::room_control::RoomControlConfig;

    const SECRET: &str = "test-control-token-with-at-least-32-bytes";
    const AUTHORITY: &str = "127.0.0.1:32100";

    fn config(names: &[(&str, &str)]) -> NodeRoomsConfig {
        let key = Ed25519KeyPair::from_seed_unchecked(&[21; 32]).unwrap();
        NodeRoomsConfig {
            issuer: "https://rooms-test.invalid".into(),
            audience: "live".into(),
            node_id: "node".into(),
            keys: vec![AccessKey {
                kid: "key".into(),
                public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
            }],
            rooms: names
                .iter()
                .map(|(tenant, room)| RoomName {
                    tenant_id: (*tenant).into(),
                    room_id: (*room).into(),
                })
                .collect(),
        }
    }

    fn control() -> Arc<RoomControl> {
        Arc::new(
            RoomControl::new(RoomControlConfig {
                cluster_id: "cluster".into(),
                coordination_endpoints: vec!["http://127.0.0.1:9".into()],
                coordination_token: SECRET.into(),
                control_token: SECRET.into(),
                coordination_tls: None,
            })
            .unwrap(),
        )
    }

    fn token(state: &WebState) -> String {
        let key = Ed25519KeyPair::from_seed_unchecked(&[21; 32]).unwrap();
        let binding = state.access.as_ref().unwrap().binding();
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let head = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"vs-live+jwt","kid":"key"}"#);
        let body = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss": "https://rooms-test.invalid", "aud": "live", "sub": "alice",
                "iat": at, "nbf": at, "exp": at + 120, "role": "publisher",
                "tenant_id": binding.tenant_id, "room_id": binding.room_id,
                "node_id": binding.node_id, "incarnation": binding.incarnation,
                "assignment_revision": 3,
            }))
            .unwrap(),
        );
        let input = format!("{head}.{body}");
        format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(key.sign(input.as_bytes()).as_ref())
        )
    }

    fn offer() -> String {
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .clear_codecs()
            .enable_vp8(true)
            .build(Instant::now());
        let mut changes = rtc.sdp_api();
        changes.add_media(MediaKind::Video, Direction::SendOnly, None, None, None);
        changes.apply().unwrap().0.to_sdp_string()
    }

    async fn request(
        app: &Router,
        method: &str,
        path: &str,
        token: &str,
        body: String,
    ) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", AUTHORITY)
                    .header("authorization", format!("Bearer {token}"))
                    .header(
                        "content-type",
                        if path.starts_with("/admin") {
                            "application/json"
                        } else {
                            "application/sdp"
                        },
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[test]
    fn invalid_or_duplicate_room_names_fail_before_media_start() {
        for names in [
            vec![],
            vec![("tenant", "room"); MAX_ROOMS + 1],
            vec![("tenant", "room"), ("tenant", "room")],
            vec![(".", "room")],
            vec![("tenant", "..")],
            vec![("tenant", "a/b")],
        ] {
            assert!(RoomRegistry::start(config(&names), control(), AUTHORITY.into()).is_err());
        }
    }

    #[tokio::test]
    async fn nested_resources_and_root_fences_isolate_tenants_with_same_room_name() {
        let (registry, worker) = RoomRegistry::start(
            config(&[("a", "room"), ("b", "room")]),
            control(),
            AUTHORITY.into(),
        )
        .unwrap();
        let a = &registry.rooms[&("a".into(), "room".into())];
        let b = &registry.rooms[&("b".into(), "room".into())];
        let binding = a.access.as_ref().unwrap().binding();
        assert_eq!(
            binding.incarnation,
            b.access.as_ref().unwrap().binding().incarnation
        );
        assert_eq!(
            a.relay.stats().unwrap().udp_port,
            b.relay.stats().unwrap().udp_port
        );
        a.relay.activate(3).await.unwrap();
        b.relay.activate(3).await.unwrap();
        let app = routes(registry.clone());
        assert_eq!(
            request(&app, "GET", "/live/a/room/", "", String::new())
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "GET", "/live/a/room/app.js", "", String::new())
                .await
                .status(),
            StatusCode::OK
        );
        let response = request(&app, "POST", "/live/b/room/whip", &token(a), offer()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = request(&app, "POST", "/live/a/room/whip", &token(a), offer()).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let location = response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(location.starts_with("http://127.0.0.1:32100/live/a/room/whip/sessions/"));
        let response = request(&app, "POST", "/live/b/room/whip", &token(b), offer()).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let foreign = location
            .strip_prefix("http://127.0.0.1:32100")
            .unwrap()
            .replace("/live/a/", "/live/b/");
        assert_eq!(
            request(&app, "DELETE", &foreign, &token(b), String::new())
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        let fence = MediaFence {
            cluster_id: "cluster".into(),
            tenant_id: "a".into(),
            room_id: "room".into(),
            target: MediaTarget {
                node_id: binding.node_id.clone(),
                incarnation: binding.incarnation.clone(),
            },
            revision: 3,
        };
        let body = serde_json::to_string(&fence).unwrap();
        assert_eq!(
            request(&app, "POST", "/admin/room/drain", "wrong", body.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = request(&app, "POST", "/admin/room/drain", SECRET, body).await;
        assert_eq!(response.status(), StatusCode::OK);
        let receipt: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(receipt["active_peers"], 0);
        assert!(b.relay.stats().unwrap().active_peers == 1);
        assert!(matches!(
            a.relay.activate(3).await,
            Err(vs_live::RelayError::Conflict)
        ));
        assert_eq!(
            request(
                &app,
                "POST",
                "/live/b/room/whep",
                &token(b),
                "invalid".into()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, "GET", "/lab/rooms", "wrong", String::new())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &app,
                "GET",
                "/live/missing/room/lab/node",
                SECRET,
                String::new()
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        worker.shutdown().unwrap();
    }
}
