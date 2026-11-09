use std::{collections::HashMap, io};

use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    learning::{TrainingDataKind, is_sha256},
    valid_id,
};

use crate::{
    consumption::{ConsumptionBatch, NormalizedConsumption, normalize_consumption},
    learning_evidence::GatewayLearningArchive,
};

pub const MAX_FEEDBACK_EVIDENCE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_BATCH_BYTES: usize = 32 * 1024;
pub(crate) const MAX_SNAPSHOT_MESSAGES: u64 = 128;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackEvidenceMessage {
    pub offset: u64,
    pub message_id: String,
    pub payload_length: usize,
    pub payload_sha256: String,
    pub payload_base64: String,
}

/// 保留原始消费声明，不能作为公开指标或独立的来源真实性证明。
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeedbackEvidenceArchive {
    pub schema: String,
    pub source_id: String,
    pub data_kind: TrainingDataKind,
    pub stream_id: u32,
    pub topic_id: u32,
    pub partition_id: u32,
    pub start_offset: u64,
    pub end_offset_exclusive: u64,
    pub captured_at: u64,
    pub messages: Vec<FeedbackEvidenceMessage>,
}

pub(crate) fn validate_gateway(
    archive: &GatewayLearningArchive,
    source_id: &str,
    data_kind: TrainingDataKind,
    at: u64,
) -> Result<(), crate::ApiError> {
    if !matches!(
        archive.schema.as_str(),
        "gateway-learning-events-v1" | "gateway-learning-events-v2"
    ) || archive.source_id != source_id
        || archive.data_kind != data_kind
        || archive.events.is_empty()
        || archive.events.len() > 64
    {
        return Err(crate::ApiError(
            StatusCode::BAD_REQUEST,
            "反馈批次来源或容量无效",
        ));
    }
    let mut seen = HashMap::new();
    for event in &archive.events {
        if !valid_id(&event.event_id)
            || !is_sha256(&event.decision_id)
            || !valid_id(&event.subject)
            || !valid_id(&event.candidate_id)
            || event.at == 0
            || event.at > at
            || event.order.as_ref().is_some_and(|order| {
                archive.schema == "gateway-learning-events-v1" || !order.is_valid()
            })
        {
            return Err(crate::ApiError(
                StatusCode::BAD_REQUEST,
                "反馈事件标识或时间无效",
            ));
        }
        if seen
            .insert(&event.event_id, event)
            .is_some_and(|previous| previous != event)
        {
            return Err(crate::ApiError(
                StatusCode::CONFLICT,
                "同一事件标识包含不同内容",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_consumption(
    batch: &ConsumptionBatch,
    source_id: &str,
    data_kind: TrainingDataKind,
    at: u64,
) -> Result<NormalizedConsumption, &'static str> {
    if batch.source_id != source_id || batch.data_kind != data_kind {
        return Err("消费来源或数据类型不匹配");
    }
    normalize_consumption(batch, at)
}

pub(crate) struct ProjectedPayload {
    pub learning: GatewayLearningArchive,
    pub consumption_events: Option<usize>,
}

pub(crate) fn project_payload(
    payload: &[u8],
    source_id: &str,
    data_kind: TrainingDataKind,
    at: u64,
) -> io::Result<ProjectedPayload> {
    let invalid = io::Error::other;
    if payload.len() > MAX_BATCH_BYTES {
        return Err(invalid("反馈原始批次超过32KiB"));
    }
    let (learning, consumption_events) = match serde_json::from_slice::<ConsumptionBatch>(payload) {
        Ok(batch) => (
            validate_consumption(&batch, source_id, data_kind, at)
                .map_err(invalid)?
                .learning,
            Some(batch.events.len()),
        ),
        Err(_) => (
            serde_json::from_slice::<GatewayLearningArchive>(payload)
                .map_err(|_| invalid("反馈批次JSON无效"))?,
            None,
        ),
    };
    // 仅QoE批次允许空学习投影；旧协议空批次仍拒绝。
    if consumption_events.is_none() || !learning.events.is_empty() {
        validate_gateway(&learning, source_id, data_kind, at)
            .map_err(|reason| invalid(reason.1))?;
    }
    Ok(ProjectedPayload {
        learning,
        consumption_events,
    })
}

impl FeedbackEvidenceArchive {
    /// 所有批次都经原校验链，未知或仅QoE记录不被补成负例。
    pub fn learning_projection(&self) -> io::Result<GatewayLearningArchive> {
        let mut archive = GatewayLearningArchive {
            schema: "gateway-learning-events-v1".into(),
            source_id: self.source_id.clone(),
            data_kind: self.data_kind,
            events: Vec::new(),
        };
        self.visit_payloads(|_, projected| {
            if projected.learning.schema == "gateway-learning-events-v2"
                && !projected.learning.events.is_empty()
            {
                archive.schema = "gateway-learning-events-v2".into();
            }
            archive.events.extend(projected.learning.events);
            Ok(())
        })?;
        Ok(archive)
    }

    pub(crate) fn visit_payloads(
        &self,
        mut visitor: impl FnMut(&[u8], ProjectedPayload) -> io::Result<()>,
    ) -> io::Result<()> {
        if self.schema != "feedback-evidence-v1"
            || !valid_id(&self.source_id)
            || self.captured_at == 0
            || self.end_offset_exclusive <= self.start_offset
            || self.end_offset_exclusive - self.start_offset > MAX_SNAPSHOT_MESSAGES
            || self.messages.len() as u64 != self.end_offset_exclusive - self.start_offset
        {
            return Err(io::Error::other("反馈证据版本、来源或固定区间无效"));
        }
        for (index, message) in self.messages.iter().enumerate() {
            if message.offset != self.start_offset + index as u64
                || message.payload_length > MAX_BATCH_BYTES
                || message.payload_base64.len() > MAX_BATCH_BYTES.div_ceil(3) * 4
            {
                return Err(io::Error::other("反馈证据偏移不连续或载荷超限"));
            }
            let payload = STANDARD
                .decode(&message.payload_base64)
                .map_err(|_| io::Error::other("反馈证据载荷编码无效"))?;
            let digest = Sha256::digest(&payload);
            let id = u128::from_be_bytes(digest[..16].try_into().unwrap()).to_string();
            if payload.len() != message.payload_length
                || format!("{digest:x}") != message.payload_sha256
                || message.message_id != id
            {
                return Err(io::Error::other("反馈证据长度、消息标识或指纹不符"));
            }
            let projected =
                project_payload(&payload, &self.source_id, self.data_kind, self.captured_at)?;
            visitor(&payload, projected)?;
        }
        Ok(())
    }
}

pub(crate) fn read_learning_archive(bytes: &[u8]) -> io::Result<GatewayLearningArchive> {
    #[derive(Deserialize)]
    struct Schema {
        schema: String,
    }
    let schema: Schema =
        serde_json::from_slice(bytes).map_err(|_| io::Error::other("网关归档JSON无效"))?;
    if schema.schema == "feedback-evidence-v1" {
        if bytes.len() > MAX_FEEDBACK_EVIDENCE_BYTES {
            return Err(io::Error::other("原始反馈证据超过8MiB"));
        }
        let evidence: FeedbackEvidenceArchive =
            serde_json::from_slice(bytes).map_err(|_| io::Error::other("原始反馈证据JSON无效"))?;
        evidence.learning_projection()
    } else {
        serde_json::from_slice(bytes).map_err(|_| io::Error::other("网关学习事件JSON无效"))
    }
}
