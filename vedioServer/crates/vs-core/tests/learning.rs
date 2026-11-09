use vs_core::{
    DomainError,
    catalog::{Candidate, PublicCatalog},
    event_order::{InteractionOrder, SampleChronology},
    learning::{
        FEATURE_COUNT, LearnedRanker, LinearRankModel, PreferenceFeedback, RankTrainingSet,
        TrainingDataKind, TrainingSample, train_rank_model,
    },
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RequestContext, recommend,
        recommend_subset_with_model, recommend_with_model,
    },
};

fn catalog() -> PublicCatalog {
    PublicCatalog {
        version: "learning-v1".into(),
        items: ["a", "b", "c", "d"]
            .into_iter()
            .enumerate()
            .map(|(index, id)| Candidate {
                id: id.into(),
                domain: if index < 2 { "video" } else { "service" }.into(),
                tags: vec![if index % 2 == 0 { "first" } else { "second" }.into()],
                prior: if index % 2 == 0 { 0.2 } else { 0.8 },
                media_sha256: None,
            })
            .collect(),
        assets: vec![],
    }
}

fn request() -> RecommendationRequest {
    RecommendationRequest {
        request_id: "query".into(),
        domains: vec!["video".into(), "service".into()],
        limit: 4,
        profile: Some(ProfileProjection {
            subject: "subject".into(),
            version: "p1".into(),
            scopes: vec!["video".into(), "service".into()],
            expires_at: 10_000,
            interests: vec![
                Interest {
                    tag: "first".into(),
                    weight: 0.8,
                },
                Interest {
                    tag: "second".into(),
                    weight: -0.7,
                },
            ],
            blocked_ids: vec![],
            denied_tags: vec![],
        }),
    }
}

fn training() -> RankTrainingSet {
    RankTrainingSet {
        schema: "rank-training-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: "a".repeat(64),
        catalog_as_of: 1,
        train_before: 1000,
        samples: (0..256)
            .map(|index| {
                let mut request = request();
                request.request_id = format!("request-{index}");
                request.profile.as_mut().unwrap().subject = format!("train-{}", index / 4);
                TrainingSample {
                    exposure_id: format!("exposure-{index}"),
                    evidence_ref: format!("feedback-{index}"),
                    profile_as_of: 1,
                    exposed_at: 2 + index * 2,
                    feedback_at: 3 + index * 2,
                    chronology: None,
                    request,
                    candidate_id: ["a", "b", "c", "d"][(index % 4) as usize].into(),
                    feedback: if index % 2 == 0 {
                        PreferenceFeedback::Like
                    } else {
                        PreferenceFeedback::Dislike
                    },
                }
            })
            .collect(),
    }
}

fn train(catalog: &PublicCatalog) -> LinearRankModel {
    train_rank_model(catalog, &training()).unwrap()
}

#[test]
fn training_generalizes_features_without_memorizing_subject_or_tag_identity() {
    let mut catalog = catalog();
    let original_catalog = catalog.clone();
    let model = train(&catalog);
    let mut request = request();
    let context = RequestContext::new(&request, 900).unwrap();
    let ranker = LearnedRanker::new(&model, &catalog).unwrap();
    assert!(ranker.score(&context, &catalog.items[0]) > ranker.score(&context, &catalog.items[1]));
    let expected = ranker.score(&context, &catalog.items[0]);
    catalog.items[0].id = "unseen-id".into();
    catalog.items[0].tags[0] = "unseen-tag".into();
    let profile = request.profile.as_mut().unwrap();
    profile.subject = "unseen-subject".into();
    profile.interests[0].tag = "unseen-tag".into();
    let context = RequestContext::new(&request, 900).unwrap();
    assert_eq!(expected, ranker.score(&context, &catalog.items[0]));
    let mut inverted = training();
    for sample in &mut inverted.samples {
        sample.feedback = match sample.feedback {
            PreferenceFeedback::Like => PreferenceFeedback::Dislike,
            PreferenceFeedback::Dislike => PreferenceFeedback::Like,
        };
    }
    let inverse = train_rank_model(&original_catalog, &inverted).unwrap();
    let inverse = LearnedRanker::new(&inverse, &original_catalog).unwrap();
    assert!(
        inverse.score(&context, &catalog.items[0]) < inverse.score(&context, &catalog.items[1])
    );
}

