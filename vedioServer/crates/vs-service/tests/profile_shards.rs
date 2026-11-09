use std::{path::Path, sync::Arc};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_service::{
    AppState, ProfileRemoteConfig, ProfileShard, ProfileShardsConfig, Role, backup_profile_log,
    handoff_profile_log, router,
};

const TOKEN: &str = "sharded-profile-test-token-00000000000000";
const CATALOG: &[u8] = br#"{"version":"shards-v1","assets":[],"items":[
    {"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
    {"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
    {"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}
]}"#;

fn shard(index: u16) -> ProfileShard {
    ProfileShard {
        schema: "profile-shard-v1".into(),
        count: 2,
        index,
    }
}

fn subject(index: u16) -> String {
    (0..100)
        .map(|value| format!("subject-{value}"))
        .find(|subject| shard(index).owns(subject))
        .unwrap()
}

fn hash() -> String {
    format!("{:x}", Sha256::digest(CATALOG))
}

fn authority(path: &Path, index: u16) -> Arc<AppState> {
    Arc::new(AppState::new_with_profile_shard(CATALOG, TOKEN, path, shard(index)).unwrap())
}

fn request(path: &str, value: Value, guard: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("x-catalog-sha256", hash())
        .header("content-type", "application/json");
    if let Some(guard) = guard {
        builder = builder.header("x-profile-shard-guard", guard);
    }
    builder
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}

fn event(subject: &str, id: &str, candidate: &str, kind: &str) -> Value {
    json!({"event_id":id,"subject":subject,"candidate_id":candidate,"kind":kind})
}

async fn call(app: &Router, path: &str, value: Value, guard: Option<&str>) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(request(path, value, guard))
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 65_536)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (endpoint, task)
}

