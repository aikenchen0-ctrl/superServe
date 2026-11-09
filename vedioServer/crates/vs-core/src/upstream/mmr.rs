// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qdrant Solutions GmbH
// 改编自 qdrant/qdrant，提交 222b2e44ab1c3f17e8246396ead6558e45041df7，
// lib/shard/src/query/mmr/mod.rs 的 maximal_marginal_relevance。
// 改动：使用索引和回调，缓存到已选集合的最大相似度，同分保留原顺序。

pub(crate) struct Selection {
    pub indices: Vec<usize>,
    pub similarity_evaluations: usize,
}

pub(crate) fn select(
    relevance: &[f64],
    lambda: f64,
    limit: usize,
    mut similarity: impl FnMut(usize, usize) -> f64,
) -> Selection {
    let count = relevance.len();
    let limit = limit.min(count);
    let mut selected = Vec::with_capacity(limit);
    let mut used = vec![false; count];
    let mut max_similarity = vec![f64::NEG_INFINITY; count];
    let mut evaluations = 0;
    if limit == 0 {
        return Selection {
            indices: selected,
            similarity_evaluations: evaluations,
        };
    }
    // 首项只看相关性，不让多样性惩罚改变原排序的最优项。
    let first = (0..count)
        .max_by(|&a, &b| {
            relevance[a]
                .total_cmp(&relevance[b])
                .then_with(|| b.cmp(&a))
        })
        .unwrap();
    used[first] = true;
    selected.push(first);
    while selected.len() < limit {
        let last = *selected.last().unwrap();
        let mut best: Option<(usize, f64)> = None;
        for index in 0..count {
            if used[index] {
                continue;
            }
            // 每轮只加入最后选中项，避免矩阵和重复扫描整个已选集合。
            max_similarity[index] = max_similarity[index].max(similarity(index, last));
            evaluations += 1;
            let score = lambda * relevance[index] - (1.0 - lambda) * max_similarity[index];
            if best.is_none_or(|(_, previous)| score > previous) {
                best = Some((index, score));
            }
        }
        let (index, _) = best.unwrap();
        used[index] = true;
        selected.push(index);
    }
    Selection {
        indices: selected,
        similarity_evaluations: evaluations,
    }
}
