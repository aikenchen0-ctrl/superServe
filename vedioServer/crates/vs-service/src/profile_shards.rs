use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    profile::{ProfileEvent, ProfileEventResult},
    recommendation::ProfileProjection,
};

use crate::{
    ProfileHistoryCheckpoint, ProfileRemoteConfig,
    profile_client::{ProfileClient, ProfileClientError},
};

const SCHEMA: &str = "profile-shard-v1";
const MAX_SHARDS: u16 = 16;

/// 固定分片身份；不表示租约、复制代次或可安全升主的权威证明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileShard {
    pub schema: String,
    pub count: u16,
    pub index: u16,
}

impl ProfileShard {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA
            || !(2..=MAX_SHARDS).contains(&self.count)
            || !self.count.is_power_of_two()
            || self.index >= self.count
        {
            return Err("画像分片身份无效，数量须为2至16的二次幂".into());
        }
        Ok(())
    }

    pub fn owns(&self, subject: &str) -> bool {
        if self.validate().is_err() || !vs_core::valid_id(subject) {
            return false;
        }
        Self::subject_index(subject, self.count) == self.index
    }

    fn subject_index(subject: &str, count: u16) -> u16 {
        let mut hash = Sha256::new();
        hash.update(b"superserve-profile-shard-v1\0");
        hash.update(subject.as_bytes());
        let digest = hash.finalize();
        let key = u64::from_be_bytes(digest[..8].try_into().unwrap());
        (key % u64::from(count)) as u16
    }

    pub fn guard(&self) -> String {
        format!("{}:{}:{}", self.schema, self.count, self.index)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileShardRemote {
    pub shard: ProfileShard,
    pub endpoint: String,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileShardsConfig {
    pub schema: String,
    pub shards: Vec<ProfileShardRemote>,
}

pub(crate) enum ProfileBackend {
    Single(ProfileClient),
    Sharded(Vec<(ProfileShard, ProfileClient)>),
    Consensus(crate::profile_consensus::ProfileConsensusClient),
}

impl ProfileBackend {
    pub(crate) fn single(config: ProfileRemoteConfig, catalog: String) -> Result<Self, String> {
        Ok(Self::Single(ProfileClient::new(config, catalog)?))
    }

    pub(crate) fn consensus(
        config: crate::profile_consensus::ProfileConsensusConfig,
        catalog: String,
    ) -> Result<Self, String> {
        Ok(Self::Consensus(
            crate::profile_consensus::ProfileConsensusClient::new(config, catalog)?,
        ))
    }

    pub(crate) fn read_only(&self) -> bool {
        matches!(self, Self::Consensus(_))
    }

    pub(crate) fn sharded(config: ProfileShardsConfig, catalog: String) -> Result<Self, String> {
        let count = u16::try_from(config.shards.len()).map_err(|_| "画像分片数量超限")?;
        if config.schema != "profile-shards-v1"
            || !(2..=MAX_SHARDS).contains(&count)
            || !count.is_power_of_two()
        {
            return Err("画像分片配置无效或数量超限".into());
        }
        let mut clients = Vec::with_capacity(usize::from(count));
        let mut indexes = std::collections::HashSet::new();
        let mut endpoints = std::collections::HashSet::new();
        for remote in config.shards {
            remote.shard.validate()?;
            if remote.shard.count != count || !indexes.insert(remote.shard.index) {
                return Err("画像分片数量不符、重复或不完整".into());
            }
            let mut client = ProfileClient::new(
                ProfileRemoteConfig {
                    endpoint: remote.endpoint,
                    token: remote.token,
                },
                catalog.clone(),
            )?;
            if !endpoints.insert(client.endpoint().to_owned()) {
                return Err("画像分片不能共用同一入口".into());
            }
            client.shard = Some(remote.shard.clone());
            clients.push((remote.shard, client));
        }
        clients.sort_by_key(|(shard, _)| shard.index);
        Ok(Self::Sharded(clients))
    }

    fn for_subject(&self, subject: &str) -> Result<&ProfileClient, ProfileClientError> {
        match self {
            Self::Single(client) => Ok(client),
            Self::Consensus(_) => Err(ProfileClientError {
                status: axum::http::StatusCode::METHOD_NOT_ALLOWED,
                code: "共识画像适配仅允许读取，事件须走独立权威写入",
            }),
            Self::Sharded(clients) => {
                if !vs_core::valid_id(subject) {
                    return Err(ProfileClientError {
                        status: axum::http::StatusCode::BAD_REQUEST,
                        code: "画像主体无法路由",
                    });
                }
                // 配置已验证连续完整并排序；每次读写只哈希一次，不扫描主体或所有分片。
                let index = ProfileShard::subject_index(subject, clients[0].0.count);
                Ok(&clients[usize::from(index)].1)
            }
        }
    }

    pub(crate) fn endpoint(&self) -> Option<&str> {
        match self {
            Self::Single(client) => Some(client.endpoint()),
            Self::Sharded(_) | Self::Consensus(_) => None,
        }
    }

    pub(crate) fn history(&self) -> Option<&ProfileHistoryCheckpoint> {
        match self {
            Self::Single(client) => client.history(),
            Self::Sharded(_) | Self::Consensus(_) => None,
        }
    }

    pub(crate) fn with_history(self, checkpoint: ProfileHistoryCheckpoint) -> Result<Self, String> {
        match self {
            Self::Single(client) => Ok(Self::Single(client.with_history(checkpoint)?)),
            Self::Sharded(_) | Self::Consensus(_) => {
                Err("多分片或共识画像不能复用单日志历史水位".into())
            }
        }
    }

    pub(crate) async fn projection(
        &self,
        subject: &str,
        domains: &[String],
        profile_access: Option<&str>,
    ) -> Result<Option<ProfileProjection>, ProfileClientError> {
        if let Self::Consensus(client) = self {
            return client.projection(subject, domains, profile_access).await;
        }
        self.for_subject(subject)?
            .projection(subject, domains)
            .await
    }

    pub(crate) async fn event(
        &self,
        event: &ProfileEvent,
    ) -> Result<ProfileEventResult, ProfileClientError> {
        // 不广播，不因节点失败改投其他分片，也不生成第二个逻辑事件。
        self.for_subject(&event.subject)?.event(event).await
    }

    pub(crate) async fn ready(&self) -> Result<(), ProfileClientError> {
        match self {
            Self::Single(client) => client.ready().await,
            Self::Consensus(client) => client.ready().await,
            Self::Sharded(clients) => {
                let checks = futures_util::future::join_all(
                    clients.iter().map(|(_, client)| client.ready()),
                )
                .await;
                for result in checks {
                    result?;
                }
                Ok(())
            }
        }
    }
}
