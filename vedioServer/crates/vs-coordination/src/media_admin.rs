use std::{collections::BTreeSet, io, net::SocketAddr, time::Duration};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::{
    MAX_ROOMS, RoomRecord,
    media_registry::{MediaNodeCommand, MediaNodeRecord, MediaNodeReply},
    tls::{OperatorTlsSettings, allowed_endpoint},
};

const MAX_RESPONSE_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaAdminConfig {
    pub cluster_id: String,
    pub endpoints: Vec<SocketAddr>,
    pub service_token: String,
    #[serde(default)]
    pub tls: Option<OperatorTlsSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OwnedRoom {
    pub tenant_id: String,
    pub room_id: String,
    pub record: RoomRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MaintenanceView {
    pub cluster_id: String,
    pub node_id: String,
    pub record: Option<MediaNodeRecord>,
    pub owned_rooms: Vec<OwnedRoom>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceOutcome {
    Confirmed,
    Rejected,
    Conflict,
    InUse,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationStage {
    Preview,
    Readback,
}

#[derive(Debug, Serialize)]
pub struct MaintenanceReceipt {
    pub schema: &'static str,
    pub outcome: MaintenanceOutcome,
    pub evidence: &'static str,
    pub writes_sent: usize,
    pub http_status: Option<u16>,
    pub command: MediaNodeCommand,
    pub observed: Option<MaintenanceView>,
    pub observation_stage: Option<ObservationStage>,
    pub confirmed_record: Option<MediaNodeRecord>,
    pub service_record: Option<MediaNodeRecord>,
    pub service_outcome: Option<String>,
}

pub struct MediaAdmin {
    config: MediaAdminConfig,
    client: reqwest::Client,
    endpoints: Vec<String>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::other(message)
}

fn revision(value: u64) -> bool {
    (1..=9_007_199_254_740_991).contains(&value)
}

pub(crate) fn valid_record(id: &str, record: &MediaNodeRecord) -> bool {
    if !revision(record.revision)
        || !record.last_command.valid()
        || record.last_command.target().node_id != id
    {
        return false;
    }
    if let Some(entry) = &record.registration
        && !(MediaNodeCommand::RegisterMedia {
            operation_id: "validate-record".into(),
            expected_revision: None,
            registration: entry.clone(),
        })
        .valid()
    {
        return false;
    }
    match &record.last_command {
        MediaNodeCommand::RegisterMedia { registration, .. } => {
            record.registration.as_ref() == Some(registration)
        }
        MediaNodeCommand::RemoveMedia { .. } => record.registration.is_none() && !record.draining,
        MediaNodeCommand::SetMediaDraining {
            target, draining, ..
        } => {
            record.draining == *draining
                && record
                    .registration
                    .as_ref()
                    .is_some_and(|entry| &entry.target == target)
        }
    }
}

impl MaintenanceView {
    fn valid(&self, cluster: &str, id: &str) -> bool {
        if self.cluster_id != cluster
            || self.node_id != id
            || self.owned_rooms.len() > MAX_ROOMS
            || self
                .record
                .as_ref()
                .is_some_and(|record| !valid_record(id, record))
        {
            return false;
        }
        let mut names = BTreeSet::new();
        self.owned_rooms.iter().all(|entry| {
            let (tenant, room, _) = entry.record.last_command.coordinates();
            entry.tenant_id == tenant
                && entry.room_id == room
                && entry.record.last_command.valid()
                && revision(entry.record.revision)
                && matches!(&entry.record.last_command, crate::RoomCommand::Assign { target, .. }
                    if entry.record.owner.as_ref() == Some(target))
                && names.insert((&entry.tenant_id, &entry.room_id))
                && self
                    .record
                    .as_ref()
                    .and_then(|record| record.registration.as_ref())
                    .is_some_and(|registered| {
                        entry.record.owner.as_ref() == Some(&registered.target)
                            && registered.rooms.iter().any(|scope| {
                                scope.tenant_id == entry.tenant_id && scope.room_id == entry.room_id
                            })
                    })
        })
    }
}

impl MediaAdmin {
    pub fn new(config: MediaAdminConfig) -> io::Result<Self> {
        if !vs_core::valid_id(&config.cluster_id)
            || !(1..=64).contains(&config.endpoints.len())
            || config.endpoints.iter().collect::<BTreeSet<_>>().len() != config.endpoints.len()
            || config
                .endpoints
                .iter()
                .any(|endpoint| !allowed_endpoint(*endpoint, config.tls.is_some()))
            || !(32..=256).contains(&config.service_token.len())
            || !config
                .service_token
                .bytes()
                .all(|value| value.is_ascii_graphic())
        {
            return Err(invalid("媒体维护配置的集群、端点或凭据无效"));
        }
        crate::ensure_http_crypto_provider();
        let (builder, endpoints) = if let Some(tls) = &config.tls {
            let builder = tls.client_builder(&config.endpoints)?;
            let endpoints = config
                .endpoints
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
                config
                    .endpoints
                    .iter()
                    .map(|address| format!("http://{address}"))
                    .collect(),
            )
        };
        let client = builder
            .connect_timeout(Duration::from_millis(250))
            .timeout(Duration::from_millis(1500))
            .build()
            .map_err(|_| invalid("媒体维护客户端创建失败"))?;
        Ok(Self {
            config,
            client,
            endpoints,
        })
    }

    async fn body<T: serde::de::DeserializeOwned>(
        &self,
        mut response: reqwest::Response,
    ) -> io::Result<T> {
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(invalid("媒体维护响应超过预算"));
        }
        let mut bytes = Vec::new();
        while let Some(part) = response
            .chunk()
            .await
            .map_err(|_| invalid("媒体维护正文读取失败"))?
        {
            if part.len() > MAX_RESPONSE_BYTES - bytes.len() {
                return Err(invalid("媒体维护响应超过预算"));
            }
            bytes.extend_from_slice(&part);
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid("媒体维护响应格式无效"))
    }

    async fn locate(&self, id: &str) -> io::Result<(String, MaintenanceView)> {
        if !vs_core::valid_id(id) || matches!(id, "." | "..") {
            return Err(invalid("媒体节点标识无效"));
        }
        for endpoint in &self.endpoints {
            let response = match self
                .client
                .get(format!("{endpoint}/v1/media-nodes/{id}/maintenance"))
                .bearer_auth(&self.config.service_token)
                .send()
                .await
            {
                Ok(response) => response,
                Err(_) => continue,
            };
            if matches!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
            ) {
                continue;
            }
            if response.status() != StatusCode::OK {
                return Err(invalid("媒体维护权威读取被拒绝"));
            }
            let view: MaintenanceView = self.body(response).await?;
            if !view.valid(&self.config.cluster_id, id) {
                return Err(invalid("媒体维护返回的集群、节点或房间状态不匹配"));
            }
            return Ok((endpoint.clone(), view));
        }
        Err(invalid("配置端点中没有可确认的权威维护视图"))
    }

    pub async fn preview(&self, id: &str) -> io::Result<MaintenanceView> {
        self.locate(id).await.map(|(_, view)| view)
    }

    fn validate_command(command: &MediaNodeCommand) -> io::Result<u64> {
        if !command.valid() {
            return Err(invalid("媒体维护命令无效"));
        }
        match command {
            MediaNodeCommand::SetMediaDraining {
                expected_revision, ..
            }
            | MediaNodeCommand::RemoveMedia {
                expected_revision, ..
            } => Ok(*expected_revision),
            _ => Err(invalid("维护客户端仅支持显式排空、恢复和移除命令")),
        }
    }

    fn proves(record: Option<&MediaNodeRecord>, command: &MediaNodeCommand) -> bool {
        record.is_some_and(|record| {
            valid_record(&command.target().node_id, record)
                && record.last_command == *command
                && match command {
                    MediaNodeCommand::SetMediaDraining {
                        expected_revision, ..
                    }
                    | MediaNodeCommand::RemoveMedia {
                        expected_revision, ..
                    } => record.revision > *expected_revision,
                    _ => false,
                }
        })
    }

    fn receipt(command: MediaNodeCommand) -> MaintenanceReceipt {
        MaintenanceReceipt {
            schema: "media-maintenance-receipt-v1",
            outcome: MaintenanceOutcome::Unknown,
            evidence: "尚未确认提交结果",
            writes_sent: 0,
            http_status: None,
            command,
            observed: None,
            observation_stage: None,
            confirmed_record: None,
            service_record: None,
            service_outcome: None,
        }
    }

    /// 只读当前保留命令；后续命令覆盖后，不能推断旧命令未执行。
    pub async fn confirm(&self, command: MediaNodeCommand) -> io::Result<MaintenanceReceipt> {
        Self::validate_command(&command)?;
        let mut receipt = Self::receipt(command);
        if let Ok(view) = self.preview(&receipt.command.target().node_id).await {
            if Self::proves(view.record.as_ref(), &receipt.command) {
                receipt.outcome = MaintenanceOutcome::Confirmed;
                receipt.evidence = "线性一致读取保留了完整相同命令";
                receipt.confirmed_record = view.record.clone();
            } else {
                receipt.evidence = "当前记录不能证明该完整命令提交；历史结局未知";
            }
            receipt.observed = Some(view);
            receipt.observation_stage = Some(ObservationStage::Readback);
        }
        Ok(receipt)
    }

    /// 最多发送一次POST；预览不锁定未来，最终并发判定仍由Raft版本检查执行。
    pub async fn apply(&self, command: MediaNodeCommand) -> io::Result<MaintenanceReceipt> {
        let expected = Self::validate_command(&command)?;
        let (endpoint, view) = self.locate(&command.target().node_id).await?;
        let mut receipt = Self::receipt(command);
        let record = view.record.as_ref();
        if Self::proves(record, &receipt.command) {
            receipt.outcome = MaintenanceOutcome::Confirmed;
            receipt.evidence = "提交前已确认同一完整命令，不重复发送";
            receipt.confirmed_record = view.record.clone();
        } else if !record.is_some_and(|record| {
            record.revision == expected
                && record
                    .registration
                    .as_ref()
                    .is_some_and(|entry| entry.target == *receipt.command.target())
        }) {
            receipt.outcome = MaintenanceOutcome::Conflict;
            receipt.evidence = "预览版本或启动身份不匹配，未发送";
        } else if matches!(&receipt.command, MediaNodeCommand::RemoveMedia { .. })
            && !view.owned_rooms.is_empty()
        {
            receipt.outcome = MaintenanceOutcome::InUse;
            receipt.evidence = "预览仍有归属房间，未发送";
        } else {
            receipt.observed = Some(view);
            receipt.observation_stage = Some(ObservationStage::Preview);
            receipt.writes_sent = 1;
            let sent = self
                .client
                .post(format!("{endpoint}/v1/media-nodes/commands"))
                .bearer_auth(&self.config.service_token)
                .json(&receipt.command)
                .send()
                .await;
            if let Ok(response) = sent {
                let status = response.status();
                receipt.http_status = Some(status.as_u16());
                if let Ok(reply) = self.body::<MediaNodeReply>(response).await {
                    if status == StatusCode::OK
                        && matches!(reply.outcome.as_str(), "applied" | "duplicate")
                        && Self::proves(reply.record.as_ref(), &receipt.command)
                    {
                        receipt.outcome = MaintenanceOutcome::Confirmed;
                        receipt.evidence = "单次写入返回完整已提交命令";
                        receipt.confirmed_record = reply.record;
                        // 预览是写前快照，不混作写后视图。
                        return Ok(receipt);
                    }
                    if matches!(
                        status,
                        StatusCode::CONFLICT | StatusCode::INSUFFICIENT_STORAGE
                    ) && matches!(reply.outcome.as_str(), "conflict" | "in_use" | "capacity")
                        && reply.record.as_ref().is_none_or(|record| {
                            valid_record(&receipt.command.target().node_id, record)
                        })
                    {
                        receipt.outcome = match reply.outcome.as_str() {
                            "in_use" => MaintenanceOutcome::InUse,
                            "conflict" => MaintenanceOutcome::Conflict,
                            _ => MaintenanceOutcome::Rejected,
                        };
                        receipt.evidence = "单次提案返回明确状态机拒绝；未自动重试";
                        receipt.service_outcome = Some(reply.outcome);
                        receipt.service_record = reply.record;
                        receipt.observation_stage = Some(ObservationStage::Preview);
                        return Ok(receipt);
                    }
                }
            }
            // 响应丢失不代表未提交；仅有界读回，不向新领导者重发写入。
            if let Ok(after) = self.preview(&receipt.command.target().node_id).await {
                if Self::proves(after.record.as_ref(), &receipt.command) {
                    receipt.outcome = MaintenanceOutcome::Confirmed;
                    receipt.evidence = "写入响应未确认，权威读回完整相同命令";
                    receipt.confirmed_record = after.record.clone();
                } else {
                    receipt.evidence = "权威读回的当前命令不同；原提案历史结局未知";
                }
                receipt.observed = Some(after);
                receipt.observation_stage = Some(ObservationStage::Readback);
            }
            return Ok(receipt);
        }
        receipt.observed = Some(view);
        receipt.observation_stage = Some(ObservationStage::Preview);
        Ok(receipt)
    }
}
