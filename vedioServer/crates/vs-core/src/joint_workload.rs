use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{DomainError, learning::is_sha256, replay::DataKind, valid_id};

pub const MAX_JOINT_REQUESTS: usize = 100_000;
pub const MAX_JOINT_ARTIFACTS: usize = 256;
const MAX_TRACE_AGE_SECONDS: u64 = 365 * 24 * 60 * 60;
const MAX_BYTES: u64 = 1 << 50;
const MAX_MILLISECONDS: u64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkloadSplit {
    Training,
    Validation,
    Holdout,
    ProductionObservation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkloadPlatform {
    Android,
    Ios,
    Web,
    Other,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JointWorkload {
    pub schema: String,
    pub data_kind: DataKind,
    pub split: WorkloadSplit,
    pub trace_id: String,
    pub source_id: String,
    pub catalog_sha256: String,
    pub started_at: u64,
    pub requests: Vec<JointRequest>,
    pub artifacts: Vec<WorkloadArtifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JointRequest {
    pub request_id: String,
    pub observed_at: u64,
    pub platform: WorkloadPlatform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_context: Option<TraceContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback_id_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_id_sha256: Option<String>,
    #[serde(default)]
    pub metrics: JointMetrics,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub trace_flags: u8,
}

impl TraceContext {
    pub fn from_traceparent(value: &str) -> Result<Self, DomainError> {
        let parts: Vec<_> = value.split('-').collect();
        if parts.len() != 4
            || parts[0] != "00"
            || parts[1].len() != 32
            || parts[2].len() != 16
            || parts[3].len() != 2
            || !is_lower_hex(parts[1])
            || !is_lower_hex(parts[2])
            || !is_lower_hex(parts[3])
            || parts[1].bytes().all(|byte| byte == b'0')
            || parts[2].bytes().all(|byte| byte == b'0')
        {
            return Err(DomainError::Invalid("joint_workload_traceparent"));
        }
        Ok(Self {
            trace_id: parts[1].into(),
            span_id: parts[2].into(),
            trace_flags: u8::from_str_radix(parts[3], 16).unwrap(),
        })
    }

    pub fn to_traceparent(&self) -> Option<String> {
        self.validate().then(|| {
            format!(
                "00-{}-{}-{:02x}",
                self.trace_id, self.span_id, self.trace_flags
            )
        })
    }

    fn validate(&self) -> bool {
        self.trace_id.len() == 32
            && self.span_id.len() == 16
            && is_lower_hex(&self.trace_id)
            && is_lower_hex(&self.span_id)
            && !self.trace_id.bytes().all(|byte| byte == b'0')
            && !self.span_id.bytes().all(|byte| byte == b'0')
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JointMetrics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_frame_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebuffer_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rss_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkloadArtifact {
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct JointWorkloadSummary {
    pub requests: usize,
    pub recommendation_links: usize,
    pub playback_links: usize,
    pub consumption_links: usize,
    pub trace_contexts: usize,
    pub metric_rows: usize,
    pub artifacts: usize,
}

impl JointWorkload {
    pub fn validate(&self) -> Result<JointWorkloadSummary, DomainError> {
        if self.schema != "joint-workload-v1"
            || !is_trace_id(&self.trace_id)
            || !valid_id(&self.source_id)
            || !is_sha256(&self.catalog_sha256)
            || self.started_at == 0
            || self.requests.is_empty()
            || self.requests.len() > MAX_JOINT_REQUESTS
            || self.artifacts.len() > MAX_JOINT_ARTIFACTS
            || (self.split == WorkloadSplit::ProductionObservation
                && !matches!(self.data_kind, DataKind::Observed))
        {
            return Err(DomainError::Invalid("joint_workload_metadata"));
        }

        let mut request_ids = HashSet::with_capacity(self.requests.len());
        let mut previous_observed_at = None;
        let mut recommendation_links = 0;
        let mut playback_links = 0;
        let mut consumption_links = 0;
        let mut trace_contexts = 0;
        let mut metric_rows = 0;
        for request in &self.requests {
            if !valid_id(&request.request_id)
                || !request_ids.insert(&request.request_id)
                || request.observed_at < self.started_at
                || previous_observed_at.is_some_and(|at| request.observed_at < at)
            {
                return Err(DomainError::Invalid("joint_workload_request_order"));
            }
            previous_observed_at = Some(request.observed_at);

            if request.observed_at - self.started_at > MAX_TRACE_AGE_SECONDS
                || request
                    .decision_id
                    .as_ref()
                    .is_some_and(|value| !is_sha256(value))
                || request
                    .candidate_id
                    .as_ref()
                    .is_some_and(|value| !valid_id(value))
                || request
                    .playback_id_sha256
                    .as_ref()
                    .is_some_and(|value| !is_sha256(value))
                || request
                    .interaction_id_sha256
                    .as_ref()
                    .is_some_and(|value| !is_sha256(value))
            {
                return Err(DomainError::Invalid("joint_workload_request_identity"));
            }
            if request.decision_id.is_some() {
                if request.candidate_id.is_none() {
                    return Err(DomainError::Invalid("joint_workload_decision_candidate"));
                }
                recommendation_links += 1;
            }
            if request
                .trace_context
                .as_ref()
                .is_some_and(|context| !context.validate())
            {
                return Err(DomainError::Invalid("joint_workload_trace_context"));
            }
            if request
                .trace_context
                .as_ref()
                .is_some_and(|context| context.trace_id != self.trace_id)
            {
                return Err(DomainError::Invalid("joint_workload_trace_mismatch"));
            }
            if request.trace_context.is_some() {
                trace_contexts += 1;
            }
            if request.playback_id_sha256.is_some() {
                if request.candidate_id.is_none() {
                    return Err(DomainError::Invalid("joint_workload_playback_candidate"));
                }
                playback_links += 1;
            }
            if let Some(interaction_id) = &request.interaction_id_sha256 {
                if request.playback_id_sha256.as_ref() != Some(interaction_id) {
                    return Err(DomainError::Invalid("joint_workload_interaction_mismatch"));
                }
                consumption_links += 1;
            }
            validate_metrics(&request.metrics)?;
            if has_metrics(&request.metrics) {
                metric_rows += 1;
            }
        }

        let mut artifact_names = HashSet::with_capacity(self.artifacts.len());
        for artifact in &self.artifacts {
            if !valid_id(&artifact.name)
                || !artifact_names.insert(&artifact.name)
                || !is_sha256(&artifact.sha256)
                || artifact.bytes > MAX_BYTES
            {
                return Err(DomainError::Invalid("joint_workload_artifact"));
            }
        }

        Ok(JointWorkloadSummary {
            requests: self.requests.len(),
            recommendation_links,
            playback_links,
            consumption_links,
            trace_contexts,
            metric_rows,
            artifacts: self.artifacts.len(),
        })
    }

    /// 在不把未知指标填成零的前提下，验证一条可用于联合归因的闭合轨迹。
    ///
    /// 普通 `validate` 允许部分观测，这是输入层必须保留的语义；本方法是更高一层的
    /// 明确验收门，只接受生产观察数据，并要求至少一条请求同时串起推荐、播放和消费。
    /// 它不证明观看事实、线路字节或性能收益，也不会改变普通校验和服务默认路径。
    pub fn validate_closed_path(&self) -> Result<JointWorkloadSummary, DomainError> {
        let summary = self.validate()?;
        if !matches!(self.data_kind, DataKind::Observed)
            || self.split != WorkloadSplit::ProductionObservation
            || !self.requests.iter().any(|request| {
                request.trace_context.is_some()
                    && request.decision_id.is_some()
                    && request.playback_id_sha256.is_some()
                    && request.interaction_id_sha256.is_some()
            })
        {
            return Err(DomainError::Invalid("joint_workload_closed_path"));
        }
        Ok(summary)
    }
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_trace_id(value: &str) -> bool {
    value.len() == 32 && is_lower_hex(value) && !value.bytes().all(|byte| byte == b'0')
}

fn validate_metrics(metrics: &JointMetrics) -> Result<(), DomainError> {
    if metrics.client_bytes.is_some_and(|value| value > MAX_BYTES)
        || metrics.source_bytes.is_some_and(|value| value > MAX_BYTES)
        || metrics.server_bytes.is_some_and(|value| value > MAX_BYTES)
        || metrics.rss_bytes.is_some_and(|value| value > MAX_BYTES)
        || metrics
            .first_frame_ms
            .is_some_and(|value| value > MAX_MILLISECONDS)
        || metrics
            .rebuffer_ms
            .is_some_and(|value| value > MAX_MILLISECONDS)
        || metrics.cpu_ms.is_some_and(|value| value > MAX_MILLISECONDS)
    {
        return Err(DomainError::Invalid("joint_workload_metric_budget"));
    }
    Ok(())
}

fn has_metrics(metrics: &JointMetrics) -> bool {
    metrics.client_bytes.is_some()
        || metrics.source_bytes.is_some()
        || metrics.server_bytes.is_some()
        || metrics.first_frame_ms.is_some()
        || metrics.rebuffer_ms.is_some()
        || metrics.cpu_ms.is_some()
        || metrics.rss_bytes.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn hash(byte: u8) -> String {
        format!("{:x}", Sha256::digest([byte; 32]))
    }

    fn request() -> JointRequest {
        JointRequest {
            request_id: "request-1".into(),
            observed_at: 101,
            platform: WorkloadPlatform::Web,
            trace_context: Some(
                TraceContext::from_traceparent(
                    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                )
                .unwrap(),
            ),
            decision_id: Some(hash(b'd')),
            candidate_id: Some("clip".into()),
            playback_id_sha256: Some(hash(b'p')),
            interaction_id_sha256: Some(hash(b'p')),
            metrics: JointMetrics {
                client_bytes: Some(100),
                source_bytes: Some(120),
                server_bytes: Some(120),
                first_frame_ms: Some(800),
                ..Default::default()
            },
        }
    }

    fn workload() -> JointWorkload {
        JointWorkload {
            schema: "joint-workload-v1".into(),
            data_kind: DataKind::Observed,
            split: WorkloadSplit::Holdout,
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
            source_id: "source-1".into(),
            catalog_sha256: hash(b'c'),
            started_at: 100,
            requests: vec![request()],
            artifacts: vec![WorkloadArtifact {
                name: "catalog".into(),
                sha256: hash(b'a'),
                bytes: 10,
            }],
        }
    }

    #[test]
    fn validates_one_closed_joint_request_without_fabricating_unknown_metrics() {
        let summary = workload().validate().unwrap();
        assert_eq!(
            summary,
            JointWorkloadSummary {
                requests: 1,
                recommendation_links: 1,
                playback_links: 1,
                consumption_links: 1,
                trace_contexts: 1,
                metric_rows: 1,
                artifacts: 1,
            }
        );
    }

    #[test]
    fn rejects_cross_split_or_cross_instance_leakage() {
        let mut value = workload();
        value.split = WorkloadSplit::ProductionObservation;
        value.data_kind = DataKind::Synthetic;
        assert!(value.validate().is_err());
        let mut value = workload();
        value.requests[0].interaction_id_sha256 = Some(hash(b'x'));
        assert!(value.validate().is_err());
        let mut value = workload();
        value.requests.push(request());
        assert!(value.validate().is_err());
    }

    #[test]
    fn rejects_out_of_order_and_unbounded_observations() {
        let mut value = workload();
        value.requests.push(JointRequest {
            request_id: "request-2".into(),
            observed_at: 99,
            platform: WorkloadPlatform::Android,
            trace_context: None,
            decision_id: None,
            candidate_id: None,
            playback_id_sha256: None,
            interaction_id_sha256: None,
            metrics: JointMetrics::default(),
        });
        assert!(value.validate().is_err());
        let mut value = workload();
        value.requests[0].metrics.client_bytes = Some(MAX_BYTES + 1);
        assert!(value.validate().is_err());
    }

    #[test]
    fn rejects_trace_context_from_another_root_trace() {
        let mut value = workload();
        value.requests[0].trace_context = Some(
            TraceContext::from_traceparent(
                "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-00f067aa0ba902b7-01",
            )
            .unwrap(),
        );
        assert!(value.validate().is_err());
    }

    #[test]
    fn traceparent_rejects_zero_or_noncanonical_context() {
        let trace = TraceContext::from_traceparent(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )
        .unwrap();
        assert_eq!(
            trace.to_traceparent().as_deref(),
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        );
        assert!(
            TraceContext {
                trace_id: "invalid".into(),
                span_id: "invalid".into(),
                trace_flags: 1,
            }
            .to_traceparent()
            .is_none()
        );
        assert!(
            TraceContext::from_traceparent(
                "00-00000000000000000000000000000000-00f067aa0ba902b7-01"
            )
            .is_err()
        );
        assert!(
            TraceContext::from_traceparent(
                "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"
            )
            .is_err()
        );
    }

    #[test]
    fn closed_path_requires_observed_production_chain_without_fabricating_metrics() {
        let mut value = workload();
        value.split = WorkloadSplit::ProductionObservation;
        value.requests[0].metrics = JointMetrics::default();
        let summary = value.validate_closed_path().unwrap();
        assert_eq!(summary.requests, 1);
        assert_eq!(summary.metric_rows, 0);

        let mut partial = value.clone();
        partial.requests[0].interaction_id_sha256 = None;
        assert!(partial.validate_closed_path().is_err());

        let mut synthetic = value;
        synthetic.data_kind = DataKind::Synthetic;
        assert!(synthetic.validate_closed_path().is_err());
    }
}
