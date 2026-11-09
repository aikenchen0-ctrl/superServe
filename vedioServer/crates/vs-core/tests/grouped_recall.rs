use std::sync::Arc;

use vs_core::{
    catalog::{Candidate, MAX_ITEMS, PublicCatalog},
    grouped_recall::{GroupHeadStrategy, GroupedRecall},
    recall::PERSONALIZED_RECALL_LIMIT,
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RequestContext, recommend,
        recommend_subset,
    },
};

fn request(interests: &[(&str, f32)]) -> RecommendationRequest {
    RecommendationRequest {
        request_id: "grouped-test".into(),
        domains: vec!["video".into(), "article".into(), "service".into()],
        limit: 50,
        profile: Some(ProfileProjection {
            subject: "grouped-user".into(),
            version: "p1".into(),
            scopes: vec!["video".into(), "article".into(), "service".into()],
            expires_at: 100,
            interests: interests
                .iter()
                .map(|(tag, weight)| Interest {
                    tag: (*tag).into(),
                    weight: *weight,
                })
                .collect(),
            blocked_ids: vec![],
            denied_tags: vec![],
        }),
    }
}

fn assert_equal(catalog: Arc<PublicCatalog>, request: &RecommendationRequest) {
    let index = GroupedRecall::new(catalog.clone()).unwrap();
    let context = RequestContext::new(request, 50).unwrap();
    let full = recommend(&catalog, request, 50).unwrap();
    // 全量排序独立核对完整召回前缀，覆盖最终响应上限以外的候选。
    let mut expected: Vec<_> = catalog
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| context.allows(item))
        .map(|(index, item)| (index, item, context.affinity(item)))
        .collect();
    expected.sort_unstable_by(|(_, a, sa), (_, b, sb)| {
        sb.total_cmp(sa)
            .then_with(|| b.prior.total_cmp(&a.prior))
            .then_with(|| a.id.cmp(&b.id))
    });
    let expected: Vec<_> = expected
        .iter()
        .take(PERSONALIZED_RECALL_LIMIT)
        .map(|(index, _, _)| *index)
        .collect();
    assert_eq!(
        index.select(&context).indices,
        index
            .select_with_strategy(&context, GroupHeadStrategy::All)
            .indices
    );
    for strategy in [
        GroupHeadStrategy::All,
        GroupHeadStrategy::Heap,
        GroupHeadStrategy::Buffered,
    ] {
        let selected = index.select_with_strategy(&context, strategy);
        assert_eq!(selected.indices, expected, "完整前缀策略：{strategy:?}");
        assert!(selected.indices.len() <= PERSONALIZED_RECALL_LIMIT);
        assert!(selected.candidates_examined <= catalog.items.len());
        if strategy != GroupHeadStrategy::All {
            assert!(selected.peak_heads <= PERSONALIZED_RECALL_LIMIT * 2);
        }
        let partial = recommend_subset(&catalog, request, 50, &selected.indices).unwrap();
        assert_eq!(
            full.items
                .iter()
                .map(|item| (&item.id, item.affinity.to_bits()))
                .collect::<Vec<_>>(),
            partial
                .items
                .iter()
                .map(|item| (&item.id, item.affinity.to_bits()))
                .collect::<Vec<_>>(),
            "策略：{strategy:?}"
        );
    }
}

#[test]
fn large_tie_group_preserves_prior_and_id_with_blocked_heads() {
    let catalog = Arc::new(PublicCatalog {
        version: "ties-v1".into(),
        items: (0..600)
            .map(|i| Candidate {
                id: format!("item-{i:03}"),
                domain: "video".into(),
                tags: vec!["shared".into()],
                prior: if i < 300 { 0.1 } else { 0.9 },
                media_sha256: None,
            })
            .collect(),
        assets: vec![],
    });
    let mut request = request(&[("shared", 1.0)]);
    request.profile.as_mut().unwrap().blocked_ids =
        (300..330).map(|i| format!("item-{i:03}")).collect();
    let index = GroupedRecall::new(catalog.clone()).unwrap();
    let selected = index.select(&RequestContext::new(&request, 50).unwrap());
    assert_eq!(index.group_count(), 1);
    assert_eq!(selected.groups_scored, 1);
    assert_eq!(catalog.items[selected.indices[0]].id, "item-330");
    assert_eq!(selected.candidates_examined, PERSONALIZED_RECALL_LIMIT + 30);
    assert_equal(catalog, &request);
}

