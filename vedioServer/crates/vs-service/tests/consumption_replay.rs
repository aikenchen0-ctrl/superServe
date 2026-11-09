use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::learning::TrainingDataKind;
use vs_service::{
    consumption::ConsumptionBatch,
    consumption_replay::{ConsumptionReplayConfig, replay_consumption_evidence},
    feedback_evidence::{FeedbackEvidenceArchive, FeedbackEvidenceMessage},
    learning_evidence::PinnedEvidenceFile,
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn event(
    sequence: u64,
    elapsed_ms: u64,
    active: Option<u64>,
    waiting: Option<u64>,
    bytes: Option<u64>,
) -> Value {
    json!({
        "event_id":format!("event-{sequence}"),"sequence":sequence,
        "elapsed_ms":elapsed_ms,"observed_at":100+elapsed_ms/1000,
        "observation":{"kind":"progress","position_ms":elapsed_ms,
            "active_ms":active,"rebuffer_ms":waiting,"transferred_bytes":bytes,
            "byte_scope":"web_xhr_body"}
    })
}

fn batch(events: Vec<Value>) -> Value {
    json!({
        "schema":"client-consumption-v1","source_id":"gateway","data_kind":"synthetic",
        "platform":"web","subject":"private-viewer","decision_id":"a".repeat(64),
        "candidate_id":"private-candidate","interaction_id":"private-interaction",
        "generation":1,"events":events
    })
}

fn archive(payloads: &[Value]) -> FeedbackEvidenceArchive {
    FeedbackEvidenceArchive {
        schema: "feedback-evidence-v1".into(),
        source_id: "gateway".into(),
        data_kind: TrainingDataKind::Synthetic,
        stream_id: 0,
        topic_id: 0,
        partition_id: 0,
        start_offset: 20,
        end_offset_exclusive: 20 + payloads.len() as u64,
        captured_at: 10000,
        messages: payloads
            .iter()
            .enumerate()
            .map(|(index, payload)| {
                let bytes = serde_json::to_vec(payload).unwrap();
                let digest = Sha256::digest(&bytes);
                FeedbackEvidenceMessage {
                    offset: 20 + index as u64,
                    message_id: u128::from_be_bytes(digest[..16].try_into().unwrap()).to_string(),
                    payload_length: bytes.len(),
                    payload_sha256: hash(&bytes),
                    payload_base64: STANDARD.encode(bytes),
                }
            })
            .collect(),
    }
}

fn prepare(root: &Path, payloads: &[Value]) -> ConsumptionReplayConfig {
    let bytes = serde_json::to_vec(&archive(payloads)).unwrap();
    std::fs::write(root.join("evidence.json"), &bytes).unwrap();
    ConsumptionReplayConfig {
        schema: "consumption-replay-v1".into(),
        evidence: PinnedEvidenceFile {
            path: "evidence.json".into(),
            sha256: hash(&bytes),
        },
    }
}

fn report(payloads: &[Value]) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let config = prepare(directory.path(), payloads);
    let target = directory.path().join("report.json");
    let receipt = replay_consumption_evidence(directory.path(), &config, &target).unwrap();
    let bytes = std::fs::read(target).unwrap();
    assert_eq!(receipt.report_sha256, hash(&bytes));
    assert_eq!(receipt.report_bytes, bytes.len());
    serde_json::from_slice(&bytes).unwrap()
}

fn rejects(payloads: &[Value]) {
    let directory = tempfile::tempdir().unwrap();
    let config = prepare(directory.path(), payloads);
    let target = directory.path().join("report.json");
    assert!(replay_consumption_evidence(directory.path(), &config, &target).is_err());
    assert!(!target.exists());
}

#[test]
fn retry_and_out_of_order_batches_rebuild_one_stream_and_do_not_sum_cumulative_values() {
    let early = batch(vec![event(1, 1000, Some(400), Some(100), Some(1000))]);
    let late = batch(vec![event(2, 2000, Some(1000), Some(200), Some(4000))]);
    let output = report(&[late, early.clone(), early]);
    assert_eq!(output["coverage"]["input_events"], 3);
    assert_eq!(output["coverage"]["unique_events"], 2);
    assert_eq!(output["coverage"]["duplicate_events"], 1);
    let interaction = &output["interactions"][0];
    assert_eq!(interaction["active_ms"]["observed_delta"], 600);
    assert_eq!(interaction["rebuffer_ms"]["observed_delta"], 100);
    assert_eq!(interaction["transferred_bytes"]["observed_delta"], 3000);
    assert_eq!(interaction["transferred_bytes"]["baseline"], 1000);
    assert_eq!(interaction["transferred_bytes"]["samples"], 2);
    assert_eq!(interaction["active_ms"]["from_elapsed_ms"], 1000);
    assert_eq!(interaction["active_ms"]["to_elapsed_ms"], 2000);
    assert_eq!(interaction["missing_sequences"], json!([]));
    let text = serde_json::to_string(&output).unwrap();
    for secret in ["private-viewer", "private-candidate", "private-interaction"] {
        assert!(!text.contains(secret));
    }
}

