use std::{
    path::Path,
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
use vs_core::{
    catalog::PublicCatalog,
    event_order::InteractionOrder,
    learning::{LinearRankModel, RankTrainingSet, TrainingDataKind},
};
use vs_service::{
    AppState, LearningCommitMode, Role,
    domain_audit::DomainAuditConfig,
    evidence_replay::{EvidenceReplayConfig, RecallAuditConfig, replay_model_evidence},
    learning_evidence::{
        EvidenceExportManifest, GatewayEventKind, GatewayLearningArchive, GatewayLearningEvent,
        PinnedEvidenceFile, export_training_evidence,
    },
    rank_model::train_and_publish_rank_model,
    router,
};

const TOKEN: &str = "learning-evidence-contract-token-00000000000";
const CATALOG: &[u8] = br#"{"version":"evidence-v1","items":[
    {"id":"video-a","domain":"video","tags":["rust"],"prior":0.8,"media_sha256":null},
    {"id":"article-b","domain":"article","tags":["storage"],"prior":0.2,"media_sha256":null}
],"assets":[]}"#;

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn state() -> AppState {
    AppState::new(CATALOG, None, TOKEN, 4, 1).unwrap()
}

async fn call(app: axum::Router, path: &str, body: Value) -> axum::response::Response {
    app.oneshot(
        Request::builder()
            .uri(path)
            .method("POST")
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
    )
    .await
    .unwrap()
}

