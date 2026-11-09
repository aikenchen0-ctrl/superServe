use std::{
    collections::HashMap,
    io::Read,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::any,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vs_core::{recall::RecallScoring, recommendation::RecommendationRequest};
use vs_service::{
    AppState, Role,
    qdrant_recall::{QdrantConfig, QdrantRecall},
    router,
};

const TOKEN: &str = "readiness-service-token-0000000000000000";

struct Origin {
    mode: Mutex<&'static str>,
    fingerprint: String,
    points: HashMap<String, Value>,
    requests: Mutex<Vec<(String, Value)>>,
    alias_reads: AtomicUsize,
    entered: Semaphore,
    resume: Semaphore,
}

fn json_response(value: Value) -> Response {
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}

async fn request(State(origin): State<Arc<Origin>>, request: Request) -> Response {
    assert_eq!(request.headers()["api-key"], "readiness-key");
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or_default().to_string();
    let method = request.method().clone();
    assert!(
        matches!(method, Method::GET | Method::POST),
        "校验不得写入索引"
    );
    let body = axum::body::to_bytes(request.into_body(), 64 * 1024)
        .await
        .unwrap();
    let body: Value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    origin
        .requests
        .lock()
        .unwrap()
        .push((path.clone(), body.clone()));
    let mode = *origin.mode.lock().unwrap();
    let physical = format!("/collections/vs_build_{}", origin.fingerprint);
    assert!(path.starts_with(&physical), "查询和校验必须固定物理集合");
    if mode == "redirect" {
        return Response::builder()
            .status(307)
            .header("location", "/unexpected")
            .body(Body::empty())
            .unwrap();
    }
    if mode == "timeout" {
        return std::future::pending().await;
    }
    if mode == "oversize" {
        return Response::builder()
            .body(Body::from_stream(futures_util::stream::iter([
                Ok::<_, std::io::Error>(vec![b' '; 262_144]),
                Ok(vec![b' '; 1]),
            ])))
            .unwrap();
    }
    if mode == "invalid-json" {
        return Response::new(Body::from("{"));
    }
    if path.ends_with("/aliases") {
        let number = origin.alias_reads.fetch_add(1, Ordering::SeqCst);
        let collection = if mode == "wrong-alias" || (mode == "alias-changed" && number > 0) {
            "different-build".into()
        } else {
            format!("vs_build_{}", origin.fingerprint)
        };
        let alias = json!({"alias_name":format!("vs_tags_{}",origin.fingerprint), "collection_name":collection});
        return json_response(
            json!({"result":{"aliases":if mode == "duplicate-alias" {vec![alias.clone(),alias]} else {vec![alias]}}}),
        );
    }
    if path == physical {
        let mut value = json!({
            "status":"green","optimizer_status":"ok","points_count":9_999_999,
            "config":{"params":{"sparse_vectors":{"tags":{"index":{"datatype":"float32"}}}}},
            "payload_schema":{
                "candidate_id":{"data_type":"keyword"},"domain":{"data_type":"keyword"},
                "catalog_sha256":{"data_type":"keyword"},"tags":{"data_type":"keyword"}
            }
        });
        match mode {
            "yellow" | "grey" | "red" | "future-status" => value["status"] = json!(mode),
            "optimizer-error" => value["optimizer_status"] = json!({"error":"injected"}),
            "missing-field" => {
                value["payload_schema"]
                    .as_object_mut()
                    .unwrap()
                    .remove("domain");
            }
            "idf" => value["config"]["params"]["sparse_vectors"]["tags"]["modifier"] = json!("idf"),
            "float16" => {
                value["config"]["params"]["sparse_vectors"]["tags"]["index"]["datatype"] =
                    json!("float16")
            }
            "missing-sparse" => value["config"]["params"]["sparse_vectors"] = json!({}),
            "deferred" => value["update_queue"] = json!({"length":0,"deferred_points":1}),
            "pending-writes" => value["update_queue"] = json!({"length":1,"deferred_points":0}),
            "malformed-queue" => value["update_queue"] = json!({"length":"unknown"}),
            "invalid-queue-type" => value["update_queue"] = json!("unknown"),
            "missing-queue-length" => value["update_queue"] = json!({}),
            _ => {}
        }
        return json_response(json!({"result":value}));
    }
    if path.ends_with("/points/query") {
        assert_eq!(body["with_vector"], false);
        let payload = origin.points.values().next().unwrap()["payload"].clone();
        return json_response(json!({"result":{"points":[{"payload":payload}]}}));
    }
    assert!(query.contains("consistency=all") && query.contains("timeout=5"));
    if path.ends_with("/points/count") {
        assert_eq!(body, json!({"exact":true}));
        if mode == "gate-count" {
            origin.entered.add_permits(1);
            origin.resume.acquire().await.unwrap().forget();
        }
        return json_response(
            json!({"result":{"count":origin.points.len() + usize::from(mode == "wrong-count")}}),
        );
    }
    assert!(path.ends_with("/points"));
    assert_eq!(body["with_vector"], json!(["tags"]));
    assert_eq!(
        body["with_payload"],
        json!(["candidate_id", "domain", "tags", "catalog_sha256"])
    );
    let ids = body["ids"].as_array().unwrap();
    assert!(!ids.is_empty() && ids.len() <= 32);
    // 反向返回点，避免校验器偶然依赖响应顺序。
    let mut points: Vec<_> = ids
        .iter()
        .rev()
        .map(|id| origin.points[id.as_str().unwrap()].clone())
        .collect();
    if mode == "permuted" {
        for point in &mut points {
            point["payload"]["tags"].as_array_mut().unwrap().reverse();
            point["vector"]["tags"]["indices"]
                .as_array_mut()
                .unwrap()
                .reverse();
            point["vector"]["tags"]["values"]
                .as_array_mut()
                .unwrap()
                .reverse();
        }
    }
    match mode {
        "missing-point" => {
            points.pop();
        }
        "duplicate-point" => points[1] = points[0].clone(),
        "unknown-point" => points[0]["id"] = json!("unknown"),
        "wrong-domain" => points[0]["payload"]["domain"] = json!("different"),
        "wrong-candidate" => points[0]["payload"]["candidate_id"] = json!("different"),
        "wrong-fingerprint" => points[0]["payload"]["catalog_sha256"] = json!("f".repeat(64)),
        "wrong-tags" => points[0]["payload"]["tags"] = json!(["unpublished"]),
        "wrong-indices" => points[0]["vector"]["tags"]["indices"] = json!([1234]),
        "wrong-weights" => points[0]["vector"]["tags"]["values"] = json!([0.75]),
        "missing-vector" => points[0]["vector"] = json!({}),
        "extra-vector" => points[0]["vector"]["extra"] = json!({"indices":[0],"values":[1.0]}),
        _ => {}
    }
    json_response(json!({"result":points}))
}

struct Fixture {
    bytes: Vec<u8>,
    endpoint: String,
    origin: Arc<Origin>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.origin.resume.close();
        self.task.abort();
    }
}

