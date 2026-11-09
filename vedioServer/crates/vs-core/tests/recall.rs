use vs_core::{
    catalog::{Candidate, PublicCatalog},
    recall::{CatalogRecall, PRIOR_RECALL_LIMIT, RecallScoring},
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RequestContext, recommend,
        recommend_subset,
    },
};

fn catalog() -> PublicCatalog {
    let mut items: Vec<_> = (0..200)
        .map(|index| Candidate {
            id: format!("item-{index:03}"),
            domain: if index < 100 { "video" } else { "article" }.into(),
            tags: vec![if index == 99 { "rust" } else { "general" }.into()],
            prior: 1.0 - index as f32 / 1000.0,
            media_sha256: None,
        })
        .collect();
    items[98].tags = vec!["denied".into()];
    PublicCatalog {
        version: "test-v1".into(),
        items,
        assets: vec![],
    }
}

fn request() -> RecommendationRequest {
    RecommendationRequest {
        request_id: "recall-test".into(),
        domains: vec!["video".into(), "article".into()],
        limit: 50,
        profile: Some(ProfileProjection {
            subject: "test-user".into(),
            version: "p1".into(),
            scopes: vec!["video".into(), "article".into()],
            expires_at: 100,
            interests: vec![Interest {
                tag: "rust".into(),
                weight: 1.0,
            }],
            blocked_ids: vec!["item-000".into()],
            denied_tags: vec!["denied".into()],
        }),
    }
}

#[test]
fn routes_preserve_domain_budget_long_tail_and_exclusions_before_ranking() {
    let catalog = catalog();
    let request = request();
    let context = RequestContext::new(&request, 50).unwrap();
    let index = CatalogRecall::new(&catalog);
    let prior = index.prior(&catalog, &context);
    assert_eq!(prior.len(), PRIOR_RECALL_LIMIT);
    assert_eq!(
        prior
            .iter()
            .filter(|i| catalog.items[**i].domain == "video")
            .count(),
        PRIOR_RECALL_LIMIT / 2
    );
    assert!(!prior.contains(&0));
    assert!(!prior.contains(&99));
    let selected = index.merge(
        &catalog,
        &context,
        prior,
        &[
            "item-099".into(),
            "item-099".into(),
            "item-098".into(),
            "item-000".into(),
            "not-published".into(),
        ],
    );
    assert_eq!(selected.len(), PRIOR_RECALL_LIMIT + 1);
    assert!(!selected.contains(&98));
    assert_eq!(
        recommend_subset(&catalog, &request, 50, &selected)
            .unwrap()
            .items[0]
            .id,
        "item-099"
    );
    let mut video = request.clone();
    video.domains = vec!["video".into()];
    let context = RequestContext::new(&video, 50).unwrap();
    assert!(
        index
            .merge(&catalog, &context, vec![], &["item-100".into()])
            .is_empty()
    );
}

#[test]
fn tag_dictionary_and_vectors_are_stable_under_catalog_permutation() {
    let catalog = catalog();
    let first = CatalogRecall::new(&catalog);
    let mut reversed = catalog.clone();
    reversed.items.reverse();
    let second = CatalogRecall::new(&reversed);
    let request = request();
    let context = RequestContext::new(&request, 50).unwrap();
    assert_eq!(first.query(&context), second.query(&context));
    assert_eq!(
        first.vector(&["rust".into(), "general".into()]),
        second.vector(&["general".into(), "rust".into()])
    );
    assert_eq!(first.query(&context).1, vec![1.0]);
    let mut negative = request.clone();
    negative.profile.as_mut().unwrap().interests[0].weight = -1.0;
    assert!(
        first
            .query(&RequestContext::new(&negative, 50).unwrap())
            .0
            .is_empty()
    );
    let signed = first.query_with_scoring(
        &RequestContext::new(&negative, 50).unwrap(),
        RecallScoring::Signed,
    );
    assert_eq!(signed.0.len(), 1);
    assert_eq!(signed.1, vec![-1.0]);
}

#[test]
fn full_subset_matches_baseline_and_invalid_or_expired_subset_is_rejected() {
    let catalog = catalog();
    let mut request = request();
    let all: Vec<_> = (0..catalog.items.len()).collect();
    let baseline = recommend(&catalog, &request, 50).unwrap();
    let recalled = recommend_subset(&catalog, &request, 50, &all).unwrap();
    assert_eq!(
        baseline
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        recalled
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>()
    );
    assert!(recommend_subset(&catalog, &request, 50, &[0, 0]).is_err());
    assert!(recommend_subset(&catalog, &request, 50, &[catalog.items.len()]).is_err());
    request.profile.as_mut().unwrap().expires_at = 50;
    assert!(RequestContext::new(&request, 50).is_err());
    assert!(recommend_subset(&catalog, &request, 50, &[]).is_err());
}

