use serde::Serialize;

use crate::{
    DomainError,
    grouped_recall::GroupedRecall,
    learning::LearnedRanker,
    model_top_k::ModelTopKAccumulator,
    recommendation::{
        RecommendationRequest, RecommendationResponse, RequestContext, validate_model_catalog,
    },
};

#[derive(Default, Debug, Serialize)]
pub struct ModelPrunedWork {
    pub groups_examined: usize,
    pub groups_filtered: usize,
    pub groups_pruned: usize,
    pub blocks_examined: usize,
    pub blocks_pruned: usize,
    pub block_bound_evaluations: usize,
    pub groups_reversed: usize,
    pub candidate_id_checks: usize,
    pub eligible_candidates: usize,
    pub model_evaluations: usize,
    pub bound_evaluations: usize,
    pub model_evaluations_skipped: usize,
    pub peak_scored_entries: usize,
    pub scored_buffer_bytes: usize,
}

pub struct ModelPrunedRecommendation {
    pub response: RecommendationResponse,
    pub work: ModelPrunedWork,
}

impl GroupedRecall {
    /// 只剪掉分数上界严格落后于门槛的整组；同分与近分均沿用完整排序。
    pub fn recommend_with_model(
        &self,
        request: &RecommendationRequest,
        now: u64,
        model: &LearnedRanker,
    ) -> Result<ModelPrunedRecommendation, DomainError> {
        self.recommend_model_pruning(request, now, model, false)
    }

    /// 复用块上界与竞争门槛机制；64项一块，无新增常驻索引，等分块继续完整评分。
    pub fn recommend_with_model_blockmax(
        &self,
        request: &RecommendationRequest,
        now: u64,
        model: &LearnedRanker,
    ) -> Result<ModelPrunedRecommendation, DomainError> {
        self.recommend_model_pruning(request, now, model, true)
    }

    fn recommend_model_pruning(
        &self,
        request: &RecommendationRequest,
        now: u64,
        model: &LearnedRanker,
        blockmax: bool,
    ) -> Result<ModelPrunedRecommendation, DomainError> {
        let catalog = self.catalog();
        let context = RequestContext::new(request, now)?;
        validate_model_catalog(catalog, now, Some(model))?;
        let has_blocked = context.has_blocked_ids();
        let mut top = ModelTopKAccumulator::new(request.limit)?;
        let mut work = ModelPrunedWork::default();
        for indices in self.member_groups() {
            work.groups_examined += 1;
            let representative = &catalog.items[indices[0]];
            if !context.allows_features(representative) {
                work.groups_filtered += 1;
                continue;
            }
            // 只有隐藏ID不同；领域和有序标签由不可变索引保证相同。
            let (first, last, eligible) = if has_blocked {
                let mut first = None;
                let mut last = 0;
                let mut eligible = 0;
                for &index in indices {
                    work.candidate_id_checks += 1;
                    if context.allows_id(&catalog.items[index].id) {
                        first.get_or_insert(index);
                        last = index;
                        eligible += 1;
                    }
                }
                let Some(first) = first else { continue };
                (first, last, eligible)
            } else {
                (indices[0], indices[indices.len() - 1], indices.len())
            };
            work.eligible_candidates += eligible;
            let first_score = model.score(&context, &catalog.items[first]);
            let last_score = if first == last {
                first_score
            } else {
                model.score(&context, &catalog.items[last])
            };
            let bounds = 1 + usize::from(first != last);
            work.model_evaluations += bounds;
            work.bound_evaluations += bounds;
            // 当前六维线性模型中，同组仅先验变化。两端评分覆盖任意符号系数；
            // 浮点舍入保留单调性，零上界提升为正零以覆盖total_cmp的负零。
            let upper = first_score.max(last_score);
            let upper = if upper == 0.0 { 0.0 } else { upper };
            if top
                .threshold_score()
                .is_some_and(|threshold| upper.total_cmp(&threshold).is_lt())
            {
                work.groups_pruned += 1;
                continue;
            }
            let affinity = context.affinity(representative);
            if blockmax && indices.len() > 64 && first_score != last_score {
                let reverse = last_score > first_score;
                work.groups_reversed += usize::from(reverse);
                let chunks = indices.len().div_ceil(64);
                for offset in 0..chunks {
                    let chunk = if reverse { chunks - 1 - offset } else { offset };
                    let block = &indices[chunk * 64..((chunk + 1) * 64).min(indices.len())];
                    work.blocks_examined += 1;
                    let mut visible_endpoint = |reverse: bool| {
                        (0..block.len()).find_map(|position| {
                            let index = block[if reverse {
                                block.len() - 1 - position
                            } else {
                                position
                            }];
                            if has_blocked {
                                work.candidate_id_checks += 1;
                            }
                            (!has_blocked || context.allows_id(&catalog.items[index].id))
                                .then_some(index)
                        })
                    };
                    let Some(block_first) = visible_endpoint(false) else {
                        continue;
                    };
                    let block_last = visible_endpoint(true).expect("非空可见块");
                    let mut bound = |index: usize| {
                        if index == first {
                            first_score
                        } else if index == last {
                            last_score
                        } else {
                            work.model_evaluations += 1;
                            work.bound_evaluations += 1;
                            work.block_bound_evaluations += 1;
                            model.score(&context, &catalog.items[index])
                        }
                    };
                    let block_first_score = bound(block_first);
                    let block_last_score = if block_first == block_last {
                        block_first_score
                    } else {
                        bound(block_last)
                    };
                    let block_upper = block_first_score.max(block_last_score);
                    let block_upper = if block_upper == 0.0 { 0.0 } else { block_upper };
                    if top
                        .threshold_score()
                        .is_some_and(|threshold| block_upper.total_cmp(&threshold).is_lt())
                    {
                        work.blocks_pruned += 1;
                        continue;
                    }
                    for position in 0..block.len() {
                        let index = block[if reverse {
                            block.len() - 1 - position
                        } else {
                            position
                        }];
                        let item = &catalog.items[index];
                        if has_blocked {
                            work.candidate_id_checks += 1;
                            if !context.allows_id(&item.id) {
                                continue;
                            }
                        }
                        let score = if index == block_first {
                            block_first_score
                        } else if index == block_last {
                            block_last_score
                        } else if index == first {
                            first_score
                        } else if index == last {
                            last_score
                        } else {
                            work.model_evaluations += 1;
                            model.score(&context, item)
                        };
                        top.push(item, affinity, score);
                    }
                }
                continue;
            }
            for &index in indices {
                let item = &catalog.items[index];
                if has_blocked {
                    work.candidate_id_checks += 1;
                    if !context.allows_id(&item.id) {
                        continue;
                    }
                }
                let score = if index == first {
                    first_score
                } else if index == last {
                    last_score
                } else {
                    work.model_evaluations += 1;
                    model.score(&context, item)
                };
                top.push(item, affinity, score);
            }
        }
        work.model_evaluations_skipped = work.eligible_candidates - work.model_evaluations;
        work.peak_scored_entries = top.peak_scored_entries;
        work.scored_buffer_bytes = top.scored_buffer_bytes;
        Ok(ModelPrunedRecommendation {
            response: top.finish(catalog, request, work.eligible_candidates),
            work,
        })
    }
}
