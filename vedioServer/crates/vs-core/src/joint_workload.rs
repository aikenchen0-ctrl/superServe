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
    pub metric_rows: usize,
    pub artifacts: usize,
}

impl JointWorkload {
    pub fn validate(&self) -> Result<JointWorkloadSummary, DomainError> {
        if self.schema != "joint-workload-v1"
            || !valid_id(&self.trace_id)
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
            metric_rows,
            artifacts: self.artifacts.len(),
        })
    }
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
            trace_id: "trace-1".into(),
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
}