#[test]
fn batching_boundaries_and_transport_order_do_not_change_reconstructed_observations() {
    let events: Vec<_> = (1..=12)
        .map(|index| {
            event(
                index,
                index * 1000,
                Some(index * 400),
                Some(index * 100),
                Some(index * 1000),
            )
        })
        .collect();
    let reference = report(&[batch(events.clone())]);
    for size in 1..=12 {
        let mut batches: Vec<_> = events
            .chunks(size)
            .map(|chunk| batch(chunk.to_vec()))
            .collect();
        batches.reverse();
        let output = report(&batches);
        assert_eq!(
            output["interactions"], reference["interactions"],
            "分批大小：{size}"
        );
    }
}

#[test]
fn native_platforms_keep_separate_metric_scopes_and_unknown_bytes() {
    let mut payloads = Vec::new();
    for (platform, scope) in [
        ("web", "web_xhr_body"),
        ("android", "android_data_source"),
        ("ios", "ios_access_log"),
    ] {
        for index in 1..=2 {
            let mut value = batch(vec![event(
                index,
                index * 1000,
                Some(index * 200),
                None,
                if platform == "ios" {
                    None
                } else {
                    Some(index * 1000)
                },
            )]);
            value["platform"] = json!(platform);
            value["interaction_id"] = json!(format!("interaction-{platform}"));
            value["events"][0]["event_id"] = json!(format!("{platform}-{index}"));
            value["events"][0]["observation"]["byte_scope"] = json!(scope);
            payloads.push(value);
        }
    }
    let output = report(&payloads);
    let streams = output["interactions"].as_array().unwrap();
    assert_eq!(streams.len(), 3);
    for stream in streams {
        assert_eq!(stream["active_ms"]["observed_delta"], 200);
        if stream["platform"] == "ios" {
            assert!(stream["transferred_bytes"]["observed_delta"].is_null());
            assert_eq!(stream["byte_scope"], "ios_access_log");
        } else {
            assert_eq!(stream["transferred_bytes"]["observed_delta"], 1000);
        }
    }
}

#[test]
fn unknown_and_initial_only_counters_remain_distinct_from_observed_zero_delta() {
    let output = report(&[
        batch(vec![event(1, 1000, None, None, Some(0))]),
        batch(vec![event(2, 2000, Some(600), None, None)]),
        batch(vec![event(3, 3000, None, None, Some(0))]),
    ]);
    let stream = &output["interactions"][0];
    assert_eq!(stream["active_ms"]["samples"], 1);
    assert!(stream["active_ms"]["observed_delta"].is_null());
    assert_eq!(stream["rebuffer_ms"]["samples"], 0);
    assert!(stream["rebuffer_ms"]["baseline"].is_null());
    assert!(stream["rebuffer_ms"]["observed_delta"].is_null());
    assert_eq!(stream["transferred_bytes"]["observed_delta"], 0);
    assert_eq!(stream["transferred_bytes"]["first_sequence"], 1);
    assert_eq!(stream["transferred_bytes"]["last_sequence"], 3);
}

#[test]
fn sequence_gaps_are_intervals_not_allocated_events_and_partial_prefix_is_reported() {
    let output = report(&[
        batch(vec![event(5, 1000, None, None, Some(100))]),
        batch(vec![event(
            9_007_199_254_740_991,
            2000,
            None,
            None,
            Some(400),
        )]),
    ]);
    let stream = &output["interactions"][0];
    assert_eq!(output["coverage"]["streams_with_missing_sequences"], 1);
    assert_eq!(
        stream["missing_sequences"],
        json!([
            {"from":1,"until_exclusive":5},
            {"from":6,"until_exclusive":9_007_199_254_740_991_u64}
        ])
    );
    assert_eq!(stream["transferred_bytes"]["observed_delta"], 300);
    assert_eq!(
        output["scope"]["complete_interaction_lifetimes_proven"],
        false
    );
}

