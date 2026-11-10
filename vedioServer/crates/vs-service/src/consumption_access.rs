use std::{
    collections::HashMap,
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
use vs_core::{
    learning::{TrainingDataKind, is_sha256},
    valid_id,
};

use crate::{
    ApiError, AppState,
    consumption::{ClientPlatform, ConsumptionBatch},
    feedback_log,
};

const MAX_TOKEN_BYTES: usize = 4096;
const MAX_TTL_SECONDS: u64 = 300;
const VERIFY_CONCURRENCY: usize = 4;
const TOKEN_TYPE: &str = "vs-consumption+jwt";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumptionAccessKey {
    pub kid: String,
    pub public_key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumptionAccessConfig {
    pub issuer: String,
    pub audience: String,
    pub keys: Vec<ConsumptionAccessKey>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConsumptionClaims {
    iss: String,
    aud: String,
    sub: String,
    iat: u64,
    nbf: u64,
    exp: u64,
    source_id: String,
    data_kind: TrainingDataKind,
    decision_id: String,
    candidate_id: String,
    interaction_id: String,
    generation: u64,
    platform: ClientPlatform,
}

pub(crate) struct ConsumptionAccess {
    keys: HashMap<String, DecodingKey>,
    validation: Validation,
    slots: Arc<Semaphore>,
}

fn denied() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "消费凭据无效、过期或不匹配")
}

fn now() -> Result<u64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "消费认证时钟不可用"))
}

impl ConsumptionAccess {
    fn new(config: ConsumptionAccessConfig) -> Result<Self, String> {
        if config.issuer.is_empty()
            || config.issuer.len() > 256
            || !config.issuer.bytes().all(|byte| byte.is_ascii_graphic())
            || !valid_id(&config.audience)
            || !(1..=4).contains(&config.keys.len())
        {
            return Err("消费凭据发行者、受众或公钥数量无效".into());
        }
        let mut keys = HashMap::new();
        for key in config.keys {
            let bytes = URL_SAFE_NO_PAD
                .decode(&key.public_key)
                .map_err(|_| "消费公钥必须使用无填充Base64URL")?;
            if !valid_id(&key.kid) || bytes.len() != 32 || bytes.iter().all(|byte| *byte == 0) {
                return Err("消费公钥长度、标识或重复配置无效".into());
            }
            let decoding =
                DecodingKey::from_ed_components(&key.public_key).map_err(|_| "消费公钥编码无效")?;
            if keys.insert(key.kid, decoding).is_some() {
                return Err("消费公钥标识重复".into());
            }
        }
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_required_spec_claims(&["iss", "aud", "sub", "exp", "nbf"]);
        validation.set_issuer(&[config.issuer]);
        validation.set_audience(&[config.audience]);
        jwt_ring::install()?;
        Ok(Self {
            keys,
            validation,
            slots: Arc::new(Semaphore::new(VERIFY_CONCURRENCY)),
        })
    }

    fn authenticate(&self, token: &str) -> Result<ConsumptionClaims, ApiError> {
        let header = decode_header(token).map_err(|_| denied())?;
        // 只允许本协议的头部，不接受令牌提供的公钥、远端地址或扩展语义。
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
        let claims = decode::<ConsumptionClaims>(token, key, &self.validation)
            .map_err(|_| denied())?
            .claims;
        let at = now()?;
        if !valid_id(&claims.sub)
            || !valid_id(&claims.source_id)
            || !is_sha256(&claims.decision_id)
            || !valid_id(&claims.candidate_id)
            || !valid_id(&claims.interaction_id)
            || claims.generation == 0
            || claims.generation > 9_007_199_254_740_991
            || claims.iat == 0
            || claims.iat > at
            || claims.nbf < claims.iat
            || claims.nbf > at
            || claims.exp <= at
            || claims.exp <= claims.nbf
            || claims.exp.saturating_sub(claims.iat) > MAX_TTL_SECONDS
        {
            return Err(denied());
        }
        // 上游已校验发行者与受众；类型化读取再次确保它们不能缺失或变成数组。
        debug_assert!(!claims.iss.is_empty() && !claims.aud.is_empty());
        Ok(claims)
    }
}

impl AppState {
    pub fn with_consumption_access(
        mut self,
        config: ConsumptionAccessConfig,
    ) -> Result<Self, String> {
        if self.feedback_log.is_none() || self.consumption_access.is_some() {
            return Err("公开消费入口必须且只能绑定一次已配置的反馈实例".into());
        }
        self.consumption_access = Some(Arc::new(ConsumptionAccess::new(config)?));
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
            .consumption_access
            .clone()
            .ok_or(ApiError(StatusCode::NOT_FOUND, "公开消费入口未启用"))?;
        let mut authorization = request.headers().get_all(header::AUTHORIZATION).iter();
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
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "消费验签预算已满"))?;
        let token = token.to_owned();
        // 请求取消后，验签任务和许可共同存活，避免提前释放预算。
        let claims = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            access.authenticate(&token)
        })
        .await
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "消费验签任务失败"))??;
        request.extensions_mut().insert(claims);
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

pub(crate) async fn ingest(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<ConsumptionClaims>,
    headers: HeaderMap,
    Json(batch): Json<ConsumptionBatch>,
) -> Result<Response, ApiError> {
    // 正文读取可能跨越到期时刻，提交前再次检查，不延长凭据窗口。
    let at = now()?;
    if at < claims.nbf || at >= claims.exp {
        return Err(denied());
    }
    let same_kind = matches!(
        (claims.data_kind, batch.data_kind),
        (TrainingDataKind::Synthetic, TrainingDataKind::Synthetic)
            | (TrainingDataKind::Observed, TrainingDataKind::Observed)
    );
    if claims.sub != batch.subject
        || claims.source_id != batch.source_id
        || !same_kind
        || claims.platform != batch.platform
        || claims.decision_id != batch.decision_id
        || claims.candidate_id != batch.candidate_id
        || claims.interaction_id != batch.interaction_id
        || claims.generation != batch.generation
        || batch
            .events
            .iter()
            .any(|event| event.observed_at < claims.nbf || event.observed_at >= claims.exp)
    {
        return Err(ApiError(StatusCode::FORBIDDEN, "消费批次超出凭据绑定范围"));
    }
    feedback_log::ingest_consumption(State(state), headers, Json(batch)).await
}
