// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2016 The Android Open Source Project
// 移植自androidx/media的DefaultLoadControl.shouldContinueLoading/shouldStartPlayback，
// 参考提交8c6678b657ede1e7883fc164ef73ed483c7796c3；版权见LICENSES/media3-NOTICE.txt，
// 原许可证全文见LICENSES/media3-Apache-2.0.txt。
// 保留时间/大小阈值与滞回；使用有界毫秒整数和千分位倍速，不移植Android分配器和预加载分支。

use crate::playback::{PlaybackFeedback, PlaybackPolicy};

pub(crate) fn loading(
    was_loading: bool,
    policy: &PlaybackPolicy,
    feedback: &PlaybackFeedback,
    size_reached: bool,
) -> bool {
    loading_time(
        was_loading,
        policy.min_buffer_ms,
        policy.max_buffer_ms,
        feedback.buffered_media_ms,
        feedback.playback_rate_milli,
        size_reached,
    )
}

pub(crate) fn loading_time(
    was_loading: bool,
    min_buffer_ms: u32,
    max_buffer_ms: u32,
    buffered_media_ms: u64,
    playback_rate_milli: u32,
    size_reached: bool,
) -> bool {
    let minimum = if playback_rate_milli > 1000 {
        (u64::from(min_buffer_ms) * u64::from(playback_rate_milli))
            .div_ceil(1000)
            .min(u64::from(max_buffer_ms))
    } else {
        u64::from(min_buffer_ms)
    }
    .max(500);
    if buffered_media_ms < minimum {
        !size_reached
    } else if buffered_media_ms >= u64::from(max_buffer_ms) || size_reached {
        false
    } else {
        was_loading
    }
}

pub(crate) fn ready(
    policy: &PlaybackPolicy,
    feedback: &PlaybackFeedback,
    size_reached: bool,
) -> bool {
    let threshold = if feedback.rebuffering {
        policy.rebuffer_ms
    } else {
        policy.start_buffer_ms
    };
    feedback.buffered_media_ms > 0
        && (feedback.buffered_media_ms * 1000
            >= u64::from(threshold) * u64::from(feedback.playback_rate_milli)
            || size_reached
            || feedback.end_of_stream)
}