#[test]
fn generation_reset_is_separate_and_same_generation_reset_or_clock_reversal_fails() {
    let first = batch(vec![event(1, 1000, Some(300), None, Some(1000))]);
    let mut reset = batch(vec![event(1, 100, Some(10), None, Some(50))]);
    reset["generation"] = json!(2);
    reset["events"][0]["event_id"] = json!("new-generation");
    let output = report(&[first.clone(), reset]);
    assert_eq!(output["interactions"].as_array().unwrap().len(), 2);
    assert!(
        output["interactions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|value| value["transferred_bytes"]["observed_delta"].is_null())
    );
    rejects(&[
        first.clone(),
        batch(vec![event(2, 2000, Some(400), None, Some(500))]),
    ]);
    rejects(&[
        first.clone(),
        batch(vec![event(2, 2000, Some(100), None, Some(2000))]),
    ]);
    rejects(&[first, batch(vec![event(2, 900, None, None, None)])]);
}

#[test]
fn cross_batch_counter_growth_and_joint_duration_cannot_exceed_elapsed_time() {
    rejects(&[
        batch(vec![event(1, 1000, Some(100), None, None)]),
        batch(vec![event(2, 2000, Some(1500), None, None)]),
    ]);
    rejects(&[
        batch(vec![event(1, 1000, Some(100), Some(0), None)]),
        batch(vec![event(2, 2000, Some(1000), Some(1000), None)]),
    ]);
}

#[test]
fn event_id_reuse_sequence_collisions_and_context_swaps_fail_without_output() {
    let first = batch(vec![event(1, 1000, None, None, Some(100))]);
    for field in ["subject", "decision_id", "candidate_id", "platform"] {
        let mut second = batch(vec![event(2, 2000, None, None, Some(200))]);
        second[field] = match field {
            "decision_id" => json!("b".repeat(64)),
            // 无平台专属字段的事件仍必须绑定原平台。
            "platform" => {
                second["events"][0]["observation"]["byte_scope"] = json!("ios_access_log");
                json!("ios")
            }
            _ => json!("another"),
        };
        rejects(&[first.clone(), second]);
    }
    let mut conflict = first.clone();
    conflict["events"][0]["observation"]["transferred_bytes"] = json!(200);
    rejects(&[first.clone(), conflict]);
    let mut alias = first.clone();
    alias["events"][0]["event_id"] = json!("different-id");
    rejects(&[first.clone(), alias]);
    let mut moved = first.clone();
    moved["generation"] = json!(2);
    rejects(&[first, moved]);
}

#[test]
fn presentation_visibility_and_preferences_do_not_turn_unknowns_into_costs_or_labels() {
    let mut first = batch(vec![]);
    first["candidate_id"] = json!("article");
    first["events"] = json!([
        {"event_id":"present","sequence":1,"elapsed_ms":100,"observed_at":100,
            "observation":{"kind":"first_presentable","signal":"web_element_visible"}},
        {"event_id":"visible","sequence":2,"elapsed_ms":200,"observed_at":100,
            "observation":{"kind":"visibility","foreground":true,"visible_fraction_milli":1000,
                "signal":"web_element_visible"}},
        {"event_id":"like","sequence":3,"elapsed_ms":300,"observed_at":100,
            "observation":{"kind":"preference","value":"like"}}
    ]);
    let output = report(&[first]);
    let stream = &output["interactions"][0];
    assert_eq!(stream["first_presentable_elapsed_ms"], 100);
    assert_eq!(stream["visibility_declarations"], 1);
    assert_eq!(stream["explicit_preferences"], 1);
    assert!(stream["transferred_bytes"]["last"].is_null());
    assert_eq!(
        output["scope"]["native_devices_or_actual_rendering_proven"],
        false
    );
}

#[test]
fn reconstruction_over_sixty_four_events_keeps_online_limit_and_exact_deduplication() {
    let mut payloads = Vec::new();
    for chunk in 0..2 {
        payloads.push(batch(
            (1..=40)
                .map(|index| {
                    let sequence = chunk * 40 + index;
                    event(sequence, sequence * 1000, None, None, Some(sequence * 100))
                })
                .collect(),
        ));
    }
    let output = report(&payloads);
    assert_eq!(output["coverage"]["unique_events"], 80);
    assert_eq!(
        output["interactions"][0]["transferred_bytes"]["observed_delta"],
        7900
    );
    let mut online: ConsumptionBatch = serde_json::from_value(payloads[0].clone()).unwrap();
    online.events.extend(
        serde_json::from_value::<ConsumptionBatch>(payloads[1].clone())
            .unwrap()
            .events,
    );
    assert!(vs_service::consumption::normalize_consumption(&online, 10000).is_err());
}

#[test]
fn legacy_only_is_not_qoe_and_mixed_legacy_batches_are_counted_without_fabrication() {
    let legacy = json!({"schema":"gateway-learning-events-v1","source_id":"gateway",
        "data_kind":"synthetic","events":[{"event_id":"visible","decision_id":"a".repeat(64),
            "subject":"private-viewer","candidate_id":"video","at":100,"kind":"visible"}]});
    rejects(std::slice::from_ref(&legacy));
    let output = report(&[legacy, batch(vec![event(1, 1000, None, None, None)])]);
    assert_eq!(output["coverage"]["legacy_batches"], 1);
    assert_eq!(output["coverage"]["consumption_batches"], 1);
    assert_eq!(output["interactions"][0]["visibility_declarations"], 0);
}

#[test]
fn fixed_input_is_deterministic_and_repinning_invalid_evidence_never_publishes() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = prepare(
        directory.path(),
        &[batch(vec![event(1, 1000, None, None, Some(5))])],
    );
    let first = directory.path().join("first.json");
    let second = directory.path().join("second.json");
    let a = replay_consumption_evidence(directory.path(), &config, &first).unwrap();
    let b = replay_consumption_evidence(directory.path(), &config, &second).unwrap();
    assert_eq!(a.report_sha256, b.report_sha256);
    assert!(replay_consumption_evidence(directory.path(), &config, &first).is_err());
    assert_eq!(hash(&std::fs::read(first).unwrap()), a.report_sha256);
    let mut raw: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("evidence.json")).unwrap())
            .unwrap();
    raw["messages"][0]["offset"] = json!(21);
    let bytes = serde_json::to_vec(&raw).unwrap();
    std::fs::write(directory.path().join("evidence.json"), &bytes).unwrap();
    config.evidence.sha256 = hash(&bytes);
    let target = directory.path().join("bad.json");
    assert!(replay_consumption_evidence(directory.path(), &config, &target).is_err());
    assert!(!target.exists());
    for path in [
        PathBuf::from("../outside"),
        PathBuf::from("."),
        directory.path().join("evidence.json"),
    ] {
        config.evidence.path = path;
        assert!(replay_consumption_evidence(directory.path(), &config, &target).is_err());
    }
}

