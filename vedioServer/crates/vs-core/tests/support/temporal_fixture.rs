use vs_core::{
    catalog::{Candidate, PublicCatalog},
    learning::{PreferenceFeedback, RankTrainingSet, TrainingDataKind, TrainingSample},
    recommendation::{ProfileProjection, RecommendationRequest},
    training_split::TemporalSplitConfig,
};

pub fn fixture() -> (PublicCatalog, RankTrainingSet, TemporalSplitConfig) {
    let domains = ["video", "article", "service"];
    let catalog = PublicCatalog {
        version: "temporal-fixture-v1".into(),
        items: domains
            .iter()
            .map(|domain| Candidate {
                id: format!("{domain}-item"),
                domain: (*domain).into(),
                tags: vec!["topic".into()],
                prior: 0.5,
                media_sha256: None,
            })
            .collect(),
        assets: vec![],
    };
    let samples = (0..18)
        .map(|index| {
            let exposed = 10 + (index / 6) * 100 + (index % 6) * 2;
            let subject = if index >= 12 && index % 2 == 1 {
                "new-user"
            } else {
                "warm-user"
            };
            TrainingSample {
                exposure_id: format!("exposure-{index}"),
                evidence_ref: format!("feedback-{index}"),
                profile_as_of: 1,
                exposed_at: exposed,
                feedback_at: exposed + 1,
                chronology: None,
                request: RecommendationRequest {
                    request_id: format!("decision-{index}"),
                    domains: domains.iter().map(|s| (*s).into()).collect(),
                    limit: 3,
                    profile: Some(ProfileProjection {
                        subject: subject.into(),
                        version: "frozen-1".into(),
                        scopes: domains.iter().map(|s| (*s).into()).collect(),
                        expires_at: 400,
                        interests: vec![],
                        blocked_ids: vec![],
                        denied_tags: vec![],
                    }),
                },
                candidate_id: format!("{}-item", domains[(index % 3) as usize]),
                feedback: if index % 2 == 0 {
                    PreferenceFeedback::Like
                } else {
                    PreferenceFeedback::Dislike
                },
            }
        })
        .collect();
    let source = RankTrainingSet {
        schema: "rank-training-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: "a".repeat(64),
        catalog_as_of: 1,
        train_before: 300,
        samples,
    };
    let config = TemporalSplitConfig {
        schema: "rank-temporal-split-v1".into(),
        train_before: 100,
        validation_before: 200,
        embargo_seconds: 5,
    };
    (catalog, source, config)
}
