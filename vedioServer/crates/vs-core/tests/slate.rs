use std::collections::HashSet;

use vs_core::{
    catalog::Candidate,
    slate::{POLICY_SCHEMA, SlatePolicy, select},
};

fn policy(weight: u16) -> SlatePolicy {
    SlatePolicy {
        schema: POLICY_SCHEMA.into(),
        candidates_limit: 50,
        relevance_milli: weight,
    }
}

fn candidate(id: usize, tags: &[&str]) -> Candidate {
    Candidate {
        id: format!("item-{id}"),
        domain: ["video", "article", "service"][id % 3].into(),
        tags: tags.iter().map(|tag| (*tag).into()).collect(),
        prior: 0.5,
        media_sha256: None,
    }
}

#[test]
fn repeated_topics_are_separated_without_changing_the_first_item() {
    let items = [
        candidate(0, &["rust"]),
        candidate(1, &["rust"]),
        candidate(2, &["rust"]),
        candidate(3, &["storage"]),
        candidate(4, &["design"]),
    ];
    let result = select(&items.iter().collect::<Vec<_>>(), 3, &policy(300)).unwrap();
    assert_eq!(result.indices, [0, 3, 4]);
    assert_eq!(result.candidates, 5);
    assert_eq!(result.similarity_evaluations, 7);
}

#[test]
fn diversity_can_reduce_recall_and_is_not_a_quality_improvement_proof() {
    use vs_core::replay::{Judgment, ranking_metrics};

    let items = [
        candidate(0, &["rust"]),
        candidate(1, &["rust"]),
        candidate(2, &["rust"]),
        candidate(3, &["storage"]),
        candidate(4, &["design"]),
    ];
    let labels: Vec<_> = (0..3)
        .map(|index| Judgment {
            candidate_id: items[index].id.clone(),
            relevance: 1,
            observed_at: 10,
        })
        .collect();
    let baseline = ranking_metrics(&["item-0", "item-1", "item-2"], &labels, 3).unwrap();
    let selected = select(&items.iter().collect::<Vec<_>>(), 3, &policy(300)).unwrap();
    let ids: Vec<_> = selected
        .indices
        .iter()
        .map(|&index| items[index].id.as_str())
        .collect();
    let diversified = ranking_metrics(&ids, &labels, 3).unwrap();
    assert!(diversified.recall_at_k < baseline.recall_at_k);
}

#[test]
fn relevance_only_is_exact_and_does_not_compute_similarity() {
    let items = [candidate(0, &["rust"]), candidate(1, &["rust"])];
    let result = select(&items.iter().collect::<Vec<_>>(), 2, &policy(1000)).unwrap();
    assert_eq!(result.indices, [0, 1]);
    assert_eq!(result.similarity_evaluations, 0);
    assert_eq!(policy(1000).pool_limit(2).unwrap(), 2);
}

#[test]
fn missing_tags_are_not_rewarded_as_novel_content_and_ties_keep_original_order() {
    let items = [
        candidate(0, &["rust"]),
        candidate(1, &[]),
        candidate(2, &["design"]),
        candidate(3, &["rust"]),
    ];
    let result = select(&items.iter().collect::<Vec<_>>(), 4, &policy(0)).unwrap();
    assert_eq!(result.indices, [0, 2, 1, 3]);
    let unknown = [candidate(0, &[]), candidate(1, &[]), candidate(2, &[])];
    assert_eq!(
        select(&unknown.iter().collect::<Vec<_>>(), 3, &policy(0))
            .unwrap()
            .indices,
        [0, 1, 2]
    );
}

