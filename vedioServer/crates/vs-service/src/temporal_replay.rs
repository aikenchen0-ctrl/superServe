// SPDX-License-Identifier: MIT
// 复用固定Recommenders的命中分母与逐查询汇总机制，原指标和领域审计仍由既有Rust实现执行。
// Copyright (c) 2018-present Microsoft Corporation.
// Copyright (c) 2023-present Recommenders contributors.
use std::{
    collections::BTreeMap,
    io::{self, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::PublicCatalog,
    learning::{
        LinearRankModel, PreferenceFeedback, RankTrainingSet, TrainingSample, train_rank_model,
    },
    recommendation::{RequestContext, recommend_with_model},
    replay::{Judgment, RankingMetrics, ranking_metrics},
    training_split::{TemporalSplitConfig, temporal_split},
};

use crate::{
    domain_audit::{DomainAudit, DomainAuditConfig},
    learning_evidence::{PinnedEvidenceFile, read_pinned},
    rank_model::{MAX_RANK_MODEL_BYTES, MAX_TRAINING_BYTES, validate_rank_model},
    upstream::atomic_create::atomic_create,
};

const MAX_QUERIES: usize = 1000;
const MAX_CATALOG_PASSES: usize = 50_000_000;
const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldoutWindow {
    Validation,
    Test,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemporalReplayConfig {
    pub schema: String,
    pub source: PinnedEvidenceFile,
    pub split: PinnedEvidenceFile,
    pub model: PinnedEvidenceFile,
    pub window: HoldoutWindow,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_audit: Option<DomainAuditConfig>,
}

#[derive(Debug, Serialize)]
pub struct TemporalReplayReceipt {
    pub schema: &'static str,
    pub report_sha256: String,
    pub report_bytes: usize,
    pub queries: usize,
    pub window: HoldoutWindow,
    pub training_reproduction_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_coverage_passed: Option<bool>,
}

#[derive(Default, Serialize)]
struct MetricTotals {
    queries: usize,
    queries_with_positive_labels: usize,
    returned: usize,
    judged_returned: usize,
    explicit_negative_returned: usize,
    unjudged_returned: usize,
    observed_positive_labels: usize,
    observed_positive_hits: usize,
    #[serde(skip)]
    recall_sum: f64,
    #[serde(skip)]
    ndcg_sum: f64,
    #[serde(skip)]
    mrr_sum: f64,
}

impl MetricTotals {
    fn add(&mut self, metrics: &RankingMetrics) {
        self.queries += 1;
        self.queries_with_positive_labels += usize::from(metrics.positive_labels > 0);
        self.returned += metrics.returned;
        self.judged_returned += metrics.judged_returned;
        self.explicit_negative_returned += metrics.judged_returned - metrics.hits;
        self.unjudged_returned += metrics.returned - metrics.judged_returned;
        self.observed_positive_labels += metrics.positive_labels;
        self.observed_positive_hits += metrics.hits;
        self.recall_sum += metrics.recall_at_k.unwrap_or(0.0);
        self.ndcg_sum += metrics.ndcg_at_k.unwrap_or(0.0);
        self.mrr_sum += metrics.mrr_at_k.unwrap_or(0.0);
    }

    fn report(&self) -> serde_json::Value {
        let fraction = |value: f64, count: usize| (count > 0).then(|| value / count as f64);
        serde_json::json!({
            "counts":self,
            "macro_recall_at_k":fraction(self.recall_sum, self.queries_with_positive_labels),
            "macro_ndcg_at_k":fraction(self.ndcg_sum, self.queries_with_positive_labels),
            "macro_mrr_at_k":fraction(self.mrr_sum, self.queries_with_positive_labels),
            "micro_observed_positive_coverage":fraction(
                self.observed_positive_hits as f64, self.observed_positive_labels),
        })
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn group_queries<'a>(
    source: &'a RankTrainingSet,
    indices: &[usize],
) -> io::Result<BTreeMap<&'a str, Vec<&'a TrainingSample>>> {
    let mut queries: BTreeMap<&str, Vec<&TrainingSample>> = BTreeMap::new();
    for index in indices {
        let sample = &source.samples[*index];
        queries
            .entry(&sample.request.request_id)
            .or_default()
            .push(sample);
    }
    if queries.is_empty() || queries.len() > MAX_QUERIES {
        return Err(invalid("留出决策为空或超过1000项，请缩小固定窗口"));
    }
    for samples in queries.values_mut() {
        samples.sort_unstable_by(|a, b| a.candidate_id.cmp(&b.candidate_id));
        let first = samples[0];
        let request = serde_json::to_vec(&first.request).map_err(io::Error::other)?;
        // 同一决策只能有一份历史请求，不能按各候选的反馈结果选择不同画像或Top-K。
        for sample in samples.iter().skip(1) {
            if sample.profile_as_of != first.profile_as_of
                || serde_json::to_vec(&sample.request).map_err(io::Error::other)? != request
            {
                return Err(invalid("同一留出决策包含不一致的冻结请求或画像时点"));
            }
        }
    }
    Ok(queries)
}

/// 固定输入重现训练后才评估；报告只证明离线关系，不自动批准生产或选出最优模型。
pub fn replay_temporal_holdout(
    root: &Path,
    catalog_bytes: &[u8],
    config: &TemporalReplayConfig,
    target: &Path,
) -> io::Result<TemporalReplayReceipt> {
    if config.schema != "rank-temporal-replay-v1" || catalog_bytes.len() > 8 * 1024 * 1024 {
        return Err(invalid("留出回放版本或目录大小无效"));
    }
    if let Some(audit) = &config.domain_audit {
        audit.validate()?;
    }
    let catalog: PublicCatalog =
        serde_json::from_slice(catalog_bytes).map_err(|_| invalid("留出回放目录JSON无效"))?;
    let catalog_sha256 = hash(catalog_bytes);
    let mut input_bytes = 0;
    let source_bytes = read_pinned(root, &config.source, MAX_TRAINING_BYTES, &mut input_bytes)?;
    let source: RankTrainingSet =
        serde_json::from_slice(&source_bytes).map_err(|_| invalid("固定训练来源JSON无效"))?;
    if source.catalog_sha256 != catalog_sha256 {
        return Err(invalid("来源与目录指纹不一致"));
    }
    let split_bytes = read_pinned(root, &config.split, 4096, &mut input_bytes)?;
    let split_config: TemporalSplitConfig =
        serde_json::from_slice(&split_bytes).map_err(|_| invalid("固定时间切分JSON无效"))?;
    let split = temporal_split(&catalog, &source, &split_config)
        .map_err(|_| invalid("时间切分、证据身份、训练或留出边界无效"))?;
    let indices = match config.window {
        HoldoutWindow::Validation => &split.validation_indices,
        HoldoutWindow::Test => &split.test_indices,
    };
    let queries = group_queries(&source, indices)?;
    let pass_budget = queries
        .len()
        .checked_mul(catalog.items.len())
        .and_then(|value| value.checked_mul(2))
        .ok_or_else(|| invalid("留出回放计算预算溢出"))?;
    if pass_budget > MAX_CATALOG_PASSES {
        return Err(invalid("留出回放超出五千万目录评分单位预算"));
    }
    let model_bytes = read_pinned(root, &config.model, MAX_RANK_MODEL_BYTES, &mut input_bytes)?;
    let model = validate_rank_model(
        &model_bytes,
        &config.model.sha256,
        &catalog,
        &catalog_sha256,
    )
    .map_err(|_| invalid("固定模型与目录或模型契约不匹配"))?;
    let actual: LinearRankModel =
        serde_json::from_slice(&model_bytes).map_err(|_| invalid("固定模型JSON无效"))?;
    let reproduced = train_rank_model(&catalog, &split.training)
        .map_err(|_| invalid("固定训练窗无法重现模型"))?;
    // 发布模型经JSON读取后才推理；两端走相同读取链，严格比较而不引入浮点误差容忍。
    let reproduced: LinearRankModel =
        serde_json::from_slice(&serde_json::to_vec(&reproduced).map_err(io::Error::other)?)
            .map_err(|_| invalid("重现模型不能按原发布格式读取"))?;
    if serde_json::to_vec(&actual).map_err(io::Error::other)?
        != serde_json::to_vec(&reproduced).map_err(io::Error::other)?
    {
        return Err(invalid("固定模型不是由指定来源的训练窗口重现的产物"));
    }
    let mut audit = config
        .domain_audit
        .as_ref()
        .map(|settings| DomainAudit::new(&catalog, settings))
        .transpose()?;
    let mut baseline_totals = MetricTotals::default();
    let mut model_totals = MetricTotals::default();
    let mut rows = Vec::new();
    for (decision, samples) in queries {
        let request = &samples[0].request;
        let at = samples
            .iter()
            .map(|sample| sample.exposed_at)
            .min()
            .unwrap();
        let labels: Vec<_> = samples
            .iter()
            .map(|sample| Judgment {
                candidate_id: sample.candidate_id.clone(),
                relevance: u8::from(matches!(sample.feedback, PreferenceFeedback::Like)),
                observed_at: sample.feedback_at,
            })
            .collect();
        let baseline = recommend_with_model(&catalog, request, at, None)
            .map_err(|_| invalid("历史请求不能执行完整目录基线"))?;
        let ranked = recommend_with_model(&catalog, request, at, Some(&model.ranker))
            .map_err(|_| invalid("历史请求不能执行固定模型"))?;
        let baseline_ids: Vec<_> = baseline.items.iter().map(|item| item.id.as_str()).collect();
        let ranked_ids: Vec<_> = ranked.items.iter().map(|item| item.id.as_str()).collect();
        let baseline_metrics = ranking_metrics(&baseline_ids, &labels, request.limit)
            .map_err(|_| invalid("留出基线指标无效"))?;
        let model_metrics = ranking_metrics(&ranked_ids, &labels, request.limit)
            .map_err(|_| invalid("留出模型指标无效"))?;
        if let Some(audit) = &mut audit {
            let context = RequestContext::new(request, at)
                .map_err(|_| invalid("留出画像在首个明确曝光时无效"))?;
            audit.observe(&context, &labels, &baseline, &ranked)?;
        }
        baseline_totals.add(&baseline_metrics);
        model_totals.add(&model_metrics);
        rows.push(serde_json::json!({
            "decision_ref_sha256":hash(decision.as_bytes()), "evaluated_at":at,
            "domains":request.domains,"k":request.limit,"explicit_labels":labels.len(),
            "eligible_candidates":ranked.considered,
            "baseline_ids":baseline_ids,"model_ids":ranked_ids,
            "baseline_partial_labels":baseline_metrics,"model_partial_labels":model_metrics,
        }));
    }
    let domain_report = audit.map(DomainAudit::finish);
    let domain_coverage_passed = domain_report.as_ref().map(|report| report.gate_passed);
    let report = serde_json::json!({
        "schema":"rank-temporal-replay-report-v1",
        "window":config.window,"data_kind":source.data_kind,
        "catalog_sha256":catalog_sha256,"source_sha256":config.source.sha256,
        "split_sha256":config.split.sha256,"model_sha256":config.model.sha256,
        "config_canonical_sha256":hash(&serde_json::to_vec(config).map_err(io::Error::other)?),
        "training_canonical_sha256":hash(&serde_json::to_vec(&split.training).map_err(io::Error::other)?),
        "training_reproduction_verified":true,"model_trained_before":actual.trained_before,
        "split_audit":split.audit,"queries":rows,
        "baseline":baseline_totals.report(),"model":model_totals.report(),
        "domain_audit":domain_report,"logical_catalog_scoring_units":pass_budget,"input_bytes":input_bytes,
        "scope":{
            "quality":"partial-label-diagnostic-only","unbiased_policy_evaluation":false,
            "historical_source_truth_verified":false,"model_selection_protected":false,
            "subject_disjoint_required":false,"production_gate_passed":false,"online_policy_changed":false,
            "training_reproduction":"固定输入和当前确定性训练实现一致，不是训练过程或来源真实性的密码学证明",
            "labels":"仅源文件已显示且有明确反馈的决策；零反馈决策未由此格式提供，未知候选不作负样本",
            "query_clock":"同一决策首个有明确反馈的曝光时点，不冒充决策签发时点",
            "candidate_set":"完整固定目录按同一历史请求过滤；不使用仅已反馈候选的有利重排",
            "macro_denominator":"仅存在正标签的决策，零命中仍计入；负例决策单独计数而指标为null",
            "source_identity":"request_id必须是来源中稳定的服务端决策身份，散列引用不证明匿名或可信",
            "raw_profiles_in_report":false,"timing_benchmark":false,
            "budget_unit":"仅两条排序路径的完整目录逻辑评分单位；不含来源验证、训练重现、序列化及实际CPU/RSS",
        }
    });
    let output = serde_json::to_vec(&report).map_err(io::Error::other)?;
    if output.len() > MAX_REPORT_BYTES {
        return Err(invalid("留出报告超过16MiB预算"));
    }
    atomic_create(target, |writer| writer.write_all(&output))?;
    Ok(TemporalReplayReceipt {
        schema: "rank-temporal-replay-receipt-v1",
        report_sha256: hash(&output),
        report_bytes: output.len(),
        queries: rows.len(),
        window: config.window,
        training_reproduction_verified: true,
        domain_coverage_passed,
    })
}
