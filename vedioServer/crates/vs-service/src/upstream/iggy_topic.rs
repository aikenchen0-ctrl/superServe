// SPDX-License-Identifier: Apache-2.0
// 改编Apache Iggy固定提交71f29618ba04917fded0ef5cd085c206fef0ee49的
// core/common/src/types/topic/mod.rs及options/mod.rs，只保留就绪校验字段。
use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct TopicDetails {
    pub(crate) id: u32,
    pub(crate) created_at: u64,
    pub(crate) partitions_count: u32,
    pub(crate) partitions: Vec<Partition>,
    pub(crate) options: BTreeMap<String, OptionValue>,
}

#[derive(Deserialize)]
pub(crate) struct Partition {
    pub(crate) id: u32,
    pub(crate) created_at: u64,
}

#[derive(Deserialize)]
pub(crate) struct OptionValue {
    pub(crate) value: String,
    pub(crate) explicit: bool,
}
