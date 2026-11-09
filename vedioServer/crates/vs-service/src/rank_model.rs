use std::{io, io::Write, path::Path, sync::Arc};

use axum::{http::HeaderValue, response::Response};
use serde::Serialize;
use sha2::{Digest, Sha256};
use vs_core::{
    DomainError,
    catalog::PublicCatalog,
    grouped_recall::{GroupedIndexLayout, GroupedRecall},
    learning::{
        LearnedRanker, LinearRankModel, RankTrainingSet, TrainingDataKind, train_rank_model,
    },
    model_top_k::recommend_model_top_k,
    recommendation::{RecommendationRequest, RecommendationResponse, recommend_with_model},
    training_split::{TemporalSplitAudit, TemporalSplitConfig, temporal_split},
};

use crate::{AppState, upstream::atomic_create::atomic_create};

pub const MAX_RANK_MODEL_BYTES: usize = 128 * 1024;
pub const MAX_TRAINING_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct RankModelState {
    pub(crate) ranker: LearnedRanker,
    pub(crate) sha256: String,
    pub(crate) data_kind: TrainingDataKind,
}

#[derive(Clone, Default)]
pub(crate) enum ModelSelection {
    #[default]
    Full,
    TopK,
    Pruned(Arc<GroupedRecall>),
    BlockMax(Arc<GroupedRecall>),
}

impl ModelSelection {
    pub(crate) fn backend(&self) -> &'static str {
        match self {
            Self::Full => "catalog",
            Self::TopK => "model-topk",
            Self::Pruned(_) => "model-pruned",
            Self::BlockMax(_) => "model-blockmax",
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        !matches!(self, Self::Full)
    }

    pub(crate) fn index_layout(&self) -> Option<GroupedIndexLayout> {
        match self {
            Self::Pruned(index) | Self::BlockMax(index) => Some(index.allocation_layout()),
            _ => None,
        }
    }
}

