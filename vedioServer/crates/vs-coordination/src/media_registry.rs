// 参考Danube登记元数据与服务地址分离的机制；节点存活不参与房间所有权判定。
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
};

use serde::{Deserialize, Serialize};

use crate::{RoomCommand, RoomRecord, RoomReply, RoomTarget, apply_command};

pub const MAX_MEDIA_NODES: usize = 64;
const MAX_NODE_ROOMS: usize = 8;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaControlTransport {
    #[default]
    LoopbackHttp,
    MtlsV1,
}

fn is_legacy_transport(transport: &MediaControlTransport) -> bool {
    *transport == MediaControlTransport::LoopbackHttp
}

#[derive(Debug, Clone)]
pub enum MediaRegistryPolicy {
    Disabled,
    LoopbackHttp,
    MtlsV1(BTreeMap<String, SocketAddr>),
}

impl MediaRegistryPolicy {
    pub fn enabled(&self) -> bool {
        !matches!(self, Self::Disabled)
    }

    pub fn accepts_registration(&self, registration: &MediaRegistration) -> bool {
        if !vs_tls::allowed_endpoint(
            registration.endpoint,
            registration.transport == MediaControlTransport::MtlsV1,
        ) {
            return false;
        }
        match self {
            Self::Disabled => false,
            Self::LoopbackHttp => registration.transport == MediaControlTransport::LoopbackHttp,
            Self::MtlsV1(directory) => {
                registration.transport == MediaControlTransport::MtlsV1
                    && directory.get(&registration.target.node_id) == Some(&registration.endpoint)
            }
        }
    }

