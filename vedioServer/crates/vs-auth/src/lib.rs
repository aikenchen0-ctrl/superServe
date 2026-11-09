// 通过jsonwebtoken 11.1.0的公开扩展接口复用现有ring，仅提供Ed25519验签。
use std::sync::OnceLock;

use jsonwebtoken::{
    Algorithm, AlgorithmFamily, DecodingKey, EncodingKey,
    crypto::{CryptoProvider, JwtSigner, JwtVerifier, KeyUtils},
    errors::{ErrorKind, Result, new_error},
    signature::{Error, Verifier},
};
use ring::signature::{ED25519, UnparsedPublicKey};

struct RingEd25519(UnparsedPublicKey<Vec<u8>>);

impl Verifier<Vec<u8>> for RingEd25519 {
    fn verify(&self, message: &[u8], signature: &Vec<u8>) -> std::result::Result<(), Error> {
        self.0.verify(message, signature).map_err(|_| Error::new())
    }
}

impl JwtVerifier for RingEd25519 {
    fn algorithm(&self) -> Algorithm {
        Algorithm::EdDSA
    }
}

fn verifier(algorithm: &Algorithm, key: &DecodingKey) -> Result<Box<dyn JwtVerifier>> {
    if *algorithm != Algorithm::EdDSA || key.family() != AlgorithmFamily::Ed {
        return Err(new_error(ErrorKind::InvalidAlgorithm));
    }
    let bytes = key.try_get_as_bytes()?;
    if bytes.len() != 32 {
        return Err(new_error(ErrorKind::InvalidEddsaKey));
    }
    Ok(Box::new(RingEd25519(UnparsedPublicKey::new(
        &ED25519,
        bytes.to_vec(),
    ))))
}

fn signer(_: &Algorithm, _: &EncodingKey) -> Result<Box<dyn JwtSigner>> {
    Err(new_error(ErrorKind::UnsupportedAlgorithm))
}

static PROVIDER: CryptoProvider = CryptoProvider {
    signer_factory: signer,
    verifier_factory: verifier,
    // 该入口不处理JWK或签发，意外调用同样返回错误，避免上游默认占位函数触发panic。
    key_utils: KeyUtils {
        rsa_pub_components_from_private_key: |_| Err(new_error(ErrorKind::UnsupportedAlgorithm)),
        rsa_pub_components_from_public_key: |_| Err(new_error(ErrorKind::UnsupportedAlgorithm)),
        ec_pub_components_from_private_key: |_, _| Err(new_error(ErrorKind::UnsupportedAlgorithm)),
        ed_pub_components_from_private_key: |_, _| Err(new_error(ErrorKind::UnsupportedAlgorithm)),
        compute_digest: |_, _| Err(new_error(ErrorKind::UnsupportedAlgorithm)),
    },
};

pub fn install() -> std::result::Result<(), String> {
    static INSTALLATION: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    INSTALLATION
        .get_or_init(|| {
            PROVIDER
                .install_default()
                .map_err(|_| "JWT进程级密码后端已被其他使用者设置".into())
        })
        .clone()
}
