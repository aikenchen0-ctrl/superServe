use std::{
    collections::{BTreeMap, HashSet},
    env,
    io::Read,
    sync::Arc,
    time::Instant,
};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::PublicCatalog,
    grouped_recall::{GroupedRecall, GroupedSelection},
    recall::{CatalogRecall, PERSONALIZED_RECALL_LIMIT, PRIOR_RECALL_LIMIT, RecallScoring},
    recommendation::{RequestContext, recommend, recommend_subset},
    replay::{PreparedQuery, RankingMetrics, ReplayTrace, ranking_metrics},
};
use vs_service::qdrant_recall::{QdrantConfig, QdrantRecall};

#[path = "support/replay_demo.rs"]
mod replay_demo;

#[path = "support/replay_holdout.rs"]
mod replay_holdout;

type Check<T> = Result<T, String>;

#[derive(Serialize)]
struct CaseReport {
    request_id: String,
    domains: Vec<String>,
    k: usize,
    eligible_catalog_items: usize,
    excluded_positive_labels: usize,
    baseline_considered: usize,
    recalled_considered: usize,
    baseline: RankingMetrics,
    recalled: RankingMetrics,
    candidate_positive_recall: Option<f64>,
    baseline_top_k_retention: Option<f64>,
    relevance_regression: bool,
    baseline_ids: Vec<String>,
    recalled_ids: Vec<String>,
    baseline_us: u128,
    retrieval_us: u128,
    subset_rank_us: u128,
    prior_examined: usize,
    neutral_prior: bool,
    remote_query_issued: bool,
    grouped: Option<Value>,
    measurements: Vec<Measurement>,
    timing: Value,
}

#[derive(Serialize)]
struct Measurement {
    baseline_us: u128,
    retrieval_us: u128,
    subset_rank_us: u128,
    recalled_considered: usize,
    recall_at_k: Option<f64>,
    ndcg_at_k: Option<f64>,
    mrr_at_k: Option<f64>,
    relevance_regression: bool,
    same_result_as_first: bool,
    prior_examined: usize,
    remote_query_issued: bool,
    grouped: Option<Value>,
}

impl Measurement {
    fn from_case(case: &CaseReport, first_ids: &[String]) -> Self {
        Self {
            baseline_us: case.baseline_us,
            retrieval_us: case.retrieval_us,
            subset_rank_us: case.subset_rank_us,
            recalled_considered: case.recalled_considered,
            recall_at_k: case.recalled.recall_at_k,
            ndcg_at_k: case.recalled.ndcg_at_k,
            mrr_at_k: case.recalled.mrr_at_k,
            relevance_regression: case.relevance_regression,
            same_result_as_first: case.recalled_ids == first_ids,
            prior_examined: case.prior_examined,
            remote_query_issued: case.remote_query_issued,
            grouped: case.grouped.clone(),
        }
    }
}

fn latency(values: impl Iterator<Item = u128>) -> Value {
    let mut values: Vec<_> = values.collect();
    values.sort_unstable();
    let percentile = |p: usize| values[(p * values.len()).div_ceil(100) - 1];
    json!({
        "samples":values.len(),"p50_us":percentile(50),"p95_us":percentile(95),
        "p99_us":percentile(99),"max_us":values.last()
    })
}

// 离线只保留正分候选，与远端分数阈值一致；全目录扫描成本不代表在线索引成本。
fn exact_sparse(
    catalog: &PublicCatalog,
    context: &RequestContext<'_>,
    scoring: RecallScoring,
) -> Vec<String> {
    let mut scores: Vec<_> = catalog
        .items
        .iter()
        .filter(|item| context.allows(item))
        .filter_map(|item| {
            let weight = 1.0 / item.tags.len().max(1) as f32;
            let score = item
                .tags
                .iter()
                .map(|tag| {
                    context
                        .interests()
                        .get(tag.as_str())
                        .copied()
                        .filter(|value| scoring.includes(*value))
                        .unwrap_or(0.0)
                        * weight
                })
                .sum::<f32>();
            (score > 0.0).then_some((item, score))
        })
        .collect();
    scores.sort_unstable_by(|(a, score_a), (b, score_b)| {
        score_b.total_cmp(score_a).then_with(|| a.id.cmp(&b.id))
    });
    scores
        .into_iter()
        .take(PERSONALIZED_RECALL_LIMIT)
        .map(|(item, _)| item.id.clone())
        .collect()
}

