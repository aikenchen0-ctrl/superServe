use vs_core::{
    playback::{LoadReason, PlaybackActivity, PlaybackPolicy},
    playback_adapter::{BufferedRange, Completion, PlayerAdapter, PlayerSnapshot, TransferOutcome},
};

fn range(start_ms: u64, end_ms: u64) -> BufferedRange {
    BufferedRange { start_ms, end_ms }
}

fn snapshot(generation: u64, sequence: u64) -> PlayerSnapshot {
    PlayerSnapshot {
        generation,
        sequence,
        monotonic_ms: sequence * 10,
        position_ms: 0,
        tracks: vec![Vec::new(), Vec::new()],
        buffered_bytes: 0,
        activity: PlaybackActivity::Active,
        playback_rate_milli: 1000,
        rebuffering: false,
        end_of_stream: false,
    }
}

#[test]
fn only_continuous_intersection_counts_and_overlaps_do_not_double_count() {
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let mut s = snapshot(1, 1);
    s.position_ms = 1000;
    s.tracks = vec![
        vec![
            range(3000, 7000),
            range(0, 2000),
            range(500, 1500),
            range(2000, 2500),
        ],
        vec![range(0, 2200), range(2200, 2400), range(2600, 8000)],
    ];
    let result = adapter.update(&s, Some(10)).unwrap();
    assert_eq!(result.feedback.buffered_media_ms, 1400);
    assert!(result.request.is_some());
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    s.tracks[1] = vec![range(1001, 8000)];
    assert_eq!(
        adapter.update(&s, None).unwrap().feedback.buffered_media_ms,
        0
    );
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    s.tracks[1].clear();
    assert_eq!(
        adapter.update(&s, None).unwrap().feedback.buffered_media_ms,
        0
    );
}

#[test]
fn transfer_completion_holds_budget_until_an_actual_append_snapshot() {
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let ticket = adapter
        .update(&snapshot(1, 1), Some(1024))
        .unwrap()
        .request
        .unwrap();
    assert_eq!(
        adapter.transfer_finished(ticket, 1024, TransferOutcome::Complete),
        Completion::ReadyForAppend
    );
    let result = adapter.update(&snapshot(1, 2), Some(1024)).unwrap();
    assert_eq!(result.feedback.buffered_media_ms, 0);
    assert_eq!(result.feedback.in_flight_bytes, 1024);
    assert_eq!(result.decision.reason, LoadReason::InFlight);
    assert!(!result.decision.start_playback);
    let mut appended = snapshot(1, 3);
    appended.tracks = vec![vec![range(0, 4000)]; 2];
    appended.buffered_bytes = 1024;
    let result = adapter.appended(ticket, &appended, Some(1024)).unwrap();
    assert_eq!(result.feedback.in_flight_bytes, 0);
    assert_eq!(result.feedback.buffered_media_ms, 4000);
    assert!(result.decision.start_playback);
    assert!(result.request.is_none());
    assert_eq!(
        adapter.transfer_finished(ticket, 1024, TransferOutcome::Complete),
        Completion::Stale
    );
}

#[test]
fn generation_change_and_old_completion_cannot_admit_or_release_new_requests() {
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let old = adapter
        .update(&snapshot(1, 1), Some(100))
        .unwrap()
        .request
        .unwrap();
    let changed = adapter.change_generation().unwrap();
    assert_eq!(changed.generation, 2);
    assert_eq!(changed.cancel, Some(old));
    assert!(adapter.update(&snapshot(1, 2), Some(100)).is_err());
    assert!(
        adapter
            .update(&snapshot(2, 1), Some(100))
            .unwrap()
            .request
            .is_none()
    );
    assert_eq!(
        adapter.transfer_finished(old, 100, TransferOutcome::Complete),
        Completion::Discarded
    );
    let new = adapter
        .update(&snapshot(2, 2), Some(200))
        .unwrap()
        .request
        .unwrap();
    assert_ne!(old, new);
    assert!(!adapter.release(old));
    assert_eq!(
        adapter.transfer_finished(old, 100, TransferOutcome::Complete),
        Completion::Stale
    );
    let still_pending = adapter.update(&snapshot(2, 3), Some(200)).unwrap();
    assert_eq!(still_pending.feedback.in_flight_bytes, 200);
    assert!(still_pending.request.is_none());
    assert_eq!(
        adapter.transfer_finished(new, 199, TransferOutcome::Complete),
        Completion::LengthMismatch
    );
    assert!(
        adapter
            .update(&snapshot(2, 4), Some(200))
            .unwrap()
            .request
            .is_some()
    );
}

#[test]
fn hiding_revokes_a_request_but_retains_reservation_until_cancellation_ack() {
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let ticket = adapter
        .update(&snapshot(1, 1), Some(100))
        .unwrap()
        .request
        .unwrap();
    let mut hidden = snapshot(1, 2);
    hidden.activity = PlaybackActivity::Hidden;
    assert_eq!(
        adapter.update(&hidden, Some(100)).unwrap().cancel,
        Some(ticket)
    );
    assert!(
        adapter
            .update(&snapshot(1, 3), Some(100))
            .unwrap()
            .request
            .is_none()
    );
    assert_eq!(
        adapter.transfer_finished(ticket, 60, TransferOutcome::Cancelled),
        Completion::Discarded
    );
    assert!(
        adapter
            .update(&snapshot(1, 4), Some(100))
            .unwrap()
            .request
            .is_some()
    );
}

