use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Extras, Validation, decode, decode_header};
use serde::{Deserialize, Serialize};

const MAX_TOKEN_BYTES: usize = 4096;
const MAX_TOKEN_TTL_SECONDS: u64 = 300;
const TOKEN_TYPE: &str = "vs-profile-read+jwt";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileAccessKey {
    pub kid: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileAccessConfig {
    pub issuer: String,
    pub audience: String,
    pub keys: Vec<ProfileAccessKey>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

impl Audience {
    fn contains(&self, expected: &str) -> bool {
        match self {
            Self::One(value) => value == expected,
            Self::Many(values) => values.iter().any(|value| value == expected),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    iss: String,
    aud: Audience,
    sub: String,
    iat: u64,
    nbf: u64,
    exp: u64,
    domains: Vec<String>,
}

pub struct ProfileAccessClaims {
    pub subject: String,
    pub domains: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum ProfileAccessError {
    Invalid,
}

pub struct ProfileAccess {
    issuer: String,
    audience: String,
    keys: HashMap<String, DecodingKey>,
    validation: Validation,
}

impl ProfileAccess {
    pub fn new(config: ProfileAccessConfig) -> Result<Self, String> {
        if config.issuer.is_empty()
            || config.issuer.len() > 256
            || !config.issuer.bytes().all(|byte| byte.is_ascii_graphic())
            || !vs_core::valid_id(&config.audience)
            || !(1..=4).contains(&config.keys.len())
        {
            return Err("画像读取发行者、受众或公钥数量无效".into());
        }
        let mut keys = HashMap::new();
        for key in config.keys {
            let bytes = URL_SAFE_NO_PAD
                .decode(&key.public_key)
                .map_err(|_| "画像读取公钥必须使用无填充Base64URL")?;
            if !vs_core::valid_id(&key.kid)
                || bytes.len() != 32
                || bytes.iter().all(|byte| *byte == 0)
            {
                return Err("画像读取公钥长度、标识或重复配置无效".into());
            }
            let decoding = DecodingKey::from_ed_components(&key.public_key)
                .map_err(|_| "画像读取公钥编码无效")?;
            if keys.insert(key.kid, decoding).is_some() {
                return Err("画像读取公钥标识重复".into());
            }
        }
        vs_auth::install()?;
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_required_spec_claims(&["iss", "aud", "sub", "exp", "nbf"]);
        validation.set_issuer(&[config.issuer.as_str()]);
        validation.set_audience(&[config.audience.as_str()]);
        Ok(Self {
            issuer: config.issuer,
            audience: config.audience,
            keys,
            validation,
        })
    }

    pub fn authenticate(&self, token: &str) -> Result<ProfileAccessClaims, ProfileAccessError> {
        if token.is_empty()
            || token.len() > MAX_TOKEN_BYTES
            || !token.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(ProfileAccessError::Invalid);
        }
        let header = decode_header(token).map_err(|_| ProfileAccessError::Invalid)?;
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
            return Err(ProfileAccessError::Invalid);
        }
        let key = header
            .kid
            .as_deref()
            .and_then(|kid| self.keys.get(kid))
            .ok_or(ProfileAccessError::Invalid)?;
        let claims = decode::<Claims>(token, key, &self.validation)
            .map_err(|_| ProfileAccessError::Invalid)?
            .claims;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ProfileAccessError::Invalid)?
            .as_secs();
        let mut domains = HashSet::new();
        if claims.iss != self.issuer
            || !claims.aud.contains(&self.audience)
            || !vs_core::valid_id(&claims.sub)
            || claims.iat == 0
            || claims.iat > now
            || claims.nbf < claims.iat
            || claims.nbf > now
            || claims.exp <= now
            || claims.exp <= claims.nbf
            || claims.exp.saturating_sub(claims.iat) > MAX_TOKEN_TTL_SECONDS
            || claims.domains.is_empty()
            || claims.domains.len() > 16
            || claims
                .domains
                .iter()
                .any(|domain| !vs_core::valid_id(domain) || !domains.insert(domain))
        {
            return Err(ProfileAccessError::Invalid);
        }
        Ok(ProfileAccessClaims {
            subject: claims.sub,
            domains: claims.domains,
        })
    }
}
