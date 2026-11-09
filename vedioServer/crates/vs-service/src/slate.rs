use axum::{http::HeaderValue, response::Response};
use vs_core::{
    DomainError,
    recommendation::{RecommendationRequest, RecommendationResponse},
    slate::SlatePolicy,
};

use crate::AppState;

impl AppState {
    pub fn with_slate_policy(mut self, policy: SlatePolicy) -> Result<Self, String> {
        policy.validate().map_err(|_| "列表重排策略参数无效")?;
        if self.profile_authority
            || self.feedback_log.is_some()
            || self.deployment.is_some()
            || self.slate_policy.is_some()
        {
            return Err("列表策略仅支持独立API配置，不能重复设置或覆盖固定部署".into());
        }
        self.slate_policy = Some(policy);
        Ok(self)
    }
}

pub(crate) fn prepare(
    request: &mut RecommendationRequest,
    policy: Option<&SlatePolicy>,
) -> Result<usize, DomainError> {
    let limit = request.limit;
    if let Some(policy) = policy {
        request.limit = policy.pool_limit(limit)?;
    }
    Ok(limit)
}

pub(crate) fn finish(
    state: &AppState,
    result: &mut RecommendationResponse,
    limit: usize,
) -> Result<(), DomainError> {
    let Some(policy) = &state.slate_policy else {
        return Ok(());
    };
    let candidates = result
        .items
        .iter()
        .map(|item| {
            state
                .candidates
                .get(&item.id)
                .ok_or(DomainError::Invalid("slate_candidate"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let selection = vs_core::slate::select(&candidates, limit, policy)?;
    tracing::debug!(
        operation = "slate_select",
        candidates = selection.candidates,
        similarity_evaluations = selection.similarity_evaluations,
        selected = selection.indices.len(),
    );
    let mut items: Vec<_> = std::mem::take(&mut result.items)
        .into_iter()
        .map(Some)
        .collect();
    result.items = selection
        .indices
        .into_iter()
        .map(|index| items[index].take().unwrap())
        .collect();
    Ok(())
}

pub(crate) fn insert_header(state: &AppState, response: &mut Response) {
    if state.slate_policy.is_some() {
        response.headers_mut().insert(
            "x-slate-policy",
            HeaderValue::from_static(vs_core::slate::POLICY_SCHEMA),
        );
    }
}
