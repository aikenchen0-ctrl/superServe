use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;
use vs_core::slate::{POLICY_SCHEMA, SlatePolicy};
use vs_service::{AppState, Role, router};

const TOKEN: &str = "slate-test-service-token-00000000000000";
const CATALOG: &[u8] = br#"{"version":"slate-v1","assets":[],"items":[
{"id":"video-a","domain":"video","tags":["rust"],"prior":0.9,"media_sha256":null},
{"id":"video-b","domain":"video","tags":["rust"],"prior":0.8,"media_sha256":null},
{"id":"video-c","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
{"id":"article","domain":"article","tags":["storage"],"prior":0.6,"media_sha256":null},
{"id":"service","domain":"service","tags":["design"],"prior":0.5,"media_sha256":null}
]}"#;

fn policy(weight: u16) -> SlatePolicy {
    SlatePolicy {
        schema: POLICY_SCHEMA.into(),
        candidates_limit: 5,
        relevance_milli: weight,
    }
}

fn state() -> AppState {
    AppState::new(CATALOG, None, TOKEN, 2, 1).unwrap()
}

fn request(path: &str, value: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

fn body(feed: bool) -> Value {
    let mut value = json!({"request_id":"slate","domains":["video","article","service"],"limit":3});
    if feed {
        value["subject"] = json!("user");
    } else {
        value["profile"] = Value::Null;
    }
    value
}

async fn call(app: &Router, path: &str, value: Value) -> (StatusCode, bool, Value) {
    let response = app.clone().oneshot(request(path, value)).await.unwrap();
    let status = response.status();
    let selected = response
        .headers()
        .get("x-slate-policy")
        .is_some_and(|value| value == POLICY_SCHEMA);
    let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
    (status, selected, serde_json::from_slice(&bytes).unwrap())
}

fn ids(value: &Value) -> Vec<&str> {
    value["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn both_endpoints_default_to_original_order_and_opt_in_preserves_original_scores() {
    for feed in [false, true] {
        let path = if feed {
            "/v1/feed"
        } else {
            "/v1/recommendations"
        };
        let baseline = router(Arc::new(state()), Role::Api);
        let (status, selected, original) = call(&baseline, path, body(feed)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!selected);
        assert_eq!(ids(&original), ["video-a", "video-b", "video-c"]);
        let exact = router(
            Arc::new(state().with_slate_policy(policy(1000)).unwrap()),
            Role::Api,
        );
        let (status, selected, exact) = call(&exact, path, body(feed)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(selected);
        assert_eq!(exact, original);
        for grouped in [false, true] {
            let mut configured = state().with_slate_policy(policy(300)).unwrap();
            if grouped {
                configured = configured.with_grouped_recall().unwrap();
            }
            let app = router(Arc::new(configured), Role::Api);
            let (status, selected, value) = call(&app, path, body(feed)).await;
            assert_eq!(status, StatusCode::OK);
            assert!(selected);
            if !feed && grouped {
                // 无状态入口不走分组召回，但重排应保持一致。
                assert_eq!(value["ranker"], original["ranker"]);
            }
            assert_eq!(ids(&value), ["video-a", "article", "service"]);
            assert_eq!(value["items"][0], original["items"][0]);
            assert_eq!(value["ranker"], original["ranker"]);
            assert_eq!(value["considered"], 5);
        }
    }
}

#[tokio::test]
async fn hidden_items_domain_scopes_and_invalid_limits_are_not_bypassed_by_larger_pool() {
    let app = router(
        Arc::new(state().with_slate_policy(policy(300)).unwrap()),
        Role::Api,
    );
    let (status, _, _) = call(
        &app,
        "/v1/profile/events",
        json!({
            "event_id":"hide","subject":"user","candidate_id":"article","kind":"hide"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, value) = call(&app, "/v1/feed", body(true)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!ids(&value).contains(&"article"));
    assert_eq!(value["profile_version"], "memory-1");
    let mut only_video = body(true);
    only_video["domains"] = json!(["video"]);
    let (_, _, video) = call(&app, "/v1/feed", only_video).await;
    assert_eq!(ids(&video), ["video-a", "video-b", "video-c"]);
    for limit in [0, 51] {
        for feed in [false, true] {
            let mut value = body(feed);
            value["limit"] = json!(limit);
            let path = if feed {
                "/v1/feed"
            } else {
                "/v1/recommendations"
            };
            assert_eq!(call(&app, path, value).await.0, StatusCode::BAD_REQUEST);
        }
    }
    let mut denied = body(false);
    denied["profile"] = json!({
        "subject":"user","version":"external-1","scopes":["video","article","service"],
        "expires_at":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()+60,
        "interests":[],"blocked_ids":[],"denied_tags":["storage"]
    });
    let (status, _, denied_result) = call(&app, "/v1/recommendations", denied.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!ids(&denied_result).contains(&"article"));
    denied["profile"]["scopes"] = json!(["video"]);
    assert_eq!(
        call(&app, "/v1/recommendations", denied).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn model_and_model_top_k_keep_model_scores_when_slate_selection_is_enabled() {
    use sha2::{Digest, Sha256};
    let model = json!({
        "schema":"ftrl-ranker-v1","feature_schema":"profile-candidate-6-v1",
        "objective":"explicit-preference-v1","catalog_version":"slate-v1",
        "catalog_sha256":format!("{:x}",Sha256::digest(CATALOG)),"data_kind":"synthetic",
        "trained_before":1,"training_samples":4,"positive_samples":2,
        "domains":["article","service","video"],
        "weights":[0,1,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0, 0,0,0,0,0,0]
    });
    let bytes = serde_json::to_vec(&model).unwrap();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    for backend in ["full", "top-k", "pruned", "blockmax"] {
        let mut configured = state().with_rank_model(&bytes, &hash).unwrap();
        configured = match backend {
            "top-k" => configured.with_model_top_k().unwrap(),
            "pruned" => configured.with_model_pruned().unwrap(),
            "blockmax" => configured.with_model_blockmax().unwrap(),
            _ => configured,
        };
        let app = router(
            Arc::new(configured.with_slate_policy(policy(300)).unwrap()),
            Role::Api,
        );
        for feed in [false, true] {
            let path = if feed {
                "/v1/feed"
            } else {
                "/v1/recommendations"
            };
            let (status, selected, value) = call(&app, path, body(feed)).await;
            assert_eq!(status, StatusCode::OK);
            assert!(selected);
            assert_eq!(ids(&value), ["video-a", "article", "service"]);
            assert_eq!(value["ranker"], "ftrl-ranker-v1");
            assert_eq!(value["items"][0]["rank_score"], f64::from(0.9_f32));
        }
    }
}

struct Process(std::process::Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn real_binary_loads_policy_records_actual_order_and_rejects_invalid_configuration() {
    use sha2::{Digest, Sha256};
    use std::time::Duration;

    let _ = rustls::crypto::ring::default_provider().install_default();

    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("catalog.json");
    let decisions = directory.path().join("decisions.jsonl");
    std::fs::write(&catalog, CATALOG).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let start = |selected: &SlatePolicy, journal: bool| {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_vs-service"));
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(|key| key.starts_with("VS_")) {
                command.env_remove(key);
            }
        }
        command
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env("VS_ROLE", "api")
            .env("VS_SERVICE_TOKEN", TOKEN)
            .env("VS_CATALOG", &catalog)
            .env("VS_SLATE_POLICY", serde_json::to_string(selected).unwrap())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        if journal {
            command
                .env("VS_LEARNING_JOURNAL", &decisions)
                .env("VS_LEARNING_SOURCE_ID", "slate-process");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Process(command.spawn().unwrap())
    };
    let mut process = start(&policy(300), true);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let endpoint = format!("http://127.0.0.1:{port}");
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            assert!(
                process.0.try_wait().unwrap().is_none(),
                "列表实验服务提前退出"
            );
            if client
                .get(format!("{endpoint}/healthz"))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let ready: Value = client
        .get(format!("{endpoint}/readyz"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        ready["slate_policy"],
        serde_json::to_value(policy(300)).unwrap()
    );
    let response = client
        .post(format!("{endpoint}/v1/feed"))
        .bearer_auth(TOKEN)
        .json(&body(true))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(response.headers()["x-slate-policy"], POLICY_SCHEMA);
    let decision_id = response.headers()["x-learning-decision-id"]
        .to_str()
        .unwrap()
        .to_string();
    let result: Value = response.json().await.unwrap();
    assert_eq!(ids(&result), ["video-a", "article", "service"]);
    drop(process);
    let decision: Value = serde_json::from_slice(&std::fs::read(&decisions).unwrap()).unwrap();
    assert_eq!(decision["schema"], "learning-decision-v2");
    assert_eq!(decision["decision_id"], decision_id);
    assert_eq!(
        decision["envelope"]["metadata"]["slate_policy"],
        serde_json::to_value(policy(300)).unwrap()
    );
    assert_eq!(decision["envelope"]["payload"]["request"]["limit"], 3);
    assert_eq!(
        decision["envelope"]["payload"]["returned_ids"],
        json!(["video-a", "article", "service"])
    );
    let issued_at = decision["envelope"]["payload"]["issued_at"]
        .as_u64()
        .unwrap();
    let mut events = Vec::new();
    for (index, (candidate, label)) in [
        ("video-a", Some("like")),
        ("article", Some("dislike")),
        ("service", None),
    ]
    .into_iter()
    .enumerate()
    {
        events.push(json!({
            "event_id":format!("visible-{index}"),"decision_id":decision_id,"subject":"user",
            "candidate_id":candidate,"at":issued_at+1,"kind":"visible"
        }));
        if let Some(label) = label {
            events.push(json!({
                "event_id":format!("label-{index}"),"decision_id":decision_id,"subject":"user",
                "candidate_id":candidate,"at":issued_at+2,"kind":label
            }));
        }
    }
    let archive = serde_json::to_vec(&json!({
        "schema":"gateway-learning-events-v1","source_id":"test-gateway",
        "data_kind":"synthetic","events":events
    }))
    .unwrap();
    std::fs::write(directory.path().join("gateway.json"), &archive).unwrap();
    let manifest = serde_json::from_value(json!({
        "schema":"learning-evidence-export-v1","data_kind":"synthetic",
        "catalog_sha256":format!("{:x}",Sha256::digest(CATALOG)),
        "catalog_as_of":issued_at.saturating_sub(60),"train_before":issued_at+4,
        "decision_logs":[{"path":"decisions.jsonl","sha256":format!("{:x}",Sha256::digest(std::fs::read(&decisions).unwrap()))}],
        "gateway_source_id":"test-gateway","gateway_events":{"path":"gateway.json","sha256":format!("{:x}",Sha256::digest(&archive))},
        "excluded_subjects":[]
    })).unwrap();
    let exported = vs_service::learning_evidence::export_training_evidence(
        directory.path(),
        CATALOG,
        &manifest,
        &directory.path().join("training.json"),
    )
    .unwrap();
    assert_eq!(exported.samples, 2);
    assert_eq!(exported.visible_without_label, 1);
    let mut rejected = start(&policy(1001), false);
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = rejected.0.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(!status.success());
}

#[test]
fn invalid_duplicate_or_profile_authority_configuration_is_rejected() {
    assert!(state().with_slate_policy(policy(1001)).is_err());
    assert!(
        state()
            .with_slate_policy(policy(300))
            .unwrap()
            .with_slate_policy(policy(500))
            .is_err()
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("profiles.jsonl");
    let configured =
        AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap();
    assert!(
        configured
            .with_slate_policy(policy(300))
            .unwrap()
            .into_profile_authority()
            .is_err()
    );
    let configured =
        AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap();
    assert!(
        configured
            .into_profile_authority()
            .unwrap()
            .with_slate_policy(policy(300))
            .is_err()
    );
}
