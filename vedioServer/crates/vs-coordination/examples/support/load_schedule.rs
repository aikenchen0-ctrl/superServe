// SPDX-License-Identifier: MIT
// 调度与计划起点计时局部改编自oha 43c7cf207fa7153ff1dbb566b0a9d60b3741d0d6
// src/client.rs的work_with_qps_latency_correction和RequestResult::duration。
// 本地改为有界并发、无等待队列，拒绝也保留样本；见LICENSES/oha-*。
use std::{future::Future, sync::Arc, time::Duration};

use serde::Serialize;
use tokio::{sync::Semaphore, task::JoinSet, time::Instant};

#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    pub sequence: usize,
    pub planned_ns: u64,
    pub dispatch_lag_ns: Option<u64>,
    pub service_ns: Option<u64>,
    pub scheduled_elapsed_ns: u64,
    pub outcome: String,
    pub status: Option<u16>,
    pub request_bytes: usize,
    pub response_bytes: usize,
}

#[derive(Debug, Serialize)]
pub struct Percentiles {
    pub samples: usize,
    pub p50_ns: u64,
    pub p95_ns: u64,
    pub p99_ns: u64,
    pub max_ns: u64,
}

pub fn percentiles(values: impl Iterator<Item = u64>) -> Option<Percentiles> {
    let mut values: Vec<_> = values.collect();
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let at = |p: usize| values[(p * values.len()).div_ceil(100) - 1];
    Some(Percentiles {
        samples: values.len(),
        p50_ns: at(50),
        p95_ns: at(95),
        p99_ns: at(99),
        max_ns: *values.last().unwrap(),
    })
}

pub fn offset(sequence: usize, rate: u32) -> Duration {
    Duration::from_nanos((sequence as u64) * 1_000_000_000 / u64::from(rate))
}

fn nanos(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

pub async fn run<F, Fut>(count: usize, rate: u32, concurrency: usize, work: F) -> Vec<Sample>
where
    F: Fn(usize) -> Fut,
    Fut: Future<Output = (String, Option<u16>, usize, usize)> + Send + 'static,
{
    let start = Instant::now();
    let permits = Arc::new(Semaphore::new(concurrency));
    let mut tasks = JoinSet::new();
    let mut samples = Vec::with_capacity(count);
    for sequence in 0..count {
        let planned = start + offset(sequence, rate);
        tokio::time::sleep_until(planned).await;
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            samples.push(Sample {
                sequence,
                planned_ns: nanos(planned - start),
                dispatch_lag_ns: None,
                service_ns: None,
                scheduled_elapsed_ns: nanos(planned.elapsed()),
                outcome: "client_dropped".into(),
                status: None,
                request_bytes: 0,
                response_bytes: 0,
            });
            continue;
        };
        let future = work(sequence);
        tasks.spawn(async move {
            let _permit = permit;
            let dispatched = Instant::now();
            let (outcome, status, request_bytes, response_bytes) = future.await;
            let end = Instant::now();
            Sample {
                sequence,
                planned_ns: nanos(planned - start),
                dispatch_lag_ns: Some(nanos(dispatched.saturating_duration_since(planned))),
                service_ns: Some(nanos(end - dispatched)),
                scheduled_elapsed_ns: nanos(end.saturating_duration_since(planned)),
                outcome,
                status,
                request_bytes,
                response_bytes,
            }
        });
        while let Some(result) = tasks.try_join_next() {
            samples.push(result.expect("压测工作任务异常"));
        }
    }
    while let Some(result) = tasks.join_next().await {
        samples.push(result.expect("压测工作任务异常"));
    }
    samples.sort_by_key(|sample| sample.sequence);
    samples
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_offsets_and_nearest_rank_do_not_average_stage_quantiles() {
        assert_eq!(offset(4, 3).as_nanos(), 1_333_333_333);
        assert!(percentiles(std::iter::empty()).is_none());
        let result = percentiles((1..=100).rev()).unwrap();
        assert_eq!(
            (result.p50_ns, result.p95_ns, result.p99_ns, result.max_ns),
            (50, 95, 99, 100)
        );
    }

    #[tokio::test]
    async fn saturation_keeps_all_arrivals_and_does_not_queue_or_retry_dropped_work() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let samples = run(20, 1_000_000, 1, move |_| {
            let calls = observed.clone();
            async move {
                calls.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(40)).await;
                ("verified".into(), Some(200), 1, 2)
            }
        })
        .await;
        assert_eq!(samples.len(), 20);
        assert!(calls.load(Ordering::Relaxed) < 20);
        assert!(
            samples
                .iter()
                .any(|sample| sample.outcome == "client_dropped")
        );
        assert_eq!(
            calls.load(Ordering::Relaxed),
            samples
                .iter()
                .filter(|sample| sample.status == Some(200))
                .count()
        );
        for (index, sample) in samples.iter().enumerate() {
            assert_eq!(sample.sequence, index);
            assert_eq!(
                sample.planned_ns,
                offset(index, 1_000_000).as_nanos() as u64
            );
            if let (Some(lag), Some(service)) = (sample.dispatch_lag_ns, sample.service_ns) {
                assert_eq!(sample.scheduled_elapsed_ns, lag + service);
            }
        }
    }
}
