use std::{
    path::{Path, PathBuf},
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
use vs_core::learning::TrainingDataKind;
use vs_service::{
    AppState, Role,
    evidence_replay::{
        EvidenceReplayConfig, EvidenceReplayReceipt, RecallAuditConfig, replay_model_evidence,
    },
    learning_evidence::{EvidenceExportManifest, PinnedEvidenceFile},
    router,
};

const TOKEN: &str = "model-recall-audit-contract-token-000000";

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Fixture {
    directory: tempfile::TempDir,
    catalog: Vec<u8>,
    manifest: EvidenceExportManifest,
    config: EvidenceReplayConfig,
}

impl Fixture {
    fn run(&self, name: &str) -> (EvidenceReplayReceipt, Value) {
        let path = self.directory.path().join(name);
        let receipt = replay_model_evidence(
            self.directory.path(),
            &self.catalog,
            &self.manifest,
            &self.config,
            &path,
        )
        .unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(hash(&bytes), receipt.report_sha256);
        (receipt, serde_json::from_slice(&bytes).unwrap())
    }
}

async fn fixture(empty_only: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let items: Vec<_> = ["video", "article", "service"]
        .into_iter()
        .flat_map(|domain| {
            (0..600).map(move |i| {
                json!({
                    "id":format!("{domain}-{i:03}"),"domain":domain,"tags":["focus"],
                    "prior":1.0-i as f32/1000.0,"media_sha256":null
                })
            })
        })
        .collect();
    let catalog = serde_json::to_vec(&json!({
        "version":"recall-audit-contract",
        "items":items,
        "assets":[]
    }))
    .unwrap();
    let state = Arc::new(
        AppState::new(&catalog, None, TOKEN, 2, 1)
            .unwrap()
            .with_learning_journal(&directory.path().join("decisions.jsonl"), "audit-replica")
            .unwrap(),
    );
    let app = router(state.clone(), Role::Api);
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 120;
    let domains: Vec<Vec<&str>> = if empty_only {
        vec![vec!["unknown"]]
    } else {
        vec![
            vec!["video"],
            vec!["article"],
            vec!["service"],
            vec!["video", "article", "service"],
            vec!["unknown"],
        ]
    };
    for (index, domains) in domains.iter().enumerate() {
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/recommendations")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "request_id":format!("audit-{index}"),"domains":domains,"limit":10,
                            "profile":{"subject":"private-test-subject","version":"frozen",
                                "expires_at":expires,"scopes":domains,
                                "interests":[{"tag":"focus","weight":1.0}],
                                "blocked_ids":["video-599","article-599","service-599"],
                                "denied_tags":[]}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key("x-learning-decision-id"));
        let _ = to_bytes(response.into_body(), 65536).await.unwrap();
    }
    state.drain_learning_writes().await;
    drop(app);
    drop(state);
    let gateway = serde_json::to_vec(&json!({
        "schema":"gateway-learning-events-v1", "source_id":"audit-gateway",
        "data_kind":"synthetic", "events":[]
    }))
    .unwrap();
    std::fs::write(directory.path().join("gateway.json"), &gateway).unwrap();
    let mut weights = vec![0.0; 24];
    weights[1] = -5.0;
    let model = serde_json::to_vec(&json!({
        "schema":"ftrl-ranker-v1","feature_schema":"profile-candidate-6-v1",
        "objective":"explicit-preference-v1","catalog_version":"recall-audit-contract",
        "catalog_sha256":hash(&catalog),"data_kind":"synthetic","trained_before":1,
        "training_samples":2,"positive_samples":1,
        "domains":["article","service","video"],"weights":weights
    }))
    .unwrap();
    std::fs::write(directory.path().join("model.json"), &model).unwrap();
    let manifest = EvidenceExportManifest {
        schema: "learning-evidence-export-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: hash(&catalog),
        catalog_as_of: 1,
        train_before: expires + 1,
        decision_logs: vec![PinnedEvidenceFile {
            path: "decisions.jsonl".into(),
            sha256: hash(&std::fs::read(directory.path().join("decisions.jsonl")).unwrap()),
        }],
        gateway_source_id: "audit-gateway".into(),
        gateway_events: PinnedEvidenceFile {
            path: "gateway.json".into(),
            sha256: hash(&gateway),
        },
        excluded_subjects: vec![],
    };
    let config = EvidenceReplayConfig {
        schema: "model-evidence-replay-config-v1".into(),
        decisions_from: 1,
        model: PinnedEvidenceFile {
            path: "model.json".into(),
            sha256: hash(&model),
        },
        samples_per_query: 6,
        warmup_per_query: 0,
        recall_audit: Some(RecallAuditConfig {
            require_full_retention: true,
        }),
        domain_audit: None,
    };
    Fixture {
        directory,
        catalog,
        manifest,
        config,
    }
}

