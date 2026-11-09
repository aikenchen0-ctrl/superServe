// SPDX-License-Identifier: MPL-2.0
// 宏接线改编UniFFI arithmetic-procmacro；决策与票据仍由原vs-core持有。
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};

use vs_core::{
    DomainError,
    playback::{LoadReason, PlaybackActivity, PlaybackPolicy, TimeBufferControl},
    playback_adapter::{
        AdapterUpdate, BufferedRange, Completion, LoadTicket, PlayerAdapter, PlayerSnapshot,
        TransferOutcome,
    },
};

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum PlaybackError {
    #[error("播放输入无效：{reason}")]
    InvalidInput { reason: String },
    #[error("播放对象正在处理其他调用")]
    Busy,
    #[error("播放对象不可用，请重新创建")]
    Unavailable,
}

impl From<DomainError> for PlaybackError {
    fn from(error: DomainError) -> Self {
        Self::InvalidInput {
            reason: error.to_string(),
        }
    }
}

#[derive(Clone, uniffi::Record)]
pub struct BufferPolicy {
    pub min_buffer_ms: u32,
    pub max_buffer_ms: u32,
    pub start_buffer_ms: u32,
    pub rebuffer_ms: u32,
    pub max_buffer_bytes: u64,
}

impl From<BufferPolicy> for PlaybackPolicy {
    fn from(value: BufferPolicy) -> Self {
        Self {
            min_buffer_ms: value.min_buffer_ms,
            max_buffer_ms: value.max_buffer_ms,
            start_buffer_ms: value.start_buffer_ms,
            rebuffer_ms: value.rebuffer_ms,
            max_buffer_bytes: value.max_buffer_bytes,
        }
    }
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum Activity {
    Active,
    Paused,
    Hidden,
    Seeking,
}

impl From<Activity> for PlaybackActivity {
    fn from(value: Activity) -> Self {
        match value {
            Activity::Active => Self::Active,
            Activity::Paused => Self::Paused,
            Activity::Hidden => Self::Hidden,
            Activity::Seeking => Self::Seeking,
        }
    }
}

#[derive(Clone, uniffi::Record)]
pub struct BufferRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, uniffi::Record)]
pub struct PlayerObservation {
    pub generation: u64,
    pub sequence: u64,
    pub monotonic_ms: u64,
    pub position_ms: u64,
    pub tracks: Vec<Vec<BufferRange>>,
    pub buffered_bytes: u64,
    pub activity: Activity,
    pub playback_rate_milli: u32,
    pub rebuffering: bool,
    pub end_of_stream: bool,
}