#[test]
fn learned_ranking_preserves_affinity_and_authorization_on_full_and_subset_paths() {
    let catalog = catalog();
    let mut model = train(&catalog);
    model.weights.fill(0.0);
    model.weights[1] = 20.0;
    let ranker = LearnedRanker::new(&model, &catalog).unwrap();
    let request = request();
    let baseline = recommend(&catalog, &request, 900).unwrap();
    let full = recommend_with_model(&catalog, &request, 1100, Some(&ranker)).unwrap();
    assert_ne!(baseline.items[0].id, full.items[0].id);
    for item in &full.items {
        assert_eq!(
            item.affinity,
            baseline
                .items
                .iter()
                .find(|old| old.id == item.id)
                .unwrap()
                .affinity
        );
        assert!(item.rank_score.unwrap().is_finite());
    }
    let subset =
        recommend_subset_with_model(&catalog, &request, 1100, &[3, 2, 1, 0], Some(&ranker))
            .unwrap();
    assert_eq!(
        serde_json::to_value(&full.items).unwrap(),
        serde_json::to_value(subset.items).unwrap()
    );
    assert!(recommend_subset_with_model(&catalog, &request, 1100, &[1, 1], Some(&ranker)).is_err());
    let mut restricted = request.clone();
    restricted
        .profile
        .as_mut()
        .unwrap()
        .blocked_ids
        .push("b".into());
    restricted
        .profile
        .as_mut()
        .unwrap()
        .denied_tags
        .push("first".into());
    let allowed = recommend_with_model(&catalog, &restricted, 1100, Some(&ranker)).unwrap();
    assert_eq!(
        allowed
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["d"]
    );
    assert!(matches!(
        recommend_with_model(&catalog, &request, 10_000, Some(&ranker)),
        Err(DomainError::Expired)
    ));
    assert!(recommend_with_model(&catalog, &request, 900, Some(&ranker)).is_err());
    restricted.profile.as_mut().unwrap().scopes.pop();
    assert!(matches!(
        recommend_with_model(&catalog, &restricted, 1100, Some(&ranker)),
        Err(DomainError::ScopeDenied)
    ));
}

#[test]
fn frozen_training_rejects_leakage_duplicates_unexposed_and_single_class_samples() {
    let catalog = catalog();
    for mutation in 0..9 {
        let mut set = training();
        match mutation {
            0 => set.samples[0].profile_as_of = set.samples[0].exposed_at + 1,
            1 => set.samples.last_mut().unwrap().feedback_at = set.train_before,
            2 => set.samples[0].feedback_at = set.samples[0].exposed_at,
            3 => set.samples[1].exposure_id = set.samples[0].exposure_id.clone(),
            4 => {
                set.samples[1].request.request_id = set.samples[0].request.request_id.clone();
                set.samples[1].candidate_id = set.samples[0].candidate_id.clone();
            }
            5 => set.samples.swap(0, 1),
            6 => set.samples[0]
                .request
                .profile
                .as_mut()
                .unwrap()
                .blocked_ids
                .push("a".into()),
            7 => set
                .samples
                .iter_mut()
                .for_each(|sample| sample.feedback = PreferenceFeedback::Like),
            8 => set.samples[0].candidate_id = "missing".into(),
            _ => unreachable!(),
        }
        assert!(
            train_rank_model(&catalog, &set).is_err(),
            "未拒绝第{mutation}类无效样本"
        );
    }
}

#[test]
fn models_fail_closed_for_incompatible_schemas_shapes_and_nonfinite_weights() {
    let catalog = catalog();
    let original = train(&catalog);
    assert_eq!(original.weights.len(), FEATURE_COUNT * 3);
    for mutation in 0..8 {
        let mut model = original.clone();
        match mutation {
            0 => model.weights[0] = f64::NAN,
            1 => model.weights[0] = f64::INFINITY,
            2 => model.weights[0] = 101.0,
            3 => {
                model.weights.pop();
            }
            4 => model.domains.reverse(),
            5 => model.feature_schema = "unknown".into(),
            6 => model.objective = "impression-is-like".into(),
            7 => model.catalog_version = "other".into(),
            _ => unreachable!(),
        }
        assert!(LearnedRanker::new(&model, &catalog).is_err());
    }
}

#[test]
fn same_second_training_requires_explicit_local_order_and_does_not_change_model_features() {
    let catalog = catalog();
    let original = training();
    let original_model = train_rank_model(&catalog, &original).unwrap();
    let mut ordered = original.clone();
    ordered.schema = "rank-training-v2".into();
    for (index, sample) in ordered.samples.iter_mut().enumerate() {
        sample.feedback_at = sample.exposed_at;
        let exposure = InteractionOrder {
            interaction_id: format!("interaction-{index}"),
            generation: 1,
            sequence: 1,
            elapsed_ms: 300,
        };
        let feedback = InteractionOrder {
            sequence: 2,
            elapsed_ms: 500,
            ..exposure.clone()
        };
        sample.chronology = Some(SampleChronology {
            source_id: "trusted-gateway".into(),
            exposure,
            feedback,
        });
    }
    let ordered_model = train_rank_model(&catalog, &ordered).unwrap();
    assert_eq!(ordered_model.weights, original_model.weights);
    let mut downgraded = ordered.clone();
    downgraded.schema = "rank-training-v1".into();
    assert!(train_rank_model(&catalog, &downgraded).is_err());
    for mutation in 0..5 {
        let mut invalid = ordered.clone();
        let sample = &mut invalid.samples[0];
        match mutation {
            0 => sample.chronology = None,
            1 => sample.chronology.as_mut().unwrap().feedback.generation += 1,
            2 => sample.chronology.as_mut().unwrap().feedback.sequence = 1,
            3 => sample.chronology.as_mut().unwrap().feedback.elapsed_ms = 100,
            _ => sample.exposed_at = sample.feedback_at + 1,
        }
        assert!(train_rank_model(&catalog, &invalid).is_err());
    }
}
