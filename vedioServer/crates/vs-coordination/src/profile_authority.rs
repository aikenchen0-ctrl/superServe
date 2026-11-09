use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::PublicCatalog,
    profile::{ProfileEvent, ProfileEventFacts, ProfileEventResult, ProfileState},
    recommendation::ProfileProjection,
};

use crate::RoomTarget;

pub const MAX_SUBJECTS: usize = 32;
pub const MAX_EVENTS: usize = 256;
pub const MAX_WRITER_CHANGES: usize = 64;

/// 隔离实验策略；固定目录与分片布局，不支持在线更换目录或重分片。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfilePolicy {
    pub catalog_sha256: String,
    pub shard_count: u16,
    candidates: BTreeMap<String, ProfileEventFacts>,
}

impl ProfilePolicy {
    pub fn from_catalog(bytes: &[u8], shard_count: u16) -> Result<Self, String> {
        if bytes.len() > 1024 * 1024
            || !(2..=16).contains(&shard_count)
            || !shard_count.is_power_of_two()
        {
            return Err("画像实验目录或分片数量超出预算".into());
        }
        let catalog: PublicCatalog =
            serde_json::from_slice(bytes).map_err(|_| "画像目录JSON无效")?;
        catalog.validate().map_err(|_| "画像目录无效")?;
        if catalog.items.is_empty() || catalog.items.len() > 64 {
            return Err("画像实验仅接受1至64个固定候选".into());
        }
        Ok(Self {
            catalog_sha256: format!("{:x}", Sha256::digest(bytes)),
            shard_count,
            candidates: catalog
                .items
                .iter()
                .map(|candidate| (candidate.id.clone(), ProfileEventFacts::from(candidate)))
                .collect(),
        })
    }

    pub fn same(&self, other: &Self) -> bool {
        // BTreeMap及固定结构保持规范顺序，比较完整策略而非仅相信声明指纹。
        serde_json::to_vec(self).ok() == serde_json::to_vec(other).ok()
    }

    pub fn validate(&self) -> bool {
        self.catalog_sha256.len() == 64
            && self
                .catalog_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && (2..=16).contains(&self.shard_count)
            && self.shard_count.is_power_of_two()
            && (1..=64).contains(&self.candidates.len())
            && self
                .candidates
                .iter()
                .all(|(id, facts)| vs_core::valid_id(id) && facts.validate().is_ok())
    }

