use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_service::{
    AppState, ProfileHistoryCheckpoint, ProfileRemoteConfig, Role, handoff_profile_log, router,
};

const TOKEN: &str = "history-profile-authority-token-000000000";
const API_TOKEN: &str = "history-api-token-0000000000000000000000";
const CATALOG: &[u8] = br#"{"version":"history-v1","assets":[],"items":[
    {"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
    {"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null}
]}"#;

fn hash() -> String {
    format!("{:x}", Sha256::digest(CATALOG))
}

fn authority(path: &Path) -> AppState {
    let _ = rustls::crypto::ring::default_provider().install_default();
    AppState::new_with_profile_log(CATALOG, None, TOKEN, 2, 1, Some(path))
        .unwrap()
        .into_profile_authority()
        .unwrap()
}

fn request(path: &str, value: Value, guard: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("x-catalog-sha256", hash())
        .header("content-type", "application/json");
    if let Some(guard) = guard {
        request = request.header("x-profile-history-guard", guard);
    }
    request
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}

fn event(id: &str, kind: &str) -> Value {
    json!({"event_id":id,"subject":"user","candidate_id":"video","kind":kind})
}

async fn checkpoint(
    app: &Router,
    minimum: Option<&ProfileHistoryCheckpoint>,
) -> ProfileHistoryCheckpoint {
    let response = app
        .clone()
        .oneshot(request(
            "/internal/v1/profile/history",
            json!({"minimum":minimum}),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65_536)
        .await
        .unwrap();
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    serde_json::from_value(response["checkpoint"].clone()).unwrap()
}

#[tokio::test]
async fn checkpoint_tracks_durable_bytes_and_duplicates_do_not_advance_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events");
    let state = Arc::new(authority(&path));
    let app = router(state.clone(), Role::Profile);
    let empty = checkpoint(&app, None).await;
    assert_eq!(empty.records, 0);
    assert_eq!(empty.sha256, format!("{:x}", Sha256::digest([])));
    for id in ["first", "second"] {
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "/internal/v1/profile/events",
                    event(id, "like"),
                    None,
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let current = checkpoint(&app, None).await;
    assert_eq!(current.records, 2);
    assert_eq!(current.bytes, std::fs::metadata(&path).unwrap().len());
    app.clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event("first", "like"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(checkpoint(&app, None).await, current);
    assert_eq!(checkpoint(&app, Some(&empty)).await, current);
    drop(app);
    drop(state);
    assert_eq!(
        current.sha256,
        format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()))
    );
    assert_eq!(
        authority(&path).profile_history_checkpoint().unwrap(),
        current
    );
}

