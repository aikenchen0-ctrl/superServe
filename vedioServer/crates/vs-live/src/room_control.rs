use std::{net::SocketAddr, sync::Arc, time::Duration};

use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use vs_core::room_assignment::{AssignmentView, MediaFence, MediaTarget};
use vs_tls::{FixedClientTls, allowed_endpoint};

use crate::{RelayError, access::LiveBinding};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoomControlConfig {
    pub cluster_id: String,
    pub coordination_endpoints: Vec<String>,
    pub coordination_token: String,
    pub control_token: String,
    #[serde(default)]
    pub coordination_tls: Option<FixedClientTls>,
}

pub struct RoomControl {
    config: RoomControlConfig,
    client: reqwest::Client,
    slots: Arc<Semaphore>,
    endpoints: Vec<String>,
}

fn token_valid(value: &str) -> bool {
    (32..=256).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_graphic())
}

impl RoomControl {
    pub fn new(config: RoomControlConfig) -> Result<Self, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        if config.cluster_id.is_empty()
            || config.cluster_id.len() > 64
            || !config.cluster_id.is_ascii()
            || !(1..=5).contains(&config.coordination_endpoints.len())
            || !token_valid(&config.coordination_token)
            || !token_valid(&config.control_token)
        {
            return Err("媒体房间控制配置无效".into());
        }
        let mut addresses = Vec::new();
        let tls = config.coordination_tls.as_ref();
        let scheme = if tls.is_some() { "https" } else { "http" };
        for endpoint in &config.coordination_endpoints {
            let url = reqwest::Url::parse(endpoint).map_err(|_| "协调地址无效")?;
            let address = endpoint
                .strip_prefix(&format!("{scheme}://"))
                .and_then(|address| address.parse::<SocketAddr>().ok());
            if url.scheme() != scheme
                || !address.is_some_and(|address| allowed_endpoint(address, tls.is_some()))
                || url.query().is_some()
                || url.fragment().is_some()
                || url.password().is_some()
                || !url.username().is_empty()
            {
                return Err("协调地址必须是固定根地址，明文仅回环、私网必须配置TLS".into());
            }
            addresses.push(address.unwrap());
        }
        let (builder, endpoints) = if let Some(tls) = tls {
            let builder = tls
                .client_builder(&addresses)
                .map_err(|error| error.to_string())?;
            let endpoints = addresses
                .iter()
                .map(|address| format!("https://{}:{}", tls.server_names[address], address.port()))
                .collect();
            (builder, endpoints)
        } else {
            (
                reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never()),
                config.coordination_endpoints.clone(),
            )
        };
        let client = builder
            .connect_timeout(Duration::from_millis(200))
            .timeout(Duration::from_millis(500))
            .build()
            .map_err(|_| "协调HTTP客户端创建失败")?;
        Ok(Self {
            config,
            client,
            slots: Arc::new(Semaphore::new(4)),
            endpoints,
        })
    }

    pub fn cluster_id(&self) -> &str {
        &self.config.cluster_id
    }

    pub fn authenticate(&self, token: &str) -> bool {
        bool::from(token.as_bytes().ct_eq(self.config.control_token.as_bytes()))
    }

    pub fn matches(&self, binding: &LiveBinding, fence: &MediaFence) -> bool {
        fence.cluster_id == self.config.cluster_id
            && fence.tenant_id == binding.tenant_id
            && fence.room_id == binding.room_id
            && fence.target
                == MediaTarget {
                    node_id: binding.node_id.clone(),
                    incarnation: binding.incarnation.clone(),
                }
            && fence.revision > 0
            && fence.revision <= 9_007_199_254_740_991
    }

    pub async fn verify_activation(&self, fence: &MediaFence) -> Result<(), RelayError> {
        let _permit = self.slots.try_acquire().map_err(|_| RelayError::Busy)?;
        tokio::time::timeout(Duration::from_secs(2), async {
            for endpoint in &self.endpoints {
                let response = self
                    .client
                    .get(format!(
                        "{endpoint}/v1/room-assignments/{}/{}",
                        fence.tenant_id, fence.room_id
                    ))
                    .bearer_auth(&self.config.coordination_token)
                    .send()
                    .await;
                let Ok(mut response) = response else {
                    continue;
                };
                if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE
                    || response.status() == reqwest::StatusCode::GATEWAY_TIMEOUT
                {
                    continue;
                }
                if response.status() != reqwest::StatusCode::OK {
                    return Err(RelayError::Unavailable);
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| RelayError::Unavailable)?
                {
                    if bytes.len() + chunk.len() > 8192 {
                        return Err(RelayError::Unavailable);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let view: AssignmentView =
                    serde_json::from_slice(&bytes).map_err(|_| RelayError::Unavailable)?;
                if view.cluster_id != fence.cluster_id
                    || view.tenant_id != fence.tenant_id
                    || view.room_id != fence.room_id
                    || !view.record.is_some_and(|record| {
                        record.revision == fence.revision
                            && record.owner.as_ref() == Some(&fence.target)
                    })
                {
                    return Err(RelayError::Conflict);
                }
                return Ok(());
            }
            Err(RelayError::Unavailable)
        })
        .await
        .map_err(|_| RelayError::Unavailable)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, path::PathBuf};

    fn config(endpoint: &str, tls: bool) -> RoomControlConfig {
        RoomControlConfig {
            cluster_id: "cluster".into(),
            coordination_endpoints: vec![endpoint.into()],
            coordination_token: "test-coordination-token-with-32-bytes".into(),
            control_token: "test-media-control-token-with-32-bytes".into(),
            coordination_tls: tls.then(|| FixedClientTls {
                ca_file: PathBuf::from("not-loaded.pem"),
                certificate_file: PathBuf::from("not-loaded.pem"),
                private_key_file: PathBuf::from("not-loaded.key"),
                certificate_sha256: "a".repeat(64),
                server_names: BTreeMap::new(),
            }),
        }
    }

    #[test]
    fn transport_mode_and_fixed_roots_are_checked_before_reading_tls_material() {
        assert!(RoomControl::new(config("http://127.0.0.1:32000", false)).is_ok());
        for (endpoint, tls) in [
            ("http://10.20.0.1:7443", false),
            ("https://127.0.0.1:7443", false),
            ("http://127.0.0.1:7443", true),
            ("https://192.0.2.1:7443", true),
            ("https://10.20.0.1:7443/path", true),
            ("https://10.20.0.1:7443?x=1", true),
            ("https://10.20.0.1:7443#fragment", true),
            ("https://user@10.20.0.1:7443", true),
            ("https://0.0.0.0:7443", true),
        ] {
            let error = RoomControl::new(config(endpoint, tls)).err().unwrap();
            assert!(error.contains("协调地址"), "必须先拒绝端点模式：{endpoint}");
        }
    }
}
