use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Extras, Validation, decode, decode_header};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::{PeerRole, SessionGrant};

pub const TOKEN_TYPE: &str = "vs-live+jwt";
const MAX_TOKEN_BYTES: usize = 4096;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessKey {
    pub kid: String,
    pub public_key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAccessConfig {
    pub issuer: String,
    pub audience: String,
    pub tenant_id: String,
    pub room_id: String,
    pub node_id: String,
    pub keys: Vec<AccessKey>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveBinding {
    pub tenant_id: String,
    pub room_id: String,
    pub node_id: String,
    pub incarnation: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub iat: u64,
    pub nbf: u64,
    pub exp: u64,
    pub tenant_id: String,
    pub room_id: String,
    pub node_id: String,
    pub incarnation: String,
    pub role: PeerRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_revision: Option<u64>,
}

#[derive(Debug)]
pub enum AccessError {
    Denied,
    Busy,
    Unavailable,
}

pub struct LiveAccess {
    binding: LiveBinding,
    keys: Arc<HashMap<String, DecodingKey>>,
    validation: Validation,
    slots: Arc<Semaphore>,
}

fn label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

impl LiveAccess {
    pub fn new(config: LiveAccessConfig) -> Result<Self, String> {
        if config.issuer.is_empty()
            || config.issuer.len() > 256
            || !config.issuer.bytes().all(|byte| byte.is_ascii_graphic())
            || !label(&config.audience)
            || !label(&config.tenant_id)
            || !label(&config.room_id)
            || !label(&config.node_id)
            || !(1..=4).contains(&config.keys.len())
        {
            return Err("直播凭据配置的发行者、范围或公钥数量无效".into());
        }
        let mut keys = HashMap::new();
        for key in config.keys {
            let bytes = URL_SAFE_NO_PAD
                .decode(&key.public_key)
                .map_err(|_| "直播公钥必须使用无填充Base64URL")?;
            if !label(&key.kid) || bytes.len() != 32 || bytes.iter().all(|byte| *byte == 0) {
                return Err("直播公钥或标识无效".into());
            }
            let decoding =
                DecodingKey::from_ed_components(&key.public_key).map_err(|_| "直播公钥编码无效")?;
            if keys.insert(key.kid, decoding).is_some() {
                return Err("直播公钥标识重复".into());
            }
        }
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_required_spec_claims(&["iss", "aud", "sub", "iat", "nbf", "exp"]);
        validation.set_issuer(&[config.issuer]);
        validation.set_audience(&[config.audience]);
        vs_auth::install()?;
        let mut nonce = [0_u8; 16];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "直播节点启动标识生成失败")?;
        Ok(Self {
            binding: LiveBinding {
                tenant_id: config.tenant_id,
                room_id: config.room_id,
                node_id: config.node_id,
                incarnation: URL_SAFE_NO_PAD.encode(nonce),
            },
            keys: Arc::new(keys),
            validation,
            slots: Arc::new(Semaphore::new(4)),
        })
    }

    pub fn binding(&self) -> &LiveBinding {
        &self.binding
    }

    pub fn for_room(&self, tenant_id: String, room_id: String) -> Result<Self, String> {
        if !label(&tenant_id) || !label(&room_id) || tenant_id == "." || room_id == "." {
            return Err("直播房间或租户标识无效".into());
        }
        if tenant_id == ".." || room_id == ".." {
            return Err("直播房间或租户标识不能为路径跳转".into());
        }
        Ok(Self {
            binding: LiveBinding {
                tenant_id,
                room_id,
                node_id: self.binding.node_id.clone(),
                incarnation: self.binding.incarnation.clone(),
            },
            keys: self.keys.clone(),
            validation: self.validation.clone(),
            // 所有房间共享验签预算；增加房间不能增加阻塞任务的并发上限。
            slots: self.slots.clone(),
        })
    }

    pub async fn authenticate(
        self: &Arc<Self>,
        token: String,
        role: PeerRole,
    ) -> Result<SessionGrant, AccessError> {
        if token.is_empty()
            || token.len() > MAX_TOKEN_BYTES
            || !token.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(AccessError::Denied);
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| AccessError::Busy)?;
        let access = self.clone();
        // 取消HTTP请求不会提前归还验签许可；不在媒体线程执行密码运算。
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            access.verify(&token, role)
        })
        .await
        .map_err(|_| AccessError::Unavailable)?
    }

    fn verify(&self, token: &str, role: PeerRole) -> Result<SessionGrant, AccessError> {
        let denied = || AccessError::Denied;
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
        let claims = decode::<LiveClaims>(token, key, &self.validation)
            .map_err(|_| denied())?
            .claims;
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AccessError::Unavailable)?
            .as_secs();
        if !label(&claims.sub)
            || claims.role != role
            || claims.tenant_id != self.binding.tenant_id
            || claims.room_id != self.binding.room_id
            || claims.node_id != self.binding.node_id
            || claims.incarnation != self.binding.incarnation
            || claims.iat == 0
            || claims.iat > at
            || claims.nbf < claims.iat
            || claims.nbf > at
            || claims.exp <= at
            || claims.exp <= claims.nbf
            || claims.exp.saturating_sub(claims.iat) > 300
            || claims
                .assignment_revision
                .is_some_and(|revision| revision == 0 || revision > 9_007_199_254_740_991)
        {
            return Err(denied());
        }
        Ok(SessionGrant {
            subject: claims.sub,
            expires_unix_seconds: claims.exp,
            assignment_revision: claims.assignment_revision,
            // 摘要已验签的签名输入；签名字节的等价编码不能成为撤权旁路。
            token_digest: ring::digest::digest(
                &ring::digest::SHA256,
                token
                    .rsplit_once('.')
                    .ok_or(AccessError::Denied)?
                    .0
                    .as_bytes(),
            )
            .as_ref()
            .try_into()
            .map_err(|_| AccessError::Unavailable)?,
        })
    }
}
