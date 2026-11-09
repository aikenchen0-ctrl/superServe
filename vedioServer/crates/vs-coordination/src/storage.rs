// SPDX-License-Identifier: Apache-2.0
// 持久日志结构改编自Danube v0.16.0 log_store.rs；状态机/快照接口参考OpenRaft示例。
// 来源署名与修改范围见LICENSES/room-authority-NOTICE.txt。
#![allow(
    clippy::result_large_err,
    reason = "OpenRaft存储契约固定返回该错误类型"
)]
use std::{
    collections::BTreeMap,
    fmt::Debug,
    io::{self, Cursor},
    ops::RangeBounds,
    path::Path,
    sync::Arc,
};

use openraft::{
    BasicNode, Entry, EntryPayload, LogId, OptionalSend, RaftSnapshotBuilder, SnapshotMeta,
    StorageError, StoredMembership, Vote,
    storage::{LogFlushed, LogState, RaftLogReader, RaftLogStorage, RaftStateMachine, Snapshot},
};
use redb::{Database, ReadableTable, ReadableTableMetadata, TableDefinition};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::sync::RwLock;

use crate::{
    NodeId, RoomRecord, RoomReply, SNAPSHOT_LIMIT, TypeConfig,
    media_registry::{
        AuthorityReply, MAX_MEDIA_NODES, MediaNodeRecord, MediaRegistryPolicy,
        apply_authority_with_policy,
    },
};

const LOG: TableDefinition<u64, &[u8]> = TableDefinition::new("raft_log");
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("raft_meta");

