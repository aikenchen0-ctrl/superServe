use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

use serde::{Deserialize, Serialize};

use crate::{
    DomainError,
    catalog::{Candidate, PublicCatalog},
    learning::LearnedRanker,
    valid_id,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecommendationRequest {
    pub request_id: String,
    pub domains: Vec<String>,
    pub limit: usize,
    pub profile: Option<ProfileProjection>,
}

/// 仅信任通过服务鉴权的授权网关；该结构本身不授予数据读取权限。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileProjection {
    pub subject: String,
    pub version: String,
    pub scopes: Vec<String>,
    pub expires_at: u64,
    pub interests: Vec<Interest>,
    pub blocked_ids: Vec<String>,
    pub denied_tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Interest {
    pub tag: String,
    pub weight: f32,
}

#[derive(Debug, Serialize)]
pub struct RecommendationResponse {
    pub request_id: String,
    pub catalog_version: String,
    pub profile_version: Option<String>,
    pub ranker: &'static str,
    pub considered: usize,
    pub items: Vec<RankedItem>,
}

#[derive(Debug, Serialize)]
pub struct RankedItem {
    pub id: String,
    pub domain: String,
    pub affinity: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank_score: Option<f64>,
    pub media_path: Option<String>,
}

pub fn recommend(
    catalog: &PublicCatalog,
    request: &RecommendationRequest,
    now: u64,
) -> Result<RecommendationResponse, DomainError> {
    recommend_with_model(catalog, request, now, None)
}

pub fn recommend_with_model(
    catalog: &PublicCatalog,
    request: &RecommendationRequest,
    now: u64,
    model: Option<&LearnedRanker>,
) -> Result<RecommendationResponse, DomainError> {
    let context = RequestContext::new(request, now)?;
    validate_model_catalog(catalog, now, model)?;
    Ok(rank(
        catalog,
        request,
        &context,
        catalog.items.iter(),
        model,
    ))
}

pub fn recommend_subset(
    catalog: &PublicCatalog,
    request: &RecommendationRequest,
    now: u64,
    indices: &[usize],
) -> Result<RecommendationResponse, DomainError> {
    recommend_subset_with_model(catalog, request, now, indices, None)
}

pub fn recommend_subset_with_model(
    catalog: &PublicCatalog,
    request: &RecommendationRequest,
    now: u64,
    indices: &[usize],
    model: Option<&LearnedRanker>,
) -> Result<RecommendationResponse, DomainError> {
    let context = RequestContext::new(request, now)?;
    validate_model_catalog(catalog, now, model)?;
    let mut seen = HashSet::new();
    if indices
        .iter()
        .any(|index| *index >= catalog.items.len() || !seen.insert(*index))
    {
        return Err(DomainError::Invalid("recall_indices"));
    }
    Ok(rank(
        catalog,
        request,
        &context,
        indices.iter().map(|index| &catalog.items[*index]),
        model,
    ))
}

pub(crate) fn validate_model_catalog(
    catalog: &PublicCatalog,
    now: u64,
    model: Option<&LearnedRanker>,
) -> Result<(), DomainError> {
    if model.is_some_and(|model| {
        model.catalog_version() != catalog.version || model.trained_before() > now
    }) {
        return Err(DomainError::Invalid("rank_model_catalog"));
    }
    Ok(())
}

pub struct RequestContext<'a> {
    interests: HashMap<&'a str, f32>,
    has_nonzero_interest: bool,
    domains: &'a [String],
    blocked: HashSet<&'a str>,
    denied: HashSet<&'a str>,
}

impl<'a> RequestContext<'a> {
    pub fn new(request: &'a RecommendationRequest, now: u64) -> Result<Self, DomainError> {
        if !valid_id(&request.request_id)
            || request.domains.is_empty()
            || request.domains.len() > 16
            || request.domains.iter().any(|domain| !valid_id(domain))
            || !(1..=50).contains(&request.limit)
        {
            return Err(DomainError::Invalid("recommendation_request"));
        }
        let mut interests = HashMap::new();
        let mut blocked = HashSet::new();
        let mut denied = HashSet::new();
        if let Some(profile) = &request.profile {
            if !valid_id(&profile.subject)
                || !valid_id(&profile.version)
                || profile.scopes.len() > 16
                || profile.interests.len() > 128
                || profile.blocked_ids.len() > 256
                || profile.denied_tags.len() > 128
                || profile
                    .scopes
                    .iter()
                    .chain(&profile.blocked_ids)
                    .chain(&profile.denied_tags)
                    .any(|value| !valid_id(value))
            {
                return Err(DomainError::Invalid("profile_projection"));
            }
            if profile.expires_at <= now {
                return Err(DomainError::Expired);
            }
            if request
                .domains
                .iter()
                .any(|domain| !profile.scopes.contains(domain))
            {
                return Err(DomainError::ScopeDenied);
            }
            for interest in &profile.interests {
                if !valid_id(&interest.tag)
                    || !interest.weight.is_finite()
                    || !(-1.0..=1.0).contains(&interest.weight)
                    || interests
                        .insert(interest.tag.as_str(), interest.weight)
                        .is_some()
                {
                    return Err(DomainError::Invalid("interest"));
                }
            }
            blocked.extend(profile.blocked_ids.iter().map(String::as_str));
            denied.extend(profile.denied_tags.iter().map(String::as_str));
        }
        Ok(Self {
            has_nonzero_interest: interests.values().any(|weight| *weight != 0.0),
            interests,
            domains: &request.domains,
            blocked,
            denied,
        })
    }

