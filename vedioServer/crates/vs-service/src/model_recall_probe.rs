use std::{
    collections::HashSet,
    io::{self, Write},
    path::Path,
    sync::Arc,
    time::Instant,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use vs_core::{
    grouped_recall::GroupedRecall,
    model_recall::MODEL_RECALL_SCHEMA,
    recommendation::{RecommendationRequest, recommend_subset_with_model, recommend_with_model},
};

use crate::{
    learning_evidence::{PinnedEvidenceFile, read_pinned},
    qdrant_model_recall::{ModelRecallResponse, QdrantModelRecall},
    qdrant_recall::QdrantConfig,
    rank_model::{MAX_RANK_MODEL_BYTES, validate_rank_model},
    upstream::atomic_create::atomic_create,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRecallProbe {
    pub schema: String,
    pub catalog: PinnedEvidenceFile,
    pub models: Vec<PinnedEvidenceFile>,
    pub queries: Vec<ModelRecallQuery>,
    pub budgets: Vec<usize>,
    pub publish: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub response_modes: Vec<ModelRecallResponse>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRecallQuery {
    pub at: u64,
    pub request: RecommendationRequest,
}

#[derive(Debug, Serialize)]
pub struct ModelRecallProbeReceipt {
    pub schema: &'static str,
    pub report_sha256: String,
    pub report_bytes: usize,
    pub comparisons: usize,
    pub all_model_top_k_retained: bool,
}

fn invalid(reason: impl Into<String>) -> io::Error {
    io::Error::other(reason.into())
}

/// 与线上路径隔离；固定输入全部验证后才触碰索引，不对缺失结果静默补全全目录。
pub async fn probe_model_recall(
    root: &Path,
    config: &ModelRecallProbe,
    endpoint: QdrantConfig,
    target: &Path,
) -> io::Result<ModelRecallProbeReceipt> {
    if config.schema != "model-recall-probe-v1"
        || !(1..=8).contains(&config.models.len())
        || !(1..=32).contains(&config.queries.len())
        || config.budgets.is_empty()
        || config.budgets.len() > 4
        || config.budgets.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid("模型召回实验的配置或比较数量无效"));
    }
    let mut input_bytes = 0;
    let response_modes = if config.response_modes.is_empty() {
        vec![ModelRecallResponse::Payload]
    } else {
        config.response_modes.clone()
    };
    if response_modes.len() > 2
        || response_modes.iter().collect::<HashSet<_>>().len() != response_modes.len()
    {
        return Err(invalid("模型召回响应模式重复或超过两项"));
    }
    let catalog_bytes = read_pinned(root, &config.catalog, 8 * 1024 * 1024, &mut input_bytes)?;
    let catalog = Arc::new(
        serde_json::from_slice::<vs_core::catalog::PublicCatalog>(&catalog_bytes)
            .map_err(|_| invalid("模型召回实验目录JSON无效"))?,
    );
    let mut models = Vec::new();
    for pinned in &config.models {
        let bytes = read_pinned(root, pinned, MAX_RANK_MODEL_BYTES, &mut input_bytes)?;
        let model = validate_rank_model(&bytes, &pinned.sha256, &catalog, &config.catalog.sha256)
            .map_err(invalid)?;
        models.push(model);
    }
    let mut requests = HashSet::new();
    for query in &config.queries {
        if !requests.insert(query.request.request_id.as_str()) {
            return Err(invalid("模型召回实验请求ID重复"));
        }
        for model in &models {
            recommend_with_model(&catalog, &query.request, query.at, Some(&model.ranker))
                .map_err(|_| invalid("模型召回实验请求过期、越权或模型时间不符"))?;
        }
        if config
            .budgets
            .iter()
            .any(|limit| *limit < query.request.limit || *limit > 512 || *limit == 0)
        {
            return Err(invalid("模型召回实验预算不覆盖请求或超过512"));
        }
    }
    let started = Instant::now();
    let old_index =
        GroupedRecall::new(catalog.clone()).map_err(|_| invalid("旧亲和度参考构建失败"))?;
    let old_build_ns = started.elapsed().as_nanos() as u64;
    let started = Instant::now();
    let mut recall = QdrantModelRecall::new(endpoint, &catalog_bytes).map_err(invalid)?;
    if config.publish {
        recall.publish().await.map_err(invalid)?;
    } else {
        recall.verify().await.map_err(invalid)?;
    }
    let publication_ns = started.elapsed().as_nanos() as u64;
    let mut comparisons = Vec::new();
    let mut all_retained = true;
    let mut evaluable_comparisons = 0;
    let mut losing_comparisons = 0;
    let mut paired_groups = 0;
    let mut divergent_groups = 0;
    for (model_number, model) in models.iter().enumerate() {
        for query in &config.queries {
            let started = Instant::now();
            let full =
                recommend_with_model(&catalog, &query.request, query.at, Some(&model.ranker))
                    .map_err(|_| invalid("完整模型参考执行失败"))?;
            let full_ns = started.elapsed().as_nanos() as u64;
            let context = vs_core::recommendation::RequestContext::new(&query.request, query.at)
                .map_err(|_| invalid("旧亲和度参考请求失败"))?;
            let old = old_index.select(&context);
            let old = recommend_subset_with_model(
                &catalog,
                &query.request,
                query.at,
                &old.indices,
                Some(&model.ranker),
            )
            .map_err(|_| invalid("旧亲和度参考重排失败"))?;
            let reference_ids: HashSet<_> =
                full.items.iter().map(|item| item.id.as_str()).collect();
            let old_retained = old
                .items
                .iter()
                .filter(|item| reference_ids.contains(item.id.as_str()))
                .count();
            for budget in &config.budgets {
                let mut first_fingerprints = None;
                let mut diverged = false;
                for (mode_number, response_mode) in response_modes.iter().enumerate() {
                    let started = Instant::now();
                    let candidates = recall
                        .query_with_response(
                            &query.request,
                            query.at,
                            &model.ranker,
                            *budget,
                            *response_mode,
                        )
                        .await
                        .map_err(invalid)?;
                    let retrieval_ns = started.elapsed().as_nanos() as u64;
                    let started = Instant::now();
                    let reranked = recommend_subset_with_model(
                        &catalog,
                        &query.request,
                        query.at,
                        &candidates.indices,
                        Some(&model.ranker),
                    )
                    .map_err(|_| invalid("模型感知候选重排失败"))?;
                    let rerank_ns = started.elapsed().as_nanos() as u64;
                    let mut ordered_indices = candidates.indices.clone();
                    ordered_indices.sort_unstable();
                    let candidate_set_sha256 = format!(
                        "{:x}",
                        Sha256::digest(serde_json::to_vec(&ordered_indices).map_err(invalid_io)?)
                    );
                    let reranked_result_sha256 = format!(
                        "{:x}",
                        Sha256::digest(serde_json::to_vec(&reranked).map_err(invalid_io)?)
                    );
                    let fingerprints =
                        (candidate_set_sha256.clone(), reranked_result_sha256.clone());
                    if let Some(first) = &first_fingerprints {
                        diverged |= first != &fingerprints;
                    } else {
                        first_fingerprints = Some(fingerprints);
                    }
                    let selected: HashSet<_> = candidates
                        .indices
                        .iter()
                        .map(|index| catalog.items[*index].id.as_str())
                        .collect();
                    let returned: HashSet<_> =
                        reranked.items.iter().map(|item| item.id.as_str()).collect();
                    let retained = reference_ids.intersection(&returned).count();
                    let missing: Vec<_> = full
                        .items
                        .iter()
                        .filter(|item| !selected.contains(item.id.as_str()))
                        .map(|item| item.id.as_str())
                        .collect();
                    let scores_match = reranked.items.iter().all(|item| {
                        let expected = &catalog.items[candidates
                            .indices
                            .iter()
                            .copied()
                            .find(|index| catalog.items[*index].id == item.id)
                            .expect("已重排候选")];
                        item.rank_score.is_some_and(|score| {
                            score.to_bits() == model.ranker.score(&context, expected).to_bits()
                        })
                    });
                    if !scores_match {
                        return Err(invalid("候选重排未保留原始Rust模型分数"));
                    }
                    let evaluable = !reference_ids.is_empty();
                    evaluable_comparisons += usize::from(evaluable);
                    losing_comparisons += usize::from(retained != reference_ids.len());
                    all_retained &= retained == reference_ids.len();
                    comparisons.push(json!({
                    "model_sha256":config.models[model_number].sha256,
                    "model_data_kind":model.data_kind,
                    "request_id":query.request.request_id,
                    "domains":query.request.domains,
                    "candidate_budget":budget,
                    "response_mode":response_mode,
                    "mode_execution_position":mode_number,
                    "candidate_set_sha256":candidate_set_sha256,
                    "reranked_result_sha256":reranked_result_sha256,
                    "eligible_candidates":full.considered,
                    "candidates_received":candidates.indices.len(),
                    "model_top_k_count":reference_ids.len(),
                    "model_top_k_retained":retained,
                    "model_top_k_retention":evaluable.then(||retained as f64/reference_ids.len() as f64),
                    "missing_model_top_k_ids":missing,
                    "old_affinity_retained":old_retained,
                    "model_candidates_scored_locally":reranked.considered,
                    "full_model_ns":full_ns,
                    "retrieval_ns":retrieval_ns,"rerank_ns":rerank_ns,
                    "request_body_bytes":candidates.request_body_bytes,
                    "response_body_bytes":candidates.response_body_bytes,
                    "negative_query_weights":candidates.negative_query_weights,
                    "query_dimensions":candidates.query_dimensions,
                    "rerank_f64_scores_preserved":scores_match
                }));
                }
                if response_modes.len() == 2 {
                    paired_groups += 1;
                    divergent_groups += usize::from(diverged);
                }
            }
        }
    }
    let all_model_top_k_retained = all_retained && evaluable_comparisons > 0;
    let report = json!({
        "schema":"model-aware-recall-probe-report-v1",
        "build":if cfg!(debug_assertions) {"debug"}else{"release"},
        "projection":MODEL_RECALL_SCHEMA,"catalog_sha256":config.catalog.sha256,
        "model_sha256":config.models.iter().map(|model|&model.sha256).collect::<Vec<_>>(),
        "config_struct_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(config).map_err(invalid_io)?)),
        "catalog_items":catalog.items.len(),"projection_dimensions":recall.dimensions(),
        "publication_or_verification_ns":publication_ns,
        "old_index_build_ns":old_build_ns,"old_index_layout":old_index.allocation_layout(),
        "collection":recall.collection(),"input_bytes":input_bytes,
        "point_id_mapping_key_bytes":recall.mapping_key_bytes(),
        "point_id_mapping_scope":"键字符串长度之和，不含HashMap桶、容量、对象、分配器和目录；不是RSS",
        "response_modes":response_modes,
        "response_equivalence":{"paired_groups":paired_groups,"divergent_groups":divergent_groups,
            "scope":"固定请求下候选集合和完整重排响应序列化指纹；不证明跨次查询、并发写入或全目录保真"},
        "evaluable_comparisons":evaluable_comparisons,"losing_comparisons":losing_comparisons,
        "all_model_top_k_retained":all_model_top_k_retained,
        "comparisons":comparisons,
        "scope":{
            "query_source":"操作者提供的固定请求，模型必须匹配固定目录和请求时点",
            "results":"f32稀疏检索后使用原Rust f64模型重排，候选边界仍近似",
            "privacy":"请求只发送领域标签派生权重和排除集合；仍可能透露偏好，不是匿名或隐私证明",
            "labels":"模型保留率不是用户满意度；没有用户标签或无偏质量评价",
            "timing":"debug或release单次本机请求局部测量，未作均衡重复，不排名生产延迟",
            "request_and_response_bytes":"只计JSON请求与实收响应正文，不含HTTP头、TLS、重传、存储或集群传输",
            "physical_cluster":false,"production_admitted":false,"online_default_changed":false
        }
    });
    let output = serde_json::to_vec(&report).map_err(invalid_io)?;
    if output.len() > 8 * 1024 * 1024 {
        return Err(invalid("模型召回实验报告超过8MiB"));
    }
    atomic_create(target, |writer| writer.write_all(&output))?;
    Ok(ModelRecallProbeReceipt {
        schema: "model-aware-recall-probe-receipt-v1",
        report_sha256: format!("{:x}", Sha256::digest(&output)),
        report_bytes: output.len(),
        comparisons: comparisons.len(),
        all_model_top_k_retained,
    })
}

fn invalid_io(error: serde_json::Error) -> io::Error {
    io::Error::other(error)
}