    pub fn shard_for(&self, subject: &str) -> u16 {
        let mut hash = Sha256::new();
        hash.update(b"superserve-profile-shard-v1\0");
        hash.update(subject.as_bytes());
        let digest = hash.finalize();
        (u64::from_be_bytes(digest[..8].try_into().unwrap()) % u64::from(self.shard_count)) as u16
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriterChange {
    pub operation_id: String,
    pub shard: u16,
    pub expected_revision: Option<u64>,
    pub target: Option<RoomTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriterRecord {
    pub revision: u64,
    pub owner: Option<RoomTarget>,
    pub last_change: WriterChange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProfileCommand {
    SetProfileWriter {
        change: WriterChange,
    },
    CommitProfileEvent {
        shard: u16,
        writer_epoch: u64,
        target: RoomTarget,
        event: ProfileEvent,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileReply {
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writer: Option<WriterRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<ProfileEventResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Observed {
    revision: u64,
    writer_epoch: u64,
    event: ProfileEvent,
    facts: ProfileEventFacts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriterTransition {
    revision: u64,
    change: WriterChange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileLedger {
    pub policy: ProfilePolicy,
    pub writers: BTreeMap<u16, WriterRecord>,
    events: Vec<Observed>,
    changes: Vec<WriterTransition>,
}

fn valid_revision(revision: u64) -> bool {
    revision > 0 && revision <= 9_007_199_254_740_991
}

fn valid_subject(subject: &str) -> bool {
    vs_core::valid_id(subject)
}

impl ProfileCommand {
    pub fn valid(&self, policy: &ProfilePolicy) -> bool {
        if !policy.validate() {
            return false;
        }
        match self {
            Self::SetProfileWriter { change } => {
                change.shard < policy.shard_count
                    && crate::label(&change.operation_id)
                    && change.expected_revision.is_none_or(valid_revision)
                    && change.target.as_ref().is_none_or(crate::target_valid)
            }
            Self::CommitProfileEvent {
                shard,
                writer_epoch,
                target,
                event,
            } => {
                *shard < policy.shard_count
                    && valid_revision(*writer_epoch)
                    && crate::target_valid(target)
                    && valid_subject(&event.subject)
                    && vs_core::valid_id(&event.event_id)
                    && policy.candidates.contains_key(&event.candidate_id)
                    && policy.shard_for(&event.subject) == *shard
            }
        }
    }
}

impl ProfileLedger {
    pub fn new(policy: ProfilePolicy) -> Self {
        Self {
            policy,
            writers: BTreeMap::new(),
            events: Vec::new(),
            changes: Vec::new(),
        }
    }

    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    fn replay(&self, subject: &str) -> Result<ProfileState, ()> {
        let mut projection = ProfileState::default();
        for observed in self
            .events
            .iter()
            .filter(|item| item.event.subject == subject)
        {
            let result = projection
                .apply_observed(&observed.event, &observed.facts)
                .map_err(|_| ())?;
            if !result.accepted || result.duplicate {
                return Err(());
            }
        }
        Ok(projection)
    }

    pub fn projection(
        &self,
        subject: &str,
        scopes: Vec<String>,
        expires_at: u64,
    ) -> Result<Option<ProfileProjection>, String> {
        if !valid_subject(subject)
            || scopes.is_empty()
            || scopes.len() > 16
            || scopes.iter().any(|scope| !vs_core::valid_id(scope))
            || scopes.iter().collect::<BTreeSet<_>>().len() != scopes.len()
        {
            return Err("画像投影主体或范围无效".into());
        }
        if !self.events.iter().any(|item| item.event.subject == subject) {
            return Ok(None);
        }
        Ok(Some(
            self.replay(subject)
                .map_err(|_| "画像事实重放失败")?
                .projection(subject, scopes, expires_at),
        ))
    }

    pub fn valid(&self, policy: &ProfilePolicy, applied: u64) -> bool {
        if !policy.validate()
            || !self.policy.same(policy)
            || self.events.len() > MAX_EVENTS
            || self.writers.len() > usize::from(policy.shard_count)
            || self.changes.len() > MAX_WRITER_CHANGES
        {
            return false;
        }
        for (&shard, record) in &self.writers {
            let command = ProfileCommand::SetProfileWriter {
                change: record.last_change.clone(),
            };
            if shard != record.last_change.shard
                || !command.valid(policy)
                || !valid_revision(record.revision)
                || record.revision > applied
                || record
                    .last_change
                    .expected_revision
                    .is_some_and(|previous| previous >= record.revision)
                || record.owner != record.last_change.target
            {
                return false;
            }
        }
        let mut keys = BTreeSet::new();
        let mut subjects = BTreeMap::<String, ProfileState>::new();
        let mut previous = 0;
        for observed in &self.events {
            let event = &observed.event;
            let Some(facts) = policy.candidates.get(&event.candidate_id) else {
                return false;
            };
            if !valid_revision(observed.revision)
                || observed.revision <= previous
                || observed.revision > applied
                || !valid_revision(observed.writer_epoch)
                || observed.writer_epoch >= observed.revision
                || !valid_subject(&event.subject)
                || !vs_core::valid_id(&event.event_id)
                || !keys.insert((event.subject.clone(), event.event_id.clone()))
                || observed.facts.domain != facts.domain
                || observed.facts.tags != facts.tags
            {
                return false;
            }
            previous = observed.revision;
            let result = subjects
                .entry(event.subject.clone())
                .or_default()
                .apply_observed(event, &observed.facts);
            if !result.is_ok_and(|result| result.accepted && !result.duplicate) {
                return false;
            }
        }
        if subjects.len() > MAX_SUBJECTS {
            return false;
        }
        // 快照保留成功的权威变更历史，与事件按同一revision重放，拒绝凭空编造epoch。
        let mut replay = Self::new(policy.clone());
        let mut commands = Vec::with_capacity(self.events.len() + self.changes.len());
        for transition in &self.changes {
            commands.push((transition.revision, Some(&transition.change), None));
        }
        for event in &self.events {
            commands.push((event.revision, None, Some(event)));
        }
        commands.sort_by_key(|(revision, _, _)| *revision);
        let mut previous = 0;
        for (revision, change, event) in commands {
            if !valid_revision(revision) || revision <= previous || revision > applied {
                return false;
            }
            previous = revision;
            let command = if let Some(change) = change {
                ProfileCommand::SetProfileWriter {
                    change: change.clone(),
                }
            } else if let Some(observed) = event {
                let shard = policy.shard_for(&observed.event.subject);
                let Some(target) = replay
                    .writers
                    .get(&shard)
                    .and_then(|record| record.owner.clone())
                else {
                    return false;
                };
                ProfileCommand::CommitProfileEvent {
                    shard,
                    writer_epoch: observed.writer_epoch,
                    target,
                    event: observed.event.clone(),
                }
            } else {
                return false;
            };
            if replay.apply(command, revision).outcome != "applied" {
                return false;
            }
        }
        serde_json::to_vec(&replay).ok() == serde_json::to_vec(self).ok()
    }

    pub fn apply(&mut self, command: ProfileCommand, revision: u64) -> ProfileReply {
        let mut reply = ProfileReply {
            outcome: "invalid".into(),
            ..Default::default()
        };
        if !command.valid(&self.policy) || !valid_revision(revision) {
            return reply;
        }
        match command {
            ProfileCommand::SetProfileWriter { change } => {
                let current = self.writers.get(&change.shard);
                reply.writer = current.cloned();
                if let Some(current) = current
                    && current.last_change.operation_id == change.operation_id
                {
                    reply.outcome = if current.last_change == change {
                        "duplicate"
                    } else {
                        "conflict"
                    }
                    .into();
                    return reply;
                }
                if current.map(|current| current.revision) != change.expected_revision
                    || current.is_some_and(|current| current.revision >= revision)
                    || (current.is_none() && change.target.is_none())
                {
                    reply.outcome = "conflict".into();
                    return reply;
                }
                if self.changes.len() >= MAX_WRITER_CHANGES {
                    reply.outcome = "capacity".into();
                    return reply;
                }
                self.changes.push(WriterTransition {
                    revision,
                    change: change.clone(),
                });
                let record = WriterRecord {
                    revision,
                    owner: change.target.clone(),
                    last_change: change,
                };
                self.writers
                    .insert(record.last_change.shard, record.clone());
                reply.outcome = "applied".into();
                reply.writer = Some(record);
            }
            ProfileCommand::CommitProfileEvent {
                shard,
                writer_epoch,
                target,
                event,
            } => {
                reply.writer = self.writers.get(&shard).cloned();
                if reply.writer.as_ref().is_none_or(|writer| {
                    writer.revision != writer_epoch
                        || writer.owner.as_ref() != Some(&target)
                        || writer_epoch >= revision
                }) {
                    reply.outcome = "fenced".into();
                    return reply;
                }
                let mut next = match self.replay(&event.subject) {
                    Ok(state) => state,
                    Err(_) => return reply,
                };
                // 在已提交状态内先判代次，再判幂等；旧写者连重复确认也不能伪造为新权威。
                if let Some(previous) = self.events.iter().find(|item| {
                    item.event.subject == event.subject && item.event.event_id == event.event_id
                }) {
                    if previous.event.idempotency_fingerprint() != event.idempotency_fingerprint() {
                        reply.outcome = "conflict".into();
                    } else {
                        reply.outcome = "duplicate".into();
                        reply.event = Some(ProfileEventResult {
                            accepted: false,
                            duplicate: true,
                            profile_version: next.version(),
                        });
                    }
                    return reply;
                }
                let subjects: BTreeSet<_> = self
                    .events
                    .iter()
                    .map(|item| item.event.subject.as_str())
                    .collect();
                if self.events.len() >= MAX_EVENTS
                    || (!subjects.contains(event.subject.as_str())
                        && subjects.len() >= MAX_SUBJECTS)
                {
                    reply.outcome = "capacity".into();
                    return reply;
                }
                let facts = self.policy.candidates[&event.candidate_id].clone();
                match next.apply_observed(&event, &facts) {
                    Ok(result) if result.accepted && !result.duplicate => {
                        self.events.push(Observed {
                            revision,
                            writer_epoch,
                            event,
                            facts,
                        });
                        reply.outcome = "applied".into();
                        reply.event = Some(result);
                    }
                    _ => reply.outcome = "capacity".into(),
                }
            }
        }
        reply
    }
}
