use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::Body,
    extract::Request,
    http::{Response, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_service::{AppState, ProfileConsensusConfig, ProfileRemoteConfig, Role, router};

const TOKEN: &str = "profile-consensus-feed-test-token-000000000";
const CATALOG: &[u8] = br#"{"version":"consensus-feed-v1","assets":[],"items":[
{"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
{"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
{"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}]}"#;

fn hash() -> String {
    format!("{:x}", Sha256::digest(CATALOG))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn view(index: u64) -> Value {
    json!({"schema":"profile-consensus-projection-v1","cluster_id":"profile-test",
        "catalog_sha256":hash(),"shard_count":2,"applied_index":index,
        "subject":"subject","domains":["video","document","service"],
        "profile":{"subject":"subject","version":"memory-1","scopes":["video","document","service"],
            "expires_at":now()+60,"interests":[{"tag":"rust","weight":0.5}],
            "blocked_ids":["document"],"denied_tags":[]}})
}
fn ready_view(index: u64) -> Value {
    json!({"schema":"profile-consensus-writer-v1","cluster_id":"profile-test",
        "catalog_sha256":hash(),"shard_count":2,"applied_index":index,
        "shard":0,"writer":null,"events":1})
}
fn config(endpoints: &[String]) -> ProfileConsensusConfig {
    serde_json::from_value(json!({"cluster_id":"profile-test",
        "endpoints":endpoints.iter().map(|url|url.strip_prefix("http://").unwrap()).collect::<Vec<_>>(),
        "service_token":TOKEN,"shard_count":2,"minimum_applied_index":5})).unwrap()
}
fn state(endpoints: &[String]) -> Arc<AppState> {
    Arc::new(
        AppState::new(CATALOG, None, TOKEN, 2, 1)
            .unwrap()
            .with_profile_consensus(config(endpoints))
            .unwrap(),
    )
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn serve(app: Router) -> (String, Server) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (endpoint, Server(handle))
}
async fn feed(app: &Router) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/feed")
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"request_id":"feed","subject":"subject",
            "domains":["video","document","service"],"limit":3})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn loopback_explicit_config_and_backend_exclusivity_fail_before_network_io() {
    for case in [
        "remote",
        "zero-port",
        "duplicate",
        "zero-index",
        "high-index",
        "count",
        "token",
        "cluster",
    ] {
        let mut value = json!({"cluster_id":"profile-test","endpoints":["127.0.0.1:8001"],
            "service_token":TOKEN,"shard_count":2,"minimum_applied_index":5});
        match case {
            "remote" => value["endpoints"] = json!(["10.1.2.3:8001"]),
            "zero-port" => value["endpoints"] = json!(["127.0.0.1:0"]),
            "duplicate" => value["endpoints"] = json!(["127.0.0.1:8001", "127.0.0.1:8001"]),
            "zero-index" => value["minimum_applied_index"] = json!(0),
            "high-index" => value["minimum_applied_index"] = json!(u64::MAX),
            "count" => value["shard_count"] = json!(3),
            "token" => value["service_token"] = json!("short"),
            _ => value["cluster_id"] = json!("../wrong"),
        }
        let parsed = serde_json::from_value(value).unwrap();
        assert!(
            AppState::new(CATALOG, None, TOKEN, 2, 1)
                .unwrap()
                .with_profile_consensus(parsed)
                .is_err(),
            "反例：{case}"
        );
    }
    let endpoints = vec!["http://127.0.0.1:8001".into()];
    let dir = tempfile::tempdir().unwrap();
    let local = AppState::new_with_profile_log(
        CATALOG,
        None,
        TOKEN,
        2,
        1,
        Some(&dir.path().join("events")),
    )
    .unwrap();
    assert!(local.with_profile_consensus(config(&endpoints)).is_err());
    let remote = AppState::new(CATALOG, None, TOKEN, 2, 1)
        .unwrap()
        .with_profile_consensus(config(&endpoints))
        .unwrap();
    assert!(
        remote
            .with_profile_remote(ProfileRemoteConfig {
                endpoint: endpoints[0].clone(),
                token: TOKEN.into()
            })
            .is_err()
    );
}

#[tokio::test]
async fn healthy_projection_hides_cross_domain_item_and_event_writes_never_leave_api() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let app = Router::new().fallback(axum::routing::any(move |request: Request| {
        let calls = observed.clone();
        async move {
            assert_eq!(
                request.headers()["authorization"],
                format!("Bearer {TOKEN}")
            );
            calls.fetch_add(1, Ordering::Relaxed);
            let value = if request.uri().path().ends_with("/writers/0") {
                ready_view(10)
            } else {
                view(10)
            };
            axum::Json(value)
        }
    }));
    let (endpoint, _server) = serve(app).await;
    let state = state(&[endpoint]);
    state.verify_profile_readiness().await.unwrap();
    let app = router(state, Role::Api);
    let (status, value) = feed(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["profile_version"], "memory-1");
    assert_eq!(value["items"].as_array().unwrap().len(), 2);
    assert!(
        value["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != "document")
    );
    let count = calls.load(Ordering::Relaxed);
    let response = app.oneshot(Request::builder().method("POST").uri("/v1/profile/events")
        .header("authorization",format!("Bearer {TOKEN}")).header("content-type","application/json")
        .body(Body::from(json!({"event_id":"event","subject":"subject","candidate_id":"video","kind":"like"}).to_string()))
        .unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(calls.load(Ordering::Relaxed), count);
}

#[tokio::test]
async fn nonleader_or_offline_reads_try_only_fixed_endpoints_and_reuse_preferred_reader() {
    let failed = Arc::new(AtomicUsize::new(0));
    let observed = failed.clone();
    let (first, _first) = serve(Router::new().fallback(axum::routing::any(move || {
        observed.fetch_add(1, Ordering::Relaxed);
        async { StatusCode::SERVICE_UNAVAILABLE }
    })))
    .await;
    let (last, _last) =
        serve(Router::new().fallback(axum::routing::any(|| async { axum::Json(view(10)) }))).await;
    let app = router(state(&[first, last]), Role::Api);
    assert_eq!(feed(&app).await.0, StatusCode::OK);
    assert_eq!(feed(&app).await.0, StatusCode::OK);
    assert_eq!(failed.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn identity_scope_expiry_schema_watermark_and_malformed_success_never_fall_back() {
    for case in [
        "cluster",
        "catalog",
        "shards",
        "low",
        "subject",
        "domains",
        "expired",
        "future",
        "weight",
        "version",
        "future-version",
        "missing-profile",
        "schema",
        "unknown",
        "null-subject",
        "body",
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let mut forged = view(10);
        match case {
            "cluster" => forged["cluster_id"] = json!("other"),
            "catalog" => forged["catalog_sha256"] = json!("0".repeat(64)),
            "shards" => forged["shard_count"] = json!(4),
            "low" => forged["applied_index"] = json!(4),
            "subject" => forged["profile"]["subject"] = json!("other"),
            "domains" => forged["profile"]["scopes"] = json!(["video"]),
            "expired" => forged["profile"]["expires_at"] = json!(1),
            "future" => forged["profile"]["expires_at"] = json!(now() + 3600),
            "weight" => forged["profile"]["interests"][0]["weight"] = json!(10),
            "version" => forged["profile"]["version"] = json!("not-a-version"),
            "future-version" => forged["profile"]["version"] = json!("memory-999"),
            "missing-profile" => {
                forged.as_object_mut().unwrap().remove("profile");
            }
            "schema" => forged["schema"] = json!("wrong"),
            "unknown" => forged["force"] = json!(true),
            "null-subject" => {
                forged["profile"] = Value::Null;
                forged["subject"] = json!("other");
            }
            _ => {}
        }
        let (first, _server) = serve(Router::new().fallback(axum::routing::any(move || {
            let value = forged.clone();
            async move {
                Response::new(Body::from(if case == "body" {
                    "{".into()
                } else {
                    value.to_string()
                }))
            }
        })))
        .await;
        let (last, _last) = serve(Router::new().fallback(axum::routing::any(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            async { axum::Json(view(10)) }
        })))
        .await;
        let app = router(state(&[first, last]), Role::Api);
        assert_eq!(feed(&app).await.0, StatusCode::CONFLICT, "反例：{case}");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }
}

#[tokio::test]
async fn redirects_and_oversized_success_never_follow_or_return_empty_profile() {
    for case in ["redirect", "size"] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let (endpoint, _server) = serve(
            Router::new()
                .route(
                    "/internal/lab/profile/projection",
                    axum::routing::post(move || async move {
                        if case == "redirect" {
                            Response::builder()
                                .status(307)
                                .header("location", "/unexpected")
                                .body(Body::empty())
                                .unwrap()
                        } else {
                            Response::new(Body::from(vec![b' '; 65_537]))
                        }
                    }),
                )
                .route(
                    "/unexpected",
                    axum::routing::post(move || {
                        observed.fetch_add(1, Ordering::Relaxed);
                        async { axum::Json(view(10)) }
                    }),
                ),
        )
        .await;
        let app = router(state(&[endpoint]), Role::Api);
        assert_eq!(feed(&app).await.0, StatusCode::CONFLICT);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }
}

#[tokio::test]
async fn readiness_rejects_wrong_cluster_and_observed_watermark_never_regresses() {
    let counter = Arc::new(AtomicUsize::new(0));
    let observed = counter.clone();
    let (endpoint, _server) = serve(Router::new().fallback(axum::routing::any(
        move |request: Request| {
            let counter = observed.clone();
            async move {
                if request.uri().path().ends_with("/writers/0") {
                    let mut value = ready_view(10);
                    value["cluster_id"] = json!("other");
                    axum::Json(value)
                } else {
                    axum::Json(view(if counter.fetch_add(1, Ordering::Relaxed) == 0 {
                        10
                    } else {
                        9
                    }))
                }
            }
        },
    )))
    .await;
    let state = state(&[endpoint]);
    assert!(state.verify_profile_readiness().await.is_err());
    let app = router(state, Role::Api);
    assert_eq!(feed(&app).await.0, StatusCode::OK);
    assert_eq!(feed(&app).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn total_read_budget_is_bounded_and_no_quorum_never_falls_back_to_local_memory() {
    let (endpoint, _server) = serve(Router::new().fallback(axum::routing::any(|| async {
        tokio::time::sleep(Duration::from_secs(3)).await;
        axum::Json(view(10))
    })))
    .await;
    let app = router(state(&[endpoint]), Role::Api);
    let start = tokio::time::Instant::now();
    assert_eq!(feed(&app).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn signed_feed_identity_reaches_consensus_reader_without_body_subject_override() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use vs_service::feed_access::{FeedAccessConfig, FeedAccessKey};

    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let (endpoint, _server) = serve(Router::new().fallback(axum::routing::any(
        move |request: Request| {
            let calls = observed.clone();
            async move {
                let bytes = axum::body::to_bytes(request.into_body(), 4096)
                    .await
                    .unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["subject"], "signed-subject");
                assert_eq!(body["domains"], json!(["video", "document", "service"]));
                calls.fetch_add(1, Ordering::Relaxed);
                let mut value = view(10);
                value["subject"] = json!("signed-subject");
                value["profile"]["subject"] = json!("signed-subject");
                axum::Json(value)
            }
        },
    )))
    .await;
    let key = Ed25519KeyPair::from_seed_unchecked(&[17; 32]).unwrap();
    let state = AppState::new(CATALOG, None, TOKEN, 2, 1)
        .unwrap()
        .with_profile_consensus(config(&[endpoint]))
        .unwrap()
        .with_feed_access(FeedAccessConfig {
            issuer: "https://synthetic-identity.example".into(),
            audience: "feed-api".into(),
            keys: vec![FeedAccessKey {
                kid: "synthetic-key".into(),
                public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
            }],
        })
        .unwrap();
    let app = router(Arc::new(state), Role::Api);
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "alg":"EdDSA","typ":"vs-feed+jwt","kid":"synthetic-key"
        }))
        .unwrap(),
    );
    let issued = now().saturating_sub(1);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "iss":"https://synthetic-identity.example","aud":"feed-api","sub":"signed-subject",
            "iat":issued,"nbf":issued,"exp":issued+120,"domains":["video","document","service"]
        }))
        .unwrap(),
    );
    let message = format!("{header}.{claims}");
    let signed = format!(
        "{message}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref())
    );
    for overridden in [false, true] {
        let mut body =
            json!({"request_id":"signed-feed","domains":["video","document","service"],"limit":3});
        if overridden {
            body["subject"] = json!("forged-subject");
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/internal/v2/feed")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .header("x-feed-identity", format!("Bearer {signed}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if overridden {
                StatusCode::UNPROCESSABLE_ENTITY
            } else {
                StatusCode::OK
            }
        );
    }
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn cold_subject_requires_matching_envelope_and_does_not_allocate_local_profile() {
    let (endpoint, _server) = serve(Router::new().fallback(axum::routing::any(|| async {
        let mut value = view(10);
        value["profile"] = Value::Null;
        axum::Json(value)
    })))
    .await;
    let app = router(state(&[endpoint]), Role::Api);
    let (status, response) = feed(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["profile_version"], Value::Null);
    assert_eq!(response["items"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn five_slow_endpoints_share_one_total_deadline() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut endpoints = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..5 {
        let observed = calls.clone();
        let (endpoint, server) = serve(Router::new().fallback(axum::routing::any(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            async {
                tokio::time::sleep(Duration::from_secs(3)).await;
                axum::Json(view(10))
            }
        })))
        .await;
        endpoints.push(endpoint);
        servers.push(server);
    }
    let app = router(state(&endpoints), Role::Api);
    let start = tokio::time::Instant::now();
    assert_eq!(feed(&app).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert!(start.elapsed() < Duration::from_millis(2700));
    assert!(calls.load(Ordering::Relaxed) < 5);
}

#[tokio::test]
async fn connection_failure_and_gateway_timeout_switch_only_to_fixed_readers() {
    let offline = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let refused = format!("http://{}", offline.local_addr().unwrap());
    drop(offline);
    let (timeout, _timeout) =
        serve(Router::new().fallback(axum::routing::any(|| async { StatusCode::GATEWAY_TIMEOUT })))
            .await;
    let (healthy, _healthy) =
        serve(Router::new().fallback(axum::routing::any(|| async { axum::Json(view(10)) }))).await;
    let app = router(state(&[refused, timeout, healthy]), Role::Api);
    assert_eq!(feed(&app).await.0, StatusCode::OK);
}

#[tokio::test]
async fn authentication_and_other_http_failures_never_probe_another_reader() {
    for rejected in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::NOT_FOUND,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let (first, _first) =
            serve(Router::new().fallback(axum::routing::any(move || async move { rejected })))
                .await;
        let (last, _last) = serve(Router::new().fallback(axum::routing::any(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            async { axum::Json(view(10)) }
        })))
        .await;
        let app = router(state(&[first, last]), Role::Api);
        assert_eq!(feed(&app).await.0, StatusCode::CONFLICT);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }
}

#[tokio::test]
async fn streamed_success_enforces_body_limit_without_trusting_content_length() {
    for extra in [0, 1] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let (first, _first) = serve(Router::new().fallback(axum::routing::any(
            move || async move {
                let encoded = serde_json::to_vec(&view(10)).unwrap();
                let padding = vec![b' '; 65_536 + extra - encoded.len()];
                let chunks = futures_util::stream::iter(
                    [encoded, padding].into_iter().map(Ok::<_, std::io::Error>),
                );
                Response::new(Body::from_stream(chunks))
            },
        )))
        .await;
        let (last, _last) = serve(Router::new().fallback(axum::routing::any(move || {
            observed.fetch_add(1, Ordering::Relaxed);
            async { axum::Json(view(10)) }
        })))
        .await;
        let app = router(state(&[first, last]), Role::Api);
        assert_eq!(
            feed(&app).await.0,
            if extra == 0 {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            }
        );
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }
}