impl Fixture {
    async fn new(tagged: usize) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut items: Vec<_> = (0..tagged).map(|index| {
            json!({
                "id":format!("item-{index:03}"),
                "domain":if index % 2 == 0 {"video"} else {"document"},
                "tags":match index % 3 {0=>vec!["beta","alpha"],1=>vec!["common"],_=>vec!["common","alpha","beta"]},
                "prior":0.5,"media_sha256":null
            })
        }).collect();
        items.push(
            json!({"id":"untagged","domain":"service","tags":[],"prior":0.5,"media_sha256":null}),
        );
        let bytes =
            serde_json::to_vec(&json!({"version":"readiness-v1","items":items,"assets":[]}))
                .unwrap();
        let fingerprint = format!("{:x}", Sha256::digest(&bytes));
        let points: HashMap<_, _> = items.iter().take(tagged).enumerate().map(|(index, item)| {
            let digest = format!("{:x}", Sha256::digest(format!("{fingerprint}:{}", item["id"].as_str().unwrap())));
            let id = format!("{}-{}-{}-{}-{}", &digest[..8], &digest[8..12], &digest[12..16], &digest[16..20], &digest[20..32]);
            let (indices, values) = match index % 3 {
                0 => (vec![0,1], vec![0.5,0.5]),
                1 => (vec![2], vec![1.0]),
                _ => (vec![0,1,2], vec![1.0_f32 / 3.0; 3]),
            };
            (id.clone(), json!({"id":id,"payload":{
                "candidate_id":item["id"],"domain":item["domain"],"tags":item["tags"],"catalog_sha256":fingerprint
            },"vector":{"tags":{"indices":indices,"values":values}}}))
        }).collect();
        let origin = Arc::new(Origin {
            mode: Mutex::new("normal"),
            fingerprint,
            points,
            requests: Mutex::new(Vec::new()),
            alias_reads: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            resume: Semaphore::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let routes = Router::new()
            .fallback(any(request))
            .with_state(origin.clone());
        let task = tokio::spawn(async { axum::serve(listener, routes).await.unwrap() });
        Self {
            bytes,
            endpoint,
            origin,
            task,
        }
    }

    fn mode(&self, mode: &'static str) {
        *self.origin.mode.lock().unwrap() = mode;
        self.origin.alias_reads.store(0, Ordering::SeqCst);
        self.origin.requests.lock().unwrap().clear();
    }

    fn config(&self) -> QdrantConfig {
        QdrantConfig {
            endpoint: self.endpoint.clone(),
            api_key: Some("readiness-key".into()),
            scoring: RecallScoring::Signed,
        }
    }

    fn recall(&self) -> QdrantRecall {
        QdrantRecall::new(self.config(), self.origin.fingerprint.clone()).unwrap()
    }
}

#[tokio::test]
async fn all_payloads_and_vectors_are_checked_in_bounded_batches_across_domains() {
    let fixture = Fixture::new(70).await;
    let recall = fixture.recall();
    let receipt = recall.verify_published(&fixture.bytes).await.unwrap();
    assert_eq!(receipt.points_verified, 70);
    assert_eq!(receipt.read_consistency, "all");
    let requests = fixture.origin.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(path, _)| path.ends_with("/points"))
            .count(),
        3
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(path, _)| path.ends_with("/points/count"))
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(path, _)| path.ends_with("/aliases"))
            .count(),
        2
    );
}