#[test]
fn cancelling_during_append_requires_append_task_release_not_duplicate_network_ack() {
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let ticket = adapter
        .update(&snapshot(1, 1), Some(100))
        .unwrap()
        .request
        .unwrap();
    adapter.transfer_finished(ticket, 100, TransferOutcome::Complete);
    adapter.change_generation().unwrap();
    assert_eq!(
        adapter.transfer_finished(ticket, 100, TransferOutcome::Complete),
        Completion::Stale
    );
    assert!(adapter.appended(ticket, &snapshot(2, 1), None).is_err());
    assert!(
        adapter
            .update(&snapshot(2, 1), Some(100))
            .unwrap()
            .request
            .is_none()
    );
    assert!(adapter.release(ticket));
    assert!(
        adapter
            .update(&snapshot(2, 2), Some(100))
            .unwrap()
            .request
            .is_some()
    );
}

#[test]
fn malformed_or_reordered_snapshots_do_not_change_pending_or_hysteresis() {
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let first = snapshot(1, 10);
    let ticket = adapter.update(&first, Some(100)).unwrap().request.unwrap();
    let mut invalid = snapshot(1, 11);
    invalid.tracks = vec![vec![range(5, 4)]];
    assert!(adapter.update(&invalid, Some(100)).is_err());
    assert!(adapter.update(&first, Some(100)).is_err());
    invalid = snapshot(1, 9);
    assert!(adapter.update(&invalid, Some(100)).is_err());
    invalid = snapshot(1, 11);
    invalid.monotonic_ms = 99;
    assert!(adapter.update(&invalid, Some(100)).is_err());
    invalid = snapshot(1, 11);
    invalid.tracks = vec![vec![range(0, 1000); 129]];
    assert!(adapter.update(&invalid, Some(100)).is_err());
    invalid = snapshot(1, 11);
    invalid.tracks.clear();
    assert!(adapter.update(&invalid, Some(100)).is_err());
    assert_eq!(
        adapter.transfer_finished(ticket, 100, TransferOutcome::Complete),
        Completion::ReadyForAppend
    );
    assert!(adapter.appended(ticket, &first, None).is_err());
    assert!(adapter.appended(ticket, &snapshot(1, 11), None).is_ok());
}

#[test]
fn backward_positions_require_new_generation_and_end_of_stream_requires_drained_requests() {
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let mut s = snapshot(1, 1);
    s.position_ms = 500;
    let ticket = adapter.update(&s, Some(100)).unwrap().request.unwrap();
    assert!(adapter.update(&snapshot(1, 2), Some(100)).is_err());
    let mut ended = snapshot(1, 2);
    ended.position_ms = 500;
    ended.end_of_stream = true;
    assert!(adapter.update(&ended, None).is_err());
    adapter.transfer_finished(ticket, 0, TransferOutcome::Failed);
    let result = adapter.update(&ended, None).unwrap();
    assert_eq!(result.decision.reason, LoadReason::EndOfStream);
    assert!(!result.decision.start_playback);
    adapter.change_generation().unwrap();
    assert!(
        adapter
            .update(&snapshot(2, 1), Some(100))
            .unwrap()
            .request
            .is_some()
    );
}

#[test]
fn complete_fragment_budget_is_enforced_through_append_and_next_admission() {
    let policy = PlaybackPolicy {
        max_buffer_bytes: 65_536,
        ..Default::default()
    };
    let mut adapter = PlayerAdapter::new(policy).unwrap();
    let ticket = adapter
        .update(&snapshot(1, 1), Some(40_000))
        .unwrap()
        .request
        .unwrap();
    assert_eq!(ticket.bytes(), 40_000);
    adapter.transfer_finished(ticket, 40_000, TransferOutcome::Complete);
    let mut s = snapshot(1, 2);
    s.buffered_bytes = 40_000;
    s.tracks = vec![vec![range(0, 500)]; 2];
    let result = adapter.appended(ticket, &s, Some(30_000)).unwrap();
    assert!(result.request.is_none());
    assert_eq!(result.decision.reason, LoadReason::FragmentExceedsBudget);
}

#[test]
fn identical_generation_and_size_from_another_playback_object_cannot_release_this_reservation() {
    let mut first = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let mut second = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let a = first
        .update(&snapshot(1, 1), Some(100))
        .unwrap()
        .request
        .unwrap();
    let b = second
        .update(&snapshot(1, 1), Some(100))
        .unwrap()
        .request
        .unwrap();
    assert_ne!(a, b);
    assert_eq!(
        first.transfer_finished(b, 100, TransferOutcome::Complete),
        Completion::Stale
    );
    assert!(!first.release(b));
    assert!(
        first
            .update(&snapshot(1, 2), Some(100))
            .unwrap()
            .request
            .is_none()
    );
    assert_eq!(
        first.transfer_finished(a, 100, TransferOutcome::Complete),
        Completion::ReadyForAppend
    );
}

#[test]
fn varied_range_sets_match_an_independent_discrete_timeline_oracle() {
    let mut seed = 17_u64;
    for _ in 0..1024 {
        let mut tracks = vec![Vec::new(), Vec::new()];
        for track in &mut tracks {
            for _ in 0..8 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let start = (seed >> 32) % 16;
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let end = start + 1 + (seed >> 32) % (16 - start);
                track.push(range(start, end));
            }
        }
        for position in [0, 1, 7, 15, 16] {
            let expected = (position..16)
                .take_while(|point| {
                    tracks.iter().all(|track| {
                        track
                            .iter()
                            .any(|range| range.start_ms <= *point && *point < range.end_ms)
                    })
                })
                .count() as u64;
            let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
            let mut s = snapshot(1, 1);
            s.position_ms = position;
            s.tracks = tracks.clone();
            assert_eq!(
                adapter.update(&s, None).unwrap().feedback.buffered_media_ms,
                expected
            );
        }
    }
}