    pub fn allows(&self, item: &Candidate) -> bool {
        self.allows_features(item) && self.allows_id(&item.id)
    }

    pub(crate) fn allows_id(&self, id: &str) -> bool {
        !self.blocked.contains(id)
    }

    pub(crate) fn has_blocked_ids(&self) -> bool {
        !self.blocked.is_empty()
    }

    pub(crate) fn allows_features(&self, item: &Candidate) -> bool {
        self.includes_domain(&item.domain)
            && !item
                .tags
                .iter()
                .any(|tag| self.denied.contains(tag.as_str()))
    }

    pub fn includes_domain(&self, domain: &str) -> bool {
        self.domains.iter().any(|requested| requested == domain)
    }

    pub fn has_nonzero_interest(&self) -> bool {
        self.has_nonzero_interest
    }

    pub fn interests(&self) -> &HashMap<&'a str, f32> {
        &self.interests
    }

    pub fn only_nonpositive_interests(&self) -> bool {
        self.interests.values().any(|weight| *weight < 0.0)
            && self.interests.values().all(|weight| *weight <= 0.0)
    }

    pub fn affinity(&self, item: &Candidate) -> f32 {
        let affinity = item
            .tags
            .iter()
            .map(|tag| self.interests.get(tag.as_str()).copied().unwrap_or(0.0))
            .sum::<f32>()
            / item.tags.len().max(1) as f32;
        // 空集合或极小权重可产生负零；中性分值统一为正零，避免同分排序分裂。
        if affinity == 0.0 { 0.0 } else { affinity }
    }
}

pub(crate) fn rank_order(a: &Candidate, sa: f32, b: &Candidate, sb: f32) -> Ordering {
    sb.total_cmp(&sa)
        .then_with(|| b.prior.total_cmp(&a.prior))
        .then_with(|| a.id.cmp(&b.id))
}

pub(crate) fn learned_rank_order(a: &Candidate, sa: f64, b: &Candidate, sb: f64) -> Ordering {
    sb.total_cmp(&sa)
        .then_with(|| b.prior.total_cmp(&a.prior))
        .then_with(|| a.id.cmp(&b.id))
}

fn rank<'a>(
    catalog: &PublicCatalog,
    request: &RecommendationRequest,
    context: &RequestContext<'_>,
    candidates: impl Iterator<Item = &'a Candidate>,
    model: Option<&LearnedRanker>,
) -> RecommendationResponse {
    // 召回结果仍经过相同的领域、隐藏和拒绝标签校验，外部索引不是授权真相。
    let candidates = candidates.filter(|item| context.allows(item));
    let (items, considered) = if let Some(model) = model {
        let mut scored: Vec<_> = candidates
            .map(|item| (item, context.affinity(item), model.score(context, item)))
            .collect();
        let considered = scored.len();
        scored.sort_unstable_by(|(a, _, sa), (b, _, sb)| learned_rank_order(a, *sa, b, *sb));
        (
            scored
                .into_iter()
                .take(request.limit)
                .map(|(item, affinity, score)| ranked_item(item, affinity, Some(score)))
                .collect(),
            considered,
        )
    } else {
        // 默认路径沿用原二元组，不为关闭的模型增加逐候选分数存储。
        let mut scored: Vec<_> = candidates
            .map(|item| (item, context.affinity(item)))
            .collect();
        let considered = scored.len();
        scored.sort_unstable_by(|(a, sa), (b, sb)| rank_order(a, *sa, b, *sb));
        (
            scored
                .into_iter()
                .take(request.limit)
                .map(|(item, affinity)| ranked_item(item, affinity, None))
                .collect(),
            considered,
        )
    };
    RecommendationResponse {
        request_id: request.request_id.clone(),
        catalog_version: catalog.version.clone(),
        profile_version: request.profile.as_ref().map(|p| p.version.clone()),
        ranker: if model.is_some() {
            "ftrl-ranker-v1"
        } else {
            "tag-affinity-v1"
        },
        considered,
        items,
    }
}

pub(crate) fn ranked_item(item: &Candidate, affinity: f32, rank_score: Option<f64>) -> RankedItem {
    RankedItem {
        id: item.id.clone(),
        domain: item.domain.clone(),
        affinity,
        rank_score,
        media_path: item
            .media_sha256
            .as_ref()
            .map(|hash| format!("/v1/media/{hash}")),
    }
}
