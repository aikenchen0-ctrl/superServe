use std::{
    collections::{HashMap, HashSet},
    io::{self, Write},
    path::Path,
    sync::Arc,
    time::Instant,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{
    grouped_recall::GroupedRecall,
    learning::PreferenceFeedback,
    model_top_k::recommend_model_top_k,
    recommendation::{
        RecommendationResponse, RequestContext, recommend_subset_with_model, recommend_with_model,
    },
    replay::{Judgment, ranking_metrics},
};

use crate::{
    domain_audit::{DomainAudit, DomainAuditConfig},
    learning_evidence::{
        EvidenceExportManifest, PinnedEvidenceFile, prepare_evidence, read_pinned,
    },
    rank_model::{MAX_RANK_MODEL_BYTES, validate_rank_model},
    upstream::atomic_create::atomic_create,
};

const MAX_QUERIES: usize = 1_000;
const MAX_EVALUATIONS: usize = 50_000_000;
const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;
const ORDERS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceReplayConfig {
    pub schema: String,
    pub decisions_from: u64,
    pub model: PinnedEvidenceFile,
    pub samples_per_query: usize,
    pub warmup_per_query: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recall_audit: Option<RecallAuditConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_audit: Option<DomainAuditConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecallAuditConfig {
    pub require_full_retention: bool,
}

#[derive(Debug, Serialize)]
pub struct EvidenceReplayReceipt {
    pub schema: &'static str,
    pub report_sha256: String,
    pub report_bytes: usize,
    pub queries: usize,
    pub exact: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall_retention_passed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_coverage_passed: Option<bool>,
}

#[derive(Serialize)]
struct Measurement {
    order: [usize; 3],
    full_ns: u64,
    topk_ns: u64,
    pruned_ns: u64,
    exact: bool,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn same(a: &RecommendationResponse, b: &RecommendationResponse) -> bool {
    a.request_id == b.request_id
        && a.catalog_version == b.catalog_version
        && a.profile_version == b.profile_version
        && a.ranker == b.ranker
        && a.considered == b.considered
        && a.items.len() == b.items.len()
        && a.items.iter().zip(&b.items).all(|(a, b)| {
            a.id == b.id
                && a.domain == b.domain
                && a.media_path == b.media_path
                && a.affinity.to_bits() == b.affinity.to_bits()
                && a.rank_score.map(f64::to_bits) == b.rank_score.map(f64::to_bits)
        })
}

fn timing(values: impl Iterator<Item = u64>) -> Value {
    let mut values: Vec<_> = values.collect();
    values.sort_unstable();
    let at = |p: usize| values[(p * values.len()).div_ceil(100) - 1];
    json!({"samples":values.len(), "p50_ns":at(50), "p95_ns":at(95), "p99_ns":at(99)})
}

/// 共用训练导出的来源关联，但保留无显示或无反馈决策，不以标签筛选计算样本。
pub fn replay_model_evidence(
    root: &Path,
    catalog_bytes: &[u8],
    manifest: &EvidenceExportManifest,
    config: &EvidenceReplayConfig,
    target: &Path,
) -> io::Result<EvidenceReplayReceipt> {
    if let Some(audit) = &config.domain_audit {
        audit.validate()?;
    }
    if config.schema != "model-evidence-replay-config-v1"
        || config.decisions_from < manifest.catalog_as_of
        || config.decisions_from >= manifest.train_before
        || !(6..=96).contains(&config.samples_per_query)
        || !config.samples_per_query.is_multiple_of(6)
        || config.warmup_per_query > 12
        || !config.warmup_per_query.is_multiple_of(6)
    {
        return Err(invalid("回放配置、时间窗口或采样预算无效"));
    }
    let mut prepared = prepare_evidence(root, catalog_bytes, manifest)?;
    let model_bytes = read_pinned(
        root,
        &config.model,
        MAX_RANK_MODEL_BYTES,
        &mut prepared.input_bytes,
    )?;
    let model = validate_rank_model(
        &model_bytes,
        &config.model.sha256,
        &prepared.catalog,
        &manifest.catalog_sha256,
    )
    .map_err(|message| invalid(&message))?;
    if model.ranker.trained_before() > config.decisions_from {
        return Err(invalid("模型训练截止晚于评估窗口起点，不能作为留出回放"));
    }
    let excluded: HashSet<_> = manifest
        .excluded_subjects
        .iter()
        .map(String::as_str)
        .collect();
    let mut before_window = 0;
    let mut after_window = 0;
    let mut excluded_decisions = 0;
    let mut decisions = Vec::new();
    for record in prepared.decisions.values() {
        let payload = &record.envelope.payload;
        if excluded.contains(payload.subject.as_str()) {
            excluded_decisions += 1;
        } else if payload.snapshot_at < config.decisions_from {
            before_window += 1;
        } else if payload.issued_at >= manifest.train_before {
            after_window += 1;
        } else {
            decisions.push(record);
        }
    }
    decisions.sort_unstable_by(|a, b| {
        (a.envelope.payload.issued_at, &a.decision_id)
            .cmp(&(b.envelope.payload.issued_at, &b.decision_id))
    });
    if decisions.is_empty() || decisions.len() > MAX_QUERIES {
        return Err(invalid("回放窗口没有决策或超过1000项；请缩小来源快照"));
    }
    let evaluation_budget = decisions
        .len()
        .checked_mul(prepared.catalog.items.len())
        .and_then(|n| {
            n.checked_mul(
                3 * (config.samples_per_query + config.warmup_per_query)
                    + 4
                    + 2 * usize::from(config.recall_audit.is_some())
                    + usize::from(config.domain_audit.is_some()),
            )
        })
        .ok_or_else(|| invalid("回放计算预算溢出"))?;
    if evaluation_budget > MAX_EVALUATIONS {
        return Err(invalid(
            "回放超过五千万目录遍历单位预算；请缩小窗口或采样数",
        ));
    }
    let mut labels: HashMap<&str, Vec<Judgment>> = HashMap::new();
    let candidates: HashMap<_, _> = prepared
        .catalog
        .items
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    for sample in &prepared.samples {
        let context = RequestContext::new(&sample.request, sample.exposed_at)
            .map_err(|_| invalid("反馈关联的历史画像在可见时已过期或越权"))?;
        if !candidates
            .get(sample.candidate_id.as_str())
            .is_some_and(|item| context.allows(item))
        {
            return Err(invalid("反馈候选不在冻结画像允许范围"));
        }
        labels
            .entry(&sample.request.request_id)
            .or_default()
            .push(Judgment {
                candidate_id: sample.candidate_id.clone(),
                relevance: u8::from(matches!(sample.feedback, PreferenceFeedback::Like)),
                observed_at: sample.feedback_at,
            });
    }
    // 全部输入先验完毕后才构建索引和计时；索引构建单独列出，不混入请求收益。
    let mut domain_audit = config
        .domain_audit
        .as_ref()
        .map(|audit| DomainAudit::new(&prepared.catalog, audit))
        .transpose()?;
    let catalog = Arc::new(prepared.catalog);
    let started = Instant::now();
    let index = GroupedRecall::new(catalog.clone()).map_err(|_| invalid("回放索引构建失败"))?;
    let index_build_ns = started.elapsed().as_nanos() as u64;
    let mut queries = Vec::new();
    let mut all_exact = true;
    let mut unlabelled_queries = 0;
    let mut invisible_queries = 0;
    let mut scope_labels = 0;
    let mut recall_queries_evaluable = 0;
    let mut recall_queries_losing_results = 0;
    let mut model_top_k_total = 0;
    let mut model_top_k_retained = 0;
    for (query_index, record) in decisions.iter().enumerate() {
        let payload = &record.envelope.payload;
        let request = &payload.request;
        let now = payload.issued_at;
        let query_labels = labels
            .get(record.decision_id.as_str())
            .map_or(&[][..], Vec::as_slice);
        let visible = prepared
            .visible_by_decision
            .get(&record.decision_id)
            .copied()
            .unwrap_or(0);
        unlabelled_queries += usize::from(query_labels.is_empty());
        invisible_queries += usize::from(visible == 0);
        scope_labels += query_labels.len();
        let baseline = recommend_with_model(&catalog, request, now, None)
            .map_err(|_| invalid("历史请求无法执行标签基线"))?;
        let reference = recommend_with_model(&catalog, request, now, Some(&model.ranker))
            .map_err(|_| invalid("历史请求无法执行固定模型"))?;
        let topk = recommend_model_top_k(&catalog, request, now, &model.ranker)
            .map_err(|_| invalid("历史请求无法执行精确Top-K"))?;
        let pruned = index
            .recommend_with_model(request, now, &model.ranker)
            .map_err(|_| invalid("历史请求无法执行分组剪枝"))?;
        let mut exact = same(&reference, &topk.response) && same(&reference, &pruned.response);
        let baseline_ids: Vec<_> = baseline.items.iter().map(|item| item.id.as_str()).collect();
        let reference_ids: Vec<_> = reference
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        let baseline_metrics = ranking_metrics(&baseline_ids, query_labels, request.limit)
            .map_err(|_| invalid("标签基线指标无效"))?;
        let model_metrics = ranking_metrics(&reference_ids, query_labels, request.limit)
            .map_err(|_| invalid("模型指标无效"))?;
        let recall_audit = if config.recall_audit.is_some() {
            let context =
                RequestContext::new(request, now).map_err(|_| invalid("召回审计请求无效"))?;
            let started = Instant::now();
            let selected = index.select(&context);
            let selection_ns = started.elapsed().as_nanos() as u64;
            let started = Instant::now();
            let recalled = recommend_subset_with_model(
                &catalog,
                request,
                now,
                &selected.indices,
                Some(&model.ranker),
            )
            .map_err(|_| invalid("召回审计模型重排失败"))?;
            let rerank_ns = started.elapsed().as_nanos() as u64;
            let selected_ids: HashSet<_> = selected
                .indices
                .iter()
                .map(|index| catalog.items[*index].id.as_str())
                .collect();
            let returned_ids: HashSet<_> =
                recalled.items.iter().map(|item| item.id.as_str()).collect();
            let retained = reference_ids
                .iter()
                .filter(|id| returned_ids.contains(**id))
                .count();
            let missing: Vec<_> = reference_ids
                .iter()
                .copied()
                .filter(|id| !selected_ids.contains(id))
                .collect();
            let positives = query_labels.iter().filter(|label| label.relevance > 0);
            let positive_count = positives.clone().count();
            let positive_covered = positives
                .filter(|label| selected_ids.contains(label.candidate_id.as_str()))
                .count();
            let metrics = ranking_metrics(
                &recalled
                    .items
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                query_labels,
                request.limit,
            )
            .map_err(|_| invalid("召回审计部分标签指标无效"))?;
            recall_queries_evaluable += usize::from(!reference_ids.is_empty());
            recall_queries_losing_results += usize::from(retained != reference_ids.len());
            model_top_k_total += reference_ids.len();
            model_top_k_retained += retained;
            Some(json!({
                "backend":"grouped-tags-reference",
                "candidate_count":selected.indices.len(),
                "groups_scored":selected.groups_scored,
                "candidates_examined":selected.candidates_examined,
                "selection_ns":selection_ns,
                "subset_model_rank_ns":rerank_ns,
                "model_candidates_scored":recalled.considered,
                "model_top_k_count":reference_ids.len(),
                "model_top_k_retained":retained,
                "model_top_k_retention":fraction(retained,reference_ids.len()),
                "missing_model_top_k_ids":missing,
                "explicit_positive_labels":positive_count,
                "explicit_positive_labels_covered":positive_covered,
                "candidate_positive_label_coverage":fraction(positive_covered,positive_count),
                "reranked_partial_labels":metrics,
                "scope":"本地旧亲和度分组召回参考；不是远端Qdrant，不把未知标签当负反馈"
            }))
        } else {
            None
        };
        let mut measurements = Vec::new();
        for iteration in 0..(config.samples_per_query + config.warmup_per_query) {
            let order = ORDERS[(iteration + query_index) % ORDERS.len()];
            let mut durations = [0; 3];
            let mut outputs = [None, None, None];
            for backend in order {
                let started = Instant::now();
                let result = match backend {
                    0 => recommend_with_model(&catalog, request, now, Some(&model.ranker)),
                    1 => recommend_model_top_k(&catalog, request, now, &model.ranker)
                        .map(|r| r.response),
                    _ => index
                        .recommend_with_model(request, now, &model.ranker)
                        .map(|r| r.response),
                }
                .map_err(|_| invalid("回放评分失败"))?;
                std::hint::black_box(&result);
                durations[backend] = started.elapsed().as_nanos() as u64;
                outputs[backend] = Some(result);
            }
            let round_exact = outputs
                .iter()
                .all(|output| same(&reference, output.as_ref().unwrap()));
            exact &= round_exact;
            if iteration >= config.warmup_per_query {
                measurements.push(Measurement {
                    order,
                    full_ns: durations[0],
                    topk_ns: durations[1],
                    pruned_ns: durations[2],
                    exact: round_exact,
                });
            }
        }
        if let Some(audit) = &mut domain_audit {
            let context =
                RequestContext::new(request, now).map_err(|_| invalid("领域审计请求无效"))?;
            audit.observe(&context, query_labels, &baseline, &reference)?;
        }
        all_exact &= exact;
        let mut query = json!({
            "decision_id":record.decision_id, "issued_at":now, "domains":request.domains, "k":request.limit,
            "historical_ranker":payload.ranker,
            "historical_slate_policy":record.envelope.metadata.slate_policy,
            "historical_slate_applied_to_comparators":false,
            "historical_model_sha256":record.envelope.metadata.model_sha256,
            "originally_returned":payload.returned_ids.len(), "visible_reported":visible,
            "explicit_labels":query_labels.len(),
            "unjudged_model_returns":reference.items.len() - model_metrics.judged_returned,
            "tag_baseline_partial_labels":baseline_metrics, "model_partial_labels":model_metrics,
            "eligible_candidates":reference.considered, "topk_work":topk.work, "pruned_work":pruned.work,
            "exact":exact,
            "timing":{"full":timing(measurements.iter().map(|m| m.full_ns)),
                "topk":timing(measurements.iter().map(|m| m.topk_ns)),
                "pruned":timing(measurements.iter().map(|m| m.pruned_ns))},
            "measurements":measurements,
        });
        if let Some(audit) = recall_audit {
            query["recall_audit"] = audit;
        }
        queries.push(query);
    }
    let recall_retention_passed = config
        .recall_audit
        .as_ref()
        .map(|_| recall_queries_evaluable > 0 && recall_queries_losing_results == 0);
    let mut report = json!({
        "schema":"model-evidence-replay-v1",
        "build":if cfg!(debug_assertions) { "debug" } else { "release" },
        "data_kind":manifest.data_kind, "model_data_kind":model.data_kind,
        "catalog_sha256":manifest.catalog_sha256, "model_sha256":config.model.sha256,
        "model_trained_before":model.ranker.trained_before(),
        "manifest_canonical_sha256":hash(&serde_json::to_vec(manifest).map_err(io::Error::other)?),
        "config_canonical_sha256":hash(&serde_json::to_vec(config).map_err(io::Error::other)?),
        "decision_log_sha256":manifest.decision_logs.iter().map(|file| &file.sha256).collect::<Vec<_>>(),
        "gateway_events_sha256":manifest.gateway_events.sha256,
        "window":{"snapshots_from":config.decisions_from, "issued_before":manifest.train_before,
            "feedback_before":manifest.train_before},
        "coverage":{"input_decisions":prepared.decisions.len(), "replayed_decisions":queries.len(),
            "excluded_decisions":excluded_decisions, "before_window":before_window,
            "after_window":after_window, "unlabelled_queries":unlabelled_queries,
            "issued_without_visibility":invisible_queries, "explicit_labels":scope_labels},
        "evidence":{"duplicate_events":prepared.duplicate_events, "excluded_events":prepared.excluded_events,
            "deferred_feedback":prepared.deferred_feedback, "visible_without_label":prepared.visible_without_label,
            "all_window_issued_without_visibility":prepared.issued_without_visibility,
            "input_bytes":prepared.input_bytes},
        "index_build_ns":index_build_ns, "index":index.allocation_layout(),
        "samples_per_query":config.samples_per_query, "warmup_per_query":config.warmup_per_query,
        "logical_catalog_pass_units":evaluation_budget, "queries":queries,
        "exactness_gate":{"passed":all_exact},
        "scope":{"labels":"仅对已显示且明确反馈的历史返回候选，未评价候选保持未知",
            "quality":"partial-label-diagnostic-only", "unbiased_policy_evaluation":false,
            "terminal_rendering_proven":false, "physical_cluster_tested":false,
            "source_trust":"依赖可信网关归档和清单操作者，散列不证明渲染、身份或授权",
            "historical_policy_reproduction":false,
            "training_provenance_verified":false,
            "budget_unit":"每条评分路径按完整目录计一遍；不等于实际ID检查、CPU指令或时间上限",
            "report_contains_raw_profiles":false, "production_gate_passed":false}
    });
    if let Some(audit) = &config.recall_audit {
        report["recall_audit"] = json!({
            "backend":"grouped-tags-reference",
            "require_full_retention":audit.require_full_retention,
            "evaluable_queries":recall_queries_evaluable,
            "queries_losing_model_top_k":recall_queries_losing_results,
            "model_top_k_total":model_top_k_total,
            "model_top_k_retained":model_top_k_retained,
            "micro_model_top_k_retention":fraction(model_top_k_retained,model_top_k_total),
            "retention_gate_passed":recall_retention_passed,
            "reason":if recall_queries_evaluable == 0 { "no_eligible_model_results" }
                else if recall_queries_losing_results > 0 { "model_top_k_lost" }
                else { "full_retention_observed" },
            "online_policy_changed":false,
            "timing_scope":"单次诊断计时，未参与三路径均衡顺序，不能据此排名延迟",
            "quality_scope":"模型结果保留率不是用户质量；部分标签保留来源偏差"
        });
    }
    let domain_coverage_passed = if let Some(audit) = domain_audit {
        let audit = audit.finish();
        let passed = audit.gate_passed;
        report["domain_audit"] = serde_json::to_value(audit).map_err(io::Error::other)?;
        Some(passed)
    } else {
        None
    };
    let output = serde_json::to_vec(&report).map_err(io::Error::other)?;
    if output.len() > MAX_REPORT_BYTES {
        return Err(invalid("回放报告超过16MiB预算"));
    }
    atomic_create(target, |writer| writer.write_all(&output))?;
    Ok(EvidenceReplayReceipt {
        schema: "model-evidence-replay-receipt-v1",
        report_sha256: hash(&output),
        report_bytes: output.len(),
        queries: decisions.len(),
        exact: all_exact,
        recall_retention_passed,
        domain_coverage_passed,
    })
}

fn fraction(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}
