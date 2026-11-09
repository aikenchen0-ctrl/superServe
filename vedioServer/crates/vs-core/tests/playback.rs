use vs_core::playback::{
    LoadControl, LoadReason, PlaybackActivity, PlaybackFeedback, PlaybackPolicy,
};

fn feedback() -> PlaybackFeedback {
    PlaybackFeedback {
        activity: PlaybackActivity::Active,
        buffered_media_ms: 0,
        buffered_bytes: 0,
        in_flight_bytes: 0,
        next_fragment_bytes: Some(32 * 1024),
        playback_rate_milli: 1000,
        rebuffering: false,
        end_of_stream: false,
    }
}

#[test]
fn time_watermarks_have_hysteresis_and_do_not_oscillate_in_the_middle() {
    let mut control = LoadControl::new(PlaybackPolicy::default()).unwrap();
    let mut f = feedback();
    for (buffer, load) in [
        (0, true),
        (2000, true),
        (3999, true),
        (4000, false),
        (3000, false),
        (2000, false),
        (1999, true),
    ] {
        f.buffered_media_ms = buffer;
        assert_eq!(control.decide(&f).unwrap().load_next, load, "{buffer}");
    }
    control.reset();
    f.buffered_media_ms = 3000;
    assert!(!control.decide(&f).unwrap().load_next);
}

#[test]
fn startup_rebuffer_and_playback_rate_use_playout_time() {
    let mut control = LoadControl::new(PlaybackPolicy::default()).unwrap();
    let mut f = feedback();
    for (speed, rebuffer, buffered, ready) in [
        (1000, false, 999, false),
        (1000, false, 1000, true),
        (1000, true, 1999, false),
        (1000, true, 2000, true),
        (2000, false, 1999, false),
        (2000, false, 2000, true),
        (250, false, 249, false),
        (250, false, 250, true),
    ] {
        f.playback_rate_milli = speed;
        f.rebuffering = rebuffer;
        f.buffered_media_ms = buffered;
        assert_eq!(control.decide(&f).unwrap().start_playback, ready);
    }
    f.playback_rate_milli = 2000;
    f.buffered_media_ms = 3000;
    control.reset();
    assert!(control.decide(&f).unwrap().load_next);
    f.buffered_media_ms = 4000;
    assert!(!control.decide(&f).unwrap().load_next);
}

#[test]
fn reservations_do_not_trigger_playback_and_complete_fragment_admission_is_bounded() {
    let policy = PlaybackPolicy {
        max_buffer_bytes: 65_536,
        ..Default::default()
    };
    let mut control = LoadControl::new(policy).unwrap();
    let mut f = feedback();
    f.buffered_media_ms = 100;
    f.in_flight_bytes = policy.max_buffer_bytes;
    let decision = control.decide(&f).unwrap();
    assert_eq!(decision.reason, LoadReason::ByteLimit);
    assert!(!decision.start_playback);
    assert!(!decision.load_next);
    f.in_flight_bytes = 1;
    assert_eq!(control.decide(&f).unwrap().reason, LoadReason::InFlight);
    f.in_flight_bytes = 0;
    f.next_fragment_bytes = Some(policy.max_buffer_bytes + 1);
    assert_eq!(
        control.decide(&f).unwrap().reason,
        LoadReason::FragmentExceedsBudget
    );
    f.buffered_bytes = policy.max_buffer_bytes - 32_768;
    f.next_fragment_bytes = Some(32_768);
    assert!(control.decide(&f).unwrap().load_next);
    f.buffered_bytes += 1;
    assert!(!control.decide(&f).unwrap().load_next);
}

