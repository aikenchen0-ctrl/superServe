use std::{collections::BTreeMap, net::SocketAddr, time::Duration};

use serde::{Deserialize, Serialize};
use vs_core::room_assignment::{MediaControlReceipt, MediaFence, MediaPhase, MediaTarget};
use vs_tls::{FixedClientTls, allowed_endpoint};

use crate::{Raft, RoomCommand, media_registry::MediaRegistryPolicy, storage::StateStore};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaReleaseConfig {
    pub endpoints: BTreeMap<String, SocketAddr>,
    pub control_token: String,
    #[serde(default)]
    pub dynamic_nodes: bool,
    #[serde(default)]
    pub node_draining: bool,
    #[serde(default)]
    pub tls: Option<FixedClientTls>,
}

#[derive(Serialize)]
pub struct MediaReleasePolicy<'a> {
    endpoints: &'a BTreeMap<String, SocketAddr>,
    control_token: &'a str,
    #[serde(skip_serializing_if = "is_false")]
    dynamic_nodes: bool,
    #[serde(skip_serializing_if = "is_false")]
    node_draining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registry_server_names: Option<&'a BTreeMap<SocketAddr, String>>,
}

impl MediaReleaseConfig {
    pub fn policy(&self) -> MediaReleasePolicy<'_> {
        MediaReleasePolicy {
            endpoints: &self.endpoints,
            control_token: &self.control_token,
            dynamic_nodes: self.dynamic_nodes,
            node_draining: self.node_draining,
            transport: self.tls.as_ref().map(|_| {
                if self.dynamic_nodes {
                    "media-registry-mtls-v1"
                } else {
                    "media-control-mtls-v1"
                }
            }),
            registry_server_names: self
                .tls
                .as_ref()
                .filter(|_| self.dynamic_nodes)
                .map(|tls| &tls.server_names),
        }
    }

    pub fn registry_policy(&self) -> Result<MediaRegistryPolicy, String> {
        validate_config(self)?;
        Ok(if !self.dynamic_nodes {
            MediaRegistryPolicy::Disabled
        } else if self.tls.is_some() {
            MediaRegistryPolicy::MtlsV1(self.endpoints.clone())
        } else {
            MediaRegistryPolicy::LoopbackHttp
        })
    }
}

fn is_false(value: &bool) -> bool {
    !value
}

pub struct MediaRelease {
    config: MediaReleaseConfig,
    client: reqwest::Client,
    registry_policy: MediaRegistryPolicy,
}

impl MediaRelease {
    pub fn new(config: MediaReleaseConfig) -> Result<Self, String> {
        let registry_policy = config.registry_policy()?;
        crate::ensure_http_crypto_provider();
        let builder = if let Some(tls) = &config.tls {
            tls.client_builder(&config.endpoints.values().copied().collect::<Vec<_>>())
                .map_err(|error| error.to_string())?
        } else {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
        };
        let client = builder
            .connect_timeout(Duration::from_millis(200))
            .timeout(Duration::from_millis(1500))
            .build()
            .map_err(|_| "媒体排空HTTP客户端创建失败")?;
        Ok(Self {
            config,
            client,
            registry_policy,
        })
    }

    pub fn registry_required(&self) -> bool {
        self.config.dynamic_nodes
    }

    pub fn node_draining_enabled(&self) -> bool {
        self.config.node_draining
    }

    pub fn registry_accepts(&self, command: &crate::media_registry::MediaNodeCommand) -> bool {
        self.registry_policy.accepts_command(command)
    }

