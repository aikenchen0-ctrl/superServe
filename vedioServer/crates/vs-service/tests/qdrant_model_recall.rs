use std::{
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    recommendation::{Interest, ProfileProjection, RecommendationRequest},
};
use vs_service::{
    learning_evidence::PinnedEvidenceFile,
    model_recall_probe::{ModelRecallProbe, ModelRecallQuery, probe_model_recall},
    qdrant_model_recall::{ModelRecallResponse, QdrantModelRecall},
    qdrant_recall::QdrantConfig,
};

const KEY: &str = "model-recall-local-test-key";

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn save(root: &Path, name: &str, value: &impl serde::Serialize) {
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(root.join(name))
        .unwrap();
    file.write_all(&serde_json::to_vec_pretty(value).unwrap())
        .unwrap();
}

fn catalog() -> PublicCatalog {
    PublicCatalog {
        version: "model-aware-probe-v1".into(),
        items: ["video", "article", "service"]
            .into_iter()
            .flat_map(|domain| {
                (0..600).map(move |i| Candidate {
                    id: format!("{domain}-{i:03}"),
                    domain: domain.into(),
                    tags: match i % 6 {
                        0 => vec![],
                        1 => vec!["focus".into()],
                        2 => vec!["noise".into(), "focus".into()],
                        3 => vec!["denied".into()],
                        4 => vec!["focus".into(), "noise".into(), "quiet".into()],
                        _ => vec!["quiet".into()],
                    },
                    prior: 1.0 - i as f32 / 1000.0,
                    media_sha256: None,
                })
            })
            .collect(),
        assets: vec![],
    }
}

fn request(id: &str, domains: &[&str], profile: bool) -> RecommendationRequest {
    RecommendationRequest {
        request_id: id.into(),
        domains: domains.iter().map(|v| (*v).into()).collect(),
        limit: 10,
        profile: profile.then(|| ProfileProjection {
            subject: "synthetic-private-subject".into(),
            version: "frozen-v1".into(),
            scopes: domains.iter().map(|v| (*v).into()).collect(),
            expires_at: 200,
            interests: vec![
                Interest {
                    tag: "focus".into(),
                    weight: 0.8,
                },
                Interest {
                    tag: "noise".into(),
                    weight: -0.7,
                },
                Interest {
                    tag: "unseen".into(),
                    weight: 1.0,
                },
            ],
            blocked_ids: vec![
                "video-599".into(),
                "article-599".into(),
                "service-599".into(),
            ],
            denied_tags: vec!["denied".into()],
        }),
    }
}

fn model(catalog: &PublicCatalog, kind: &str, catalog_sha256: &str) -> LinearRankModel {
    let mut weights = vec![0.0; 24];
    match kind {
        "negative_prior" => weights[1] = -5.0,
        "positive_prior" => weights[1] = 5.0,
        "mixed" => {
            weights[..6].copy_from_slice(&[0.2, 1.0, 2.0, 4.0, 0.5, -0.3]);
            weights[7] = -2.0;
            weights[13] = 2.0;
            weights[19] = 0.5;
        }
        "near_f32_tie" => {
            weights[0] = 100.0;
            weights[1] = 1e-8;
        }
        "zero" => {}
        _ => unreachable!(),
    }
    LinearRankModel {
        schema: "ftrl-ranker-v1".into(),
        feature_schema: "profile-candidate-6-v1".into(),
        objective: "explicit-preference-v1".into(),
        catalog_version: catalog.version.clone(),
        catalog_sha256: catalog_sha256.into(),
        data_kind: TrainingDataKind::Synthetic,
        trained_before: 1,
        training_samples: 2,
        positive_samples: 1,
        domains: vec!["article".into(), "service".into(), "video".into()],
        weights,
    }
}