#[test]
fn pause_hide_seek_and_content_switch_clear_hysteresis_and_cancel_active_requests() {
    for activity in [
        PlaybackActivity::Paused,
        PlaybackActivity::Hidden,
        PlaybackActivity::Seeking,
    ] {
        let mut control = LoadControl::new(PlaybackPolicy::default()).unwrap();
        let mut f = feedback();
        assert!(control.decide(&f).unwrap().load_next);
        f.activity = activity;
        f.in_flight_bytes = 512;
        let decision = control.decide(&f).unwrap();
        assert!(decision.cancel_in_flight);
        assert!(!decision.load_next);
        assert!(!decision.start_playback);
        f.activity = PlaybackActivity::Active;
        f.in_flight_bytes = 0;
        f.buffered_media_ms = 3000;
        assert!(!control.decide(&f).unwrap().load_next);
    }
    let mut first = LoadControl::new(PlaybackPolicy::default()).unwrap();
    first.decide(&feedback()).unwrap();
    let mut second = LoadControl::new(PlaybackPolicy::default()).unwrap();
    let f = PlaybackFeedback {
        buffered_media_ms: 3000,
        ..feedback()
    };
    assert!(first.decide(&f).unwrap().load_next);
    assert!(!second.decide(&f).unwrap().load_next);
}

#[test]
fn known_short_tail_can_start_but_empty_tail_cannot() {
    let mut control = LoadControl::new(PlaybackPolicy::default()).unwrap();
    let mut f = PlaybackFeedback {
        next_fragment_bytes: None,
        ..feedback()
    };
    assert_eq!(
        control.decide(&f).unwrap().reason,
        LoadReason::AwaitingFragment
    );
    f.end_of_stream = true;
    assert!(!control.decide(&f).unwrap().start_playback);
    f.buffered_media_ms = 100;
    let decision = control.decide(&f).unwrap();
    assert_eq!(decision.reason, LoadReason::EndOfStream);
    assert!(decision.start_playback);
    assert!(!decision.load_next);
}

#[test]
fn invalid_feedback_does_not_mutate_a_valid_loading_state() {
    for invalid in [
        PlaybackFeedback {
            playback_rate_milli: 0,
            ..feedback()
        },
        PlaybackFeedback {
            buffered_media_ms: u64::MAX,
            ..feedback()
        },
        PlaybackFeedback {
            buffered_bytes: u64::MAX,
            ..feedback()
        },
        PlaybackFeedback {
            end_of_stream: true,
            ..feedback()
        },
        PlaybackFeedback {
            next_fragment_bytes: Some(0),
            ..feedback()
        },
    ] {
        let mut control = LoadControl::new(PlaybackPolicy::default()).unwrap();
        control.decide(&feedback()).unwrap();
        assert!(control.decide(&invalid).is_err());
        let valid = PlaybackFeedback {
            buffered_media_ms: 3000,
            ..feedback()
        };
        assert!(control.decide(&valid).unwrap().load_next);
    }
    for policy in [
        PlaybackPolicy {
            min_buffer_ms: 0,
            ..Default::default()
        },
        PlaybackPolicy {
            max_buffer_ms: 500,
            ..Default::default()
        },
        PlaybackPolicy {
            max_buffer_bytes: u64::MAX,
            ..Default::default()
        },
        PlaybackPolicy {
            rebuffer_ms: 4000,
            ..Default::default()
        },
    ] {
        assert!(LoadControl::new(policy).is_err());
    }
}

#[test]
fn decisions_never_admit_outside_activity_inflight_or_byte_budget() {
    let policy = PlaybackPolicy {
        max_buffer_bytes: 65_536,
        ..Default::default()
    };
    for rate in [250, 999, 1000, 1001, 4000] {
        for buffer in [0, 499, 1000, 1999, 2000, 3999, 4000, 60_000] {
            for occupied in [0, 32_768, 65_535, 65_536] {
                let mut control = LoadControl::new(policy).unwrap();
                let f = PlaybackFeedback {
                    playback_rate_milli: rate,
                    buffered_media_ms: buffer,
                    buffered_bytes: occupied,
                    ..feedback()
                };
                let decision = control.decide(&f).unwrap();
                if decision.load_next {
                    assert!(occupied + f.next_fragment_bytes.unwrap() <= policy.max_buffer_bytes);
                    assert!(buffer < u64::from(policy.max_buffer_ms));
                    assert_eq!(decision.reason, LoadReason::Load);
                }
            }
        }
    }
}