fn fraction(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}

fn decreased(before: Option<f64>, after: Option<f64>) -> bool {
    matches!((before,after),(Some(a),Some(b)) if b + 1e-12 < a)
}

async fn evaluate_case(
    catalog: &PublicCatalog,
    index: &CatalogRecall,
    query: &PreparedQuery,
    mode: &str,
    remote: Option<&QdrantRecall>,
    grouped: Option<&GroupedRecall>,
) -> Check<CaseReport> {
    let request = &query.request;
    let context = RequestContext::new(request, query.at).map_err(|_| "回放请求校验失败")?;
    let started = Instant::now();
    let baseline = recommend(catalog, request, query.at).map_err(|_| "全目录排序失败")?;
    let baseline_us = started.elapsed().as_micros();
    let started = Instant::now();
    let scoring = if matches!(mode, "exact-signed-reference" | "qdrant-signed" | "grouped") {
        RecallScoring::Signed
    } else {
        RecallScoring::Positive
    };
    let (selected, prior_examined, neutral_prior, remote_query_issued, grouped_stats) =
        if let Some(grouped) = grouped {
            let GroupedSelection {
                indices,
                groups_examined,
                groups_scored,
                candidates_examined,
                peak_heads,
                head_buffer_bytes,
                output_buffer_bytes,
            } = grouped.select(&context);
            (
                indices,
                0,
                false,
                false,
                Some(json!({
                    "groups_examined":groups_examined,"groups_scored":groups_scored,
                    "candidates_examined":candidates_examined,"peak_heads":peak_heads,
                    "head_buffer_bytes":head_buffer_bytes,"output_buffer_bytes":output_buffer_bytes
                })),
            )
        } else {
            let prior = index.prior_with_scoring(catalog, &context, scoring);
            let prior_examined = prior.examined;
            let neutral_prior = prior.neutral_first;
            let (indices, values) = index.query_with_scoring(&context, scoring);
            let remote_query_issued =
                remote.is_some() && mode != "prior" && !indices.is_empty() && !neutral_prior;
            let ids = if mode == "prior" || indices.is_empty() || neutral_prior {
                vec![]
            } else if let Some(remote) = remote {
                // 评估遇到远端故障直接失败，避免把故障降级当作正常召回质量。
                remote
                    .query(request, indices, values)
                    .await
                    .map_err(|code| format!("真实召回失败：{code}"))?
            } else {
                exact_sparse(catalog, &context, scoring)
            };
            (
                index.merge(catalog, &context, prior.indices, &ids),
                prior_examined,
                neutral_prior,
                remote_query_issued,
                None,
            )
        };
    let retrieval_us = started.elapsed().as_micros();
    let started = Instant::now();
    let recalled =
        recommend_subset(catalog, request, query.at, &selected).map_err(|_| "有限召回排序失败")?;
    let subset_rank_us = started.elapsed().as_micros();
    if baseline.items.iter().chain(&recalled.items).any(|result| {
        !query
            .eligible_items
            .iter()
            .any(|index| catalog.items[*index].id == result.id)
    }) {
        return Err("回放出现违反场景或隐藏约束的候选，停止出具质量报告".into());
    }
    let baseline_ids: Vec<_> = baseline.items.iter().map(|item| item.id.clone()).collect();
    let recalled_ids: Vec<_> = recalled.items.iter().map(|item| item.id.clone()).collect();
    let baseline_metrics = ranking_metrics(
        &baseline_ids.iter().map(String::as_str).collect::<Vec<_>>(),
        &query.eligible_labels,
        request.limit,
    )
    .map_err(|_| "全目录指标失败")?;
    let recalled_metrics = ranking_metrics(
        &recalled_ids.iter().map(String::as_str).collect::<Vec<_>>(),
        &query.eligible_labels,
        request.limit,
    )
    .map_err(|_| "有限召回指标失败")?;
    let selected_ids: HashSet<_> = selected
        .iter()
        .map(|index| catalog.items[*index].id.as_str())
        .collect();
    let positives = query
        .eligible_labels
        .iter()
        .filter(|label| label.relevance > 0)
        .count();
    let retrieved = query
        .eligible_labels
        .iter()
        .filter(|label| label.relevance > 0 && selected_ids.contains(label.candidate_id.as_str()))
        .count();
    let returned: HashSet<_> = recalled_ids.iter().map(String::as_str).collect();
    let retained = baseline_ids
        .iter()
        .filter(|id| returned.contains(id.as_str()))
        .count();
    Ok(CaseReport {
        request_id: request.request_id.clone(),
        domains: request.domains.clone(),
        k: request.limit,
        eligible_catalog_items: query.eligible_items.len(),
        excluded_positive_labels: query.excluded_positive_labels,
        baseline_considered: baseline.considered,
        recalled_considered: recalled.considered,
        candidate_positive_recall: fraction(retrieved, positives),
        baseline_top_k_retention: fraction(retained, baseline_ids.len()),
        relevance_regression: decreased(baseline_metrics.recall_at_k, recalled_metrics.recall_at_k)
            || decreased(baseline_metrics.ndcg_at_k, recalled_metrics.ndcg_at_k)
            || decreased(baseline_metrics.mrr_at_k, recalled_metrics.mrr_at_k),
        baseline: baseline_metrics,
        recalled: recalled_metrics,
        baseline_ids,
        recalled_ids,
        baseline_us,
        retrieval_us,
        subset_rank_us,
        prior_examined,
        neutral_prior,
        remote_query_issued,
        grouped: grouped_stats,
        measurements: Vec::new(),
        timing: Value::Null,
    })
}

