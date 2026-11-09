use vs_core::playback::{
    LoadControl, PlaybackActivity, PlaybackFeedback, PlaybackPolicy, TimeBufferControl,
};

#[test]
fn time_gate_matches_existing_control_when_byte_budget_does_not_bind() {
    for rate in [250, 999, 1000, 1001, 2000, 4000] {
        for (minimum, maximum) in [(500, 500), (750, 2000), (2000, 4000), (30_000, 60_000)] {
            let mut gate = TimeBufferControl::new(minimum, maximum).unwrap();
            let mut control = LoadControl::new(PlaybackPolicy {
                min_buffer_ms: minimum,
                max_buffer_ms: maximum,
                start_buffer_ms: minimum.min(1000),
                rebuffer_ms: minimum,
                ..Default::default()
            })
            .unwrap();
            for buffered in [0, 500, 1999, 3000, 60_000, 3000, 1999, 0] {
                let feedback = PlaybackFeedback {
                    activity: PlaybackActivity::Active,
                    buffered_media_ms: buffered,
                    buffered_bytes: 0,
                    in_flight_bytes: 0,
                    next_fragment_bytes: Some(1),
                    playback_rate_milli: rate,
                    rebuffering: false,
                    end_of_stream: false,
                };
                assert_eq!(
                    gate.should_load(buffered as u32, rate).unwrap(),
                    control.decide(&feedback).unwrap().load_next,
                    "{minimum}/{maximum}/{rate}/{buffered}"
                );
            }
        }
    }
}

#[test]
fn invalid_samples_preserve_hysteresis_and_reset_clears_it() {
    let mut gate = TimeBufferControl::new(2000, 4000).unwrap();
    assert!(gate.should_load(0, 1000).unwrap());
    assert!(gate.should_load(3000, 0).is_err());
    assert!(gate.should_load(u32::MAX, 1000).is_err());
    assert!(gate.should_load(3000, 1000).unwrap());
    gate.reset();
    assert!(!gate.should_load(3000, 1000).unwrap());
    assert!(TimeBufferControl::new(0, 4000).is_err());
    assert!(TimeBufferControl::new(2000, 1000).is_err());
}
