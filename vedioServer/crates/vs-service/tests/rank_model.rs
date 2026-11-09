use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_core::{learning::LinearRankModel, recall::RecallScoring};
use vs_service::{
    AppState, Role, qdrant_recall::QdrantConfig, rank_model::train_and_publish_rank_model, router,
};

const TOKEN: &str = "rank-model-contract-token-00000000000000";
const CATALOG: &[u8] = br#"{"version":"rank-http-v1","items":[
    {"id":"a","domain":"video","tags":["first"],"prior":0.2,"media_sha256":null},
    {"id":"b","domain":"video","tags":["second"],"prior":0.8,"media_sha256":null},
    {"id":"c","domain":"article","tags":["second"],"prior":0.9,"media_sha256":null}
],"assets":[]}"#;

fn training() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schema":"rank-training-v1","data_kind":"synthetic",
        "catalog_sha256":format!("{:x}",Sha256::digest(CATALOG)),
        "catalog_as_of":1,"train_before":1000,
        "samples":(0..64).map(|i| json!({
            "exposure_id":format!("exp-{i}"),"evidence_ref":format!("feedback-{i}"),
            "profile_as_of":1,"exposed_at":2+i*2,"feedback_at":3+i*2,
            "request":{"request_id":format!("train-{i}"),"domains":["video"],"limit":2,
                "profile":null},
            "candidate_id":if i%2==0 {"a"} else {"b"},
            "feedback":if i%2==0 {"like"} else {"dislike"}
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

fn model() -> (Vec<u8>, String) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("model.json");
    train_and_publish_rank_model(CATALOG, &training(), &path).unwrap();
    let mut model: LinearRankModel = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    // 人为逆转标签基线，验证入口确实使用模型，而非只修改响应中的名称。
    model.weights.fill(0.0);
    model.weights[1] = 10.0;
    let bytes = serde_json::to_vec(&model).unwrap();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    (bytes, hash)
}

fn state() -> AppState {
    AppState::new(CATALOG, None, TOKEN, 2, 1).unwrap()
}

async fn call(app: axum::Router, path: &str, body: Option<Value>) -> axum::response::Response {
    let mut request = Request::builder()
        .uri(path)
        .header("authorization", format!("Bearer {TOKEN}"));
    let body = if let Some(body) = body {
        request = request
            .method("POST")
            .header("content-type", "application/json");
        Body::from(serde_json::to_vec(&body).unwrap())
    } else {
        Body::empty()
    };
    app.oneshot(request.body(body).unwrap()).await.unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap()
}

#[tokio::test]
async fn both_endpoints_use_the_pinned_model_and_explicit_filters_still_win() {
    let (bytes, hash) = model();
    let app = router(
        Arc::new(state().with_rank_model(&bytes, &hash).unwrap()),
        Role::Api,
    );
    let old = router(Arc::new(state()), Role::Api);
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let mut request = json!({
        "request_id":"online-rank","domains":["video","article"],"limit":3,
        "profile":{"subject":"user","version":"p1","scopes":["video","article"],
            "expires_at":expires,"interests":[{"tag":"first","weight":1.0}],
            "blocked_ids":[],"denied_tags":[]}
    });
    let old_result = json_body(call(old, "/v1/recommendations", Some(request.clone())).await).await;
    assert_eq!(old_result["items"][0]["id"], "a");
    assert!(old_result["items"][0].get("rank_score").is_none());
    let response = call(app.clone(), "/v1/recommendations", Some(request.clone())).await;
    assert_eq!(response.headers()["x-rank-model-sha256"], hash);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let result = json_body(response).await;
    assert_eq!(result["items"][0]["id"], "c");
    assert_eq!(result["ranker"], "ftrl-ranker-v1");
    assert_eq!(result["items"][0]["affinity"], 0.0);
    request["profile"]["blocked_ids"] = json!(["c"]);
    request["profile"]["denied_tags"] = json!(["second"]);
    let result = json_body(call(app.clone(), "/v1/recommendations", Some(request)).await).await;
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["id"], "a");
    json_body(
        call(
            app.clone(),
            "/v1/profile/events",
            Some(json!({
                "event_id":"like-a","subject":"user","candidate_id":"a","kind":"like"
            })),
        )
        .await,
    )
    .await;
    let feed =
        json!({"request_id":"feed-rank","subject":"user","domains":["video","article"],"limit":3});
    let response = call(app.clone(), "/v1/feed", Some(feed)).await;
    assert_eq!(response.headers()["x-rank-model-sha256"], hash);
    assert_eq!(json_body(response).await["items"][0]["id"], "c");
    let ready = json_body(call(app, "/readyz", None).await).await;
    assert_eq!(ready["rank_model_sha256"], hash);
    assert_eq!(ready["rank_training_data_kind"], "synthetic");
}

#[tokio::test]
async fn model_top_k_matches_full_sort_on_both_endpoints_and_preserves_filter_errors() {
    check_exact_backend("model-topk").await;
}

#[tokio::test]
async fn model_pruned_matches_full_sort_on_both_endpoints_and_preserves_filter_errors() {
    check_exact_backend("model-pruned").await;
}

#[tokio::test]
async fn model_blockmax_matches_both_endpoints_and_keeps_backend_and_model_requirements() {
    check_exact_backend("model-blockmax").await;
    let (bytes, hash) = model();
    let loaded = || state().with_rank_model(&bytes, &hash).unwrap();
    assert!(state().with_model_blockmax().is_err());
    assert!(
        loaded()
            .with_model_blockmax()
            .unwrap()
            .with_model_pruned()
            .is_err()
    );
    assert!(
        loaded()
            .with_model_pruned()
            .unwrap()
            .with_model_blockmax()
            .is_err()
    );
    assert!(
        loaded()
            .with_model_blockmax()
            .unwrap()
            .with_grouped_recall()
            .is_err()
    );
}

async fn check_exact_backend(backend: &str) {
    let (bytes, hash) = model();
    let loaded = || state().with_rank_model(&bytes, &hash).unwrap();
    let full = router(Arc::new(loaded()), Role::Api);
    let selected = if backend == "model-blockmax" {
        loaded().with_model_blockmax().unwrap()
    } else if backend == "model-pruned" {
        loaded().with_model_pruned().unwrap()
    } else {
        loaded().with_model_top_k().unwrap()
    };
    let exact = router(Arc::new(selected), Role::Api);
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let mut request = json!({
        "request_id":"model-selection","domains":["video","article"],"limit":2,
        "profile":{"subject":"user","version":"p1","scopes":["video","article"],
            "expires_at":expires,"interests":[{"tag":"first","weight":1.0}],
            "blocked_ids":["c"],"denied_tags":[]}
    });
    for path in ["/v1/recommendations", "/v1/feed"] {
        let body = if path.ends_with("feed") {
            for app in [full.clone(), exact.clone()] {
                for (id, candidate, kind) in [("hide-b", "b", "hide"), ("like-a", "a", "like")] {
                    json_body(
                        call(
                            app.clone(),
                            "/v1/profile/events",
                            Some(json!({
                                "event_id":id,"subject":"user","candidate_id":candidate,"kind":kind
                            })),
                        )
                        .await,
                    )
                    .await;
                }
            }
            json!({"request_id":"model-selection","subject":"user","domains":["video","article"],"limit":2})
        } else {
            request.clone()
        };
        let expected = json_body(call(full.clone(), path, Some(body.clone())).await).await;
        let response = call(exact.clone(), path, Some(body)).await;
        assert_eq!(response.headers()["x-rank-model-sha256"], hash);
        assert_eq!(response.headers()["x-recall-mode"], backend);
        assert_eq!(expected, json_body(response).await);
    }
    request["profile"]["expires_at"] = json!(0);
    assert_eq!(
        call(exact.clone(), "/v1/recommendations", Some(request.clone()))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    request["profile"]["expires_at"] = json!(expires);
    request["profile"]["scopes"] = json!(["video"]);
    assert_eq!(
        call(exact.clone(), "/v1/recommendations", Some(request))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let metrics = json_body(call(exact, "/v1/metrics", None).await).await;
    assert_eq!(metrics["recall_backend"], backend);
    if matches!(backend, "model-pruned" | "model-blockmax") {
        assert_eq!(metrics["model_index"]["groups"], 3);
        assert_eq!(metrics["model_index"]["members"], 3);
    } else {
        assert!(metrics["model_index"].is_null());
    }
    assert_eq!(metrics["recall_queries"], 0);
}

#[test]
fn model_loading_rejects_wrong_content_or_catalog_and_old_recall_in_either_order() {
    let (bytes, hash) = model();
    assert!(state().with_rank_model(&bytes, &"f".repeat(64)).is_err());
    let mut wrong: Value = serde_json::from_slice(&bytes).unwrap();
    wrong["catalog_sha256"] = json!("e".repeat(64));
    let wrong = serde_json::to_vec(&wrong).unwrap();
    let wrong_hash = format!("{:x}", Sha256::digest(&wrong));
    assert!(state().with_rank_model(&wrong, &wrong_hash).is_err());
    let learned = || state().with_rank_model(&bytes, &hash).unwrap();
    assert!(state().with_model_top_k().is_err());
    assert!(state().with_model_pruned().is_err());
    assert!(
        learned()
            .with_model_pruned()
            .unwrap()
            .with_model_top_k()
            .is_err()
    );
    assert!(
        learned()
            .with_model_top_k()
            .unwrap()
            .with_model_pruned()
            .is_err()
    );
    assert!(
        learned()
            .with_model_top_k()
            .unwrap()
            .with_model_top_k()
            .is_err()
    );
    assert!(learned().with_rank_model(&bytes, &hash).is_err());
    assert!(learned().with_grouped_recall().is_err());
    assert!(
        state()
            .with_grouped_recall()
            .unwrap()
            .with_rank_model(&bytes, &hash)
            .is_err()
    );
    let qdrant = || QdrantConfig {
        endpoint: "http://127.0.0.1:6333".into(),
        api_key: None,
        scoring: RecallScoring::Signed,
    };
    assert!(learned().with_qdrant_recall(qdrant()).is_err());
    assert!(
        state()
            .with_qdrant_recall(qdrant())
            .unwrap()
            .with_rank_model(&bytes, &hash)
            .is_err()
    );
    let directory = tempfile::tempdir().unwrap();
    let logged = || {
        AppState::new_with_profile_log(
            CATALOG,
            None,
            TOKEN,
            1,
            1,
            Some(&directory.path().join("profile.jsonl")),
        )
        .unwrap()
    };
    assert!(
        logged()
            .with_rank_model(&bytes, &hash)
            .unwrap()
            .into_profile_authority()
            .is_err()
    );
    assert!(
        logged()
            .into_profile_authority()
            .unwrap()
            .with_rank_model(&bytes, &hash)
            .is_err()
    );
}

#[test]
fn training_publishes_deterministically_without_replacing_or_partially_publishing() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.json");
    let second = directory.path().join("second.json");
    let receipt = train_and_publish_rank_model(CATALOG, &training(), &first).unwrap();
    let repeated = train_and_publish_rank_model(CATALOG, &training(), &second).unwrap();
    assert_eq!(receipt.sha256, repeated.sha256);
    assert_eq!(
        std::fs::read(&first).unwrap(),
        std::fs::read(&second).unwrap()
    );
    assert!(train_and_publish_rank_model(CATALOG, &training(), &first).is_err());
    let mut invalid: Value = serde_json::from_slice(&training()).unwrap();
    invalid["samples"][1]["feedback_at"] = json!(1000);
    let invalid = serde_json::to_vec(&invalid).unwrap();
    let failed = directory.path().join("failed.json");
    assert!(train_and_publish_rank_model(CATALOG, &invalid, &failed).is_err());
    assert!(!failed.exists());
    assert!(
        train_and_publish_rank_model(
            br#"{"version":"other","items":[],"assets":[]}"#,
            &training(),
            &failed,
        )
        .is_err()
    );
    assert!(!failed.exists());
}

struct Process(std::process::Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(
    catalog: &std::path::Path,
    model: &std::path::Path,
    hash: &str,
    port: u16,
) -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("VS_") {
            command.env_remove(name);
        }
    }
    command
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_ROLE", "api")
        .env("VS_SERVICE_TOKEN", TOKEN)
        .env("VS_CATALOG", catalog)
        .env("VS_RANK_MODEL", model)
        .env("VS_RANK_MODEL_SHA256", hash)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[tokio::test]
async fn independent_processes_pin_model_content_and_new_reader_rejects_modified_file() {
    use std::time::{Duration, Instant};
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("catalog.json");
    let model_file = directory.path().join("model.json");
    let (bytes, hash) = model();
    std::fs::write(&catalog, CATALOG).unwrap();
    std::fs::write(&model_file, &bytes).unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let mut replicas = Vec::new();
    for backend in ["catalog", "model-topk", "model-pruned", "model-blockmax"] {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut process = Process(
            command(&catalog, &model_file, &hash, port)
                .env("VS_RECALL_BACKEND", backend)
                .spawn()
                .unwrap(),
        );
        let endpoint = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(
                process.0.try_wait().unwrap().is_none(),
                "学习排序副本提前退出"
            );
            if let Ok(response) = client
                .get(format!("{endpoint}/readyz"))
                .bearer_auth(TOKEN)
                .send()
                .await
                && response.status().is_success()
            {
                let ready: Value = response.json().await.unwrap();
                assert_eq!(ready["rank_model_sha256"], hash);
                break;
            }
            assert!(Instant::now() < deadline, "学习排序副本启动超时");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        replicas.push((endpoint, backend, process));
    }
    let mut modified: Value = serde_json::from_slice(&bytes).unwrap();
    modified["weights"][1] = json!(-10.0);
    std::fs::write(&model_file, serde_json::to_vec(&modified).unwrap()).unwrap();
    for (endpoint, backend, _) in &replicas {
        let response = client
            .post(format!("{endpoint}/v1/feed"))
            .bearer_auth(TOKEN)
            .json(&json!({"request_id":"pinned","subject":"new","domains":["video"],"limit":2}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert_eq!(response.headers()["x-rank-model-sha256"], hash);
        if *backend != "catalog" {
            assert_eq!(response.headers()["x-recall-mode"], *backend);
        }
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["items"][0]["id"], "b");
    }
    let mut missing = Process(
        command(&catalog, &model_file, &hash, 0)
            .env_remove("VS_RANK_MODEL")
            .env_remove("VS_RANK_MODEL_SHA256")
            .env("VS_RECALL_BACKEND", "model-topk")
            .spawn()
            .unwrap(),
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = missing.0.try_wait().unwrap() {
                assert!(!status.success());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut rejected = Process(command(&catalog, &model_file, &hash, 0).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = rejected.0.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        assert!(Instant::now() < deadline, "篡改模型未及时被拒绝");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
