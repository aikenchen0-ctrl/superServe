use std::{collections::BTreeMap, io::Cursor};

use serde::{Deserialize, Serialize};

pub mod media_admin;
pub mod media_registry;
pub mod media_release;
pub mod network;
pub mod profile_access;
pub mod profile_authority;
pub mod storage;
pub mod tls;

// OpenDAL等工作区依赖可能合并启用reqwest的rustls-no-provider特性。
// 沿用既有ring提供者；调用方已选其他提供者时不覆盖其选择。
fn ensure_http_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub type NodeId = u64;
pub const SNAPSHOT_LIMIT: usize = 2 * 1024 * 1024;
pub const MAX_ROOMS: usize = 64;

openraft::declare_raft_types!(
    pub TypeConfig:
        D = media_registry::AuthorityCommand,
        R = RoomReply,
);

pub type Raft = openraft::Raft<TypeConfig>;
pub type RpcError<E = openraft::error::Infallible> =
    openraft::error::RPCError<NodeId, openraft::BasicNode, openraft::error::RaftError<NodeId, E>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoomTarget {
    pub node_id: String,
    pub incarnation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoomCommand {
    Assign {
        tenant_id: String,
        room_id: String,
        operation_id: String,
        expected_revision: Option<u64>,
        target: RoomTarget,
    },
    Release {
        tenant_id: String,
        room_id: String,
        operation_id: String,
        expected_revision: u64,
        target: RoomTarget,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RoomRecord {
    pub revision: u64,
    pub owner: Option<RoomTarget>,
    pub last_command: RoomCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RoomReply {
    pub outcome: String,
    pub record: Option<RoomRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_node: Option<media_registry::MediaNodeRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Box<profile_authority::ProfileReply>>,
}

fn label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn target_valid(target: &RoomTarget) -> bool {
    label(&target.node_id)
        && target.incarnation.len() == 22
        && target
            .incarnation
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

impl RoomCommand {
    pub fn coordinates(&self) -> (&str, &str, &str) {
        match self {
            Self::Assign {
                tenant_id,
                room_id,
                operation_id,
                ..
            }
            | Self::Release {
                tenant_id,
                room_id,
                operation_id,
                ..
            } => (tenant_id, room_id, operation_id),
        }
    }

    pub fn valid(&self) -> bool {
        let (tenant, room, operation) = self.coordinates();
        let target = match self {
            Self::Assign { target, .. } | Self::Release { target, .. } => target,
        };
        label(tenant) && label(room) && label(operation) && target_valid(target)
    }
}

// 只在已提交日志上作确定性转换；不读取本机时钟，也不按TTL猜测旧媒体已停。
pub fn apply_command(
    rooms: &mut BTreeMap<String, RoomRecord>,
    command: RoomCommand,
    revision: u64,
) -> RoomReply {
    if !command.valid() || revision > 9_007_199_254_740_991 {
        return RoomReply {
            outcome: "invalid".into(),
            record: None,
            media_node: None,
            profile: None,
        };
    }
    let (tenant, room, operation) = command.coordinates();
    let key = format!("{tenant}/{room}");
    let current = rooms.get(&key).cloned();
    if let Some(current) = &current
        && current.last_command.coordinates().2 == operation
    {
        return RoomReply {
            outcome: if current.last_command == command {
                "duplicate"
            } else {
                "conflict"
            }
            .into(),
            record: Some(current.clone()),
            media_node: None,
            profile: None,
        };
    }
    let matches = match &command {
        RoomCommand::Assign {
            expected_revision, ..
        } => {
            current.as_ref().map(|record| record.revision) == *expected_revision
                && current.as_ref().is_none_or(|record| record.owner.is_none())
        }
        RoomCommand::Release {
            expected_revision,
            target,
            ..
        } => current.as_ref().is_some_and(|record| {
            record.revision == *expected_revision && record.owner.as_ref() == Some(target)
        }),
    };
    if !matches {
        return RoomReply {
            outcome: "conflict".into(),
            record: current,
            media_node: None,
            profile: None,
        };
    }
    if current.is_none() && rooms.len() >= MAX_ROOMS {
        return RoomReply {
            outcome: "capacity".into(),
            record: None,
            media_node: None,
            profile: None,
        };
    }
    let owner = match &command {
        RoomCommand::Assign { target, .. } => Some(target.clone()),
        RoomCommand::Release { .. } => None,
    };
    let record = RoomRecord {
        revision,
        owner,
        last_command: command,
    };
    rooms.insert(key, record.clone());
    RoomReply {
        outcome: "applied".into(),
        record: Some(record),
        media_node: None,
        profile: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assign(operation: &str, expected_revision: Option<u64>) -> RoomCommand {
        RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: operation.into(),
            expected_revision,
            target: RoomTarget {
                node_id: "media-a".into(),
                incarnation: "aaaaaaaaaaaaaaaaaaaaaa".into(),
            },
        }
    }

    #[test]
    fn competing_claims_retries_and_aba_keep_the_committed_owner() {
        let mut rooms = BTreeMap::new();
        let first = assign("one", None);
        assert_eq!(
            apply_command(&mut rooms, first.clone(), 3).outcome,
            "applied"
        );
        assert_eq!(
            apply_command(&mut rooms, first, 4).record.unwrap().revision,
            3
        );
        assert_eq!(
            apply_command(&mut rooms, assign("two", None), 5).outcome,
            "conflict"
        );
        assert_eq!(
            apply_command(&mut rooms, assign("two", Some(3)), 6).outcome,
            "conflict"
        );
        let target = rooms["tenant/room"].owner.clone().unwrap();
        let release = RoomCommand::Release {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "release".into(),
            expected_revision: 3,
            target,
        };
        assert_eq!(
            apply_command(&mut rooms, release.clone(), 7).outcome,
            "applied"
        );
        assert_eq!(
            apply_command(&mut rooms, assign("three", None), 8).outcome,
            "conflict"
        );
        assert_eq!(
            apply_command(&mut rooms, assign("three", Some(7)), 9).outcome,
            "applied"
        );
        assert_eq!(apply_command(&mut rooms, release, 10).outcome, "conflict");
        assert_eq!(rooms["tenant/room"].revision, 9);
    }
}
