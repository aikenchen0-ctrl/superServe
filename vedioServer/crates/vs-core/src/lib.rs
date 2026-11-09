pub mod catalog;
pub mod event_order;
pub mod grouped_recall;
pub mod joint_workload;
pub mod learning;
pub mod model_pruned;
pub mod model_recall;
pub mod model_top_k;
pub mod playback;
pub mod playback_adapter;
pub mod profile;
pub mod recall;
pub mod recommendation;
pub mod replay;
pub mod room_assignment;
pub mod slate;
pub mod training_split;
mod upstream;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("invalid_input:{0}")]
    Invalid(&'static str),
    #[error("projection_expired")]
    Expired,
    #[error("projection_scope_denied")]
    ScopeDenied,
    #[error("profile_capacity_reached")]
    Capacity,
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
