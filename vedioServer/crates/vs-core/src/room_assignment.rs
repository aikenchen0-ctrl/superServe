use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MediaTarget {
    pub node_id: String,
    pub incarnation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AssignmentRecord {
    pub revision: u64,
    pub owner: Option<MediaTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignmentView {
    pub cluster_id: String,
    pub tenant_id: String,
    pub room_id: String,
    pub record: Option<AssignmentRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MediaFence {
    pub cluster_id: String,
    pub tenant_id: String,
    pub room_id: String,
    pub target: MediaTarget,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaPhase {
    Active,
    Drained,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaControlReceipt {
    pub fence: MediaFence,
    pub phase: MediaPhase,
    pub active_peers: usize,
}
