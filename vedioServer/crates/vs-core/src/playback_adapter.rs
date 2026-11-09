use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::{
    DomainError,
    playback::{LoadControl, PlaybackActivity, PlaybackDecision, PlaybackFeedback, PlaybackPolicy},
    upstream::hlsjs_buffer,
};

const MAX_TIME_MS: u64 = 86_400_000;
const MAX_BUFFER_BYTES: u64 = 512 * 1024 * 1024;
static NEXT_ADAPTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BufferedRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// 每轨区间必须映射到相同播放时间线；不能直接把媒体DTS或下载顺序当作播放时间。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlayerSnapshot {
    pub generation: u64,
    pub sequence: u64,
    pub monotonic_ms: u64,
    pub position_ms: u64,
    pub tracks: Vec<Vec<BufferedRange>>,
    pub buffered_bytes: u64,
    pub activity: PlaybackActivity,
    pub playback_rate_milli: u32,
    pub rebuffering: bool,
    pub end_of_stream: bool,
}

impl PlayerSnapshot {
    fn feedback(
        &self,
        in_flight_bytes: u64,
        next_fragment_bytes: Option<u64>,
    ) -> Result<PlaybackFeedback, DomainError> {
        if self.sequence == 0
            || self.monotonic_ms > MAX_TIME_MS
            || self.position_ms > MAX_TIME_MS
            || self.buffered_bytes > MAX_BUFFER_BYTES
            || !(1..=8).contains(&self.tracks.len())
            || self.tracks.iter().any(|ranges| {
                ranges.len() > 128
                    || ranges
                        .iter()
                        .any(|range| range.start_ms >= range.end_ms || range.end_ms > MAX_TIME_MS)
            })
        {
            return Err(DomainError::Invalid("播放器快照或区间越界"));
        }
        let end = self
            .tracks
            .iter()
            .map(|ranges| hlsjs_buffer::continuous_end(self.position_ms, ranges))
            .min()
            .unwrap_or(self.position_ms);
        let feedback = PlaybackFeedback {
            activity: self.activity,
            buffered_media_ms: end - self.position_ms,
            buffered_bytes: self.buffered_bytes,
            in_flight_bytes,
            next_fragment_bytes,
            playback_rate_milli: self.playback_rate_milli,
            rebuffering: self.rebuffering,
            end_of_stream: self.end_of_stream,
        };
        feedback.validate()?;
        Ok(feedback)
    }
}

/// 不可自行创建的本地预留；携带代次和序号，旧下载完成不能释放新请求的预算。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LoadTicket {
    owner: u64,
    generation: u64,
    sequence: u64,
    bytes: u64,
}

