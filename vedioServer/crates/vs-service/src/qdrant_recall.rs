use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    recall::{CatalogRecall, PERSONALIZED_RECALL_LIMIT, RecallScoring},
    recommendation::RecommendationRequest,
    valid_id,
};

const VERIFY_BATCH: usize = 32;
const TAG_DICTIONARY: &str = "sorted-tags-v1";

#[derive(Debug, Clone, Serialize)]
pub struct RecallReadiness {
    pub schema: &'static str,
    pub collection: String,
    pub alias: String,
    pub catalog_sha256: String,
    pub points_verified: usize,
    pub tag_dictionary: &'static str,
    pub read_consistency: &'static str,
}

#[derive(Deserialize)]
struct Envelope<T> {
    result: T,
}

#[derive(Deserialize)]
struct AliasList {
    aliases: Vec<Alias>,
}

#[derive(Deserialize)]
struct Alias {
    alias_name: String,
    collection_name: String,
}

#[derive(Deserialize)]
struct SparseVector {
    indices: Vec<u32>,
    values: Vec<f32>,
}

#[derive(Deserialize)]
struct IndexedPayload {
    candidate_id: String,
    domain: String,
    tags: Vec<String>,
    catalog_sha256: String,
}

#[derive(Deserialize)]
struct IndexedPoint {
    id: String,
    payload: IndexedPayload,
    vector: HashMap<String, SparseVector>,
}

#[derive(Deserialize)]
struct ExactCount {
    count: usize,
}

pub(crate) fn point_id(catalog_sha256: &str, id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(format!("{catalog_sha256}:{id}")));
    format!(
        "{}-{}-{}-{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32]
    )
}

pub struct QdrantConfig {
    pub endpoint: String,
    pub api_key: Option<String>,
    pub scoring: RecallScoring,
}

pub struct QdrantRecall {
    client: Client,
    endpoint: String,
    api_key: Option<String>,
    catalog_sha256: String,
    scoring: RecallScoring,
    verification_slots: Semaphore,
}

