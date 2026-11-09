use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use m3u8_rs::Playlist;
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    learning::is_sha256,
    recommendation::{
        ProfileProjection, RecommendationRequest, RecommendationResponse, RequestContext,
    },
    valid_id,
};

use crate::{ApiError, AppState};

const MAX_TTL_SECONDS: u64 = 300;
const MAX_PLAYLIST_BYTES: usize = 128 * 1024;
// 固定二进制负载：版本、深度、起止秒、随机播放标识、主体指纹、根资源、当前资源。
const PAYLOAD_BYTES: usize = 2 + 8 + 8 + 16 + 32 + 32 + 32;
const TOKEN_BYTES: usize = PAYLOAD_BYTES + 32;
const MAX_RECEIPT_BYTES: usize = 8192;

pub(crate) struct PlaybackAccess {
    key: hmac::Key,
    audience: String,
    catalog_sha256: String,
}

#[derive(Clone)]
struct Grant {
    depth: u8,
    issued_at: u64,
    expires_at: u64,
    id: [u8; 16],
    subject: [u8; 32],
    root: [u8; 32],
    asset: [u8; 32],
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlaybackGrantRequest {
    pub candidate_id: String,
    pub ttl_seconds: u64,
    #[serde(default)]
    pub decision_receipt: Option<String>,
    // 仅接受可信授权网关提交的投影，不能把客户端自报主体当作身份验证。
    pub profile: ProfileProjection,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlaybackGrantResponse {
    pub schema: String,
    pub candidate_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommendation_request_id: Option<String>,
    pub catalog_sha256: String,
    pub playback_id: String,
    pub protocol: String,
    pub media_path: String,
    pub expires_at: u64,
    pub credential_transport: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionReceipt {
    schema: String,
    decision_id: String,
    request_id: String,
    subject: String,
    candidates: Vec<String>,
    issued_at: u64,
    expires_at: u64,
}

/// 仅为已持久记录的真实返回列表签发；不签入画像、服务密钥或完整会话。
pub(crate) fn decision_receipt(
    state: &AppState,
    identity: Option<(String, u64)>,
    result: &RecommendationResponse,
    decision_id: Option<&str>,
) -> Result<Option<HeaderValue>, ApiError> {
    let (Some(access), Some((subject, expires_at)), Some(decision_id)) =
        (&state.playback_access, identity, decision_id)
    else {
        return Ok(None);
    };
    if result.items.is_empty() {
        return Ok(None);
    }
    let at = now()?;
    let receipt = DecisionReceipt {
        schema: "playback-decision-v1".into(),
        decision_id: decision_id.into(),
        request_id: result.request_id.clone(),
        subject: access.subject_digest(&subject),
        candidates: result.items.iter().map(|item| item.id.clone()).collect(),
        issued_at: at,
        expires_at: expires_at.min(at + MAX_TTL_SECONDS),
    };
    if receipt.expires_at <= at {
        return Err(ApiError(StatusCode::FORBIDDEN, "决策收据签发时画像已过期"));
    }
    let bytes = serde_json::to_vec(&receipt)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "决策收据编码失败"))?;
    let mut context = access.receipt_context();
    context.update(&bytes);
    let encoded = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(&bytes),
        URL_SAFE_NO_PAD.encode(context.sign().as_ref())
    );
    if encoded.len() > MAX_RECEIPT_BYTES {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "决策收据超出预算",
        ));
    }
    HeaderValue::from_str(&encoded)
        .map(Some)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "决策收据响应编码失败"))
}

fn now() -> Result<u64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "服务时钟不可用"))
}

fn denied() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "播放凭据无效或已过期")
}

fn invalid_playlist() -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "清单内容、引用或格式不在授权发布范围",
    )
}

fn hash_bytes(value: &str) -> Result<[u8; 32], ApiError> {
    if !is_sha256(value) {
        return Err(denied());
    }
    let mut result = [0; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let digit = |byte: u8| match byte {
            b'0'..=b'9' => byte - b'0',
            _ => byte - b'a' + 10,
        };
        result[index] = digit(pair[0]) * 16 + digit(pair[1]);
    }
    Ok(result)
}