struct Servers(Vec<tokio::task::JoinHandle<()>>);
impl Drop for Servers {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

fn config(endpoints: &[String]) -> ProfileShardsConfig {
    serde_json::from_value(json!({
        "schema":"profile-shards-v1",
        "shards":endpoints.iter().enumerate().rev().map(|(index,endpoint)|json!({
            "shard":shard(index as u16),"endpoint":endpoint,"token":TOKEN
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

fn api(endpoints: &[String]) -> Arc<AppState> {
    Arc::new(
        AppState::new(CATALOG, None, TOKEN, 2, 1)
            .unwrap()
            .with_profile_shards(config(endpoints))
            .unwrap(),
    )
}

#[test]
fn mapping_is_complete_stable_and_independent_of_process_seed() {
    // 独立PowerShell SHA256计算的向量固定字节序、命名空间与编码规则。
    for (subject, index) in [("user-a", 1), ("user-b", 12), ("subject-0", 13), ("z_9", 2)] {
        assert!(
            ProfileShard {
                count: 16,
                index,
                ..shard(0)
            }
            .owns(subject)
        );
    }
    for count in [2, 4, 8, 16] {
        let shards: Vec<_> = (0..count)
            .map(|index| ProfileShard {
                count,
                index,
                ..shard(0)
            })
            .collect();
        let mut counts = vec![0; count as usize];
        for value in 0..4096 {
            let subject = format!("subject-{value}");
            let owners: Vec<_> = shards.iter().filter(|shard| shard.owns(&subject)).collect();
            assert_eq!(owners.len(), 1);
            counts[owners[0].index as usize] += 1;
            let encoded = serde_json::to_vec(owners[0]).unwrap();
            let decoded: ProfileShard = serde_json::from_slice(&encoded).unwrap();
            assert!(decoded.owns(&subject));
        }
        assert!(counts.iter().all(|count| *count > 0));
    }
    for count in [0, 1, 3, 17, 32] {
        assert!(ProfileShard { count, ..shard(0) }.validate().is_err());
    }
    assert!(!shard(0).owns("../user"));
    assert!(
        !ProfileShard {
            index: 2,
            ..shard(0)
        }
        .owns("user")
    );
}

#[test]
fn incomplete_duplicate_mixed_and_unsafe_configurations_are_rejected() {
    let base = json!({"schema":"profile-shards-v1","shards":[
        {"shard":shard(0),"endpoint":"http://127.0.0.1:8001","token":TOKEN},
        {"shard":shard(1),"endpoint":"http://127.0.0.1:8002","token":TOKEN}
    ]});
    for case in [
        "missing",
        "duplicate",
        "count",
        "endpoint",
        "credentials",
        "token",
        "schema",
    ] {
        let mut value = base.clone();
        match case {
            "missing" => {
                value["shards"].as_array_mut().unwrap().pop();
            }
            "duplicate" => value["shards"][1]["shard"] = json!(shard(0)),
            "count" => value["shards"][1]["shard"]["count"] = json!(4),
            "endpoint" => value["shards"][1]["endpoint"] = json!("http://127.0.0.1:8001/"),
            "credentials" => {
                value["shards"][1]["endpoint"] = json!("http://name:secret@127.0.0.1:8002")
            }
            "token" => value["shards"][1]["token"] = json!("short"),
            _ => value["schema"] = json!("unknown"),
        }
        let config: ProfileShardsConfig = serde_json::from_value(value).unwrap();
        assert!(
            AppState::new(CATALOG, None, TOKEN, 2, 1)
                .unwrap()
                .with_profile_shards(config)
                .is_err(),
            "反例：{case}"
        );
    }
    assert!(
        serde_json::from_value::<ProfileShardsConfig>(json!({
            "schema":"profile-shards-v1","shards":[],"auto_migrate":true
        }))
        .is_err()
    );
    let endpoints = vec![
        "http://127.0.0.1:8001".into(),
        "http://127.0.0.1:8002".into(),
    ];
    let state = AppState::new(CATALOG, None, TOKEN, 2, 1)
        .unwrap()
        .with_profile_shards(config(&endpoints))
        .unwrap();
    assert!(
        state
            .with_profile_remote(ProfileRemoteConfig {
                endpoint: endpoints[0].clone(),
                token: TOKEN.into()
            })
            .is_err()
    );
}

#[tokio::test]
async fn authority_rejects_wrong_or_absent_guard_and_wrong_subject_without_appending() {
    let dir = tempfile::tempdir().unwrap();
    let state = authority(&dir.path().join("events"), 0);
    let app = router(state.clone(), Role::Profile);
    let initial = state.profile_history_checkpoint().unwrap();
    for guard in [None, Some("profile-shard-v1:2:1"), Some("forged")] {
        assert_eq!(
            call(
                &app,
                "/internal/v1/profile/events",
                event(&subject(0), "one", "video", "like"),
                guard
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    for path in [
        "/internal/v1/profile/events",
        "/internal/v1/profile/projection",
    ] {
        let value = if path.ends_with("events") {
            event(&subject(1), "one", "video", "like")
        } else {
            json!({"subject":subject(1),"domains":["video"]})
        };
        assert_eq!(
            call(&app, path, value, Some(&shard(0).guard())).await.0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(state.profile_history_checkpoint().unwrap(), initial);
    let response = app
        .clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event(&subject(0), "one", "video", "like"),
            Some(&shard(0).guard()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["x-profile-shard-guard"],
        shard(0).guard()
    );
}

#[tokio::test]
async fn two_api_replicas_route_cross_domain_writes_reads_duplicates_and_restart_to_same_owner() {
    let dir = tempfile::tempdir().unwrap();
    let mut servers = Servers(Vec::new());
    let mut endpoints = Vec::new();
    let mut states = Vec::new();
    for index in 0..2 {
        let state = authority(&dir.path().join(format!("events-{index}")), index);
        let (endpoint, task) = serve(router(state.clone(), Role::Profile)).await;
        states.push(state);
        endpoints.push(endpoint);
        servers.0.push(task);
    }
    let first = api(&endpoints);
    first.verify_profile_readiness().await.unwrap();
    let a = router(first, Role::Api);
    let b = router(api(&endpoints), Role::Api);
    for index in 0..2 {
        let subject = subject(index);
        for (id, candidate, kind) in [
            ("same-id", "video", "like"),
            ("document-hide", "document", "hide"),
            ("service-like", "service", "like"),
        ] {
            let value = event(&subject, id, candidate, kind);
            let (status, result) = call(&a, "/v1/profile/events", value.clone(), None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(result["accepted"], true);
            let (status, result) = call(&b, "/v1/profile/events", value, None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(result["duplicate"], true);
        }
        let (status, _) = call(
            &b,
            "/v1/profile/events",
            event(&subject, "same-id", "video", "hide"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let request = json!({"request_id":"shard-feed","subject":subject,"domains":["video","document","service"],"limit":3});
        let (status, feed_a) = call(&a, "/v1/feed", request.clone(), None).await;
        let (other, feed_b) = call(&b, "/v1/feed", request, None).await;
        assert_eq!((status, other), (StatusCode::OK, StatusCode::OK));
        assert_eq!(feed_a, feed_b);
        assert_eq!(feed_a["profile_version"], "memory-3");
        assert!(
            feed_a["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["id"] != "document")
        );
        assert_eq!(
            states[index as usize]
                .profile_history_checkpoint()
                .unwrap()
                .records,
            3
        );
    }
    drop(a);
    drop(b);
    for task in servers.0.drain(..) {
        task.abort();
        let _ = task.await;
    }
    drop(states);
    for index in 0..2 {
        let state = authority(&dir.path().join(format!("events-{index}")), index);
        let app = router(state.clone(), Role::Profile);
        let (status, projection) = call(
            &app,
            "/internal/v1/profile/projection",
            json!({"subject":subject(index),"domains":["video","document","service"]}),
            Some(&shard(index).guard()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(projection["profile"]["version"], "memory-3");
        assert_eq!(projection["profile"]["blocked_ids"], json!(["document"]));
        assert_eq!(
            call(
                &app,
                "/internal/v1/profile/events",
                event(&subject(index), "same-id", "video", "like"),
                Some(&shard(index).guard())
            )
            .await
            .1["duplicate"],
            true
        );
        assert_eq!(state.profile_history_checkpoint().unwrap().records, 3);
    }
}

#[tokio::test]
async fn unavailable_owner_does_not_write_or_read_another_shard() {
    let dir = tempfile::tempdir().unwrap();
    let live = authority(&dir.path().join("live"), 1);
    let (endpoint, task) = serve(router(live.clone(), Role::Profile)).await;
    let _servers = Servers(vec![task]);
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_endpoint = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    let app = router(api(&[dead_endpoint, endpoint]), Role::Api);
    let before = live.profile_history_checkpoint().unwrap();
    assert_eq!(
        call(
            &app,
            "/v1/profile/events",
            event(&subject(0), "one", "video", "hide"),
            None
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call(
            &app,
            "/v1/feed",
            json!({"request_id":"unavailable-feed","subject":subject(0),"domains":["video"],"limit":1}),
            None
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(before, live.profile_history_checkpoint().unwrap());
    assert_eq!(
        call(
            &app,
            "/v1/profile/events",
            event(&subject(1), "one", "video", "like"),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn unsharded_or_misidentified_authorities_cannot_silently_serve_sharded_clients() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new_with_profile_log(CATALOG, None, TOKEN, 2, 1, Some(&dir.path().join("plain")))
            .unwrap()
            .into_profile_authority()
            .unwrap(),
    );
    let (plain, task) = serve(router(state.clone(), Role::Profile)).await;
    let wrong = authority(&dir.path().join("wrong"), 0);
    let (wrong, task2) = serve(router(wrong, Role::Profile)).await;
    let _servers = Servers(vec![task, task2]);
    let backend = api(&[plain, wrong]);
    assert!(backend.verify_profile_readiness().await.is_err());
    let app = router(backend, Role::Api);
    assert_eq!(
        call(
            &app,
            "/v1/profile/events",
            event(&subject(0), "one", "video", "like"),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(state.profile_history_checkpoint().unwrap().records, 0);
}

#[tokio::test]
async fn missing_or_forged_response_shard_guard_never_confirms_or_retries_a_write() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for guard in [None, Some("profile-shard-v1:2:1")] {
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = attempts.clone();
        let app =
            Router::new().route(
                "/internal/v1/profile/events",
                axum::routing::post(move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    async move {
                        let mut response = axum::http::Response::builder()
                            .header("content-type", "application/json")
                            .header("x-catalog-sha256", hash());
                        if let Some(guard) = guard {
                            response = response.header("x-profile-shard-guard", guard);
                        }
                        response.body(Body::from(
                        r#"{"accepted":true,"duplicate":false,"profile_version":"memory-1"}"#,
                    )).unwrap()
                    }
                }),
            );
        let (endpoint, task) = serve(app).await;
        let _servers = Servers(vec![task]);
        let api = router(api(&[endpoint, "http://127.0.0.1:1".into()]), Role::Api);
        assert_eq!(
            call(
                &api,
                "/v1/profile/events",
                event(&subject(0), "one", "video", "like"),
                None
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }
}

#[tokio::test]
async fn persisted_layout_cannot_change_or_open_unsharded_and_nonempty_logs_cannot_be_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events");
    let state = authority(&path, 0);
    let app = router(state.clone(), Role::Profile);
    call(
        &app,
        "/internal/v1/profile/events",
        event(&subject(0), "one", "video", "like"),
        Some(&shard(0).guard()),
    )
    .await;
    drop(app);
    drop(state);
    let original = std::fs::read(&path).unwrap();
    assert!(AppState::new_with_profile_shard(CATALOG, TOKEN, &path, shard(1)).is_err());
    assert!(
        AppState::new_with_profile_shard(
            CATALOG,
            TOKEN,
            &path,
            ProfileShard {
                count: 4,
                ..shard(0)
            }
        )
        .is_err()
    );
    assert!(AppState::new_with_profile_log(CATALOG, None, TOKEN, 2, 1, Some(&path)).is_err());
    assert!(handoff_profile_log(&path, &dir.path().join("target"), &hash()).is_err());
    assert!(backup_profile_log(&path, CATALOG, &dir.path().join("backup")).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    drop(authority(&path, 0));
    let plain = dir.path().join("plain");
    std::fs::write(&plain, &original).unwrap();
    assert!(AppState::new_with_profile_shard(CATALOG, TOKEN, &plain, shard(0)).is_err());
    assert!(!dir.path().join("plain.shard.json").exists());
    assert_eq!(std::fs::read(&plain).unwrap(), original);
}

#[tokio::test]
async fn wrong_partition_history_and_unknown_marker_fields_fail_before_activation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events");
    let state = authority(&path, 0);
    let app = router(state.clone(), Role::Profile);
    call(
        &app,
        "/internal/v1/profile/events",
        event(&subject(0), "one", "video", "like"),
        Some(&shard(0).guard()),
    )
    .await;
    drop(app);
    drop(state);
    let bytes = std::fs::read(&path).unwrap();
    let marker = dir.path().join("events.shard.json");
    std::fs::write(&marker, serde_json::to_vec(&shard(1)).unwrap()).unwrap();
    assert!(AppState::new_with_profile_shard(CATALOG, TOKEN, &path, shard(1)).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let mut value = json!(shard(0));
    value["force"] = json!(true);
    std::fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(AppState::new_with_profile_shard(CATALOG, TOKEN, &path, shard(0)).is_err());
}

#[test]
fn missing_log_with_persisted_identity_or_reserved_name_is_not_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events");
    std::fs::write(
        dir.path().join("events.shard.json"),
        serde_json::to_vec(&shard(0)).unwrap(),
    )
    .unwrap();
    assert!(AppState::new_with_profile_shard(CATALOG, TOKEN, &path, shard(0)).is_err());
    assert!(AppState::new_with_profile_log(CATALOG, None, TOKEN, 2, 1, Some(&path)).is_err());
    assert!(!path.exists());
    for name in [
        "events.shard.json",
        "events.sealed.json",
        "EVENTS.SHARD.JSON",
    ] {
        assert!(
            AppState::new_with_profile_shard(CATALOG, TOKEN, &dir.path().join(name), shard(0))
                .is_err()
        );
    }
}
