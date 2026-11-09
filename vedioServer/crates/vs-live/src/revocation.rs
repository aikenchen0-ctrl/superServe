use std::{collections::HashMap, time::Duration};

use crate::{RelayError, SessionGrant};

pub(crate) const MAX_REVOKED_TOKENS: usize = 64;

#[derive(Default)]
pub(crate) struct Revocations {
    entries: HashMap<[u8; 32], u64>,
    watermark: Option<Duration>,
    next_expiry: Option<u64>,
    reclaimed: u64,
}

impl Revocations {
    pub(crate) fn observe(&mut self, wall: Option<Duration>) -> Option<Duration> {
        let wall = wall?;
        let watermark = self.watermark.get_or_insert(wall);
        *watermark = (*watermark).max(wall);
        let effective = *watermark;
        // 只有最早到期时间已到才扫描；水位保留在拒绝路径，清理后回拨也不能复活旧授权。
        if self
            .next_expiry
            .is_some_and(|expiry| expiry <= effective.as_secs())
        {
            let before = self.entries.len();
            self.entries
                .retain(|_, expiry| *expiry > effective.as_secs());
            self.reclaimed += (before - self.entries.len()) as u64;
            self.next_expiry = self.entries.values().copied().min();
        }
        Some(effective)
    }

    pub(crate) fn contains(&self, digest: &[u8; 32]) -> bool {
        self.entries.contains_key(digest)
    }

    pub(crate) fn insert(&mut self, grant: &SessionGrant) -> Result<(), RelayError> {
        if !self.contains(&grant.token_digest) && self.entries.len() >= MAX_REVOKED_TOKENS {
            return Err(RelayError::Busy);
        }
        self.entries
            .entry(grant.token_digest)
            .and_modify(|expiry| *expiry = (*expiry).max(grant.expires_unix_seconds))
            .or_insert(grant.expires_unix_seconds);
        self.next_expiry = Some(
            self.next_expiry
                .map_or(grant.expires_unix_seconds, |expiry| {
                    expiry.min(grant.expires_unix_seconds)
                }),
        );
        Ok(())
    }

    pub(crate) fn clear_drained(&mut self) {
        self.entries.clear();
        self.next_expiry = None;
        // 排空只清除已不可重用版本的记录，不回退本进程已观察的授权时间。
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn reclaimed(&self) -> u64 {
        self.reclaimed
    }

    pub(crate) fn watermark_seconds(&self) -> Option<u64> {
        self.watermark.map(|time| time.as_secs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(digest: u64, expiry: u64) -> SessionGrant {
        let mut token_digest = [0; 32];
        token_digest[..8].copy_from_slice(&digest.to_le_bytes());
        SessionGrant {
            subject: "alice".into(),
            assignment_revision: Some(3),
            expires_unix_seconds: expiry,
            token_digest,
        }
    }

    #[test]
    fn boundary_cleanup_retains_watermark_across_rollback_clock_failure_and_drain() {
        let mut entries = Revocations::default();
        let original = grant(1, 120);
        entries.observe(Some(Duration::from_secs(100)));
        entries.insert(&original).unwrap();
        assert_eq!(entries.observe(None), None);
        assert_eq!(entries.len(), 1);
        entries.observe(Some(Duration::from_millis(119999)));
        assert_eq!(entries.len(), 1);
        let effective = entries.observe(Some(Duration::from_secs(120)));
        assert_eq!(entries.len(), 0);
        assert_eq!(entries.reclaimed(), 1);
        assert!(original.remaining_at(effective).is_err());
        let rollback = entries.observe(Some(Duration::from_secs(90)));
        assert_eq!(rollback, effective);
        assert!(original.remaining_at(rollback).is_err());
        entries.clear_drained();
        assert_eq!(entries.observe(Some(Duration::from_secs(80))), effective);
        assert_eq!(entries.observe(None), None);
        assert_eq!(entries.watermark_seconds(), Some(120));
    }

    #[test]
    fn capacity_tracks_unexpired_revocations_instead_of_total_room_lifetime() {
        let mut entries = Revocations::default();
        entries.observe(Some(Duration::from_secs(1)));
        for cycle in 0..100 {
            let expiry = 10 + cycle * 10;
            for index in 0..MAX_REVOKED_TOKENS as u64 {
                entries.insert(&grant(cycle * 64 + index, expiry)).unwrap();
            }
            assert_eq!(entries.len(), MAX_REVOKED_TOKENS);
            assert!(matches!(
                entries.insert(&grant(u64::MAX, expiry + 1)),
                Err(RelayError::Busy)
            ));
            let floor = entries.observe(Some(Duration::from_secs(expiry)));
            assert_eq!(entries.len(), 0);
            for index in 0..MAX_REVOKED_TOKENS as u64 {
                assert!(
                    grant(cycle * 64 + index, expiry)
                        .remaining_at(floor)
                        .is_err()
                );
            }
            assert!(
                grant(cycle * 64, expiry)
                    .remaining_at(entries.observe(Some(Duration::from_secs(1))))
                    .is_err()
            );
        }
        assert_eq!(entries.reclaimed(), 6400);
    }

    #[test]
    fn cleanup_never_discards_later_expiries_when_earliest_entries_are_reclaimed() {
        let mut entries = Revocations::default();
        entries.observe(Some(Duration::from_secs(10)));
        for (id, expiry) in [(1, 15), (2, 21), (3, 17), (4, 21)] {
            entries.insert(&grant(id, expiry)).unwrap();
        }
        for (at, expected) in [(14, 4), (15, 3), (16, 3), (17, 2), (20, 2), (21, 0)] {
            entries.observe(Some(Duration::from_secs(at)));
            assert_eq!(entries.len(), expected);
        }
        assert_eq!(entries.reclaimed(), 4);
    }
}
