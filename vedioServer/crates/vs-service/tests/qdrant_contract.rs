use std::{
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::catalog::{Candidate, PublicCatalog};
use vs_service::{
    AppState, ProfileRemoteConfig, Role,
    qdrant_recall::{QdrantConfig, QdrantRecall},
    router,
};

const API_TOKEN: &str = "recall-contract-api-token-00000000000000";
const PROFILE_TOKEN: &str = "recall-contract-profile-token-00000000000";

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn serve(state: Arc<AppState>, role: Role) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router(state, role)).await.unwrap();
    });
    (endpoint, task)
}

async fn post(client: &Client, endpoint: &str, path: &str, body: &Value) -> reqwest::Response {
    client
        .post(format!("{endpoint}{path}"))
        .bearer_auth(API_TOKEN)
        .json(body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "需要 VS_TEST_QDRANT_BINARY 指向官方 Qdrant 1.20.0 二进制，单独执行真实索引合约"]
async fn real_qdrant_recall_shared_profile_exclusions_and_degradation() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let binary = std::env::var_os("VS_TEST_QDRANT_BINARY").expect("缺少真实 Qdrant 二进制路径");
    let binary = std::fs::canonicalize(binary).unwrap();
    let version = Command::new(&binary).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "qdrant 1.20.0"
    );
    let binary_sha256 = format!("{:x}", Sha256::digest(std::fs::read(&binary).unwrap()));
    let directory = tempfile::tempdir().unwrap();
    let storage_root = std::fs::canonicalize(directory.path()).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let server_log = directory.path().join("qdrant.log");
    let stdout = std::fs::File::create(&server_log).unwrap();
    let mut command = Command::new(&binary);
    command
        .current_dir(directory.path())
        .arg("--disable-telemetry")
        .env("QDRANT__SERVICE__HOST", "127.0.0.1")
        .env("QDRANT__SERVICE__HTTP_PORT", port.to_string())
        .env("QDRANT__SERVICE__GRPC_PORT", "0")
        .env("QDRANT__CLUSTER__ENABLED", "false")
        .env("QDRANT__STORAGE__STORAGE_PATH", storage_root.join("qdrant"))
        .env(
            "QDRANT__STORAGE__SNAPSHOTS_PATH",
            storage_root.join("snapshots"),
        )
        .env("QDRANT__SERVICE__API_KEY", "recall-test-qdrant-key")
        .stderr(Stdio::from(stdout.try_clone().unwrap()))
        .stdout(Stdio::from(stdout));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = Process(command.spawn().unwrap());
    let endpoint = format!("http://127.0.0.1:{port}");
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        assert!(
            process.0.try_wait().unwrap().is_none(),
            "真实 Qdrant 提前退出"
        );
        if client
            .get(format!("{endpoint}/readyz"))
            .header("api-key", "recall-test-qdrant-key")
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        assert!(Instant::now() < deadline, "真实 Qdrant 启动超时");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut items: Vec<_> = (0..160)
        .map(|i| Candidate {
            id: format!("prior-{i:03}"),
            domain: if i < 80 { "video" } else { "article" }.into(),
            tags: vec!["general".into()],
            prior: 0.9,
            media_sha256: None,
        })
        .collect();
    items.extend([
        Candidate {
            id: "tail-video".into(),
            domain: "video".into(),
            tags: vec!["rust".into()],
            prior: 0.1,
            media_sha256: None,
        },
        Candidate {
            id: "tail-article".into(),
            domain: "article".into(),
            tags: vec!["rust".into()],
            prior: 0.2,
            media_sha256: None,
        },
    ]);
    let catalog = PublicCatalog {
        version: "recall-contract-v1".into(),
        items,
        assets: vec![],
    };
    let bytes = serde_json::to_vec(&catalog).unwrap();
    let catalog_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let config = || QdrantConfig {
        endpoint: endpoint.clone(),
        api_key: Some("recall-test-qdrant-key".into()),
        scoring: vs_core::recall::RecallScoring::Positive,
    };
    let recall = QdrantRecall::new(config(), catalog_sha256.clone()).unwrap();
    let publication = recall.publish(&bytes).await;
    if publication.is_err() {
        eprintln!(
            "真实索引发布失败，服务端诊断：{}",
            std::fs::read_to_string(&server_log).unwrap()
        );
    }
    let receipt = publication.unwrap();
    assert_eq!(receipt["points"], 162);
    assert!(recall.publish(b"{}").await.is_err());
    // 版本化导入禁止覆盖已存在集合，查询只使用最后发布的别名。
    assert!(recall.publish(&bytes).await.is_err());
    let authority = Arc::new(
        AppState::new_with_profile_log(
            &bytes,
            None,
            PROFILE_TOKEN,
            2,
            1,
            Some(&directory.path().join("events.jsonl")),
        )
        .unwrap()
        .into_profile_authority()
        .unwrap(),
    );
    let (authority_url, authority_task) = serve(authority.clone(), Role::Profile).await;
    let api_state = || {
        Arc::new(
            AppState::new(&bytes, None, API_TOKEN, 2, 1)
                .unwrap()
                .with_profile_remote(ProfileRemoteConfig {
                    endpoint: authority_url.clone(),
                    token: PROFILE_TOKEN.into(),
                })
                .unwrap()
                .with_qdrant_recall(config())
                .unwrap(),
        )
    };
    let mut state_a = api_state();
    Arc::get_mut(&mut state_a)
        .unwrap()
        .verify_recall_publication(&bytes)
        .await
        .unwrap();
    let mut state_b = api_state();
    Arc::get_mut(&mut state_b)
        .unwrap()
        .verify_recall_publication(&bytes)
        .await
        .unwrap();
    let (api_a, task_a) = serve(state_a, Role::Api).await;
    let (api_b, task_b) = serve(state_b, Role::Api).await;
    let readiness: Value = client
        .get(format!("{api_a}/readyz"))
        .bearer_auth(API_TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(readiness["recall_readiness"]["points_verified"], 162);
    let feed = json!({"request_id":"recall-contract","subject":"user-a","domains":["video","article"],"limit":5});
    let cold = post(&client, &api_a, "/v1/feed", &feed).await;
    assert_eq!(cold.headers()["x-recall-mode"], "prior-cold");
    assert_eq!(cold.json::<Value>().await.unwrap()["considered"], 64);
    let like =
        json!({"event_id":"like-1","subject":"user-a","candidate_id":"tail-video","kind":"like"});
    assert!(
        post(&client, &api_a, "/v1/profile/events", &like)
            .await
            .status()
            .is_success()
    );
    let personalized = post(&client, &api_b, "/v1/feed", &feed).await;
    assert_eq!(personalized.headers()["x-recall-mode"], "qdrant-tags+prior");
    let personalized: Value = personalized.json().await.unwrap();
    assert_eq!(personalized["items"][0]["id"], "tail-article");
    assert_eq!(personalized["items"][1]["id"], "tail-video");
    assert_eq!(personalized["considered"], 66);
    assert_eq!(
        post(&client, &api_a, "/v1/feed", &feed)
            .await
            .json::<Value>()
            .await
            .unwrap(),
        personalized
    );
    client
        .put(format!("{endpoint}/collections/unrelated-index"))
        .header("api-key", "recall-test-qdrant-key")
        .json(&json!({
            "vectors":{},"sparse_vectors":{"tags":{}}
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let rebind = |collection: &str| {
        json!({"actions":[{
            "create_alias":{"collection_name":collection,"alias_name":recall.collection()}
        }]})
    };
    client
        .post(format!("{endpoint}/collections/aliases"))
        .header("api-key", "recall-test-qdrant-key")
        .json(&rebind("unrelated-index"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(recall.verify_published(&bytes).await.is_err());
    let pinned = post(&client, &api_a, "/v1/feed", &feed).await;
    assert_eq!(pinned.headers()["x-recall-mode"], "qdrant-tags+prior");
    assert_eq!(pinned.json::<Value>().await.unwrap(), personalized);
    client
        .post(format!("{endpoint}/collections/aliases"))
        .header("api-key", "recall-test-qdrant-key")
        .json(&rebind(&recall.physical_collection()))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let duplicate: Value = post(&client, &api_b, "/v1/profile/events", &like)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["profile_version"], "memory-1");
    let hide =
        json!({"event_id":"hide-1","subject":"user-a","candidate_id":"tail-video","kind":"hide"});
    assert!(
        post(&client, &api_b, "/v1/profile/events", &hide)
            .await
            .status()
            .is_success()
    );
    let hidden = post(&client, &api_a, "/v1/feed", &feed).await;
    assert_eq!(hidden.headers()["x-recall-mode"], "qdrant-tags+prior");
    let hidden: Value = hidden.json().await.unwrap();
    assert_eq!(hidden["considered"], 65);
    assert!(
        hidden["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != "tail-video")
    );
    let mut only_video = feed.clone();
    only_video["domains"] = json!(["video"]);
    let video = post(&client, &api_b, "/v1/feed", &only_video)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert!(
        video["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["domain"] == "video" && item["id"] != "tail-video")
    );
    let sparse_catalog = br#"{"version":"sparse-boundary","assets":[],"items":[
        {"id":"only-prior","domain":"service","tags":[],"prior":0.5,"media_sha256":null},
        {"id":"multi","domain":"article","tags":["c","a","b"],"prior":0.5,"media_sha256":null}
    ]}"#;
    let sparse_recall =
        QdrantRecall::new(config(), format!("{:x}", Sha256::digest(sparse_catalog))).unwrap();
    let sparse_publication = sparse_recall.publish(sparse_catalog).await;
    if sparse_publication.is_err() {
        eprintln!(
            "稀疏边界发布失败，服务端诊断：{}",
            std::fs::read_to_string(&server_log).unwrap()
        );
    }
    assert_eq!(
        sparse_publication.unwrap()["readiness"]["points_verified"],
        1
    );
    let empty_catalog = br#"{"version":"zero-index","assets":[],"items":[
        {"id":"only-prior","domain":"service","tags":[],"prior":0.5,"media_sha256":null}
    ]}"#;
    let empty_recall =
        QdrantRecall::new(config(), format!("{:x}", Sha256::digest(empty_catalog))).unwrap();
    let empty_publication = empty_recall.publish(empty_catalog).await;
    if empty_publication.is_err() {
        eprintln!(
            "空索引发布失败，服务端诊断：{}",
            std::fs::read_to_string(&server_log).unwrap()
        );
    }
    assert_eq!(
        empty_publication.unwrap()["readiness"]["points_verified"],
        0
    );
    // 实际修改一个向量而保持点数不变，排除“计数相同即可证明就绪”的错误推论。
    let point = format!(
        "{:x}",
        Sha256::digest(format!("{catalog_sha256}:tail-video"))
    );
    let point = format!(
        "{}-{}-{}-{}-{}",
        &point[..8],
        &point[8..12],
        &point[12..16],
        &point[16..20],
        &point[20..32]
    );
    let original: Value = client
        .post(format!(
            "{endpoint}/collections/{}/points",
            recall.physical_collection()
        ))
        .header("api-key", "recall-test-qdrant-key")
        .json(&json!({"ids":[point],"with_payload":true,"with_vector":true}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let mut changed = original["result"][0].clone();
    changed["vector"]["tags"] = json!({"indices":[0],"values":[0.75]});
    client
        .put(format!(
            "{endpoint}/collections/{}/points?wait=true",
            recall.physical_collection()
        ))
        .header("api-key", "recall-test-qdrant-key")
        .json(&json!({"points":[changed]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(
        recall
            .verify_published(&bytes)
            .await
            .unwrap_err()
            .contains("向量")
    );
    client
        .delete(format!(
            "{endpoint}/collections/{}",
            recall.physical_collection()
        ))
        .header("api-key", "recall-test-qdrant-key")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        client
            .get(format!("{api_a}/readyz"))
            .bearer_auth(API_TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(process);
    let degraded = post(&client, &api_b, "/v1/feed", &feed).await;
    assert_eq!(degraded.status(), StatusCode::OK);
    assert_eq!(degraded.headers()["x-recall-mode"], "prior-degraded");
    let degraded: Value = degraded.json().await.unwrap();
    assert_eq!(degraded["profile_version"], "memory-2");
    assert_eq!(degraded["considered"], 64);
    assert!(
        degraded["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != "tail-video")
    );
    for task in [task_a, task_b, authority_task] {
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }
    authority.drain_profile_writes().await;
    println!(
        "{}",
        json!({
            "schema":"qdrant-recall-contract-v1","passed":true,"qdrant_version":"1.20.0",
            "binary_sha256":binary_sha256,"publication":receipt,
            "catalog_items":162,"cold_considered":64,"personalized_considered":66,"hidden_considered":65,
            "degraded_considered":64,"shared_profile_version":"memory-2",
            "readiness_checks":{
                "payloads_and_vectors":162,"verified_api_replicas":2,
                "alias_rebinding_does_not_move_running_readers":true,
                "equal_count_vector_corruption_rejected":true,
                "three_tag_float32_and_untagged_candidates":true,
                "empty_sparse_index":true,"deleted_collection_is_not_ready":true
            },
            "physical_cluster_tested":false,"recommendation_quality_measured":false
        })
    );
}
