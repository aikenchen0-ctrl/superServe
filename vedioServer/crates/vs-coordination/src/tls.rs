// SPDX-License-Identifier: MIT
// 局部改编axum low-level-rustls示例，提交40d061fdacd468217c7a609bede16357276b6c40。
// Copyright (c) 2019-2025 axum Contributors
// 增加双向验证、固定角色、资源预算和有界停机；证书与签名验证仍由rustls执行。
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    io::{self, Read},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Router,
    extract::Request,
    middleware::{self, Next},
};
use rustls::{
    RootCertStore, ServerConfig,
    client::{WebPkiServerVerifier, danger::ServerCertVerifier},
    pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime, pem::PemObject},
    server::WebPkiClientVerifier,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;

use crate::NodeId;
pub use vs_tls::{FixedClientTls as OperatorTlsSettings, allowed_endpoint, fingerprint};

const MAX_PEM_BYTES: usize = 65_536;
pub const POLICY_MODE: &str = "coordination-mtls-v1";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TlsSettings {
    pub ca_file: PathBuf,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub server_names: BTreeMap<NodeId, String>,
    pub peer_sha256: BTreeMap<NodeId, String>,
    pub operator_sha256: Vec<String>,
    #[serde(default)]
    pub media_reader_sha256: BTreeMap<String, String>,
    #[serde(default)]
    pub profile_reader_sha256: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientRole {
    Node(NodeId),
    Operator,
    MediaReader(String),
    ProfileReader(String),
    Unknown,
}

#[derive(Serialize)]
pub struct TlsIdentityPolicy {
    schema: &'static str,
    ca_sha256: BTreeSet<String>,
    server_names: BTreeMap<NodeId, String>,
    peer_sha256: BTreeMap<NodeId, String>,
    operator_sha256: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    media_reader_sha256: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    profile_reader_sha256: BTreeMap<String, String>,
}

impl TlsIdentityPolicy {
    pub fn server_names(&self) -> &BTreeMap<NodeId, String> {
        &self.server_names
    }
}

pub struct TlsTransport {
    server: Arc<ServerConfig>,
    client: reqwest::Client,
    roles: Arc<BTreeMap<String, ClientRole>>,
    identity_policy: TlsIdentityPolicy,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::other(message)
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

impl TlsTransport {
    pub fn load(
        settings: &TlsSettings,
        node: NodeId,
        peers: &BTreeMap<NodeId, SocketAddr>,
    ) -> io::Result<Self> {
        crate::ensure_http_crypto_provider();
        if settings.server_names.keys().ne(peers.keys())
            || settings.peer_sha256.keys().ne(peers.keys())
            || settings.server_names.values().any(|name| !valid_name(name))
            || settings
                .server_names
                .values()
                .collect::<BTreeSet<_>>()
                .len()
                != peers.len()
            || !(1..=4).contains(&settings.operator_sha256.len())
            || settings.media_reader_sha256.len() > crate::media_registry::MAX_MEDIA_NODES
            || settings.profile_reader_sha256.len() > 16
        {
            return Err(invalid("TLS节点名称、名册或运维身份配置无效"));
        }
        let mut roles = BTreeMap::new();
        for (node, hash) in &settings.peer_sha256 {
            if !valid_fingerprint(hash)
                || roles
                    .insert(hash.clone(), ClientRole::Node(*node))
                    .is_some()
            {
                return Err(invalid("TLS节点证书指纹无效或重复"));
            }
        }
        for hash in &settings.operator_sha256 {
            if !valid_fingerprint(hash)
                || roles.insert(hash.clone(), ClientRole::Operator).is_some()
            {
                return Err(invalid("TLS运维证书指纹无效或与节点混用"));
            }
        }
        for (id, hash) in &settings.media_reader_sha256 {
            if !vs_core::valid_id(id)
                || matches!(id.as_str(), "." | "..")
                || !valid_fingerprint(hash)
                || roles
                    .insert(hash.clone(), ClientRole::MediaReader(id.clone()))
                    .is_some()
            {
                return Err(invalid("媒体只读证书的节点、指纹或角色无效"));
            }
        }
        for (id, hash) in &settings.profile_reader_sha256 {
            if !vs_core::valid_id(id)
                || matches!(id.as_str(), "." | "..")
                || !valid_fingerprint(hash)
                || roles
                    .insert(hash.clone(), ClientRole::ProfileReader(id.clone()))
                    .is_some()
            {
                return Err(invalid("画像只读证书的服务、指纹或角色无效"));
            }
        }
        let ca = certificates(&read(&settings.ca_file)?)?;
        let certificate_pem = read(&settings.certificate_file)?;
        let chain = certificates(&certificate_pem)?;
        let key_pem = read(&settings.private_key_file)?;
        let key = PrivateKeyDer::from_pem_slice(&key_pem).map_err(|_| invalid("TLS私钥PEM无效"))?;
        if settings.peer_sha256.get(&node) != Some(&fingerprint(chain[0].as_ref())) {
            return Err(invalid("TLS本节点证书与固定指纹不匹配"));
        }
        let mut roots = RootCertStore::empty();
        for cert in &ca {
            roots
                .add(cert.clone())
                .map_err(|_| invalid("TLS根证书无效"))?;
        }
        let roots = Arc::new(roots);
        let name = settings
            .server_names
            .get(&node)
            .ok_or_else(|| invalid("TLS本节点名称缺失"))?;
        let verifier = WebPkiServerVerifier::builder(roots.clone())
            .build()
            .map_err(|_| invalid("TLS服务验证器创建失败"))?;
        verifier
            .verify_server_cert(
                &chain[0],
                &chain[1..],
                &ServerName::try_from(name.clone()).map_err(|_| invalid("TLS节点名称无效"))?,
                &[],
                UnixTime::now(),
            )
            .map_err(|_| invalid("TLS本节点证书链、有效期或名称无效"))?;
        let verifier = WebPkiClientVerifier::builder(roots)
            .build()
            .map_err(|_| invalid("TLS客户端验证器创建失败"))?;
        verifier
            .verify_client_cert(&chain[0], &chain[1..], UnixTime::now())
            .map_err(|_| invalid("TLS本节点证书不具备有效客户端用途"))?;
        let mut server = ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
            .with_client_cert_verifier(verifier)
            .with_single_cert(chain, key)
            .map_err(|_| invalid("TLS证书与私钥不匹配"))?;
        server.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mut identity = certificate_pem;
        identity.push(b'\n');
        identity.extend_from_slice(&key_pem);
        let client = Self::client_builder(&ca, &identity, &settings.server_names, peers)?
            .build()
            .map_err(|_| invalid("TLS共识客户端创建失败"))?;
        Ok(Self {
            server: Arc::new(server),
            client,
            roles: Arc::new(roles),
            identity_policy: TlsIdentityPolicy {
                schema: "coordination-mtls-identity-v1",
                ca_sha256: ca.iter().map(|cert| fingerprint(cert.as_ref())).collect(),
                server_names: settings.server_names.clone(),
                peer_sha256: settings.peer_sha256.clone(),
                operator_sha256: settings.operator_sha256.iter().cloned().collect(),
                media_reader_sha256: settings.media_reader_sha256.clone(),
                profile_reader_sha256: settings.profile_reader_sha256.clone(),
            },
        })
    }

    pub fn client_builder(
        ca: &[CertificateDer<'static>],
        identity_pem: &[u8],
        names: &BTreeMap<NodeId, String>,
        peers: &BTreeMap<NodeId, SocketAddr>,
    ) -> io::Result<reqwest::ClientBuilder> {
        let hosts = peers
            .iter()
            .map(|(id, address)| {
                names
                    .get(id)
                    .map(|name| (name.as_str(), *address))
                    .ok_or_else(|| invalid("TLS目标名称缺失"))
            })
            .collect::<io::Result<Vec<_>>>()?;
        vs_tls::client_builder_for_hosts(ca, identity_pem, hosts)
    }

    pub fn client(&self) -> reqwest::Client {
        self.client.clone()
    }
    pub fn identity_policy(&self) -> &TlsIdentityPolicy {
        &self.identity_policy
    }

    pub fn authority(&self, id: NodeId, address: SocketAddr) -> io::Result<String> {
        let name = self
            .identity_policy
            .server_names
            .get(&id)
            .ok_or_else(|| invalid("TLS目标不在固定名称表"))?;
        Ok(format!("{name}:{}", address.port()))
    }

    pub async fn serve(
        &self,
        listener: TcpListener,
        app: Router,
        shutdown: impl Future<Output = ()>,
    ) -> io::Result<()> {
        let roles = self.roles.clone();
        let app = app.layer(middleware::from_fn(
            move |mut request: Request, next: Next| {
                let roles = roles.clone();
                async move {
                    let role = request
                        .extensions()
                        .get::<vs_tls::VerifiedPeer>()
                        .and_then(|peer| roles.get(peer.sha256()))
                        .cloned()
                        .unwrap_or(ClientRole::Unknown);
                    request.extensions_mut().insert(role);
                    next.run(request).await
                }
            },
        ));
        vs_tls::serve_mtls(self.server.clone(), listener, app, shutdown).await
    }
}
