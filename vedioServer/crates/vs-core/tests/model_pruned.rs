use std::{collections::BTreeSet, sync::Arc};

use vs_core::{
    DomainError,
    catalog::{Candidate, PublicCatalog},
    grouped_recall::GroupedRecall,
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RequestContext, recommend_with_model,
    },
};

fn model(catalog: &PublicCatalog, seed: usize) -> LearnedRanker {
    let domains: Vec<_> = catalog
        .items
        .iter()
        .map(|item| item.domain.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let weights = (0..6 * (domains.len() + 1))
        .map(|index| match seed {
            0 => {
                if index == 1 {
                    -5.0
                } else {
                    0.0
                }
            }
            1 => {
                if index % 6 == 2 || index % 6 == 3 {
                    2.0
                } else {
                    0.0
                }
            }
            2 => {
                if index % 6 == 0 {
                    100.0
                } else if index % 6 == 1 {
                    f64::EPSILON
                } else {
                    0.0
                }
            }
            3 => -0.0,
            4 => {
                if index % 2 == 0 {
                    f64::from_bits(1)
                } else {
                    -f64::from_bits(1)
                }
            }
            _ => (((index + 7) * (seed + 13) * 19) % 201) as f64 - 100.0,
        })
        .collect();
    LearnedRanker::new(
        &LinearRankModel {
            schema: "ftrl-ranker-v1".into(),
            feature_schema: "profile-candidate-6-v1".into(),
            objective: "explicit-preference-v1".into(),
            catalog_version: catalog.version.clone(),
            catalog_sha256: "a".repeat(64),
            trained_before: 1,
            training_samples: 2,
            positive_samples: 1,
            data_kind: TrainingDataKind::Synthetic,
            domains,
            weights,
        },
        catalog,
    )
    .unwrap()
}

fn request(k: usize) -> RecommendationRequest {
    RecommendationRequest {
        request_id: "group-model-test".into(),
        limit: k,
        domains: vec!["video".into(), "article".into(), "service".into()],
        profile: Some(ProfileProjection {
            subject: "subject".into(),
            version: "p1".into(),
            expires_at: 100,
            scopes: vec!["video".into(), "article".into(), "service".into()],
            interests: vec![
                Interest {
                    tag: "a-best".into(),
                    weight: 0.9,
                },
                Interest {
                    tag: "b-low".into(),
                    weight: -0.9,
                },
                Interest {
                    tag: "tiny".into(),
                    weight: f32::from_bits(1),
                },
            ],
            blocked_ids: vec!["item-00001".into(), "item-00002".into()],
            denied_tags: vec!["denied".into()],
        }),
    }
}

fn catalog(size: usize, unique: bool) -> PublicCatalog {
    PublicCatalog {
        version: "model-pruned-test-v1".into(),
        assets: vec![],
        items: (0..size)
            .map(|i| Candidate {
                id: format!("item-{i:05}"),
                domain: ["article", "service", "video"][i % 3].into(),
                tags: if unique {
                    vec![format!("unique-{i}")]
                } else {
                    match i % 7 {
                        0 => vec![],
                        1 => vec!["a-best".into()],
                        2 => vec!["b-low".into()],
                        3 => vec!["a-best".into(), "tiny".into(), "b-low".into()],
                        4 => vec!["tiny".into(), "a-best".into(), "b-low".into()],
                        5 => vec!["denied".into()],
                        _ => vec!["b-low".into(), "a-best".into()],
                    }
                },
                prior: match i % 11 {
                    0 => -0.0,
                    1 => 0.0,
                    2 => f32::from_bits(1),
                    3 => f32::MIN_POSITIVE,
                    4 => 0.5,
                    5 => 1.0,
                    _ => (i % 101) as f32 / 100.0,
                },
                media_sha256: None,
            })
            .collect(),
    }
}

fn assert_exact(
    catalog: Arc<PublicCatalog>,
    model: &LearnedRanker,
    request: &RecommendationRequest,
) {
    let index = GroupedRecall::new(catalog.clone()).unwrap();
    let actual = index.recommend_with_model(request, 50, model).unwrap();
    let expected = recommend_with_model(&catalog, request, 50, Some(model)).unwrap();
    let blocks = index
        .recommend_with_model_blockmax(request, 50, model)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&blocks.response).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    assert_eq!(
        blocks.work.model_evaluations + blocks.work.model_evaluations_skipped,
        blocks.response.considered
    );
    for (a, b) in blocks.response.items.iter().zip(&expected.items) {
        assert_eq!(a.affinity.to_bits(), b.affinity.to_bits());
        assert_eq!(
            a.rank_score.unwrap().to_bits(),
            b.rank_score.unwrap().to_bits()
        );
    }
    let context = RequestContext::new(request, 50).unwrap();
    let mut independent: Vec<_> = catalog
        .items
        .iter()
        .filter(|item| context.allows(item))
        .map(|item| (item, model.score(&context, item)))
        .collect();
    independent.sort_unstable_by(|(a, sa), (b, sb)| {
        sb.total_cmp(sa)
            .then_with(|| b.prior.total_cmp(&a.prior))
            .then_with(|| a.id.cmp(&b.id))
    });
    assert_eq!(
        actual
            .response
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        independent
            .iter()
            .take(request.limit)
            .map(|(item, _)| &item.id)
            .collect::<Vec<_>>()
    );
    assert_eq!(actual.response.considered, independent.len());
    assert_eq!(actual.response.considered, actual.work.eligible_candidates);
    assert!(actual.work.model_evaluations <= independent.len());
    assert_eq!(
        actual.work.model_evaluations_skipped,
        independent.len() - actual.work.model_evaluations
    );
    assert!(actual.work.peak_scored_entries <= 2 * request.limit);
    for (a, b) in actual.response.items.iter().zip(&expected.items) {
        assert_eq!(a.affinity.to_bits(), b.affinity.to_bits());
        assert_eq!(
            a.rank_score.map(f64::to_bits),
            b.rank_score.map(f64::to_bits)
        );
    }
    assert_eq!(
        serde_json::to_value(actual.response).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn varied_signs_domains_filters_tag_order_signed_zero_and_subnormals_match_full_sort() {
    for size in [3, 31, 600, 10_000] {
        for unique in [false, true] {
            for reverse in [false, true] {
                let mut catalog = catalog(size, unique);
                if reverse {
                    catalog.items.reverse();
                }
                let catalog = Arc::new(catalog);
                for seed in 0..10 {
                    let model = model(&catalog, seed);
                    for k in [1, 10, 50] {
                        let mut request = request(k);
                        if seed == 3 {
                            request.profile = None;
                        }
                        assert_exact(catalog.clone(), &model, &request);
                    }
                }
            }
        }
    }
}

#[test]
fn whole_group_bounds_reduce_model_evaluations_and_never_score_hidden_endpoints() {
    let mut catalog = catalog(3000, false);
    for (i, item) in catalog.items.iter_mut().enumerate() {
        item.domain = "video".into();
        item.tags = if i < 300 {
            vec!["a-best".into()]
        } else {
            vec!["b-low".into()]
        };
        item.prior = i as f32 / 3000.0;
    }
    let model = model(&catalog, 1);
    let catalog = Arc::new(catalog);
    let index = GroupedRecall::new(catalog.clone()).unwrap();
    let mut request = request(10);
    request.profile.as_mut().unwrap().blocked_ids = vec![
        "item-00000".into(),
        "item-00299".into(),
        "item-00300".into(),
        "item-02999".into(),
    ];
    let result = index.recommend_with_model(&request, 50, &model).unwrap();
    assert_eq!(result.work.groups_pruned, 1);
    assert_eq!(result.work.eligible_candidates, 2996);
    assert_eq!(result.work.model_evaluations, 300);
    assert_eq!(result.work.model_evaluations_skipped, 2696);
    assert_exact(catalog, &model, &request);
}

#[test]
fn rounded_score_plateaus_are_not_pruned_and_hidden_groups_or_empty_results_are_consistent() {
    let mut catalog = catalog(600, false);
    for item in &mut catalog.items {
        item.domain = "video".into();
        item.tags = if item.id.as_str() < "item-00300" {
            vec!["a-best".into()]
        } else {
            vec!["b-low".into()]
        };
        item.prior = if item.id.as_str() < "item-00300" {
            0.1
        } else {
            0.9
        };
    }
    let model = model(&catalog, 2);
    let catalog = Arc::new(catalog);
    let index = GroupedRecall::new(catalog.clone()).unwrap();
    let request = request(10);
    let result = index.recommend_with_model(&request, 50, &model).unwrap();
    assert!(result.response.items[0].id.as_str() >= "item-00300");
    assert_eq!(result.work.groups_pruned, 0);
    assert_exact(catalog.clone(), &model, &request);
    let mut request = request;
    request.profile.as_mut().unwrap().denied_tags = vec!["a-best".into(), "b-low".into()];
    let empty = index.recommend_with_model(&request, 50, &model).unwrap();
    assert_eq!(empty.work.model_evaluations, 0);
    assert_eq!(empty.response.considered, 0);
    assert!(matches!(
        index.recommend_with_model(&request, 100, &model),
        Err(DomainError::Expired)
    ));
    request.profile.as_mut().unwrap().scopes.pop();
    assert!(matches!(
        index.recommend_with_model(&request, 50, &model),
        Err(DomainError::ScopeDenied)
    ));
}