async fn sample_case(
    catalog: &PublicCatalog,
    index: &CatalogRecall,
    query: &PreparedQuery,
    mode: &str,
    remote: Option<&QdrantRecall>,
    grouped: Option<&GroupedRecall>,
    samples: usize,
) -> Check<CaseReport> {
    let mut first = evaluate_case(catalog, index, query, mode, remote, grouped).await?;
    let mut measurements = vec![Measurement::from_case(&first, &first.recalled_ids)];
    for _ in 1..samples {
        let next = evaluate_case(catalog, index, query, mode, remote, grouped).await?;
        measurements.push(Measurement::from_case(&next, &first.recalled_ids));
        // 任一样本退化都保留失败，不能只挑有利的首次结果。
        first.relevance_regression |= next.relevance_regression;
    }
    first.timing = json!({
        "baseline":latency(measurements.iter().map(|sample|sample.baseline_us)),
        "retrieval":latency(measurements.iter().map(|sample|sample.retrieval_us)),
        "subset_rank":latency(measurements.iter().map(|sample|sample.subset_rank_us))
    });
    first.measurements = measurements;
    Ok(first)
}

fn mean(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let values: Vec<_> = values.flatten().collect();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn route_metrics(row: &CaseReport, recalled: bool) -> &RankingMetrics {
    if recalled {
        &row.recalled
    } else {
        &row.baseline
    }
}

fn summary(rows: &[&CaseReport], eligible_union: &HashSet<&str>) -> Value {
    let before: HashSet<_> = rows
        .iter()
        .flat_map(|row| row.baseline_ids.iter().map(String::as_str))
        .collect();
    let after: HashSet<_> = rows
        .iter()
        .flat_map(|row| row.recalled_ids.iter().map(String::as_str))
        .collect();
    let metrics = |recalled: bool| {
        json!({
            "macro_recall_at_k":mean(rows.iter().map(|row|route_metrics(row,recalled).recall_at_k)),
            "macro_ndcg_at_k":mean(rows.iter().map(|row|route_metrics(row,recalled).ndcg_at_k)),
            "macro_mrr_at_k":mean(rows.iter().map(|row|route_metrics(row,recalled).mrr_at_k)),
            "returned":rows.iter().map(|row|route_metrics(row,recalled).returned).sum::<usize>(),
            "judged_returned":rows.iter().map(|row|route_metrics(row,recalled).judged_returned).sum::<usize>()
        })
    };
    json!({
        "queries":rows.len(),
        "queries_with_eligible_positive_labels":rows.iter().filter(|row|row.baseline.positive_labels>0).count(),
        "queries_without_eligible_positive_labels":rows.iter().filter(|row|row.baseline.positive_labels==0).count(),
        "excluded_positive_labels":rows.iter().map(|row|row.excluded_positive_labels).sum::<usize>(),
        "relevance_regressions":rows.iter().filter(|row|row.relevance_regression).count(),
        "macro_baseline_top_k_retention":mean(rows.iter().map(|row|row.baseline_top_k_retention)),
        "macro_candidate_positive_recall":mean(rows.iter().map(|row|row.candidate_positive_recall)),
        "baseline":metrics(false), "recalled":metrics(true),
        "baseline_total_ranked_candidates":rows.iter().map(|row|row.baseline_considered).sum::<usize>(),
        "recalled_total_ranked_candidates":rows.iter().map(|row|row.recalled_considered).sum::<usize>(),
        "eligible_catalog_union":eligible_union.len(),
        "baseline_distinct_recommended":before.len(), "recalled_distinct_recommended":after.len(),
        "baseline_catalog_coverage":fraction(before.len(),eligible_union.len()),
        "recalled_catalog_coverage":fraction(after.len(),eligible_union.len())
    })
}

fn read(path: &str, maximum: u64) -> Check<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| format!("无法读取文件：{path}"))?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("读取失败：{path}"))?;
    if bytes.len() as u64 > maximum {
        return Err(format!("文件超过容量上限：{path}"));
    }
    Ok(bytes)
}

