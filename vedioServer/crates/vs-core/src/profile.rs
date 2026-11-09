use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    DomainError,
    catalog::Candidate,
    recommendation::{Interest, ProfileProjection},
    valid_id,
};

pub const MAX_PROFILE_SUBJECTS: usize = 10_000;
const MAX_PROFILE_INTERESTS: usize = 128;
const MAX_PROFILE_BLOCKED_IDS: usize = 256;
const MAX_REMEMBERED_EVENT_IDS: usize = 128;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileEventKind {
    Impression,
    View,
    Complete,
    Like,
    Skip,
    Hide,
}

impl ProfileEventKind {
    fn weight(self) -> f32 {
        match self {
            Self::Impression => 0.01,
            Self::View => 0.1,
            Self::Complete => 0.25,
            Self::Like => 1.0,
            Self::Skip => -0.2,
            Self::Hide => -0.5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileEvent {
    pub event_id: String,
    pub subject: String,
    pub candidate_id: String,
    pub kind: ProfileEventKind,
}

impl ProfileEvent {
    /// 仅指纹化事件ID键之外的正文，避免在有界内存索引中重复保存候选ID。
    pub fn idempotency_fingerprint(&self) -> [u8; 32] {
        let kind = match self.kind {
            ProfileEventKind::Impression => 0,
            ProfileEventKind::View => 1,
            ProfileEventKind::Complete => 2,
            ProfileEventKind::Like => 3,
            ProfileEventKind::Skip => 4,
            ProfileEventKind::Hide => 5,
        };
        let mut hasher = Sha256::new();
        hasher.update(b"profile-event-payload-v1\0");
        hasher.update(self.candidate_id.as_bytes());
        hasher.update([0, kind]);
        hasher.finalize().into()
    }
}

/// 提交时冻结的最小公开特征；重放不再依赖当前候选目录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileEventFacts {
    pub domain: String,
    pub tags: Vec<String>,
}

impl From<&Candidate> for ProfileEventFacts {
    fn from(candidate: &Candidate) -> Self {
        Self {
            domain: candidate.domain.clone(),
            tags: candidate.tags.clone(),
        }
    }
}

impl ProfileEventFacts {
    pub fn validate(&self) -> Result<(), DomainError> {
        if !valid_id(&self.domain)
            || self.tags.len() > 32
            || self.tags.iter().any(|tag| !valid_id(tag))
            || self.tags.iter().collect::<HashSet<_>>().len() != self.tags.len()
        {
            return Err(DomainError::Invalid("profile_event_facts"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileEventResult {
    pub accepted: bool,
    pub duplicate: bool,
    pub profile_version: String,
}

#[derive(Debug, Clone, Default)]
pub struct ProfileState {
    version: u64,
    interests: HashMap<String, f32>,
    blocked_ids: HashSet<String>,
    event_ids: VecDeque<RememberedProfileEvent>,
}

#[derive(Debug, Clone)]
struct RememberedProfileEvent {
    event_id: String,
    payload_fingerprint: [u8; 32],
}

impl ProfileState {
    pub fn apply(
        &mut self,
        event: &ProfileEvent,
        candidate: &Candidate,
    ) -> Result<ProfileEventResult, DomainError> {
        self.apply_tags(event, &candidate.id, &candidate.tags)
    }

    pub fn apply_observed(
        &mut self,
        event: &ProfileEvent,
        facts: &ProfileEventFacts,
    ) -> Result<ProfileEventResult, DomainError> {
        facts.validate()?;
        self.apply_tags(event, &event.candidate_id, &facts.tags)
    }

    fn apply_tags(
        &mut self,
        event: &ProfileEvent,
        candidate_id: &str,
        tags: &[String],
    ) -> Result<ProfileEventResult, DomainError> {
        if !valid_id(&event.event_id)
            || !valid_id(&event.subject)
            || !valid_id(&event.candidate_id)
            || event.candidate_id != candidate_id
        {
            return Err(DomainError::Invalid("profile_event"));
        }
        if let Some(previous) = self
            .event_ids
            .iter()
            .find(|previous| previous.event_id == event.event_id)
        {
            if previous.payload_fingerprint != event.idempotency_fingerprint() {
                return Err(DomainError::Invalid("profile_event_id_conflict"));
            }
            return Ok(ProfileEventResult {
                accepted: false,
                duplicate: true,
                profile_version: self.version_string(),
            });
        }
        let weight = event.kind.weight();
        let new_interests = tags
            .iter()
            .filter(|tag| !self.interests.contains_key(*tag))
            .count();
        if self.interests.len() + new_interests > MAX_PROFILE_INTERESTS
            || (matches!(event.kind, ProfileEventKind::Hide)
                && !self.blocked_ids.contains(candidate_id)
                && self.blocked_ids.len() >= MAX_PROFILE_BLOCKED_IDS)
        {
            return Err(DomainError::Capacity);
        }
        for tag in tags {
            let value = (self.interests.get(tag).copied().unwrap_or(0.0) + weight).clamp(-1.0, 1.0);
            self.interests.insert(tag.clone(), value);
        }
        if matches!(event.kind, ProfileEventKind::Hide) {
            self.blocked_ids.insert(candidate_id.to_string());
        }
        self.remember_event(event);
        self.version = self.version.saturating_add(1);
        Ok(ProfileEventResult {
            accepted: true,
            duplicate: false,
            profile_version: self.version_string(),
        })
    }

    pub fn projection(
        &self,
        subject: &str,
        scopes: Vec<String>,
        expires_at: u64,
    ) -> ProfileProjection {
        let mut interests: Vec<_> = self
            .interests
            .iter()
            .map(|(tag, weight)| Interest {
                tag: tag.clone(),
                weight: *weight,
            })
            .collect();
        interests.sort_unstable_by(|a, b| a.tag.cmp(&b.tag));
        let mut blocked_ids: Vec<_> = self.blocked_ids.iter().cloned().collect();
        blocked_ids.sort_unstable();
        ProfileProjection {
            subject: subject.to_string(),
            version: self.version_string(),
            scopes,
            expires_at,
            interests,
            blocked_ids,
            denied_tags: Vec::new(),
        }
    }

    pub fn version(&self) -> String {
        self.version_string()
    }

    fn remember_event(&mut self, event: &ProfileEvent) {
        self.event_ids.push_back(RememberedProfileEvent {
            event_id: event.event_id.clone(),
            payload_fingerprint: event.idempotency_fingerprint(),
        });
        if self.event_ids.len() > MAX_REMEMBERED_EVENT_IDS {
            self.event_ids.pop_front();
        }
    }

    fn version_string(&self) -> String {
        format!("memory-{}", self.version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> Candidate {
        Candidate {
            id: "video".into(),
            domain: "video".into(),
            tags: vec!["rust".into(), "engineering".into()],
            prior: 0.5,
            media_sha256: None,
        }
    }

    fn event(id: &str, kind: ProfileEventKind) -> ProfileEvent {
        ProfileEvent {
            event_id: id.into(),
            subject: "user-a".into(),
            candidate_id: "video".into(),
            kind,
        }
    }

    #[test]
    fn duplicate_events_are_idempotent_and_projection_is_stable() {
        let candidate = candidate();
        let mut state = ProfileState::default();
        let first = state
            .apply(&event("event-1", ProfileEventKind::Like), &candidate)
            .unwrap();
        let duplicate = state
            .apply(&event("event-1", ProfileEventKind::Like), &candidate)
            .unwrap();
        assert!(first.accepted);
        assert!(!first.duplicate);
        assert!(!duplicate.accepted);
        assert!(duplicate.duplicate);
        assert_eq!(first.profile_version, duplicate.profile_version);
        let projection = state.projection("user-a", vec!["video".into()], 100);
        assert_eq!(projection.version, "memory-1");
        assert_eq!(projection.interests[0].tag, "engineering");
        assert_eq!(projection.interests[0].weight, 1.0);
    }

    #[test]
    fn reusing_event_id_with_changed_content_is_rejected_without_mutation() {
        let candidate = candidate();
        let mut state = ProfileState::default();
        state
            .apply(&event("event-1", ProfileEventKind::Like), &candidate)
            .unwrap();

        for kind in [
            ProfileEventKind::Impression,
            ProfileEventKind::View,
            ProfileEventKind::Complete,
            ProfileEventKind::Skip,
            ProfileEventKind::Hide,
        ] {
            assert!(matches!(
                state.apply(&event("event-1", kind), &candidate),
                Err(DomainError::Invalid("profile_event_id_conflict"))
            ));
        }
        let mut other_candidate = candidate.clone();
        other_candidate.id = "document".into();
        let mut changed = event("event-1", ProfileEventKind::Like);
        changed.candidate_id = other_candidate.id.clone();
        assert!(matches!(
            state.apply(&changed, &other_candidate),
            Err(DomainError::Invalid("profile_event_id_conflict"))
        ));
        assert!(
            state
                .apply(&event("event-1", ProfileEventKind::Like), &candidate)
                .unwrap()
                .duplicate
        );
        let projection = state.projection("user-a", vec!["video".into()], 100);
        assert_eq!(projection.version, "memory-1");
        assert!(projection.blocked_ids.is_empty());
        assert!(
            projection
                .interests
                .iter()
                .all(|interest| interest.weight == 1.0)
        );
    }

    #[test]
    fn hide_event_blocks_candidate_without_removing_interest_history() {
        let candidate = candidate();
        let mut state = ProfileState::default();
        state
            .apply(&event("event-1", ProfileEventKind::Like), &candidate)
            .unwrap();
        state
            .apply(&event("event-2", ProfileEventKind::Hide), &candidate)
            .unwrap();
        let projection = state.projection("user-a", vec!["video".into()], 100);
        assert_eq!(projection.blocked_ids, vec!["video"]);
        assert_eq!(projection.interests.len(), 2);
        assert!(
            projection
                .interests
                .iter()
                .all(|interest| interest.weight > 0.0)
        );
    }

    #[test]
    fn invalid_candidate_binding_is_rejected() {
        let candidate = candidate();
        let mut state = ProfileState::default();
        let mut event = event("event-1", ProfileEventKind::View);
        event.candidate_id = "other".into();
        assert!(matches!(
            state.apply(&event, &candidate),
            Err(DomainError::Invalid("profile_event"))
        ));
    }

    #[test]
    fn profile_capacity_rejects_an_event_without_partial_mutation() {
        let mut state = ProfileState::default();
        for index in 0..4 {
            let candidate = Candidate {
                id: format!("video-{index}"),
                domain: "video".into(),
                tags: (0..32).map(|tag| format!("tag-{index}-{tag}")).collect(),
                prior: 0.5,
                media_sha256: None,
            };
            state
                .apply(
                    &ProfileEvent {
                        event_id: format!("event-{index}"),
                        subject: "user-a".into(),
                        candidate_id: candidate.id.clone(),
                        kind: ProfileEventKind::Like,
                    },
                    &candidate,
                )
                .unwrap();
        }
        let candidate = Candidate {
            id: "video-last".into(),
            domain: "video".into(),
            tags: (0..32).map(|tag| format!("new-{tag}")).collect(),
            prior: 0.5,
            media_sha256: None,
        };
        let error = state.apply(
            &ProfileEvent {
                event_id: "event-last".into(),
                subject: "user-a".into(),
                candidate_id: candidate.id.clone(),
                kind: ProfileEventKind::Like,
            },
            &candidate,
        );
        assert!(matches!(error, Err(DomainError::Capacity)));
        assert_eq!(state.version_string(), "memory-4");
        assert_eq!(
            state
                .projection("user-a", vec!["video".into()], 100)
                .interests
                .len(),
            128
        );
    }
}