#[test]
fn policy_pool_and_malformed_candidates_fail_closed() {
    for invalid in [
        SlatePolicy {
            schema: "future".into(),
            ..policy(500)
        },
        SlatePolicy {
            candidates_limit: 0,
            ..policy(500)
        },
        SlatePolicy {
            candidates_limit: 51,
            ..policy(500)
        },
        policy(1001),
    ] {
        assert!(select(&[], 1, &invalid).is_err());
    }
    assert!(select(&[], 0, &policy(500)).is_err());
    assert!(select(&[], 51, &policy(500)).is_err());
    let too_many: Vec<_> = (0..51).map(|id| candidate(id, &["tag"])).collect();
    assert!(select(&too_many.iter().collect::<Vec<_>>(), 2, &policy(500)).is_err());
    let repeated_id = [candidate(0, &["a"]), candidate(0, &["b"])];
    assert!(select(&repeated_id.iter().collect::<Vec<_>>(), 2, &policy(500)).is_err());
    let repeated_tags = [candidate(0, &["a", "a"])];
    assert!(select(&[&repeated_tags[0]], 1, &policy(500)).is_err());
    assert!(serde_json::from_str::<SlatePolicy>(
        r#"{"schema":"tag-rank-mmr-v1","candidates_limit":3,"relevance_milli":300,"extra":true}"#
    ).is_err());
}

#[test]
fn empty_singleton_full_pool_and_requested_limit_above_pool_are_bounded() {
    assert!(select(&[], 1, &policy(0)).unwrap().indices.is_empty());
    let one = candidate(0, &["a"]);
    assert_eq!(select(&[&one], 50, &policy(500)).unwrap().indices, [0]);
    let items: Vec<_> = (0..50).map(|id| candidate(id, &["a"])).collect();
    let result = select(&items.iter().collect::<Vec<_>>(), 50, &policy(500)).unwrap();
    assert_eq!(result.indices, (0..50).collect::<Vec<_>>());
    assert_eq!(result.similarity_evaluations, 1225);
    let mut narrow = policy(500);
    narrow.candidates_limit = 2;
    assert_eq!(narrow.pool_limit(50).unwrap(), 50);
}

fn oracle(items: &[Candidate], limit: usize, weight: u16) -> Vec<usize> {
    let mut result = vec![0];
    let lambda = f64::from(weight) / 1000.0;
    while result.len() < limit.min(items.len()) {
        let score = |index: usize| {
            let relevance = 1.0 - index as f64 / items.len().saturating_sub(1).max(1) as f64;
            let a: HashSet<_> = items[index].tags.iter().collect();
            let redundancy = result
                .iter()
                .map(|&selected| {
                    let b: HashSet<_> = items[selected].tags.iter().collect();
                    if a.is_empty() || b.is_empty() {
                        1.0
                    } else {
                        a.intersection(&b).count() as f64 / ((a.len() * b.len()) as f64).sqrt()
                    }
                })
                .fold(f64::NEG_INFINITY, f64::max);
            lambda * relevance - (1.0 - lambda) * redundancy
        };
        let index = (0..items.len())
            .filter(|index| !result.contains(index))
            .max_by(|&a, &b| score(a).total_cmp(&score(b)).then_with(|| b.cmp(&a)))
            .unwrap();
        result.push(index);
    }
    result
}

#[test]
fn incremental_reuse_matches_independent_full_recomputation_across_dimensions() {
    let vocabulary = ["a", "b", "c", "d", "e"];
    for seed in 0..12 {
        for count in [2, 5, 17, 50] {
            let items: Vec<_> = (0..count)
                .map(|id| {
                    let tags: Vec<_> = vocabulary
                        .iter()
                        .enumerate()
                        .filter(|(tag, _)| (id * 7 + tag * 3 + seed) % 5 < (id + seed) % 4)
                        .map(|(_, tag)| *tag)
                        .collect();
                    candidate(id, &tags)
                })
                .collect();
            for weight in [0, 100, 500, 900, 999] {
                for limit in [1, count / 2, count] {
                    let expected = oracle(&items, limit, weight);
                    let result =
                        select(&items.iter().collect::<Vec<_>>(), limit, &policy(weight)).unwrap();
                    assert_eq!(
                        result.indices, expected,
                        "种子{seed}，候选{count}，权重{weight}，条数{limit}"
                    );
                    assert_eq!(
                        result.indices.iter().copied().collect::<HashSet<_>>().len(),
                        result.indices.len()
                    );
                    assert!(result.similarity_evaluations <= count * limit);
                    let mut reordered = items.clone();
                    for item in &mut reordered {
                        item.tags.reverse();
                    }
                    assert_eq!(
                        select(
                            &reordered.iter().collect::<Vec<_>>(),
                            limit,
                            &policy(weight)
                        )
                        .unwrap()
                        .indices,
                        expected
                    );
                }
            }
        }
    }
}