impl LoadTicket {
    pub fn bytes(self) -> u64 {
        self.bytes
    }
    pub fn generation(self) -> u64 {
        self.generation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferOutcome {
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Completion {
    ReadyForAppend,
    Discarded,
    Stale,
    LengthMismatch,
}

#[derive(Debug, Serialize)]
pub struct AdapterUpdate {
    pub feedback: PlaybackFeedback,
    pub decision: PlaybackDecision,
    pub request: Option<LoadTicket>,
    pub cancel: Option<LoadTicket>,
}

#[derive(Debug, Serialize)]
pub struct GenerationChange {
    pub generation: u64,
    pub cancel: Option<LoadTicket>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Downloading,
    AwaitingAppend,
}

struct Pending {
    ticket: LoadTicket,
    phase: Phase,
    revoked: bool,
}

/// 本地客户端适配边界；每个播放对象最多一项预留，下载与播放器追加采用两阶段确认。
pub struct PlayerAdapter {
    owner: u64,
    control: LoadControl,
    generation: u64,
    next_request: u64,
    last_snapshot: Option<(u64, u64, u64)>,
    pending: Option<Pending>,
}

impl PlayerAdapter {
    pub fn new(policy: PlaybackPolicy) -> Result<Self, DomainError> {
        let control = LoadControl::new(policy)?;
        let owner = NEXT_ADAPTER
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| DomainError::Invalid("播放对象标识溢出"))?;
        Ok(Self {
            owner,
            control,
            generation: 1,
            next_request: 0,
            last_snapshot: None,
            pending: None,
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 内容切换或不连续跳转时提升代次；旧预留保留至传输/追加任务确认结束。
    pub fn change_generation(&mut self) -> Result<GenerationChange, DomainError> {
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(DomainError::Invalid("播放代次溢出"))?;
        self.control.reset();
        self.generation = generation;
        self.last_snapshot = None;
        let cancel = self.pending.as_mut().map(|pending| {
            pending.revoked = true;
            pending.ticket
        });
        Ok(GenerationChange { generation, cancel })
    }

    fn validate_snapshot(
        &self,
        snapshot: &PlayerSnapshot,
        in_flight_bytes: u64,
        next_fragment_bytes: Option<u64>,
    ) -> Result<PlaybackFeedback, DomainError> {
        if snapshot.generation != self.generation {
            return Err(DomainError::Invalid("播放器快照属于旧代次"));
        }
        let feedback = snapshot.feedback(in_flight_bytes, next_fragment_bytes)?;
        if self
            .last_snapshot
            .is_some_and(|(sequence, time, position)| {
                snapshot.sequence <= sequence
                    || snapshot.monotonic_ms < time
                    || snapshot.position_ms < position
            })
        {
            return Err(DomainError::Invalid("播放器快照重复、乱序或跳转未提升代次"));
        }
        Ok(feedback)
    }

    fn apply(
        &mut self,
        snapshot: &PlayerSnapshot,
        feedback: PlaybackFeedback,
    ) -> Result<AdapterUpdate, DomainError> {
        // 在修改滞回前检查预留序号，所有拒绝路径都不污染已接纳快照。
        let next = self
            .next_request
            .checked_add(1)
            .ok_or(DomainError::Invalid("播放请求序号溢出"))?;
        let decision = self.control.decide(&feedback)?;
        self.last_snapshot = Some((
            snapshot.sequence,
            snapshot.monotonic_ms,
            snapshot.position_ms,
        ));
        let mut cancel = None;
        if decision.cancel_in_flight {
            cancel = self.pending.as_mut().map(|pending| {
                pending.revoked = true;
                pending.ticket
            });
        }
        let request = if decision.load_next {
            let ticket = LoadTicket {
                owner: self.owner,
                generation: self.generation,
                sequence: next,
                bytes: feedback
                    .next_fragment_bytes
                    .expect("加载决策包含下一片长度"),
            };
            self.next_request = next;
            self.pending = Some(Pending {
                ticket,
                phase: Phase::Downloading,
                revoked: false,
            });
            Some(ticket)
        } else {
            None
        };
        Ok(AdapterUpdate {
            feedback,
            decision,
            request,
            cancel,
        })
    }

    /// 使用播放器快照准入下一请求；返回票据时立即占用预算，调用方随后执行网络操作。
    pub fn update(
        &mut self,
        snapshot: &PlayerSnapshot,
        next_fragment_bytes: Option<u64>,
    ) -> Result<AdapterUpdate, DomainError> {
        let reserved = self
            .pending
            .as_ref()
            .map_or(0, |pending| pending.ticket.bytes);
        let feedback = self.validate_snapshot(snapshot, reserved, next_fragment_bytes)?;
        self.apply(snapshot, feedback)
    }

    /// 完整收字节仅允许追加，不自动增加缓冲；调用方仍负责核对内容散列和解码器错误。
    pub fn transfer_finished(
        &mut self,
        ticket: LoadTicket,
        received_bytes: u64,
        outcome: TransferOutcome,
    ) -> Completion {
        let Some(pending) = self
            .pending
            .as_mut()
            .filter(|pending| pending.ticket == ticket)
        else {
            return Completion::Stale;
        };
        if pending.phase == Phase::AwaitingAppend {
            return Completion::Stale;
        }
        if pending.revoked
            || ticket.generation != self.generation
            || outcome != TransferOutcome::Complete
        {
            self.pending = None;
            return Completion::Discarded;
        }
        if received_bytes != ticket.bytes {
            self.pending = None;
            return Completion::LengthMismatch;
        }
        pending.phase = Phase::AwaitingAppend;
        Completion::ReadyForAppend
    }

    /// 追加完成后用新播放器快照原子替换预留；失败快照不释放等待追加的预算。
    pub fn appended(
        &mut self,
        ticket: LoadTicket,
        snapshot: &PlayerSnapshot,
        next_fragment_bytes: Option<u64>,
    ) -> Result<AdapterUpdate, DomainError> {
        if !self.pending.as_ref().is_some_and(|pending| {
            pending.ticket == ticket
                && pending.phase == Phase::AwaitingAppend
                && !pending.revoked
                && ticket.generation == self.generation
        }) {
            return Err(DomainError::Invalid("追加确认不属于当前有效下载"));
        }
        let feedback = self.validate_snapshot(snapshot, 0, next_fragment_bytes)?;
        // apply只会在序号溢出时拒绝，必须先于预算释放检查。
        self.next_request
            .checked_add(1)
            .ok_or(DomainError::Invalid("播放请求序号溢出"))?;
        self.pending = None;
        self.apply(snapshot, feedback)
    }

    /// 网络或追加任务确认已释放资源后调用；匹配旧票据才能解除旧预留。
    pub fn release(&mut self, ticket: LoadTicket) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.ticket == ticket)
        {
            self.pending = None;
            true
        } else {
            false
        }
    }
}
