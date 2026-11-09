use openraft::{
    CommittedLeaderId, Entry, EntryPayload, LogId, RaftSnapshotBuilder, storage::RaftStateMachine,
};
use vs_coordination::{
    RoomCommand, RoomTarget, TypeConfig,
    media_registry::{
        AuthorityCommand, AuthorityReply, MediaNodeCommand, MediaNodeReply, MediaRegistration,
        RoomName, apply_authority,
    },
    storage::{StateData, open_with_registry},
};

fn target() -> RoomTarget {
    RoomTarget {
        node_id: "media".into(),
        incarnation: "abcdefghijklmnopqrstuv".into(),
    }
}

fn registration() -> MediaNodeCommand {
    MediaNodeCommand::RegisterMedia {
        operation_id: "register".into(),
        expected_revision: None,
        registration: MediaRegistration {
            transport: Default::default(),
            target: target(),
            endpoint: "127.0.0.1:32001".parse().unwrap(),
            rooms: ["one", "two"]
                .into_iter()
                .map(|room| RoomName {
                    tenant_id: "tenant".into(),
                    room_id: room.into(),
                })
                .collect(),
        },
    }
}

fn set_draining(operation: &str, revision: u64, draining: bool) -> MediaNodeCommand {
    MediaNodeCommand::SetMediaDraining {
        operation_id: operation.into(),
        expected_revision: revision,
        target: target(),
        draining,
    }
}

fn assign(room: &str) -> RoomCommand {
    RoomCommand::Assign {
        tenant_id: "tenant".into(),
        room_id: room.into(),
        operation_id: format!("assign-{room}"),
        expected_revision: None,
        target: target(),
    }
}

fn media(state: &mut StateData, command: MediaNodeCommand, revision: u64) -> MediaNodeReply {
    match apply_authority(state, AuthorityCommand::Media(command), revision, true) {
        AuthorityReply::Media(reply) => reply,
        _ => panic!("媒体命令没有返回媒体结果"),
    }
}

fn room(state: &mut StateData, command: RoomCommand, revision: u64) -> vs_coordination::RoomReply {
    match apply_authority(state, AuthorityCommand::Room(command), revision, true) {
        AuthorityReply::Room(reply) => reply,
        _ => panic!("房间命令没有返回房间结果"),
    }
}

#[test]
fn draining_preserves_owners_and_endpoint_but_blocks_new_assignments_until_resume() {
    let mut state = StateData::default();
    media(&mut state, registration(), 1);
    room(&mut state, assign("one"), 2);
    let previous = state.rooms.clone();
    let drained = media(&mut state, set_draining("drain", 1, true), 3);
    assert_eq!(drained.outcome, "applied");
    assert!(drained.record.unwrap().draining);
    assert_eq!(state.rooms, previous);
    assert_eq!(
        state.media_nodes["media"]
            .registration
            .as_ref()
            .unwrap()
            .endpoint,
        "127.0.0.1:32001".parse().unwrap()
    );
    assert_eq!(room(&mut state, assign("two"), 4).outcome, "node_draining");
    assert!(!state.rooms.contains_key("tenant/two"));
    let duplicate = room(&mut state, assign("one"), 5);
    assert_eq!(duplicate.outcome, "duplicate");
    assert_eq!(duplicate.record.unwrap().revision, 2);
    assert_eq!(
        media(
            &mut state,
            MediaNodeCommand::RemoveMedia {
                operation_id: "remove-in-use".into(),
                expected_revision: 3,
                target: target(),
            },
            6
        )
        .outcome,
        "in_use"
    );
    assert_eq!(
        media(&mut state, set_draining("resume", 3, false), 7).outcome,
        "applied"
    );
    assert_eq!(room(&mut state, assign("two"), 8).outcome, "applied");
    assert!(!state.media_nodes["media"].draining);
}

#[test]
fn stale_or_conflicting_drain_cannot_modify_new_registration_or_resumed_node() {
    let mut state = StateData::default();
    media(&mut state, registration(), 1);
    assert!(
        serde_json::to_value(&state.media_nodes["media"])
            .unwrap()
            .get("draining")
            .is_none()
    );
    let legacy: vs_coordination::media_registry::MediaNodeRecord =
        serde_json::from_value(serde_json::to_value(&state.media_nodes["media"]).unwrap()).unwrap();
    assert!(!legacy.draining);
    let drain = set_draining("drain", 1, true);
    media(&mut state, drain.clone(), 2);
    assert_eq!(media(&mut state, drain.clone(), 3).outcome, "duplicate");
    assert_eq!(
        media(&mut state, set_draining("drain", 1, false), 4).outcome,
        "conflict"
    );
    assert_eq!(
        media(&mut state, set_draining("stale", 1, false), 5).outcome,
        "conflict"
    );
    let mut wrong = set_draining("wrong-incarnation", 2, false);
    if let MediaNodeCommand::SetMediaDraining { target, .. } = &mut wrong {
        target.incarnation = "bbbbbbbbbbbbbbbbbbbbbb".into();
    }
    assert_eq!(media(&mut state, wrong, 6).outcome, "conflict");
    media(&mut state, set_draining("resume", 2, false), 7);
    assert_eq!(media(&mut state, drain, 8).outcome, "conflict");
    assert!(!state.media_nodes["media"].draining);
    media(
        &mut state,
        MediaNodeCommand::RemoveMedia {
            operation_id: "remove".into(),
            expected_revision: 7,
            target: target(),
        },
        9,
    );
    assert_eq!(
        media(&mut state, set_draining("after-remove", 9, true), 10).outcome,
        "conflict"
    );
}

