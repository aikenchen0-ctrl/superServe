use openraft::{
    CommittedLeaderId, Entry, EntryPayload, LogId, RaftSnapshotBuilder,
    storage::{RaftLogReader, RaftLogStorageExt, RaftStateMachine},
};
use serde_json::json;
use vs_coordination::{
    RoomTarget, TypeConfig,
    media_registry::AuthorityCommand,
    profile_authority::{
        MAX_EVENTS, MAX_SUBJECTS, MAX_WRITER_CHANGES, ProfileCommand, ProfileLedger, ProfilePolicy,
        WriterChange,
    },
    storage::{open, open_with_profile_policy},
};
use vs_core::profile::{ProfileEvent, ProfileEventKind};

const CATALOG: &[u8] = br#"{"version":"consensus-v1","assets":[],"items":[
{"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
{"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
{"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}]}"#;

fn policy() -> ProfilePolicy {
    ProfilePolicy::from_catalog(CATALOG, 2).unwrap()
}
fn target(letter: char) -> RoomTarget {
    RoomTarget {
        node_id: format!("writer-{letter}"),
        incarnation: letter.to_string().repeat(22),
    }
}
fn subject(shard: u16) -> String {
    (0..100)
        .map(|i| format!("user-{i}"))
        .find(|s| policy().shard_for(s) == shard)
        .unwrap()
}
fn change(
    id: &str,
    shard: u16,
    expected: Option<u64>,
    owner: Option<RoomTarget>,
) -> ProfileCommand {
    ProfileCommand::SetProfileWriter {
        change: WriterChange {
            operation_id: id.into(),
            shard,
            expected_revision: expected,
            target: owner,
        },
    }
}
fn event(id: &str, epoch: u64, owner: RoomTarget, kind: ProfileEventKind) -> ProfileCommand {
    ProfileCommand::CommitProfileEvent {
        shard: 0,
        writer_epoch: epoch,
        target: owner,
        event: ProfileEvent {
            event_id: id.into(),
            subject: subject(0),
            candidate_id: "document".into(),
            kind,
        },
    }
}
fn entry(command: ProfileCommand, index: u64) -> Entry<TypeConfig> {
    Entry {
        log_id: LogId::new(CommittedLeaderId::new(1, 1), index),
        payload: EntryPayload::Normal(AuthorityCommand::Profile(command)),
    }
}

#[test]
fn epoch_change_and_fact_commit_share_one_order_without_old_writer_window() {
    for rotation_first in [true, false] {
        let mut ledger = ProfileLedger::new(policy());
        ledger.apply(change("initial", 0, None, Some(target('a'))), 1);
        let write = event("hide", 1, target('a'), ProfileEventKind::Hide);
        let rotate = change("replace", 0, Some(1), Some(target('b')));
        if rotation_first {
            assert_eq!(ledger.apply(rotate, 2).outcome, "applied");
            assert_eq!(ledger.apply(write, 3).outcome, "fenced");
            assert_eq!(ledger.event_count(), 0);
        } else {
            assert_eq!(ledger.apply(write, 2).outcome, "applied");
            assert_eq!(ledger.apply(rotate, 3).outcome, "applied");
            assert_eq!(ledger.event_count(), 1);
        }
        assert!(ledger.valid(&policy(), 3));
    }
}

#[test]
fn rotation_disable_aba_and_idempotency_preserve_hidden_fact() {
    let mut ledger = ProfileLedger::new(policy());
    let initial = change("initial", 0, None, Some(target('a')));
    assert_eq!(ledger.apply(initial.clone(), 1).outcome, "applied");
    assert_eq!(ledger.apply(initial, 2).outcome, "duplicate");
    let hide = event("stable", 1, target('a'), ProfileEventKind::Hide);
    assert_eq!(ledger.apply(hide.clone(), 3).outcome, "applied");
    assert_eq!(
        ledger
            .apply(change("replace", 0, Some(1), Some(target('b'))), 4)
            .outcome,
        "applied"
    );
    assert_eq!(ledger.apply(hide.clone(), 5).outcome, "fenced");
    let duplicate = ledger.apply(event("stable", 4, target('b'), ProfileEventKind::Hide), 6);
    assert_eq!(duplicate.outcome, "duplicate");
    assert!(duplicate.event.unwrap().duplicate);
    assert_eq!(
        ledger
            .apply(event("stable", 4, target('b'), ProfileEventKind::Like), 7)
            .outcome,
        "conflict"
    );
    assert_eq!(
        ledger.apply(change("disable", 0, Some(4), None), 8).outcome,
        "applied"
    );
    assert_eq!(
        ledger
            .apply(event("disabled", 8, target('b'), ProfileEventKind::Like), 9)
            .outcome,
        "fenced"
    );
    assert_eq!(
        ledger
            .apply(change("back-to-a", 0, Some(8), Some(target('a'))), 10)
            .outcome,
        "applied"
    );
    assert_eq!(ledger.apply(hide, 11).outcome, "fenced");
    assert_eq!(
        ledger
            .apply(change("stale", 0, Some(1), Some(target('b'))), 12)
            .outcome,
        "conflict"
    );
    let projection = ledger
        .projection(&subject(0), vec!["document".into(), "video".into()], 123)
        .unwrap()
        .unwrap();
    assert_eq!(projection.blocked_ids, vec!["document"]);
    assert_eq!(projection.version, "memory-1");
    assert!(ledger.valid(&policy(), 12));
}

#[test]
fn retained_facts_deduplicate_beyond_memory_window_and_at_full_event_budget() {
    let mut ledger = ProfileLedger::new(policy());
    ledger.apply(change("initial", 0, None, Some(target('a'))), 1);
    for index in 0..MAX_EVENTS {
        assert_eq!(
            ledger
                .apply(
                    event(
                        &format!("event-{index}"),
                        1,
                        target('a'),
                        ProfileEventKind::Like
                    ),
                    index as u64 + 2
                )
                .outcome,
            "applied"
        );
    }
    assert_eq!(
        ledger
            .apply(
                event("event-0", 1, target('a'), ProfileEventKind::Like),
                300
            )
            .outcome,
        "duplicate"
    );
    assert_eq!(
        ledger
            .apply(
                event("event-0", 1, target('a'), ProfileEventKind::Hide),
                301
            )
            .outcome,
        "conflict"
    );
    assert_eq!(
        ledger
            .apply(
                event("too-many", 1, target('a'), ProfileEventKind::Like),
                302
            )
            .outcome,
        "capacity"
    );
    assert_eq!(ledger.event_count(), MAX_EVENTS);
    assert!(ledger.valid(&policy(), 302));
}

#[test]
fn subject_and_writer_change_budgets_do_not_silently_evict_facts_or_epochs() {
    let mut ledger = ProfileLedger::new(policy());
    ledger.apply(change("zero", 0, None, Some(target('a'))), 1);
    let mut index = 0;
    for count in 0..=MAX_SUBJECTS {
        let subject = loop {
            index += 1;
            let value = format!("subject-{index}");
            if policy().shard_for(&value) == 0 {
                break value;
            }
        };
        let mut command = event("same-id", 1, target('a'), ProfileEventKind::Like);
        if let ProfileCommand::CommitProfileEvent { event, .. } = &mut command {
            event.subject = subject;
        }
        assert_eq!(
            ledger.apply(command, count as u64 + 2).outcome,
            if count < MAX_SUBJECTS {
                "applied"
            } else {
                "capacity"
            }
        );
    }
    assert_eq!(ledger.event_count(), MAX_SUBJECTS);
    let mut previous = 1;
    for index in 1..MAX_WRITER_CHANGES {
        let revision = 100 + index as u64;
        assert_eq!(
            ledger
                .apply(
                    change(
                        &format!("change-{index}"),
                        0,
                        Some(previous),
                        Some(target('a'))
                    ),
                    revision
                )
                .outcome,
            "applied"
        );
        previous = revision;
    }
    assert_eq!(
        ledger
            .apply(change("overflow", 0, Some(previous), None), 200)
            .outcome,
        "capacity"
    );
    assert!(ledger.valid(&policy(), 200));
}

#[test]
fn snapshots_reject_forged_epoch_facts_writer_history_and_unknown_fields() {
    let mut ledger = ProfileLedger::new(policy());
    ledger.apply(change("initial", 0, None, Some(target('a'))), 1);
    ledger.apply(event("hide", 1, target('a'), ProfileEventKind::Hide), 2);
    for case in ["epoch", "facts", "writer", "history", "duplicate"] {
        let mut value = serde_json::to_value(&ledger).unwrap();
        match case {
            "epoch" => value["events"][0]["writer_epoch"] = json!(99),
            "facts" => value["events"][0]["facts"]["tags"] = json!(["forged"]),
            "writer" => value["writers"]["0"]["revision"] = json!(3),
            "history" => value["changes"] = json!([]),
            _ => {
                let first = value["events"][0].clone();
                value["events"].as_array_mut().unwrap().push(first);
            }
        }
        let invalid: ProfileLedger = serde_json::from_value(value).unwrap();
        assert!(!invalid.valid(&policy(), 4), "反例：{case}");
    }
    let mut unknown = serde_json::to_value(&ledger).unwrap();
    unknown["skip_fence"] = json!(true);
    assert!(serde_json::from_value::<ProfileLedger>(unknown).is_err());
}

#[test]
fn invalid_commands_and_unknown_protocol_fields_do_not_create_state() {
    let mut ledger = ProfileLedger::new(policy());
    for mut command in [
        change("bad", 2, None, Some(target('a'))),
        event("zero-epoch", 0, target('a'), ProfileEventKind::Hide),
        event("valid", 1, target('a'), ProfileEventKind::Hide),
    ] {
        if let ProfileCommand::CommitProfileEvent { event, .. } = &mut command {
            event.subject = subject(1);
        }
        assert_eq!(ledger.apply(command, 4).outcome, "invalid");
    }
    assert_eq!(ledger.event_count(), 0);
    assert!(ledger.writers.is_empty());
    assert!(
        ledger
            .projection("user", vec!["video".into(), "video".into()], 3)
            .is_err()
    );
    let mut command =
        serde_json::to_value(event("valid", 1, target('a'), ProfileEventKind::Hide)).unwrap();
    command["force"] = json!(true);
    assert!(serde_json::from_value::<ProfileCommand>(command).is_err());
}

#[test]
fn shard_writer_epochs_and_same_event_ids_remain_isolated_across_subjects() {
    let mut ledger = ProfileLedger::new(policy());
    ledger.apply(change("zero", 0, None, Some(target('a'))), 1);
    ledger.apply(change("one", 1, None, Some(target('b'))), 2);
    assert_eq!(
        ledger
            .apply(event("same", 1, target('a'), ProfileEventKind::Hide), 3)
            .outcome,
        "applied"
    );
    let command = |epoch, owner| ProfileCommand::CommitProfileEvent {
        shard: 1,
        writer_epoch: epoch,
        target: target(owner),
        event: ProfileEvent {
            event_id: "same".into(),
            subject: subject(1),
            candidate_id: "service".into(),
            kind: ProfileEventKind::Like,
        },
    };
    assert_eq!(ledger.apply(command(1, 'a'), 4).outcome, "fenced");
    assert_eq!(ledger.apply(command(2, 'b'), 5).outcome, "applied");
    ledger.apply(change("zero-rotate", 0, Some(1), Some(target('c'))), 6);
    assert_eq!(ledger.apply(command(2, 'b'), 7).outcome, "duplicate");
    assert_eq!(
        ledger
            .projection(&subject(1), vec!["service".into()], 123)
            .unwrap()
            .unwrap()
            .version,
        "memory-1"
    );
    assert_eq!(ledger.event_count(), 2);
    assert!(ledger.valid(&policy(), 7));
}

#[tokio::test]
async fn durable_log_state_snapshot_and_restart_keep_fence_and_projection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.redb");
    let (mut logs, mut state) = open_with_profile_policy(&path, "profile", 1, policy()).unwrap();
    let entries = [
        entry(change("initial", 0, None, Some(target('a'))), 1),
        entry(event("hide", 1, target('a'), ProfileEventKind::Hide), 2),
        entry(change("replace", 0, Some(1), Some(target('b'))), 3),
        entry(event("old", 1, target('a'), ProfileEventKind::Like), 4),
    ];
    logs.blocking_append(entries).await.unwrap();
    let replay = logs.try_get_log_entries(1..=4).await.unwrap();
    let replies = state.apply(replay).await.unwrap();
    assert_eq!(
        replies
            .iter()
            .map(|reply| reply.outcome.as_str())
            .collect::<Vec<_>>(),
        ["applied", "applied", "applied", "fenced"]
    );
    let before = state.profile_ledger().await.unwrap();
    let snapshot = state.build_snapshot().await.unwrap();
    let (_, mut other) =
        open_with_profile_policy(&dir.path().join("replica.redb"), "profile", 2, policy()).unwrap();
    other
        .install_snapshot(&snapshot.meta, snapshot.snapshot.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(other.profile_ledger().await).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    let (_, mut legacy) = open(&dir.path().join("legacy.redb"), "profile", 3).unwrap();
    assert!(
        legacy
            .install_snapshot(&snapshot.meta, snapshot.snapshot.clone())
            .await
            .is_err()
    );
    drop(logs);
    drop(state);
    assert!(open(&path, "profile", 1).is_err());
    let (_, state) = open_with_profile_policy(&path, "profile", 1, policy()).unwrap();
    let restored = state.profile_ledger().await.unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    let changed = ProfilePolicy::from_catalog(CATALOG, 4).unwrap();
    drop(state);
    assert!(open_with_profile_policy(&path, "profile", 1, changed).is_err());
}

#[test]
fn existing_room_history_cannot_be_adopted_by_profile_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("authority.redb");
    let (logs, state) = open(&path, "cluster", 1).unwrap();
    logs.pin_policy("legacy").unwrap();
    drop(logs);
    drop(state);
    assert!(open_with_profile_policy(&path, "cluster", 1, policy()).is_err());
}

#[tokio::test]
async fn malformed_policy_and_snapshot_cannot_bypass_persisted_mode_or_replace_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut invalid = serde_json::to_value(policy()).unwrap();
    invalid["shard_count"] = json!(0);
    let invalid: ProfilePolicy = serde_json::from_value(invalid).unwrap();
    assert!(!invalid.validate());
    assert!(
        open_with_profile_policy(&dir.path().join("invalid.redb"), "profile", 1, invalid).is_err()
    );
    assert!(!dir.path().join("invalid.redb").exists());

    let (_, mut source) =
        open_with_profile_policy(&dir.path().join("source.redb"), "profile", 1, policy()).unwrap();
    source
        .apply([
            entry(change("initial", 0, None, Some(target('a'))), 1),
            entry(event("hide", 1, target('a'), ProfileEventKind::Hide), 2),
        ])
        .await
        .unwrap();
    let snapshot = source.build_snapshot().await.unwrap();
    let (_, mut destination) =
        open_with_profile_policy(&dir.path().join("destination.redb"), "profile", 2, policy())
            .unwrap();
    let before = serde_json::to_value(destination.profile_ledger().await).unwrap();
    for case in ["facts", "epoch", "mode", "metadata"] {
        let mut value: serde_json::Value =
            serde_json::from_slice(snapshot.snapshot.get_ref()).unwrap();
        let mut meta = snapshot.meta.clone();
        match case {
            "facts" => value["profiles"]["events"][0]["facts"]["tags"] = json!(["wrong"]),
            "epoch" => value["profiles"]["events"][0]["writer_epoch"] = json!(99),
            "mode" => value["profiles"] = serde_json::Value::Null,
            _ => meta.last_log_id = None,
        }
        let data = Box::new(std::io::Cursor::new(serde_json::to_vec(&value).unwrap()));
        assert!(
            destination.install_snapshot(&meta, data).await.is_err(),
            "反例：{case}"
        );
        assert_eq!(
            serde_json::to_value(destination.profile_ledger().await).unwrap(),
            before
        );
    }
}