#[test]
fn signed_sparse_dot_product_matches_affinity_for_mixed_multitag_candidates() {
    let catalog = PublicCatalog {
        version: "signed-v1".into(),
        items: vec![
            Candidate {
                id: "mixed".into(),
                domain: "video".into(),
                tags: vec!["rust".into(), "noise".into()],
                prior: 0.9,
                media_sha256: None,
            },
            Candidate {
                id: "tail".into(),
                domain: "video".into(),
                tags: vec!["rust".into(), "quiet".into(), "focus".into()],
                prior: 0.1,
                media_sha256: None,
            },
        ],
        assets: vec![],
    };
    let mut request = request();
    request.profile.as_mut().unwrap().interests.extend([
        Interest {
            tag: "noise".into(),
            weight: -1.0,
        },
        Interest {
            tag: "quiet".into(),
            weight: 0.0,
        },
        Interest {
            tag: "missing".into(),
            weight: 0.5,
        },
    ]);
    let context = RequestContext::new(&request, 50).unwrap();
    let index = CatalogRecall::new(&catalog);
    let (dimensions, weights) = index.query_with_scoring(&context, RecallScoring::Signed);
    assert_eq!(dimensions.len(), 2);
    let ranked = recommend(&catalog, &request, 50).unwrap();
    assert_eq!(ranked.items[0].id, "tail");
    for candidate in &catalog.items {
        let (indices, values) = index.vector(&candidate.tags);
        let dot: f32 = indices
            .iter()
            .zip(&values)
            .map(|(dimension, value)| {
                dimensions
                    .binary_search(dimension)
                    .map_or(0.0, |i| weights[i] * value)
            })
            .sum();
        let affinity = ranked
            .items
            .iter()
            .find(|item| item.id == candidate.id)
            .unwrap()
            .affinity;
        assert!((dot - affinity).abs() < 1e-6);
    }
}

#[test]
fn nonpositive_prior_prefers_neutral_across_domains_and_keeps_policy_filters() {
    let mut items: Vec<_> = (0..160)
        .map(|i| Candidate {
            id: format!("negative-{i:03}"),
            domain: if i < 80 { "article" } else { "video" }.into(),
            tags: vec!["unwanted".into()],
            prior: 0.9,
            media_sha256: None,
        })
        .collect();
    items.extend((0..80).map(|i| Candidate {
        id: format!("neutral-{i:03}"),
        domain: "video".into(),
        tags: if i == 1 {
            vec!["denied".into()]
        } else {
            vec![]
        },
        prior: 0.1,
        media_sha256: None,
    }));
    let mut catalog = PublicCatalog {
        version: "neutral-v1".into(),
        items,
        assets: vec![],
    };
    let mut request = request();
    let profile = request.profile.as_mut().unwrap();
    profile.interests = vec![Interest {
        tag: "unwanted".into(),
        weight: -0.5,
    }];
    profile.blocked_ids = vec!["neutral-000".into()];
    let context = RequestContext::new(&request, 50).unwrap();
    let index = CatalogRecall::new(&catalog);
    let selected = index.prior_with_scoring(&catalog, &context, RecallScoring::Signed);
    assert!(selected.neutral_first);
    assert_eq!(selected.indices.len(), PRIOR_RECALL_LIMIT);
    assert!(selected.examined > PRIOR_RECALL_LIMIT);
    assert!(selected.examined <= catalog.items.len() * 2);
    assert!(
        selected
            .indices
            .iter()
            .all(|i| context.affinity(&catalog.items[*i]) == 0.0)
    );
    assert!(
        selected
            .indices
            .iter()
            .all(|i| context.allows(&catalog.items[*i]))
    );
    let ids: Vec<_> = selected
        .indices
        .iter()
        .map(|i| catalog.items[*i].id.clone())
        .collect();
    assert_eq!(ids[0], "neutral-002");
    assert!(
        index
            .prior(&catalog, &context)
            .iter()
            .all(|i| catalog.items[*i].id.starts_with("negative-"))
    );
    catalog.items.reverse();
    let reversed =
        CatalogRecall::new(&catalog).prior_with_scoring(&catalog, &context, RecallScoring::Signed);
    assert_eq!(
        ids,
        reversed
            .indices
            .iter()
            .map(|i| catalog.items[*i].id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn neutral_priority_fills_remaining_budget_with_negative_candidates() {
    let catalog = catalog();
    let index = CatalogRecall::new(&catalog);
    let mut request = request();
    request.profile.as_mut().unwrap().interests = vec![Interest {
        tag: "general".into(),
        weight: -1.0,
    }];
    let context = RequestContext::new(&request, 50).unwrap();
    let selected = index.prior_with_scoring(&catalog, &context, RecallScoring::Signed);
    assert!(selected.neutral_first);
    assert_eq!(selected.indices.len(), PRIOR_RECALL_LIMIT);
    assert_eq!(catalog.items[selected.indices[0]].id, "item-099");
    assert!(
        selected
            .indices
            .iter()
            .skip(1)
            .all(|i| context.affinity(&catalog.items[*i]) < 0.0)
    );
    assert!(selected.examined <= catalog.items.len() * 2);
    assert_eq!(
        selected
            .indices
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        selected.indices.len()
    );
}

#[test]
fn mixed_and_cold_profiles_keep_existing_prior_policy() {
    let catalog = catalog();
    let index = CatalogRecall::new(&catalog);
    for interests in [
        vec![],
        vec![Interest {
            tag: "general".into(),
            weight: 0.0,
        }],
        vec![
            Interest {
                tag: "rust".into(),
                weight: 1.0,
            },
            Interest {
                tag: "general".into(),
                weight: -0.5,
            },
        ],
    ] {
        let mut request = request();
        request.profile.as_mut().unwrap().interests = interests;
        let context = RequestContext::new(&request, 50).unwrap();
        let selected = index.prior_with_scoring(&catalog, &context, RecallScoring::Signed);
        assert!(!selected.neutral_first);
        assert_eq!(selected.indices, index.prior(&catalog, &context));
    }
}