#[tokio::test]
async fn reusing_event_id_with_changed_content_returns_conflict_without_appending() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events");
    let state = Arc::new(authority(&path));
    let app = router(state, Role::Profile);

    let first = app
        .clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event("stable-id", "like"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let checkpoint_before_conflict = checkpoint(&app, None).await;

    let conflict = app
        .clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event("stable-id", "hide"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(checkpoint(&app, None).await, checkpoint_before_conflict);

    let retry = app
        .clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event("stable-id", "like"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(retry.status(), StatusCode::OK);
    assert_eq!(checkpoint(&app, None).await, checkpoint_before_conflict);
}

#[tokio::test]
async fn offline_handoff_seals_source_and_preserves_projection_and_append_continuity() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let target = dir.path().join("target");
    let state = Arc::new(authority(&source));
    let app = router(state.clone(), Role::Profile);
    for (id, kind) in [("like", "like"), ("hide", "hide")] {
        app.clone()
            .oneshot(request(
                "/internal/v1/profile/events",
                event(id, kind),
                None,
            ))
            .await
            .unwrap();
    }
    let water = checkpoint(&app, None).await;
    assert!(handoff_profile_log(&source, &target, &hash()).is_err());
    assert!(!source.with_file_name("source.sealed.json").exists());
    drop(app);
    drop(state);
    let original = std::fs::read(&source).unwrap();
    let receipt = handoff_profile_log(&source, &target, &hash()).unwrap();
    assert_eq!(receipt.checkpoint, water);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    assert_eq!(std::fs::read(&target).unwrap(), original);
    assert!(AppState::new_with_profile_log(CATALOG, None, TOKEN, 2, 1, Some(&source)).is_err());
    assert!(handoff_profile_log(&source, &dir.path().join("second-copy"), &hash()).is_err());
    let moved = Arc::new(authority(&target));
    let app = router(moved, Role::Profile);
    checkpoint(&app, Some(&water)).await;
    let projection = app
        .clone()
        .oneshot(request(
            "/internal/v1/profile/projection",
            json!({"subject":"user","domains":["video","document"]}),
            Some(&water.guard()),
        ))
        .await
        .unwrap();
    assert_eq!(
        projection.headers()["x-profile-history-guard"],
        water.guard()
    );
    let bytes = axum::body::to_bytes(projection.into_body(), 65_536)
        .await
        .unwrap();
    let projection: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(projection["profile"]["version"], "memory-2");
    assert_eq!(projection["profile"]["blocked_ids"], json!(["video"]));
    assert_eq!(
        app.clone()
            .oneshot(request(
                "/internal/v1/profile/events",
                event("new", "like"),
                Some(&water.guard()),
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(checkpoint(&app, Some(&water)).await.records, 3);
}

#[tokio::test]
async fn equal_count_divergence_truncation_and_malformed_watermarks_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(authority(&dir.path().join("source")));
    let app = router(state, Role::Profile);
    app.clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event("first", "like"),
            None,
        ))
        .await
        .unwrap();
    let water = checkpoint(&app, None).await;
    let other = router(
        Arc::new(authority(&dir.path().join("independent"))),
        Role::Profile,
    );
    other
        .clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event("other", "like"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(
        other
            .oneshot(request(
                "/internal/v1/profile/history",
                json!({"minimum":water}),
                None,
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let mut invalid = vec![water.clone(); 5];
    invalid[0].bytes -= 1;
    invalid[1].records += 1;
    invalid[2].sha256 = "a".repeat(64);
    invalid[3].schema = "future".into();
    invalid[4].projection_version = "future".into();
    for water in invalid {
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "/internal/v1/profile/history",
                    json!({"minimum":water}),
                    None,
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
    }
    let fresh = router(
        Arc::new(authority(&dir.path().join("empty"))),
        Role::Profile,
    );
    assert_eq!(
        fresh
            .oneshot(request(
                "/internal/v1/profile/events",
                event("wrong", "like"),
                Some(&water.guard()),
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn handoff_rejects_missing_parent_and_existing_target_before_sealing() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    drop(authority(&source));
    let missing = dir.path().join("absent").join("target");
    assert!(handoff_profile_log(&source, &missing, &hash()).is_err());
    assert!(!source.with_file_name("source.sealed.json").exists());
    let target = dir.path().join("target");
    std::fs::write(&target, b"owned-target").unwrap();
    assert!(handoff_profile_log(&source, &target, &hash()).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"owned-target");
    assert!(!source.with_file_name("source.sealed.json").exists());
}

#[tokio::test]
async fn torn_tail_is_not_repaired_or_published_by_handoff() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let target = dir.path().join("target");
    drop(authority(&source));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"{\"unfinished\":")
        .unwrap();
    assert!(handoff_profile_log(&source, &target, &hash()).is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"{\"unfinished\":");
    assert!(!source.with_file_name("source.sealed.json").exists());
    assert!(!target.exists());
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(path: &Path, catalog: &Path, port: u16) -> Process {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    for key in [
        "VS_DEPLOYMENT_CHANNEL",
        "VS_DEPLOYMENT_SHA256",
        "VS_PUBLICATION_ROOT",
        "VS_PUBLICATION_BACKEND",
        "VS_CATALOG_RELEASE",
        "VS_PROFILE_AUTHORITY_URL",
        "VS_QDRANT_URL",
        "VS_RECALL_BACKEND",
    ] {
        command.env_remove(key);
    }
    command
        .env("VS_ROLE", "profile")
        .env("VS_CATALOG", catalog)
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_SERVICE_TOKEN", TOKEN)
        .env("VS_PROFILE_EVENT_LOG", path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Process(command.spawn().unwrap())
}

async fn live(client: &Client, process: &mut Process, port: u16) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            assert!(process.0.try_wait().unwrap().is_none(), "画像进程提前退出");
            if client
                .get(format!("http://127.0.0.1:{port}/readyz"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn independent_process_transfer_preserves_checkpoint_and_refuses_source_restart() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let target = dir.path().join("target");
    let catalog = dir.path().join("catalog.json");
    std::fs::write(&catalog, CATALOG).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let mut process = start(&source, &catalog, port);
    live(&client, &mut process, port).await;
    client
        .post(format!(
            "http://127.0.0.1:{port}/internal/v1/profile/events"
        ))
        .bearer_auth(TOKEN)
        .header("x-catalog-sha256", hash())
        .json(&event("first", "like"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let history: Value = client
        .post(format!(
            "http://127.0.0.1:{port}/internal/v1/profile/history"
        ))
        .bearer_auth(TOKEN)
        .header("x-catalog-sha256", hash())
        .json(&json!({"minimum":null}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    drop(process);
    let receipt = handoff_profile_log(&source, &target, &hash()).unwrap();
    assert_eq!(
        serde_json::to_value(&receipt.checkpoint).unwrap(),
        history["checkpoint"]
    );
    let mut sealed = start(&source, &catalog, 0);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = sealed.0.try_wait().unwrap() {
                assert!(!status.success());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut diagnostics = String::new();
    sealed
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut diagnostics)
        .unwrap();
    assert!(diagnostics.contains("封存"));
    let mut moved = start(&target, &catalog, port);
    live(&client, &mut moved, port).await;
    let ready: Value = client
        .get(format!("http://127.0.0.1:{port}/readyz"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ready["profile_history"], history["checkpoint"]);
}

#[tokio::test]
async fn pinned_client_refuses_same_endpoint_replaced_with_empty_history() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(authority(&dir.path().join("source")));
    let app = router(state.clone(), Role::Profile);
    app.clone()
        .oneshot(request(
            "/internal/v1/profile/events",
            event("history", "like"),
            None,
        ))
        .await
        .unwrap();
    let water = checkpoint(&app, None).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let url = format!("http://{address}");
    let task = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    let api = AppState::new(CATALOG, None, API_TOKEN, 32, 1)
        .unwrap()
        .with_profile_remote(ProfileRemoteConfig {
            endpoint: url,
            token: TOKEN.into(),
        })
        .unwrap()
        .with_profile_history(water)
        .unwrap();
    api.verify_profile_readiness().await.unwrap();
    let client_app = router(Arc::new(api), Role::Api);
    let feed = || {
        Request::builder().method("POST").uri("/v1/feed")
        .header("authorization", format!("Bearer {API_TOKEN}")).header("content-type", "application/json")
        .body(Body::from(json!({"request_id":"pinned","subject":"user","domains":["video","document"],"limit":2}).to_string())).unwrap()
    };
    assert_eq!(
        client_app.clone().oneshot(feed()).await.unwrap().status(),
        StatusCode::OK
    );
    let concurrent = futures_util::future::join_all((0..32).map(|_| {
        let app = client_app.clone();
        let request = feed();
        async move { app.oneshot(request).await.unwrap().status() }
    }))
    .await;
    assert!(concurrent.iter().all(|status| *status == StatusCode::OK));
    task.abort();
    let _ = task.await;
    drop(state);
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let empty = router(
        Arc::new(authority(&dir.path().join("unrelated"))),
        Role::Profile,
    );
    let other = tokio::spawn(async { axum::serve(listener, empty).await.unwrap() });
    assert_eq!(
        client_app.oneshot(feed()).await.unwrap().status(),
        StatusCode::CONFLICT
    );
    other.abort();
    let _ = other.await;
}
