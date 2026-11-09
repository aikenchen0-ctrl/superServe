// SPDX-License-Identifier: MIT
// 迁移既有Axum低层接入改编，源提交40d061fdacd468217c7a609bede16357276b6c40。
// Copyright (c) 2019-2025 axum Contributors
use std::{future::Future, io, path::PathBuf, sync::Arc, time::Duration};

use axum::{Router, extract::Request};
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use rustls::{
    RootCertStore, ServerConfig,
    client::{WebPkiServerVerifier, danger::ServerCertVerifier},
    pki_types::{PrivateKeyDer, ServerName, UnixTime, pem::PemObject},
    server::WebPkiClientVerifier,
};
use serde::Deserialize;
use tokio::{
    net::TcpListener,
    sync::{Semaphore, watch},
    task::JoinSet,
};
use tokio_rustls::TlsAcceptor;
use tower::Service;

use super::{
    certificates, ensure_crypto_provider, fingerprint, invalid, read, valid_fingerprint, valid_name,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixedServerTls {
    pub ca_file: PathBuf,
    pub certificate_file: PathBuf,
    pub private_key_file: PathBuf,
    pub certificate_sha256: String,
    pub server_name: String,
}

#[derive(Clone)]
pub struct VerifiedPeer {
    sha256: Arc<str>,
}

impl VerifiedPeer {
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

impl FixedServerTls {
    pub fn load(&self) -> io::Result<Arc<ServerConfig>> {
        self.load_mode(true)
    }

    pub fn load_https(&self) -> io::Result<Arc<ServerConfig>> {
        self.load_mode(false)
    }

    fn load_mode(&self, client_auth: bool) -> io::Result<Arc<ServerConfig>> {
        ensure_crypto_provider();
        if !valid_name(&self.server_name) || !valid_fingerprint(&self.certificate_sha256) {
            return Err(invalid("TLS服务名称或本地证书指纹无效"));
        }
        let ca = certificates(&read(&self.ca_file)?)?;
        let chain = certificates(&read(&self.certificate_file)?)?;
        if fingerprint(chain[0].as_ref()) != self.certificate_sha256 {
            return Err(invalid("TLS服务证书与配置指纹不匹配"));
        }
        let key = PrivateKeyDer::from_pem_slice(&read(&self.private_key_file)?)
            .map_err(|_| invalid("TLS服务私钥PEM无效"))?;
        let mut roots = RootCertStore::empty();
        for cert in ca {
            roots.add(cert).map_err(|_| invalid("TLS服务根证书无效"))?;
        }
        let roots = Arc::new(roots);
        WebPkiServerVerifier::builder(roots.clone())
            .build()
            .map_err(|_| invalid("TLS服务验证器创建失败"))?
            .verify_server_cert(
                &chain[0],
                &chain[1..],
                &ServerName::try_from(self.server_name.clone())
                    .map_err(|_| invalid("TLS服务名称无效"))?,
                &[],
                UnixTime::now(),
            )
            .map_err(|_| invalid("TLS服务证书链、名称、有效期或用途无效"))?;
        let provider = rustls::crypto::CryptoProvider::get_default()
            .ok_or_else(|| invalid("TLS服务加密提供者不可用"))?;
        rustls::sign::CertifiedKey::from_der(chain.clone(), key.clone_key(), provider)
            .map_err(|_| invalid("TLS服务私钥加载失败"))?
            .keys_match()
            .map_err(|_| invalid("TLS服务私钥匹配未能确认"))?;
        let builder = ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13]);
        let builder = if client_auth {
            let verifier = WebPkiClientVerifier::builder(roots)
                .build()
                .map_err(|_| invalid("TLS服务客户端验证器创建失败"))?;
            builder.with_client_cert_verifier(verifier)
        } else {
            builder.with_no_client_auth()
        };
        let mut config = builder
            .with_single_cert(chain, key)
            .map_err(|_| invalid("TLS服务证书与私钥不匹配"))?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }
}

pub async fn serve_mtls(
    config: Arc<ServerConfig>,
    listener: TcpListener,
    app: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    serve(config, listener, app, shutdown, true).await
}

pub async fn serve_https(
    config: Arc<ServerConfig>,
    listener: TcpListener,
    app: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    serve(config, listener, app, shutdown, false).await
}

async fn serve(
    config: Arc<ServerConfig>,
    listener: TcpListener,
    app: Router,
    shutdown: impl Future<Output = ()>,
    require_client: bool,
) -> io::Result<()> {
    let acceptor = TlsAcceptor::from(config);
    let permits = Arc::new(Semaphore::new(32));
    let (stop, stopped) = watch::channel(false);
    let mut connections = JoinSet::new();
    tokio::pin!(shutdown);
    let result = loop {
        tokio::select! {
            _ = &mut shutdown => break Ok(()),
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            incoming = listener.accept() => {
                let (socket, _) = match incoming { Ok(value) => value, Err(error) => break Err(error) };
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                let (acceptor, app, mut stopped) = (acceptor.clone(), app.clone(), stopped.clone());
                connections.spawn(async move {
                    let _permit = permit;
                    let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(2), acceptor.accept(socket)).await else { return; };
                    let peer = if require_client {
                        let Some(leaf) = stream.get_ref().1.peer_certificates().and_then(|chain| chain.first()) else { return; };
                        Some(VerifiedPeer { sha256: fingerprint(leaf.as_ref()).into() })
                    } else { None };
                    let service = hyper::service::service_fn(move |mut request: Request<Incoming>| {
                        if let Some(peer) = &peer {
                            request.extensions_mut().insert(peer.clone());
                        }
                        app.clone().call(request)
                    });
                    let mut builder = hyper::server::conn::http1::Builder::new();
                    builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(2)).max_buf_size(32 * 1024);
                    let connection = builder.serve_connection(TokioIo::new(stream), service);
                    tokio::pin!(connection);
                    tokio::select! {
                        _ = &mut connection => {},
                        _ = stopped.changed() => {
                            connection.as_mut().graceful_shutdown();
                            let _ = tokio::time::timeout(Duration::from_secs(2), &mut connection).await;
                        },
                        _ = tokio::time::sleep(Duration::from_secs(30)) => {},
                    }
                });
            }
        }
    };
    let _ = stop.send(true);
    if tokio::time::timeout(Duration::from_secs(3), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.shutdown().await;
    }
    result
}
