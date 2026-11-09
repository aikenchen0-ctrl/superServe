use vs_core::learning::TrainingDataKind;
use vs_service::{
    consumption::{
        ByteScope, ClientPlatform, ConsumptionBatch, ConsumptionEvent, ConsumptionObservation,
        ExplicitPreference, PresentationSignal, normalize_consumption,
    },
    learning_evidence::GatewayEventKind,
};

fn event(sequence: u64, elapsed_ms: u64, observation: ConsumptionObservation) -> ConsumptionEvent {
    ConsumptionEvent {
        event_id: format!("event-{sequence}"),
        sequence,
        elapsed_ms,
        observed_at: 100 + elapsed_ms / 1000,
        observation,
    }
}

fn batch(platform: ClientPlatform) -> ConsumptionBatch {
    ConsumptionBatch {
        schema: "client-consumption-v1".into(),
        source_id: "gateway".into(),
        data_kind: TrainingDataKind::Synthetic,
        platform,
        subject: "viewer".into(),
        decision_id: "a".repeat(64),
        candidate_id: "candidate".into(),
        interaction_id: "interaction".into(),
        generation: 1,
        events: vec![],
    }
}

fn progress(
    position: u64,
    active: Option<u64>,
    waiting: Option<u64>,
    bytes: Option<u64>,
    scope: Option<ByteScope>,
) -> ConsumptionObservation {
    ConsumptionObservation::Progress {
        position_ms: Some(position),
        active_ms: active,
        rebuffer_ms: waiting,
        transferred_bytes: bytes,
        byte_scope: scope,
    }
}

#[test]
fn native_signals_and_unknown_counters_preserve_their_own_measurement_scope() {
    for (platform, signal, scope) in [
        (
            ClientPlatform::Android,
            PresentationSignal::AndroidRenderedFirstFrame,
            ByteScope::AndroidDataSource,
        ),
        (
            ClientPlatform::Ios,
            PresentationSignal::IosReadyForDisplay,
            ByteScope::IosAccessLog,
        ),
        (
            ClientPlatform::Web,
            PresentationSignal::WebVideoFrameCallback,
            ByteScope::WebXhrBody,
        ),
    ] {
        let mut input = batch(platform);
        input.events = vec![
            event(1, 200, ConsumptionObservation::FirstPresentable { signal }),
            event(
                2,
                1000,
                progress(800, Some(700), Some(100), None, Some(scope)),
            ),
            event(
                3,
                2000,
                progress(200, Some(1500), None, Some(5000), Some(scope)),
            ),
            event(4, 3000, progress(2800, None, None, None, Some(scope))),
        ];
        let output = normalize_consumption(&input, 104).unwrap();
        assert!(output.learning.events.is_empty());
        assert_eq!(output.summary.first_presentable_elapsed_ms, Some(200));
        assert_eq!(output.summary.last_known_transferred_bytes, Some(5000));
        assert_eq!(output.summary.last_known_active_ms, Some(1500));
        assert_eq!(output.summary.last_known_rebuffer_ms, Some(100));
        assert_eq!(output.summary.byte_scope, Some(scope));
        assert_eq!(output.summary.last_position_ms, Some(2800));
    }
}

#[test]
fn only_foreground_presented_visibility_and_explicit_preference_become_learning_declarations() {
    let mut input = batch(ClientPlatform::Ios);
    input.events = vec![
        event(
            1,
            100,
            ConsumptionObservation::FirstPresentable {
                signal: PresentationSignal::IosReadyForDisplay,
            },
        ),
        event(
            2,
            200,
            ConsumptionObservation::Visibility {
                signal: None,
                foreground: true,
                visible_fraction_milli: 1000,
            },
        ),
        event(
            3,
            300,
            ConsumptionObservation::Visibility {
                signal: Some(PresentationSignal::IosReadyForDisplay),
                foreground: false,
                visible_fraction_milli: 1000,
            },
        ),
        event(
            4,
            400,
            ConsumptionObservation::Visibility {
                signal: Some(PresentationSignal::IosReadyForDisplay),
                foreground: true,
                visible_fraction_milli: 0,
            },
        ),
        event(
            5,
            1200,
            ConsumptionObservation::Visibility {
                signal: Some(PresentationSignal::IosReadyForDisplay),
                foreground: true,
                visible_fraction_milli: 800,
            },
        ),
        event(
            6,
            2300,
            ConsumptionObservation::Preference {
                value: ExplicitPreference::Dislike,
            },
        ),
    ];
    input.events.push(input.events[5].clone());
    let output = normalize_consumption(&input, 104).unwrap();
    assert_eq!(output.summary.unique_events, 6);
    assert_eq!(output.summary.duplicate_events, 1);
    assert_eq!(output.learning.events.len(), 2);
    assert_eq!(output.learning.schema, "gateway-learning-events-v2");
    assert_eq!(
        output.learning.events[0].order.as_ref().unwrap().sequence,
        5
    );
    assert_eq!(
        output.learning.events[1].order.as_ref().unwrap().sequence,
        6
    );
    assert_eq!(output.learning.events[0].kind, GatewayEventKind::Visible);
    assert_eq!(output.learning.events[1].kind, GatewayEventKind::Dislike);
    assert_eq!(output.learning.events[0].at, 101);
    assert_eq!(output.learning.events[1].at, 102);
}

