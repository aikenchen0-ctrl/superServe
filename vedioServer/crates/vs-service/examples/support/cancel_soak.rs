use std::{
    collections::BTreeMap,
    future::Future,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{StreamExt, stream::FuturesUnordered};
use opendal::Operator;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::{
    Check, delete_check,
    direct_cancel::{self, Action},
    ensure,
};

const OBJECTS: usize = 8;
const OBJECT_BYTES: usize = 3_145_801;
const CYCLES: usize = 3;
const SLOTS: usize = 600;
const PERIOD: Duration = Duration::from_millis(25);
const MAX_IN_FLIGHT: usize = 8;
const DRAIN: Duration = Duration::from_secs(12);

#[derive(Default, Debug, Serialize)]
struct Counts {
    scheduled: usize,
    dispatched: usize,
    skipped_capacity: usize,
    skipped_late: usize,
    completed: usize,
    aborted_at_drain_deadline: usize,
    peak_in_flight: usize,
    body_polled_bytes: u64,
    stages: BTreeMap<String, usize>,
    errors: BTreeMap<String, usize>,
}

impl Counts {
    fn record(&mut self, result: Check<Value>) {
        self.completed += 1;
        match result {
            Ok(value) => {
                let stage = value["stage"].as_str().unwrap_or("invalid_stage");
                *self.stages.entry(stage.to_string()).or_default() += 1;
                self.body_polled_bytes += value["response_body_polled_bytes"].as_u64().unwrap_or(0);
            }
            Err(error) => *self.errors.entry(error).or_default() += 1,
        }
    }

    fn valid(&self) -> bool {
        self.scheduled == self.dispatched + self.skipped_capacity + self.skipped_late
            && self.dispatched == self.completed + self.aborted_at_drain_deadline
    }

    fn covered(&self) -> bool {
        self.valid()
            && self.errors.is_empty()
            && self.aborted_at_drain_deadline == 0
            && self.dispatched * 10 >= self.scheduled * 9
            && ["full", "dropped_after_headers", "cancelled_before_headers"]
                .iter()
                .all(|key| self.stages.get(*key).copied().unwrap_or(0) > 0)
    }
}

// 无队列补发：落后时跳过时隙；并发饱和时记账，不把压力转成探针积压。
async fn drive<F, Fut>(
    slots: usize,
    period: Duration,
    capacity: usize,
    drain: Duration,
    mut make: F,
) -> Counts
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Check<Value>>,
{
    let start = Instant::now();
    let end = start + period * slots as u32;
    let mut pending = FuturesUnordered::new();
    let mut counts = Counts::default();
    let mut slot = 0;
    while slot < slots {
        let due = start + period * slot as u32;
        tokio::select! {
            biased;
            Some(result) = pending.next(), if !pending.is_empty() => counts.record(result),
            _ = tokio::time::sleep_until(due) => {
                counts.scheduled += 1;
                if Instant::now() >= due + period {
                    counts.skipped_late += 1;
                } else if pending.len() == capacity {
                    counts.skipped_capacity += 1;
                } else {
                    pending.push(make(slot));
                    counts.dispatched += 1;
                    counts.peak_in_flight = counts.peak_in_flight.max(pending.len());
                }
                slot += 1;
            }
        }
    }
    // 排空只等待本地请求；远端任务是否完成不能由此推导。
    let _ = tokio::time::timeout_at(end + drain, async {
        while let Some(result) = pending.next().await {
            counts.record(result);
        }
    })
    .await;
    counts.aborted_at_drain_deadline = pending.len();
    drop(pending);
    tokio::time::sleep_until(end).await;
    counts
}

fn profile(slot: usize) -> (usize, usize, usize, Action) {
    let action = match slot % 5 {
        0 => Action::Full,
        1 => Action::DropAfterHeaders,
        2 => Action::CancelAfter(Duration::ZERO),
        3 => Action::CancelAfter(Duration::from_millis(1)),
        _ => Action::CancelAfter(Duration::from_millis(4)),
    };
    // 路由维度独立变化，避免每个对象固定在某个端点或某种动作。
    (
        slot % OBJECTS,
        (slot / OBJECTS) % 4,
        if (slot / (OBJECTS * 4)).is_multiple_of(2) {
            65_536
        } else {
            1_048_576
        },
        action,
    )
}

fn mark(phases: &mut Vec<Value>, phase: &str, cycle: Option<usize>) {
    let value = json!({
        "phase": phase, "cycle": cycle,
        "unix_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
    });
    eprintln!("{value}");
    phases.push(value);
}

pub async fn run(operators: &[Operator], seed: &str, bucket: &str) -> Check<()> {
    ensure(operators.len() == 4, "soak_requires_four_nodes")?;
    let client = direct_cancel::client()?;
    let mut owned = Vec::new();
    let mut objects = Vec::new();
    let mut cycles = Vec::new();
    let mut phases = Vec::new();
    let mut verification = Vec::new();
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(420), async {
        mark(&mut phases, "prepare", None);
        for index in 0..OBJECTS {
            let mut data = vec![0; OBJECT_BYTES];
            for (offset, chunk) in data.chunks_mut(32).enumerate() {
                let hash = Sha256::digest(format!("{seed}:soak:{index}:{offset}").as_bytes());
                chunk.copy_from_slice(&hash[..chunk.len()]);
            }
            let hash = format!("{:x}", Sha256::digest(&data));
            let key = format!("media/{hash}");
            owned.push(hash);
            operators[0]
                .write_with(&key, data.clone())
                .if_not_exists(true)
                .await
                .map_err(super::storage_error)?;
            // 先预热全部端点，基线不混入首次对象创建或首次连接。
            for operator in operators {
                direct_cancel::request(&client, operator, &key, 0..4096, &data, Action::Full)
                    .await?;
            }
            objects.push((key, data));
        }
        mark(&mut phases, "baseline", None);
        tokio::time::sleep(Duration::from_secs(10)).await;
        for cycle in 0..CYCLES {
            mark(&mut phases, "load", Some(cycle));
            let counts = drive(SLOTS, PERIOD, MAX_IN_FLIGHT, DRAIN, |slot| {
                let (object, endpoint, length, action) = profile(slot + cycle * SLOTS);
                let (key, data) = &objects[object];
                direct_cancel::request(
                    &client,
                    &operators[endpoint],
                    key,
                    4096..4096 + length,
                    data,
                    action,
                )
            })
            .await;
            cycles.push(json!({"cycle": cycle, "counts": counts, "covered": counts.covered()}));
            mark(&mut phases, "recovery", Some(cycle));
            tokio::time::sleep(Duration::from_secs(if cycle + 1 == CYCLES {
                60
            } else {
                30
            }))
            .await;
        }
        mark(&mut phases, "verify", None);
        for (key, data) in &objects {
            for (endpoint, operator) in operators.iter().enumerate() {
                let check = direct_cancel::request(
                    &client,
                    operator,
                    key,
                    0..data.len(),
                    data,
                    Action::Full,
                )
                .await;
                verification.push(json!({
                    "object_sha256": key.strip_prefix("media/").unwrap(),
                    "endpoint": endpoint, "passed": check.is_ok(), "error": check.err()
                }));
            }
        }
        ensure(
            cycles.iter().all(|cycle| cycle["covered"] == true),
            "soak_workload_or_request_failed",
        )?;
        ensure(
            verification.len() == OBJECTS * 4 && verification.iter().all(|v| v["passed"] == true),
            "soak_integrity_failed",
        )
    })
    .await
    .map_err(|_| "soak_deadline".to_string())
    .and_then(|r| r);
    mark(&mut phases, "cleanup", None);
    let mut cleanup = Vec::new();
    for hash in &owned {
        cleanup.push(delete_check::delete_and_check(operators, hash).await);
    }
    let cleaned = delete_check::outcome(&cleanup);
    mark(&mut phases, "finished", None);
    println!(
        "{}",
        json!({
            "schema": "storage-cancel-soak-v1", "seed": seed, "bucket": bucket,
            "passed": result.is_ok() && cleaned.is_ok(), "error": result.as_ref().err(),
            "owned_object_sha256": owned, "cycles": cycles, "phases": phases,
            "verification": verification, "cleanup": cleanup, "cleanup_passed": cleaned.is_ok(),
            "elapsed_ms": started.elapsed().as_millis(),
            "configuration": {
                "objects": OBJECTS, "object_bytes": OBJECT_BYTES, "cycles": CYCLES,
                "slots_per_cycle": SLOTS, "period_ms": PERIOD.as_millis(),
                "max_in_flight": MAX_IN_FLIGHT, "drain_ms": DRAIN.as_millis(),
                "baseline_seconds": 10, "recovery_seconds": [30, 30, 60],
                "minimum_dispatch_fraction": 0.9, "request_timeout_seconds": 10
            },
            "resource_convergence_proven": false, "remote_task_count_measured": false,
            "remote_lease_count_measured": false, "production_performance_claim": false
        })
    );
    result?;
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn saturated_load_is_bounded_and_pending_futures_are_dropped() {
        struct DropCount(Arc<AtomicUsize>);
        impl Drop for DropCount {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let counts = drive(
            8,
            Duration::from_millis(10),
            2,
            Duration::from_millis(10),
            |_| {
                let guard = DropCount(dropped.clone());
                async move {
                    let _guard = guard;
                    std::future::pending::<Check<Value>>().await
                }
            },
        )
        .await;
        assert!(counts.valid());
        assert!(counts.dispatched > 0 && counts.dispatched <= 2);
        assert_eq!(counts.peak_in_flight, counts.dispatched);
        assert_eq!(counts.aborted_at_drain_deadline, counts.dispatched);
        assert_eq!(dropped.load(Ordering::SeqCst), counts.dispatched);
        assert!(!counts.covered());
    }

    #[tokio::test]
    async fn completed_errors_are_not_lost_or_counted_as_cancellation() {
        let counts = drive(
            2,
            Duration::from_millis(50),
            2,
            Duration::from_secs(1),
            |_| async { Err("synthetic_http_failure".to_string()) },
        )
        .await;
        assert!(counts.valid());
        assert!(counts.dispatched > 0);
        assert_eq!(counts.errors["synthetic_http_failure"], counts.dispatched);
        assert_eq!(counts.completed, counts.dispatched);
        assert_eq!(counts.aborted_at_drain_deadline, 0);
        assert!(!counts.covered());
    }

    #[test]
    fn profile_covers_every_object_endpoint_action_and_length() {
        let mut combinations = std::collections::HashSet::new();
        for slot in 0..SLOTS * CYCLES {
            let (object, endpoint, length, action) = profile(slot);
            combinations.insert((object, endpoint, length, format!("{action:?}")));
        }
        assert_eq!(combinations.len(), OBJECTS * 4 * 2 * 5);
    }

    #[test]
    fn missing_cancellation_or_accounting_cannot_pass() {
        let mut counts = Counts::default();
        assert!(!counts.covered());
        counts.scheduled = 3;
        counts.dispatched = 3;
        for stage in ["full", "dropped_after_headers", "cancelled_before_headers"] {
            counts.record(Ok(json!({"stage": stage, "response_body_polled_bytes": 0})));
        }
        assert!(counts.covered());
        counts.dispatched += 1;
        assert!(!counts.covered());
    }
}
