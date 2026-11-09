use serde::{Deserialize, Serialize};

use crate::{DomainError, upstream::media3_load_control};

fn valid_buffer_times(minimum: u32, maximum: u32) -> bool {
    (500..=30_000).contains(&minimum) && (minimum..=60_000).contains(&maximum)
}

/// 实验策略；播放器按当前资源固定一份，不应每次取片请求服务端决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlaybackPolicy {
    pub min_buffer_ms: u32,
    pub max_buffer_ms: u32,
    pub start_buffer_ms: u32,
    pub rebuffer_ms: u32,
    pub max_buffer_bytes: u64,
}

impl Default for PlaybackPolicy {
    fn default() -> Self {
        Self {
            min_buffer_ms: 2000,
            max_buffer_ms: 4000,
            start_buffer_ms: 1000,
            rebuffer_ms: 2000,
            max_buffer_bytes: 8 * 1024 * 1024,
        }
    }
}

impl PlaybackPolicy {
    pub fn validate(&self) -> Result<(), DomainError> {
        if !valid_buffer_times(self.min_buffer_ms, self.max_buffer_ms)
            || !(1..=self.min_buffer_ms).contains(&self.start_buffer_ms)
            || !(self.start_buffer_ms..=self.min_buffer_ms).contains(&self.rebuffer_ms)
            || !(64 * 1024..=64 * 1024 * 1024).contains(&self.max_buffer_bytes)
        {
            return Err(DomainError::Invalid("播放缓冲策略越界"));
        }
        Ok(())
    }
}

/// 仅控制时间阈值；播放器继续拥有请求调度、字节预算和起播决定，不将未知字节伪装为零。
pub struct TimeBufferControl {
    min_buffer_ms: u32,
    max_buffer_ms: u32,
    is_loading: bool,
}

impl TimeBufferControl {
    pub fn new(min_buffer_ms: u32, max_buffer_ms: u32) -> Result<Self, DomainError> {
        if !valid_buffer_times(min_buffer_ms, max_buffer_ms) {
            return Err(DomainError::Invalid("播放时间阈值越界"));
        }
        Ok(Self {
            min_buffer_ms,
            max_buffer_ms,
            is_loading: false,
        })
    }

    pub fn reset(&mut self) {
        self.is_loading = false;
    }

    pub fn should_load(
        &mut self,
        buffered_media_ms: u32,
        playback_rate_milli: u32,
    ) -> Result<bool, DomainError> {
        if buffered_media_ms > 86_400_000 || !(250..=4000).contains(&playback_rate_milli) {
            return Err(DomainError::Invalid("播放时间反馈越界"));
        }
        self.is_loading = media3_load_control::loading_time(
            self.is_loading,
            self.min_buffer_ms,
            self.max_buffer_ms,
            u64::from(buffered_media_ms),
            playback_rate_milli,
            false,
        );
        Ok(self.is_loading)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackActivity {
    Active,
    Paused,
    Hidden,
    Seeking,
}

/// 由播放器报告的当前连续可播放区间；下载时长和跨越缺口的区间不能充当这个值。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlaybackFeedback {
    pub activity: PlaybackActivity,
    pub buffered_media_ms: u64,
    pub buffered_bytes: u64,
    pub in_flight_bytes: u64,
    pub next_fragment_bytes: Option<u64>,
    pub playback_rate_milli: u32,
    pub rebuffering: bool,
    pub end_of_stream: bool,
}

impl PlaybackFeedback {
    pub(crate) fn validate(&self) -> Result<(), DomainError> {
        if self.buffered_media_ms > 86_400_000
            || self.buffered_bytes > 512 * 1024 * 1024
            || self.in_flight_bytes > 512 * 1024 * 1024
            || !matches!(self.next_fragment_bytes, None | Some(1..=536_870_912))
            || !(250..=4000).contains(&self.playback_rate_milli)
            || (self.end_of_stream
                && (self.next_fragment_bytes.is_some() || self.in_flight_bytes != 0))
        {
            return Err(DomainError::Invalid("播放反馈越界或状态冲突"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoadReason {
    Inactive,
    EndOfStream,
    ByteLimit,
    BufferSatisfied,
    InFlight,
    AwaitingFragment,
    FragmentExceedsBudget,
    Load,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PlaybackDecision {
    pub load_next: bool,
    pub start_playback: bool,
    pub cancel_in_flight: bool,
    pub reason: LoadReason,
}

/// 每个播放对象只保存一位滞回状态；切换内容或不连续跳转时重置，不维护网络/用户状态。
pub struct LoadControl {
    policy: PlaybackPolicy,
    is_loading: bool,
}

impl LoadControl {
    pub fn new(policy: PlaybackPolicy) -> Result<Self, DomainError> {
        policy.validate()?;
        Ok(Self {
            policy,
            is_loading: false,
        })
    }

    pub fn reset(&mut self) {
        self.is_loading = false;
    }

    pub fn decide(&mut self, feedback: &PlaybackFeedback) -> Result<PlaybackDecision, DomainError> {
        feedback.validate()?;
        if feedback.activity != PlaybackActivity::Active {
            self.reset();
            return Ok(PlaybackDecision {
                load_next: false,
                start_playback: false,
                cancel_in_flight: feedback.in_flight_bytes != 0,
                reason: LoadReason::Inactive,
            });
        }
        let occupied = feedback.buffered_bytes + feedback.in_flight_bytes;
        let size_reached = occupied >= self.policy.max_buffer_bytes;
        let start_playback = media3_load_control::ready(
            &self.policy,
            feedback,
            feedback.buffered_bytes >= self.policy.max_buffer_bytes,
        );
        self.is_loading = !feedback.end_of_stream
            && media3_load_control::loading(self.is_loading, &self.policy, feedback, size_reached);
        let reason = if feedback.end_of_stream {
            LoadReason::EndOfStream
        } else if size_reached {
            LoadReason::ByteLimit
        } else if !self.is_loading {
            LoadReason::BufferSatisfied
        } else if feedback.in_flight_bytes != 0 {
            LoadReason::InFlight
        } else if let Some(bytes) = feedback.next_fragment_bytes {
            // 对完整分片先做字节准入，时间阈值只在两次分片之间检查，不承诺分片内停止。
            if occupied + bytes > self.policy.max_buffer_bytes {
                LoadReason::FragmentExceedsBudget
            } else {
                LoadReason::Load
            }
        } else {
            LoadReason::AwaitingFragment
        };
        Ok(PlaybackDecision {
            load_next: reason == LoadReason::Load,
            start_playback,
            cancel_in_flight: false,
            reason,
        })
    }
}