#[test]
#[ignore = "需设置VS_TEST_CONSUMPTION_REPLAYER指向已构建的消费重建示例"]
fn independent_cli_returns_bounded_receipt_and_refuses_overwrite_or_invalid_config() {
    use std::process::{Command, Stdio};
    let directory = tempfile::tempdir().unwrap();
    let config = prepare(
        directory.path(),
        &[
            batch(vec![event(1, 1000, Some(100), None, Some(10))]),
            batch(vec![event(2, 2000, Some(600), None, Some(1010))]),
        ],
    );
    let path = directory.path().join("config.json");
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let target = directory.path().join("report.json");
    let execute = |config_path: &Path, target: &Path| {
        let mut command = Command::new(std::env::var_os("VS_TEST_CONSUMPTION_REPLAYER").unwrap());
        command
            .args([config_path, target])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command.output().unwrap()
    };
    let output = execute(&path, &target);
    assert!(
        output.status.success(),
        "独立命令失败：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() < 2048);
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    let bytes = std::fs::read(&target).unwrap();
    let report: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(receipt["report_sha256"], hash(&bytes));
    assert_eq!(
        report["interactions"][0]["active_ms"]["observed_delta"],
        500
    );
    assert_eq!(
        report["interactions"][0]["transferred_bytes"]["observed_delta"],
        1000
    );
    assert!(report["interactions"][0]["rebuffer_ms"]["observed_delta"].is_null());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private-"));
    assert_eq!(execute(&path, &target).status.code(), Some(1));
    assert_eq!(bytes, std::fs::read(target).unwrap());
    let bad = directory.path().join("bad-config.json");
    std::fs::write(&bad, br#"{"schema":"unknown","evidence":{}}"#).unwrap();
    let missing = directory.path().join("missing.json");
    assert_eq!(execute(&bad, &missing).status.code(), Some(1));
    assert!(!missing.exists());
    println!(
        "{}",
        json!({
            "schema":"consumption-replay-cli-contract-v1",
            "data_kind":"synthetic","interactions":receipt["interactions"],
            "unique_events":receipt["unique_events"],
            "active_observed_delta_ms":500,"transferred_observed_delta_bytes":1000,
            "unknown_rebuffer_preserved":true,"overwrite_refused":true,
            "invalid_config_exit_code":1,"bounded_receipt":true,
            "real_user_devices_or_cost_benchmark":false
        })
    );
}
