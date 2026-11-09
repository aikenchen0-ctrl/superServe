// SPDX-License-Identifier: MIT
// 改编OpenRaft v0.9.25 raft-kv-memstore网络示例，复用客户端、地址白名单和请求预算。
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc, time::Duration};

use openraft::{
    BasicNode,
    error::{InstallSnapshotError, NetworkError, RPCError, RemoteError, Unreachable},
    network::{RPCOption, RaftNetwork, RaftNetworkFactory},
    raft::{
        AppendEntriesRequest, AppendEntriesResponse, InstallSnapshotRequest,
        InstallSnapshotResponse, VoteRequest, VoteResponse,
    },
};
use serde::{Serialize, de::DeserializeOwned};

use crate::{NodeId, RpcError, TypeConfig};

#[derive(Clone)]
pub struct Network {
    client: reqwest::Client,
    token: Arc<str>,
    peers: Arc<BTreeMap<NodeId, SocketAddr>>,
    policy: Arc<str>,
    server_names: Option<Arc<BTreeMap<NodeId, String>>>,
}

impl Network {
    pub fn new(
        token: String,
        peers: BTreeMap<NodeId, SocketAddr>,
        policy: String,
    ) -> Result<Self, reqwest::Error> {
        crate::ensure_http_crypto_provider();
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_millis(800))
                .connect_timeout(Duration::from_millis(250))
                .retry(reqwest::retry::never())
                .build()?,
            token: token.into(),
            peers: Arc::new(peers),
            policy: policy.into(),
            server_names: None,
        })
    }

    pub fn with_tls(mut self, transport: &crate::tls::TlsTransport) -> Self {
        self.client = transport.client();
        self.server_names = Some(Arc::new(transport.identity_policy().server_names().clone()));
        self
    }
}

pub struct Connection {
    network: Network,
    target: NodeId,
    node: BasicNode,
}

impl RaftNetworkFactory<TypeConfig> for Network {
    type Network = Connection;
    async fn new_client(&mut self, target: NodeId, node: &BasicNode) -> Self::Network {
        Connection {
            network: self.clone(),
            target,
            node: node.clone(),
        }
    }
}

impl Connection {
    async fn rpc<Q, S, E>(&self, path: &str, request: Q) -> Result<S, crate::RpcError<E>>
    where
        Q: Serialize,
        S: DeserializeOwned,
        E: std::error::Error + DeserializeOwned,
    {
        let addr = self
            .network
            .peers
            .get(&self.target)
            .filter(|addr| addr.to_string() == self.node.addr)
            .filter(|addr| self.network.server_names.is_some() || addr.ip().is_loopback())
            .ok_or_else(|| {
                RPCError::Unreachable(Unreachable::new(&std::io::Error::other(
                    "共识目标不在固定节点表",
                )))
            })?;
        let endpoint = if let Some(names) = &self.network.server_names {
            let name = names.get(&self.target).ok_or_else(|| {
                RPCError::Unreachable(Unreachable::new(&std::io::Error::other(
                    "TLS目标不在固定名称表",
                )))
            })?;
            format!("https://{name}:{}", addr.port())
        } else {
            format!("http://{addr}")
        };
        let response = self
            .network
            .client
            .post(format!("{endpoint}/raft/{path}"))
            .bearer_auth(&*self.network.token)
            .header("x-vs-room-policy", &*self.network.policy)
            .json(&request)
            .send()
            .await
            .map_err(|error| {
                if error.is_connect() {
                    RPCError::Unreachable(Unreachable::new(&error))
                } else {
                    RPCError::Network(NetworkError::new(&error))
                }
            })?
            .error_for_status()
            .map_err(|error| RPCError::Network(NetworkError::new(&error)))?;
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| RPCError::Network(NetworkError::new(&error)))?
        {
            if bytes.len().saturating_add(chunk.len()) > crate::SNAPSHOT_LIMIT {
                return Err(RPCError::Network(NetworkError::new(
                    &std::io::Error::other("共识应答超出预算"),
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        let result: Result<S, openraft::error::RaftError<NodeId, E>> =
            serde_json::from_slice(&bytes)
                .map_err(|error| RPCError::Network(NetworkError::new(&error)))?;
        result.map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
}

impl RaftNetwork<TypeConfig> for Connection {
    async fn append_entries(
        &mut self,
        request: AppendEntriesRequest<TypeConfig>,
        _: RPCOption,
    ) -> Result<AppendEntriesResponse<NodeId>, RpcError> {
        self.rpc("append", request).await
    }
    async fn vote(
        &mut self,
        request: VoteRequest<NodeId>,
        _: RPCOption,
    ) -> Result<VoteResponse<NodeId>, RpcError> {
        self.rpc("vote", request).await
    }
    async fn install_snapshot(
        &mut self,
        request: InstallSnapshotRequest<TypeConfig>,
        _: RPCOption,
    ) -> Result<InstallSnapshotResponse<NodeId>, RpcError<InstallSnapshotError>> {
        self.rpc("snapshot", request).await
    }
}