    pub fn accepts_command(&self, command: &MediaNodeCommand) -> bool {
        self.enabled()
            && command.valid()
            && match command {
                MediaNodeCommand::RegisterMedia { registration, .. } => {
                    self.accepts_registration(registration)
                }
                _ => match self {
                    Self::MtlsV1(directory) => directory.contains_key(&command.target().node_id),
                    _ => true,
                },
            }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct RoomName {
    pub tenant_id: String,
    pub room_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MediaRegistration {
    pub target: RoomTarget,
    pub endpoint: SocketAddr,
    pub rooms: Vec<RoomName>,
    #[serde(default, skip_serializing_if = "is_legacy_transport")]
    pub transport: MediaControlTransport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaNodeCommand {
    RegisterMedia {
        operation_id: String,
        expected_revision: Option<u64>,
        registration: MediaRegistration,
    },
    RemoveMedia {
        operation_id: String,
        expected_revision: u64,
        target: RoomTarget,
    },
    SetMediaDraining {
        operation_id: String,
        expected_revision: u64,
        target: RoomTarget,
        draining: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MediaNodeRecord {
    pub revision: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub draining: bool,
    pub registration: Option<MediaRegistration>,
    pub last_command: MediaNodeCommand,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct MediaNodeReply {
    pub outcome: String,
    pub record: Option<MediaNodeRecord>,
}

// 旧房间命令的JSON形状保持；新命令以不同operation区分，不改写历史日志。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AuthorityCommand {
    Room(RoomCommand),
    Media(MediaNodeCommand),
    Profile(crate::profile_authority::ProfileCommand),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "result", rename_all = "snake_case")]
pub enum AuthorityReply {
    Room(RoomReply),
    Media(MediaNodeReply),
    Profile(crate::profile_authority::ProfileReply),
}

impl Default for AuthorityReply {
    fn default() -> Self {
        Self::Room(RoomReply::default())
    }
}

impl From<AuthorityReply> for RoomReply {
    fn from(reply: AuthorityReply) -> Self {
        match reply {
            AuthorityReply::Room(reply) => reply,
            AuthorityReply::Media(reply) => Self {
                outcome: reply.outcome,
                record: None,
                media_node: reply.record,
                profile: None,
            },
            AuthorityReply::Profile(reply) => Self {
                outcome: reply.outcome.clone(),
                record: None,
                media_node: None,
                profile: Some(Box::new(reply)),
            },
        }
    }
}

impl MediaNodeCommand {
    pub fn target(&self) -> &RoomTarget {
        match self {
            Self::RegisterMedia { registration, .. } => &registration.target,
            Self::RemoveMedia { target, .. } | Self::SetMediaDraining { target, .. } => target,
        }
    }

    fn operation_id(&self) -> &str {
        match self {
            Self::RegisterMedia { operation_id, .. }
            | Self::RemoveMedia { operation_id, .. }
            | Self::SetMediaDraining { operation_id, .. } => operation_id,
        }
    }

    pub fn valid(&self) -> bool {
        let target = self.target();
        if !crate::label(self.operation_id())
            || !crate::target_valid(target)
            || matches!(target.node_id.as_str(), "." | "..")
        {
            return false;
        }
        match self {
            Self::RegisterMedia {
                expected_revision,
                registration,
                ..
            } => {
                expected_revision.is_none_or(valid_revision)
                    && vs_tls::allowed_endpoint(
                        registration.endpoint,
                        registration.transport == MediaControlTransport::MtlsV1,
                    )
                    && (1..=MAX_NODE_ROOMS).contains(&registration.rooms.len())
                    && registration.rooms.iter().all(|room| {
                        crate::label(&room.tenant_id)
                            && crate::label(&room.room_id)
                            && !matches!(room.tenant_id.as_str(), "." | "..")
                            && !matches!(room.room_id.as_str(), "." | "..")
                    })
                    && registration.rooms.iter().collect::<BTreeSet<_>>().len()
                        == registration.rooms.len()
            }
            Self::RemoveMedia {
                expected_revision, ..
            }
            | Self::SetMediaDraining {
                expected_revision, ..
            } => valid_revision(*expected_revision),
        }
    }
}

fn valid_revision(revision: u64) -> bool {
    revision > 0 && revision <= 9_007_199_254_740_991
}

pub fn apply_authority(
    state: &mut crate::storage::StateData,
    command: AuthorityCommand,
    revision: u64,
    registry_required: bool,
) -> AuthorityReply {
    apply_authority_with_policy(
        state,
        command,
        revision,
        &if registry_required {
            MediaRegistryPolicy::LoopbackHttp
        } else {
            MediaRegistryPolicy::Disabled
        },
    )
}

pub fn apply_authority_with_policy(
    state: &mut crate::storage::StateData,
    command: AuthorityCommand,
    revision: u64,
    policy: &MediaRegistryPolicy,
) -> AuthorityReply {
    if let Some(ledger) = &mut state.profiles {
        return match command {
            AuthorityCommand::Profile(command) => {
                AuthorityReply::Profile(ledger.apply(command, revision))
            }
            _ => AuthorityReply::Room(RoomReply {
                outcome: "disabled".into(),
                ..Default::default()
            }),
        };
    }
    match command {
        AuthorityCommand::Profile(_) => {
            AuthorityReply::Profile(crate::profile_authority::ProfileReply {
                outcome: "disabled".into(),
                ..Default::default()
            })
        }
        AuthorityCommand::Room(command) => AuthorityReply::Room(apply_room(
            &mut state.rooms,
            &state.media_nodes,
            command,
            revision,
            policy.enabled(),
        )),
        AuthorityCommand::Media(command) => AuthorityReply::Media(if !policy.enabled() {
            MediaNodeReply {
                outcome: "disabled".into(),
                record: None,
            }
        } else if policy.accepts_command(&command) {
            apply_media(&mut state.media_nodes, &state.rooms, command, revision)
        } else {
            MediaNodeReply {
                outcome: "invalid".into(),
                record: None,
            }
        }),
    }
}

pub fn apply_media(
    nodes: &mut BTreeMap<String, MediaNodeRecord>,
    rooms: &BTreeMap<String, RoomRecord>,
    command: MediaNodeCommand,
    revision: u64,
) -> MediaNodeReply {
    if !command.valid() || !valid_revision(revision) {
        return MediaNodeReply {
            outcome: "invalid".into(),
            record: None,
        };
    }
    let node_id = &command.target().node_id;
    let current = nodes.get(node_id).cloned();
    let reply = |outcome: &str| MediaNodeReply {
        outcome: outcome.into(),
        record: current.clone(),
    };
    if let Some(record) = &current
        && record.last_command.operation_id() == command.operation_id()
    {
        return reply(if record.last_command == command {
            "duplicate"
        } else {
            "conflict"
        });
    }
    let matches = match &command {
        MediaNodeCommand::RegisterMedia {
            expected_revision, ..
        } => current.as_ref().map(|record| record.revision) == *expected_revision,
        MediaNodeCommand::RemoveMedia {
            expected_revision,
            target,
            ..
        }
        | MediaNodeCommand::SetMediaDraining {
            expected_revision,
            target,
            ..
        } => current.as_ref().is_some_and(|record| {
            record.revision == *expected_revision
                && record
                    .registration
                    .as_ref()
                    .is_some_and(|entry| &entry.target == target)
        }),
    };
    if !matches {
        return reply("conflict");
    }
    // 停止接新房间不改动既有房间及控制地址，房间排空仍使用原有可信回执。
    if let MediaNodeCommand::SetMediaDraining { draining, .. } = &command {
        let record = MediaNodeRecord {
            revision,
            draining: *draining,
            registration: current
                .as_ref()
                .and_then(|record| record.registration.clone()),
            last_command: command.clone(),
        };
        nodes.insert(node_id.clone(), record.clone());
        return MediaNodeReply {
            outcome: "applied".into(),
            record: Some(record),
        };
    }
    // 在同一已提交状态机中检查引用，避免登记删除与房间分配之间的检查/提交竞态。
    if rooms.values().any(|room| {
        room.owner
            .as_ref()
            .is_some_and(|owner| &owner.node_id == node_id)
    }) {
        return reply("in_use");
    }
    if current.is_none() && nodes.len() >= MAX_MEDIA_NODES {
        return reply("capacity");
    }
    let registration = match &command {
        MediaNodeCommand::RegisterMedia { registration, .. } => {
            if nodes
                .values()
                .filter_map(|node| node.registration.as_ref())
                .any(|other| {
                    other.target.node_id != *node_id && other.endpoint == registration.endpoint
                })
            {
                return reply("endpoint_in_use");
            }
            Some(registration.clone())
        }
        MediaNodeCommand::RemoveMedia { .. } => None,
        MediaNodeCommand::SetMediaDraining { .. } => unreachable!("节点排空标记已处理"),
    };
    let node_id = node_id.clone();
    let record = MediaNodeRecord {
        revision,
        // 更新登记地址或启动身份不能隐式取消维护；删除墓碑不携带接单状态。
        draining: registration.is_some() && current.as_ref().is_some_and(|record| record.draining),
        registration,
        last_command: command,
    };
    nodes.insert(node_id, record.clone());
    MediaNodeReply {
        outcome: "applied".into(),
        record: Some(record),
    }
}

pub fn apply_room(
    rooms: &mut BTreeMap<String, RoomRecord>,
    nodes: &BTreeMap<String, MediaNodeRecord>,
    command: RoomCommand,
    revision: u64,
    registry_required: bool,
) -> RoomReply {
    let (tenant, room, _) = command.coordinates();
    let key = format!("{tenant}/{room}");
    // 同一已提交命令的重试不产生新分配，不能因后来排空而改判。
    if rooms
        .get(&key)
        .is_some_and(|record| record.last_command == command)
    {
        return apply_command(rooms, command, revision);
    }
    if registry_required
        && let RoomCommand::Assign {
            tenant_id,
            room_id,
            target,
            ..
        } = &command
        && !nodes
            .get(&target.node_id)
            .and_then(|node| node.registration.as_ref())
            .is_some_and(|entry| {
                entry.target == *target
                    && entry
                        .rooms
                        .iter()
                        .any(|room| room.tenant_id == *tenant_id && room.room_id == *room_id)
            })
    {
        return RoomReply {
            outcome: "unregistered".into(),
            record: rooms.get(&format!("{tenant_id}/{room_id}")).cloned(),
            media_node: None,
            profile: None,
        };
    }
    if registry_required
        && let RoomCommand::Assign { target, .. } = &command
        && nodes
            .get(&target.node_id)
            .is_some_and(|record| record.draining)
    {
        return RoomReply {
            outcome: "node_draining".into(),
            record: rooms.get(&key).cloned(),
            media_node: None,
            profile: None,
        };
    }
    apply_command(rooms, command, revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(incarnation: &str) -> RoomTarget {
        RoomTarget {
            node_id: "media-a".into(),
            incarnation: incarnation.into(),
        }
    }

    fn registration(incarnation: &str, port: u16) -> MediaRegistration {
        MediaRegistration {
            target: target(incarnation),
            endpoint: SocketAddr::from(([127, 0, 0, 1], port)),
            rooms: vec![RoomName {
                tenant_id: "tenant".into(),
                room_id: "room".into(),
            }],
            transport: MediaControlTransport::LoopbackHttp,
        }
    }

    fn register(
        operation: &str,
        expected: Option<u64>,
        registration: MediaRegistration,
    ) -> MediaNodeCommand {
        MediaNodeCommand::RegisterMedia {
            operation_id: operation.into(),
            expected_revision: expected,
            registration,
        }
    }

    #[test]
    fn explicit_tls_transport_does_not_expand_legacy_wire_or_network_scope() {
        let legacy = registration("aaaaaaaaaaaaaaaaaaaaaa", 32001);
        let bytes = serde_json::to_vec(&legacy).unwrap();
        assert_eq!(bytes, br#"{"target":{"node_id":"media-a","incarnation":"aaaaaaaaaaaaaaaaaaaaaa"},"endpoint":"127.0.0.1:32001","rooms":[{"tenant_id":"tenant","room_id":"room"}]}"#);
        assert_eq!(
            serde_json::from_slice::<MediaRegistration>(&bytes).unwrap(),
            legacy
        );
        for address in [
            "127.0.0.1:32001",
            "10.1.2.3:7443",
            "172.16.2.3:7443",
            "192.168.2.3:7443",
            "[::1]:7443",
            "[fd00::1]:7443",
            "0.0.0.0:7443",
            "192.0.2.1:7443",
            "8.8.8.8:7443",
            "169.254.169.254:80",
            "[fe80::1]:7443",
            "[2001:db8::1]:7443",
            "127.0.0.1:0",
        ] {
            let mut entry = legacy.clone();
            entry.endpoint = address.parse().unwrap();
            assert_eq!(
                register("legacy", None, entry.clone()).valid(),
                entry.endpoint.ip().is_loopback() && entry.endpoint.port() != 0,
                "{address}"
            );
            entry.transport = MediaControlTransport::MtlsV1;
            assert_eq!(
                register("modern", None, entry.clone()).valid(),
                vs_tls::allowed_endpoint(entry.endpoint, true),
                "{address}"
            );
        }
        let mut invalid = serde_json::to_value(&legacy).unwrap();
        invalid["transport"] = serde_json::json!("https");
        assert!(serde_json::from_value::<MediaRegistration>(invalid).is_err());
    }

    #[test]
    fn directory_separates_authorized_destination_from_dynamic_incarnation_and_cas() {
        let mut entry = registration("aaaaaaaaaaaaaaaaaaaaaa", 32001);
        entry.endpoint = "10.1.2.3:7443".parse().unwrap();
        entry.transport = MediaControlTransport::MtlsV1;
        let policy = MediaRegistryPolicy::MtlsV1(BTreeMap::from([
            (entry.target.node_id.clone(), entry.endpoint),
            ("media-b".into(), "10.1.2.4:7443".parse().unwrap()),
        ]));
        let first = register("register", None, entry.clone());
        assert!(policy.accepts_command(&first));
        assert!(!MediaRegistryPolicy::LoopbackHttp.accepts_command(&first));
        assert!(!MediaRegistryPolicy::Disabled.accepts_command(&first));
        for changed in ["node", "borrowed-node", "address", "port", "transport"] {
            let mut wrong = entry.clone();
            match changed {
                "node" => wrong.target.node_id = "unlisted".into(),
                "borrowed-node" => wrong.target.node_id = "media-b".into(),
                "address" => wrong.endpoint = "10.1.2.4:7443".parse().unwrap(),
                "port" => wrong.endpoint.set_port(7444),
                "transport" => wrong.transport = MediaControlTransport::LoopbackHttp,
                _ => unreachable!(),
            }
            let mut state = crate::storage::StateData::default();
            assert!(matches!(
                apply_authority_with_policy(
                    &mut state, AuthorityCommand::Media(register("denied", None, wrong)),
                    2, &policy
                ), AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "invalid"
            ));
            assert!(state.media_nodes.is_empty());
        }
        let mut state = crate::storage::StateData::default();
        let apply = |state: &mut crate::storage::StateData, command, revision| {
            match apply_authority_with_policy(state, command, revision, &policy) {
                AuthorityReply::Media(reply) => reply.outcome,
                AuthorityReply::Room(reply) => reply.outcome,
                AuthorityReply::Profile(reply) => reply.outcome,
            }
        };
        assert_eq!(
            apply(&mut state, AuthorityCommand::Media(first.clone()), 2),
            "applied"
        );
        assert_eq!(
            apply(&mut state, AuthorityCommand::Media(first), 3),
            "duplicate"
        );
        let assign = RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "assign".into(),
            expected_revision: None,
            target: entry.target.clone(),
        };
        assert_eq!(
            apply(&mut state, AuthorityCommand::Room(assign), 3),
            "applied"
        );
        let mut next = entry.clone();
        next.target.incarnation = "bbbbbbbbbbbbbbbbbbbbbb".into();
        assert_eq!(
            apply(
                &mut state,
                AuthorityCommand::Media(register("replace", Some(2), next.clone())),
                4
            ),
            "in_use"
        );
        let release = RoomCommand::Release {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "release".into(),
            expected_revision: 3,
            target: entry.target.clone(),
        };
        assert_eq!(
            apply(&mut state, AuthorityCommand::Room(release), 4),
            "applied"
        );
        let remove = MediaNodeCommand::RemoveMedia {
            operation_id: "remove".into(),
            expected_revision: 2,
            target: entry.target,
        };
        assert_eq!(
            apply(&mut state, AuthorityCommand::Media(remove), 5),
            "applied"
        );
        assert_eq!(
            apply(
                &mut state,
                AuthorityCommand::Media(register("aba", None, next.clone())),
                6
            ),
            "conflict"
        );
        assert_eq!(
            apply(
                &mut state,
                AuthorityCommand::Media(register("replace", Some(5), next)),
                7
            ),
            "applied"
        );
        assert_eq!(state.media_nodes["media-a"].revision, 7);
    }

    #[test]
    fn onboarding_rejects_stale_updates_and_endpoint_changes_while_rooms_are_owned() {
        let mut state = crate::storage::StateData::default();
        let first = register(
            "register-a",
            None,
            registration("aaaaaaaaaaaaaaaaaaaaaa", 32001),
        );
        assert!(matches!(
            apply_authority(
                &mut state,
                AuthorityCommand::Media(first.clone()),
                2,
                true
            ),
            AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "applied"
        ));
        assert!(matches!(
            apply_authority(&mut state, AuthorityCommand::Media(first), 3, true),
            AuthorityReply::Media(MediaNodeReply {
                outcome,
                record: Some(MediaNodeRecord { revision: 2, .. })
            }) if outcome == "duplicate"
        ));
        let assignment = RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "assign-a".into(),
            expected_revision: None,
            target: target("aaaaaaaaaaaaaaaaaaaaaa"),
        };
        assert!(matches!(
            apply_authority(&mut state, AuthorityCommand::Room(assignment), 3, true),
            AuthorityReply::Room(RoomReply { outcome, .. }) if outcome == "applied"
        ));
        let update = register(
            "move-a",
            Some(2),
            registration("bbbbbbbbbbbbbbbbbbbbbb", 32002),
        );
        for command in [
            update,
            MediaNodeCommand::RemoveMedia {
                operation_id: "remove-a".into(),
                expected_revision: 2,
                target: target("aaaaaaaaaaaaaaaaaaaaaa"),
            },
        ] {
            assert!(matches!(
                apply_authority(&mut state, AuthorityCommand::Media(command), 4, true),
                AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "in_use"
            ));
        }
        assert!(matches!(
            apply_authority(
                &mut state,
                AuthorityCommand::Media(register(
                    "stale",
                    Some(1),
                    registration("aaaaaaaaaaaaaaaaaaaaaa", 32001)
                )),
                4,
                true
            ),
            AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "conflict"
        ));
        assert_eq!(
            state.media_nodes["media-a"]
                .registration
                .as_ref()
                .unwrap()
                .endpoint
                .port(),
            32001
        );
    }

    #[test]
    fn room_allocation_requires_exact_media_incarnation_and_declared_scope() {
        let mut state = crate::storage::StateData::default();
        apply_authority(
            &mut state,
            AuthorityCommand::Media(register(
                "register",
                None,
                registration("aaaaaaaaaaaaaaaaaaaaaa", 32001),
            )),
            2,
            true,
        );
        let make = |operation: &str, room: &str, incarnation: &str| RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: room.into(),
            operation_id: operation.into(),
            expected_revision: None,
            target: target(incarnation),
        };
        for (operation, room, incarnation) in [
            ("wrong-generation", "room", "bbbbbbbbbbbbbbbbbbbbbb"),
            ("wrong-room", "other", "aaaaaaaaaaaaaaaaaaaaaa"),
        ] {
            assert!(matches!(
                apply_authority(
                    &mut state,
                    AuthorityCommand::Room(make(operation, room, incarnation)),
                    3,
                    true
                ),
                AuthorityReply::Room(RoomReply { outcome, .. }) if outcome == "unregistered"
            ));
        }
        assert!(matches!(
            apply_authority(
                &mut state,
                AuthorityCommand::Room(make("valid", "room", "aaaaaaaaaaaaaaaaaaaaaa")),
                3,
                true
            ),
            AuthorityReply::Room(RoomReply { outcome, .. }) if outcome == "applied"
        ));
    }

    #[test]
    fn disabled_registry_preserves_legacy_room_commands_but_rejects_registry_writes() {
        let mut state = crate::storage::StateData::default();
        assert!(matches!(
            apply_authority(
                &mut state,
                AuthorityCommand::Media(register(
                    "disabled",
                    None,
                    registration("aaaaaaaaaaaaaaaaaaaaaa", 32001)
                )),
                2,
                false
            ),
            AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "disabled"
        ));
        assert!(state.media_nodes.is_empty());
        let command = RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "legacy".into(),
            expected_revision: None,
            target: target("aaaaaaaaaaaaaaaaaaaaaa"),
        };
        assert!(matches!(
            apply_authority(&mut state, AuthorityCommand::Room(command), 2, false),
            AuthorityReply::Room(RoomReply { outcome, .. }) if outcome == "applied"
        ));
    }

    #[test]
    fn remove_and_assign_serialize_in_either_order_without_dangling_ownership() {
        for assign_first in [false, true] {
            let mut state = crate::storage::StateData::default();
            apply_authority(
                &mut state,
                AuthorityCommand::Media(register(
                    "create",
                    None,
                    registration("aaaaaaaaaaaaaaaaaaaaaa", 32001),
                )),
                2,
                true,
            );
            let assign = RoomCommand::Assign {
                tenant_id: "tenant".into(),
                room_id: "room".into(),
                operation_id: "assign".into(),
                expected_revision: None,
                target: target("aaaaaaaaaaaaaaaaaaaaaa"),
            };
            let remove = MediaNodeCommand::RemoveMedia {
                operation_id: "remove".into(),
                expected_revision: 2,
                target: target("aaaaaaaaaaaaaaaaaaaaaa"),
            };
            let commands = if assign_first {
                [
                    AuthorityCommand::Room(assign),
                    AuthorityCommand::Media(remove),
                ]
            } else {
                [
                    AuthorityCommand::Media(remove),
                    AuthorityCommand::Room(assign),
                ]
            };
            for (index, command) in commands.into_iter().enumerate() {
                apply_authority(&mut state, command, index as u64 + 3, true);
            }
            assert_eq!(
                state.rooms.values().any(|room| room.owner.is_some()),
                assign_first
            );
            assert_eq!(
                state.media_nodes["media-a"].registration.is_some(),
                assign_first
            );
            if !assign_first {
                assert!(matches!(
                    apply_authority(&mut state, AuthorityCommand::Media(register("aba", None, registration("bbbbbbbbbbbbbbbbbbbbbb", 32002))), 5, true),
                    AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "conflict"
                ));
                assert!(matches!(
                    apply_authority(&mut state, AuthorityCommand::Media(register("recreate", Some(3), registration("bbbbbbbbbbbbbbbbbbbbbb", 32002))), 6, true),
                    AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "applied"
                ));
            }
        }
    }

    #[test]
    fn address_scope_capacity_and_wire_format_boundaries_remain_explicit() {
        let mut state = crate::storage::StateData::default();
        let entry = registration("aaaaaaaaaaaaaaaaaaaaaa", 32001);
        for address in ["0.0.0.0:1234", "192.0.2.1:1234", "127.0.0.1:0"] {
            let mut changed = entry.clone();
            changed.endpoint = address.parse().unwrap();
            assert!(!register("invalid", None, changed).valid());
        }
        let mut duplicate_rooms = entry.clone();
        duplicate_rooms.rooms.push(duplicate_rooms.rooms[0].clone());
        assert!(!register("duplicate", None, duplicate_rooms).valid());
        for id in [".", ".."] {
            let mut invalid = entry.clone();
            invalid.target.node_id = id.into();
            assert!(!register("invalid-path", None, invalid).valid());
        }
        for index in 0..MAX_MEDIA_NODES {
            let mut changed = entry.clone();
            changed.target.node_id = format!("media-{index}");
            if index == 1 {
                assert!(matches!(
                    apply_authority(&mut state, AuthorityCommand::Media(register("duplicate-endpoint", None, changed.clone())), 3, true),
                    AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "endpoint_in_use"
                ));
            }
            changed.endpoint.set_port(32001 + index as u16);
            assert!(matches!(
                apply_authority(&mut state, AuthorityCommand::Media(register("create", None, changed)), index as u64 + 2, true),
                AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "applied"
            ));
        }
        assert!(matches!(
            apply_authority(&mut state, AuthorityCommand::Media(register("overflow", None, entry)), 100, true),
            AuthorityReply::Media(MediaNodeReply { outcome, .. }) if outcome == "capacity"
        ));
        let old = RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "legacy".into(),
            expected_revision: None,
            target: target("aaaaaaaaaaaaaaaaaaaaaa"),
        };
        let legacy = serde_json::to_value(&old).unwrap();
        let wrapped = serde_json::to_value(AuthorityCommand::Room(old)).unwrap();
        assert_eq!(legacy, wrapped);
        assert!(matches!(
            serde_json::from_value::<AuthorityCommand>(legacy).unwrap(),
            AuthorityCommand::Room(_)
        ));
        // 空记录的两类结果必须可区分，不能因无标签反序列化把节点结果读成房间结果。
        let encoded =
            serde_json::to_vec(&AuthorityReply::Media(MediaNodeReply::default())).unwrap();
        assert!(matches!(
            serde_json::from_slice::<AuthorityReply>(&encoded).unwrap(),
            AuthorityReply::Media(_)
        ));
        let legacy_reply = serde_json::to_value(RoomReply {
            outcome: "applied".into(),
            record: None,
            media_node: None,
            profile: None,
        })
        .unwrap();
        assert_eq!(
            legacy_reply,
            serde_json::json!({"outcome":"applied","record":null})
        );
    }
}