impl PlaybackAccess {
    pub(crate) fn new(key: &[u8], audience: &str, catalog: &str) -> Result<Self, String> {
        if key.len() != 32 || !valid_id(audience) || !is_sha256(catalog) {
            return Err("播放签名密钥须为32字节，受众和目录指纹必须有效".into());
        }
        Ok(Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, key),
            audience: audience.into(),
            catalog_sha256: catalog.into(),
        })
    }

    fn context(&self) -> hmac::Context {
        let mut context = hmac::Context::with_key(&self.key);
        context.update(b"superServe-playback-v1\0");
        context.update(self.audience.as_bytes());
        context.update(b"\0");
        context.update(self.catalog_sha256.as_bytes());
        context.update(b"\0");
        context
    }

    fn receipt_context(&self) -> hmac::Context {
        let mut context = hmac::Context::with_key(&self.key);
        context.update(b"superServe-playback-decision-v1\0");
        context.update(self.audience.as_bytes());
        context.update(b"\0");
        context.update(self.catalog_sha256.as_bytes());
        context.update(b"\0");
        context
    }

    fn subject_digest(&self, subject: &str) -> String {
        let mut context = hmac::Context::with_key(&self.key);
        context.update(b"playback-subject-v1\0");
        context.update(subject.as_bytes());
        URL_SAFE_NO_PAD.encode(context.sign().as_ref())
    }

    fn verify_receipt(
        &self,
        token: &str,
        subject: &str,
        candidate: &str,
        at: u64,
    ) -> Result<DecisionReceipt, ApiError> {
        let denied = || ApiError(StatusCode::FORBIDDEN, "推荐决策收据无效、过期或范围不匹配");
        if token.len() > MAX_RECEIPT_BYTES {
            return Err(denied());
        }
        let (payload, signature) = token.split_once('.').ok_or_else(denied)?;
        let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| denied())?;
        let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| denied())?;
        let mut message = Vec::with_capacity(bytes.len() + 400);
        message.extend_from_slice(b"superServe-playback-decision-v1\0");
        message.extend_from_slice(self.audience.as_bytes());
        message.push(0);
        message.extend_from_slice(self.catalog_sha256.as_bytes());
        message.push(0);
        message.extend_from_slice(&bytes);
        hmac::verify(&self.key, &message, &signature).map_err(|_| denied())?;
        let receipt: DecisionReceipt = serde_json::from_slice(&bytes).map_err(|_| denied())?;
        if receipt.schema != "playback-decision-v1"
            || !is_sha256(&receipt.decision_id)
            || !valid_id(&receipt.request_id)
            || receipt.subject != self.subject_digest(subject)
            || !(1..=50).contains(&receipt.candidates.len())
            || receipt.candidates.iter().any(|id| !valid_id(id))
            || !receipt.candidates.iter().any(|id| id == candidate)
            || receipt.issued_at > at
            || receipt.expires_at <= at
            || receipt.expires_at <= receipt.issued_at
            || receipt.expires_at - receipt.issued_at > MAX_TTL_SECONDS
        {
            return Err(denied());
        }
        Ok(receipt)
    }

    fn encode(&self, grant: &Grant) -> String {
        let mut bytes = Vec::with_capacity(TOKEN_BYTES);
        bytes.extend_from_slice(&[1, grant.depth]);
        bytes.extend_from_slice(&grant.issued_at.to_be_bytes());
        bytes.extend_from_slice(&grant.expires_at.to_be_bytes());
        bytes.extend_from_slice(&grant.id);
        bytes.extend_from_slice(&grant.subject);
        bytes.extend_from_slice(&grant.root);
        bytes.extend_from_slice(&grant.asset);
        let mut context = self.context();
        context.update(&bytes);
        bytes.extend_from_slice(context.sign().as_ref());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decode(&self, token: &str, at: u64) -> Result<Grant, ApiError> {
        if token.len() > 256 {
            return Err(denied());
        }
        let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| denied())?;
        if bytes.len() != TOKEN_BYTES || bytes[0] != 1 || bytes[1] > 4 {
            return Err(denied());
        }
        // 由ring执行常量时间校验，不自行比较认证码。
        let mut message = Vec::with_capacity(256);
        message.extend_from_slice(b"superServe-playback-v1\0");
        message.extend_from_slice(self.audience.as_bytes());
        message.push(0);
        message.extend_from_slice(self.catalog_sha256.as_bytes());
        message.push(0);
        message.extend_from_slice(&bytes[..PAYLOAD_BYTES]);
        hmac::verify(&self.key, &message, &bytes[PAYLOAD_BYTES..]).map_err(|_| denied())?;
        let grant = Grant {
            depth: bytes[1],
            issued_at: u64::from_be_bytes(bytes[2..10].try_into().unwrap()),
            expires_at: u64::from_be_bytes(bytes[10..18].try_into().unwrap()),
            id: bytes[18..34].try_into().unwrap(),
            subject: bytes[34..66].try_into().unwrap(),
            root: bytes[66..98].try_into().unwrap(),
            asset: bytes[98..130].try_into().unwrap(),
        };
        if grant.issued_at > at
            || grant.expires_at <= at
            || grant.expires_at.saturating_sub(grant.issued_at) > MAX_TTL_SECONDS
        {
            return Err(denied());
        }
        Ok(grant)
    }

    fn path(&self, grant: &Grant, hash: &str, filename: &str) -> String {
        format!("/v1/playback/{}/{hash}/{filename}", self.encode(grant))
    }
}

