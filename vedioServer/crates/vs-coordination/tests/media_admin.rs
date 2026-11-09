use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tokio::sync::Mutex;
use vs_coordination::{
    RoomCommand, RoomTarget,
    media_admin::{MaintenanceOutcome, MaintenanceView, MediaAdmin, MediaAdminConfig, OwnedRoom},
    media_registry::{
        AuthorityCommand, AuthorityReply, MediaNodeCommand, MediaRegistration, RoomName,
        apply_authority,
    },
    storage::StateData,
};

const TOKEN: &str = "media-admin-test-service-secret-32-bytes";

struct FixtureState {
    data: Mutex<StateData>,
    writes: AtomicUsize,
    reads: AtomicUsize,
    mode: AtomicUsize,
}
struct Fixture {
    state: Arc<FixtureState>,
    endpoint: std::net::SocketAddr,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn target() -> RoomTarget {
    RoomTarget {
        node_id: "media".into(),
        incarnation: "abcdefghijklmnopqrstuv".into(),
    }
}
fn drain() -> MediaNodeCommand {
    MediaNodeCommand::SetMediaDraining {
        operation_id: "maintenance".into(),
        expected_revision: 1,
        target: target(),
        draining: true,
    }
}
fn config(endpoints: Vec<std::net::SocketAddr>) -> MediaAdminConfig {
    MediaAdminConfig {
        cluster_id: "test-cluster".into(),
        endpoints,
        service_token: TOKEN.into(),
        tls: None,
    }
}
fn view(data: &StateData) -> MaintenanceView {
    MaintenanceView {
        cluster_id: "test-cluster".into(),
        node_id: "media".into(),
        record: data.media_nodes.get("media").cloned(),
        owned_rooms: data
            .rooms
            .values()
            .filter(|room| room.owner.as_ref() == Some(&target()))
            .map(|record| {
                let (tenant, room, _) = record.last_command.coordinates();
                OwnedRoom {
                    tenant_id: tenant.into(),
                    room_id: room.into(),
                    record: record.clone(),
                }
            })
            .collect(),
    }
}
fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .is_some_and(|value| value.as_bytes() == format!("Bearer {TOKEN}").as_bytes())
}
async fn read(State(state): State<Arc<FixtureState>>, headers: HeaderMap) -> Response {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    state.reads.fetch_add(1, Ordering::SeqCst);
    let data = state.data.lock().await;
    let mut value = view(&data);
    match state.mode.load(Ordering::SeqCst) {
        6 => {
            value.cluster_id = "other-cluster".into();
        }
        7 => return (StatusCode::OK, " ".repeat(128 * 1024 + 1)).into_response(),
        8 => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        10 => {
            return (
                StatusCode::TEMPORARY_REDIRECT,
                [("location", "/v1/media-nodes/media/maintenance")],
            )
                .into_response();
        }
        11 => {
            if let Some(record) = value.record.as_mut() {
                record.registration.as_mut().unwrap().endpoint = "192.0.2.1:3000".parse().unwrap();
            }
        }
        _ => (),
    }
    Json(value).into_response()
}
async fn write(
    State(state): State<Arc<FixtureState>>,
    headers: HeaderMap,
    Json(command): Json<MediaNodeCommand>,
) -> Response {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    state.writes.fetch_add(1, Ordering::SeqCst);
    let mode = state.mode.load(Ordering::SeqCst);
    let mut data = state.data.lock().await;
    let reply = if mode == 4 {
        // 预览之后另一个操作者先提交恢复，模拟真正的版本竞争。
        apply_authority(
            &mut data,
            AuthorityCommand::Media(MediaNodeCommand::SetMediaDraining {
                operation_id: "concurrent".into(),
                expected_revision: 1,
                target: target(),
                draining: false,
            }),
            2,
            true,
        );
        apply_authority(&mut data, AuthorityCommand::Media(command), 3, true)
    } else if mode == 12 {
        apply_authority(
            &mut data,
            AuthorityCommand::Room(RoomCommand::Assign {
                tenant_id: "tenant".into(),
                room_id: "room".into(),
                operation_id: "concurrent-room".into(),
                expected_revision: None,
                target: target(),
            }),
            2,
            true,
        );
        apply_authority(&mut data, AuthorityCommand::Media(command), 3, true)
    } else {
        apply_authority(&mut data, AuthorityCommand::Media(command), 2, true)
    };
    let AuthorityReply::Media(reply) = reply else {
        panic!("媒体回复类型错误");
    };
    match mode {
        1 => StatusCode::SERVICE_UNAVAILABLE.into_response(), // 已提交但响应未确认
        2 => Response::builder()
            .status(200)
            .body(Body::from("{"))
            .unwrap(),
        3 => {
            apply_authority(
                &mut data,
                AuthorityCommand::Media(MediaNodeCommand::SetMediaDraining {
                    operation_id: "later-resume".into(),
                    expected_revision: 2,
                    target: target(),
                    draining: false,
                }),
                3,
                true,
            );
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
        5 => (
            StatusCode::TEMPORARY_REDIRECT,
            [("location", "/v1/media-nodes/commands")],
        )
            .into_response(),
        9 => {
            drop(data);
            tokio::time::sleep(Duration::from_millis(1800)).await;
            Json(reply).into_response()
        }
        _ => {
            let status = if matches!(reply.outcome.as_str(), "applied" | "duplicate") {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            };
            (status, Json(reply)).into_response()
        }
    }
}
impl Fixture {
    async fn new() -> Self {
        let mut data = StateData::default();
        apply_authority(
            &mut data,
            AuthorityCommand::Media(MediaNodeCommand::RegisterMedia {
                operation_id: "register".into(),
                expected_revision: None,
                registration: MediaRegistration {
                    transport: Default::default(),
                    target: target(),
                    endpoint: "127.0.0.1:35000".parse().unwrap(),
                    rooms: vec![RoomName {
                        tenant_id: "tenant".into(),
                        room_id: "room".into(),
                    }],
                },
            }),
            1,
            true,
        );
        let state = Arc::new(FixtureState {
            data: Mutex::new(data),
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            mode: AtomicUsize::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/v1/media-nodes/media/maintenance", get(read))
            .route("/v1/media-nodes/commands", post(write))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            state,
            endpoint,
            task,
        }
    }
    fn client(&self) -> MediaAdmin {
        MediaAdmin::new(config(vec![self.endpoint])).unwrap()
    }
}

#[tokio::test]
async fn single_write_commits_and_same_command_is_confirmed_without_repeating_post() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    assert!(
        !client
            .preview("media")
            .await
            .unwrap()
            .record
            .unwrap()
            .draining
    );
    let receipt = client.apply(drain()).await.unwrap();
    assert!(matches!(receipt.outcome, MaintenanceOutcome::Confirmed));
    assert_eq!(receipt.writes_sent, 1);
    assert_eq!(receipt.confirmed_record.unwrap().revision, 2);
    let retry = client.apply(drain()).await.unwrap();
    assert!(matches!(retry.outcome, MaintenanceOutcome::Confirmed));
    assert_eq!(retry.writes_sent, 0);
    let confirm = client.confirm(drain()).await.unwrap();
    assert!(matches!(confirm.outcome, MaintenanceOutcome::Confirmed));
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn uncertain_503_malformed_response_and_redirect_are_resolved_by_reading_without_resending() {
    for mode in [1, 2, 5] {
        let fixture = Fixture::new().await;
        fixture.state.mode.store(mode, Ordering::SeqCst);
        let receipt = fixture.client().apply(drain()).await.unwrap();
        assert!(matches!(receipt.outcome, MaintenanceOutcome::Confirmed));
        assert_eq!(receipt.confirmed_record.unwrap().last_command, drain());
        assert_eq!(receipt.writes_sent, 1);
        assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.state.reads.load(Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn timeout_after_commit_is_confirmed_without_a_second_post() {
    let fixture = Fixture::new().await;
    fixture.state.mode.store(9, Ordering::SeqCst);
    let receipt = fixture.client().apply(drain()).await.unwrap();
    assert!(matches!(receipt.outcome, MaintenanceOutcome::Confirmed));
    assert_eq!(receipt.writes_sent, 1);
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn overwritten_command_stays_unknown_and_cannot_be_reconstructed_from_current_state() {
    let fixture = Fixture::new().await;
    fixture.state.mode.store(3, Ordering::SeqCst);
    let receipt = fixture.client().apply(drain()).await.unwrap();
    assert!(matches!(receipt.outcome, MaintenanceOutcome::Unknown));
    assert!(receipt.confirmed_record.is_none());
    assert_eq!(receipt.observed.unwrap().record.unwrap().revision, 3);
    assert_eq!(
        receipt.evidence,
        "权威读回的当前命令不同；原提案历史结局未知"
    );
    let confirm = fixture.client().confirm(drain()).await.unwrap();
    assert!(matches!(confirm.outcome, MaintenanceOutcome::Unknown));
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn different_current_record_is_unknown_not_false_conflict_or_rebased_retry() {
    let fixture = Fixture::new().await;
    fixture.state.mode.store(3, Ordering::SeqCst);
    let receipt = fixture.client().apply(drain()).await.unwrap();
    assert!(matches!(receipt.outcome, MaintenanceOutcome::Unknown));
    assert!(receipt.confirmed_record.is_none());
    assert!(receipt.evidence.contains("历史结局未知"));
    assert_eq!(receipt.observed.unwrap().record.unwrap().revision, 3);
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.state.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn preflight_conflict_and_in_use_remove_do_not_send_writes_but_live_drain_can() {
    let fixture = Fixture::new().await;
    let mut command = drain();
    if let MediaNodeCommand::SetMediaDraining {
        expected_revision, ..
    } = &mut command
    {
        *expected_revision = 4;
    }
    assert!(matches!(
        fixture.client().apply(command).await.unwrap().outcome,
        MaintenanceOutcome::Conflict
    ));
    {
        let mut data = fixture.state.data.lock().await;
        apply_authority(
            &mut data,
            AuthorityCommand::Room(RoomCommand::Assign {
                tenant_id: "tenant".into(),
                room_id: "room".into(),
                operation_id: "assign".into(),
                expected_revision: None,
                target: target(),
            }),
            2,
            true,
        );
    }
    let preview = fixture.client().preview("media").await.unwrap();
    assert_eq!(preview.owned_rooms.len(), 1);
    let remove = MediaNodeCommand::RemoveMedia {
        operation_id: "remove".into(),
        expected_revision: 1,
        target: target(),
    };
    assert!(matches!(
        fixture.client().apply(remove).await.unwrap().outcome,
        MaintenanceOutcome::InUse
    ));
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.client().apply(drain()).await.unwrap().outcome,
        MaintenanceOutcome::Confirmed
    ));
    assert_eq!(
        fixture
            .client()
            .preview("media")
            .await
            .unwrap()
            .owned_rooms
            .len(),
        1
    );
}

#[tokio::test]
async fn concurrent_revision_change_is_a_rejection_and_never_automatically_rebased() {
    let fixture = Fixture::new().await;
    fixture.state.mode.store(4, Ordering::SeqCst);
    let receipt = fixture.client().apply(drain()).await.unwrap();
    assert!(matches!(receipt.outcome, MaintenanceOutcome::Conflict));
    assert_eq!(receipt.http_status, Some(409));
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.state.data.lock().await.media_nodes["media"].revision,
        2
    );
}

#[tokio::test]
async fn room_assigned_after_preview_returns_service_in_use_without_confusing_prewrite_snapshot() {
    let fixture = Fixture::new().await;
    fixture.state.mode.store(12, Ordering::SeqCst);
    let command = MediaNodeCommand::RemoveMedia {
        operation_id: "remove".into(),
        expected_revision: 1,
        target: target(),
    };
    let receipt = fixture.client().apply(command).await.unwrap();
    assert!(matches!(receipt.outcome, MaintenanceOutcome::InUse));
    assert_eq!(receipt.writes_sent, 1);
    assert_eq!(receipt.service_outcome.as_deref(), Some("in_use"));
    assert_eq!(receipt.service_record.as_ref().unwrap().revision, 1);
    assert!(receipt.confirmed_record.is_none());
    assert!(receipt.observed.unwrap().owned_rooms.is_empty());
    assert_eq!(
        fixture
            .client()
            .preview("media")
            .await
            .unwrap()
            .owned_rooms
            .len(),
        1
    );
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn nonleader_read_can_try_next_configured_endpoint_but_wrong_identity_and_redirect_fail_closed()
 {
    let follower = Fixture::new().await;
    let leader = Fixture::new().await;
    follower.state.mode.store(8, Ordering::SeqCst);
    let client = MediaAdmin::new(config(vec![follower.endpoint, leader.endpoint])).unwrap();
    assert!(matches!(
        client.apply(drain()).await.unwrap().outcome,
        MaintenanceOutcome::Confirmed
    ));
    assert_eq!(follower.state.writes.load(Ordering::SeqCst), 0);
    assert_eq!(leader.state.writes.load(Ordering::SeqCst), 1);
    for mode in [6, 7, 10, 11] {
        follower.state.mode.store(mode, Ordering::SeqCst);
        assert!(client.apply(drain()).await.is_err());
    }
    assert_eq!(leader.state.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn missing_authority_or_wrong_credentials_never_issue_a_write_and_confirm_is_unknown() {
    let fixture = Fixture::new().await;
    fixture.state.mode.store(8, Ordering::SeqCst);
    assert!(fixture.client().apply(drain()).await.is_err());
    assert!(matches!(
        fixture.client().confirm(drain()).await.unwrap().outcome,
        MaintenanceOutcome::Unknown
    ));
    fixture.state.mode.store(0, Ordering::SeqCst);
    let mut cfg = config(vec![fixture.endpoint]);
    cfg.service_token = "another-valid-length-service-secret".into();
    assert!(MediaAdmin::new(cfg).unwrap().apply(drain()).await.is_err());
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn empty_node_remove_returns_tombstone_proof_and_receipts_never_contain_the_service_secret() {
    let fixture = Fixture::new().await;
    {
        let mut data = fixture.state.data.lock().await;
        apply_authority(
            &mut data,
            AuthorityCommand::Room(RoomCommand::Assign {
                tenant_id: "tenant".into(),
                room_id: "room".into(),
                operation_id: "assign".into(),
                expected_revision: None,
                target: target(),
            }),
            2,
            true,
        );
    }
    let remove = MediaNodeCommand::RemoveMedia {
        operation_id: "remove".into(),
        expected_revision: 1,
        target: target(),
    };
    let blocked = fixture.client().apply(remove.clone()).await.unwrap();
    assert!(matches!(blocked.outcome, MaintenanceOutcome::InUse));
    assert_eq!(blocked.service_outcome, None);
    assert_eq!(blocked.service_record, None);
    assert_eq!(blocked.writes_sent, 0);
    assert_eq!(
        blocked.observation_stage.as_ref().map(|stage| match stage {
            vs_coordination::media_admin::ObservationStage::Preview => "preview",
            vs_coordination::media_admin::ObservationStage::Readback => "readback",
        }),
        Some("preview")
    );
    assert_eq!(blocked.observed.unwrap().owned_rooms.len(), 1);
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 0);
    {
        let mut data = fixture.state.data.lock().await;
        apply_authority(
            &mut data,
            AuthorityCommand::Room(RoomCommand::Release {
                tenant_id: "tenant".into(),
                room_id: "room".into(),
                operation_id: "release".into(),
                expected_revision: 2,
                target: target(),
            }),
            3,
            true,
        );
    }
    let remove = MediaNodeCommand::RemoveMedia {
        operation_id: "remove-empty".into(),
        expected_revision: 1,
        target: target(),
    };
    let receipt = fixture.client().apply(remove).await.unwrap();
    assert!(matches!(receipt.outcome, MaintenanceOutcome::Confirmed));
    assert!(
        receipt
            .confirmed_record
            .as_ref()
            .unwrap()
            .registration
            .is_none()
    );
    assert!(!serde_json::to_string(&receipt).unwrap().contains(TOKEN));
    assert!(
        !serde_json::to_string(&fixture.client().preview("media").await.unwrap())
            .unwrap()
            .contains(TOKEN)
    );
}

#[tokio::test]
async fn invalid_or_unsupported_commands_are_rejected_before_network_io() {
    let fixture = Fixture::new().await;
    let mut invalid = drain();
    if let MediaNodeCommand::SetMediaDraining {
        expected_revision, ..
    } = &mut invalid
    {
        *expected_revision = 0;
    }
    assert!(fixture.client().apply(invalid).await.is_err());
    let register = fixture.state.data.lock().await.media_nodes["media"]
        .last_command
        .clone();
    assert!(fixture.client().apply(register).await.is_err());
    assert_eq!(fixture.state.reads.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn actual_cli_exit_codes_and_output_distinguish_confirmed_conflict_unknown_and_invalid_config()
 {
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    let command_path = dir.path().join("command.json");
    std::fs::write(
        &config_path,
        serde_json::to_vec(&serde_json::json!({
            "cluster_id":"test-cluster", "endpoints":[fixture.endpoint], "service_token":TOKEN,
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(&command_path, serde_json::to_vec(&drain()).unwrap()).unwrap();
    let execute = |mode: &'static str| {
        let config_path = config_path.clone();
        let command_path = command_path.clone();
        tokio::task::spawn_blocking(move || {
            std::process::Command::new(env!("CARGO_BIN_EXE_media-admin"))
                .arg(config_path)
                .arg(mode)
                .arg(command_path)
                .output()
                .unwrap()
        })
    };
    let unknown = execute("confirm").await.unwrap();
    assert_eq!(unknown.status.code(), Some(3));
    let value: serde_json::Value = serde_json::from_slice(&unknown.stdout).unwrap();
    assert_eq!(value["outcome"], "unknown");
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 0);
    let applied = execute("apply").await.unwrap();
    assert_eq!(applied.status.code(), Some(0));
    let value: serde_json::Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(value["outcome"], "confirmed");
    assert_eq!(value["confirmed_record"]["revision"], 2);
    let mut stale = drain();
    if let MediaNodeCommand::SetMediaDraining { operation_id, .. } = &mut stale {
        *operation_id = "different".into();
    }
    std::fs::write(&command_path, serde_json::to_vec(&stale).unwrap()).unwrap();
    let conflict = execute("apply").await.unwrap();
    assert_eq!(conflict.status.code(), Some(2));
    assert_eq!(fixture.state.writes.load(Ordering::SeqCst), 1);
    std::fs::write(
        &config_path,
        format!("{{\"service_token\":\"{TOKEN}\",\"extra\":true}}"),
    )
    .unwrap();
    let bad = execute("apply").await.unwrap();
    assert_eq!(bad.status.code(), Some(1));
    for output in [unknown, applied, conflict, bad] {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    }
}

#[test]
fn bounded_fixed_endpoint_config_rejects_remote_duplicate_or_invalid_credentials() {
    let address = "127.0.0.1:30000".parse().unwrap();
    for endpoints in [
        vec![],
        vec![address; 2],
        vec!["192.0.2.1:3000".parse().unwrap()],
        vec!["127.0.0.1:0".parse().unwrap()],
    ] {
        assert!(MediaAdmin::new(config(endpoints)).is_err());
    }
    for token in [
        "short".to_owned(),
        "x".repeat(257),
        format!("{}\n", "x".repeat(32)),
    ] {
        let mut cfg = config(vec![address]);
        cfg.service_token = token;
        assert!(MediaAdmin::new(cfg).is_err());
    }
}

#[tokio::test]
async fn preview_from_real_state_store_contains_one_consistent_node_and_owned_room_snapshot() {
    use openraft::{CommittedLeaderId, Entry, EntryPayload, LogId, storage::RaftStateMachine};
    use vs_coordination::{TypeConfig, storage::open_with_registry};
    let dir = tempfile::tempdir().unwrap();
    let (_, mut store) =
        open_with_registry(&dir.path().join("preview.redb"), "test-cluster", 1, true).unwrap();
    let fixture = Fixture::new().await;
    let registration = fixture.state.data.lock().await.media_nodes["media"]
        .last_command
        .clone();
    for (index, command) in [
        AuthorityCommand::Media(registration),
        AuthorityCommand::Room(RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "assign".into(),
            expected_revision: None,
            target: target(),
        }),
        AuthorityCommand::Media(drain()),
    ]
    .into_iter()
    .enumerate()
    {
        store
            .apply([Entry::<TypeConfig> {
                log_id: LogId::new(CommittedLeaderId::new(1, 1), index as u64 + 1),
                payload: EntryPayload::Normal(command),
            }])
            .await
            .unwrap();
    }
    let snapshot = store.media_maintenance("test-cluster", "media").await;
    assert!(snapshot.record.unwrap().draining);
    assert_eq!(snapshot.owned_rooms.len(), 1);
    assert_eq!(snapshot.owned_rooms[0].record.owner, Some(target()));
    let missing = store.media_maintenance("test-cluster", "missing").await;
    assert!(missing.record.is_none() && missing.owned_rooms.is_empty());
}
