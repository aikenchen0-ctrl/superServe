use std::{ops::Range, time::Duration};

use opendal::Operator;
use reqwest::{Client, Response, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::{Check, delete_check, ensure, storage_error};

#[derive(Clone, Copy, Debug)]
pub(super) enum Action {
    Full,
    DropAfterHeaders,
    CancelAfter(Duration),
}

pub(super) fn client() -> Check<Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "direct_client_build".into())
}

pub(super) async fn request(
    client: &Client,
    operator: &Operator,
    key: &str,
    range: Range<usize>,
    data: &[u8],
    action: Action,
) -> Check<Value> {
    // 签名只用于本次回环请求，不写入收据、错误或日志。
    let signed = operator
        .presign_read(key, Duration::from_secs(60))
        .await
        .map_err(storage_error)?;
    let builder = client
        .get(signed.uri().to_string())
        .headers(signed.header().clone())
        .header("range", format!("bytes={}-{}", range.start, range.end - 1));
    exchange(builder, range, data, action).await
}

async fn exchange(
    builder: reqwest::RequestBuilder,
    range: Range<usize>,
    data: &[u8],
    action: Action,
) -> Check<Value> {
    ensure(
        range.start < range.end && range.end <= data.len(),
        "direct_invalid_range",
    )?;
    let started = Instant::now();
    let mut pending = Box::pin(builder.send());
    let response = match action {
        Action::CancelAfter(delay) => {
            // 先轮询请求；截止时丢弃 Future，不等待响应头、不排空正文。
            tokio::select! {
                biased;
                response = &mut pending => Some(response),
                _ = tokio::time::sleep(delay) => None,
            }
        }
        _ => Some((&mut pending).await),
    };
    drop(pending);
    let Some(response) = response else {
        return Ok(json!({
            "stage": "cancelled_before_headers",
            "response_body_polled_bytes": 0,
            "elapsed_us": started.elapsed().as_micros(),
            "remote_receipt_proven": false
        }));
    };
    // reqwest 错误可能含签名 URL，只保留本地错误代码。
    let response = response.map_err(|_| "direct_http_error")?;
    validate_headers(&response, &range, data.len())?;
    let headers_us = started.elapsed().as_micros();
    let mut bytes = 0;
    let stage = match action {
        Action::Full => {
            bytes = consume_exact(response, &range, data).await?;
            "full"
        }
        Action::DropAfterHeaders => {
            drop(response);
            "dropped_after_headers"
        }
        Action::CancelAfter(_) => {
            drop(response);
            // 已收到响应头的案例不能冒充响应头前取消成功。
            "headers_won_deadline"
        }
    };
    Ok(json!({
        "stage": stage, "response_body_polled_bytes": bytes,
        "headers_us": headers_us, "elapsed_us": started.elapsed().as_micros(),
        "remote_receipt_proven": true
    }))
}

fn validate_headers(response: &Response, range: &Range<usize>, size: usize) -> Check<()> {
    ensure(
        response.status() == StatusCode::PARTIAL_CONTENT,
        "direct_range_status",
    )?;
    ensure(
        response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            == Some(format!("bytes {}-{}/{size}", range.start, range.end - 1).as_str()),
        "direct_content_range",
    )?;
    ensure(
        response.content_length() == Some((range.end - range.start) as u64),
        "direct_content_length",
    )
}

async fn consume_exact(mut response: Response, range: &Range<usize>, data: &[u8]) -> Check<usize> {
    let mut offset = range.start;
    while let Some(chunk) = response.chunk().await.map_err(|_| "direct_body_error")? {
        let end = offset
            .checked_add(chunk.len())
            .ok_or("direct_length_overflow")?;
        ensure(end <= range.end, "direct_body_too_long")?;
        ensure(chunk.as_ref() == &data[offset..end], "direct_body_mismatch")?;
        offset = end;
    }
    ensure(offset == range.end, "direct_body_too_short")?;
    Ok(offset - range.start)
}