pub(crate) async fn issue(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PlaybackGrantRequest>,
) -> Result<Response, ApiError> {
    let access = state
        .playback_access
        .as_ref()
        .ok_or(ApiError(StatusCode::NOT_FOUND, "播放授权未启用"))?;
    let at = now()?;
    if !(1..=MAX_TTL_SECONDS).contains(&request.ttl_seconds) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "播放有效期必须为1至300秒",
        ));
    }
    let candidate = state
        .candidates
        .get(&request.candidate_id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "候选不存在"))?;
    let recommendation = RecommendationRequest {
        request_id: "playback-grant".into(),
        domains: vec![candidate.domain.clone()],
        limit: 1,
        profile: Some(request.profile),
    };
    let context = RequestContext::new(&recommendation, at)
        .map_err(|_| ApiError(StatusCode::FORBIDDEN, "授权投影无效、过期或范围不匹配"))?;
    if !context.allows(candidate) {
        return Err(ApiError(StatusCode::FORBIDDEN, "候选不在授权投影范围"));
    }
    let profile = recommendation.profile.as_ref().unwrap();
    let receipt = request
        .decision_receipt
        .as_deref()
        .map(|token| access.verify_receipt(token, &profile.subject, &candidate.id, at))
        .transpose()?;
    let hash = candidate
        .media_sha256
        .as_ref()
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "候选没有媒体"))?;
    let asset = &state.assets[hash];
    let (protocol, filename) = match asset.content_type.as_str() {
        "application/vnd.apple.mpegurl" => ("hls", "index.m3u8"),
        "video/mp4" => ("progressive_mp4", "media.mp4"),
        _ => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "媒体类型尚未支持播放授权",
            ));
        }
    };
    let mut id = [0; 16];
    SystemRandom::new()
        .fill(&mut id)
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "播放标识生成失败"))?;
    let mut subject = hmac::Context::with_key(&access.key);
    subject.update(b"playback-subject-v1\0");
    subject.update(profile.subject.as_bytes());
    let grant = Grant {
        depth: 0,
        issued_at: at,
        expires_at: (at + request.ttl_seconds).min(profile.expires_at).min(
            receipt
                .as_ref()
                .map_or(u64::MAX, |receipt| receipt.expires_at),
        ),
        id,
        subject: subject.sign().as_ref().try_into().unwrap(),
        root: hash_bytes(hash)?,
        asset: hash_bytes(hash)?,
    };
    let value = PlaybackGrantResponse {
        schema: "playback-grant-v1".into(),
        candidate_id: candidate.id.clone(),
        decision_id: receipt.as_ref().map(|receipt| receipt.decision_id.clone()),
        recommendation_request_id: receipt.as_ref().map(|receipt| receipt.request_id.clone()),
        catalog_sha256: state.catalog_sha256.clone(),
        playback_id: URL_SAFE_NO_PAD.encode(id),
        protocol: protocol.into(),
        media_path: access.path(&grant, hash, filename),
        expires_at: grant.expires_at,
        credential_transport: "signed_path".into(),
    };
    let mut response = Json(value).into_response();
    private_headers(&mut response);
    Ok(response)
}

