use std::{
    ops::Range,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use vs_service::{AppState, Role, router};
use vs_storage::MediaStore;

use super::{Check, ensure, range_cases};

#[derive(Clone, Copy)]
pub enum Consumption {
    Full,
    FirstChunk,
    Bytes(usize),
}

pub struct Case {
    pub name: String,
    pub range: Range<usize>,
    pub consumption: Consumption,
}

pub async fn run(store: MediaStore, hash: &str, data: &[u8]) -> Check<Value> {
    let mut cases: Vec<_> = range_cases(data.len())
        .into_iter()
        .enumerate()
        .map(|(index, range)| Case {
            name: format!("range-{index}"),
            range,
            consumption: Consumption::Full,
        })
        .collect();
    cases.push(Case {
        name: "full".into(),
        range: 0..data.len(),
        consumption: Consumption::Full,
    });
    cases.push(Case {
        name: "cancel-full".into(),
        range: 0..data.len(),
        consumption: Consumption::FirstChunk,
    });
    run_cases(store, hash, data, &cases).await
}

pub async fn run_cases(store: MediaStore, hash: &str, data: &[u8], cases: &[Case]) -> Check<Value> {
    let token = format!("storage-measure-{hash}");
    let catalog = serde_json::to_vec(&json!({
        "version": "storage-measure",
        "items": [],
        "assets": [{"sha256": hash, "bytes": data.len(), "content_type": "application/octet-stream"}]
    }))
    .map_err(|_| "measure_catalog")?;
    let state = Arc::new(
        AppState::new(&catalog, Some(store.clone()), &token, 1, 2).map_err(str::to_string)?,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "measure_bind")?;
    let address = listener.local_addr().map_err(|_| "measure_address")?;
    let app = router(state.clone(), Role::Media);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let mut task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await
    });
    let result = async {
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "measure_client")?;
        let url = format!("http://{address}/v1/media/{hash}");
        let mut samples = Vec::new();
        for case in cases {
            let range = &case.range;
            ensure(range.start < range.end && range.end <= data.len(), "measure_invalid_range")?;
            let target = match case.consumption {
                Consumption::Bytes(target) => {
                    ensure(target > 0 && target < range.len(), "measure_invalid_budget")?;
                    Some(target)
                }
                _ => None,
            };
            let cancel = !matches!(case.consumption, Consumption::Full);
            let before = store.http_metrics().ok_or("measure_requires_s3")?;
            ensure(before.active_exchanges == 0, "measure_not_quiescent")?;
            let yielded_before = state.counters.media_bytes_yielded.load(Ordering::Relaxed);
            let start = Instant::now();
            let mut response = client
                .get(&url)
                .bearer_auth(&token)
                .header("range", format!("bytes={}-{}", range.start, range.end - 1))
                .send()
                .await
                .map_err(|_| "measure_request")?;
            let headers_us = start.elapsed().as_micros() as u64;
            ensure(response.status() == StatusCode::PARTIAL_CONTENT, "measure_status")?;
            let mut offset = range.start;
            let mut consumed = 0;
            let mut first_body_us = None;
            while let Some(bytes) = response.chunk().await.map_err(|_| "measure_body")? {
                if bytes.is_empty() {
                    continue;
                }
                first_body_us.get_or_insert(start.elapsed().as_micros() as u64);
                let end = offset.checked_add(bytes.len()).ok_or("measure_overflow")?;
                ensure(end <= range.end, "measure_overread")?;
                ensure(bytes.as_ref() == &data[offset..end], "measure_mismatch")?;
                offset = end;
                // 请求库返回一块不等于应用消费整块；各模式使用相同预算并保留未消费尾部的计数。
                consumed += target.map_or(bytes.len(), |target| bytes.len().min(target - consumed));
                if matches!(case.consumption, Consumption::FirstChunk) || target == Some(consumed) {
                    break;
                }
            }
            let consumer_done_us = start.elapsed().as_micros() as u64;
            drop(response);
            // 许可跟随响应体；等待释放后再取快照，避免把本次残余读取计入下一次。
            let slots = tokio::time::timeout(
                Duration::from_secs(5),
                state.media_slots.clone().acquire_many_owned(2),
            )
            .await
            .map_err(|_| "measure_drain_timeout")?
            .map_err(|_| "measure_slots_closed")?;
            let settled_us = start.elapsed().as_micros() as u64;
            let after = store.http_metrics().ok_or("measure_requires_s3")?;
            ensure(after.active_exchanges == 0, "measure_active_after_drain")?;
            let received = consumed as u64;
            let client_polled = (offset - range.start) as u64;
            let requested = (range.end - range.start) as u64;
            ensure(
                if cancel { received > 0 && received < requested } else { received == requested },
                "measure_consumer_length",
            )?;
            ensure(target.is_none_or(|target| consumed == target), "measure_budget_mismatch")?;
            let yielded = state.counters.media_bytes_yielded.load(Ordering::Relaxed) - yielded_before;
            let origin = after.response_body_bytes - before.response_body_bytes;
            ensure(origin >= yielded && yielded >= client_polled && client_polled >= received, "measure_byte_order")?;
            ensure(
                after.transport_errors == before.transport_errors
                    && after.status_errors == before.status_errors,
                "measure_upstream_error",
            )?;
            samples.push(json!({
                "case": case.name, "range_start": range.start, "range_end_exclusive": range.end,
                "cancel_after_first_chunk": matches!(case.consumption, Consumption::FirstChunk),
                "cancel_after_bytes": target, "requested_bytes": requested,
                "client_polled_body_bytes": client_polled,
                "client_consumed_body_bytes": received, "media_body_yielded_bytes": yielded,
                "storage_http_polled_body_bytes": origin,
                "storage_http_requests": after.requests - before.requests,
                "storage_http_get_requests": after.get_requests - before.get_requests,
                "storage_http_head_requests": after.head_requests - before.head_requests,
                "storage_http_abandoned_exchanges": after.abandoned_exchanges - before.abandoned_exchanges,
                "storage_http_abandoned_before_headers": after.abandoned_before_headers - before.abandoned_before_headers,
                "storage_http_abandoned_during_body": after.abandoned_during_body - before.abandoned_during_body,
                "request_to_headers_us": headers_us, "request_to_first_body_us": first_body_us,
                "consumer_done_us": consumer_done_us, "request_to_quiescence_us": settled_us
            }));
            drop(slots);
        }
        Ok(json!({
            "object_bytes": data.len(), "object_sha256": hash, "read_mode": store.read_mode(), "samples": samples,
            "cache_state": "uncontrolled_after_upload", "concurrent_consumers": 1,
            "comparison_or_performance_claim": false,
            "wire_bytes_measured": false, "storage_peer_bytes_measured": false,
            "quiescence_scope": "media_and_storage_client_only",
            "disk_bytes_measured": false, "player_first_frame_measured": false
        }))
    }
    .await;
    let _ = stop_tx.send(());
    match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
        Ok(Ok(Ok(()))) => result,
        Ok(_) => Err("measure_shutdown".into()),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err("measure_shutdown".into())
        }
    }
}
