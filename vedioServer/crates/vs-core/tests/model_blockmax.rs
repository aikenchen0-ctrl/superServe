use std::sync::Arc;

use vs_core::{
    catalog::{Candidate, PublicCatalog},
    grouped_recall::GroupedRecall,
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    recommendation::{ProfileProjection, RecommendationRequest, recommend_with_model},
};

#[test]
fn blocks_preserve_full_sort_at_boundaries_with_hiding_plateaus_and_both_score_directions() {
    for size in [63_usize, 64, 65, 129, 513, 4096] {
        for reverse in [false, true] {
            let mut catalog = PublicCatalog {
                version: "model-blockmax".into(),
                items: (0..size)
                    .map(|i| Candidate {
                        id: format!("item-{i:05}"),
                        domain: "video".into(),
                        tags: vec!["focus".into()],
                        prior: match i % 11 {
                            0 => -0.0,
                            1 => 0.0,
                            2 => f32::from_bits(1),
                            3 => f32::MIN_POSITIVE,
                            4 => 0.5,
                            5 => 1.0,
                            _ => i as f32 / size as f32,
                        },
                        media_sha256: None,
                    })
                    .collect(),
                assets: vec![],
            };
            if reverse {
                catalog.items.reverse();
            }
            let catalog = Arc::new(catalog);
            let index = GroupedRecall::new(catalog.clone()).unwrap();
            for (bias, slope) in [
                (0.0, -5.0),
                (0.0, 5.0),
                (0.0, 0.0),
                (100.0, f64::EPSILON),
                (-0.0, -0.0),
                (0.0, f64::from_bits(1)),
                (0.0, -f64::from_bits(1)),
            ] {
                let mut weights = vec![0.0; 12];
                weights[0] = bias;
                weights[1] = slope;
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
                        domains: vec!["video".into()],
                        weights,
                    },
                    &catalog,
                )
                .unwrap();
                for k in [1, 10, 50] {
                    for hidden in [false, true] {
                        let request = RecommendationRequest {
                            request_id: "blockmax".into(),
                            domains: vec!["video".into()],
                            limit: k,
                            profile: Some(ProfileProjection {
                                subject: "unit".into(),
                                version: "frozen".into(),
                                scopes: vec!["video".into()],
                                expires_at: 100,
                                interests: vec![],
                                blocked_ids: if hidden {
                                    catalog
                                        .items
                                        .iter()
                                        .enumerate()
                                        .filter(|(i, _)| {
                                            i % 5 == 0 || *i < 65 || *i >= size.saturating_sub(65)
                                        })
                                        .map(|(_, item)| item.id.clone())
                                        .collect()
                                } else {
                                    vec![]
                                },
                                denied_tags: vec![],
                            }),
                        };
                        // 最多128个隐藏ID；全隐块另在较小目录验证。
                        let mut request = request;
                        request.profile.as_mut().unwrap().blocked_ids.truncate(128);
                        let actual = index
                            .recommend_with_model_blockmax(&request, 50, &model)
                            .unwrap();
                        let full =
                            recommend_with_model(&catalog, &request, 50, Some(&model)).unwrap();
                        assert_eq!(
                            serde_json::to_value(&actual.response).unwrap(),
                            serde_json::to_value(&full).unwrap()
                        );
                        for (a, b) in actual.response.items.iter().zip(&full.items) {
                            assert_eq!(
                                a.rank_score.unwrap().to_bits(),
                                b.rank_score.unwrap().to_bits()
                            );
                            assert_eq!(a.affinity.to_bits(), b.affinity.to_bits());
                        }
                        assert_eq!(
                            actual.work.model_evaluations + actual.work.model_evaluations_skipped,
                            full.considered
                        );
                        assert!(actual.work.peak_scored_entries <= 2 * k);
                        if size >= 513 && !hidden && bias == 0.0 && slope.abs() == 5.0 {
                            assert!(actual.work.blocks_pruned > 0);
                            assert!(actual.work.model_evaluations < full.considered / 2);
                            assert_eq!(actual.work.groups_reversed, usize::from(slope < 0.0));
                        }
                        if slope == 0.0 {
                            assert_eq!(actual.work.blocks_examined, 0);
                        }
                    }
                }
            }
        }
    }
}