async fn feed(app: axum::Router, subject: &str) -> String {
    let response = call(
        app,
        "/v1/feed",
        json!({
            "request_id":"client-retry-id","subject":subject,
            "domains":["video","article"],"limit":2
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    response.headers()["x-learning-decision-id"]
        .to_str()
        .unwrap()
        .into()
}

struct Fixture {
    directory: tempfile::TempDir,
    manifest: EvidenceExportManifest,
    archive: GatewayLearningArchive,
    ids: Vec<String>,
}

impl Fixture {
    fn replay_config(&self) -> EvidenceReplayConfig {
        let model = LinearRankModel {
            schema: "ftrl-ranker-v1".into(),
            feature_schema: "profile-candidate-6-v1".into(),
            objective: "explicit-preference-v1".into(),
            catalog_version: "evidence-v1".into(),
            catalog_sha256: hash(CATALOG),
            data_kind: TrainingDataKind::Synthetic,
            trained_before: 1,
            training_samples: 2,
            positive_samples: 1,
            domains: vec!["article".into(), "video".into()],
            weights: vec![0.0; 18],
        };
        let bytes = serde_json::to_vec(&model).unwrap();
        std::fs::write(self.directory.path().join("holdout-model.json"), &bytes).unwrap();
        EvidenceReplayConfig {
            schema: "model-evidence-replay-config-v1".into(),
            decisions_from: self.manifest.catalog_as_of,
            model: PinnedEvidenceFile {
                path: "holdout-model.json".into(),
                sha256: hash(&bytes),
            },
            samples_per_query: 6,
            warmup_per_query: 0,
            recall_audit: None,
            domain_audit: None,
        }
    }

    fn replay(
        &self,
        config: &EvidenceReplayConfig,
        name: &str,
    ) -> std::io::Result<vs_service::evidence_replay::EvidenceReplayReceipt> {
        replay_model_evidence(
            self.directory.path(),
            CATALOG,
            &self.manifest,
            config,
            &self.directory.path().join(name),
        )
    }

    fn write_gateway(&mut self) {
        let bytes = serde_json::to_vec(&self.archive).unwrap();
        std::fs::write(self.directory.path().join("gateway.json"), &bytes).unwrap();
        self.manifest.gateway_events.sha256 = hash(&bytes);
    }

    fn export(
        &self,
        name: &str,
    ) -> std::io::Result<vs_service::learning_evidence::EvidenceExportReceipt> {
        export_training_evidence(
            self.directory.path(),
            CATALOG,
            &self.manifest,
            &self.directory.path().join(name),
        )
    }

    fn journal(&self, index: usize) -> std::path::PathBuf {
        self.directory.path().join(format!("replica-{index}.jsonl"))
    }

    fn pin_journal(&mut self, index: usize) {
        self.manifest.decision_logs[index].sha256 =
            hash(&std::fs::read(self.journal(index)).unwrap());
    }
}

#[tokio::test]
async fn pinned_replay_keeps_unlabelled_decisions_filters_withdrawals_and_never_claims_unbiased_quality()
 {
    let mut fixture = fixture().await;
    fixture
        .archive
        .events
        .retain(|event| event.decision_id != fixture.ids[2]);
    fixture.write_gateway();
    let config = fixture.replay_config();
    let receipt = fixture.replay(&config, "replay.json").unwrap();
    assert!(receipt.exact);
    assert_eq!(receipt.queries, 2);
    let bytes = std::fs::read(fixture.directory.path().join("replay.json")).unwrap();
    assert_eq!(receipt.report_sha256, hash(&bytes));
    let report: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(report["coverage"]["input_decisions"], 3);
    assert_eq!(report["coverage"]["excluded_decisions"], 1);
    assert_eq!(report["coverage"]["unlabelled_queries"], 1);
    assert_eq!(report["coverage"]["issued_without_visibility"], 1);
    assert_eq!(report["coverage"]["explicit_labels"], 1);
    assert_eq!(report["scope"]["unbiased_policy_evaluation"], false);
    assert_eq!(report["scope"]["production_gate_passed"], false);
    assert!(!String::from_utf8(bytes).unwrap().contains("subject-a"));
    assert!(
        report["queries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|q| q.get("request").is_none())
    );
    let unlabelled = report["queries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|query| query["explicit_labels"] == 0)
        .unwrap();
    assert!(unlabelled["model_partial_labels"]["ndcg_at_k"].is_null());
    assert_eq!(unlabelled["measurements"].as_array().unwrap().len(), 6);
    assert!(fixture.replay(&config, "replay.json").is_err());
    fixture.archive.events.clear();
    fixture.write_gateway();
    let receipt = fixture.replay(&config, "zero-feedback.json").unwrap();
    assert!(receipt.exact);
    assert_eq!(receipt.queries, 2);
    assert!(fixture.export("no-training.json").is_err());
    fixture.manifest.excluded_subjects.push("subject-a".into());
    assert!(fixture.replay(&config, "all-excluded.json").is_err());
    assert!(!fixture.directory.path().join("all-excluded.json").exists());
}

#[tokio::test]
async fn recall_audit_keeps_explicit_labels_and_unknown_queries_separate() {
    let mut fixture = fixture().await;
    fixture
        .archive
        .events
        .retain(|event| event.decision_id != fixture.ids[2]);
    fixture.write_gateway();
    let mut config = fixture.replay_config();
    config.recall_audit = Some(RecallAuditConfig {
        require_full_retention: true,
    });
    let receipt = fixture.replay(&config, "audited.json").unwrap();
    assert!(receipt.exact);
    assert_eq!(receipt.recall_retention_passed, Some(true));
    let report: Value = serde_json::from_slice(
        &std::fs::read(fixture.directory.path().join("audited.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(report["recall_audit"]["micro_model_top_k_retention"], 1.0);
    let labelled = report["queries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|query| query["explicit_labels"] == 1)
        .unwrap();
    assert_eq!(labelled["recall_audit"]["explicit_positive_labels"], 1);
    assert_eq!(
        labelled["recall_audit"]["explicit_positive_labels_covered"],
        1
    );
    assert_eq!(
        labelled["recall_audit"]["candidate_positive_label_coverage"],
        1.0
    );
    let unknown = report["queries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|query| query["explicit_labels"] == 0)
        .unwrap();
    assert!(unknown["recall_audit"]["candidate_positive_label_coverage"].is_null());
    assert!(unknown["recall_audit"]["reranked_partial_labels"]["ndcg_at_k"].is_null());
}

#[tokio::test]
async fn domain_audit_keeps_unknowns_and_reports_small_domain_regression_separately_from_micro() {
    let mut fixture = fixture().await;
    fixture
        .archive
        .events
        .retain(|event| event.decision_id != fixture.ids[2]);
    fixture.write_gateway();
    let catalog: PublicCatalog = serde_json::from_slice(CATALOG).unwrap();
    let domains: Vec<_> = catalog
        .items
        .iter()
        .map(|item| item.domain.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    assert_eq!(domains, vec!["article".to_owned(), "video".to_owned()]);
    let mut config = fixture.replay_config();
    config.domain_audit = Some(DomainAuditConfig {
        required_domains: vec!["video".into()],
        minimum_positive_labels: 1,
        maximum_positive_coverage_drop_basis_points: 10_000,
    });
    let passing = fixture.replay(&config, "domain-audit.json").unwrap();
    assert_eq!(passing.domain_coverage_passed, Some(true));
    let report: Value = serde_json::from_slice(
        &std::fs::read(fixture.directory.path().join("domain-audit.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(report["domain_audit"]["production_gate_passed"], false);
    assert_eq!(report["domain_audit"]["online_policy_changed"], false);
    for row in report["domain_audit"]["rows"].as_array().unwrap() {
        assert_eq!(row["requests_in_scope"], 2);
        assert_eq!(row["multi_domain_requests"], 2);
        if row["domain"] == "video" {
            assert!(row["baseline_observed_positive_coverage"].is_number());
            assert!(row["model_observed_positive_coverage"].is_number());
            assert_eq!(row["reason"], "within_configured_bound");
        } else {
            assert!(row["baseline_observed_positive_coverage"].is_null());
            assert!(row["model_observed_positive_coverage"].is_null());
            assert_eq!(row["reason"], "not_required");
        }
    }
    let mut failing_config = config;
    failing_config.domain_audit = Some(DomainAuditConfig {
        required_domains: vec!["article".into()],
        minimum_positive_labels: 1,
        maximum_positive_coverage_drop_basis_points: 0,
    });
    let failing = fixture
        .replay(&failing_config, "domain-audit-article-gate.json")
        .unwrap();
    assert_eq!(failing.domain_coverage_passed, Some(false));
    let report: Value = serde_json::from_slice(
        &std::fs::read(
            fixture
                .directory
                .path()
                .join("domain-audit-article-gate.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let article = report["domain_audit"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["domain"] == "article")
        .unwrap();
    assert_eq!(article["explicit_positive_labels"], 0);
    assert_eq!(article["model"]["explicit_positive_returned"], 0);
    assert_eq!(article["reason"], "insufficient_positive_evidence");
    assert_eq!(article["positive_coverage_gate_passed"], false);
    assert_eq!(article["model_observed_positive_coverage"], Value::Null);
    assert!(failing.exact && !failing.domain_coverage_passed.unwrap());
}

#[tokio::test]
async fn replay_window_and_input_order_keep_decisions_stable_without_extending_label_cutoff() {
    let mut fixture = fixture().await;
    let mut config = fixture.replay_config();
    let record: Value = serde_json::from_str(
        std::fs::read_to_string(fixture.journal(0))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    config.decisions_from = record["envelope"]["payload"]["snapshot_at"]
        .as_u64()
        .unwrap();
    let count = |fixture: &Fixture, name: &str| {
        fixture.replay(&config, name).unwrap();
        let report: Value =
            serde_json::from_slice(&std::fs::read(fixture.directory.path().join(name)).unwrap())
                .unwrap();
        let queries: Vec<_> = report["queries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|query| {
                (
                    query["decision_id"].clone(),
                    query["model_partial_labels"].clone(),
                )
            })
            .collect();
        (report, queries)
    };
    let (before, queries) = count(&fixture, "window.json");
    assert_eq!(before["coverage"]["explicit_labels"], 2);
    assert_eq!(before["evidence"]["deferred_feedback"], 1);
    fixture.archive.events.reverse();
    fixture.manifest.decision_logs.reverse();
    fixture.write_gateway();
    let (_, reordered) = count(&fixture, "window-reordered.json");
    assert_eq!(queries, reordered);
    config.decisions_from = fixture.manifest.train_before - 1;
    // 夹具决策都早于窗口终点，不能为凑样本而回退到窗口外请求。
    assert!(fixture.replay(&config, "empty-window.json").is_err());
    assert!(!fixture.directory.path().join("empty-window.json").exists());
}

#[tokio::test]
async fn replay_rejects_temporal_leakage_tampering_and_invalid_budgets_before_publishing() {
    let fixture = fixture().await;
    let config = fixture.replay_config();
    let original = std::fs::read(fixture.directory.path().join("holdout-model.json")).unwrap();
    for mutation in 0..8 {
        let mut config = config.clone();
        match mutation {
            0 => {
                let mut document: LinearRankModel = serde_json::from_slice(&original).unwrap();
                document.trained_before = config.decisions_from + 1;
                let bytes = serde_json::to_vec(&document).unwrap();
                std::fs::write(fixture.directory.path().join("late-model.json"), &bytes).unwrap();
                config.model = PinnedEvidenceFile {
                    path: "late-model.json".into(),
                    sha256: hash(&bytes),
                };
            }
            1 => config.model.sha256 = "f".repeat(64),
            2 => config.model.path = "../outside.json".into(),
            3 => config.samples_per_query = 7,
            4 => config.warmup_per_query = 1,
            5 => config.decisions_from = fixture.manifest.train_before,
            6 => config.decisions_from = fixture.manifest.catalog_as_of - 1,
            _ => config.samples_per_query = 102,
        }
        let name = format!("invalid-replay-{mutation}.json");
        assert!(
            fixture.replay(&config, &name).is_err(),
            "第{mutation}类无效回放未被拒绝"
        );
        assert!(!fixture.directory.path().join(name).exists());
    }
    let gateway = fixture.directory.path().join("gateway.json");
    std::fs::write(&gateway, b"{}").unwrap();
    assert!(fixture.replay(&config, "tampered-gateway.json").is_err());
    assert!(
        !fixture
            .directory
            .path()
            .join("tampered-gateway.json")
            .exists()
    );
}

#[tokio::test]
#[ignore = "需要VS_TEST_EVIDENCE_REPLAYER指向已构建的replay_model_evidence示例"]
async fn independent_replay_cli_consumes_pinned_snapshot_and_preserves_no_overwrite_contract() {
    use std::process::{Command, Stdio};
    let fixture = ordered_fixture().await;
    let config = fixture.replay_config();
    let root = fixture.directory.path();
    std::fs::write(root.join("catalog.json"), CATALOG).unwrap();
    std::fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&fixture.manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("replay-config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let command = |report_name: &str| {
        let mut command = Command::new(std::env::var_os("VS_TEST_EVIDENCE_REPLAYER").unwrap());
        command.args([
            root.join("catalog.json"),
            root.join("manifest.json"),
            root.join("replay-config.json"),
            root.join(report_name),
        ]);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    };
    let output = command("cli-report.json").output().unwrap();
    assert!(
        output.status.success(),
        "独立回放命令失败：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["queries"], 2);
    assert_eq!(receipt["exact"], true);
    let before = std::fs::read(root.join("cli-report.json")).unwrap();
    assert_eq!(receipt["report_sha256"], hash(&before));
    assert!(
        !command("cli-report.json")
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(before, std::fs::read(root.join("cli-report.json")).unwrap());
    let mut guarded = fixture.replay_config();
    guarded.domain_audit = Some(DomainAuditConfig {
        required_domains: vec!["article".into()],
        minimum_positive_labels: 1,
        maximum_positive_coverage_drop_basis_points: 1_000,
    });
    std::fs::write(
        root.join("replay-config.json"),
        serde_json::to_vec(&guarded).unwrap(),
    )
    .unwrap();
    let guarded_output = command("cli-domain-gate.json").output().unwrap();
    assert_eq!(guarded_output.status.code(), Some(2));
    let receipt: Value = serde_json::from_slice(&guarded_output.stdout).unwrap();
    assert_eq!(receipt["exact"], true);
    assert_eq!(receipt["domain_coverage_passed"], false);
    let report: Value =
        serde_json::from_slice(&std::fs::read(root.join("cli-domain-gate.json")).unwrap()).unwrap();
    assert_eq!(report["domain_audit"]["gate_passed"], false);
    assert_eq!(report["domain_audit"]["production_gate_passed"], false);
}

async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut ids = Vec::new();
    let mut logs = Vec::new();
    for index in 0..2 {
        let path = directory.path().join(format!("replica-{index}.jsonl"));
        let state = Arc::new(
            state()
                .with_learning_journal_mode(
                    &path,
                    &format!("replica-{index}"),
                    if index == 0 {
                        LearningCommitMode::Single
                    } else {
                        LearningCommitMode::Grouped
                    },
                )
                .unwrap(),
        );
        let app = router(state.clone(), Role::Api);
        ids.push(feed(app.clone(), "subject-a").await);
        if index == 0 {
            ids.push(feed(app.clone(), "withdrawn").await);
        }
        state.drain_learning_writes().await;
        drop(app);
        drop(state);
        logs.push(PinnedEvidenceFile {
            path: path.file_name().unwrap().into(),
            sha256: hash(&std::fs::read(path).unwrap()),
        });
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let event =
        |id: &str, decision: &str, candidate: &str, subject: &str, at, kind| GatewayLearningEvent {
            event_id: id.into(),
            decision_id: decision.into(),
            subject: subject.into(),
            candidate_id: candidate.into(),
            at,
            kind,
            order: None,
        };
    let archive = GatewayLearningArchive {
        schema: "gateway-learning-events-v1".into(),
        source_id: "trusted-test-gateway".into(),
        data_kind: TrainingDataKind::Synthetic,
        events: vec![
            event(
                "like",
                &ids[0],
                "video-a",
                "subject-a",
                now + 2,
                GatewayEventKind::Like,
            ),
            event(
                "visible-video",
                &ids[0],
                "video-a",
                "subject-a",
                now + 1,
                GatewayEventKind::Visible,
            ),
            event(
                "visible-article",
                &ids[2],
                "article-b",
                "subject-a",
                now + 1,
                GatewayEventKind::Visible,
            ),
            event(
                "dislike",
                &ids[2],
                "article-b",
                "subject-a",
                now + 3,
                GatewayEventKind::Dislike,
            ),
            event(
                "unlabelled",
                &ids[0],
                "article-b",
                "subject-a",
                now + 1,
                GatewayEventKind::Visible,
            ),
            event(
                "withdrawn-visible",
                &ids[1],
                "video-a",
                "withdrawn",
                now + 1,
                GatewayEventKind::Visible,
            ),
            event(
                "withdrawn-like",
                &ids[1],
                "video-a",
                "withdrawn",
                now + 2,
                GatewayEventKind::Like,
            ),
            event(
                "late",
                &ids[0],
                "article-b",
                "subject-a",
                now + 100,
                GatewayEventKind::Like,
            ),
        ],
    };
    let manifest = EvidenceExportManifest {
        schema: "learning-evidence-export-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: hash(CATALOG),
        catalog_as_of: now.saturating_sub(60),
        train_before: now + 60,
        decision_logs: logs,
        gateway_source_id: archive.source_id.clone(),
        gateway_events: PinnedEvidenceFile {
            path: "gateway.json".into(),
            sha256: String::new(),
        },
        excluded_subjects: vec!["withdrawn".into()],
    };
    let mut fixture = Fixture {
        directory,
        manifest,
        archive,
        ids,
    };
    fixture
        .archive
        .events
        .push(fixture.archive.events[0].clone());
    fixture.write_gateway();
    fixture
}

async fn ordered_fixture() -> Fixture {
    let mut fixture = fixture().await;
    fixture.archive.schema = "gateway-learning-events-v2".into();
    let at = fixture
        .archive
        .events
        .iter()
        .find(|event| event.event_id == "visible-video")
        .unwrap()
        .at;
    for event in &mut fixture.archive.events {
        let (interaction, sequence, elapsed) = match event.event_id.as_str() {
            "visible-video" => ("video-interaction", 2, 300),
            "like" => ("video-interaction", 3, 650),
            "visible-article" => ("article-interaction", 1, 100),
            "dislike" => ("article-interaction", 2, 400),
            _ => continue,
        };
        event.at = at;
        event.order = Some(InteractionOrder {
            interaction_id: interaction.into(),
            generation: 1,
            sequence,
            elapsed_ms: elapsed,
        });
    }
    fixture.write_gateway();
    fixture
}

#[tokio::test]
async fn same_second_evidence_exports_trains_and_replays_with_original_utc_seconds() {
    let fixture = ordered_fixture().await;
    let receipt = fixture.export("same-second.json").unwrap();
    let bytes = std::fs::read(fixture.directory.path().join("same-second.json")).unwrap();
    let training: RankTrainingSet = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(training.schema, "rank-training-v2");
    assert_eq!(receipt.samples, 2);
    for sample in &training.samples {
        assert_eq!(sample.exposed_at, sample.feedback_at);
        assert!(sample.chronology.as_ref().unwrap().proves_order());
    }
    let model = fixture.directory.path().join("same-second-model.json");
    train_and_publish_rank_model(CATALOG, &bytes, &model).unwrap();
    let replay = fixture
        .replay(&fixture.replay_config(), "same-second-replay.json")
        .unwrap();
    assert!(replay.exact);
    println!(
        "{}",
        json!({
            "schema":"same-second-learning-contract-v1",
            "data_kind":"synthetic","samples":receipt.samples,
            "replayed_queries":replay.queries,"replay_exact":replay.exact,
            "utc_seconds_modified":false,"model_schema":"ftrl-ranker-v1",
            "native_devices_verified":false
        })
    );
}

#[tokio::test]
async fn reordered_and_legacy_enriched_duplicates_produce_identical_training_bytes() {
    let mut fixture = ordered_fixture().await;
    let mut legacy_duplicate = fixture
        .archive
        .events
        .iter()
        .find(|event| event.event_id == "like")
        .unwrap()
        .clone();
    legacy_duplicate.order = None;
    fixture.archive.events.push(legacy_duplicate);
    fixture.write_gateway();
    let first = fixture.export("ordered-a.json").unwrap();
    for rotation in 0..fixture.archive.events.len() {
        fixture.archive.events.rotate_left(1);
        if rotation % 2 == 0 {
            fixture.archive.events.reverse();
        }
        fixture.write_gateway();
        let next = fixture
            .export(&format!("permutation-{rotation}.json"))
            .unwrap();
        assert_eq!(next.training_sha256, first.training_sha256);
        assert_eq!(next.duplicate_events, 2);
    }
}

#[tokio::test]
async fn contradictory_causality_stream_reuse_and_implicit_schema_downgrades_fail_closed() {
    let mut fixture = ordered_fixture().await;
    let original = fixture.archive.clone();
    for mutation in 0..12 {
        fixture.archive = original.clone();
        match mutation {
            0 => {
                for event in &mut fixture.archive.events {
                    if event.event_id == "like" {
                        event.order = None;
                    }
                }
            }
            1 => fixture.archive.schema = "gateway-learning-events-v1".into(),
            2..=5 => {
                for event in &mut fixture.archive.events {
                    if event.event_id == "like" {
                        let order = event.order.as_mut().unwrap();
                        match mutation {
                            2 => order.sequence = 2,
                            3 => order.elapsed_ms = 100,
                            4 => order.generation = 2,
                            _ => order.interaction_id = "another-interaction".into(),
                        }
                    }
                }
            }
            6 => {
                fixture
                    .archive
                    .events
                    .iter_mut()
                    .find(|event| event.event_id == "visible-video")
                    .unwrap()
                    .subject = "other".into()
            }
            7 => {
                fixture
                    .archive
                    .events
                    .iter_mut()
                    .find(|event| event.event_id == "visible-video")
                    .unwrap()
                    .at += 1
            }
            8 => {
                fixture
                    .archive
                    .events
                    .last_mut()
                    .unwrap()
                    .order
                    .as_mut()
                    .unwrap()
                    .sequence += 10
            }
            9 => {
                fixture
                    .archive
                    .events
                    .iter_mut()
                    .find(|event| event.event_id == "visible-article")
                    .unwrap()
                    .order
                    .as_mut()
                    .unwrap()
                    .interaction_id = "video-interaction".into()
            }
            10 => {
                let mut collision = fixture
                    .archive
                    .events
                    .iter()
                    .find(|event| event.event_id == "visible-video")
                    .unwrap()
                    .clone();
                collision.event_id = "another-event-id".into();
                fixture.archive.events.push(collision);
            }
            _ => {
                let mut conflict = fixture
                    .archive
                    .events
                    .iter()
                    .find(|event| event.event_id == "like")
                    .unwrap()
                    .clone();
                conflict.order = None;
                conflict.at += 1;
                fixture.archive.events.push(conflict);
            }
        }
        fixture.write_gateway();
        let output = format!("invalid-order-{mutation}.json");
        assert!(
            fixture.export(&output).is_err(),
            "第{mutation}种冲突没有拒绝"
        );
        assert!(!fixture.directory.path().join(output).exists());
    }
}

#[tokio::test]
async fn different_device_streams_keep_strict_utc_fallback_but_cannot_infer_same_second_order() {
    let mut fixture = fixture().await;
    fixture.archive.schema = "gateway-learning-events-v2".into();
    let feedback_at = fixture
        .archive
        .events
        .iter()
        .find(|event| event.event_id == "like")
        .unwrap()
        .at;
    for event in &mut fixture.archive.events {
        match event.event_id.as_str() {
            "visible-video" => {
                event.order = Some(InteractionOrder {
                    interaction_id: "ios-view".into(),
                    generation: 1,
                    sequence: 1,
                    elapsed_ms: 100,
                })
            }
            "like" => {
                event.order = Some(InteractionOrder {
                    interaction_id: "android-feedback".into(),
                    generation: 1,
                    sequence: 20,
                    elapsed_ms: 10,
                })
            }
            _ => {}
        }
    }
    fixture.write_gateway();
    fixture.export("different-device-strict.json").unwrap();
    let bytes = std::fs::read(
        fixture
            .directory
            .path()
            .join("different-device-strict.json"),
    )
    .unwrap();
    let training: RankTrainingSet = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(training.schema, "rank-training-v1");
    assert!(
        training
            .samples
            .iter()
            .all(|sample| sample.chronology.is_none())
    );
    fixture
        .archive
        .events
        .iter_mut()
        .find(|event| event.event_id == "visible-video")
        .unwrap()
        .at = feedback_at;
    fixture.write_gateway();
    assert!(fixture.export("different-device-ambiguous.json").is_err());
    assert!(
        !fixture
            .directory
            .path()
            .join("different-device-ambiguous.json")
            .exists()
    );
}

#[tokio::test]
async fn unordered_gateway_events_join_two_replicas_without_inventing_negative_feedback() {
    let mut fixture = fixture().await;
    let receipt = fixture.export("training.json").unwrap();
    assert_eq!(receipt.samples, 2);
    assert_eq!(receipt.duplicate_events, 1);
    assert_eq!(receipt.excluded_events, 2);
    assert_eq!(receipt.deferred_feedback, 1);
    assert_eq!(receipt.visible_without_label, 1);
    let bytes = std::fs::read(fixture.directory.path().join("training.json")).unwrap();
    let training: RankTrainingSet = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(training.samples[0].request.request_id, fixture.ids[0]);
    assert_eq!(training.samples[1].request.request_id, fixture.ids[2]);
    assert_ne!(
        training.samples[0].exposure_id,
        training.samples[1].exposure_id
    );
    fixture.archive.events.reverse();
    fixture.write_gateway();
    fixture.manifest.decision_logs.reverse();
    fixture.export("reordered.json").unwrap();
    assert_eq!(
        bytes,
        std::fs::read(fixture.directory.path().join("reordered.json")).unwrap()
    );
    assert!(fixture.export("training.json").is_err());
    let model = fixture.directory.path().join("model.json");
    let receipt = train_and_publish_rank_model(CATALOG, &bytes, &model).unwrap();
    let model = std::fs::read(model).unwrap();
    // 此夹具将反馈及截止时间放在未来；可验证导出和训练，但尚不能作为当前模型启动。
    assert!(state().with_rank_model(&model, &receipt.sha256).is_err());
}

#[tokio::test]
async fn fabricated_cross_subject_unreturned_duplicate_and_future_sources_fail_without_output() {
    let fixture = fixture().await;
    for mutation in 0..9 {
        let mut manifest = fixture.manifest.clone();
        let mut archive = fixture.archive.clone();
        archive.events.pop();
        match mutation {
            0 => archive.events[0].subject = "other".into(),
            1 => archive.events[0].decision_id = "f".repeat(64),
            2 => archive.events[0].candidate_id = "not-returned".into(),
            3 => archive.events[1].at = 0,
            4 => archive.events[1].at = archive.events[0].at,
            5 => {
                archive.events.remove(1);
            }
            6 => {
                let mut event = archive.events[0].clone();
                event.event_id = "second-like".into();
                archive.events.push(event);
            }
            7 => {
                let mut event = archive.events[0].clone();
                event.kind = GatewayEventKind::Dislike;
                archive.events.push(event);
            }
            8 => archive.source_id = "untrusted-source".into(),
            _ => unreachable!(),
        }
        let bytes = serde_json::to_vec(&archive).unwrap();
        let file = fixture
            .directory
            .path()
            .join(format!("invalid-{mutation}.json"));
        std::fs::write(&file, &bytes).unwrap();
        manifest.gateway_events = PinnedEvidenceFile {
            path: file.file_name().unwrap().into(),
            sha256: hash(&bytes),
        };
        let target = fixture
            .directory
            .path()
            .join(format!("output-{mutation}.json"));
        assert!(
            export_training_evidence(fixture.directory.path(), CATALOG, &manifest, &target)
                .is_err(),
            "第{mutation}类无效证据未被拒绝"
        );
        assert!(!target.exists());
    }
}

#[test]
fn evidence_paths_cannot_escape_the_manifest_directory() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = b"{}";
    std::fs::write(directory.path().join("gateway.json"), bytes).unwrap();
    let mut manifest = EvidenceExportManifest {
        schema: "learning-evidence-export-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: hash(CATALOG),
        catalog_as_of: 1,
        train_before: 2,
        decision_logs: vec![PinnedEvidenceFile {
            path: "../outside.json".into(),
            sha256: hash(bytes),
        }],
        gateway_source_id: "gateway".into(),
        gateway_events: PinnedEvidenceFile {
            path: "gateway.json".into(),
            sha256: hash(bytes),
        },
        excluded_subjects: vec![],
    };
    for path in [
        std::path::PathBuf::from("../outside.json"),
        directory.path().join("gateway.json"),
    ] {
        manifest.decision_logs[0].path = path;
        let error = export_training_evidence(
            directory.path(),
            CATALOG,
            &manifest,
            &directory.path().join("output.json"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("来源路径"));
    }
}

#[tokio::test]
async fn pinned_sources_reject_rewriting_torn_tail_missing_records_and_duplicate_replica_names() {
    for mutation in 0..5 {
        let mut fixture = fixture().await;
        let path = fixture.journal(0);
        let original = std::fs::read(&path).unwrap();
        let changed = match mutation {
            0 => {
                let mut bytes = original.clone();
                bytes.push(b' ');
                bytes
            }
            1 => original[..original.len() - 1].to_vec(),
            2 => original
                .split_inclusive(|b| *b == b'\n')
                .skip(1)
                .flatten()
                .copied()
                .collect(),
            3 => {
                let mut line: Value =
                    serde_json::from_slice(original.split(|b| *b == b'\n').next().unwrap())
                        .unwrap();
                line["envelope"]["payload"]["subject"] = json!("forged");
                let mut bytes = serde_json::to_vec(&line).unwrap();
                bytes.push(b'\n');
                bytes
            }
            4 => original.clone(),
            _ => unreachable!(),
        };
        std::fs::write(&path, changed).unwrap();
        if mutation != 0 {
            fixture.pin_journal(0);
        }
        if mutation == 4 {
            fixture
                .manifest
                .decision_logs
                .push(fixture.manifest.decision_logs[0].clone());
        }
        assert!(fixture.export("should-not-exist.json").is_err());
        assert!(
            !fixture
                .directory
                .path()
                .join("should-not-exist.json")
                .exists()
        );
    }
}

#[tokio::test]
async fn journal_is_opt_in_exclusive_restartable_and_not_an_anonymous_exposure_claim() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("decisions.jsonl");
    let off = router(Arc::new(state()), Role::Api);
    let response = call(
        off,
        "/v1/feed",
        json!({
            "request_id":"off","subject":"subject","domains":["video"],"limit":1
        }),
    )
    .await;
    assert!(!response.headers().contains_key("x-learning-decision-id"));
    let logged = Arc::new(state().with_learning_journal(&path, "replica").unwrap());
    assert!(state().with_learning_journal(&path, "replica").is_err());
    let first = feed(router(logged.clone(), Role::Api), "subject").await;
    let response = call(
        router(logged.clone(), Role::Api),
        "/v1/recommendations",
        json!({
            "request_id":"anonymous","domains":["video"],"limit":1,"profile":null
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key("x-learning-decision-id"));
    drop(logged);
    let restarted = Arc::new(state().with_learning_journal(&path, "replica").unwrap());
    let second = feed(router(restarted.clone(), Role::Api), "subject").await;
    assert_ne!(first, second);
    restarted.drain_learning_writes().await;
    drop(restarted);
    let lines = std::fs::read_to_string(&path).unwrap();
    let records: Vec<Value> = lines
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 2);
    assert_eq!(records[1]["envelope"]["sequence"], 2);
    assert_eq!(
        records[1]["envelope"]["metadata"]["previous_decision_id"],
        first
    );
    assert!(
        state()
            .with_learning_journal(&path, "different-replica")
            .is_err()
    );
    assert!(
        state()
            .with_learning_journal(&path, "replica")
            .unwrap()
            .into_profile_authority()
            .is_err()
    );
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.pop();
    std::fs::write(&path, &bytes).unwrap();
    assert!(state().with_learning_journal(&path, "replica").is_err());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[tokio::test]
async fn export_refuses_active_writer_and_raw_profile_feedback_cannot_change_frozen_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("live.jsonl");
    let logged = Arc::new(
        state()
            .with_learning_journal(&path, "live-replica")
            .unwrap(),
    );
    let app = router(logged.clone(), Role::Api);
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let response = call(app.clone(), "/v1/recommendations", json!({
        "request_id":"projected","domains":["video"],"limit":1,
        "profile":{"subject":"subject","version":"frozen","scopes":["video"],"expires_at":expires,
            "interests":[{"tag":"rust","weight":0.75}],"blocked_ids":[],"denied_tags":[]}
    })).await;
    assert_eq!(response.status(), StatusCode::OK);
    let id = response.headers()["x-learning-decision-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let response = call(
        app,
        "/v1/profile/events",
        json!({
            "event_id":"later-feedback","subject":"subject","candidate_id":"video-a","kind":"hide"
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response_bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    assert!(
        serde_json::from_slice::<Value>(&response_bytes).unwrap()["accepted"]
            .as_bool()
            .unwrap()
    );
    logged.drain_learning_writes().await;
    drop(logged);
    let bytes = std::fs::read(&path).unwrap();
    let record: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(record["decision_id"], id);
    assert_eq!(
        record["envelope"]["payload"]["request"]["profile"]["interests"][0]["weight"],
        0.75
    );
    let manifest = EvidenceExportManifest {
        schema: "learning-evidence-export-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: hash(CATALOG),
        catalog_as_of: 1,
        train_before: expires + 1,
        decision_logs: vec![PinnedEvidenceFile {
            path: "live.jsonl".into(),
            sha256: hash(&bytes),
        }],
        gateway_source_id: "gateway".into(),
        gateway_events: PinnedEvidenceFile {
            path: "not-opened.json".into(),
            sha256: "f".repeat(64),
        },
        excluded_subjects: vec![],
    };
    let logged = Arc::new(
        state()
            .with_learning_journal(&path, "live-replica")
            .unwrap(),
    );
    let error = export_training_evidence(
        directory.path(),
        CATALOG,
        &manifest,
        &directory.path().join("no.json"),
    )
    .unwrap_err();
    assert!(error.to_string().contains("仍在写入"));
    logged.drain_learning_writes().await;
}

#[test]
fn journal_configuration_keeps_profile_authority_separate() {
    let directory = tempfile::tempdir().unwrap();
    let profile = AppState::new_with_profile_log(
        CATALOG,
        None,
        TOKEN,
        1,
        1,
        Some(&directory.path().join("profile.jsonl")),
    )
    .unwrap()
    .into_profile_authority()
    .unwrap();
    assert!(
        profile
            .with_learning_journal(Path::new("unused.jsonl"), "replica")
            .is_err()
    );
}