#[tokio::test]
async fn empty_tag_index_is_valid_and_approximate_counts_are_not_publication_evidence() {
    let fixture = Fixture::new(0).await;
    assert_eq!(
        fixture
            .recall()
            .verify_published(&fixture.bytes)
            .await
            .unwrap()
            .points_verified,
        0
    );
    assert!(
        !fixture
            .origin
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(path, _)| path.ends_with("/points"))
    );
}

#[tokio::test]
async fn yellow_and_grey_remain_queryable_but_red_optimizer_and_semantic_changes_are_rejected() {
    let fixture = Fixture::new(35).await;
    let recall = fixture.recall();
    for mode in ["green", "yellow", "grey", "permuted"] {
        fixture.mode(mode);
        recall.verify_published(&fixture.bytes).await.unwrap();
    }
    for mode in [
        "red",
        "future-status",
        "optimizer-error",
        "missing-field",
        "missing-sparse",
        "idf",
        "float16",
        "deferred",
        "pending-writes",
        "malformed-queue",
        "invalid-queue-type",
        "missing-queue-length",
    ] {
        fixture.mode(mode);
        assert!(
            recall.verify_published(&fixture.bytes).await.is_err(),
            "应拒绝状态：{mode}"
        );
    }
}

#[tokio::test]
async fn count_alias_and_each_content_corruption_fail_closed_without_any_write() {
    let fixture = Fixture::new(35).await;
    let recall = fixture.recall();
    for mode in [
        "wrong-count",
        "wrong-alias",
        "duplicate-alias",
        "alias-changed",
        "missing-point",
        "duplicate-point",
        "unknown-point",
        "wrong-domain",
        "wrong-candidate",
        "wrong-fingerprint",
        "wrong-tags",
        "wrong-indices",
        "wrong-weights",
        "missing-vector",
        "extra-vector",
    ] {
        fixture.mode(mode);
        assert!(
            recall.verify_published(&fixture.bytes).await.is_err(),
            "应拒绝内容：{mode}"
        );
    }
}

