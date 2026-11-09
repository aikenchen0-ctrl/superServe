use std::{io, path::PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    learning::{PreferenceFeedback, RankTrainingSet, TrainingDataKind, TrainingSample},
    recommendation::{ProfileProjection, RecommendationRequest},
    training_split::TemporalSplitConfig,
};
use vs_service::{
    domain_audit::DomainAuditConfig,
    learning_evidence::PinnedEvidenceFile,
    rank_model::train_and_publish_temporal_rank_model,
    temporal_replay::{
        HoldoutWindow, TemporalReplayConfig, TemporalReplayReceipt, replay_temporal_holdout,
    },
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct Fixture {
    directory: tempfile::TempDir,
    catalog: Vec<u8>,
    source: RankTrainingSet,
    config: TemporalReplayConfig,
}

impl Fixture {
    fn new() -> Self {
        let domains = ["article", "service", "video"];
        let catalog = PublicCatalog {
            version: "temporal-replay-fixture".into(),
            items: domains
                .iter()
                .flat_map(|domain| {
                    [("low", 0.1), ("high", 0.9)].map(|(id, prior)| Candidate {
                        id: format!("{domain}-{id}"),
                        domain: (*domain).into(),
                        tags: vec!["topic".into()],
                        prior,
                        media_sha256: None,
                    })
                })
                .collect(),
            assets: vec![],
        };
        let catalog = serde_json::to_vec(&catalog).unwrap();
        let mut samples = Vec::new();
        for (start, rounds) in [(10, 40), (1000, 1), (2000, 1)] {
            for round in 0..rounds {
                for domain in domains {
                    let exposed = start + samples.len() as u64;
                    let request = RecommendationRequest {
                        request_id: format!("decision-{start}-{round}-{domain}"),
                        domains: vec![domain.into()],
                        limit: 1,
                        profile: Some(ProfileProjection {
                            subject: "private-subject".into(),
                            version: "p1".into(),
                            scopes: vec![domain.into()],
                            expires_at: 10_000,
                            interests: vec![],
                            blocked_ids: vec![],
                            denied_tags: vec![],
                        }),
                    };
                    for (suffix, feedback) in [
                        ("low", PreferenceFeedback::Like),
                        ("high", PreferenceFeedback::Dislike),
                    ] {
                        let number = samples.len();
                        samples.push(TrainingSample {
                            exposure_id: format!("exposure-{number}"),
                            evidence_ref: format!("feedback-{number}"),
                            profile_as_of: 1,
                            exposed_at: exposed,
                            feedback_at: exposed + 1,
                            chronology: None,
                            request: request.clone(),
                            candidate_id: format!("{domain}-{suffix}"),
                            feedback,
                        });
                    }
                }
            }
        }
        let source = RankTrainingSet {
            schema: "rank-training-v1".into(),
            data_kind: TrainingDataKind::Synthetic,
            catalog_sha256: hash(&catalog),
            catalog_as_of: 1,
            train_before: 3000,
            samples,
        };
        let split = TemporalSplitConfig {
            schema: "rank-temporal-split-v1".into(),
            train_before: 900,
            validation_before: 1900,
            embargo_seconds: 10,
        };
        let directory = tempfile::tempdir().unwrap();
        let pin = |name: &str, bytes: &[u8]| {
            std::fs::write(directory.path().join(name), bytes).unwrap();
            PinnedEvidenceFile {
                path: name.into(),
                sha256: hash(bytes),
            }
        };
        pin("catalog.json", &catalog);
        let source_pin = pin("source.json", &serde_json::to_vec(&source).unwrap());
        let split_pin = pin("split.json", &serde_json::to_vec(&split).unwrap());
        let model_path = directory.path().join("model.json");
        let receipt = train_and_publish_temporal_rank_model(
            &catalog,
            &serde_json::to_vec(&source).unwrap(),
            &split,
            &model_path,
        )
        .unwrap();
        let config = TemporalReplayConfig {
            schema: "rank-temporal-replay-v1".into(),
            source: source_pin,
            split: split_pin,
            model: PinnedEvidenceFile {
                path: "model.json".into(),
                sha256: receipt.sha256,
            },
            window: HoldoutWindow::Validation,
            domain_audit: Some(DomainAuditConfig {
                required_domains: domains.iter().map(|name| (*name).into()).collect(),
                minimum_positive_labels: 1,
                maximum_positive_coverage_drop_basis_points: 0,
            }),
        };
        Self {
            directory,
            catalog,
            source,
            config,
        }
    }

    fn repin_source(&mut self) {
        let bytes = serde_json::to_vec(&self.source).unwrap();
        std::fs::write(self.directory.path().join("source.json"), &bytes).unwrap();
        self.config.source.sha256 = hash(&bytes);
    }

    fn run(&self, name: &str) -> io::Result<(TemporalReplayReceipt, Value)> {
        let target = self.directory.path().join(name);
        let receipt =
            replay_temporal_holdout(self.directory.path(), &self.catalog, &self.config, &target)?;
        let bytes = std::fs::read(target)?;
        assert_eq!(receipt.report_sha256, hash(&bytes));
        assert_eq!(receipt.report_bytes, bytes.len());
        Ok((receipt, serde_json::from_slice(&bytes).unwrap()))
    }
}

#[test]
fn published_model_reproduction_compares_loaded_numbers_on_both_sides() {
    let fixture = Fixture::new();
    let catalog: PublicCatalog = serde_json::from_slice(&fixture.catalog).unwrap();
    let config: TemporalSplitConfig = serde_json::from_slice(
        &std::fs::read(fixture.directory.path().join("split.json")).unwrap(),
    )
    .unwrap();
    let split =
        vs_core::training_split::temporal_split(&catalog, &fixture.source, &config).unwrap();
    let trained = vs_core::learning::train_rank_model(&catalog, &split.training).unwrap();
    let encoded = serde_json::to_vec(&trained).unwrap();
    let published = std::fs::read(fixture.directory.path().join("model.json")).unwrap();
    assert_eq!(encoded, published);
    let expected: vs_core::learning::LinearRankModel = serde_json::from_slice(&encoded).unwrap();
    let loaded: vs_core::learning::LinearRankModel = serde_json::from_slice(&published).unwrap();
    for (index, (raw, roundtrip)) in expected.weights.iter().zip(&loaded.weights).enumerate() {
        assert_eq!(
            raw.to_bits(),
            roundtrip.to_bits(),
            "权重{index}的同格式读取不一致"
        );
    }
}

#[test]
fn fixed_window_reproduces_training_and_evaluates_full_catalog_with_manual_metrics() {
    let fixture = Fixture::new();
    let (receipt, report) = fixture.run("validation.json").unwrap();
    assert_eq!(receipt.queries, 3);
    assert!(receipt.training_reproduction_verified);
    assert_eq!(report["model_trained_before"], 900);
    assert_eq!(report["split_audit"]["retained"]["training"], 240);
    assert_eq!(report["split_audit"]["retained"]["validation"], 6);
    assert_eq!(report["split_audit"]["retained"]["test"], 6);
    assert_eq!(report["baseline"]["macro_recall_at_k"], 0.0);
    assert_eq!(
        report["baseline"]["counts"]["explicit_negative_returned"],
        3
    );
    assert_eq!(report["model"]["macro_recall_at_k"], 1.0);
    assert_eq!(report["model"]["macro_ndcg_at_k"], 1.0);
    assert_eq!(report["model"]["macro_mrr_at_k"], 1.0);
    for row in report["queries"].as_array().unwrap() {
        assert_eq!(row["eligible_candidates"], 2);
        assert_eq!(row["explicit_labels"], 2);
        assert_eq!(row["model_partial_labels"]["hits"], 1);
    }
    assert_eq!(report["scope"]["historical_source_truth_verified"], false);
    assert_eq!(report["scope"]["unbiased_policy_evaluation"], false);
    assert_eq!(report["scope"]["production_gate_passed"], false);
    assert!(
        !serde_json::to_string(&report)
            .unwrap()
            .contains("private-subject")
    );
    export_cli_fixture(&fixture);
}

#[test]
fn future_test_labels_do_not_change_validation_metrics_or_reproduced_training() {
    let mut fixture = Fixture::new();
    let (_, before) = fixture.run("before.json").unwrap();
    for sample in &mut fixture.source.samples {
        if sample.exposed_at >= 2000 {
            sample.feedback = match sample.feedback {
                PreferenceFeedback::Like => PreferenceFeedback::Dislike,
                PreferenceFeedback::Dislike => PreferenceFeedback::Like,
            };
        }
    }
    fixture.repin_source();
    let (_, after) = fixture.run("after.json").unwrap();
    for key in [
        "queries",
        "model",
        "baseline",
        "training_canonical_sha256",
        "domain_audit",
    ] {
        assert_eq!(before[key], after[key], "{key}");
    }
    assert_ne!(before["source_sha256"], after["source_sha256"]);
    fixture.config.window = HoldoutWindow::Test;
    let (receipt, test) = fixture.run("test.json").unwrap();
    assert_eq!(test["window"], "test");
    assert_eq!(test["baseline"]["macro_recall_at_k"], 1.0);
    assert_eq!(test["model"]["macro_recall_at_k"], 0.0);
    assert_eq!(receipt.domain_coverage_passed, Some(false));
}

#[test]
fn negative_only_queries_remain_counted_and_unknown_results_stay_unknown() {
    let mut fixture = Fixture::new();
    for sample in &mut fixture.source.samples {
        if (1000..1900).contains(&sample.exposed_at) {
            sample.feedback = PreferenceFeedback::Dislike;
        }
    }
    fixture.source.samples.retain(|sample| {
        !(1000..1900).contains(&sample.exposed_at) || !sample.candidate_id.ends_with("-low")
    });
    fixture.repin_source();
    let (receipt, report) = fixture.run("negative.json").unwrap();
    assert_eq!(receipt.queries, 3);
    assert_eq!(receipt.domain_coverage_passed, Some(false));
    assert!(report["model"]["macro_recall_at_k"].is_null());
    assert_eq!(report["model"]["counts"]["unjudged_returned"], 3);
    assert_eq!(
        report["baseline"]["counts"]["explicit_negative_returned"],
        3
    );
    assert_eq!(report["model"]["counts"]["queries_with_positive_labels"], 0);
}

#[test]
fn self_declared_cutoff_or_modified_weights_cannot_replace_training_reproduction() {
    let mut fixture = Fixture::new();
    let path = fixture.directory.path().join("model.json");
    let mut model: vs_core::learning::LinearRankModel =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    model.weights[0] += 0.01;
    let bytes = serde_json::to_vec(&model).unwrap();
    std::fs::write(path, &bytes).unwrap();
    fixture.config.model.sha256 = hash(&bytes);
    let error = fixture.run("tampered.json").unwrap_err();
    assert!(error.to_string().contains("重现"));
    assert!(!fixture.directory.path().join("tampered.json").exists());
}

#[test]
fn modified_training_labels_with_a_valid_new_source_pin_reject_the_old_model() {
    let mut fixture = Fixture::new();
    fixture.source.samples[0].feedback = PreferenceFeedback::Dislike;
    fixture.repin_source();
    let error = fixture.run("changed-training.json").unwrap_err();
    assert!(error.to_string().contains("重现"));
    assert!(
        !fixture
            .directory
            .path()
            .join("changed-training.json")
            .exists()
    );
}

#[test]
fn typed_model_equality_accepts_whitespace_changes_without_relaxing_weight_checks() {
    let mut fixture = Fixture::new();
    let path = fixture.directory.path().join("model.json");
    let original = std::fs::read(&path).unwrap();
    let mut bytes = b" \n".to_vec();
    bytes.extend(&original);
    bytes.extend(b"\n ");
    std::fs::write(&path, &bytes).unwrap();
    fixture.config.model.sha256 = hash(&bytes);
    let (receipt, _) = fixture.run("whitespace.json").unwrap();
    assert!(receipt.training_reproduction_verified);
}

#[test]
fn multi_domain_decision_uses_one_shared_top_k_and_keeps_global_positive_denominator() {
    let mut fixture = Fixture::new();
    let mut request = fixture.source.samples[240].request.clone();
    request.request_id = "mixed-domain-decision".into();
    request.domains = vec!["article".into(), "service".into(), "video".into()];
    request.profile.as_mut().unwrap().scopes = request.domains.clone();
    request.limit = 2;
    for sample in &mut fixture.source.samples[240..246] {
        sample.request = request.clone();
    }
    fixture.repin_source();
    let (receipt, report) = fixture.run("mixed.json").unwrap();
    assert_eq!(receipt.queries, 1);
    let row = &report["queries"][0];
    assert_eq!(row["eligible_candidates"], 6);
    assert_eq!(row["explicit_labels"], 6);
    assert_eq!(row["model_ids"].as_array().unwrap().len(), 2);
    assert_eq!(row["model_partial_labels"]["positive_labels"], 3);
    assert_eq!(row["model_partial_labels"]["hits"], 2);
    let recall = row["model_partial_labels"]["recall_at_k"].as_f64().unwrap();
    assert!((recall - 2.0 / 3.0).abs() < 1e-12);
    for domain in report["domain_audit"]["rows"].as_array().unwrap() {
        assert_eq!(domain["multi_domain_requests"], 1);
    }
}

#[test]
fn mismatched_frozen_requests_in_one_decision_are_not_silently_ranked_using_first_sample() {
    let mut fixture = Fixture::new();
    let sample = fixture
        .source
        .samples
        .iter_mut()
        .find(|sample| (1000..1900).contains(&sample.exposed_at))
        .unwrap();
    sample.request.limit = 2;
    fixture.repin_source();
    assert!(
        fixture
            .run("mismatch.json")
            .unwrap_err()
            .to_string()
            .contains("不一致")
    );
    assert!(!fixture.directory.path().join("mismatch.json").exists());
}

#[test]
fn pin_path_config_and_catalog_failures_never_publish_partial_reports() {
    for failure in ["digest", "path", "schema", "catalog", "split"] {
        let mut fixture = Fixture::new();
        match failure {
            "digest" => fixture.config.source.sha256 = "0".repeat(64),
            "path" => fixture.config.source.path = PathBuf::from("../source.json"),
            "schema" => fixture.config.schema = "unsupported".into(),
            "catalog" => fixture.catalog.push(b' '),
            "split" => fixture.config.split.sha256 = "0".repeat(64),
            _ => unreachable!(),
        }
        assert!(fixture.run("rejected.json").is_err(), "{failure}");
        assert!(!fixture.directory.path().join("rejected.json").exists());
    }
}

#[test]
fn reports_are_deterministic_without_overwrite_and_optional_audit_stays_optional() {
    let mut fixture = Fixture::new();
    fixture.config.domain_audit = None;
    let (first, _) = fixture.run("first.json").unwrap();
    let (second, report) = fixture.run("second.json").unwrap();
    assert_eq!(first.report_sha256, second.report_sha256);
    assert_eq!(second.domain_coverage_passed, None);
    assert!(report["domain_audit"].is_null());
    assert!(fixture.run("first.json").is_err());
    assert_eq!(
        hash(&std::fs::read(fixture.directory.path().join("first.json")).unwrap()),
        first.report_sha256
    );
}

#[test]
fn query_budget_is_checked_before_full_catalog_scoring() {
    let mut fixture = Fixture::new();
    let prototype = fixture.source.samples[240].clone();
    let mut heldout = Vec::new();
    for index in 0..1001 {
        let mut sample = prototype.clone();
        sample.exposure_id = format!("budget-exposure-{index}");
        sample.evidence_ref = format!("budget-feedback-{index}");
        sample.request.request_id = format!("budget-decision-{index}");
        heldout.push(sample);
    }
    fixture.source.samples.splice(240..246, heldout);
    fixture.repin_source();
    let error = fixture.run("budget.json").unwrap_err();
    assert!(error.to_string().contains("1000"));
    assert!(!fixture.directory.path().join("budget.json").exists());
}

#[test]
#[ignore = "需先构建回放示例并设置VS_TEST_TEMPORAL_REPLAYER绝对路径"]
fn independent_cli_distinguishes_success_diagnostic_failure_invalid_and_existing_report() {
    use std::process::{Command, Stdio};

    let mut fixture = Fixture::new();
    let binary = PathBuf::from(std::env::var_os("VS_TEST_TEMPORAL_REPLAYER").unwrap());
    assert!(
        binary.is_absolute() && binary.is_file(),
        "独立命令路径必须存在且为绝对路径"
    );
    let run = |config: &TemporalReplayConfig, name: &str| {
        let path = fixture.directory.path().join("replay-config.json");
        std::fs::write(&path, serde_json::to_vec(config).unwrap()).unwrap();
        let mut command = Command::new(&binary);
        command
            .args([
                fixture.directory.path().join("catalog.json"),
                path,
                fixture.directory.path().join(name),
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
    let success = run(&fixture.config, "cli-success.json");
    assert!(
        success.status.success(),
        "{}",
        String::from_utf8_lossy(&success.stderr)
    );
    let receipt: Value = serde_json::from_slice(&success.stdout).unwrap();
    let original = std::fs::read(fixture.directory.path().join("cli-success.json")).unwrap();
    assert_eq!(receipt["report_sha256"], hash(&original));
    assert_eq!(receipt["queries"], 3);
    let duplicate = run(&fixture.config, "cli-success.json");
    assert_eq!(duplicate.status.code(), Some(1));
    assert_eq!(
        std::fs::read(fixture.directory.path().join("cli-success.json")).unwrap(),
        original
    );
    let mut strict = fixture.config.clone();
    strict
        .domain_audit
        .as_mut()
        .unwrap()
        .minimum_positive_labels = 100;
    let diagnostic = run(&strict, "cli-strict.json");
    assert_eq!(diagnostic.status.code(), Some(2));
    let receipt: Value = serde_json::from_slice(&diagnostic.stdout).unwrap();
    assert_eq!(receipt["domain_coverage_passed"], false);
    let mut invalid = fixture.config.clone();
    invalid.source.sha256 = "0".repeat(64);
    let rejected = run(&invalid, "cli-rejected.json");
    assert_eq!(rejected.status.code(), Some(1));
    assert!(!fixture.directory.path().join("cli-rejected.json").exists());
    fixture.config.window = HoldoutWindow::Test;
    let test = run(&fixture.config, "cli-test.json");
    assert!(test.status.success());
    let receipt: Value = serde_json::from_slice(&test.stdout).unwrap();
    assert_eq!(receipt["window"], "test");
}

fn export_cli_fixture(fixture: &Fixture) {
    let Some(output) = std::env::var_os("VS_HOLDOUT_FIXTURE_EXPORT") else {
        return;
    };
    let output = PathBuf::from(output);
    assert!(
        output.is_absolute() && output.starts_with("O:/"),
        "夹具导出仅允许O盘绝对路径"
    );
    std::fs::create_dir(&output).unwrap();
    for name in ["catalog.json", "source.json", "split.json", "model.json"] {
        std::fs::copy(fixture.directory.path().join(name), output.join(name)).unwrap();
    }
    for (name, window) in [
        ("validation-config.json", HoldoutWindow::Validation),
        ("test-config.json", HoldoutWindow::Test),
    ] {
        let mut config = fixture.config.clone();
        config.window = window;
        std::fs::write(output.join(name), serde_json::to_vec(&config).unwrap()).unwrap();
    }
    let mut fail = fixture.config.clone();
    fail.domain_audit.as_mut().unwrap().minimum_positive_labels = 100;
    std::fs::write(
        output.join("strict-config.json"),
        serde_json::to_vec(&fail).unwrap(),
    )
    .unwrap();
    std::fs::write(
        output.join("invalid-config.json"),
        serde_json::to_vec(&json!({"schema":"invalid"})).unwrap(),
    )
    .unwrap();
}