fn private_headers(response: &mut Response) {
    for (name, value) in [
        ("cache-control", "private, no-store"),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
}

fn rewrite(
    bytes: &[u8],
    state: &AppState,
    access: &PlaybackAccess,
    grant: &Grant,
) -> Result<Vec<u8>, ApiError> {
    let (remainder, mut playlist) =
        m3u8_rs::parse_playlist(bytes).map_err(|_| invalid_playlist())?;
    if !remainder.iter().all(u8::is_ascii_whitespace) || grant.depth >= 4 {
        return Err(invalid_playlist());
    }
    let mut references = 0;
    let mut sign = |uri: &mut String, filename: &str| -> Result<(), ApiError> {
        references += 1;
        if references > 1024 {
            return Err(invalid_playlist());
        }
        let parts: Vec<_> = uri.split('/').collect();
        if parts.len() != 5 || parts[..3] != ["", "v1", "media"] || parts[4] != filename {
            return Err(invalid_playlist());
        }
        let hash = parts[3];
        let asset = state.assets.get(hash).ok_or_else(invalid_playlist)?;
        let matches_type = match filename {
            "index.m3u8" => asset.content_type == "application/vnd.apple.mpegurl",
            "media.mp4" => matches!(asset.content_type.as_str(), "video/mp4" | "audio/mp4"),
            _ => false,
        };
        if !matches_type {
            return Err(invalid_playlist());
        }
        let mut child = grant.clone();
        child.depth += 1;
        child.asset = hash_bytes(hash).map_err(|_| invalid_playlist())?;
        *uri = access.path(&child, hash, filename);
        Ok(())
    };
    match &mut playlist {
        Playlist::MasterPlaylist(master) => {
            if !master.unknown_tags.is_empty()
                || !master.session_data.is_empty()
                || !master.session_key.is_empty()
                || master.variants.is_empty()
            {
                return Err(invalid_playlist());
            }
            for variant in &mut master.variants {
                if variant
                    .other_attributes
                    .as_ref()
                    .is_some_and(|value| !value.is_empty())
                {
                    return Err(invalid_playlist());
                }
                sign(&mut variant.uri, "index.m3u8")?;
            }
            for alternative in &mut master.alternatives {
                if alternative
                    .other_attributes
                    .as_ref()
                    .is_some_and(|value| !value.is_empty())
                {
                    return Err(invalid_playlist());
                }
                if let Some(uri) = &mut alternative.uri {
                    sign(uri, "index.m3u8")?;
                }
            }
        }
        Playlist::MediaPlaylist(media) => {
            if !media.end_list || !media.unknown_tags.is_empty() || media.segments.is_empty() {
                return Err(invalid_playlist());
            }
            for segment in &mut media.segments {
                if segment.key.is_some()
                    || !segment.unknown_tags.is_empty()
                    || segment.daterange.is_some()
                {
                    return Err(invalid_playlist());
                }
                sign(&mut segment.uri, "media.mp4")?;
                if let Some(map) = &mut segment.map {
                    if !map.other_attributes.is_empty() {
                        return Err(invalid_playlist());
                    }
                    sign(&mut map.uri, "media.mp4")?;
                }
            }
        }
    }
    let mut result = Vec::new();
    playlist
        .write_to(&mut result)
        .map_err(|_| invalid_playlist())?;
    if result.len() > 1024 * 1024 {
        return Err(invalid_playlist());
    }
    Ok(result)
}

pub(crate) async fn read(
    State(state): State<Arc<AppState>>,
    Path((token, hash, filename)): Path<(String, String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let result = read_authorized(&state, &token, &hash, &filename, method, headers).await;
    let mut response = result.unwrap_or_else(IntoResponse::into_response);
    private_headers(&mut response);
    response
}

async fn read_authorized(
    state: &Arc<AppState>,
    token: &str,
    hash: &str,
    filename: &str,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let access = state.playback_access.as_ref().ok_or_else(denied)?;
    let grant = access.decode(token, now()?)?;
    if grant.asset != hash_bytes(hash)? {
        return Err(denied());
    }
    if filename != "index.m3u8" {
        return crate::named_media(
            State(state.clone()),
            Path((hash.into(), filename.into())),
            method,
            headers,
        )
        .await;
    }
    let asset = state.assets.get(hash).ok_or_else(invalid_playlist)?;
    if asset.bytes > MAX_PLAYLIST_BYTES as u64 {
        return Err(invalid_playlist());
    }
    // 清单始终完整读取并校验原始指纹；不能用Range或304绕过对子资源的授权重写。
    let response = crate::named_media(
        State(state.clone()),
        Path((hash.into(), filename.into())),
        Method::GET,
        HeaderMap::new(),
    )
    .await?;
    let body = to_bytes(response.into_body(), MAX_PLAYLIST_BYTES)
        .await
        .map_err(|_| invalid_playlist())?;
    if body.len() as u64 != asset.bytes || format!("{:x}", Sha256::digest(&body)) != hash {
        return Err(invalid_playlist());
    }
    let body = rewrite(&body, state, access, &grant)?;
    let size = body.len();
    let mut response = if method == Method::HEAD {
        Body::empty().into_response()
    } else {
        Body::from(body).into_response()
    };
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.apple.mpegurl"),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).unwrap(),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_bind_asset_catalog_audience_and_exact_expiry() {
        let signer = PlaybackAccess::new(&[7; 32], "media", &"a".repeat(64)).unwrap();
        let grant = Grant {
            depth: 0,
            issued_at: 100,
            expires_at: 200,
            id: [1; 16],
            subject: [2; 32],
            root: [3; 32],
            asset: [4; 32],
        };
        let token = signer.encode(&grant);
        assert_eq!(token.len(), 216);
        assert_eq!(signer.decode(&token, 199).unwrap().asset, [4; 32]);
        assert!(signer.decode(&token, 99).is_err());
        assert!(signer.decode(&token, 200).is_err());
        let other = PlaybackAccess::new(&[7; 32], "another", &"a".repeat(64)).unwrap();
        assert!(other.decode(&token, 101).is_err());
        let other = PlaybackAccess::new(&[7; 32], "media", &"b".repeat(64)).unwrap();
        assert!(other.decode(&token, 101).is_err());
        let other = PlaybackAccess::new(&[8; 32], "media", &"a".repeat(64)).unwrap();
        assert!(other.decode(&token, 101).is_err());
        let mut forged = URL_SAFE_NO_PAD.decode(&token).unwrap();
        forged[100] ^= 1;
        assert!(signer.decode(&URL_SAFE_NO_PAD.encode(forged), 101).is_err());
        assert!(signer.decode(&"a".repeat(257), 101).is_err());
    }

    #[test]
    fn decision_receipts_bind_subject_candidates_catalog_expiry_and_signature_purpose() {
        let state = AppState::new(
            br#"{"version":"receipt-v1","items":[],"assets":[]}"#,
            None,
            "receipt-test-service-token-0000000000000000",
            1,
            1,
        )
        .unwrap()
        .with_playback_access(&[7; 32], "media")
        .unwrap();
        let access = state.playback_access.as_ref().unwrap();
        let at = now().unwrap();
        let result = RecommendationResponse {
            request_id: "request".into(),
            catalog_version: "receipt-v1".into(),
            profile_version: None,
            ranker: "tag-affinity-v1",
            considered: 1,
            items: vec![vs_core::recommendation::RankedItem {
                id: "clip".into(),
                domain: "video".into(),
                affinity: 0.0,
                rank_score: None,
                media_path: None,
            }],
        };
        let decision = "a".repeat(64);
        let token = decision_receipt(
            &state,
            Some(("alice".into(), at + 20)),
            &result,
            Some(&decision),
        )
        .unwrap()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
        assert_eq!(
            access
                .verify_receipt(&token, "alice", "clip", at)
                .unwrap()
                .expires_at,
            at + 20
        );
        for (subject, candidate, time) in [
            ("bob", "clip", at),
            ("alice", "other", at),
            ("alice", "clip", at - 1),
            ("alice", "clip", at + 20),
        ] {
            assert!(
                access
                    .verify_receipt(&token, subject, candidate, time)
                    .is_err()
            );
        }
        for other in [
            PlaybackAccess::new(&[7; 32], "media", &"b".repeat(64)).unwrap(),
            PlaybackAccess::new(&[7; 32], "other", &state.catalog_sha256).unwrap(),
            PlaybackAccess::new(&[8; 32], "media", &state.catalog_sha256).unwrap(),
        ] {
            assert!(other.verify_receipt(&token, "alice", "clip", at).is_err());
        }
        assert!(access.decode(&token, at).is_err());
        let (payload, signature) = token.split_once('.').unwrap();
        let mut changed: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        changed["candidates"] = serde_json::json!(["other"]);
        let forged = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&changed).unwrap()),
            signature
        );
        assert!(
            access
                .verify_receipt(&forged, "alice", "other", at)
                .is_err()
        );
        assert!(
            access
                .verify_receipt(&"a".repeat(MAX_RECEIPT_BYTES + 1), "alice", "clip", at)
                .is_err()
        );
        assert!(
            decision_receipt(&state, Some(("alice".into(), at + 20)), &result, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn playlist_issuer_rejects_external_references_keys_live_and_unknown_tags() {
        let state = AppState::new(
            br#"{"version":"reject-v1","items":[],"assets":[]}"#,
            None,
            "reject-playlist-test-token-0000000000000",
            1,
            1,
        )
        .unwrap();
        let signer = PlaybackAccess::new(&[7; 32], "media", &state.catalog_sha256).unwrap();
        let grant = Grant {
            depth: 0,
            issued_at: 100,
            expires_at: 200,
            id: [1; 16],
            subject: [2; 32],
            root: [3; 32],
            asset: [4; 32],
        };
        for text in [
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil.invalid/track.m3u8\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n../secret.mp4\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://evil/key\"\n#EXTINF:2,\nx.mp4\n#EXT-X-ENDLIST\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nx.mp4\n",
            "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART:DURATION=1,URI=\"https://evil/part\"\n#EXTINF:2,\nx.mp4\n#EXT-X-ENDLIST\n",
        ] {
            assert!(rewrite(text.as_bytes(), &state, &signer, &grant).is_err());
        }
    }
}
