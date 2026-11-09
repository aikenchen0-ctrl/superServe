use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use vs_core::{
    event_order::InteractionOrder,
    learning::{TrainingDataKind, is_sha256},
    valid_id,
};

use crate::learning_evidence::{GatewayEventKind, GatewayLearningArchive, GatewayLearningEvent};

pub const MAX_CONSUMPTION_EVENTS: usize = 64;
const MAX_ELAPSED_MS: u64 = 86_400_000;
const MAX_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientPlatform {
    Android,
    Ios,
    Web,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresentationSignal {
    AndroidRenderedFirstFrame,
    IosReadyForDisplay,
    WebVideoFrameCallback,
    AndroidViewDrawn,
    IosViewAppeared,
    WebElementVisible,
}

impl PresentationSignal {
    fn platform(self) -> ClientPlatform {
        match self {
            Self::AndroidRenderedFirstFrame | Self::AndroidViewDrawn => ClientPlatform::Android,
            Self::IosReadyForDisplay | Self::IosViewAppeared => ClientPlatform::Ios,
            Self::WebVideoFrameCallback | Self::WebElementVisible => ClientPlatform::Web,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByteScope {
    AndroidDataSource,
    IosAccessLog,
    WebXhrBody,
}

impl ByteScope {
    fn platform(self) -> ClientPlatform {
        match self {
            Self::AndroidDataSource => ClientPlatform::Android,
            Self::IosAccessLog => ClientPlatform::Ios,
            Self::WebXhrBody => ClientPlatform::Web,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplicitPreference {
    Like,
    Dislike,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConsumptionObservation {
    FirstPresentable {
        signal: PresentationSignal,
    },
    Visibility {
        signal: Option<PresentationSignal>,
        foreground: bool,
        visible_fraction_milli: u16,
    },
    Progress {
        position_ms: Option<u64>,
        active_ms: Option<u64>,
        rebuffer_ms: Option<u64>,
        transferred_bytes: Option<u64>,
        byte_scope: Option<ByteScope>,
    },
    Preference {
        value: ExplicitPreference,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumptionEvent {
    pub event_id: String,
    pub sequence: u64,
    pub elapsed_ms: u64,
    pub observed_at: u64,
    pub observation: ConsumptionObservation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumptionBatch {
    pub schema: String,
    pub source_id: String,
    pub data_kind: TrainingDataKind,
    pub platform: ClientPlatform,
    pub subject: String,
    pub decision_id: String,
    pub candidate_id: String,
    // 媒体播放和文章/服务交互共用实例身份；切换候选或重置计数时创建新代次。
    pub interaction_id: String,
    pub generation: u64,
    pub events: Vec<ConsumptionEvent>,
}

#[derive(Debug, Default, Serialize)]
pub struct ConsumptionSummary {
    pub unique_events: usize,
    pub duplicate_events: usize,
    pub first_presentable_elapsed_ms: Option<u64>,
    pub last_position_ms: Option<u64>,
    pub last_known_active_ms: Option<u64>,
    pub last_known_rebuffer_ms: Option<u64>,
    pub last_known_transferred_bytes: Option<u64>,
    pub byte_scope: Option<ByteScope>,
    pub visibility_declarations: usize,
    pub explicit_preferences: usize,
}

pub struct NormalizedConsumption {
    pub summary: ConsumptionSummary,
    pub learning: GatewayLearningArchive,
}

fn monotonic_counter(
    value: Option<u64>,
    last: &mut Option<u64>,
    maximum: u64,
) -> Result<(), &'static str> {
    if let Some(value) = value {
        if value > maximum || last.is_some_and(|previous| value < previous) {
            return Err("消费累计计数倒退或超过预算，重置需使用新代次");
        }
        *last = Some(value);
    }
    Ok(())
}

/// 校验单批消费声明，不把平台回调提升为真实用户观看证明。
pub fn normalize_consumption(
    batch: &ConsumptionBatch,
    received_at: u64,
) -> Result<NormalizedConsumption, &'static str> {
    normalize_consumption_with_limit(batch, received_at, MAX_CONSUMPTION_EVENTS)
}

/// 离线重建复用同一验证规则；在线入口仍固定最多64项。
pub(crate) fn normalize_consumption_with_limit(
    batch: &ConsumptionBatch,
    received_at: u64,
    maximum: usize,
) -> Result<NormalizedConsumption, &'static str> {
    if batch.schema != "client-consumption-v1"
        || !valid_id(&batch.source_id)
        || !valid_id(&batch.subject)
        || !is_sha256(&batch.decision_id)
        || !valid_id(&batch.candidate_id)
        || !valid_id(&batch.interaction_id)
        || !(1..=MAX_JSON_INTEGER).contains(&batch.generation)
        || batch.events.is_empty()
        || batch.events.len() > maximum
    {
        return Err("消费批次身份、版本或容量无效");
    }
    let mut summary = ConsumptionSummary::default();
    let mut learning = GatewayLearningArchive {
        schema: "gateway-learning-events-v2".into(),
        source_id: batch.source_id.clone(),
        data_kind: batch.data_kind,
        events: Vec::new(),
    };
    let mut seen: HashMap<&str, &ConsumptionEvent> = HashMap::new();
    let mut previous: Option<(u64, u64, u64)> = None;
    for event in &batch.events {
        if !valid_id(&event.event_id)
            || !(1..=MAX_JSON_INTEGER).contains(&event.sequence)
            || event.elapsed_ms > MAX_ELAPSED_MS
            || event.observed_at == 0
            || event.observed_at > received_at
        {
            return Err("消费事件标识、时间或序号无效");
        }
        if let Some(original) = seen.insert(&event.event_id, event) {
            if original != event {
                return Err("同一消费事件ID包含不同内容");
            }
            summary.duplicate_events += 1;
            continue;
        }
        if previous.is_some_and(|(sequence, elapsed, at)| {
            event.sequence <= sequence || event.elapsed_ms < elapsed || event.observed_at < at
        }) {
            return Err("同批消费序号或时间倒退");
        }
        previous = Some((event.sequence, event.elapsed_ms, event.observed_at));
        summary.unique_events += 1;
        let mut derived = None;
        match event.observation {
            ConsumptionObservation::FirstPresentable { signal } => {
                if signal.platform() != batch.platform {
                    return Err("首帧或呈现信号与客户端平台不匹配");
                }
                summary
                    .first_presentable_elapsed_ms
                    .get_or_insert(event.elapsed_ms);
            }
            ConsumptionObservation::Visibility {
                signal,
                foreground,
                visible_fraction_milli,
            } => {
                if visible_fraction_milli > 1000
                    || signal.is_some_and(|value| value.platform() != batch.platform)
                {
                    return Err("可见比例或呈现信号无效");
                }
                // 首帧、下载、仅容器可见都不单独产生可见内容声明。
                if foreground && visible_fraction_milli > 0 && signal.is_some() {
                    derived = Some(GatewayEventKind::Visible);
                    summary.visibility_declarations += 1;
                }
            }
            ConsumptionObservation::Progress {
                position_ms,
                active_ms,
                rebuffer_ms,
                transferred_bytes,
                byte_scope,
            } => {
                if position_ms.is_some_and(|value| value > MAX_ELAPSED_MS)
                    || byte_scope.is_some_and(|value| value.platform() != batch.platform)
                    || (transferred_bytes.is_some() && byte_scope.is_none())
                    || active_ms.is_some_and(|value| value > event.elapsed_ms)
                    || rebuffer_ms.is_some_and(|value| value > event.elapsed_ms)
                    || active_ms
                        .zip(rebuffer_ms)
                        .is_some_and(|(active, waiting)| active + waiting > event.elapsed_ms)
                {
                    return Err("消费进度、计量来源或累计时长无效");
                }
                monotonic_counter(active_ms, &mut summary.last_known_active_ms, MAX_ELAPSED_MS)?;
                monotonic_counter(
                    rebuffer_ms,
                    &mut summary.last_known_rebuffer_ms,
                    MAX_ELAPSED_MS,
                )?;
                monotonic_counter(
                    transferred_bytes,
                    &mut summary.last_known_transferred_bytes,
                    1 << 40,
                )?;
                if summary
                    .last_known_active_ms
                    .zip(summary.last_known_rebuffer_ms)
                    .is_some_and(|(active, waiting)| active + waiting > event.elapsed_ms)
                {
                    return Err("累计播放和等待时长超过实例已流逝时间");
                }
                if position_ms.is_some() {
                    summary.last_position_ms = position_ms;
                }
                if byte_scope.is_some() {
                    summary.byte_scope = byte_scope;
                }
            }
            ConsumptionObservation::Preference { value } => {
                summary.explicit_preferences += 1;
                derived = Some(match value {
                    ExplicitPreference::Like => GatewayEventKind::Like,
                    ExplicitPreference::Dislike => GatewayEventKind::Dislike,
                });
            }
        }
        if let Some(kind) = derived {
            learning.events.push(GatewayLearningEvent {
                event_id: event.event_id.clone(),
                decision_id: batch.decision_id.clone(),
                subject: batch.subject.clone(),
                candidate_id: batch.candidate_id.clone(),
                at: event.observed_at,
                kind,
                order: Some(InteractionOrder {
                    interaction_id: batch.interaction_id.clone(),
                    generation: batch.generation,
                    sequence: event.sequence,
                    elapsed_ms: event.elapsed_ms,
                }),
            });
        }
    }
    Ok(NormalizedConsumption { summary, learning })
}