pub async fn run(operators: &[Operator], seed: &str, bucket: &str) -> Check<()> {
    let client = client()?;
    let mut checks = Vec::new();
    let mut owned = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(300), async {
        for subsequent in [false, true] {
            for length in [65_536, 1_048_576] {
                for action in [
                    Action::Full,
                    Action::DropAfterHeaders,
                    Action::CancelAfter(Duration::ZERO),
                    Action::CancelAfter(Duration::from_millis(1)),
                    Action::CancelAfter(Duration::from_millis(4)),
                ] {
                    let mut data = vec![0; 3_145_801];
                    for (offset, chunk) in data.chunks_mut(32).enumerate() {
                        let hash = Sha256::digest(
                            format!("{seed}:direct:{subsequent}:{length}:{action:?}:{offset}")
                                .as_bytes(),
                        );
                        chunk.copy_from_slice(&hash[..chunk.len()]);
                    }
                    let hash = format!("{:x}", Sha256::digest(&data));
                    let key = format!("media/{hash}");
                    // 在 PUT 前登记，确保超时或部分成功的对象仍能按已知键回收。
                    owned.push(hash.clone());
                    operators[0].write_with(&key, data.clone())
                        .if_not_exists(true).await.map_err(storage_error)?;
                    let prefix = if subsequent {
                        Some(request(&client, &operators[0], &key, 0..4096, &data, Action::Full).await)
                    } else {
                        None
                    };
                    let offset = if subsequent { 4096 } else { 0 };
                    let read = if prefix.as_ref().is_some_and(Result::is_err) {
                        Err("direct_prefix_failed".to_string())
                    } else {
                        request(&client, &operators[0], &key, offset..offset + length, &data, action).await
                    };
                    let deletion = delete_check::delete_and_check(operators, &hash).await;
                    checks.push(json!({
                        "object_sha256": hash, "subsequent_get": subsequent,
                        "range_start": offset, "range_length": length,
                        "action": format!("{action:?}"), "prefix": prefix.as_ref().and_then(|r| r.as_ref().ok()),
                        "prefix_error": prefix.as_ref().and_then(|r| r.as_ref().err()),
                        "read": read.as_ref().ok(), "read_error": read.as_ref().err(),
                        "immediate_delete": deletion
                    }));
                }
            }
        }
        ensure(checks.len() == 20, "direct_case_count")?;
        ensure(checks.iter().all(|c| c["read_error"].is_null()), "direct_read_failed")?;
        // 两种读取位置均须实际命中取消窗口，避免全是已完成请求的假阳性。
        for subsequent in [false, true] {
            for length in [65_536, 1_048_576] {
                ensure(checks.iter().any(|c| {
                    c["subsequent_get"] == subsequent && c["range_length"] == length
                        && c["read"]["stage"] == "cancelled_before_headers"
                }), "direct_cancellation_window_not_covered")?;
            }
        }
        ensure(checks.iter().all(|c| c["immediate_delete"]["passed"] == true),
            "direct_delete_failed")
    }).await.map_err(|_| "direct_probe_timeout".to_string()).and_then(|r| r);
    let mut cleanup = Vec::new();
    for hash in &owned {
        if checks
            .iter()
            .any(|c| c["object_sha256"] == *hash && c["immediate_delete"]["passed"] == true)
        {
            continue;
        }
        cleanup.push(delete_check::delete_and_check(operators, hash).await);
    }
    let cleaned = delete_check::outcome(&cleanup);
    println!(
        "{}",
        json!({
            "schema": "storage-direct-cancel-v1", "seed": seed, "bucket": bucket,
            "passed": result.is_ok() && cleaned.is_ok(), "error": result.as_ref().err(),
            "checks": checks, "expected_cases": 20, "owned_object_sha256": owned,
            "cleanup": cleanup, "cleanup_passed": cleaned.is_ok(),
            "read_path": "reqwest_presigned_s3_no_media_no_opendal_reader",
            "cancellation_scope": "client_before_headers_not_remote_lock_stage",
            "production_performance_claim": false
        })
    );
    result?;
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, extract::State, http::Response as HttpResponse, routing::get};
    use std::sync::Arc;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct StateData {
        arrived: Arc<Notify>,
        release: Arc<Notify>,
    }

    async fn delayed(State(state): State<StateData>) -> HttpResponse<Body> {
        state.arrived.notify_one();
        state.release.notified().await;
        HttpResponse::builder()
            .status(206)
            .header("content-length", "4")
            .header("content-range", "bytes 0-3/4")
            .body(Body::from(vec![1, 2, 3, 4]))
            .unwrap()
    }

    async fn fixture() -> (String, StateData, tokio::task::JoinHandle<()>) {
        let state = StateData {
            arrived: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/", get(delayed))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (endpoint, state, server)
    }

    #[tokio::test]
    async fn cancelled_direct_request_is_not_counted_as_completed() {
        let (endpoint, state, server) = fixture().await;
        let read = tokio::spawn(async move {
            exchange(
                client().unwrap().get(endpoint),
                0..4,
                &[1, 2, 3, 4],
                Action::CancelAfter(Duration::from_millis(250)),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), state.arrived.notified())
            .await
            .unwrap();
        let receipt = read.await.unwrap().unwrap();
        assert_eq!(receipt["stage"], "cancelled_before_headers");
        assert_eq!(receipt["remote_receipt_proven"], false);
        assert_eq!(receipt["response_body_polled_bytes"], 0);
        state.release.notify_one();
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn headers_winning_deadline_are_reported_without_consuming_body() {
        let (endpoint, state, server) = fixture().await;
        state.release.notify_one();
        let receipt = exchange(
            client().unwrap().get(endpoint),
            0..4,
            &[1, 2, 3, 4],
            Action::CancelAfter(Duration::from_secs(2)),
        )
        .await
        .unwrap();
        assert_eq!(receipt["stage"], "headers_won_deadline");
        assert_eq!(receipt["response_body_polled_bytes"], 0);
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn full_read_checks_body_integrity() {
        let (endpoint, state, server) = fixture().await;
        state.release.notify_one();
        let error = exchange(
            client().unwrap().get(endpoint),
            0..4,
            &[1, 2, 3, 5],
            Action::Full,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "direct_body_mismatch");
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }
}