#[tokio::test]
async fn redirects_oversized_chunked_responses_malformed_json_and_timeouts_fail_closed() {
    let fixture = Fixture::new(35).await;
    let recall = fixture.recall();
    for mode in ["redirect", "oversize", "invalid-json", "timeout"] {
        fixture.mode(mode);
        assert!(
            recall.verify_published(&fixture.bytes).await.is_err(),
            "应拒绝响应：{mode}"
        );
        assert_eq!(fixture.origin.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn wrong_local_fingerprint_does_not_issue_a_network_request() {
    let fixture = Fixture::new(35).await;
    assert!(fixture.recall().verify_published(b"{}").await.is_err());
    assert!(fixture.origin.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn one_verification_owns_the_budget_and_cancellation_releases_it() {
    let fixture = Fixture::new(35).await;
    fixture.mode("gate-count");
    let recall = Arc::new(fixture.recall());
    let verifier = recall.clone();
    let bytes = fixture.bytes.clone();
    let pending = tokio::spawn(async move { verifier.verify_published(&bytes).await });
    tokio::time::timeout(Duration::from_secs(3), fixture.origin.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(recall.probe_ready().await.is_err());
    assert!(recall.verify_published(&fixture.bytes).await.is_err());
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    fixture.mode("normal");
    fixture.origin.resume.add_permits(1);
    recall.verify_published(&fixture.bytes).await.unwrap();
}

#[tokio::test]
async fn readiness_requires_full_startup_verification_then_uses_only_live_schema_probes() {
    let fixture = Fixture::new(35).await;
    let mut state = AppState::new(&fixture.bytes, None, TOKEN, 1, 1)
        .unwrap()
        .with_qdrant_recall(fixture.config())
        .unwrap();
    let app = router(Arc::new(state), Role::Api);
    use tower::ServiceExt;
    let ready_request = || {
        axum::http::Request::builder()
            .uri("/readyz")
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        app.oneshot(ready_request()).await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    state = AppState::new(&fixture.bytes, None, TOKEN, 1, 1)
        .unwrap()
        .with_qdrant_recall(fixture.config())
        .unwrap();
    state
        .verify_recall_publication(&fixture.bytes)
        .await
        .unwrap();
    fixture.mode("normal");
    let app = router(Arc::new(state), Role::Api);
    for _ in 0..3 {
        assert_eq!(
            app.clone().oneshot(ready_request()).await.unwrap().status(),
            StatusCode::OK
        );
    }
    {
        let requests = fixture.origin.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(
            requests
                .iter()
                .all(|(path, _)| !path.contains("/points") && !path.ends_with("/aliases"))
        );
    }
    fixture.mode("red");
    assert_eq!(
        app.oneshot(ready_request()).await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn normal_recommendation_query_is_pinned_without_extra_readiness_rpcs() {
    let fixture = Fixture::new(35).await;
    fixture.mode("wrong-alias");
    let recall = fixture.recall();
    let response = recall
        .query(
            &RecommendationRequest {
                request_id: "physical-query".into(),
                domains: vec!["video".into(), "document".into()],
                limit: 2,
                profile: None,
            },
            vec![0],
            vec![1.0],
        )
        .await;
    assert_eq!(response.unwrap().len(), 1);
    let requests = fixture.origin.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].0.ends_with("/points/query"));
}

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn service_process_rejects_corrupt_index_before_listening_and_starts_with_verified_pin() {
    let fixture = Fixture::new(35).await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("catalog.json");
    std::fs::write(&path, &fixture.bytes).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
        for name in [
            "VS_PUBLICATION_ROOT",
            "VS_PUBLICATION_BACKEND",
            "VS_CATALOG_RELEASE",
            "VS_PROFILE_EVENT_LOG",
            "VS_PROFILE_AUTHORITY_URL",
            "VS_PROFILE_AUTHORITY_TOKEN",
        ] {
            command.env_remove(name);
        }
        command
            .env("VS_CATALOG", &path)
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env("VS_ROLE", "api")
            .env("VS_SERVICE_TOKEN", TOKEN)
            .env("VS_RECALL_BACKEND", "qdrant")
            .env("VS_QDRANT_URL", &fixture.endpoint)
            .env("VS_QDRANT_API_KEY", "readiness-key")
            .env("VS_QDRANT_SCORING", "signed")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    };
    fixture.mode("wrong-weights");
    let mut invalid = Process(command().spawn().unwrap());
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(status) = invalid.0.try_wait().unwrap() {
                assert!(!status.success());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut diagnostics = String::new();
    invalid
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut diagnostics)
        .unwrap();
    assert!(
        diagnostics.contains("索引标签字典或向量权重不符"),
        "进程必须因内容校验拒绝启动"
    );
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    drop(listener);
    fixture.mode("normal");
    let mut valid = Process(command().spawn().unwrap());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            assert!(
                valid.0.try_wait().unwrap().is_none(),
                "已验证索引的服务进程提前退出"
            );
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/readyz"))
                .bearer_auth(TOKEN)
                .send()
                .await
                && response.status().is_success()
            {
                let receipt: Value = response.json().await.unwrap();
                assert_eq!(receipt["recall_readiness"]["points_verified"], 35);
                assert_eq!(
                    receipt["recall_readiness"]["catalog_sha256"],
                    fixture.origin.fingerprint
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}
