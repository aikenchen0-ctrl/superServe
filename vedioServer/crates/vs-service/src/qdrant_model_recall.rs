use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::PublicCatalog,
    learning::LearnedRanker,
    model_recall::{MODEL_RECALL_SCHEMA, ModelRecallProjection, SparseProjection},
    recommendation::{RecommendationRequest, RequestContext},
};

use crate::qdrant_recall::{QdrantConfig, QdrantRecall, point_id};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRecallResponse {
    #[default]
    Payload,
    IdOnly,
}

#[derive(Debug, Serialize)]
pub struct ModelRecallCandidates {
    pub indices: Vec<usize>,
    pub request_body_bytes: usize,
    pub response_body_bytes: usize,
    pub negative_query_weights: bool,
    pub query_dimensions: usize,
}

#[cfg(test)]
#[path = "qdrant_model_recall_tests.rs"]
mod tests;

/// 独立实验集合；复用现有有界HTTP与鉴权，不改变线上标签索引或默认路由。
pub struct QdrantModelRecall {
    client: QdrantRecall,
    projection: ModelRecallProjection,
    points: HashMap<String, usize>,
    catalog_sha256: String,
    verified: bool,
}

impl QdrantModelRecall {
    pub fn new(config: QdrantConfig, catalog_bytes: &[u8]) -> Result<Self, &'static str> {
        if catalog_bytes.len() > 8 * 1024 * 1024 {
            return Err("模型召回目录超过预算");
        }
        let catalog: PublicCatalog =
            serde_json::from_slice(catalog_bytes).map_err(|_| "模型召回目录JSON无效")?;
        let projection =
            ModelRecallProjection::new(Arc::new(catalog)).map_err(|_| "模型召回目录无效")?;
        let catalog_sha256 = format!("{:x}", Sha256::digest(catalog_bytes));
        let client = QdrantRecall::new(config, catalog_sha256.clone())?;
        let points = projection
            .catalog()
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| (point_id(&catalog_sha256, &item.id), index))
            .collect();
        Ok(Self {
            client,
            projection,
            points,
            catalog_sha256,
            verified: false,
        })
    }

    pub fn collection(&self) -> String {
        format!("vs_m1_{}", self.catalog_sha256)
    }

    pub fn dimensions(&self) -> u32 {
        self.projection.dimensions()
    }

    pub fn mapping_key_bytes(&self) -> usize {
        self.points.keys().map(String::len).sum()
    }

    async fn call(
        &self,
        method: Method,
        suffix: &str,
        body: Option<Value>,
    ) -> Result<Value, &'static str> {
        let builder = self
            .client
            .request(
                method,
                &format!("/collections/{}{}", self.collection(), suffix),
            )
            .timeout(Duration::from_secs(5));
        let builder = if let Some(body) = body {
            builder.json(&body)
        } else {
            builder
        };
        QdrantRecall::json(builder).await
    }

    pub async fn publish(&mut self) -> Result<(), &'static str> {
        self.verified = false;
        tokio::time::timeout(Duration::from_secs(120), self.publish_inner())
            .await
            .map_err(|_| "模型召回发布超过120秒")?
    }

    async fn publish_inner(&mut self) -> Result<(), &'static str> {
        let created = self
            .call(
                Method::PUT,
                "",
                Some(json!({
                    "vectors":{},"sparse_vectors":{"model":{"index":{"on_disk":false}}}
                })),
            )
            .await?;
        if created["result"] != true {
            return Err("模型召回集合创建未确认");
        }
        for field in [
            "candidate_id",
            "catalog_sha256",
            "domain",
            "tags",
            "projection",
        ] {
            let result = self
                .call(
                    Method::PUT,
                    "/index?wait=true",
                    Some(json!({
                        "field_name":field,"field_schema":"keyword"
                    })),
                )
                .await?;
            if result["result"]["status"] != "completed" {
                return Err("模型召回字段索引未完成");
            }
        }
        for start in (0..self.projection.catalog().items.len()).step_by(64) {
            let end = (start + 64).min(self.projection.catalog().items.len());
            let points = (start..end)
                .map(|index| {
                    let item = &self.projection.catalog().items[index];
                    let vector = self.projection.point(index).expect("已校验目录内索引");
                    json!({"id":point_id(&self.catalog_sha256,&item.id),
                    "vector":{"model":vector},
                    "payload":{"candidate_id":item.id,"domain":item.domain,"tags":item.tags,
                        "catalog_sha256":self.catalog_sha256,"projection":MODEL_RECALL_SCHEMA}})
                })
                .collect::<Vec<_>>();
            let result = self
                .call(
                    Method::PUT,
                    "/points?wait=true",
                    Some(json!({"points":points})),
                )
                .await?;
            if result["result"]["status"] != "completed" {
                return Err("模型召回点写入未完成");
            }
        }
        self.verify().await
    }

    pub async fn verify(&mut self) -> Result<(), &'static str> {
        self.verified = false;
        tokio::time::timeout(Duration::from_secs(60), self.verify_inner())
            .await
            .map_err(|_| "模型召回验证超过60秒")?
    }

    async fn verify_inner(&mut self) -> Result<(), &'static str> {
        let info = self.call(Method::GET, "", None).await?;
        if !matches!(
            info["result"]["status"].as_str(),
            Some("green" | "yellow" | "grey")
        ) || info["result"]["optimizer_status"] != "ok"
        {
            return Err("模型召回集合不可服务");
        }
        let sparse = &info["result"]["config"]["params"]["sparse_vectors"]["model"];
        if !sparse.is_object()
            || (!sparse["modifier"].is_null() && sparse["modifier"] != "none")
            || (!sparse["index"]["datatype"].is_null() && sparse["index"]["datatype"] != "float32")
        {
            return Err("模型召回集合改变了点积语义");
        }
        for field in [
            "candidate_id",
            "catalog_sha256",
            "domain",
            "tags",
            "projection",
        ] {
            if info["result"]["payload_schema"][field]["data_type"] != "keyword" {
                return Err("模型召回集合缺少关键词索引");
            }
        }
        let count = self
            .call(
                Method::POST,
                "/points/count?consistency=all",
                Some(json!({"exact":true})),
            )
            .await?;
        if count["result"]["count"].as_u64() != Some(self.projection.catalog().items.len() as u64) {
            return Err("模型召回点数与固定目录不符");
        }
        for (start, batch) in self.projection.catalog().items.chunks(32).enumerate() {
            let wanted: HashMap<_, _> = batch
                .iter()
                .enumerate()
                .map(|(i, item)| (point_id(&self.catalog_sha256, &item.id), start * 32 + i))
                .collect();
            let read = self
                .call(
                    Method::POST,
                    "/points?consistency=all",
                    Some(json!({"ids":wanted.keys().collect::<Vec<_>>(),
                    "with_vector":true,"with_payload":true})),
                )
                .await?;
            let points = read["result"].as_array().ok_or("模型召回读回结构无效")?;
            if points.len() != batch.len() {
                return Err("模型召回读回点缺失");
            }
            let mut seen = HashSet::new();
            for point in points {
                let id = point["id"].as_str().ok_or("模型召回读回标识无效")?;
                let index = *wanted.get(id).ok_or("模型召回返回未请求的点")?;
                if !seen.insert(id) {
                    return Err("模型召回重复读回点");
                }
                let item = &self.projection.catalog().items[index];
                let payload = &point["payload"];
                if payload["candidate_id"] != item.id
                    || payload["domain"] != item.domain
                    || payload["tags"] != json!(item.tags)
                    || payload["catalog_sha256"] != self.catalog_sha256
                    || payload["projection"] != MODEL_RECALL_SCHEMA
                    || point["vector"].as_object().is_none_or(|v| v.len() != 1)
                {
                    return Err("模型召回读回属性不符");
                }
                let vector: SparseProjection =
                    serde_json::from_value(point["vector"]["model"].clone())
                        .map_err(|_| "模型召回向量无效")?;
                let expected = self
                    .projection
                    .point(index)
                    .map_err(|_| "模型召回候选无效")?;
                if vector.indices != expected.indices || vector.values != expected.values {
                    return Err("模型召回字典或权重不符");
                }
            }
        }
        self.verified = true;
        Ok(())
    }

    pub async fn query(
        &self,
        request: &RecommendationRequest,
        now: u64,
        model: &LearnedRanker,
        limit: usize,
    ) -> Result<ModelRecallCandidates, &'static str> {
        self.query_with_response(request, now, model, limit, ModelRecallResponse::Payload)
            .await
    }

    pub async fn query_with_response(
        &self,
        request: &RecommendationRequest,
        now: u64,
        model: &LearnedRanker,
        limit: usize,
        response: ModelRecallResponse,
    ) -> Result<ModelRecallCandidates, &'static str> {
        if !self.verified {
            return Err("模型召回集合尚未完整校验");
        }
        if !(request.limit..=512).contains(&limit) || limit == 0 {
            return Err("模型召回预算必须覆盖请求且不大于512");
        }
        let context =
            RequestContext::new(request, now).map_err(|_| "模型召回请求过期、越权或无效")?;
        let vector = self
            .projection
            .query(request, now, model)
            .map_err(|_| "模型召回模型或请求不符")?;
        let negative_query_weights = vector.values.iter().any(|value| *value < 0.0);
        let query_dimensions = vector.indices.len();
        let mut must_not = Vec::new();
        if let Some(profile) = &request.profile {
            if !profile.blocked_ids.is_empty() {
                must_not.push(json!({"key":"candidate_id","match":{"any":profile.blocked_ids}}));
            }
            if !profile.denied_tags.is_empty() {
                must_not.push(json!({"key":"tags","match":{"any":profile.denied_tags}}));
            }
        }
        let with_payload = match response {
            ModelRecallResponse::Payload => json!(["candidate_id", "catalog_sha256", "projection"]),
            ModelRecallResponse::IdOnly => json!(false),
        };
        let body = json!({"query":vector,"using":"model","limit":limit,
            "with_vector":false,"with_payload":with_payload,
            "filter":{"must":[
                {"key":"catalog_sha256","match":{"value":self.catalog_sha256}},
                {"key":"projection","match":{"value":MODEL_RECALL_SCHEMA}},
                {"key":"domain","match":{"any":request.domains}}
            ],"must_not":must_not},"timeout":1});
        let encoded = serde_json::to_vec(&body).map_err(|_| "模型召回请求编码失败")?;
        if encoded.len() > 256 * 1024 {
            return Err("模型召回请求超过预算");
        }
        let request_body_bytes = encoded.len();
        let (value, response_body_bytes): (Value, usize) = QdrantRecall::json_measured(
            self.client
                .request(
                    Method::POST,
                    &format!("/collections/{}/points/query", self.collection()),
                )
                .header("content-type", "application/json")
                .body(encoded),
        )
        .await?;
        let points = value["result"]["points"]
            .as_array()
            .ok_or("模型召回响应结构无效")?;
        if points.len() > limit {
            return Err("模型召回候选数量超过预算");
        }
        let mut indices = Vec::new();
        let mut seen = HashSet::new();
        for point in points {
            let index = *point["id"]
                .as_str()
                .and_then(|id| self.points.get(id))
                .ok_or("模型召回返回未知或无效的固定点ID")?;
            if !point["score"].as_f64().is_some_and(f64::is_finite) {
                return Err("模型召回响应分数无效");
            }
            if response == ModelRecallResponse::Payload {
                let payload = &point["payload"];
                if payload["catalog_sha256"] != self.catalog_sha256
                    || payload["projection"] != MODEL_RECALL_SCHEMA
                    || payload["candidate_id"] != self.projection.catalog().items[index].id
                {
                    return Err("模型召回响应属性与固定点ID不符");
                }
            }
            if !seen.insert(index) || !context.allows(&self.projection.catalog().items[index]) {
                return Err("模型召回候选重复或越过授权过滤");
            }
            indices.push(index);
        }
        Ok(ModelRecallCandidates {
            indices,
            request_body_bytes,
            response_body_bytes,
            negative_query_weights,
            query_dimensions,
        })
    }
}
