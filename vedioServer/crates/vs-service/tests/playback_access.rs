use std::{
    collections::HashSet,
    fs,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
};
use m3u8_rs::Playlist;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_core::catalog::PublicCatalog;
use vs_service::{
    AppState, Role, hls::publish_hls, playback_access::PlaybackGrantResponse,
    publication::load_catalog_release, router,
};
use vs_storage::MediaStore;

const SERVICE_TOKEN: &str = "playback-access-internal-test-only-0000000000000";

struct Fixture {
    directory: tempfile::TempDir,
    catalog: Vec<u8>,
    api: Router,
    media: Router,
}

impl Fixture {
    fn new() -> Self {
        Self::with_decisions(false)
    }

    fn with_decisions(decisions: bool) -> Self {
        Self::with_linkage(decisions, false)
    }

    fn with_linkage(decisions: bool, linkage: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.mp4");
        fs::write(&input, include_bytes!("fixtures/mp4/h264-aac-tail.mp4")).unwrap();
        publish_hls(directory.path(), &input, "access-v1", "clip", 1).unwrap();
        let mut catalog: PublicCatalog =
            serde_json::from_slice(&load_catalog_release(directory.path(), "access-v1").unwrap())
                .unwrap();
        // 与HLS无关的同目录资产，用来验证凭据不能扩展到全目录。
        let bytes = b"not-in-the-playlist";
        let hash = format!("{:x}", Sha256::digest(bytes));
        fs::write(directory.path().join("media").join(&hash), bytes).unwrap();
        catalog.assets.push(vs_core::catalog::MediaAsset {
            sha256: hash,
            bytes: bytes.len() as u64,
            content_type: "video/mp4".into(),
        });
        let catalog = serde_json::to_vec(&catalog).unwrap();
        let state = |store, journal| {
            let state = AppState::new(&catalog, store, SERVICE_TOKEN, 2, 8)
                .unwrap()
                .with_playback_access(&[7; 32], "media-v1")
                .unwrap()
                .with_delivery_observation();
            let state = if linkage {
                state.with_playback_linkage_v2().unwrap()
            } else {
                state
            };
            let state = if journal {
                state
                    .with_learning_journal(
                        &directory.path().join("decisions.jsonl"),
                        "receipt-test",
                    )
                    .unwrap()
            } else {
                state
            };
            Arc::new(state)
        };
        let api = router(state(None, decisions), Role::Api);
        let media = router(
            state(
                Some(MediaStore::filesystem(directory.path().to_str().unwrap()).unwrap()),
                false,
            ),
            Role::Media,
        );
        Self {
            directory,
            catalog,
            api,
            media,
        }
    }

    fn grant_request() -> Value {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        json!({
            "candidate_id": "clip",
            "ttl_seconds": 120,
            "profile": {
                "subject": "local-viewer",
                "version": "access-v1",
                "scopes": ["video"],
                "expires_at": now + 600,
                "interests": [], "blocked_ids": [], "denied_tags": []
            }
        })
    }

    async fn issue(&self, value: &Value, authenticate: bool) -> axum::response::Response {
        let mut request = Request::builder()
            .method("POST")
            .uri("/internal/v1/playback/grants")
            .header("content-type", "application/json");
        if authenticate {
            request = request.header("authorization", format!("Bearer {SERVICE_TOKEN}"));
        }
        self.api
            .clone()
            .oneshot(request.body(Body::from(value.to_string())).unwrap())
            .await
            .unwrap()
    }