    pub async fn before_release(
        &self,
        raft: &Raft,
        store: &StateStore,
        cluster: &str,
        command: &RoomCommand,
    ) -> Result<(), ()> {
        let RoomCommand::Release {
            tenant_id,
            room_id,
            expected_revision,
            target,
            ..
        } = command
        else {
            return Ok(());
        };
        raft.ensure_linearizable().await.map_err(|_| ())?;
        let current = store.room(&format!("{tenant_id}/{room_id}")).await;
        // 重试已提交释放或冲突请求时，不向可能的新会话发排空；最终结果仍由Raft状态机裁决。
        if !current.as_ref().is_some_and(|record| {
            record.revision == *expected_revision && record.owner.as_ref() == Some(target)
        }) {
            return Ok(());
        }
        let endpoint = if self.config.dynamic_nodes {
            let registration = store
                .media_node(&target.node_id)
                .await
                .and_then(|record| record.registration)
                .ok_or(())?;
            if registration.target != *target {
                return Err(());
            }
            // 登记只描述业务实例；不能自行取得目录之外的网络访问权。
            if !self.registry_policy.accepts_registration(&registration) {
                return Err(());
            }
            registration.endpoint
        } else {
            *self.config.endpoints.get(&target.node_id).ok_or(())?
        };
        let fence = MediaFence {
            cluster_id: cluster.into(),
            tenant_id: tenant_id.clone(),
            room_id: room_id.clone(),
            target: MediaTarget {
                node_id: target.node_id.clone(),
                incarnation: target.incarnation.clone(),
            },
            revision: *expected_revision,
        };
        let authority = if let Some(tls) = &self.config.tls {
            let name = tls.server_names.get(&endpoint).ok_or(())?;
            format!("https://{name}:{}", endpoint.port())
        } else {
            format!("http://{endpoint}")
        };
        let mut response = self
            .client
            .post(format!("{authority}/admin/room/drain"))
            .bearer_auth(&self.config.control_token)
            .json(&fence)
            .send()
            .await
            .map_err(|_| ())?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if bytes.len() + chunk.len() > 8192 {
                return Err(());
            }
            bytes.extend_from_slice(&chunk);
        }
        let receipt: MediaControlReceipt = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if receipt.fence != fence
            || receipt.phase != MediaPhase::Drained
            || receipt.active_peers != 0
        {
            return Err(());
        }
        Ok(())
    }
}