pub(crate) fn validate_rank_model(
    bytes: &[u8],
    expected_sha256: &str,
    catalog: &PublicCatalog,
    catalog_sha256: &str,
) -> Result<RankModelState, String> {
    if bytes.len() > MAX_RANK_MODEL_BYTES
        || format!("{:x}", Sha256::digest(bytes)) != expected_sha256
    {
        return Err("排序模型过大或与指定指纹不符".into());
    }
    let model: LinearRankModel = serde_json::from_slice(bytes).map_err(|_| "排序模型JSON无效")?;
    if model.catalog_sha256 != catalog_sha256 {
        return Err("排序模型与实例目录指纹不符".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "模型校验时系统时钟不可用")?
        .as_secs();
    if model.trained_before > now {
        return Err("排序模型训练截止时间尚未到达".into());
    }
    let ranker = LearnedRanker::new(&model, catalog).map_err(|_| "排序模型结构或参数无效")?;
    Ok(RankModelState {
        ranker,
        sha256: expected_sha256.into(),
        data_kind: model.data_kind,
    })
}

impl AppState {
    pub fn with_rank_model(mut self, bytes: &[u8], expected_sha256: &str) -> Result<Self, String> {
        if self.rank_model.is_some()
            || self.feedback_log.is_some()
            || self.profile_authority
            || self.recall.is_some()
            || self.grouped_recall.is_some()
            || self.deployment.is_some()
        {
            return Err("学习排序不支持旧标签召回，不能重复加载或修改已绑定部署".into());
        }
        self.rank_model = Some(Arc::new(validate_rank_model(
            bytes,
            expected_sha256,
            &self.catalog,
            &self.catalog_sha256,
        )?));
        Ok(self)
    }

    pub fn with_model_top_k(mut self) -> Result<Self, String> {
        if self.rank_model.is_none()
            || self.model_selection.enabled()
            || self.profile_authority
            || self.recall.is_some()
            || self.grouped_recall.is_some()
            || self.deployment.is_some()
        {
            return Err("精确模型选择需要先加载模型，且不能与旧召回或已绑定部署共用".into());
        }
        self.model_selection = ModelSelection::TopK;
        Ok(self)
    }

    pub fn with_model_pruned(self) -> Result<Self, String> {
        let mut state = self.with_model_top_k()?;
        let index =
            GroupedRecall::new(state.catalog.clone()).map_err(|_| "模型分组索引构建失败")?;
        state.model_selection = ModelSelection::Pruned(Arc::new(index));
        Ok(state)
    }

    pub fn with_model_blockmax(self) -> Result<Self, String> {
        let mut state = self.with_model_top_k()?;
        let index =
            GroupedRecall::new(state.catalog.clone()).map_err(|_| "模型分组索引构建失败")?;
        state.model_selection = ModelSelection::BlockMax(Arc::new(index));
        Ok(state)
    }
}

pub(crate) fn recommend(
    catalog: &PublicCatalog,
    request: &RecommendationRequest,
    now: u64,
    model: Option<&RankModelState>,
    selection: &ModelSelection,
) -> Result<RecommendationResponse, DomainError> {
    match selection {
        ModelSelection::Full => {
            recommend_with_model(catalog, request, now, model.map(|model| &model.ranker))
        }
        ModelSelection::TopK => {
            let model = model.ok_or(DomainError::Invalid("model_top_k_without_model"))?;
            recommend_model_top_k(catalog, request, now, &model.ranker)
                .map(|result| result.response)
        }
        ModelSelection::Pruned(index) => {
            let model = model.ok_or(DomainError::Invalid("model_pruned_without_model"))?;
            index
                .recommend_with_model(request, now, &model.ranker)
                .map(|result| result.response)
        }
        ModelSelection::BlockMax(index) => {
            let model = model.ok_or(DomainError::Invalid("model_blockmax_without_model"))?;
            index
                .recommend_with_model_blockmax(request, now, &model.ranker)
                .map(|result| result.response)
        }
    }
}

pub(crate) fn insert_model_header(state: &AppState, response: &mut Response) {
    if let Some(model) = &state.rank_model {
        response.headers_mut().insert(
            "x-rank-model-sha256",
            HeaderValue::from_str(&model.sha256).unwrap(),
        );
    }
}

#[derive(Debug, Serialize)]
pub struct RankModelReceipt {
    pub sha256: String,
    pub bytes: usize,
    pub catalog_sha256: String,
    pub trained_before: u64,
    pub training_samples: usize,
    pub positive_samples: usize,
    pub data_kind: TrainingDataKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temporal_split: Option<TemporalSplitAudit>,
}

/// 只发布新文件；更换模型通过新的指纹和新实例完成，不覆盖运行中的产物。
pub fn train_and_publish_rank_model(
    catalog_bytes: &[u8],
    training_bytes: &[u8],
    target: &Path,
) -> io::Result<RankModelReceipt> {
    train_and_publish(catalog_bytes, training_bytes, None, target)
}

pub fn train_and_publish_temporal_rank_model(
    catalog_bytes: &[u8],
    training_bytes: &[u8],
    split: &TemporalSplitConfig,
    target: &Path,
) -> io::Result<RankModelReceipt> {
    train_and_publish(catalog_bytes, training_bytes, Some(split), target)
}

fn train_and_publish(
    catalog_bytes: &[u8],
    training_bytes: &[u8],
    split: Option<&TemporalSplitConfig>,
    target: &Path,
) -> io::Result<RankModelReceipt> {
    if catalog_bytes.len() > 8 * 1024 * 1024 || training_bytes.len() > MAX_TRAINING_BYTES {
        return Err(io::Error::other("训练目录或样本文件超过预算"));
    }
    let catalog: PublicCatalog =
        serde_json::from_slice(catalog_bytes).map_err(|_| io::Error::other("训练目录JSON无效"))?;
    let mut training: RankTrainingSet =
        serde_json::from_slice(training_bytes).map_err(|_| io::Error::other("训练样本JSON无效"))?;
    if training.catalog_sha256 != format!("{:x}", Sha256::digest(catalog_bytes)) {
        return Err(io::Error::other("训练样本与目录指纹不符"));
    }
    let temporal_split = if let Some(config) = split {
        let result = temporal_split(&catalog, &training, config)
            .map_err(|_| io::Error::other("时间切分的边界、决策归属、证据身份或训练样本不足"))?;
        training = result.training;
        Some(result.audit)
    } else {
        None
    };
    let model = train_rank_model(&catalog, &training)
        .map_err(|_| io::Error::other("训练样本、时间边界、授权范围或数值无效"))?;
    let bytes = serde_json::to_vec(&model).map_err(io::Error::other)?;
    if bytes.len() > MAX_RANK_MODEL_BYTES {
        return Err(io::Error::other("训练产物超过模型预算"));
    }
    atomic_create(target, |writer| writer.write_all(&bytes))?;
    Ok(RankModelReceipt {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len(),
        catalog_sha256: model.catalog_sha256,
        trained_before: model.trained_before,
        training_samples: model.training_samples,
        positive_samples: model.positive_samples,
        data_kind: model.data_kind,
        temporal_split,
    })
}