#[test]
fn mixed_neutral_and_negative_results_match_full_ranking_across_domains() {
    let mut items: Vec<_> = (0..400)
        .map(|i| Candidate {
            id: format!("item-{i:03}"),
            domain: ["video", "article", "service"][i % 3].into(),
            tags: match i % 5 {
                0 => vec![],
                1 => vec!["favored".into(), "disliked".into()],
                2 => vec!["disliked".into()],
                3 => vec!["denied".into()],
                _ => vec!["unknown".into()],
            },
            prior: (i % 97) as f32 / 100.0,
            media_sha256: None,
        })
        .collect();
    items.reverse();
    let catalog = Arc::new(PublicCatalog {
        version: "mixed-v1".into(),
        items,
        assets: vec![],
    });
    for interests in [
        vec![],
        vec![("disliked", -1.0)],
        vec![("favored", 1.0), ("disliked", -0.7)],
        vec![("favored", -0.0), ("unknown", 0.0)],
    ] {
        let mut request = request(&interests);
        request.profile.as_mut().unwrap().blocked_ids = vec!["item-005".into(), "item-004".into()];
        request.profile.as_mut().unwrap().denied_tags = vec!["denied".into()];
        assert_equal(catalog.clone(), &request);
    }
}

#[test]
fn tag_order_and_unique_feature_groups_do_not_change_float_ranking() {
    let mut catalog = PublicCatalog {
        version: "near-ties-v1".into(),
        items: (0..300)
            .map(|i| Candidate {
                id: format!("item-{i:03}"),
                domain: "article".into(),
                tags: if i % 2 == 0 {
                    vec![
                        "positive".into(),
                        "negative".into(),
                        "tiny".into(),
                        format!("tag-{i}"),
                    ]
                } else {
                    vec![
                        "positive".into(),
                        "tiny".into(),
                        "negative".into(),
                        format!("tag-{i}"),
                    ]
                },
                prior: 1.0 - i as f32 / 1000.0,
                media_sha256: None,
            })
            .collect(),
        assets: vec![],
    };
    catalog.items.extend([
        Candidate {
            id: "ordered-high".into(),
            domain: "article".into(),
            tags: vec!["positive".into(), "negative".into(), "tiny".into()],
            prior: 0.0,
            media_sha256: None,
        },
        Candidate {
            id: "ordered-low".into(),
            domain: "article".into(),
            tags: vec!["positive".into(), "tiny".into(), "negative".into()],
            prior: 1.0,
            media_sha256: None,
        },
    ]);
    let catalog = Arc::new(catalog);
    let request = request(&[("positive", 1.0), ("negative", -1.0), ("tiny", 1e-8)]);
    assert_eq!(
        recommend(&catalog, &request, 50).unwrap().items[0].id,
        "ordered-high"
    );
    assert_eq!(
        GroupedRecall::new(catalog.clone()).unwrap().group_count(),
        302
    );
    assert_equal(catalog, &request);
}

#[test]
fn empty_and_denied_groups_produce_no_results_and_invalid_catalog_is_rejected() {
    let mut catalog = PublicCatalog {
        version: "empty-v1".into(),
        items: vec![],
        assets: vec![],
    };
    let empty = GroupedRecall::new(Arc::new(catalog.clone())).unwrap();
    let layout = empty.allocation_layout();
    assert_eq!(layout.groups, 0);
    assert_eq!(layout.members, 0);
    assert_eq!(layout.member_slots_bytes, 0);
    assert_eq!(layout.retained_buffers, 1);
    assert_equal(Arc::new(catalog.clone()), &request(&[]));
    catalog.items.push(Candidate {
        id: "denied".into(),
        domain: "video".into(),
        tags: vec!["denied".into()],
        prior: 0.9,
        media_sha256: None,
    });
    let mut request = request(&[]);
    request.profile.as_mut().unwrap().denied_tags = vec!["denied".into()];
    assert_equal(Arc::new(catalog.clone()), &request);
    catalog.items.push(catalog.items[0].clone());
    assert!(GroupedRecall::new(Arc::new(catalog)).is_err());
}

#[test]
fn packed_members_preserve_full_prefix_at_the_catalog_limit() {
    for groups in [1, 101, MAX_ITEMS] {
        let catalog = Arc::new(PublicCatalog {
            version: "packed-limit-v1".into(),
            items: (0..MAX_ITEMS)
                .map(|i| Candidate {
                    id: format!("entry-{:05}", MAX_ITEMS - i - 1),
                    domain: "video".into(),
                    tags: vec![format!("group-{}", i % groups)],
                    prior: ((i * 17) % 1001) as f32 / 1000.0,
                    media_sha256: None,
                })
                .collect(),
            assets: vec![],
        });
        let index = GroupedRecall::new(catalog.clone()).unwrap();
        let layout = index.allocation_layout();
        assert_eq!(layout.groups, groups);
        assert_eq!(layout.members, MAX_ITEMS);
        assert_eq!(layout.retained_buffers, 2);
        assert_eq!(
            layout.member_slots_bytes,
            MAX_ITEMS * std::mem::size_of::<usize>()
        );
        let mut request = request(&[("group-0", 1.0), ("group-1", -1.0)]);
        request.domains = vec!["video".into()];
        let profile = request.profile.as_mut().unwrap();
        profile.blocked_ids = (0..256).map(|i| format!("entry-{i:05}")).collect();
        profile.denied_tags = vec!["group-100".into()];
        assert_equal(catalog, &request);
    }
}

