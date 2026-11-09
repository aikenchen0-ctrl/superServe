use std::sync::Arc;

use vs_core::{
    catalog::{Candidate, PublicCatalog},
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    model_recall::ModelRecallProjection,
    recommendation::{Interest, ProfileProjection, RecommendationRequest, RequestContext},
};

#[test]
fn model_projection_preserves_domain_components_and_is_stable_under_catalog_permutation() {
    let catalog = Arc::new(PublicCatalog {
        version: "model-recall-unit".into(),
        items: ["video", "article", "service"]
            .into_iter()
            .flat_map(|domain| {
                (0..4).map(move |i| Candidate {
                    id: format!("{domain}-{i}"),
                    domain: domain.into(),
                    tags: match i {
                        0 => vec![],
                        1 => vec!["positive".into()],
                        2 => vec!["negative".into(), "positive".into(), "unknown".into()],
                        _ => vec!["unknown".into()],
                    },
                    prior: i as f32 / 3.0,
                    media_sha256: None,
                })
            })
            .collect(),
        assets: vec![],
    });
    let mut reversed = (*catalog).clone();
    reversed.items.reverse();
    let forward = ModelRecallProjection::new(catalog.clone()).unwrap();
    let reverse = ModelRecallProjection::new(Arc::new(reversed)).unwrap();
    let model = LearnedRanker::new(
        &LinearRankModel {
            schema: "ftrl-ranker-v1".into(),
            feature_schema: "profile-candidate-6-v1".into(),
            objective: "explicit-preference-v1".into(),
            catalog_version: catalog.version.clone(),
            catalog_sha256: "a".repeat(64),
            data_kind: TrainingDataKind::Synthetic,
            trained_before: 1,
            training_samples: 2,
            positive_samples: 1,
            domains: vec!["article".into(), "video".into()],
            weights: [0.2, -2.0, 3.0, 4.0, -0.5, 0.7]
                .into_iter()
                .chain([0.3, 1.0, -0.1, 0.3, 0.4, -0.1])
                .chain([-0.1, -0.3, 0.2, -0.2, 0.1, 0.2])
                .collect(),
        },
        &catalog,
    )
    .unwrap();
    for cold in [false, true] {
        let request = RecommendationRequest {
            request_id: "projection-test".into(),
            domains: vec!["video".into(), "article".into(), "service".into()],
            limit: 5,
            profile: (!cold).then(|| ProfileProjection {
                subject: "unit".into(),
                version: "p1".into(),
                scopes: vec!["video".into(), "article".into(), "service".into()],
                expires_at: 200,
                interests: vec![
                    Interest {
                        tag: "positive".into(),
                        weight: 0.7,
                    },
                    Interest {
                        tag: "negative".into(),
                        weight: -0.6,
                    },
                    Interest {
                        tag: "missing".into(),
                        weight: 1.0,
                    },
                ],
                blocked_ids: vec![],
                denied_tags: vec![],
            }),
        };
        let context = RequestContext::new(&request, 100).unwrap();
        let query = forward.query(&request, 100, &model).unwrap();
        let other = reverse.query(&request, 100, &model).unwrap();
        assert_eq!(query.indices, other.indices);
        assert_eq!(query.values, other.values);
        for (i, item) in catalog.items.iter().enumerate() {
            let point = forward.point(i).unwrap();
            let mirrored = reverse.point(catalog.items.len() - 1 - i).unwrap();
            assert_eq!(point.indices, mirrored.indices);
            assert_eq!(point.values, mirrored.values);
            let dot: f64 = point
                .indices
                .iter()
                .zip(&point.values)
                .map(|(index, value)| {
                    query.indices.binary_search(index).map_or(0.0, |position| {
                        f64::from(query.values[position]) * f64::from(*value)
                    })
                })
                .sum();
            assert!((dot - model.score(&context, item)).abs() < 1e-5);
            assert!(point.indices.windows(2).all(|pair| pair[0] < pair[1]));
        }
        assert!(forward.query(&request, 0, &model).is_err());
        assert!(forward.point(catalog.items.len()).is_err());
    }
}
