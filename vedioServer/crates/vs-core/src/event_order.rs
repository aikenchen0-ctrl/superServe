use serde::{Deserialize, Serialize};

use crate::valid_id;

const MAX_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ELAPSED_MS: u64 = 86_400_000;

/// 复用聚合实例与序号的顺序模型；单调时间只在同一实例代次内可比较。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionOrder {
    pub interaction_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub elapsed_ms: u64,
}

impl InteractionOrder {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.interaction_id)
            && (1..=MAX_JSON_INTEGER).contains(&self.generation)
            && (1..=MAX_JSON_INTEGER).contains(&self.sequence)
            && self.elapsed_ms <= MAX_ELAPSED_MS
    }

    pub fn same_stream(&self, other: &Self) -> bool {
        self.interaction_id == other.interaction_id && self.generation == other.generation
    }

    pub fn precedes(&self, other: &Self) -> bool {
        self.is_valid()
            && other.is_valid()
            && self.same_stream(other)
            && self.sequence < other.sequence
            && self.elapsed_ms <= other.elapsed_ms
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SampleChronology {
    pub source_id: String,
    pub exposure: InteractionOrder,
    pub feedback: InteractionOrder,
}

impl SampleChronology {
    pub fn proves_order(&self) -> bool {
        valid_id(&self.source_id) && self.exposure.precedes(&self.feedback)
    }
}