impl From<PlayerObservation> for PlayerSnapshot {
    fn from(value: PlayerObservation) -> Self {
        Self {
            generation: value.generation,
            sequence: value.sequence,
            monotonic_ms: value.monotonic_ms,
            position_ms: value.position_ms,
            tracks: value
                .tracks
                .into_iter()
                .map(|ranges| {
                    ranges
                        .into_iter()
                        .map(|range| BufferedRange {
                            start_ms: range.start_ms,
                            end_ms: range.end_ms,
                        })
                        .collect()
                })
                .collect(),
            buffered_bytes: value.buffered_bytes,
            activity: value.activity.into(),
            playback_rate_milli: value.playback_rate_milli,
            rebuffering: value.rebuffering,
            end_of_stream: value.end_of_stream,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TransferResult {
    Complete,
    Cancelled,
    Failed,
}

impl From<TransferResult> for TransferOutcome {
    fn from(value: TransferResult) -> Self {
        match value {
            TransferResult::Complete => Self::Complete,
            TransferResult::Cancelled => Self::Cancelled,
            TransferResult::Failed => Self::Failed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TransferCompletion {
    ReadyForAppend,
    Discarded,
    Stale,
    LengthMismatch,
}

impl From<Completion> for TransferCompletion {
    fn from(value: Completion) -> Self {
        match value {
            Completion::ReadyForAppend => Self::ReadyForAppend,
            Completion::Discarded => Self::Discarded,
            Completion::Stale => Self::Stale,
            Completion::LengthMismatch => Self::LengthMismatch,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum DecisionReason {
    Inactive,
    EndOfStream,
    ByteLimit,
    BufferSatisfied,
    InFlight,
    AwaitingFragment,
    FragmentExceedsBudget,
    Load,
}

impl From<LoadReason> for DecisionReason {
    fn from(value: LoadReason) -> Self {
        match value {
            LoadReason::Inactive => Self::Inactive,
            LoadReason::EndOfStream => Self::EndOfStream,
            LoadReason::ByteLimit => Self::ByteLimit,
            LoadReason::BufferSatisfied => Self::BufferSatisfied,
            LoadReason::InFlight => Self::InFlight,
            LoadReason::AwaitingFragment => Self::AwaitingFragment,
            LoadReason::FragmentExceedsBudget => Self::FragmentExceedsBudget,
            LoadReason::Load => Self::Load,
        }
    }
}

/// 不提供构造器或可变字段，外语侧不能伪造owner、序号和长度。
#[derive(uniffi::Object)]
pub struct DownloadTicket {
    ticket: LoadTicket,
}

impl DownloadTicket {
    fn wrap(ticket: LoadTicket) -> Arc<Self> {
        Arc::new(Self { ticket })
    }
}

#[uniffi::export]
impl DownloadTicket {
    pub fn bytes(&self) -> u64 {
        self.ticket.bytes()
    }

    pub fn generation(&self) -> u64 {
        self.ticket.generation()
    }
}

#[derive(uniffi::Record)]
pub struct PlayerUpdate {
    pub buffered_media_ms: u64,
    pub in_flight_bytes: u64,
    pub load_next: bool,
    pub start_playback: bool,
    pub cancel_in_flight: bool,
    pub reason: DecisionReason,
    pub request: Option<Arc<DownloadTicket>>,
    pub cancel: Option<Arc<DownloadTicket>>,
}

impl From<AdapterUpdate> for PlayerUpdate {
    fn from(value: AdapterUpdate) -> Self {
        Self {
            buffered_media_ms: value.feedback.buffered_media_ms,
            in_flight_bytes: value.feedback.in_flight_bytes,
            load_next: value.decision.load_next,
            start_playback: value.decision.start_playback,
            cancel_in_flight: value.decision.cancel_in_flight,
            reason: value.decision.reason.into(),
            request: value.request.map(DownloadTicket::wrap),
            cancel: value.cancel.map(DownloadTicket::wrap),
        }
    }
}

#[derive(uniffi::Record)]
pub struct GenerationUpdate {
    pub generation: u64,
    pub cancel: Option<Arc<DownloadTicket>>,
}

#[derive(uniffi::Object)]
pub struct NativePlayer {
    adapter: Mutex<PlayerAdapter>,
}

/// 平台自己调度下载时只使用时间门，不捏造完整票据适配器所需的分片证据。
#[derive(uniffi::Object)]
pub struct NativeTimeBufferControl {
    control: Mutex<TimeBufferControl>,
}

impl NativeTimeBufferControl {
    fn control(&self) -> Result<MutexGuard<'_, TimeBufferControl>, PlaybackError> {
        self.control.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => PlaybackError::Busy,
            TryLockError::Poisoned(_) => PlaybackError::Unavailable,
        })
    }
}

#[uniffi::export]
impl NativeTimeBufferControl {
    #[uniffi::constructor]
    pub fn new(min_buffer_ms: u32, max_buffer_ms: u32) -> Result<Arc<Self>, PlaybackError> {
        Ok(Arc::new(Self {
            control: Mutex::new(TimeBufferControl::new(min_buffer_ms, max_buffer_ms)?),
        }))
    }

    pub fn reset(&self) -> Result<(), PlaybackError> {
        self.control()?.reset();
        Ok(())
    }

    pub fn should_load(
        &self,
        buffered_media_ms: u32,
        playback_rate_milli: u32,
    ) -> Result<bool, PlaybackError> {
        Ok(self
            .control()?
            .should_load(buffered_media_ms, playback_rate_milli)?)
    }
}

impl NativePlayer {
    fn adapter(&self) -> Result<MutexGuard<'_, PlayerAdapter>, PlaybackError> {
        self.adapter.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => PlaybackError::Busy,
            TryLockError::Poisoned(_) => PlaybackError::Unavailable,
        })
    }
}

#[uniffi::export]
impl NativePlayer {
    #[uniffi::constructor]
    pub fn new(policy: BufferPolicy) -> Result<Arc<Self>, PlaybackError> {
        Ok(Arc::new(Self {
            adapter: Mutex::new(PlayerAdapter::new(policy.into())?),
        }))
    }

    pub fn generation(&self) -> Result<u64, PlaybackError> {
        Ok(self.adapter()?.generation())
    }

    pub fn change_generation(&self) -> Result<GenerationUpdate, PlaybackError> {
        let update = self.adapter()?.change_generation()?;
        Ok(GenerationUpdate {
            generation: update.generation,
            cancel: update.cancel.map(DownloadTicket::wrap),
        })
    }

    pub fn update(
        &self,
        observation: PlayerObservation,
        next_fragment_bytes: Option<u64>,
    ) -> Result<PlayerUpdate, PlaybackError> {
        Ok(self
            .adapter()?
            .update(&observation.into(), next_fragment_bytes)?
            .into())
    }

    pub fn transfer_finished(
        &self,
        ticket: Arc<DownloadTicket>,
        received_bytes: u64,
        outcome: TransferResult,
    ) -> Result<TransferCompletion, PlaybackError> {
        Ok(self
            .adapter()?
            .transfer_finished(ticket.ticket, received_bytes, outcome.into())
            .into())
    }

    pub fn appended(
        &self,
        ticket: Arc<DownloadTicket>,
        observation: PlayerObservation,
        next_fragment_bytes: Option<u64>,
    ) -> Result<PlayerUpdate, PlaybackError> {
        Ok(self
            .adapter()?
            .appended(ticket.ticket, &observation.into(), next_fragment_bytes)?
            .into())
    }

    pub fn release(&self, ticket: Arc<DownloadTicket>) -> Result<bool, PlaybackError> {
        Ok(self.adapter()?.release(ticket.ticket))
    }
}

uniffi::setup_scaffolding!();

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> BufferPolicy {
        BufferPolicy {
            min_buffer_ms: 2000,
            max_buffer_ms: 4000,
            start_buffer_ms: 1000,
            rebuffer_ms: 2000,
            max_buffer_bytes: 65536,
        }
    }

    fn observation(sequence: u64) -> PlayerObservation {
        PlayerObservation {
            generation: 1,
            sequence,
            monotonic_ms: sequence * 10,
            position_ms: 0,
            tracks: vec![vec![], vec![]],
            buffered_bytes: 0,
            activity: Activity::Active,
            playback_rate_milli: 1000,
            rebuffering: false,
            end_of_stream: false,
        }
    }

    #[test]
    fn transfer_does_not_release_budget_before_append() {
        let player = NativePlayer::new(policy()).unwrap();
        let ticket = player
            .update(observation(1), Some(1024))
            .unwrap()
            .request
            .unwrap();
        assert_eq!(ticket.bytes(), 1024);
        assert_eq!(
            player
                .transfer_finished(ticket.clone(), 1024, TransferResult::Complete)
                .unwrap(),
            TransferCompletion::ReadyForAppend
        );
        let waiting = player.update(observation(2), Some(1024)).unwrap();
        assert_eq!(waiting.in_flight_bytes, 1024);
        assert_eq!(waiting.reason, DecisionReason::InFlight);
        let mut appended = observation(3);
        appended.buffered_bytes = 1024;
        appended.tracks = vec![
            vec![BufferRange {
                start_ms: 0,
                end_ms: 4000
            }];
            2
        ];
        let update = player.appended(ticket.clone(), appended, None).unwrap();
        assert_eq!(update.buffered_media_ms, 4000);
        assert!(update.start_playback);
        assert!(!player.release(ticket).unwrap());
    }

    #[test]
    fn foreign_ticket_and_old_completion_do_not_release_current_budget() {
        let player = NativePlayer::new(policy()).unwrap();
        let other = NativePlayer::new(policy()).unwrap();
        let first = player
            .update(observation(1), Some(1024))
            .unwrap()
            .request
            .unwrap();
        let foreign = other
            .update(observation(1), Some(1024))
            .unwrap()
            .request
            .unwrap();
        assert!(!player.release(foreign.clone()).unwrap());
        assert_eq!(
            player
                .transfer_finished(foreign, 1024, TransferResult::Complete)
                .unwrap(),
            TransferCompletion::Stale
        );
        let changed = player.change_generation().unwrap();
        assert_eq!(changed.generation, 2);
        assert_eq!(changed.cancel.unwrap().generation(), 1);
        assert!(player.update(observation(2), Some(1024)).is_err());
        assert_eq!(
            player
                .transfer_finished(first, 1024, TransferResult::Complete)
                .unwrap(),
            TransferCompletion::Discarded
        );
        let mut next = observation(1);
        next.generation = 2;
        assert!(player.update(next, Some(1024)).unwrap().request.is_some());
    }

    #[test]
    fn invalid_snapshots_and_busy_calls_do_not_mutate_state() {
        let player = NativePlayer::new(policy()).unwrap();
        let mut invalid = observation(1);
        invalid.tracks.clear();
        assert!(player.update(invalid, Some(1024)).is_err());
        let guard = player.adapter.lock().unwrap();
        assert!(matches!(player.generation(), Err(PlaybackError::Busy)));
        drop(guard);
        assert!(
            player
                .update(observation(1), Some(1024))
                .unwrap()
                .request
                .is_some()
        );
        assert!(player.update(observation(1), Some(1024)).is_err());
        let mut invalid_policy = policy();
        invalid_policy.max_buffer_bytes = 1;
        assert!(NativePlayer::new(invalid_policy).is_err());
    }

    #[test]
    fn inactive_requests_require_explicit_resource_release() {
        for activity in [Activity::Paused, Activity::Hidden, Activity::Seeking] {
            let player = NativePlayer::new(policy()).unwrap();
            let ticket = player
                .update(observation(1), Some(1024))
                .unwrap()
                .request
                .unwrap();
            let mut inactive = observation(2);
            inactive.activity = activity;
            let update = player.update(inactive, None).unwrap();
            assert!(update.cancel_in_flight);
            assert!(update.cancel.is_some());
            assert!(!update.start_playback);
            assert!(player.release(ticket.clone()).unwrap());
            assert!(!player.release(ticket).unwrap());
        }
    }

    #[test]
    fn wrapper_preserves_core_decisions_across_policies_rates_and_buffers() {
        for (minimum, maximum) in [(500, 500), (2000, 4000), (30_000, 60_000)] {
            for rate in [250, 1000, 2000, 4000] {
                for buffered in [0, 499, 500, 1999, 2000, 3999, 4000, 60_000] {
                    let mut settings = policy();
                    settings.min_buffer_ms = minimum;
                    settings.max_buffer_ms = maximum;
                    settings.start_buffer_ms = minimum.min(1000);
                    settings.rebuffer_ms = settings.start_buffer_ms;
                    let player = NativePlayer::new(settings.clone()).unwrap();
                    let mut core = PlayerAdapter::new(settings.into()).unwrap();
                    let mut sample = observation(1);
                    sample.playback_rate_milli = rate;
                    if buffered != 0 {
                        sample.tracks = vec![
                            vec![BufferRange {
                                start_ms: 0,
                                end_ms: buffered,
                            }];
                            2
                        ];
                    }
                    let expected = core.update(&sample.clone().into(), Some(1024)).unwrap();
                    let actual = player.update(sample, Some(1024)).unwrap();
                    assert_eq!(
                        actual.buffered_media_ms,
                        expected.feedback.buffered_media_ms
                    );
                    assert_eq!(actual.reason, expected.decision.reason.into());
                    assert_eq!(actual.load_next, expected.decision.load_next);
                    assert_eq!(actual.start_playback, expected.decision.start_playback);
                    assert_eq!(
                        actual.request.as_ref().map(|ticket| ticket.bytes()),
                        expected.request.map(|ticket| ticket.bytes())
                    );
                }
            }
        }
    }

    #[test]
    fn poisoned_adapter_fails_closed_instead_of_recovering_unproven_state() {
        let player = NativePlayer::new(policy()).unwrap();
        let other = player.clone();
        let _ = std::thread::spawn(move || {
            let _guard = other.adapter.lock().unwrap();
            panic!("仅测试锁中毒");
        })
        .join();
        assert!(matches!(
            player.generation(),
            Err(PlaybackError::Unavailable)
        ));
        assert!(matches!(
            player.update(observation(1), None),
            Err(PlaybackError::Unavailable)
        ));
    }

    #[test]
    fn time_only_gate_reuses_core_hysteresis_without_fake_bytes() {
        for (minimum, maximum) in [(500, 500), (2000, 4000), (30_000, 60_000)] {
            for rate in [250, 1000, 1501, 2000, 4000] {
                let wrapper = NativeTimeBufferControl::new(minimum, maximum).unwrap();
                let mut core = TimeBufferControl::new(minimum, maximum).unwrap();
                for buffer in [0, 4000, 3000, 1999, 1000, 60_000, 0] {
                    assert_eq!(
                        wrapper.should_load(buffer, rate).unwrap(),
                        core.should_load(buffer, rate).unwrap()
                    );
                }
                assert!(wrapper.should_load(0, 0).is_err());
                wrapper.reset().unwrap();
                core.reset();
                assert_eq!(
                    wrapper.should_load(3000, rate).unwrap(),
                    core.should_load(3000, rate).unwrap()
                );
            }
        }
        assert!(NativeTimeBufferControl::new(0, 4000).is_err());
    }
}
