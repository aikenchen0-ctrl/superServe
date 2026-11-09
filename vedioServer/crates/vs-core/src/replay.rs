use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    DomainError,
    catalog::PublicCatalog,
    profile::{MAX_PROFILE_SUBJECTS, ProfileEvent, ProfileState},
    recommendation::{RecommendationRequest, RequestContext},
    valid_id,
};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DataKind {
    Synthetic,
    Observed,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayTrace {
    pub schema: String,
    pub data_kind: DataKind,
    pub catalog_version: String,
    pub catalog_as_of: u64,
    pub history_cutoff: u64,
    pub events: Vec<TimedEvent>,
    pub queries: Vec<ReplayQuery>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TimedEvent {
    pub at: u64,
    pub event: ProfileEvent,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayQuery {
    pub request_id: String,
    pub subject: String,
    pub at: u64,
    pub label_window_end: u64,
    pub domains: Vec<String>,
    pub limit: usize,
    pub labels: Vec<Judgment>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Judgment {
    pub candidate_id: String,
    pub relevance: u8,
    pub observed_at: u64,
}

pub struct PreparedQuery {
    pub request: RecommendationRequest,
    pub at: u64,
    pub eligible_items: Vec<usize>,
    pub eligible_labels: Vec<Judgment>,
    pub excluded_positive_labels: usize,
}

impl ReplayTrace {
    // 一次验证全部输入后才允许查询外部索引，避免无效后半段产生部分评估结果。
    pub fn prepare(&self, catalog: &PublicCatalog) -> Result<Vec<PreparedQuery>, DomainError> {
        catalog.validate()?;
        if self.schema != "recommendation-replay-v1"
            || self.catalog_version != catalog.version
            || self.catalog_as_of > self.history_cutoff
            || self.events.len() > 100_000
            || self.queries.is_empty()
            || self.queries.len() > 1_000
        {
            return Err(DomainError::Invalid("replay_metadata"));
        }
        let items: HashMap<_, _> = catalog
            .items
            .iter()
            .map(|item| (item.id.as_str(), item))
            .collect();
        let mut profiles: HashMap<&str, ProfileState> = HashMap::new();
        let mut events = HashSet::new();
        let mut previous = None;
        for timed in &self.events {
            let event = &timed.event;
            if timed.at >= self.history_cutoff
                || previous.is_some_and(|at| at > timed.at)
                || !events.insert((&event.subject, &event.event_id))
                || (!profiles.contains_key(event.subject.as_str())
                    && profiles.len() >= MAX_PROFILE_SUBJECTS)
            {
                return Err(DomainError::Invalid("replay_history_order_or_duplicate"));
            }
            let candidate = items
                .get(event.candidate_id.as_str())
                .ok_or(DomainError::Invalid("replay_history_candidate"))?;
            profiles
                .entry(&event.subject)
                .or_default()
                .apply(event, candidate)?;
            previous = Some(timed.at);
        }
        let mut requests = HashSet::new();
        self.queries
            .iter()
            .map(|query| {
                if !valid_id(&query.subject)
                    || !requests.insert(&query.request_id)
                    || query.at < self.history_cutoff
                    || query.label_window_end <= query.at
                    || query.labels.len() > 1_000
                {
                    return Err(DomainError::Invalid("replay_query"));
                }
                let expires = query
                    .at
                    .checked_add(60)
                    .ok_or(DomainError::Invalid("replay_clock"))?;
                let request = RecommendationRequest {
                    request_id: query.request_id.clone(),
                    domains: query.domains.clone(),
                    limit: query.limit,
                    profile: profiles.get(query.subject.as_str()).map(|profile| {
                        profile.projection(&query.subject, query.domains.clone(), expires)
                    }),
                };
                let context = RequestContext::new(&request, query.at)?;
                let eligible_items = catalog
                    .items
                    .iter()
                    .enumerate()
                    .filter(|(_, item)| context.allows(item))
                    .map(|(index, _)| index)
                    .collect();
                let mut labels = HashSet::new();
                let mut eligible_labels = Vec::new();
                let mut excluded_positive_labels = 0;
                for label in &query.labels {
                    if label.observed_at <= query.at
                        || label.observed_at > query.label_window_end
                        || label.relevance > 3
                        || !labels.insert(&label.candidate_id)
                    {
                        return Err(DomainError::Invalid("replay_label_time_or_duplicate"));
                    }
                    let candidate = items
                        .get(label.candidate_id.as_str())
                        .ok_or(DomainError::Invalid("replay_label_candidate"))?;
                    if !context.includes_domain(&candidate.domain) {
                        return Err(DomainError::Invalid("replay_label_domain"));
                    }
                    if context.allows(candidate) {
                        eligible_labels.push(Judgment {
                            candidate_id: label.candidate_id.clone(),
                            relevance: label.relevance,
                            observed_at: label.observed_at,
                        });
                    } else if label.relevance > 0 {
                        excluded_positive_labels += 1;
                    }
                }
                drop(context);
                Ok(PreparedQuery {
                    request,
                    at: query.at,
                    eligible_items,
                    eligible_labels,
                    excluded_positive_labels,
                })
            })
            .collect()
    }
}

#[derive(Debug, Serialize)]
pub struct RankingMetrics {
    pub returned: usize,
    pub judged_returned: usize,
    pub positive_labels: usize,
    pub hits: usize,
    pub recall_at_k: Option<f64>,
    pub ndcg_at_k: Option<f64>,
    pub mrr_at_k: Option<f64>,
}

pub fn ranking_metrics(
    ids: &[&str],
    labels: &[Judgment],
    k: usize,
) -> Result<RankingMetrics, DomainError> {
    if !(1..=50).contains(&k) || ids.len() > k {
        return Err(DomainError::Invalid("metric_rank_length"));
    }
    let mut seen = HashSet::new();
    if ids.iter().any(|id| !valid_id(id) || !seen.insert(*id)) {
        return Err(DomainError::Invalid("metric_duplicate_rank"));
    }
    let mut gains = HashMap::new();
    for label in labels {
        if !valid_id(&label.candidate_id)
            || label.relevance > 3
            || gains
                .insert(label.candidate_id.as_str(), label.relevance)
                .is_some()
        {
            return Err(DomainError::Invalid("metric_judgment"));
        }
    }
    let mut ideal: Vec<_> = gains.values().copied().filter(|gain| *gain > 0).collect();
    ideal.sort_unstable_by(|a, b| b.cmp(a));
    let positive = ideal.len();
    let mut hits = 0;
    let mut judged_returned = 0;
    let mut dcg = 0.0;
    let mut reciprocal = 0.0;
    for (rank, id) in ids.iter().enumerate() {
        if let Some(grade) = gains.get(id) {
            judged_returned += 1;
            if *grade > 0 {
                hits += 1;
                dcg += ((1_u32 << *grade) - 1) as f64 / ((rank + 2) as f64).log2();
                if reciprocal == 0.0 {
                    reciprocal = 1.0 / (rank + 1) as f64;
                }
            }
        }
    }
    let ideal_dcg: f64 = ideal
        .iter()
        .take(k)
        .enumerate()
        .map(|(rank, grade)| ((1_u32 << *grade) - 1) as f64 / ((rank + 2) as f64).log2())
        .sum();
    Ok(RankingMetrics {
        returned: ids.len(),
        judged_returned,
        positive_labels: positive,
        hits,
        recall_at_k: (positive > 0).then(|| hits as f64 / positive as f64),
        ndcg_at_k: (positive > 0).then(|| dcg / ideal_dcg),
        mrr_at_k: (positive > 0).then_some(reciprocal),
    })
}