#[test]
fn article_and_service_surfaces_do_not_require_video_callbacks() {
    for (platform, signal) in [
        (
            ClientPlatform::Android,
            PresentationSignal::AndroidViewDrawn,
        ),
        (ClientPlatform::Ios, PresentationSignal::IosViewAppeared),
        (ClientPlatform::Web, PresentationSignal::WebElementVisible),
    ] {
        let mut input = batch(platform);
        input.events = vec![
            event(
                1,
                1000,
                ConsumptionObservation::Visibility {
                    signal: Some(signal),
                    foreground: true,
                    visible_fraction_milli: 1000,
                },
            ),
            event(
                2,
                2100,
                ConsumptionObservation::Preference {
                    value: ExplicitPreference::Like,
                },
            ),
        ];
        let output = normalize_consumption(&input, 104).unwrap();
        assert_eq!(output.learning.events.len(), 2);
        assert!(output.summary.first_presentable_elapsed_ms.is_none());
    }
}

#[test]
fn invalid_sources_sequences_counter_resets_and_conflicting_duplicates_are_rejected() {
    let mut input = batch(ClientPlatform::Android);
    input.events = vec![
        event(
            1,
            1000,
            progress(
                500,
                Some(600),
                Some(100),
                Some(900),
                Some(ByteScope::AndroidDataSource),
            ),
        ),
        event(
            2,
            2000,
            progress(
                100,
                Some(1500),
                None,
                Some(2000),
                Some(ByteScope::AndroidDataSource),
            ),
        ),
    ];
    let mut bad = input.clone();
    bad.events[1].observation = progress(
        100,
        Some(500),
        None,
        Some(2000),
        Some(ByteScope::AndroidDataSource),
    );
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].sequence = 1;
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].event_id = "event-1".into();
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].observation =
        progress(100, None, None, Some(2000), Some(ByteScope::IosAccessLog));
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].observation = progress(100, None, None, Some(2000), None);
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].observation = ConsumptionObservation::FirstPresentable {
        signal: PresentationSignal::WebVideoFrameCallback,
    };
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].observed_at = 105;
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].elapsed_ms = 1100;
    bad.events[1].observation = progress(100, None, Some(600), None, None);
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.generation = 9_007_199_254_740_992;
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events[1].sequence = 9_007_199_254_740_992;
    assert!(normalize_consumption(&bad, 104).is_err());
    let mut bad = input.clone();
    bad.events = vec![bad.events[0].clone(); 65];
    assert!(normalize_consumption(&bad, 104).is_err());
}

#[test]
fn unknown_native_bytes_stay_null_and_negative_wire_values_do_not_become_zero() {
    let mut input = batch(ClientPlatform::Ios);
    input.events = vec![event(
        1,
        1000,
        progress(0, None, None, None, Some(ByteScope::IosAccessLog)),
    )];
    let output = normalize_consumption(&input, 104).unwrap();
    assert!(output.summary.last_known_transferred_bytes.is_none());
    assert!(output.summary.last_known_active_ms.is_none());
    assert!(output.summary.last_known_rebuffer_ms.is_none());
    let mut wire = serde_json::to_value(&input).unwrap();
    wire["events"][0]["observation"]["transferred_bytes"] = serde_json::json!(-1);
    assert!(serde_json::from_value::<ConsumptionBatch>(wire).is_err());
}
