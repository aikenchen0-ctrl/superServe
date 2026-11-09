use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{DomainError, catalog::Candidate, upstream::mmr, valid_id};

pub const POLICY_SCHEMA: &str = "tag-rank-mmr-v1";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SlatePolicy {
    pub schema: String,
    pub candidates_limit: usize,
    pub relevance_milli: u16,
}

impl SlatePolicy {
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.schema != POLICY_SCHEMA
            || !(1..=50).contains(&self.candidates_limit)
            || self.relevance_milli > 1000
        {
            return Err(DomainError::Invalid("slate_policy"));
        }
        Ok(())
    }

    pub fn pool_limit(&self, limit: usize) -> Result<usize, DomainError> {
        self.validate()?;
        if !(1..=50).contains(&limit) {
            return Err(DomainError::Invalid("recommendation_request"));
        }
        Ok(if self.relevance_milli == 1000 {
            limit
        } else {
            limit.max(self.candidates_limit)
        })
    }
}

#[derive(Debug, Serialize)]
pub struct SlateSelection {
    pub indices: Vec<usize>,
    pub candidates: usize,
    pub similarity_evaluations: usize,
}

/// 输入顺序必须是现有评分器的完整确定性排序；不把异构模型分数当作已校准概率。
pub fn select(
    candidates: &[&Candidate],
    limit: usize,
    policy: &SlatePolicy,
) -> Result<SlateSelection, DomainError> {
    let capacity = policy.pool_limit(limit)?;
    if candidates.len() > capacity {
        return Err(DomainError::Invalid("slate_pool"));
    }
    let mut ids = HashSet::new();
    let mut tags = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if !valid_id(&candidate.id)
            || !ids.insert(candidate.id.as_str())
            || candidate.tags.len() > 32
            || candidate.tags.iter().any(|tag| !valid_id(tag))
        {
            return Err(DomainError::Invalid("slate_candidate"));
        }
        let mut sorted: Vec<_> = candidate.tags.iter().map(String::as_str).collect();
        sorted.sort_unstable();
        if sorted.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(DomainError::Invalid("slate_candidate"));
        }
        tags.push(sorted);
    }
    let count = candidates.len();
    let selection = if policy.relevance_milli == 1000 {
        mmr::Selection {
            indices: (0..limit.min(count)).collect(),
            similarity_evaluations: 0,
        }
    } else {
        // 只使用原排序位置；丢弃分差是明确代偿，须用留出标签另验效用。
        let denominator = count.saturating_sub(1).max(1) as f64;
        let relevance: Vec<_> = (0..count)
            .map(|index| 1.0 - index as f64 / denominator)
            .collect();
        mmr::select(
            &relevance,
            f64::from(policy.relevance_milli) / 1000.0,
            limit,
            |a, b| tag_similarity(&tags[a], &tags[b]),
        )
    };
    Ok(SlateSelection {
        indices: selection.indices,
        candidates: count,
        similarity_evaluations: selection.similarity_evaluations,
    })
}

fn tag_similarity(a: &[&str], b: &[&str]) -> f64 {
    if a.is_empty() || b.is_empty() {
        // 缺失标签不等于新颖内容，按最大冗余处理，避免奖励元数据缺失。
        return 1.0;
    }
    let (mut left, mut right, mut intersection) = (0, 0, 0);
    while left < a.len() && right < b.len() {
        match a[left].cmp(b[right]) {
            std::cmp::Ordering::Less => left += 1,
            std::cmp::Ordering::Greater => right += 1,
            std::cmp::Ordering::Equal => {
                intersection += 1;
                left += 1;
                right += 1;
            }
        }
    }
    intersection as f64 / ((a.len() * b.len()) as f64).sqrt()
}