#[test]
fn hidden_group_and_feature_denials_do_not_cross_packed_boundaries() {
    let catalog = Arc::new(PublicCatalog {
        version: "packed-filters-v1".into(),
        items: (0..600)
            .map(|i| Candidate {
                id: format!("entry-{i:03}"),
                domain: if i % 3 == 2 { "article" } else { "video" }.into(),
                tags: vec![
                    "shared".into(),
                    if i % 3 == 1 { "denied" } else { "allowed" }.into(),
                ],
                prior: (i % 100) as f32 / 100.0,
                media_sha256: None,
            })
            .collect(),
        assets: vec![],
    });
    let index = GroupedRecall::new(catalog.clone()).unwrap();
    let mut request = request(&[("shared", 1.0)]);
    request.domains = vec!["video".into()];
    let profile = request.profile.as_mut().unwrap();
    profile.blocked_ids = (0..600)
        .step_by(3)
        .map(|i| format!("entry-{i:03}"))
        .collect();
    profile.denied_tags = vec!["denied".into()];
    let selected = index.select(&RequestContext::new(&request, 50).unwrap());
    assert!(selected.indices.is_empty());
    assert_eq!(selected.groups_scored, 0);
    assert_equal(catalog.clone(), &request);

    request.profile.as_mut().unwrap().blocked_ids.pop();
    let selected = index.select(&RequestContext::new(&request, 50).unwrap());
    assert_eq!(selected.indices.len(), 1);
    assert_eq!(catalog.items[selected.indices[0]].id, "entry-597");
    assert_equal(catalog, &request);
}

#[test]
fn varied_catalog_sizes_filters_and_k_match_the_independent_full_scan() {
    for size in [1, 65, 129, 513] {
        let mut catalog = PublicCatalog {
            version: "matrix-v1".into(),
            items: (0..size)
                .map(|i| Candidate {
                    id: format!("entry-{i:04}"),
                    domain: ["video", "article", "service"][i % 3].into(),
                    tags: match i % 7 {
                        0 => vec![],
                        1 => vec!["plus".into()],
                        2 => vec!["minus".into(), "tiny".into()],
                        3 => vec!["plus".into(), "minus".into()],
                        4 => vec!["tiny".into(), "minus".into(), "plus".into()],
                        5 => vec![format!("unique-{i}")],
                        _ => vec!["excluded".into()],
                    },
                    prior: ((i * 37) % 101) as f32 / 101.0,
                    media_sha256: None,
                })
                .collect(),
            assets: vec![],
        };
        for reverse in [false, true] {
            if reverse {
                catalog.items.reverse();
            }
            let catalog = Arc::new(catalog.clone());
            for interests in [
                vec![],
                vec![("minus", -1.0)],
                vec![("plus", 1.0), ("minus", -1.0), ("tiny", 1e-8)],
            ] {
                for limit in [1, 7, 50] {
                    let mut request = request(&interests);
                    request.limit = limit;
                    request.domains = if limit == 7 {
                        vec!["article".into()]
                    } else {
                        vec!["video".into(), "service".into()]
                    };
                    let profile = request.profile.as_mut().unwrap();
                    profile.blocked_ids =
                        (0..size.min(30)).map(|i| format!("entry-{i:04}")).collect();
                    profile.denied_tags = vec!["excluded".into()];
                    assert_equal(catalog.clone(), &request);
                }
            }
        }
    }
}

#[test]
fn pruned_group_heads_preserve_the_entire_128_candidate_prefix() {
    let catalog = Arc::new(PublicCatalog {
        version: "pruned-heads-v1".into(),
        items: (0..2000)
            .map(|i| Candidate {
                id: format!("entry-{i:04}"),
                domain: "article".into(),
                tags: vec!["shared".into(), format!("group-{}", i % 500)],
                prior: if i < 500 { 0.1 } else { 0.9 },
                media_sha256: None,
            })
            .collect(),
        assets: vec![],
    });
    let mut request = request(&[("shared", 1.0)]);
    request.profile.as_mut().unwrap().blocked_ids =
        (500..580).map(|i| format!("entry-{i:04}")).collect();
    let context = RequestContext::new(&request, 50).unwrap();
    let index = GroupedRecall::new(catalog).unwrap();
    let all = index.select_with_strategy(&context, GroupHeadStrategy::All);
    let selected_default = index.select(&context);
    assert_eq!(selected_default.indices, all.indices);
    assert!(selected_default.peak_heads <= 256);
    assert!(selected_default.head_buffer_bytes < all.head_buffer_bytes);
    for strategy in [GroupHeadStrategy::Heap, GroupHeadStrategy::Buffered] {
        let selected = index.select_with_strategy(&context, strategy);
        assert_eq!(selected.indices, all.indices);
        assert_eq!(selected.groups_scored, all.groups_scored);
        assert!(selected.peak_heads <= 256);
        assert!(selected.head_buffer_bytes < all.head_buffer_bytes);
    }
}
