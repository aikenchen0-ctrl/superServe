use std::{collections::HashSet, sync::Arc};

use serde_json::json;
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    grouped_recall::GroupedRecall,
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    model_top_k::recommend_model_top_k,
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, recommend_subset_with_model,
        recommend_with_model,
    },
};

const CANDIDATE_COUNT: usize = 600;
const LIMIT: usize = 10;

fn catalog() -> PublicCatalog {
    let items = (0..CANDIDATE_COUNT)
        .map(|index| Candidate {
            id: format!("candidate-{index:03}"),
            domain: "video".into(),
            tags: vec!["focus".into()],
            // 目录顺序与先验均从高到低，模拟旧召回的稳定热门前缀。
            prior: 1.0 - index as f32 / 1000.0,
            media_sha256: None,
        })
        .collect();
    PublicCatalog {
        version: "model-recall-audit-v1".into(),
        items,
        assets: vec![],
    }
}

fn request() -> RecommendationRequest {
    RecommendationRequest {
        request_id: "model-recall-audit".into(),
        domains: vec!["video".into()],
        limit: LIMIT,
        profile: Some(ProfileProjection {
            subject: "audit-user".into(),
            version: "audit-v1".into(),
            scopes: vec!["video".into()],
            expires_at: 1_000,
            interests: vec![Interest {
                tag: "focus".into(),
                weight: 1.0,
            }],
            blocked_ids: vec![],
            denied_tags: vec![],
        }),
    }
}

fn reverse_prior_model(catalog: &PublicCatalog) -> LearnedRanker {
    let catalog_bytes = serde_json::to_vec(catalog).unwrap();
    let model = LinearRankModel {
        schema: "ftrl-ranker-v1".into(),
        feature_schema: "profile-candidate-6-v1".into(),
        objective: "explicit-preference-v1".into(),
        catalog_version: catalog.version.clone(),
        catalog_sha256: format!("{:x}", Sha256::digest(catalog_bytes)),
        data_kind: TrainingDataKind::Synthetic,
        trained_before: 1,
        training_samples: 2,
        positive_samples: 1,
        domains: vec!["video".into()],
        // 领域偏置的先验系数为负，明确构造与旧热门顺序相反的模型。
        weights: vec![0.0; 6]
            .into_iter()
            .chain([0.0, -5.0, 0.0, 0.0, 0.0, 0.0])
            .collect(),
    };
    LearnedRanker::new(&model, catalog).unwrap()
}

fn ids(response: &vs_core::recommendation::RecommendationResponse) -> Vec<String> {
    response.items.iter().map(|item| item.id.clone()).collect()
}

fn main() {
    let catalog = Arc::new(catalog());
    let request = request();
    let model = reverse_prior_model(&catalog);
    let full = recommend_with_model(&catalog, &request, 100, Some(&model)).unwrap();
    let context = vs_core::recommendation::RequestContext::new(&request, 100).unwrap();
    let index = GroupedRecall::new(catalog.clone()).unwrap();
    let selected = index.select(&context).indices;
    let recalled =
        recommend_subset_with_model(&catalog, &request, 100, &selected, Some(&model)).unwrap();
    let exact = recommend_model_top_k(&catalog, &request, 100, &model).unwrap();
    let full_ids = ids(&full);
    let recalled_ids = ids(&recalled);
    let exact_ids = ids(&exact.response);
    let full_set: HashSet<_> = full_ids.iter().collect();
    let recalled_set: HashSet<_> = recalled_ids.iter().collect();
    let overlap = full_set.intersection(&recalled_set).count();
    let exact_matches_full = exact_ids == full_ids;
    let report = json!({
        "schema": "model-recall-audit-v1",
        "data_kind": "synthetic_adversarial",
        "catalog_sha256": format!("{:x}", Sha256::digest(serde_json::to_vec(&*catalog).unwrap())),
        "catalog_items": catalog.items.len(),
        "request_limit": LIMIT,
        "old_recall_budget": selected.len(),
        "old_recall": {
            "mechanism": "既有GroupedRecall按完整亲和度、先验和ID选择前128项",
            "candidate_ids": selected.iter().take(12).map(|index| catalog.items[*index].id.clone()).collect::<Vec<_>>(),
            "model_top_k_overlap": overlap,
            "model_top_k_recall": overlap as f64 / LIMIT as f64,
            "result_ids": recalled_ids,
            "considered": recalled.considered
        },
        "full_model": {
            "result_ids": full_ids,
            "considered": full.considered
        },
        "exact_model_top_k": {
            "result_ids": exact_ids,
            "considered": exact.response.considered,
            "scored_buffer_bytes": exact.work.scored_buffer_bytes,
            "matches_full_model": exact_matches_full
        },
        "model": {
            "intent": "先验权重为负，模型偏好低先验候选",
            "inference_rpc": 0,
            "online_path_changed": false
        },
        "conclusion": {
            "old_recall_can_drop_model_top_k": overlap < LIMIT,
            "model_top_k_preserves_full_result": exact_matches_full,
            "online_default_changed": false,
            "claim": "没有模型分数上界时，旧召回后模型重排不能提供精确保真；model-topk仍需全量授权过滤和模型评分"
        },
        "scope": "构造性反例；不代表真实推荐质量、Qdrant近似误差、CPU/RSS、网络或用户效用"
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