#[test]
fn registration_updates_do_not_silently_resume_empty_draining_nodes() {
    let mut state = StateData::default();
    media(&mut state, registration(), 1);
    media(&mut state, set_draining("drain", 1, true), 2);
    let mut update = registration();
    if let MediaNodeCommand::RegisterMedia {
        operation_id,
        expected_revision,
        registration,
    } = &mut update
    {
        *operation_id = "update-while-draining".into();
        *expected_revision = Some(2);
        registration.endpoint = "127.0.0.1:32002".parse().unwrap();
    }
    assert_eq!(media(&mut state, update, 3).outcome, "applied");
    assert!(state.media_nodes["media"].draining);
    assert_eq!(room(&mut state, assign("one"), 4).outcome, "node_draining");
    assert_eq!(
        media(&mut state, set_draining("resume", 3, false), 5).outcome,
        "applied"
    );
    assert_eq!(room(&mut state, assign("one"), 6).outcome, "applied");
}

#[test]
fn drain_and_assign_have_one_committed_order_and_release_remains_available() {
    for assign_first in [true, false] {
        let mut state = StateData::default();
        media(&mut state, registration(), 1);
        if assign_first {
            assert_eq!(room(&mut state, assign("one"), 2).outcome, "applied");
        }
        media(&mut state, set_draining("drain", 1, true), 3);
        if assign_first {
            assert_eq!(
                room(
                    &mut state,
                    RoomCommand::Release {
                        tenant_id: "tenant".into(),
                        room_id: "one".into(),
                        operation_id: "release".into(),
                        expected_revision: 2,
                        target: target(),
                    },
                    4
                )
                .outcome,
                "applied"
            );
        } else {
            assert_eq!(room(&mut state, assign("one"), 4).outcome, "node_draining");
        }
        assert_eq!(
            media(
                &mut state,
                MediaNodeCommand::RemoveMedia {
                    operation_id: "remove".into(),
                    expected_revision: 3,
                    target: target(),
                },
                5
            )
            .outcome,
            "applied"
        );
        assert!(state.media_nodes["media"].registration.is_none());
    }
}

#[tokio::test]
async fn draining_state_survives_snapshot_install_and_reopen_without_changing_owner() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.redb");
    let target_path = directory.path().join("target.redb");
    let expected;
    {
        let (logs, mut store) = open_with_registry(&source_path, "cluster", 1, true).unwrap();
        logs.pin_policy("registry-with-node-draining-v1").unwrap();
        for (index, command) in [
            AuthorityCommand::Media(registration()),
            AuthorityCommand::Room(assign("one")),
            AuthorityCommand::Media(set_draining("drain", 1, true)),
        ]
        .into_iter()
        .enumerate()
        {
            let revision = index as u64 + 1;
            let replies = store
                .apply([Entry::<TypeConfig> {
                    log_id: LogId::new(CommittedLeaderId::new(1, 1), revision),
                    payload: EntryPayload::Normal(command),
                }])
                .await
                .unwrap();
            assert_eq!(replies[0].outcome, "applied");
        }
        expected = store.media_node("media").await.unwrap();
        assert!(expected.draining);
        assert_eq!(
            store.room("tenant/one").await.unwrap().owner,
            Some(target())
        );
        let snapshot = store
            .get_snapshot_builder()
            .await
            .build_snapshot()
            .await
            .unwrap();
        let (_, mut replica) = open_with_registry(&target_path, "cluster", 2, true).unwrap();
        replica
            .install_snapshot(&snapshot.meta, snapshot.snapshot)
            .await
            .unwrap();
        assert_eq!(replica.media_node("media").await.unwrap(), expected);
    }
    let (logs, store) = open_with_registry(&source_path, "cluster", 1, true).unwrap();
    logs.pin_policy("registry-with-node-draining-v1").unwrap();
    assert!(logs.pin_policy("registry-without-node-draining").is_err());
    assert_eq!(store.media_node("media").await.unwrap(), expected);
    let (_, restored) = open_with_registry(&target_path, "cluster", 2, true).unwrap();
    assert_eq!(restored.media_node("media").await.unwrap(), expected);
    assert_eq!(
        restored.room("tenant/one").await.unwrap().owner,
        Some(target())
    );
}

#[test]
fn invalid_wire_commands_and_disabled_registry_do_not_change_admission() {
    let command = set_draining("drain", 1, true);
    let serialized = serde_json::to_value(&command).unwrap();
    assert_eq!(serialized["operation"], "set_media_draining");
    assert!(
        serde_json::from_value::<MediaNodeCommand>(serialized.clone())
            .unwrap()
            .valid()
    );
    for (field, value) in [
        ("draining", serde_json::json!("true")),
        ("expected_revision", serde_json::json!(0)),
        (
            "expected_revision",
            serde_json::json!(9_007_199_254_740_992_u64),
        ),
        ("extra", serde_json::json!(true)),
    ] {
        let mut changed = serialized.clone();
        changed[field] = value;
        assert!(
            !serde_json::from_value::<MediaNodeCommand>(changed)
                .is_ok_and(|command| command.valid())
        );
    }
    let mut state = StateData::default();
    match apply_authority(&mut state, AuthorityCommand::Media(command), 1, false) {
        AuthorityReply::Media(reply) => assert_eq!(reply.outcome, "disabled"),
        _ => panic!("禁用登记仍应返回明确结果"),
    }
    assert!(state.media_nodes.is_empty());
}