#[tokio::test]
async fn frozen_multidomain_decisions_expose_losses_without_labels_or_raw_profiles() {
    let mut fixture = fixture(false).await;
    let (receipt, report) = fixture.run("loss.json");
    assert!(receipt.exact);
    assert_eq!(receipt.recall_retention_passed, Some(false));
    assert_eq!(report["coverage"]["replayed_decisions"], 5);
    assert_eq!(report["coverage"]["unlabelled_queries"], 5);
    assert_eq!(report["recall_audit"]["evaluable_queries"], 4);
    assert_eq!(report["recall_audit"]["queries_losing_model_top_k"], 4);
    assert_eq!(report["recall_audit"]["model_top_k_total"], 40);
    assert_eq!(report["recall_audit"]["model_top_k_retained"], 0);
    for query in report["queries"].as_array().unwrap() {
        assert!(query["recall_audit"]["candidate_positive_label_coverage"].is_null());
        assert!(query["recall_audit"]["reranked_partial_labels"]["ndcg_at_k"].is_null());
        for missing in query["recall_audit"]["missing_model_top_k_ids"]
            .as_array()
            .unwrap()
        {
            let id = missing.as_str().unwrap();
            assert!(!id.ends_with("-599"));
            assert!(
                query["domains"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|domain| { id.starts_with(&format!("{}-", domain.as_str().unwrap())) })
            );
        }
    }
    assert!(!report.to_string().contains("private-test-subject"));
    fixture.config.recall_audit = None;
    let (old, legacy) = fixture.run("legacy.json");
    assert!(old.exact);
    assert_eq!(old.recall_retention_passed, None);
    assert!(legacy.get("recall_audit").is_none());
    assert!(
        !serde_json::to_value(&fixture.config)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("recall_audit")
    );
    assert_eq!(
        report["logical_catalog_pass_units"].as_u64().unwrap()
            - legacy["logical_catalog_pass_units"].as_u64().unwrap(),
        5 * 1800 * 2
    );
    let bytes = std::fs::read(fixture.directory.path().join("model.json")).unwrap();
    let mut model: Value = serde_json::from_slice(&bytes).unwrap();
    model["weights"][1] = json!(5.0);
    let bytes = serde_json::to_vec(&model).unwrap();
    std::fs::write(fixture.directory.path().join("positive.json"), &bytes).unwrap();
    fixture.config.model = PinnedEvidenceFile {
        path: "positive.json".into(),
        sha256: hash(&bytes),
    };
    fixture.config.recall_audit = Some(RecallAuditConfig {
        require_full_retention: true,
    });
    let (positive, report) = fixture.run("aligned.json");
    assert!(positive.exact);
    assert_eq!(positive.recall_retention_passed, Some(true));
    assert_eq!(report["recall_audit"]["micro_model_top_k_retention"], 1.0);
}