fn failure(error: impl std::fmt::Display) -> StorageError<NodeId> {
    StorageError::from_io_error(
        openraft::ErrorSubject::Store,
        openraft::ErrorVerb::Write,
        io::Error::other(error.to_string()),
    )
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>, StorageError<NodeId>> {
    serde_json::to_vec(value).map_err(failure)
}

fn read<T: DeserializeOwned>(db: &Database, key: &str) -> Result<Option<T>, StorageError<NodeId>> {
    let tx = db.begin_read().map_err(failure)?;
    let table = tx.open_table(META).map_err(failure)?;
    table
        .get(key)
        .map_err(failure)?
        .map(|value| serde_json::from_slice(value.value()).map_err(failure))
        .transpose()
}

fn write(db: &Database, key: &str, value: &impl Serialize) -> Result<(), StorageError<NodeId>> {
    let bytes = encode(value)?;
    let tx = db.begin_write().map_err(failure)?;
    {
        tx.open_table(META)
            .map_err(failure)?
            .insert(key, bytes.as_slice())
            .map_err(failure)?;
    }
    tx.commit().map_err(failure)
}

#[derive(Clone)]
pub struct LogStore {
    db: Arc<Database>,
}

impl LogStore {
    pub fn pin_policy(&self, policy: &str) -> Result<(), StorageError<NodeId>> {
        match read::<String>(&self.db, "room_policy")? {
            Some(saved) if saved != policy => Err(failure("协调排空策略与持久身份不符")),
            Some(_) => Ok(()),
            None => {
                let state: Option<StateData> = read(&self.db, "state")?;
                let tx = self.db.begin_read().map_err(failure)?;
                if state.is_some()
                    || !tx
                        .open_table(LOG)
                        .map_err(failure)?
                        .is_empty()
                        .map_err(failure)?
                {
                    return Err(failure("已有协调历史缺少策略身份，需要显式迁移"));
                }
                drop(tx);
                write(&self.db, "room_policy", &policy)
            }
        }
    }
}

#[derive(Clone)]
pub struct StateStore {
    db: Arc<Database>,
    state: Arc<RwLock<StateData>>,
    registry_policy: MediaRegistryPolicy,
    profile_policy: Option<crate::profile_authority::ProfilePolicy>,
}

impl StateStore {
    pub async fn profile_read_view(
        &self,
    ) -> Option<(crate::profile_authority::ProfileLedger, u64)> {
        let state = self.state.read().await;
        Some((state.profiles.clone()?, state.last_applied_log?.index))
    }

    pub async fn profile_ledger(&self) -> Option<crate::profile_authority::ProfileLedger> {
        self.state.read().await.profiles.clone()
    }
    pub async fn media_maintenance(
        &self,
        cluster: &str,
        id: &str,
    ) -> crate::media_admin::MaintenanceView {
        let state = self.state.read().await;
        crate::media_admin::MaintenanceView {
            cluster_id: cluster.into(),
            node_id: id.into(),
            record: state.media_nodes.get(id).cloned(),
            owned_rooms: state
                .rooms
                .values()
                .filter_map(|record| {
                    record.owner.as_ref().filter(|owner| owner.node_id == id)?;
                    let (tenant, room, _) = record.last_command.coordinates();
                    Some(crate::media_admin::OwnedRoom {
                        tenant_id: tenant.into(),
                        room_id: room.into(),
                        record: record.clone(),
                    })
                })
                .collect(),
        }
    }

    pub async fn room(&self, key: &str) -> Option<RoomRecord> {
        self.state.read().await.rooms.get(key).cloned()
    }

    pub async fn media_node(&self, id: &str) -> Option<MediaNodeRecord> {
        self.state.read().await.media_nodes.get(id).cloned()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct StateData {
    pub last_applied_log: Option<LogId<NodeId>>,
    pub last_membership: StoredMembership<NodeId, BasicNode>,
    pub rooms: BTreeMap<String, RoomRecord>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub media_nodes: BTreeMap<String, MediaNodeRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profiles: Option<crate::profile_authority::ProfileLedger>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SavedSnapshot {
    meta: SnapshotMeta<NodeId, BasicNode>,
    data: Vec<u8>,
}

pub fn open(
    path: &Path,
    cluster: &str,
    node: NodeId,
) -> Result<(LogStore, StateStore), StorageError<NodeId>> {
    open_with_registry(path, cluster, node, false)
}

pub fn open_with_registry(
    path: &Path,
    cluster: &str,
    node: NodeId,
    registry_required: bool,
) -> Result<(LogStore, StateStore), StorageError<NodeId>> {
    open_with_registry_policy(
        path,
        cluster,
        node,
        if registry_required {
            MediaRegistryPolicy::LoopbackHttp
        } else {
            MediaRegistryPolicy::Disabled
        },
    )
}

fn valid_media_state(state: &StateData, policy: &MediaRegistryPolicy) -> bool {
    state.media_nodes.len() <= MAX_MEDIA_NODES
        && (policy.enabled() || state.media_nodes.is_empty())
        && state.media_nodes.iter().all(|(id, record)| {
            crate::media_admin::valid_record(id, record)
                && policy.accepts_command(&record.last_command)
                && record
                    .registration
                    .as_ref()
                    .is_none_or(|entry| policy.accepts_registration(entry))
        })
}

pub fn open_with_registry_policy(
    path: &Path,
    cluster: &str,
    node: NodeId,
    registry_policy: MediaRegistryPolicy,
) -> Result<(LogStore, StateStore), StorageError<NodeId>> {
    open_with_policies(path, cluster, node, registry_policy, None)
}

pub fn open_with_profile_policy(
    path: &Path,
    cluster: &str,
    node: NodeId,
    policy: crate::profile_authority::ProfilePolicy,
) -> Result<(LogStore, StateStore), StorageError<NodeId>> {
    open_with_policies(
        path,
        cluster,
        node,
        MediaRegistryPolicy::Disabled,
        Some(policy),
    )
}

fn valid_profile_state(
    state: &StateData,
    policy: &Option<crate::profile_authority::ProfilePolicy>,
) -> bool {
    match (&state.profiles, policy) {
        (None, None) => true,
        (Some(ledger), Some(policy)) => {
            state.rooms.is_empty()
                && state.media_nodes.is_empty()
                && ledger.valid(policy, state.last_applied_log.map_or(0, |log| log.index))
        }
        _ => false,
    }
}

fn open_with_policies(
    path: &Path,
    cluster: &str,
    node: NodeId,
    registry_policy: MediaRegistryPolicy,
    profile_policy: Option<crate::profile_authority::ProfilePolicy>,
) -> Result<(LogStore, StateStore), StorageError<NodeId>> {
    if profile_policy
        .as_ref()
        .is_some_and(|policy| !policy.validate())
    {
        return Err(failure("画像权威策略无效"));
    }
    let db = Arc::new(
        Database::builder()
            .set_cache_size(8 * 1024 * 1024)
            .create(path)
            .map_err(failure)?,
    );
    let identity = (1_u8, cluster.to_owned(), node);
    let tx = db.begin_write().map_err(failure)?;
    {
        let logs = tx.open_table(LOG).map_err(failure)?;
        let mut meta = tx.open_table(META).map_err(failure)?;
        let saved = meta
            .get("identity")
            .map_err(failure)?
            .map(|value| value.value().to_vec());
        match saved {
            Some(bytes)
                if serde_json::from_slice::<(u8, String, u64)>(&bytes).map_err(failure)?
                    != identity =>
            {
                return Err(failure("协调节点数据库身份不匹配"));
            }
            Some(_) => {}
            None => {
                if !logs.is_empty().map_err(failure)? || !meta.is_empty().map_err(failure)? {
                    return Err(failure("协调数据库缺少身份，拒绝覆盖已有状态"));
                }
                meta.insert("identity", encode(&identity)?.as_slice())
                    .map_err(failure)?;
            }
        }
        let saved_profile = meta
            .get("profile_policy")
            .map_err(failure)?
            .map(|value| value.value().to_vec());
        match (saved_profile, &profile_policy) {
            (Some(bytes), Some(policy)) => {
                let saved: crate::profile_authority::ProfilePolicy =
                    serde_json::from_slice(&bytes).map_err(failure)?;
                if !saved.same(policy) {
                    return Err(failure("画像目录或分片策略与持久身份不符"));
                }
            }
            (Some(_), None) => return Err(failure("画像权威不能退回房间模式")),
            (None, Some(policy)) => {
                if !logs.is_empty().map_err(failure)?
                    || meta.len().map_err(failure)? != 1
                    || meta.get("state").map_err(failure)?.is_some()
                    || meta.get("room_policy").map_err(failure)?.is_some()
                {
                    return Err(failure("已有协调历史不能自动切为画像权威"));
                }
                meta.insert("profile_policy", encode(policy)?.as_slice())
                    .map_err(failure)?;
            }
            (None, None) => {}
        }
    }
    tx.commit().map_err(failure)?;
    let mut state: StateData = read(&db, "state")?.unwrap_or_default();
    if state.profiles.is_none()
        && state.last_applied_log.is_none()
        && let Some(policy) = &profile_policy
    {
        state.profiles = Some(crate::profile_authority::ProfileLedger::new(policy.clone()));
    }
    if !valid_media_state(&state, &registry_policy) || !valid_profile_state(&state, &profile_policy)
    {
        return Err(failure("媒体登记持久状态与传输目录不符，需要显式迁移"));
    }
    Ok((
        LogStore { db: db.clone() },
        StateStore {
            db,
            state: Arc::new(RwLock::new(state)),
            registry_policy,
            profile_policy,
        },
    ))
}

impl RaftLogReader<TypeConfig> for LogStore {
    async fn try_get_log_entries<RB: RangeBounds<u64> + Clone + Debug + OptionalSend>(
        &mut self,
        range: RB,
    ) -> Result<Vec<Entry<TypeConfig>>, StorageError<NodeId>> {
        let tx = self.db.begin_read().map_err(failure)?;
        let table = tx.open_table(LOG).map_err(failure)?;
        table
            .range(range)
            .map_err(failure)?
            .map(|item| {
                let (_, value) = item.map_err(failure)?;
                serde_json::from_slice(value.value()).map_err(failure)
            })
            .collect()
    }
}

impl RaftLogStorage<TypeConfig> for LogStore {
    type LogReader = Self;
    async fn get_log_state(&mut self) -> Result<LogState<TypeConfig>, StorageError<NodeId>> {
        let purged = read(&self.db, "purged")?;
        let tx = self.db.begin_read().map_err(failure)?;
        let table = tx.open_table(LOG).map_err(failure)?;
        let last = match table.last().map_err(failure)? {
            Some((_, value)) => Some(
                serde_json::from_slice::<Entry<TypeConfig>>(value.value())
                    .map_err(failure)?
                    .log_id,
            ),
            None => purged,
        };
        Ok(LogState {
            last_purged_log_id: purged,
            last_log_id: last,
        })
    }
    async fn get_log_reader(&mut self) -> Self::LogReader {
        self.clone()
    }
    async fn save_vote(&mut self, vote: &Vote<NodeId>) -> Result<(), StorageError<NodeId>> {
        write(&self.db, "vote", vote)
    }
    async fn read_vote(&mut self) -> Result<Option<Vote<NodeId>>, StorageError<NodeId>> {
        read(&self.db, "vote")
    }
    async fn save_committed(
        &mut self,
        value: Option<LogId<NodeId>>,
    ) -> Result<(), StorageError<NodeId>> {
        write(&self.db, "committed", &value)
    }
    async fn read_committed(&mut self) -> Result<Option<LogId<NodeId>>, StorageError<NodeId>> {
        Ok(read::<Option<LogId<NodeId>>>(&self.db, "committed")?.flatten())
    }
    async fn append<I>(
        &mut self,
        entries: I,
        callback: LogFlushed<TypeConfig>,
    ) -> Result<(), StorageError<NodeId>>
    where
        I: IntoIterator<Item = Entry<TypeConfig>> + OptionalSend,
        I::IntoIter: OptionalSend,
    {
        let tx = self.db.begin_write().map_err(failure)?;
        {
            let mut table = tx.open_table(LOG).map_err(failure)?;
            for entry in entries {
                table
                    .insert(entry.log_id.index, encode(&entry)?.as_slice())
                    .map_err(failure)?;
            }
        }
        tx.commit().map_err(failure)?;
        callback.log_io_completed(Ok(()));
        Ok(())
    }
    async fn truncate(&mut self, from: LogId<NodeId>) -> Result<(), StorageError<NodeId>> {
        let tx = self.db.begin_write().map_err(failure)?;
        {
            let mut table = tx.open_table(LOG).map_err(failure)?;
            let keys = table
                .range(from.index..)
                .map_err(failure)?
                .map(|item| item.map(|(key, _)| key.value()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(failure)?;
            for key in keys {
                table.remove(key).map_err(failure)?;
            }
        }
        tx.commit().map_err(failure)
    }
    async fn purge(&mut self, through: LogId<NodeId>) -> Result<(), StorageError<NodeId>> {
        let tx = self.db.begin_write().map_err(failure)?;
        {
            let mut table = tx.open_table(LOG).map_err(failure)?;
            let keys = table
                .range(..=through.index)
                .map_err(failure)?
                .map(|item| item.map(|(key, _)| key.value()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(failure)?;
            for key in keys {
                table.remove(key).map_err(failure)?;
            }
            tx.open_table(META)
                .map_err(failure)?
                .insert("purged", encode(&through)?.as_slice())
                .map_err(failure)?;
        }
        tx.commit().map_err(failure)
    }
}

impl RaftStateMachine<TypeConfig> for StateStore {
    type SnapshotBuilder = Self;
    async fn applied_state(
        &mut self,
    ) -> Result<(Option<LogId<NodeId>>, StoredMembership<NodeId, BasicNode>), StorageError<NodeId>>
    {
        let state = self.state.read().await;
        Ok((state.last_applied_log, state.last_membership.clone()))
    }
    async fn apply<I>(&mut self, entries: I) -> Result<Vec<RoomReply>, StorageError<NodeId>>
    where
        I: IntoIterator<Item = Entry<TypeConfig>> + OptionalSend,
    {
        let mut guard = self.state.write().await;
        let mut next = guard.clone();
        let mut responses = Vec::new();
        for entry in entries {
            next.last_applied_log = Some(entry.log_id);
            let reply = match entry.payload {
                EntryPayload::Blank => AuthorityReply::default(),
                EntryPayload::Membership(membership) => {
                    next.last_membership = StoredMembership::new(Some(entry.log_id), membership);
                    AuthorityReply::default()
                }
                EntryPayload::Normal(command) => apply_authority_with_policy(
                    &mut next,
                    command,
                    entry.log_id.index,
                    &self.registry_policy,
                ),
            };
            responses.push(reply.into());
        }
        // redb提交成功后才公开内存投影；IO失败由OpenRaft关闭该节点。
        write(&self.db, "state", &next)?;
        *guard = next;
        Ok(responses)
    }
    async fn get_snapshot_builder(&mut self) -> Self::SnapshotBuilder {
        self.clone()
    }
    async fn begin_receiving_snapshot(
        &mut self,
    ) -> Result<Box<Cursor<Vec<u8>>>, StorageError<NodeId>> {
        Ok(Box::new(Cursor::new(Vec::new())))
    }
    async fn install_snapshot(
        &mut self,
        meta: &SnapshotMeta<NodeId, BasicNode>,
        snapshot: Box<Cursor<Vec<u8>>>,
    ) -> Result<(), StorageError<NodeId>> {
        let data = snapshot.into_inner();
        if data.len() > SNAPSHOT_LIMIT {
            return Err(failure("房间快照超出预算"));
        }
        let next: StateData = serde_json::from_slice(&data).map_err(failure)?;
        if next.last_applied_log != meta.last_log_id
            || next.last_membership != meta.last_membership
            || next.rooms.len() > crate::MAX_ROOMS
            || !valid_media_state(&next, &self.registry_policy)
            || !valid_profile_state(&next, &self.profile_policy)
        {
            return Err(failure("房间快照元数据不匹配"));
        }
        let mut guard = self.state.write().await;
        let tx = self.db.begin_write().map_err(failure)?;
        {
            let mut table = tx.open_table(META).map_err(failure)?;
            table
                .insert("state", encode(&next)?.as_slice())
                .map_err(failure)?;
            table
                .insert(
                    "snapshot",
                    encode(&SavedSnapshot {
                        meta: meta.clone(),
                        data,
                    })?
                    .as_slice(),
                )
                .map_err(failure)?;
        }
        tx.commit().map_err(failure)?;
        *guard = next;
        Ok(())
    }
    async fn get_current_snapshot(
        &mut self,
    ) -> Result<Option<Snapshot<TypeConfig>>, StorageError<NodeId>> {
        Ok(
            read::<SavedSnapshot>(&self.db, "snapshot")?.map(|saved| Snapshot {
                meta: saved.meta,
                snapshot: Box::new(Cursor::new(saved.data)),
            }),
        )
    }
}

impl RaftSnapshotBuilder<TypeConfig> for StateStore {
    async fn build_snapshot(&mut self) -> Result<Snapshot<TypeConfig>, StorageError<NodeId>> {
        let state = self.state.read().await;
        let data = encode(&*state)?;
        if data.len() > SNAPSHOT_LIMIT {
            return Err(failure("房间快照超出预算"));
        }
        let meta = SnapshotMeta {
            last_log_id: state.last_applied_log,
            last_membership: state.last_membership.clone(),
            snapshot_id: format!("room-{:?}", state.last_applied_log),
        };
        write(
            &self.db,
            "snapshot",
            &SavedSnapshot {
                meta: meta.clone(),
                data: data.clone(),
            },
        )?;
        Ok(Snapshot {
            meta,
            snapshot: Box::new(Cursor::new(data)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_registry::{AuthorityCommand, MediaNodeCommand, MediaRegistration, RoomName};
    use crate::{RoomCommand, RoomTarget};
    use openraft::{
        CommittedLeaderId,
        storage::RaftLogStorageExt,
        testing::{StoreBuilder, Suite},
    };

    struct Builder;

    #[tokio::test]
    async fn tls_registry_replay_snapshot_and_reopen_enforce_the_same_directory() {
        use crate::media_registry::MediaControlTransport;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tls-registry.redb");
        let endpoint: std::net::SocketAddr = "10.1.2.3:7443".parse().unwrap();
        let policy = MediaRegistryPolicy::MtlsV1(BTreeMap::from([("media".into(), endpoint)]));
        let (mut logs, mut state) =
            open_with_registry_policy(&path, "cluster", 1, policy.clone()).unwrap();
        let command = MediaNodeCommand::RegisterMedia {
            operation_id: "register".into(),
            expected_revision: None,
            registration: MediaRegistration {
                target: RoomTarget {
                    node_id: "media".into(),
                    incarnation: "aaaaaaaaaaaaaaaaaaaaaa".into(),
                },
                endpoint,
                rooms: vec![RoomName {
                    tenant_id: "tenant".into(),
                    room_id: "room".into(),
                }],
                transport: MediaControlTransport::MtlsV1,
            },
        };
        let entry = Entry::<TypeConfig> {
            log_id: LogId::new(CommittedLeaderId::new(1, 1), 2),
            payload: EntryPayload::Normal(AuthorityCommand::Media(command)),
        };
        logs.blocking_append([entry]).await.unwrap();
        let replay = logs.try_get_log_entries(2..=2).await.unwrap();
        assert_eq!(state.apply(replay).await.unwrap()[0].outcome, "applied");
        let expected = state.media_node("media").await.unwrap();
        let snapshot = state.build_snapshot().await.unwrap();
        for (index, rejected) in [
            MediaRegistryPolicy::Disabled,
            MediaRegistryPolicy::LoopbackHttp,
            MediaRegistryPolicy::MtlsV1(BTreeMap::from([(
                "media".into(),
                "10.1.2.4:7443".parse().unwrap(),
            )])),
        ]
        .into_iter()
        .enumerate()
        {
            let (_, mut destination) = open_with_registry_policy(
                &directory.path().join(format!("rejected-{index}.redb")),
                "cluster",
                2,
                rejected.clone(),
            )
            .unwrap();
            assert!(
                destination
                    .install_snapshot(&snapshot.meta, snapshot.snapshot.clone())
                    .await
                    .is_err()
            );
            assert!(destination.media_node("media").await.is_none());
            let mut nodes = state.state.read().await.clone();
            assert!(!valid_media_state(&nodes, &rejected));
            nodes.media_nodes.clear();
            assert!(valid_media_state(&nodes, &rejected));
        }
        let replica = directory.path().join("accepted.redb");
        let (_, mut destination) =
            open_with_registry_policy(&replica, "cluster", 2, policy.clone()).unwrap();
        destination
            .install_snapshot(&snapshot.meta, snapshot.snapshot)
            .await
            .unwrap();
        assert_eq!(destination.media_node("media").await.unwrap(), expected);
        drop(logs);
        drop(state);
        drop(destination);
        // 错误目录既不能接收快照，也不能借完整重启绕过已保存的登记。
        assert!(open_with_registry(&path, "cluster", 1, true).is_err());
        let (_, reopened) = open_with_registry_policy(&path, "cluster", 1, policy.clone()).unwrap();
        assert_eq!(reopened.media_node("media").await.unwrap(), expected);
        let (_, restored) = open_with_registry_policy(&replica, "cluster", 2, policy).unwrap();
        assert_eq!(restored.media_node("media").await.unwrap(), expected);
    }

    #[tokio::test]
    async fn media_registry_survives_snapshot_install_and_full_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("media.redb");
        let (_, mut state) = open_with_registry(&path, "cluster", 1, true).unwrap();
        let command = MediaNodeCommand::RegisterMedia {
            operation_id: "register".into(),
            expected_revision: None,
            registration: MediaRegistration {
                target: RoomTarget {
                    node_id: "media".into(),
                    incarnation: "aaaaaaaaaaaaaaaaaaaaaa".into(),
                },
                endpoint: "127.0.0.1:32001".parse().unwrap(),
                rooms: vec![RoomName {
                    tenant_id: "tenant".into(),
                    room_id: "room".into(),
                }],
                transport: Default::default(),
            },
        };
        let entry = Entry::<TypeConfig> {
            log_id: LogId::new(CommittedLeaderId::new(1, 1), 2),
            payload: EntryPayload::Normal(AuthorityCommand::Media(command)),
        };
        let replies = state.apply([entry]).await.unwrap();
        assert_eq!(replies[0].outcome, "applied");
        assert_eq!(replies[0].media_node.as_ref().unwrap().revision, 2);
        let snapshot = state.build_snapshot().await.unwrap();
        let expected = state.media_node("media").await.unwrap();
        let replica = directory.path().join("replica.redb");
        let (_, mut installed) = open_with_registry(&replica, "cluster", 2, true).unwrap();
        installed
            .install_snapshot(&snapshot.meta, snapshot.snapshot)
            .await
            .unwrap();
        assert_eq!(installed.media_node("media").await.unwrap(), expected);
        drop(state);
        drop(installed);
        let (_, reopened) = open_with_registry(&path, "cluster", 1, true).unwrap();
        assert_eq!(reopened.media_node("media").await.unwrap(), expected);
        let (_, restored) = open_with_registry(&replica, "cluster", 2, true).unwrap();
        assert_eq!(restored.media_node("media").await.unwrap(), expected);
        let old: serde_json::Value = serde_json::to_value(StateData::default()).unwrap();
        assert!(old.get("media_nodes").is_none());
        assert!(
            serde_json::from_value::<StateData>(old)
                .unwrap()
                .media_nodes
                .is_empty()
        );
    }
    impl StoreBuilder<TypeConfig, LogStore, StateStore, tempfile::TempDir> for Builder {
        async fn build(
            &self,
        ) -> Result<(tempfile::TempDir, LogStore, StateStore), StorageError<NodeId>> {
            let directory = tempfile::tempdir().map_err(failure)?;
            let (logs, state) = open(&directory.path().join("suite.redb"), "suite", 1)?;
            Ok((directory, logs, state))
        }
    }

    #[test]
    fn room_policy_identity_survives_reopen_and_refuses_silent_downgrade() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.redb");
        {
            let (logs, _) = open(&path, "cluster", 1).unwrap();
            logs.pin_policy("drain-required").unwrap();
        }
        let (logs, _) = open(&path, "cluster", 1).unwrap();
        logs.pin_policy("drain-required").unwrap();
        assert!(logs.pin_policy("without-drain").is_err());
    }

    #[test]
    fn upstream_storage_contract_suite() -> Result<(), StorageError<NodeId>> {
        Suite::test_all(Builder)
    }

    #[tokio::test]
    async fn durable_state_snapshot_vote_and_purge_survive_reopen_and_identity_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("restart.redb");
        let id = LogId::new(CommittedLeaderId::new(1, 1), 3);
        let command = RoomCommand::Assign {
            tenant_id: "tenant".into(),
            room_id: "room".into(),
            operation_id: "one".into(),
            expected_revision: None,
            target: RoomTarget {
                node_id: "media-a".into(),
                incarnation: "aaaaaaaaaaaaaaaaaaaaaa".into(),
            },
        };
        {
            let (mut logs, mut state) = open(&path, "cluster", 1).unwrap();
            let entry = Entry {
                log_id: id,
                payload: EntryPayload::Normal(AuthorityCommand::Room(command)),
            };
            logs.blocking_append([entry.clone()]).await.unwrap();
            state.apply([entry]).await.unwrap();
            logs.save_vote(&Vote::new(2, 1)).await.unwrap();
            logs.save_committed(Some(id)).await.unwrap();
            state.build_snapshot().await.unwrap();
            logs.purge(id).await.unwrap();
        }
        assert!(open(&path, "other-cluster", 1).is_err());
        assert!(open(&path, "cluster", 2).is_err());
        let (mut logs, mut state) = open(&path, "cluster", 1).unwrap();
        assert_eq!(logs.read_vote().await.unwrap(), Some(Vote::new(2, 1)));
        assert_eq!(logs.read_committed().await.unwrap(), Some(id));
        assert_eq!(
            logs.get_log_state().await.unwrap().last_purged_log_id,
            Some(id)
        );
        assert_eq!(state.room("tenant/room").await.unwrap().revision, 3);
        let snapshot = state.get_current_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.meta.last_log_id, Some(id));
        let mut changed = snapshot.meta.clone();
        changed.last_log_id = None;
        assert!(
            state
                .install_snapshot(&changed, snapshot.snapshot)
                .await
                .is_err()
        );
        assert_eq!(state.room("tenant/room").await.unwrap().revision, 3);
    }
}
