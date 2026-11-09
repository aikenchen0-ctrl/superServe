use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use vs_core::playback::PlaybackPolicy;

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlaybackPolicyResponse {
    pub schema: String,
    pub controller: String,
    pub catalog_sha256: String,
    pub policy_sha256: String,
    pub policy: PlaybackPolicy,
}

impl PlaybackPolicyResponse {
    pub fn verify(&self, catalog_sha256: &str) -> Result<(), &'static str> {
        if self.schema != "playback-policy-v1"
            || self.controller != "media3-buffer-v1"
            || self.catalog_sha256 != catalog_sha256
            || self.policy.validate().is_err()
            || fingerprint(&self.policy) != self.policy_sha256
        {
            return Err("播放策略版本、目录或内容指纹不匹配");
        }
        Ok(())
    }
}

fn fingerprint(policy: &PlaybackPolicy) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(policy).expect("固定整数策略可序列化"))
    )
}

pub(crate) async fn get_policy(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let value = PlaybackPolicyResponse {
        schema: "playback-policy-v1".into(),
        controller: "media3-buffer-v1".into(),
        catalog_sha256: state.catalog_sha256.clone(),
        policy_sha256: fingerprint(&state.playback_policy),
        policy: state.playback_policy,
    };
    let etag = format!("\"{}-{}\"", value.catalog_sha256, value.policy_sha256);
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|item| {
                let item = item.trim();
                item == "*" || item.strip_prefix("W/").unwrap_or(item) == etag
            })
        });
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(value).into_response()
    };
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response.headers_mut().insert(
        "x-catalog-sha256",
        HeaderValue::from_str(&state.catalog_sha256).unwrap(),
    );
    response
}