#[tokio::test]
#[ignore = "需要VS_TEST_QDRANT_BINARY，可用VS_TEST_MODEL_RECALL_OUTPUT保存不可覆盖的实验目录"]
async fn real_sparse_model_recall_reuses_one_index_across_models_and_keeps_precision_counterexamples()
 {
    let temporary = tempfile::tempdir().unwrap();
    let root = if let Some(path) = std::env::var_os("VS_TEST_MODEL_RECALL_OUTPUT") {
        let path = std::path::PathBuf::from(path);
        std::fs::create_dir(&path).unwrap();
        path
    } else {
        temporary.path().to_path_buf()
    };
    let binary = std::fs::canonicalize(std::env::var_os("VS_TEST_QDRANT_BINARY").unwrap()).unwrap();
    // 段文件嵌套较深；Windows实验存储使用短临时根，报告仍写入固定证据目录。
    let storage_root = tempfile::Builder::new()
        .prefix("mr")
        .tempdir_in(std::env::var_os("CARGO_TARGET_DIR").unwrap())
        .unwrap();
    let version = Command::new(&binary).arg("--version").output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "qdrant 1.20.0"
    );
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let output = std::fs::File::create(root.join("qdrant.log")).unwrap();
    let mut command = Command::new(&binary);
    command
        .current_dir(&root)
        .arg("--disable-telemetry")
        .env("QDRANT__SERVICE__HOST", "127.0.0.1")
        .env("QDRANT__SERVICE__HTTP_PORT", port.to_string())
        .env("QDRANT__SERVICE__GRPC_PORT", "0")
        .env("QDRANT__SERVICE__API_KEY", KEY)
        .env("QDRANT__CLUSTER__ENABLED", "false")
        .env(
            "QDRANT__STORAGE__STORAGE_PATH",
            storage_root.path().join("storage"),
        )
        .env(
            "QDRANT__STORAGE__SNAPSHOTS_PATH",
            storage_root.path().join("snapshots"),
        )
        .stdout(Stdio::from(output.try_clone().unwrap()))
        .stderr(Stdio::from(output));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = Process(command.spawn().unwrap());
    let process_id = process.0.id();
    let endpoint = format!("http://127.0.0.1:{port}");
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        assert!(
            process.0.try_wait().unwrap().is_none(),
            "真实Qdrant提前退出"
        );
        if http
            .get(format!("{endpoint}/readyz"))
            .header("api-key", KEY)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        assert!(Instant::now() < deadline, "真实Qdrant启动超时");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let catalog = catalog();
    let bytes = serde_json::to_vec(&catalog).unwrap();
    std::fs::write(root.join("catalog.json"), &bytes).unwrap();
    let fingerprint = hash(&bytes);
    let mut models = Vec::new();
    let mut model_kinds = Vec::new();
    for kind in [
        "negative_prior",
        "positive_prior",
        "mixed",
        "near_f32_tie",
        "zero",
    ] {
        let document = model(&catalog, kind, &fingerprint);
        let bytes = serde_json::to_vec(&document).unwrap();
        std::fs::write(root.join(format!("{kind}.json")), &bytes).unwrap();
        models.push(PinnedEvidenceFile {
            path: format!("{kind}.json").into(),
            sha256: hash(&bytes),
        });
        model_kinds.push((kind, hash(&bytes)));
    }
    let queries = vec![
        request("video-personal", &["video"], true),
        request("article-cold", &["article"], false),
        request("service-personal", &["service"], true),
        request("cross-domain", &["video", "article", "service"], true),
        request("empty-domain", &["unknown"], true),
    ]
    .into_iter()
    .map(|request| ModelRecallQuery { at: 100, request })
    .collect();
    let mut config = ModelRecallProbe {
        schema: "model-recall-probe-v1".into(),
        catalog: PinnedEvidenceFile {
            path: "catalog.json".into(),
            sha256: fingerprint.clone(),
        },
        models,
        queries,
        budgets: vec![10, 128, 512],
        publish: true,
        response_modes: vec![],
    };
    assert!(
        serde_json::to_value(&config)
            .unwrap()
            .get("response_modes")
            .is_none()
    );
    config.response_modes = if std::env::var_os("VS_TEST_MODEL_RECALL_COMPACT_FIRST").is_some() {
        vec![ModelRecallResponse::IdOnly, ModelRecallResponse::Payload]
    } else {
        vec![ModelRecallResponse::Payload, ModelRecallResponse::IdOnly]
    };
    save(&root, "probe.json", &config);
    let make_config = || QdrantConfig {
        endpoint: endpoint.clone(),
        api_key: Some(KEY.into()),
        scoring: Default::default(),
    };
    let receipt = probe_model_recall(
        &root,
        &config,
        make_config(),
        &root.join("probe-report.json"),
    )
    .await
    .unwrap();
    save(&root, "receipt.json", &receipt);
    let report_bytes = std::fs::read(root.join("probe-report.json")).unwrap();
    assert_eq!(hash(&report_bytes), receipt.report_sha256);
    let report: Value = serde_json::from_slice(&report_bytes).unwrap();
    assert_eq!(receipt.comparisons, 150);
    assert_eq!(report["response_equivalence"]["paired_groups"], 75);
    assert_eq!(report["response_equivalence"]["divergent_groups"], 0);
    let rows = report["comparisons"].as_array().unwrap();
    for pair in rows.chunks_exact(2) {
        assert_eq!(
            pair[0]["candidate_set_sha256"],
            pair[1]["candidate_set_sha256"]
        );
        assert_eq!(
            pair[0]["reranked_result_sha256"],
            pair[1]["reranked_result_sha256"]
        );
        let (full, compact) = if pair[0]["response_mode"] == "payload" {
            (&pair[0], &pair[1])
        } else {
            (&pair[1], &pair[0])
        };
        if full["candidates_received"].as_u64().unwrap() > 0 {
            assert!(
                compact["response_body_bytes"].as_u64().unwrap()
                    < full["response_body_bytes"].as_u64().unwrap()
            );
        }
        let selector_delta =
            serde_json::to_vec(&json!(["candidate_id", "catalog_sha256", "projection"]))
                .unwrap()
                .len()
                - serde_json::to_vec(&json!(false)).unwrap().len();
        assert_eq!(
            compact["request_body_bytes"].as_u64().unwrap() + selector_delta as u64,
            full["request_body_bytes"].as_u64().unwrap()
        );
    }
    let negative = &model_kinds[0].1;
    let rows = report["comparisons"].as_array().unwrap();
    assert!(
        rows.iter()
            .filter(|row| row["model_sha256"] == *negative && row["request_id"] == "video-personal")
            .all(|row| row["model_top_k_retention"] == 1.0)
    );
    assert!(
        rows.iter()
            .all(|row| row["rerank_f64_scores_preserved"] == true)
    );
    assert!(rows.iter().any(|row| row["negative_query_weights"] == true));
    assert!(
        rows.iter()
            .any(|row| row["model_sha256"] == model_kinds[3].1
                && row["model_top_k_retention"]
                    .as_f64()
                    .is_some_and(|v| v < 1.0)),
        "近分模型应暴露f32候选边界反例"
    );
    assert!(
        !String::from_utf8(report_bytes)
            .unwrap()
            .contains("synthetic-private-subject")
    );
    let mut cli_exits = None;
    config.publish = false;
    save(&root, "query-existing.json", &config);
    if let Some(binary) = std::env::var_os("VS_TEST_MODEL_RECALL_PROBE") {
        let run_cli = || {
            let mut command = Command::new(&binary);
            command
                .args([
                    root.join("query-existing.json"),
                    root.join("cli-report.json"),
                ])
                .env("VS_QDRANT_URL", &endpoint)
                .env("VS_QDRANT_API_KEY", KEY)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            command.output().unwrap()
        };
        let output = run_cli();
        std::fs::write(root.join("cli-stdout.json"), &output.stdout).unwrap();
        std::fs::write(root.join("cli-stderr.log"), &output.stderr).unwrap();
        assert_eq!(output.status.code(), Some(2), "漏召回应保留报告且退出2");
        let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
        let report = std::fs::read(root.join("cli-report.json")).unwrap();
        assert_eq!(hash(&report), receipt["report_sha256"]);
        let repeated = run_cli();
        std::fs::write(root.join("cli-repeat-stderr.log"), &repeated.stderr).unwrap();
        assert_eq!(repeated.status.code(), Some(1));
        assert_eq!(report, std::fs::read(root.join("cli-report.json")).unwrap());
        cli_exits = Some(json!({"loss_exit":2,"repeat_exit":1,"original_preserved":true}));
    }
    let mut pinned = QdrantModelRecall::new(make_config(), &bytes).unwrap();
    let document = model(&catalog, "negative_prior", &fingerprint);
    let ranker = LearnedRanker::new(&document, &catalog).unwrap();
    assert!(
        pinned
            .query(&config.queries[0].request, 100, &ranker, 128)
            .await
            .is_err()
    );
    pinned.verify().await.unwrap();
    assert!(pinned.publish().await.is_err(), "已有集合不能覆盖");
    // 发布冲突后必须显式重新校验，避免复用未确认的验证状态。
    assert!(
        pinned
            .query(&config.queries[0].request, 100, &ranker, 128)
            .await
            .is_err()
    );
    pinned.verify().await.unwrap();
    let before = pinned
        .query(&config.queries[0].request, 100, &ranker, 128)
        .await
        .unwrap();
    let collection = pinned.collection();
    let point_id = http
        .post(format!("{endpoint}/collections/{collection}/points/scroll"))
        .header("api-key", KEY)
        .json(&json!({"limit":1,"with_payload":true,"with_vector":false}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["result"]["points"][0]["id"]
        .clone();
    http.post(format!(
        "{endpoint}/collections/{collection}/points/payload?wait=true"
    ))
    .header("api-key", KEY)
    .json(&json!({"points":[point_id],"payload":{"projection":"corrupt"}}))
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap();
    assert!(pinned.verify().await.is_err(), "相同点数的属性篡改必须拒绝");
    assert!(
        pinned
            .query(&config.queries[0].request, 100, &ranker, 128)
            .await
            .is_err()
    );
    drop(process);
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
    );
    save(
        &root,
        "process-receipt.json",
        &json!({
            "schema":"qdrant-model-aware-recall-contract-v1",
            "date":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            "qdrant_version":"1.20.0","binary_sha256":hash(&std::fs::read(binary).unwrap()),
            "process_id":process_id,"port":port,"remaining_listener":false,
            "comparisons":150,"model_kinds":model_kinds,"candidate_count":1800,
            "response_modes":config.response_modes,
            "paired_response_groups":75,"response_divergences":0,
            "same_index_used_across_models":true,
        "independent_cli":cli_exits,
            "negative_prior_video_top_k_retention":1.0,
            "f32_near_tie_loss_observed":true,
            "points_in_validated_query":before.indices.len(),
            "unverified_query_rejected":true,"overwrite_rejected":true,
            "same_count_corruption_rejected":true,"corruption_invalidated_query":true,
            "physical_cluster":false,"production_admitted":false
        }),
    );
}
