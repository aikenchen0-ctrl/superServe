mod support {
    pub mod temporal_fixture;
}

use support::temporal_fixture::fixture;
use vs_core::{
    event_order::{InteractionOrder, SampleChronology},
    learning::{PreferenceFeedback, train_rank_model, validate_training_set},
    training_split::temporal_split,
};

#[test]
fn global_windows_keep_all_domains_and_report_warm_users_without_claiming_cold_start() {
    let (catalog, source, config) = fixture();
    let result = temporal_split(&catalog, &source, &config).unwrap();
    assert_eq!(result.training.samples.len(), 6);
    assert_eq!(result.validation_indices, (6..12).collect::<Vec<_>>());
    assert_eq!(result.test_indices, (12..18).collect::<Vec<_>>());
    assert!(result.purged_indices.is_empty());
    assert_eq!(result.training.train_before, 100);
    assert_eq!(result.audit.validation_known_subject_samples, 6);
    assert_eq!(result.audit.test_known_subject_samples, 3);
    assert!(!result.audit.subject_disjoint_required);
    assert!(!result.audit.model_selection_protected);
    for domain in result.audit.domains.values() {
        assert_eq!(
            (
                domain.training,
                domain.validation,
                domain.test,
                domain.purged
            ),
            (2, 2, 2, 0)
        );
    }
    validate_training_set(&catalog, &result.training).unwrap();
}

#[test]
fn whole_decision_is_purged_instead_of_distributing_its_candidates_across_windows() {
    let (catalog, mut source, config) = fixture();
    source.samples[6].request.request_id = source.samples[4].request.request_id.clone();
    let result = temporal_split(&catalog, &source, &config).unwrap();
    assert_eq!(result.purged_indices, [4, 6]);
    assert_eq!(result.audit.purged_decisions, 1);
    assert_eq!(result.training.samples.len(), 5);
    assert_eq!(result.validation_indices.len(), 5);
    assert!(
        !result
            .training
            .samples
            .iter()
            .any(|sample| sample.exposure_id == "exposure-4")
    );
}

#[test]
fn half_open_cutoffs_embargo_and_delayed_labels_never_move_old_exposures_to_a_later_set() {
    let (catalog, mut source, config) = fixture();
    for (index, exposed, feedback) in [
        (5, 99, 100),
        (6, 100, 101),
        (7, 105, 106),
        (11, 199, 200),
        (12, 200, 201),
        (13, 205, 206),
    ] {
        source.samples[index].exposed_at = exposed;
        source.samples[index].feedback_at = feedback;
    }
    let result = temporal_split(&catalog, &source, &config).unwrap();
    assert_eq!(result.purged_indices, [5, 6, 11, 12]);
    assert!(result.validation_indices.contains(&7));
    assert!(result.test_indices.contains(&13));
    assert_eq!(result.audit.retained.training, 5);
    assert_eq!(result.audit.retained.validation, 4);
    assert_eq!(result.audit.retained.test, 5);
}

#[test]
fn changing_every_future_label_cannot_change_training_samples_or_model_weights() {
    let (catalog, mut source, config) = fixture();
    let original = temporal_split(&catalog, &source, &config).unwrap();
    let expected = train_rank_model(&catalog, &original.training).unwrap();
    for sample in &mut source.samples[6..] {
        sample.feedback = match sample.feedback {
            PreferenceFeedback::Like => PreferenceFeedback::Dislike,
            PreferenceFeedback::Dislike => PreferenceFeedback::Like,
        };
    }
    let changed = temporal_split(&catalog, &source, &config).unwrap();
    let actual = train_rank_model(&catalog, &changed.training).unwrap();
    assert_eq!(expected.weights, actual.weights);
    assert_eq!(expected.training_samples, 6);
    assert_eq!(expected.positive_samples, 3);
    assert_eq!(actual.trained_before, 100);
}

#[test]
fn reused_feedback_identity_and_cross_subject_decision_identity_are_rejected() {
    let (catalog, original, config) = fixture();
    let mut source = original.clone();
    source.samples[12].evidence_ref = source.samples[0].evidence_ref.clone();
    assert!(temporal_split(&catalog, &source, &config).is_err());
    source = original;
    source.samples[12].request.request_id = source.samples[0].request.request_id.clone();
    source.samples[12].request.profile.as_mut().unwrap().subject = "other-user".into();
    assert!(temporal_split(&catalog, &source, &config).is_err());
}

#[test]
fn invalid_boundaries_empty_holdouts_and_single_class_training_fail_without_resampling() {
    let (catalog, original, original_config) = fixture();
    for (train, validation, gap) in [
        (1, 200, 5),
        (100, 100, 0),
        (100, 105, 5),
        (100, 295, 5),
        (u64::MAX, 200, 5),
        (250, 260, 0),
    ] {
        let mut config = original_config.clone();
        config.train_before = train;
        config.validation_before = validation;
        config.embargo_seconds = gap;
        assert!(temporal_split(&catalog, &original, &config).is_err());
    }
    let mut source = original;
    for sample in &mut source.samples[..6] {
        sample.feedback = PreferenceFeedback::Like;
    }
    assert!(temporal_split(&catalog, &source, &original_config).is_err());
}

#[test]
fn timestamp_ties_require_existing_local_order_evidence_and_remain_on_one_side_of_cutoff() {
    let (catalog, mut source, mut config) = fixture();
    config.embargo_seconds = 0;
    source.schema = "rank-training-v2".into();
    let sample = &mut source.samples[6];
    sample.exposed_at = 100;
    sample.feedback_at = 100;
    let order = |sequence| InteractionOrder {
        interaction_id: "interaction-6".into(),
        generation: 1,
        sequence,
        elapsed_ms: sequence * 10,
    };
    sample.chronology = Some(SampleChronology {
        source_id: "test-source".into(),
        exposure: order(1),
        feedback: order(2),
    });
    let result = temporal_split(&catalog, &source, &config).unwrap();
    assert!(result.validation_indices.contains(&6));
    source.samples[6].chronology = None;
    assert!(temporal_split(&catalog, &source, &config).is_err());
}

#[test]
fn unknown_subjects_are_counted_instead_of_being_treated_as_one_shared_user() {
    let (catalog, mut source, config) = fixture();
    source.samples[7].request.profile = None;
    let result = temporal_split(&catalog, &source, &config).unwrap();
    assert_eq!(result.audit.unknown_subject_samples, 1);
    assert_eq!(result.audit.validation_known_subject_samples, 5);
}
