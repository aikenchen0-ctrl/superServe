use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    DomainError,
    catalog::{Candidate, PublicCatalog},
    event_order::SampleChronology,
    recommendation::{RecommendationRequest, RequestContext},
    upstream::ftrl::Ftrl,
    valid_id,
};

pub const FEATURE_COUNT: usize = 6;
pub const MAX_MODEL_DOMAINS: usize = 64;
pub const MAX_TRAINING_SAMPLES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrainingDataKind {
    Synthetic,
    Observed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreferenceFeedback {
    Like,
    Dislike,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrainingSample {
    pub exposure_id: String,
    pub evidence_ref: String,
    pub profile_as_of: u64,
    pub exposed_at: u64,
    pub feedback_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chronology: Option<SampleChronology>,
    pub request: RecommendationRequest,
    pub candidate_id: String,
    pub feedback: PreferenceFeedback,
}

impl TrainingSample {
    pub fn has_valid_time_order(&self) -> bool {
        match &self.chronology {
            Some(chronology) => self.exposed_at <= self.feedback_at && chronology.proves_order(),
            None => self.exposed_at < self.feedback_at,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RankTrainingSet {
    pub schema: String,
    pub data_kind: TrainingDataKind,
    pub catalog_sha256: String,
    pub catalog_as_of: u64,
    pub train_before: u64,
    pub samples: Vec<TrainingSample>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LinearRankModel {
    pub schema: String,
    pub feature_schema: String,
    pub objective: String,
    pub catalog_version: String,
    pub catalog_sha256: String,
    pub data_kind: TrainingDataKind,
    pub trained_before: u64,
    pub training_samples: usize,
    pub positive_samples: usize,
    pub domains: Vec<String>,
    pub weights: Vec<f64>,
}

/// 只保存推理权重；特征不含主体、候选ID或原始私人内容。
pub struct LearnedRanker {
    catalog_version: String,
    trained_before: u64,
    global: [f64; FEATURE_COUNT],
    domains: HashMap<String, [f64; FEATURE_COUNT]>,
}

impl LearnedRanker {
    pub fn new(model: &LinearRankModel, catalog: &PublicCatalog) -> Result<Self, DomainError> {
        catalog.validate()?;
        if model.schema != "ftrl-ranker-v1"
            || model.feature_schema != "profile-candidate-6-v1"
            || model.objective != "explicit-preference-v1"
            || model.catalog_version != catalog.version
            || !is_sha256(&model.catalog_sha256)
            || model.trained_before == 0
            || !(2..=MAX_TRAINING_SAMPLES).contains(&model.training_samples)
            || model.positive_samples == 0
            || model.positive_samples >= model.training_samples
            || model.domains.is_empty()
            || model.domains.len() > MAX_MODEL_DOMAINS
            || model.domains.windows(2).any(|pair| pair[0] >= pair[1])
            || model.domains.iter().any(|domain| {
                !valid_id(domain) || !catalog.items.iter().any(|item| &item.domain == domain)
            })
            || model.weights.len() != FEATURE_COUNT * (1 + model.domains.len())
            || model
                .weights
                .iter()
                .any(|weight| !weight.is_finite() || weight.abs() > 100.0)
        {
            return Err(DomainError::Invalid("rank_model"));
        }
        let global: [f64; FEATURE_COUNT] = model.weights[..FEATURE_COUNT].try_into().unwrap();
        let domains = model
            .domains
            .iter()
            .zip(model.weights[FEATURE_COUNT..].chunks_exact(FEATURE_COUNT))
            .map(|(name, weights)| {
                (
                    name.clone(),
                    std::array::from_fn(|index| weights[index] + global[index]),
                )
            })
            .collect();
        Ok(Self {
            catalog_version: model.catalog_version.clone(),
            trained_before: model.trained_before,
            global,
            domains,
        })
    }

    pub fn catalog_version(&self) -> &str {
        &self.catalog_version
    }

    pub fn trained_before(&self) -> u64 {
        self.trained_before
    }

    pub(crate) fn weights_for_domain(&self, domain: &str) -> &[f64; FEATURE_COUNT] {
        self.domains.get(domain).unwrap_or(&self.global)
    }

    /// 分数是未校准的线性值，不作为点击概率或事实置信度。
    // 特征或求和逻辑改变时，须同步核对model_pruned依赖的组内先验单调性。
    pub fn score(&self, context: &RequestContext<'_>, item: &Candidate) -> f64 {
        let weights = self.weights_for_domain(&item.domain);
        features(context, item)
            .iter()
            .zip(weights)
            .map(|(value, weight)| value * weight)
            .sum()
    }
}

fn features(context: &RequestContext<'_>, item: &Candidate) -> [f64; FEATURE_COUNT] {
    let mut positive = 0.0;
    let mut negative = 0.0;
    let mut matched = 0.0;
    for tag in &item.tags {
        let weight = f64::from(
            context
                .interests()
                .get(tag.as_str())
                .copied()
                .unwrap_or(0.0),
        );
        positive += weight.max(0.0);
        negative += weight.min(0.0);
        matched += f64::from(weight != 0.0);
    }
    let count = item.tags.len().max(1) as f64;
    [
        1.0,
        f64::from(item.prior),
        positive / count,
        negative / count,
        matched / count,
        f64::from(context.has_nonzero_interest()),
    ]
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 输入须由可信导出器冻结曝光时投影；时间字段不能自行证明来源与授权真实。
fn validate_training(
    catalog: &PublicCatalog,
    training: &RankTrainingSet,
) -> Result<(Vec<String>, usize), DomainError> {
    catalog.validate()?;
    if !matches!(
        training.schema.as_str(),
        "rank-training-v1" | "rank-training-v2"
    ) || !is_sha256(&training.catalog_sha256)
        || training.catalog_as_of >= training.train_before
        || !(2..=MAX_TRAINING_SAMPLES).contains(&training.samples.len())
    {
        return Err(DomainError::Invalid("rank_training"));
    }
    let candidates: HashMap<_, _> = catalog
        .items
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let mut exposures = HashSet::new();
    let mut judgments = HashSet::new();
    let mut domains = BTreeSet::new();
    let mut positives = 0;
    let mut previous = 0;
    // 先验证完整数据集，再训练；不得静默丢弃越权样本或未来标签。
    for sample in &training.samples {
        let item = candidates
            .get(sample.candidate_id.as_str())
            .ok_or(DomainError::Invalid("training_candidate"))?;
        if !valid_id(&sample.exposure_id)
            || !valid_id(&sample.evidence_ref)
            || !exposures.insert(&sample.exposure_id)
            || !judgments.insert((&sample.request.request_id, &sample.candidate_id))
            || training.catalog_as_of > sample.exposed_at
            || sample.profile_as_of > sample.exposed_at
            || !sample.has_valid_time_order()
            || (training.schema == "rank-training-v1" && sample.chronology.is_some())
            || sample.feedback_at >= training.train_before
            || sample.feedback_at < previous
        {
            return Err(DomainError::Invalid("training_time_or_duplicate"));
        }
        let context = RequestContext::new(&sample.request, sample.exposed_at)?;
        if !context.allows(item) {
            return Err(DomainError::ScopeDenied);
        }
        domains.insert(item.domain.clone());
        positives += usize::from(matches!(sample.feedback, PreferenceFeedback::Like));
        previous = sample.feedback_at;
    }
    if positives == 0 || positives == training.samples.len() || domains.len() > MAX_MODEL_DOMAINS {
        return Err(DomainError::Invalid("training_classes_or_domains"));
    }
    let domains: Vec<_> = domains.into_iter().collect();
    Ok((domains, positives))
}

pub fn validate_training_set(
    catalog: &PublicCatalog,
    training: &RankTrainingSet,
) -> Result<(), DomainError> {
    validate_training(catalog, training).map(|_| ())
}

pub fn train_rank_model(
    catalog: &PublicCatalog,
    training: &RankTrainingSet,
) -> Result<LinearRankModel, DomainError> {
    let (domains, positives) = validate_training(catalog, training)?;
    let candidates: HashMap<_, _> = catalog
        .items
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let mut optimizer = Ftrl::new(FEATURE_COUNT * (1 + domains.len()));
    for sample in &training.samples {
        let item = candidates[sample.candidate_id.as_str()];
        let context = RequestContext::new(&sample.request, sample.exposed_at)?;
        let offset = FEATURE_COUNT * (1 + domains.binary_search(&item.domain).unwrap());
        optimizer.learn(
            &features(&context, item),
            offset,
            matches!(sample.feedback, PreferenceFeedback::Like),
        )?;
    }
    let model = LinearRankModel {
        schema: "ftrl-ranker-v1".into(),
        feature_schema: "profile-candidate-6-v1".into(),
        objective: "explicit-preference-v1".into(),
        catalog_version: catalog.version.clone(),
        catalog_sha256: training.catalog_sha256.clone(),
        data_kind: training.data_kind,
        trained_before: training.train_before,
        training_samples: training.samples.len(),
        positive_samples: positives,
        domains,
        weights: optimizer.weights(),
    };
    LearnedRanker::new(&model, catalog)?;
    Ok(model)
}
