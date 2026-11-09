// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)
// 区间排序及当前位置选取改编自video-dev/hls.js的src/utils/buffer-helper.ts，
// 固定提交15ded1909feda7a414998ba022d3b88e647592f7；许可见LICENSES/hlsjs-LICENSE.txt。
// 使用有界整数毫秒，合并重叠及首尾相接区间，不跨越任何正长度缺口。

use crate::playback_adapter::BufferedRange;

pub(crate) fn continuous_end(position_ms: u64, ranges: &[BufferedRange]) -> u64 {
    let mut ranges = ranges.to_vec();
    ranges.sort_unstable_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then_with(|| b.end_ms.cmp(&a.end_ms))
    });
    let mut end = position_ms;
    for range in ranges {
        if range.start_ms > end {
            break;
        }
        if range.end_ms > end {
            end = range.end_ms;
        }
    }
    end
}
