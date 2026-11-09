use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Extension, Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Extras, Validation, decode, decode_header};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use vs_auth as jwt_ring;
use vs_core::valid_id;

use crate::{ApiError, AppState};

const MAX_TOKEN_BYTES: usize = 4096;
const MAX_TTL_SECONDS: u64 = 300;
const VERIFY_CONCURRENCY: usize = 4;
const TOKEN_TYPE: &str = "vs-feed+jwt";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedAccessKey {
    pub kid: String,
    pub public_key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedAccessConfig {
    pub issuer: String,
    pub audience: String,
    pub keys: Vec<FeedAccessKey>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FeedClaims {
    iss: String,
    #[serde(rename = "aud")]
    _aud: String,
    pub(crate) sub: String,
    iat: u64,
    nbf: u64,
    exp: u64,
    pub(crate) domains: Vec<String>,
}

pub(crate) struct FeedAccess {
    keys: HashMap<String, DecodingKey>,
    validation: Validation,
    slots: Arc<Semaphore>,
}

fn denied() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "推荐访问凭据无效或已过期")
}

fn now() -> Result<u64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "推荐认证时钟不可用"))
}

impl FeedAccess {
    fn new(config: FeedAccessConfig) -> Result<Self, String> {
        if config.issuer.is_empty()
            || config.issuer.len() > 256
            || !config.issuer.bytes().all(|byte| byte.is_ascii_graphic())
            || !valid_id(&config.audience)
            || !(1..=4).contains(&config.keys.len())
        {
            return Err("推荐凭据发行者、受众或公钥数量无效".into());
        }
        let mut keys = HashMap::new();
        for key in config.keys {
            let bytes = URL_SAFE_NO_PAD
                .decode(&key.public_key)
                .map_err(|_| "推荐公钥必须使用无填充Base64URL")?;
            if !valid_id(&key.kid) || bytes.len() != 32 || bytes.iter().all(|byte| *byte == 0) {
                return Err("推荐公钥长度、标识或重复配置无效".into());
            }
            let decoding =
                DecodingKey::from_ed_components(&key.public_key).map_err(|_| "推荐公钥编码无效")?;
            if keys.insert(key.kid, decoding).is_some() {
                return Err("推荐公钥标识重复".into());
            }
        }
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_required_spec_claims(&["iss", "aud", "sub", "exp", "nbf"]);
        validation.set_issuer(&[config.issuer]);
        validation.set_audience(std::slice::from_ref(&config.audience));
        jwt_ring::install()?;
        Ok(Self {
            keys,
            validation,
            slots: Arc::new(Semaphore::new(VERIFY_CONCURRENCY)),
        })
    }

    fn authenticate(&self, token: &str) -> Result<FeedClaims, ApiError> {
        let header = decode_header(token).map_err(|_| denied())?;
        if header.alg != Algorithm::EdDSA
            || header.typ.as_deref() != Some(TOKEN_TYPE)
            || header.cty.is_some()
            || header.jku.is_some()
            || header.jwk.is_some()
            || header.x5u.is_some()
            || header.x5c.is_some()
            || header.x5t.is_some()
            || header.x5t_s256.is_some()
            || header.crit.is_some()
            || header.enc.is_some()
            || header.zip.is_some()
            || header.url.is_some()
            || header.nonce.is_some()
            || header.extras != Extras::default()
        {
            return Err(denied());
        }
        let key = header
            .kid
            .as_deref()
            .and_then(|kid| self.keys.get(kid))
            .ok_or_else(denied)?;
        let claims = decode::<FeedClaims>(token, key, &self.validation)
            .map_err(|_| denied())?
            .claims;
        let at = now()?;
        let mut domains = HashSet::new();
        if !valid_id(&claims.sub)
            || claims.iat == 0
            || claims.iat > at
            || claims.nbf < claims.iat
            || claims.nbf > at
            || claims.exp <= at
            || claims.exp <= claims.nbf
            || claims.exp.saturating_sub(claims.iat) > MAX_TTL_SECONDS
            || claims.domains.is_empty()
            || claims.domains.len() > 16
            || claims
                .domains
                .iter()
                .any(|domain| !valid_id(domain) || !domains.insert(domain))
        {
            return Err(denied());
        }
        debug_assert!(!claims.iss.is_empty());
        Ok(claims)
    }
}

#[derive(Clone)]
pub(crate) struct AuthenticatedFeed {
    pub(crate) claims: FeedClaims,
    pub(crate) profile_access: Option<String>,
}

impl AppState {
    pub fn with_feed_access(mut self, config: FeedAccessConfig) -> Result<Self, String> {
        if self.feed_access.is_some() {
            return Err("推荐访问凭据只能配置一次".into());
        }
        self.feed_access = Some(Arc::new(FeedAccess::new(config)?));
        Ok(self)
    }
}

pub(crate) async fn authenticate(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let outcome = async {
        let access = state
            .feed_access
            .clone()
            .ok_or(ApiError(StatusCode::NOT_FOUND, "网关推荐身份入口未启用"))?;
        let mut authorization = request.headers().get_all("x-feed-identity").iter();
        let token = authorization
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(denied)?;
        if authorization.next().is_some()
            || token.is_empty()
            || token.len() > MAX_TOKEN_BYTES
            || !token.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(denied());
        }
        let permit = access
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "推荐验签预算已满"))?;
        let token = token.to_owned();
        let claims = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            access.authenticate(&token)
        })
        .await
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "推荐验签任务失败"))??;
        let mut grants = request.headers().get_all("x-profile-access-grant").iter();
        let profile_access = grants
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= MAX_TOKEN_BYTES
                    && value.bytes().all(|byte| byte.is_ascii_graphic())
            })
            .map(str::to_owned);
        if grants.next().is_some()
            || (state.profile_authorization_audience().is_some() && profile_access.is_none())
            || (state.profile_authorization_audience().is_none() && profile_access.is_some())
        {
            return Err(denied());
        }
        request.extensions_mut().insert(AuthenticatedFeed {
            claims,
            profile_access,
        });
        Ok::<_, ApiError>(next.run(request).await)
    }
    .await;
    let mut response = outcome.unwrap_or_else(IntoResponse::into_response);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    if response.status() == StatusCode::UNAUTHORIZED {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, "Bearer".parse().unwrap());
    }
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicFeedRequest {
    request_id: String,
    domains: Vec<String>,
    limit: usize,
}

pub(crate) async fn feed(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<AuthenticatedFeed>,
    headers: HeaderMap,
    Json(request): Json<PublicFeedRequest>,
) -> Result<Response, ApiError> {
    let claims = &identity.claims;
    if request
        .domains
        .iter()
        .any(|domain| !claims.domains.contains(domain))
    {
        return Err(ApiError(StatusCode::FORBIDDEN, "推荐领域超出凭据授权范围"));
    }
    let trace_context = crate::request_trace_context(&headers);
    crate::feed_for_subject_with_profile_access_and_trace(
        state,
        crate::FeedRequest {
            request_id: request.request_id,
            subject: claims.sub.clone(),
            domains: request.domains,
            limit: request.limit,
        },
        identity.profile_access,
        trace_context.as_ref(),
    )
    .await
}
