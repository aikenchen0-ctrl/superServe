// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
// 局部转写固定OpenTelemetry tracker的首点drop和单调求差机制。
// 本地改动：显式区间、不自动接受重置；来源与许可见otel-cumulative-NOTICE.txt。
use serde::Serialize;

#[derive(Debug, Default, Serialize)]
pub(crate) struct CounterWindow {
    pub samples: usize,
    pub first_sequence: Option<u64>,
    pub last_sequence: Option<u64>,
    pub from_elapsed_ms: Option<u64>,
    pub to_elapsed_ms: Option<u64>,
    pub baseline: Option<u64>,
    pub last: Option<u64>,
    pub observed_delta: Option<u64>,
}

impl CounterWindow {
    pub fn observe(
        &mut self,
        value: Option<u64>,
        sequence: u64,
        elapsed_ms: u64,
        duration: bool,
    ) -> Result<(), &'static str> {
        let Some(value) = value else { return Ok(()) };
        if let Some(previous) = self.last {
            let delta = value
                .checked_sub(previous)
                .ok_or("跨批累计值倒退，必须使用新交互代次")?;
            let elapsed = elapsed_ms
                .checked_sub(self.to_elapsed_ms.unwrap())
                .ok_or("累计观测单调时间倒退")?;
            if duration && delta > elapsed {
                return Err("活动或等待增量超过两个已知观测之间的时间");
            }
            self.observed_delta = Some(value - self.baseline.unwrap());
        } else {
            // 未知前缀只建基线，不把首个累计值当作已观测增量。
            self.baseline = Some(value);
            self.first_sequence = Some(sequence);
            self.from_elapsed_ms = Some(elapsed_ms);
        }
        self.samples += 1;
        self.last_sequence = Some(sequence);
        self.to_elapsed_ms = Some(elapsed_ms);
        self.last = Some(value);
        Ok(())
    }
}
