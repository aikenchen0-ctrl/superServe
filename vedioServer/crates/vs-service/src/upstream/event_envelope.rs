// SPDX-License-Identifier: Apache-2.0
// Copyright 2023 Serverless Technology Consulting, LLC
// 改编自 serverlesstechnology/cqrs 的 src/event.rs，提交37c1ab09b5de20ae47aaf0b72a0775b92a45a0cd。
// 移除Aggregate依赖，以类型化载荷和元数据替代关联事件与任意字符串表，增加严格序列化。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EventEnvelope<P, M> {
    pub aggregate_id: String,
    pub sequence: u64,
    pub payload: P,
    pub metadata: M,
}