impl QdrantRecall {
    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn new(config: QdrantConfig, catalog_sha256: String) -> Result<Self, &'static str> {
        let url = Url::parse(&config.endpoint).map_err(|_| "invalid_recall_endpoint")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || catalog_sha256.len() != 64
            || !catalog_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || config.api_key.as_ref().is_some_and(|key| {
                key.is_empty() || key.len() > 256 || !key.bytes().all(|b| b.is_ascii_graphic())
            })
        {
            return Err("invalid_recall_configuration");
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_millis(300))
            .timeout(Duration::from_millis(800))
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|_| "recall_client_failed")?;
        Ok(Self {
            client,
            endpoint: url.as_str().trim_end_matches('/').into(),
            api_key: config.api_key,
            catalog_sha256,
            scoring: config.scoring,
            verification_slots: Semaphore::new(1),
        })
    }

    pub fn scoring(&self) -> RecallScoring {
        self.scoring
    }

    pub fn collection(&self) -> String {
        format!("vs_tags_{}", self.catalog_sha256)
    }

    pub fn physical_collection(&self) -> String {
        format!("vs_build_{}", self.catalog_sha256)
    }

    pub(crate) fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let mut builder = self
            .client
            .request(method, format!("{}{path}", self.endpoint));
        if let Some(key) = &self.api_key {
            builder = builder.header("api-key", key);
        }
        builder
    }

    pub(crate) async fn json<T: DeserializeOwned>(
        builder: reqwest::RequestBuilder,
    ) -> Result<T, &'static str> {
        Self::json_measured(builder).await.map(|(value, _)| value)
    }

    pub(crate) async fn json_measured<T: DeserializeOwned>(
        builder: reqwest::RequestBuilder,
    ) -> Result<(T, usize), &'static str> {
        const MAX_BYTES: usize = 262_144;
        let mut response = builder.send().await.map_err(|_| "recall_unavailable")?;
        if !response.status().is_success() {
            return Err("recall_response_status");
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BYTES as u64)
        {
            return Err("recall_response_too_large");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "recall_body_failed")? {
            if chunk.len() > MAX_BYTES - bytes.len() {
                return Err("recall_response_too_large");
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| "recall_invalid_json")?;
        Ok((value, bytes.len()))
    }

    pub async fn query(
        &self,
        request: &RecommendationRequest,
        indices: Vec<u32>,
        values: Vec<f32>,
    ) -> Result<Vec<String>, &'static str> {
        if indices.is_empty()
            || indices.len() > 128
            || indices.len() != values.len()
            || indices.windows(2).any(|pair| pair[0] >= pair[1])
            || values.iter().any(|value| {
                !value.is_finite()
                    || !(-1.0..=1.0).contains(value)
                    || !self.scoring.includes(*value)
            })
        {
            return Err("recall_invalid_vector");
        }
        let mut must_not = Vec::new();
        if let Some(profile) = &request.profile {
            if !profile.blocked_ids.is_empty() {
                must_not.push(json!({"key":"candidate_id","match":{"any":profile.blocked_ids}}));
            }
            if !profile.denied_tags.is_empty() {
                must_not.push(json!({"key":"tags","match":{"any":profile.denied_tags}}));
            }
        }
        let body = json!({
            "query":{"indices":indices,"values":values}, "using":"tags",
            "score_threshold":f32::MIN_POSITIVE,
            "filter":{"must":[
                {"key":"catalog_sha256","match":{"value":self.catalog_sha256}},
                {"key":"domain","match":{"any":request.domains}}
            ],"must_not":must_not},
            "limit":PERSONALIZED_RECALL_LIMIT, "with_vector":false,
            "with_payload":["candidate_id","catalog_sha256"], "timeout":1
        });
        let value: Value = Self::json(
            self.request(
                Method::POST,
                &format!("/collections/{}/points/query", self.physical_collection()),
            )
            .json(&body),
        )
        .await?;
        let points = value["result"]["points"]
            .as_array()
            .ok_or("recall_invalid_points")?;
        if points.len() > PERSONALIZED_RECALL_LIMIT {
            return Err("recall_too_many_points");
        }
        let mut ids = Vec::new();
        for point in points {
            let payload = &point["payload"];
            let id = payload["candidate_id"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or("recall_invalid_candidate")?;
            if payload["catalog_sha256"] != self.catalog_sha256 {
                return Err("recall_catalog_mismatch");
            }
            ids.push(id.to_string());
        }
        Ok(ids)
    }

    async fn verify_alias(&self) -> Result<(), &'static str> {
        let response: Envelope<AliasList> = Self::json(
            self.request(
                Method::GET,
                &format!("/collections/{}/aliases", self.physical_collection()),
            )
            .timeout(Duration::from_secs(5)),
        )
        .await
        .map_err(|_| "索引别名读取失败")?;
        let expected = self.collection();
        let aliases: Vec<_> = response
            .result
            .aliases
            .iter()
            .filter(|alias| alias.alias_name == expected)
            .collect();
        if aliases.len() != 1 || aliases[0].collection_name != self.physical_collection() {
            return Err("索引发布别名未绑定预期物理集合");
        }
        Ok(())
    }

    async fn inspect_collection(&self) -> Result<(), &'static str> {
        let info: Envelope<Value> = Self::json(self.request(
            Method::GET,
            &format!("/collections/{}", self.physical_collection()),
        ))
        .await
        .map_err(|_| "索引集合读取失败")?;
        let info = info.result;
        // Yellow和Grey仍可查询；近似points_count不能作为完整发布证明。
        if !matches!(info["status"].as_str(), Some("green" | "yellow" | "grey"))
            || info["optimizer_status"] != "ok"
        {
            return Err("索引集合状态不可服务");
        }
        let queue = &info["update_queue"];
        let deferred = &queue["deferred_points"];
        if !queue.is_null()
            && (!queue.is_object()
                || queue["length"].as_u64() != Some(0)
                || (!deferred.is_null() && deferred.as_u64() != Some(0)))
        {
            return Err("索引仍有待处理或暂不可搜索的点");
        }
        let sparse = &info["config"]["params"]["sparse_vectors"]["tags"];
        if !sparse.is_object()
            || (!sparse["modifier"].is_null() && sparse["modifier"] != "none")
            || (!sparse["index"]["datatype"].is_null() && sparse["index"]["datatype"] != "float32")
        {
            return Err("标签索引配置改变了评分语义");
        }
        for field in ["candidate_id", "catalog_sha256", "domain", "tags"] {
            if info["payload_schema"][field]["data_type"] != "keyword" {
                return Err("索引缺少所需的关键词字段");
            }
        }
        Ok(())
    }

    /// 健康探针只检查已固定物理集合的状态和结构，不重复全量读回。
    pub async fn probe_ready(&self) -> Result<(), &'static str> {
        let _permit = self
            .verification_slots
            .try_acquire()
            .map_err(|_| "索引校验并发预算已满")?;
        self.inspect_collection().await
    }

    /// 启动时全量核对公开候选与稀疏向量；校验是只读快照，不是写入隔离或永久证明。
    pub async fn verify_published(
        &self,
        catalog_bytes: &[u8],
    ) -> Result<RecallReadiness, &'static str> {
        let _permit = self
            .verification_slots
            .try_acquire()
            .map_err(|_| "索引校验并发预算已满")?;
        tokio::time::timeout(
            Duration::from_secs(60),
            self.verify_contents(catalog_bytes, true),
        )
        .await
        .map_err(|_| "索引全量校验超过60秒")?
    }

    async fn verify_contents(
        &self,
        catalog_bytes: &[u8],
        require_alias: bool,
    ) -> Result<RecallReadiness, &'static str> {
        if catalog_bytes.len() > 8 * 1024 * 1024
            || format!("{:x}", Sha256::digest(catalog_bytes)) != self.catalog_sha256
        {
            return Err("校验目录指纹不符");
        }
        let catalog: PublicCatalog =
            serde_json::from_slice(catalog_bytes).map_err(|_| "校验目录JSON无效")?;
        catalog.validate().map_err(|_| "校验目录声明无效")?;
        let index = CatalogRecall::new(&catalog);
        let expected: Vec<_> = catalog
            .items
            .iter()
            .filter(|item| !item.tags.is_empty())
            .collect();
        if require_alias {
            self.verify_alias().await?;
        }
        self.inspect_collection().await?;
        let count: Envelope<ExactCount> = Self::json(
            self.request(
                Method::POST,
                &format!(
                    "/collections/{}/points/count?consistency=all&timeout=5",
                    self.physical_collection()
                ),
            )
            .timeout(Duration::from_secs(5))
            .json(&json!({"exact":true})),
        )
        .await
        .map_err(|_| "索引精确计数失败")?;
        if count.result.count != expected.len() {
            return Err("索引真实点数与目录不符");
        }
        for batch in expected.chunks(VERIFY_BATCH) {
            let wanted: HashMap<_, _> = batch
                .iter()
                .map(|item| (point_id(&self.catalog_sha256, &item.id), *item))
                .collect();
            let points: Envelope<Vec<IndexedPoint>> = Self::json(
                self.request(
                    Method::POST,
                    &format!(
                        "/collections/{}/points?consistency=all&timeout=5",
                        self.physical_collection()
                    ),
                )
                .timeout(Duration::from_secs(5))
                .json(&json!({
                    "ids":wanted.keys().collect::<Vec<_>>(),
                    "with_payload":["candidate_id","domain","tags","catalog_sha256"],
                    "with_vector":["tags"]
                })),
            )
            .await
            .map_err(|_| "索引候选及向量读取失败")?;
            if points.result.len() != wanted.len() {
                return Err("索引候选缺失或数量异常");
            }
            let mut seen = HashSet::new();
            for point in &points.result {
                let item = wanted.get(&point.id).ok_or("索引返回未请求的点")?;
                if !seen.insert(&point.id) {
                    return Err("索引重复返回同一点");
                }
                self.verify_point(point, item, &index)?;
            }
        }
        // 首尾检查只提供快照证据；后续查询固定物理集合，绕开别名重绑。
        if require_alias {
            self.verify_alias().await?;
        }
        self.inspect_collection().await?;
        Ok(RecallReadiness {
            schema: "qdrant-index-readiness-v1",
            collection: self.physical_collection(),
            alias: self.collection(),
            catalog_sha256: self.catalog_sha256.clone(),
            points_verified: expected.len(),
            tag_dictionary: TAG_DICTIONARY,
            read_consistency: "all",
        })
    }

    fn verify_point(
        &self,
        point: &IndexedPoint,
        item: &Candidate,
        index: &CatalogRecall,
    ) -> Result<(), &'static str> {
        let payload = &point.payload;
        if payload.candidate_id != item.id
            || payload.domain != item.domain
            || payload.catalog_sha256 != self.catalog_sha256
        {
            return Err("索引候选属性与目录不符");
        }
        let mut tags: HashSet<_> = item.tags.iter().map(String::as_str).collect();
        if payload.tags.len() != item.tags.len()
            || payload.tags.iter().any(|tag| !tags.remove(tag.as_str()))
            || !tags.is_empty()
        {
            return Err("索引候选标签与目录不符");
        }
        let vector = point.vector.get("tags").ok_or("索引缺少标签向量")?;
        let (indices, values) = index.vector(&item.tags);
        // 标签特征无顺序语义；允许等价排列，但拒绝重复维度和不同权重。
        let mut actual: Vec<_> = vector
            .indices
            .iter()
            .copied()
            .zip(vector.values.iter().copied())
            .collect();
        actual.sort_unstable_by_key(|(index, _)| *index);
        if point.vector.len() != 1
            || vector.indices.len() != vector.values.len()
            || actual.into_iter().ne(indices.into_iter().zip(values))
        {
            return Err("索引标签字典或向量权重不符");
        }
        Ok(())
    }

    /// 离线发布独立版本索引；已有同名集合拒绝覆盖，部分发布需由操作者检查。
    pub async fn publish(&self, catalog_bytes: &[u8]) -> Result<Value, &'static str> {
        if catalog_bytes.len() > 8 * 1024 * 1024
            || format!("{:x}", Sha256::digest(catalog_bytes)) != self.catalog_sha256
        {
            return Err("recall_catalog_fingerprint_mismatch");
        }
        let catalog: PublicCatalog =
            serde_json::from_slice(catalog_bytes).map_err(|_| "recall_catalog_invalid")?;
        catalog.validate().map_err(|_| "recall_catalog_invalid")?;
        let index = CatalogRecall::new(&catalog);
        let alias = self.collection();
        let collection = self.physical_collection();
        let create: Value = Self::json(
            self.request(Method::PUT, &format!("/collections/{collection}"))
                .timeout(Duration::from_secs(20))
                .json(&json!({
                    "vectors":{}, "sparse_vectors":{"tags":{"index":{"on_disk":false}}}
                })),
        )
        .await?;
        if create["result"] != true {
            return Err("recall_collection_create_failed");
        }
        for field in ["candidate_id", "catalog_sha256", "domain", "tags"] {
            let _: Value = Self::json(
                self.request(
                    Method::PUT,
                    &format!("/collections/{collection}/index?wait=true"),
                )
                .timeout(Duration::from_secs(20))
                .json(&json!({"field_name":field,"field_schema":"keyword"})),
            )
            .await?;
        }
        let mut written = 0;
        for batch in catalog.items.chunks(128) {
            let points: Vec<_> = batch.iter().filter(|item| !item.tags.is_empty()).map(|item| {
                let uuid = point_id(&self.catalog_sha256, &item.id);
                let (indices, values) = index.vector(&item.tags);
                json!({"id":uuid, "vector":{"tags":{"indices":indices,"values":values}}, "payload":{
                    "candidate_id":item.id,"domain":item.domain,"tags":item.tags,"catalog_sha256":self.catalog_sha256
                }})
            }).collect();
            if !points.is_empty() {
                written += points.len();
                let value: Value = Self::json(
                    self.request(
                        Method::PUT,
                        &format!("/collections/{collection}/points?wait=true"),
                    )
                    .timeout(Duration::from_secs(20))
                    .json(&json!({"points":points})),
                )
                .await?;
                if value["result"]["status"] != "completed" {
                    return Err("recall_publish_incomplete");
                }
            }
        }
        let readiness = {
            let _permit = self
                .verification_slots
                .try_acquire()
                .map_err(|_| "索引校验并发预算已满")?;
            tokio::time::timeout(
                Duration::from_secs(60),
                self.verify_contents(catalog_bytes, false),
            )
            .await
            .map_err(|_| "索引全量校验超过60秒")??
        };
        // 完整读回通过后才发布别名，部分或损坏构建不会获得发布入口。
        let published: Value = Self::json(
            self.request(Method::POST, "/collections/aliases")
                .timeout(Duration::from_secs(20))
                .json(&json!({"actions":[{
                    "create_alias":{"collection_name":collection,"alias_name":alias}
                }]})),
        )
        .await?;
        if published["result"] != true {
            return Err("recall_alias_publish_failed");
        }
        self.verify_alias().await?;
        Ok(json!({
            "collection":collection,"alias":alias,"catalog_sha256":self.catalog_sha256,
            "points":written,"tag_dictionary":TAG_DICTIONARY,"readiness":readiness
        }))
    }
}