#[tokio::test]
async fn empty_results_do_not_vacuously_pass_retention_and_config_rejects_unknown_backend() {
    let fixture = fixture(true).await;
    let (receipt, report) = fixture.run("empty.json");
    assert!(receipt.exact);
    assert_eq!(receipt.recall_retention_passed, Some(false));
    assert_eq!(
        report["recall_audit"]["reason"],
        "no_eligible_model_results"
    );
    assert!(report["recall_audit"]["micro_model_top_k_retention"].is_null());
    let mut config = serde_json::to_value(&fixture.config).unwrap();
    config["recall_audit"]["backend"] = json!("qdrant");
    assert!(serde_json::from_value::<EvidenceReplayConfig>(config).is_err());
}

fn write_json(root: &Path, name: &str, value: &impl serde::Serialize) {
    std::fs::write(root.join(name), serde_json::to_vec(value).unwrap()).unwrap();
}

#[tokio::test]
#[ignore = "需要VS_TEST_EVIDENCE_REPLAYER；可用VS_TEST_RECALL_AUDIT_OUTPUT保存完整实验文件"]
async fn cli_strict_gate_preserves_failed_report_and_diagnostic_mode_remains_usable() {
    use std::process::{Command, Stdio};
    let fixture = fixture(false).await;
    let root = fixture.directory.path();
    std::fs::write(root.join("catalog.json"), &fixture.catalog).unwrap();
    write_json(root, "manifest.json", &fixture.manifest);
    write_json(root, "strict.json", &fixture.config);
    let mut diagnostic = fixture.config.clone();
    diagnostic
        .recall_audit
        .as_mut()
        .unwrap()
        .require_full_retention = false;
    write_json(root, "diagnostic.json", &diagnostic);
    let command = |config: &str, report: &str| {
        let mut command = Command::new(std::env::var_os("VS_TEST_EVIDENCE_REPLAYER").unwrap());
        command
            .args([
                root.join("catalog.json"),
                root.join("manifest.json"),
                root.join(config),
                root.join(report),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command.output().unwrap()
    };
    let failed = command("strict.json", "strict-report.json");
    std::fs::write(root.join("strict-stdout.json"), &failed.stdout).unwrap();
    std::fs::write(root.join("strict-stderr.log"), &failed.stderr).unwrap();
    assert_eq!(failed.status.code(), Some(2));
    let receipt: Value = serde_json::from_slice(&failed.stdout).unwrap();
    assert_eq!(receipt["exact"], true);
    assert_eq!(receipt["recall_retention_passed"], false);
    let before = std::fs::read(root.join("strict-report.json")).unwrap();
    assert_eq!(hash(&before), receipt["report_sha256"]);
    let repeated = command("strict.json", "strict-report.json");
    std::fs::write(root.join("repeat-stderr.log"), &repeated.stderr).unwrap();
    assert_eq!(repeated.status.code(), Some(1));
    assert_eq!(
        before,
        std::fs::read(root.join("strict-report.json")).unwrap()
    );
    let diagnostic = command("diagnostic.json", "diagnostic-report.json");
    std::fs::write(root.join("diagnostic-stdout.json"), &diagnostic.stdout).unwrap();
    std::fs::write(root.join("diagnostic-stderr.log"), &diagnostic.stderr).unwrap();
    assert!(diagnostic.status.success());
    let report: Value =
        serde_json::from_slice(&std::fs::read(root.join("strict-report.json")).unwrap()).unwrap();
    write_json(
        root,
        "cli-results.json",
        &json!({
            "schema":"model-recall-audit-cli-contract-v1",
            "strict_exit_code":2,"diagnostic_exit_code":0,"repeat_exit_code":1,
            "replayed_queries":5,"queries_losing_model_top_k":4,
            "unknown_feedback_not_negative":true,"raw_profiles_in_report":false,
            "gate":report["recall_audit"],
            "scope":"真实服务HTTP生成的合成决策日志与独立CLI；不是用户行为或物理集群"
        }),
    );
    if let Some(output) = std::env::var_os("VS_TEST_RECALL_AUDIT_OUTPUT") {
        let output = PathBuf::from(output);
        std::fs::create_dir(&output).unwrap();
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                std::fs::copy(entry.path(), output.join(entry.file_name())).unwrap();
            }
        }
    }
}