async fn run() -> Check<bool> {
    let mut args: Vec<_> = env::args().skip(1).collect();
    let require_no_regression = args
        .last()
        .is_some_and(|argument| argument == "--require-no-regression");
    if require_no_regression {
        args.pop();
    }
    if args == ["--demo-catalog"] || args == ["--holdout-catalog"] {
        let (bytes, _) = if args == ["--holdout-catalog"] {
            replay_holdout::fixture()
        } else {
            replay_demo::fixture()
        };
        println!("{}", String::from_utf8(bytes).unwrap());
        return Ok(true);
    }
    if args == ["--demo-trace"] || args == ["--holdout-trace"] {
        let (_, trace) = if args == ["--holdout-trace"] {
            replay_holdout::fixture()
        } else {
            replay_demo::fixture()
        };
        println!("{}", serde_json::to_string_pretty(&trace).unwrap());
        return Ok(true);
    }
    let (catalog_bytes, trace_bytes, trace) = if args == ["--demo"] || args == ["--holdout"] {
        let (bytes, trace) = if args == ["--holdout"] {
            replay_holdout::fixture()
        } else {
            replay_demo::fixture()
        };
        let trace_bytes = serde_json::to_vec(&trace).unwrap();
        (bytes, trace_bytes, trace)
    } else if args.len() == 2 {
        let catalog = read(&args[0], 8 * 1024 * 1024)?;
        let trace_bytes = read(&args[1], 32 * 1024 * 1024)?;
        let trace: ReplayTrace =
            serde_json::from_slice(&trace_bytes).map_err(|_| "回放轨迹 JSON 无效")?;
        (catalog, trace_bytes, trace)
    } else {
        return Err("用法：recommendation_replay <目录.json> <轨迹.json> [--require-no-regression]；或 --demo、--holdout；目录和轨迹可用 --demo-catalog、--demo-trace、--holdout-catalog、--holdout-trace 导出".into());
    };
    let catalog: Arc<PublicCatalog> =
        Arc::new(serde_json::from_slice(&catalog_bytes).map_err(|_| "候选目录 JSON 无效")?);
    let prepared = trace
        .prepare(&catalog)
        .map_err(|error| format!("回放预检拒绝：{error}"))?;
    let catalog_sha256 = format!("{:x}", Sha256::digest(&catalog_bytes));
    let mode = env::var("REPLAY_RECALL_MODE").unwrap_or_else(|_| "exact-sparse-reference".into());
    if !matches!(
        mode.as_str(),
        "exact-sparse-reference"
            | "exact-signed-reference"
            | "qdrant"
            | "qdrant-signed"
            | "prior"
            | "grouped"
    ) {
        return Err("REPLAY_RECALL_MODE 必须为 exact-sparse-reference、exact-signed-reference、qdrant、qdrant-signed、prior 或 grouped".into());
    }
    let remote = if matches!(mode.as_str(), "qdrant" | "qdrant-signed") {
        Some(
            QdrantRecall::new(
                QdrantConfig {
                    endpoint: env::var("VS_QDRANT_URL")
                        .map_err(|_| "真实索引模式缺少 VS_QDRANT_URL")?,
                    api_key: env::var("VS_QDRANT_API_KEY").ok(),
                    scoring: if mode == "qdrant-signed" {
                        RecallScoring::Signed
                    } else {
                        RecallScoring::Positive
                    },
                },
                catalog_sha256.clone(),
            )
            .map_err(|code| format!("召回配置无效：{code}"))?,
        )
    } else {
        None
    };
    let index = CatalogRecall::new(&catalog);
    let group_started = Instant::now();
    let grouped = if mode == "grouped" {
        Some(GroupedRecall::new(catalog.clone()).map_err(|_| "分组索引构建失败")?)
    } else {
        None
    };
    let group_build_us = group_started.elapsed().as_micros();
    let samples = match env::var("REPLAY_TIMING_SAMPLES") {
        Ok(value) => value.parse::<usize>().ok().filter(|n| (1..=32).contains(n)),
        Err(env::VarError::NotPresent) => Some(1),
        Err(_) => None,
    }
    .ok_or("REPLAY_TIMING_SAMPLES 必须为 1 至 32 的整数")?;
    let mut rows = Vec::new();
    for query in &prepared {
        rows.push(
            sample_case(
                &catalog,
                &index,
                query,
                &mode,
                remote.as_ref(),
                grouped.as_ref(),
                samples,
            )
            .await?,
        );
    }
    let union: HashSet<_> = prepared
        .iter()
        .flat_map(|query| {
            query
                .eligible_items
                .iter()
                .map(|index| catalog.items[*index].id.as_str())
        })
        .collect();
    let mut domain_groups: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        for domain in row
            .domains
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>()
        {
            domain_groups.entry(domain).or_default().push(index);
        }
    }
    let domain_slices: BTreeMap<_, _> = domain_groups
        .into_iter()
        .map(|(domain, indices)| {
            let union: HashSet<_> = indices
                .iter()
                .flat_map(|index| {
                    prepared[*index]
                        .eligible_items
                        .iter()
                        .map(|index| catalog.items[*index].id.as_str())
                })
                .collect();
            let group: Vec<_> = indices.iter().map(|index| &rows[*index]).collect();
            (domain, summary(&group, &union))
        })
        .collect();
    let all: Vec<_> = rows.iter().collect();
    let regressions = rows.iter().filter(|row| row.relevance_regression).count();
    let evaluated_queries = rows
        .iter()
        .filter(|row| row.baseline.positive_labels > 0)
        .count();
    let gate_passed = evaluated_queries > 0 && regressions == 0;
    let report = json!({
        "schema":"recommendation-replay-report-v4","data_kind":trace.data_kind,"mode":mode,
        "catalog_sha256":catalog_sha256,"trace_sha256":format!("{:x}",Sha256::digest(&trace_bytes)),
        "catalog_version":catalog.version,"catalog_as_of":trace.catalog_as_of,"history_cutoff":trace.history_cutoff,
        "summary":summary(&all,&union),"requested_domain_slices":domain_slices,"domain_slices_overlap":true,
        "cases":rows,"profile_filter_violations":0,
        "quality_gate":{
            "enabled":require_no_regression,
            "rule":"at_least_one_evaluable_query_and_no_per_query_or_sample_recall_ndcg_or_mrr_regression_vs_full_catalog",
            "passed":if require_no_regression {Some(gate_passed)} else {None},
            "reason":if evaluated_queries==0 {"insufficient_positive_judgments"} else if regressions>0 {"relevance_regression"} else {"no_regression_observed"}
        },
        "timing_scope":"本机离线局部测量；基线为进程内排序，召回含先验、本地穷举或真实 RPC；不构成生产延迟对比",
        "label_scope":"仅对可见的正标签计算；未标注不等于负反馈，不估计曝光偏差或反事实用户效用",
        "reference_scope":if mode=="grouped" {
            "完整目录分组包含正分、零分、负分；按最终亲和度、先验、稳定ID归并；不是近似索引或学习排序"
        } else {
            "稀疏参考只保留正分候选；signed 同时计入负兴趣；按ID解同分，真实索引同分边界可能不同"
        },
        "recall_scoring":if matches!(mode.as_str(),"exact-signed-reference"|"qdrant-signed"|"grouped") {"signed"} else {"positive"},
        "candidate_budget":{
            "personalized":PERSONALIZED_RECALL_LIMIT,"prior":PRIOR_RECALL_LIMIT,
            "maximum_before_dedup":PERSONALIZED_RECALL_LIMIT + PRIOR_RECALL_LIMIT,
            "grouped_limit":PERSONALIZED_RECALL_LIMIT,"grouped_prior":0
        },
        "grouped_index":grouped.as_ref().map(|index|json!({
            "groups":index.group_count(),"catalog_items":catalog.items.len(),"build_us":group_build_us,
            "scope":"不可变完整目录本地索引；构建在请求外；有序标签保留浮点顺序，分组内按先验与ID归并"
        })),
        "prior_policy":if mode=="grouped" {"不启用额外先验路；分组归并本身覆盖完整可见目录"}
            else {"signed 且全部兴趣非正并至少一个为负时，中性先验优先并跳过索引请求；不足仍补负分，记录真实先验检查量"},
        "measurement_scope":{
            "samples_per_case":samples,"separate_warmup":false,"connection_pool_reused":remote.is_some(),
            "case_metrics":"首次样本的指标与 ID；退化门禁覆盖全部样本，逐样本指标另行保留",
            "percentiles":"逐请求最近秩描述统计；样本最多32个，不能估计生产P95/P99；不含完整HTTP端到端与负载排队"
        },
        "production_performance_claim":false,"online_quality_claim":false
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    Ok(!require_no_regression || gate_passed)
}

#[cfg(test)]
mod tests {
    use super::latency;

    #[test]
    fn nearest_rank_percentiles_keep_tail_samples_and_do_not_interpolate() {
        let report = latency((1..=20).rev());
        assert_eq!(report["samples"], 20);
        assert_eq!(report["p50_us"], 10);
        assert_eq!(report["p95_us"], 19);
        assert_eq!(report["p99_us"], 20);
        assert_eq!(latency(1..=16)["p95_us"], 16);
    }
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("质量门禁未通过：存在质量下降或缺少有效正标签，报告已输出。");
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("回放失败：{error}");
            std::process::exit(1);
        }
    }
}