fn validate_config(config: &MediaReleaseConfig) -> Result<(), String> {
    if config.node_draining && !config.dynamic_nodes {
        return Err("节点排空必须先启用动态登记".into());
    }
    let dynamic_plain = config.dynamic_nodes && config.tls.is_none();
    let invalid_directory = config.dynamic_nodes
        && config.tls.is_some()
        && (config
            .endpoints
            .keys()
            .any(|id| !crate::label(id) || matches!(id.as_str(), "." | ".."))
            || config
                .endpoints
                .values()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != config.endpoints.len());
    if (dynamic_plain && !config.endpoints.is_empty())
        || (!dynamic_plain && !(1..=64).contains(&config.endpoints.len()))
        || invalid_directory
        || !(32..=256).contains(&config.control_token.len())
        || !config
            .control_token
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
        || !config
            .endpoints
            .values()
            .all(|address| allowed_endpoint(*address, config.tls.is_some()))
    {
        return Err("媒体排空名册或服务凭据无效".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_mode_is_explicit_and_legacy_policy_serialization_stays_identical() {
        let legacy = serde_json::json!({
            "endpoints": {"media": "127.0.0.1:32001"},
            "control_token": "test-control-token-with-at-least-32-bytes"
        });
        let config: MediaReleaseConfig = serde_json::from_value(legacy.clone()).unwrap();
        assert!(!config.dynamic_nodes);
        assert!(!config.node_draining);
        assert_eq!(serde_json::to_value(config.policy()).unwrap(), legacy);
        // 冻结旧持久策略的字段顺序，不能把JSON重排当成无需迁移。
        assert_eq!(serde_json::to_vec(&Some(config.policy())).unwrap(),
            br#"{"endpoints":{"media":"127.0.0.1:32001"},"control_token":"test-control-token-with-at-least-32-bytes"}"#);
        assert!(validate_config(&config).is_ok());
        for (dynamic, endpoints, accepted) in [
            (false, BTreeMap::new(), false),
            (true, BTreeMap::new(), true),
            (
                true,
                BTreeMap::from([("media".into(), "127.0.0.1:32001".parse().unwrap())]),
                false,
            ),
        ] {
            let config = MediaReleaseConfig {
                endpoints,
                control_token: "test-control-token-with-at-least-32-bytes".into(),
                dynamic_nodes: dynamic,
                node_draining: false,
                tls: None,
            };
            assert_eq!(validate_config(&config).is_ok(), accepted);
        }
        let enabled = MediaReleaseConfig {
            endpoints: BTreeMap::new(),
            control_token: "test-control-token-with-at-least-32-bytes".into(),
            dynamic_nodes: true,
            node_draining: true,
            tls: None,
        };
        assert!(validate_config(&enabled).is_ok());
        assert_eq!(
            serde_json::to_value(enabled.policy()).unwrap()["node_draining"],
            true
        );
        assert!(
            validate_config(&MediaReleaseConfig {
                dynamic_nodes: false,
                ..enabled
            })
            .is_err()
        );
    }

    #[test]
    fn tls_policy_pins_mode_not_rotating_identity_and_requires_dynamic_directory() {
        let value = serde_json::json!({
            "endpoints":{"media":"127.0.0.1:32001"},
            "control_token":"test-control-token-with-at-least-32-bytes",
            "tls":{
                "ca_file":"O:/test/ca.pem","certificate_file":"O:/test/node-1.pem",
                "private_key_file":"O:/test/node-1.key","certificate_sha256":"a".repeat(64),
                "server_names":{"127.0.0.1:32001":"media.control.test"}
            }
        });
        let first: MediaReleaseConfig = serde_json::from_value(value.clone()).unwrap();
        let mut rotated = value.clone();
        rotated["tls"]["certificate_file"] = serde_json::json!("O:/test/node-2.pem");
        rotated["tls"]["private_key_file"] = serde_json::json!("O:/test/node-2.key");
        rotated["tls"]["certificate_sha256"] = serde_json::json!("b".repeat(64));
        let second: MediaReleaseConfig = serde_json::from_value(rotated).unwrap();
        assert_eq!(
            serde_json::to_vec(&first.policy()).unwrap(),
            serde_json::to_vec(&second.policy()).unwrap()
        );
        let mut plain = value.clone();
        plain.as_object_mut().unwrap().remove("tls");
        let plain: MediaReleaseConfig = serde_json::from_value(plain).unwrap();
        assert_ne!(
            serde_json::to_vec(&first.policy()).unwrap(),
            serde_json::to_vec(&plain.policy()).unwrap()
        );
        let mut dynamic = value;
        dynamic["dynamic_nodes"] = serde_json::json!(true);
        dynamic["endpoints"] = serde_json::json!({});
        assert!(validate_config(&serde_json::from_value(dynamic).unwrap()).is_err());
    }

    #[test]
    fn dynamic_tls_policy_pins_node_address_and_name_but_not_rotating_local_identity() {
        let value = serde_json::json!({
            "endpoints":{"media":"10.12.0.2:7443"},
            "control_token":"test-control-token-with-at-least-32-bytes",
            "dynamic_nodes":true,"node_draining":true,
            "tls":{
                "ca_file":"O:/test/ca.pem","certificate_file":"O:/test/node-1.pem",
                "private_key_file":"O:/test/node-1.key","certificate_sha256":"a".repeat(64),
                "server_names":{"10.12.0.2:7443":"media.control.test"}
            }
        });
        let original: MediaReleaseConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(original.registry_policy().is_ok());
        let frozen = serde_json::to_value(original.policy()).unwrap();
        assert_eq!(frozen["transport"], "media-registry-mtls-v1");
        assert_eq!(
            frozen["registry_server_names"],
            value["tls"]["server_names"]
        );
        for field in ["certificate_file", "private_key_file", "certificate_sha256"] {
            let mut rotated = value.clone();
            rotated["tls"][field] = serde_json::json!("different-local-identity");
            let config: MediaReleaseConfig = serde_json::from_value(rotated).unwrap();
            assert_eq!(serde_json::to_value(config.policy()).unwrap(), frozen);
        }
        for change in ["name", "address", "node", "mode"] {
            let mut changed = value.clone();
            match change {
                "name" => {
                    changed["tls"]["server_names"]["10.12.0.2:7443"] =
                        serde_json::json!("other.control.test")
                }
                "address" => changed["endpoints"]["media"] = serde_json::json!("10.12.0.3:7443"),
                "node" => changed["endpoints"] = serde_json::json!({"other":"10.12.0.2:7443"}),
                "mode" => changed["dynamic_nodes"] = serde_json::json!(false),
                _ => unreachable!(),
            }
            let config: MediaReleaseConfig = serde_json::from_value(changed).unwrap();
            assert_ne!(
                serde_json::to_value(config.policy()).unwrap(),
                frozen,
                "{change}"
            );
        }
    }
}
