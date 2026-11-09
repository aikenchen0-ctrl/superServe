use std::{cmp::Ordering, num::NonZeroUsize};

use serde::Serialize;

use crate::{
    DomainError,
    catalog::{Candidate, PublicCatalog},
    learning::LearnedRanker,
    recommendation::{
        RecommendationRequest, RecommendationResponse, RequestContext, learned_rank_order,
        ranked_item, validate_model_catalog,
    },
    upstream::buffered_top_k::BufferedTopK,
};

#[derive(Debug, Serialize)]
pub struct ModelTopKWork {
    pub candidates_examined: usize,
    pub candidates_scored: usize,
    pub peak_scored_entries: usize,
    pub scored_buffer_bytes: usize,
}

pub struct ModelTopKRecommendation {
    pub response: RecommendationResponse,
    pub work: ModelTopKWork,
}

#[derive(Clone, Copy)]
struct ScoredCandidate<'a> {
    candidate: &'a Candidate,
    affinity: f32,
    score: f64,
}

impl Ord for ScoredCandidate<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        // 选择器保留最大项；完整排序中的第一项在这里必须最大。
        learned_rank_order(other.candidate, other.score, self.candidate, self.score)
    }
}

impl PartialOrd for ScoredCandidate<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for ScoredCandidate<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for ScoredCandidate<'_> {}

pub(crate) struct ModelTopKAccumulator<'a> {
    top: BufferedTopK<ScoredCandidate<'a>>,
    pub(crate) peak_scored_entries: usize,
    pub(crate) scored_buffer_bytes: usize,
}

impl<'a> ModelTopKAccumulator<'a> {
    pub(crate) fn new(limit: usize) -> Result<Self, DomainError> {
        let limit = NonZeroUsize::new(limit).ok_or(DomainError::Invalid("model_top_k_limit"))?;
        let top = BufferedTopK::new(limit);
        let scored_buffer_bytes = std::mem::size_of_val(&top)
            + top.capacity() * std::mem::size_of::<ScoredCandidate<'_>>();
        Ok(Self {
            top,
            peak_scored_entries: 0,
            scored_buffer_bytes,
        })
    }

    pub(crate) fn push(&mut self, candidate: &'a Candidate, affinity: f32, score: f64) {
        let before = self.top.len();
        if self.top.push(ScoredCandidate {
            candidate,
            affinity,
            score,
        }) {
            self.peak_scored_entries = self.peak_scored_entries.max(before + 1);
        }
    }

    pub(crate) fn threshold_score(&self) -> Option<f64> {
        self.top.threshold().map(|entry| entry.score)
    }

    pub(crate) fn finish(
        self,
        catalog: &PublicCatalog,
        request: &RecommendationRequest,
        considered: usize,
    ) -> RecommendationResponse {
        let mut selected = self.top.into_vec();
        selected.sort_unstable_by(|a, b| {
            learned_rank_order(a.candidate, a.score, b.candidate, b.score)
        });
        let items = selected
            .into_iter()
            .map(|item| ranked_item(item.candidate, item.affinity, Some(item.score)))
            .collect();
        RecommendationResponse {
            request_id: request.request_id.clone(),
            catalog_version: catalog.version.clone(),
            profile_version: request
                .profile
                .as_ref()
                .map(|profile| profile.version.clone()),
            ranker: "ftrl-ranker-v1",
            considered,
            items,
        }
    }
}

/// 先执行全部授权过滤，再按当前模型完整评分；不借用旧分数的候选裁剪结论。
pub fn recommend_model_top_k(
    catalog: &PublicCatalog,
    request: &RecommendationRequest,
    now: u64,
    model: &LearnedRanker,
) -> Result<ModelTopKRecommendation, DomainError> {
    let context = RequestContext::new(request, now)?;
    validate_model_catalog(catalog, now, Some(model))?;
    let mut top = ModelTopKAccumulator::new(request.limit)?;
    let mut work = ModelTopKWork {
        candidates_examined: 0,
        candidates_scored: 0,
        peak_scored_entries: 0,
        // 只计本选择器及候选槽位，不含共享目录、画像表、输出和分配器元数据。
        scored_buffer_bytes: top.scored_buffer_bytes,
    };
    for item in &catalog.items {
        work.candidates_examined += 1;
        if !context.allows(item) {
            continue;
        }
        work.candidates_scored += 1;
        top.push(item, context.affinity(item), model.score(&context, item));
    }
    work.peak_scored_entries = top.peak_scored_entries;
    Ok(ModelTopKRecommendation {
        response: top.finish(catalog, request, work.candidates_scored),
        work,
    })
}
