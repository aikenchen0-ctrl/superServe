// 固定目标客户端和有界双向TLS接入；不包含服务角色、共识、媒体或凭据签发。
mod server;
pub use server::{FixedServerTls, VerifiedPeer, serve_https, serve_mtls};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Read},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use rustls::{
    RootCertStore,
    pki_types::{CertificateDer, PrivateKeyDer, UnixTime, pem::PemObject},
    server::WebPkiClientVerifier,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_PEM_BYTES: usize = 65_536;

pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixedClientTls {
    pub ca_file: PathBuf,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub certificate_sha256: String,
    pub server_names: BTreeMap<SocketAddr, String>,
}

pub fn allowed_endpoint(address: SocketAddr, tls: bool) -> bool {
    address.port() != 0
        && match address.ip() {
            std::net::IpAddr::V4(ip) => ip.is_loopback() || (tls && ip.is_private()),
            std::net::IpAddr::V6(ip) => ip.is_loopback() || (tls && ip.is_unique_local()),
        }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::other(message)
}

fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn read(path: &Path) -> io::Result<Vec<u8>> {
    if !path.is_absolute() {
        return Err(invalid("TLS文件路径必须为绝对路径"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_PEM_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > MAX_PEM_BYTES {
        return Err(invalid("TLS文件为空或超出64KiB"));
    }
    Ok(bytes)
}

fn certificates(bytes: &[u8]) -> io::Result<Vec<CertificateDer<'static>>> {
    let values = CertificateDer::pem_slice_iter(bytes)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid("TLS证书PEM无效"))?;
    if values.is_empty() || values.len() > 4 {
        return Err(invalid("TLS证书链数量须为1至4"));
    }
    Ok(values)
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_name(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        && value.parse::<std::net::IpAddr>().is_err()
}

impl FixedClientTls {
    pub fn client_builder(&self, endpoints: &[SocketAddr]) -> io::Result<reqwest::ClientBuilder> {
        ensure_crypto_provider();
        if !(1..=64).contains(&endpoints.len())
            || endpoints.iter().collect::<BTreeSet<_>>().len() != endpoints.len()
            || self.server_names.keys().copied().collect::<BTreeSet<_>>()
                != endpoints.iter().copied().collect()
            || self.server_names.values().any(|name| !valid_name(name))
            || self.server_names.values().collect::<BTreeSet<_>>().len() != endpoints.len()
            || endpoints
                .iter()
                .any(|address| !allowed_endpoint(*address, true))
            || !valid_fingerprint(&self.certificate_sha256)
        {
            return Err(invalid("客户端TLS端点、名称或本地证书指纹无效"));
        }
        let ca = certificates(&read(&self.ca_file)?)?;
        let certificate_pem = read(&self.certificate_file)?;
        let chain = certificates(&certificate_pem)?;
        if fingerprint(chain[0].as_ref()) != self.certificate_sha256 {
            return Err(invalid("客户端TLS本地证书与配置指纹不匹配"));
        }
        let key_pem = read(&self.private_key_file)?;
        let key =
            PrivateKeyDer::from_pem_slice(&key_pem).map_err(|_| invalid("客户端TLS私钥PEM无效"))?;
        let mut roots = RootCertStore::empty();
        for certificate in &ca {
            roots
                .add(certificate.clone())
                .map_err(|_| invalid("客户端TLS根证书无效"))?;
        }
        WebPkiClientVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|_| invalid("客户端TLS验证器创建失败"))?
            .verify_client_cert(&chain[0], &chain[1..], UnixTime::now())
            .map_err(|_| invalid("客户端TLS证书链、有效期或用途无效"))?;
        let provider = rustls::crypto::CryptoProvider::get_default()
            .ok_or_else(|| invalid("客户端TLS加密提供者不可用"))?;
        let certified = rustls::sign::CertifiedKey::from_der(chain, key, provider)
            .map_err(|_| invalid("客户端TLS证书与私钥不匹配"))?;
        // 加载成功可能仍无法判定一致性，必须明确匹配后才允许联网。
        certified
            .keys_match()
            .map_err(|_| invalid("客户端TLS私钥匹配未能确认"))?;
        let mut identity = certificate_pem;
        identity.push(b'\n');
        identity.extend_from_slice(&key_pem);
        client_builder_for_hosts(
            &ca,
            &identity,
            self.server_names
                .iter()
                .map(|(address, name)| (name.as_str(), *address)),
        )
    }
}

pub fn client_builder_for_hosts<'a>(
    ca: &[CertificateDer<'static>],
    identity_pem: &[u8],
    hosts: impl IntoIterator<Item = (&'a str, SocketAddr)>,
) -> io::Result<reqwest::ClientBuilder> {
    ensure_crypto_provider();
    let roots = ca
        .iter()
        .map(|cert| reqwest::Certificate::from_der(cert.as_ref()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid("TLS客户端根证书无效"))?;
    let mut builder = reqwest::Client::builder()
        .tls_backend_rustls()
        .http1_only()
        .https_only(true)
        .tls_version_min(reqwest::tls::Version::TLS_1_3)
        .tls_version_max(reqwest::tls::Version::TLS_1_3)
        .tls_certs_only(roots)
        .identity(
            reqwest::Identity::from_pem(identity_pem).map_err(|_| invalid("TLS客户端身份无效"))?,
        )
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_millis(1200))
        .pool_max_idle_per_host(2);
    for (name, address) in hosts {
        builder = builder.resolve(name, address);
    }
    Ok(builder)
}