    async fn read(
        &self,
        uri: &str,
        agent: &str,
        method: Method,
        range: bool,
    ) -> axum::response::Response {
        let mut request = Request::builder()
            .uri(uri)
            .method(method)
            .header("user-agent", agent);
        if range {
            request = request.header("range", "bytes=0-15");
        }
        self.media
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn read_with_cmcd(
        &self,
        uri: &str,
        playback_id: &str,
        request_id: Option<&str>,
    ) -> axum::response::Response {
        let mut request = Request::builder().uri(uri).method(Method::GET).header(
            "cmcd-session",
            format!("sid=\"{playback_id}\",cid=\"clip\""),
        );
        if let Some(request_id) = request_id {
            request = request.header("cmcd-request", format!("vs-rid=\"{request_id}\""));
        }
        self.media
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn durable_recommendation_receipt_links_playback_without_allowing_scope_or_subject_changes() {
    let fixture = Fixture::with_decisions(true);
    let profile = Fixture::grant_request()["profile"].clone();
    let response = fixture.api.clone().oneshot(
        Request::builder().method("POST").uri("/v1/recommendations")
            .header("authorization", format!("Bearer {SERVICE_TOKEN}"))
            .header("content-type", "application/json")
            .body(Body::from(json!({
                "request_id": "joint-request", "domains": ["video"], "limit": 1, "profile": profile,
            }).to_string())).unwrap()
    ).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let receipt = response.headers()["x-playback-decision-receipt"]
        .to_str()
        .unwrap()
        .to_owned();
    let decision = response.headers()["x-learning-decision-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(!receipt.contains(SERVICE_TOKEN));
    let mut request = Fixture::grant_request();
    request["decision_receipt"] = json!(receipt);
    let linked = fixture.issue(&request, true).await;
    assert_eq!(linked.status(), StatusCode::OK);
    let linked: PlaybackGrantResponse =
        serde_json::from_slice(&to_bytes(linked.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(linked.decision_id.as_deref(), Some(decision.as_str()));
    assert_eq!(
        linked.recommendation_request_id.as_deref(),
        Some("joint-request")
    );
    let body = fixture
        .read(&linked.media_path, "client", Method::GET, false)
        .await;
    assert_eq!(body.status(), StatusCode::OK);
    let mut other = request.clone();
    other["profile"]["subject"] = json!("other-subject");
    assert_eq!(
        fixture.issue(&other, true).await.status(),
        StatusCode::FORBIDDEN
    );
    other = request.clone();
    other["profile"]["blocked_ids"] = json!(["clip"]);
    assert_eq!(
        fixture.issue(&other, true).await.status(),
        StatusCode::FORBIDDEN
    );
    other = request.clone();
    other["decision_receipt"] = json!(format!("{receipt}x"));
    assert_eq!(
        fixture.issue(&other, true).await.status(),
        StatusCode::FORBIDDEN
    );
    let direct = fixture.issue(&Fixture::grant_request(), true).await;
    let direct: Value =
        serde_json::from_slice(&to_bytes(direct.into_body(), 4096).await.unwrap()).unwrap();
    assert!(direct.get("decision_id").is_none());
    assert!(direct.get("recommendation_request_id").is_none());
}

#[tokio::test]
async fn delivery_metrics_count_only_playback_capability_bound_cmcd_linkage() {
    let fixture = Fixture::with_linkage(true, true);
    let profile = Fixture::grant_request()["profile"].clone();
    let recommendation = fixture
        .api
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/recommendations")
                .header("authorization", format!("Bearer {SERVICE_TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "request_id": "trace-request",
                        "domains": ["video"],
                        "limit": 1,
                        "profile": profile,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(recommendation.status(), StatusCode::OK);
    let decision_receipt = recommendation.headers()["x-playback-decision-receipt"]
        .to_str()
        .unwrap()
        .to_owned();

    let mut request = Fixture::grant_request();
    request["decision_receipt"] = json!(decision_receipt);
    let linked = fixture.issue(&request, true).await;
    assert_eq!(linked.status(), StatusCode::OK);
    let linked: PlaybackGrantResponse =
        serde_json::from_slice(&to_bytes(linked.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(
        linked.recommendation_request_id.as_deref(),
        Some("trace-request")
    );
    let direct = fixture.issue(&Fixture::grant_request(), true).await;
    assert_eq!(direct.status(), StatusCode::OK);
    let direct: PlaybackGrantResponse =
        serde_json::from_slice(&to_bytes(direct.into_body(), 4096).await.unwrap()).unwrap();
    assert!(direct.recommendation_request_id.is_none());
    let body = fixture
        .read_with_cmcd(
            &linked.media_path,
            &linked.playback_id,
            Some("trace-request"),
        )
        .await;
    assert_eq!(body.status(), StatusCode::OK);
    let _ = to_bytes(body.into_body(), 2 * 1024 * 1024).await.unwrap();

    // 令牌有效但资产范围被修改时，不能把自报的正确标识计为已验证关联。
    let catalog: PublicCatalog = serde_json::from_slice(&fixture.catalog).unwrap();
    let other_hash = &catalog.assets.last().unwrap().sha256;
    let mut parts: Vec<_> = linked.media_path.split('/').collect();
    parts[4] = other_hash;
    let denied = fixture
        .read_with_cmcd(&parts.join("/"), &linked.playback_id, Some("trace-request"))
        .await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let _ = to_bytes(denied.into_body(), 4096).await.unwrap();

    let forged = fixture
        .read_with_cmcd(
            &direct.media_path,
            &direct.playback_id,
            Some("trace-request"),
        )
        .await;
    assert_eq!(forged.status(), StatusCode::OK);
    let _ = to_bytes(forged.into_body(), 2 * 1024 * 1024).await.unwrap();

    let mismatched = fixture
        .read_with_cmcd(
            &linked.media_path,
            &linked.playback_id,
            Some("client-forged-request"),
        )
        .await;
    assert_eq!(mismatched.status(), StatusCode::OK);
    let _ = to_bytes(mismatched.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();

    // 平台未发送CMCD时，v2播放能力仍提供请求级服务端关联。
    let native_shape = fixture
        .read(
            &linked.media_path,
            "native-player-without-cmcd",
            Method::GET,
            false,
        )
        .await;
    assert_eq!(native_shape.status(), StatusCode::OK);
    let _ = to_bytes(native_shape.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();

    let body = fixture
        .read_with_cmcd(&direct.media_path, &direct.playback_id, None)
        .await;
    assert_eq!(body.status(), StatusCode::OK);
    let _ = to_bytes(body.into_body(), 2 * 1024 * 1024).await.unwrap();

    let metrics = fixture
        .media
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/metrics")
                .header("authorization", format!("Bearer {SERVICE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let metrics: Value =
        serde_json::from_slice(&to_bytes(metrics.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(metrics["delivery"]["linkage_claims"], 5);
    assert_eq!(metrics["delivery"]["verified_playback_linkages"], 2);
    assert_eq!(metrics["delivery"]["verified_recommendation_linkages"], 1);
    assert_eq!(metrics["delivery"]["unverified_linkage_claims"], 3);
    assert_eq!(metrics["delivery"]["capability_authorized_requests"], 5);
}

#[tokio::test]
async fn default_issuance_and_legacy_child_rewrites_keep_v1_without_claiming_linkage() {
    let fixture = Fixture::new();
    let direct = fixture.issue(&Fixture::grant_request(), true).await;
    assert_eq!(direct.status(), StatusCode::OK);
    let direct: PlaybackGrantResponse =
        serde_json::from_slice(&to_bytes(direct.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(direct.media_path.split('/').nth(3).unwrap().len(), 216);
    let response = fixture
        .read_with_cmcd(&direct.media_path, &direct.playback_id, None)
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let (_, playlist) = m3u8_rs::parse_playlist(&bytes).unwrap();
    let Playlist::MasterPlaylist(master) = playlist else {
        panic!("测试素材未生成主清单");
    };
    assert!(!master.variants.is_empty());
    for variant in master.variants {
        assert_eq!(variant.uri.split('/').nth(3).unwrap().len(), 216);
        let child = fixture
            .read(&variant.uri, "client", Method::GET, false)
            .await;
        assert_eq!(child.status(), StatusCode::OK);
        let _ = to_bytes(child.into_body(), 2 * 1024 * 1024).await.unwrap();
    }
    let metrics = fixture
        .media
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/metrics")
                .header("authorization", format!("Bearer {SERVICE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let metrics: Value =
        serde_json::from_slice(&to_bytes(metrics.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(metrics["delivery"]["verified_playback_linkages"], 0);
    assert_eq!(metrics["delivery"]["unverified_linkage_claims"], 1);
}

#[tokio::test]
async fn independent_issuer_and_media_replicas_authorize_every_hls_reference_without_service_headers()
 {
    let fixture = Fixture::with_linkage(false, true);
    let response = fixture.issue(&Fixture::grant_request(), true).await;
    assert_eq!(response.status(), StatusCode::OK);
    let grant: PlaybackGrantResponse =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert!(!grant.media_path.contains(SERVICE_TOKEN));
    let catalog: PublicCatalog = serde_json::from_slice(&fixture.catalog).unwrap();
    let mut checked = HashSet::new();
    let root_token = grant.media_path.split('/').nth(3).unwrap().to_string();
    assert_eq!(root_token.len(), 238);
    let mut pending = vec![grant.media_path];
    let mut fragments = Vec::new();
    while let Some(path) = pending.pop() {
        if !checked.insert(path.clone()) {
            continue;
        }
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let root_claims = URL_SAFE_NO_PAD.decode(&root_token).unwrap();
        let child_claims = URL_SAFE_NO_PAD
            .decode(path.split('/').nth(3).unwrap())
            .unwrap();
        assert_eq!(path.split('/').nth(3).unwrap().len(), 238);
        assert_eq!(&root_claims[2..98], &child_claims[2..98]);
        assert_eq!(&root_claims[130..146], &child_claims[130..146]);
        let response = fixture
            .read(&path, "platform-neutral-client", Method::GET, false)
            .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        if path.ends_with("index.m3u8") {
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            assert!(!text.contains("/v1/media/"));
            assert!(!text.contains(SERVICE_TOKEN));
            assert!(!text.contains("local-viewer"));
            let (remaining, playlist) = m3u8_rs::parse_playlist(&bytes).unwrap();
            assert!(remaining.is_empty());
            match playlist {
                Playlist::MasterPlaylist(master) => {
                    pending.extend(master.variants.into_iter().map(|value| value.uri));
                    pending.extend(
                        master
                            .alternatives
                            .into_iter()
                            .filter_map(|value| value.uri),
                    );
                }
                Playlist::MediaPlaylist(media) => {
                    assert!(media.end_list);
                    for segment in media.segments {
                        pending.push(segment.uri);
                        if let Some(map) = segment.map {
                            pending.push(map.uri);
                        }
                    }
                }
            }
        } else {
            let parts: Vec<_> = path.split('/').collect();
            let hash = parts[4];
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), hash);
            assert!(catalog.assets.iter().any(|asset| asset.sha256 == hash));
            fragments.push(path);
        }
    }
    assert!(!fragments.is_empty());
    // 仅验证三类客户端共同的HTTP契约；User-Agent不是原生SDK或设备验证。
    for agent in [
        "android-contract-probe",
        "ios-contract-probe",
        "web-contract-probe",
    ] {
        let response = fixture.read(&fragments[0], agent, Method::GET, true).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(to_bytes(response.into_body(), 16).await.unwrap().len(), 16);
        let response = fixture.read(&fragments[0], agent, Method::HEAD, true).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(to_bytes(response.into_body(), 16).await.unwrap().is_empty());
    }
    let path = &fragments[0];
    let mut parts: Vec<_> = path.split('/').collect();
    parts[4] = &catalog.assets.last().unwrap().sha256;
    assert_eq!(
        fixture
            .read(&parts.join("/"), "client", Method::GET, false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED,
    );
    assert_eq!(
        fixture
            .read(
                &format!("/v1/media/{}", catalog.assets[0].sha256),
                "client",
                Method::GET,
                false
            )
            .await
            .status(),
        StatusCode::UNAUTHORIZED,
    );
    let response = fixture
        .media
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/metrics")
                .header("authorization", format!("Bearer {SERVICE_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let metrics: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    assert!(metrics["delivery"]["requests"].as_u64().unwrap() >= checked.len() as u64);
    assert!(metrics["delivery"]["yielded_bytes"].as_u64().unwrap() > 0);
    assert_eq!(metrics["delivery"]["active_bodies"], 0);
}

#[tokio::test]
async fn issuance_requires_gateway_auth_and_projection_permissions_and_defaults_off() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .issue(&Fixture::grant_request(), false)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for (field, value) in [
        ("blocked_ids", json!(["clip"])),
        ("scopes", json!(["article"])),
        ("expires_at", json!(1)),
    ] {
        let mut request = Fixture::grant_request();
        request["profile"][field] = value;
        assert_eq!(
            fixture.issue(&request, true).await.status(),
            StatusCode::FORBIDDEN
        );
    }
    let mut request = Fixture::grant_request();
    request["ttl_seconds"] = json!(301);
    assert_eq!(
        fixture.issue(&request, true).await.status(),
        StatusCode::BAD_REQUEST
    );
    let state = Arc::new(AppState::new(&fixture.catalog, None, SERVICE_TOKEN, 1, 1).unwrap());
    let disabled = router(state, Role::All);
    let response = disabled
        .oneshot(
            Request::builder()
                .uri("/v1/playback/invalid/invalid/media.mp4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn playlist_corruption_is_rejected_before_signing_children() {
    let fixture = Fixture::new();
    let response = fixture.issue(&Fixture::grant_request(), true).await;
    let grant: PlaybackGrantResponse =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let catalog: PublicCatalog = serde_json::from_slice(&fixture.catalog).unwrap();
    let root = catalog.items[0].media_sha256.as_ref().unwrap();
    let path = fixture.directory.path().join("media").join(root);
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    fs::write(path, bytes).unwrap();
    assert_eq!(
        fixture
            .read(&grant.media_path, "client", Method::GET, false)
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
}

#[tokio::test]
async fn expired_root_and_child_urls_are_rejected_without_extra_headers() {
    let fixture = Fixture::new();
    let mut request = Fixture::grant_request();
    request["ttl_seconds"] = json!(1);
    let response = fixture.issue(&request, true).await;
    let grant: PlaybackGrantResponse =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let response = fixture
        .read(&grant.media_path, "client", Method::GET, false)
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let Playlist::MasterPlaylist(master) = m3u8_rs::parse_playlist_res(&bytes).unwrap() else {
        panic!("测试素材没有生成主清单");
    };
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    for path in [&grant.media_path, &master.variants[0].uri] {
        let response = fixture.read(path, "client", Method::GET, false).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
