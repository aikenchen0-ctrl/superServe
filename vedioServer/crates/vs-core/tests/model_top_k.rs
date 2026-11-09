use std::sync::Arc;

use vs_core::{
    DomainError,
    catalog::{Candidate, MAX_ITEMS, PublicCatalog},
    grouped_recall::GroupedRecall,
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    model_top_k::recommend_model_top_k,
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RequestContext,
        recommend_subset_with_model, recommend_with_model,
    },
};

fn catalog(size: usize) -> PublicCatalog {
    PublicCatalog {
        version: "model-topk-v1".into(),
        items: (0..size)
            .map(|index| Candidate {
                id: format!("item-{index:05}"),
                domain: ["video", "article", "service"][index % 3].into(),
                tags: match index % 7 {
                    0 => vec![],
                    1 => vec!["a".into()],
                    2 => vec!["b".into()],
                    3 => vec!["a".into(), "b".into()],
                    4 => vec!["b".into(), "a".into()],
                    5 => vec!["denied".into()],
                    _ => vec![format!("unseen-{index}")],
                },
                prior: (index % 101) as f32 / 100.0,
                media_sha256: None,
            })
            .collect(),
        assets: vec![],
    }
}

fn request(k: usize) -> RecommendationRequest {
    RecommendationRequest {
        request_id: "test-request".into(),
        domains: vec!["video".into(), "article".into(), "service".into()],
        limit: k,
        profile: Some(ProfileProjection {
            subject: "subject".into(),
            version: "p1".into(),
            scopes: vec!["video".into(), "article".into(), "service".into()],
            expires_at: 100,
            interests: vec![
                Interest {
                    tag: "a".into(),
                    weight: 0.8,
                },
                Interest {
                    tag: "b".into(),
                    weight: -0.7,
                },
            ],
            blocked_ids: vec!["item-00000".into(), "item-00001".into()],
            denied_tags: vec!["denied".into()],
        }),
    }
}

fn model(catalog: &PublicCatalog, case: usize) -> LearnedRanker {
    let mut weights = vec![0.0; 24];
    match case {
        0 => weights[1] = -5.0,
        1 => {
            weights[1] = 4.0;
            weights[2] = -8.0;
            weights[3] = 7.0;
        }
        2 => {
            weights[..6].copy_from_slice(&[0.5, 2.0, 4.0, -3.0, 0.1, 0.2]);
            weights[7] = -6.0;
            weights[13] = 3.0;
            weights[19] = -2.0;
        }
        3 => {
            weights[0] = 100.0;
            weights[1] = f64::EPSILON;
        }
        _ => {}
    }
    let domains = if catalog.items.is_empty() {
        vec![]
    } else {
        vec!["article".into(), "service".into(), "video".into()]
    };
    // 空目录不能训练；空结果测试用有目录而请求无对应领域的情况。
    LearnedRanker::new(
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
            domains,
            weights,
        },
        catalog,
    )
    .unwrap()
}

#[test]
fn old_affinity_prefix_misses_negative_prior_model_and_exact_selection_keeps_it() {
    let mut catalog = catalog(600);
    for (index, item) in catalog.items.iter_mut().enumerate() {
        item.domain = "video".into();
        item.tags = vec!["a".into()];
        item.prior = index as f32 / 600.0;
    }
    let mut document = LinearRankModel {
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
        weights: vec![0.0; 12],
    };
    document.weights[1] = -5.0;
    let model = LearnedRanker::new(&document, &catalog).unwrap();
    let catalog = Arc::new(catalog);
    let request = request(10);
    let context = RequestContext::new(&request, 50).unwrap();
    let old = GroupedRecall::new(catalog.clone())
        .unwrap()
        .select(&context);
    let old_result =
        recommend_subset_with_model(&catalog, &request, 50, &old.indices, Some(&model)).unwrap();
    let full = recommend_with_model(&catalog, &request, 50, Some(&model)).unwrap();
    assert_eq!(full.items[0].id, "item-00002");
    assert!(
        full.items
            .iter()
            .all(|item| !old_result.items.iter().any(|old| old.id == item.id))
    );
    let exact = recommend_model_top_k(&catalog, &request, 50, &model).unwrap();
    assert_eq!(
        serde_json::to_value(exact.response).unwrap(),
        serde_json::to_value(full).unwrap()
    );
}

#[test]
fn varied_scores_filters_orders_and_limits_match_full_sort_and_independent_total_order() {
    for size in [3, 31, 128, 513, MAX_ITEMS] {
        for reverse in [false, true] {
            let mut catalog = catalog(size);
            if reverse {
                catalog.items.reverse();
            }
            for case in 0..5 {
                let model = model(&catalog, case);
                for k in [1, 10, 50] {
                    let mut request = request(k);
                    if case == 4 {
                        request.profile = None;
                    }
                    let context = RequestContext::new(&request, 50).unwrap();
                    let mut expected: Vec<_> = catalog
                        .items
                        .iter()
                        .filter(|item| context.allows(item))
                        .map(|item| (item, model.score(&context, item)))
                        .collect();
                    expected.sort_unstable_by(|(a, sa), (b, sb)| {
                        sb.total_cmp(sa)
                            .then_with(|| b.prior.total_cmp(&a.prior))
                            .then_with(|| a.id.cmp(&b.id))
                    });
                    let exact = recommend_model_top_k(&catalog, &request, 50, &model).unwrap();
                    let full = recommend_with_model(&catalog, &request, 50, Some(&model)).unwrap();
                    assert_eq!(
                        exact
                            .response
                            .items
                            .iter()
                            .map(|item| item.id.as_str())
                            .collect::<Vec<_>>(),
                        expected
                            .iter()
                            .take(k)
                            .map(|(item, _)| item.id.as_str())
                            .collect::<Vec<_>>()
                    );
                    assert_eq!(
                        serde_json::to_value(exact.response).unwrap(),
                        serde_json::to_value(full).unwrap()
                    );
                    assert!(exact.work.peak_scored_entries <= k * 2);
                    assert_eq!(exact.work.candidates_examined, size);
                    assert_eq!(exact.work.candidates_scored, expected.len());
                    assert!(exact.work.scored_buffer_bytes <= 10_000);
                }
            }
        }
    }
}

#[test]
fn invalid_profile_clock_model_binding_and_empty_eligible_set_fail_or_return_empty_consistently() {
    let catalog = catalog(30);
    let model = model(&catalog, 0);
    let mut request = request(10);
    assert!(matches!(
        recommend_model_top_k(&catalog, &request, 100, &model),
        Err(DomainError::Expired)
    ));
    request.profile.as_mut().unwrap().scopes.pop();
    assert!(matches!(
        recommend_model_top_k(&catalog, &request, 50, &model),
        Err(DomainError::ScopeDenied)
    ));
    request.profile = None;
    request.domains = vec!["absent".into()];
    let empty = recommend_model_top_k(&catalog, &request, 50, &model).unwrap();
    assert!(empty.response.items.is_empty());
    assert_eq!(empty.response.considered, 0);
    assert_eq!(empty.work.candidates_scored, 0);
    request.limit = 0;
    assert!(recommend_model_top_k(&catalog, &request, 50, &model).is_err());
    request.limit = 10;
    let mut other = catalog.clone();
    other.version = "other".into();
    assert!(recommend_model_top_k(&other, &request, 50, &model).is_err());
    assert!(recommend_model_top_k(&catalog, &request, 0, &model).is_err());
}
