use std::{ops::Range, sync::atomic::Ordering, time::Duration};

use futures_util::StreamExt;
use vs_storage::{MediaCacheConfig, MediaCachePolicy, PublishedStream, ReadMode};

#[path = "../examples/support/cache_fixture.rs"]
mod fixture;
use fixture::{Behavior, Fixture, read_store, wait_until};

async fn setup(behavior: Behavior) -> Fixture {
    Fixture::new_with_policy(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        behavior,
        MediaCachePolicy::Block64KibStream,
    )
    .await
}

async fn source(fixture: &Fixture, range: Range<u64>) -> PublishedStream {
    fixture
        .store
        .published_stream(
            &fixture.origin.hash,
            fixture.origin.data.len() as u64,
            range,
        )
        .await
        .unwrap()
}

async fn next(source: &mut PublishedStream) -> Option<std::io::Result<axum::body::Bytes>> {
    tokio::time::timeout(Duration::from_secs(5), source.next())
        .await
        .expect("流式缓存轮询超时")
}

async fn collect(source: &mut PublishedStream) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    while let Some(part) = next(source).await {
        result.extend_from_slice(&part?);
    }
    Ok(result)
}

fn reader(
    fixture: &Fixture,
    range: Range<u64>,
) -> tokio::task::JoinHandle<std::io::Result<Vec<u8>>> {
    tokio::spawn(read_store(
        fixture.store.clone(),
        fixture.origin.hash.clone(),
        fixture.origin.data.len() as u64,
        range,
    ))
}

#[tokio::test]
async fn cold_prefix_arrives_before_gated_tail_and_followers_only_read_verified_complete_block() {
    let fixture = setup(Behavior::BodyGated).await;
    let mut leader = source(&fixture, 17..8209).await;
    let prefix = next(&mut leader).await.unwrap().unwrap();
    assert!(!prefix.is_empty() && prefix.len() <= 1007);
    assert_eq!(prefix.as_ref(), &fixture.origin.data[17..17 + prefix.len()]);
    let before = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(before.entries, 0);
    assert_eq!(before.active_fills, 1);
    assert!(before.fill_received_bytes < 65536);
    let follower = reader(&fixture, 16384..20480);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 2).await;
    assert!(!follower.is_finished());
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 1);
    fixture.origin.gate.close();
    let mut body = prefix.to_vec();
    body.extend(collect(&mut leader).await.unwrap());
    assert_eq!(body, fixture.origin.data[17..8209]);
    assert_eq!(
        follower.await.unwrap().unwrap(),
        fixture.origin.data[16384..20480]
    );
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_completed, 1);
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(metrics.early_yielded_bytes, 8191);
    assert_eq!(metrics.reused_after_miss, 1);
    assert_eq!(metrics.fill_received_bytes, 65536);
    fixture.close().await;
}

#[tokio::test]
async fn original_buffered_block_remains_pending_until_its_complete_tail() {
    let fixture = Fixture::new_with_policy(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::BodyGated,
        MediaCachePolicy::Block64Kib,
    )
    .await;
    let leader = reader(&fixture, 17..8209);
    wait_until(|| fixture.origin.sent_bytes.load(Ordering::SeqCst) == 1024).await;
    assert!(!leader.is_finished());
    assert_eq!(
        fixture
            .store
            .media_cache_metrics()
            .unwrap()
            .early_yielded_bytes,
        0
    );
    fixture.origin.gate.close();
    assert_eq!(
        leader.await.unwrap().unwrap(),
        fixture.origin.data[17..8209]
    );
    fixture.close().await;
}

#[tokio::test]
async fn cancelled_prefix_owner_releases_source_and_transfers_guard_without_partial_publication() {
    let fixture = setup(Behavior::BodyGated).await;
    let mut leader = source(&fixture, 17..8209).await;
    assert!(next(&mut leader).await.unwrap().is_ok());
    let follower = reader(&fixture, 16384..20480);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 2).await;
    let cancelled = reader(&fixture, 32768..36864);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 3).await;
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_cancelled,
        0
    );
    drop(leader);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 2).await;
    assert_eq!(fixture.store.media_cache_metrics().unwrap().entries, 0);
    fixture.origin.gate.close();
    assert_eq!(
        follower.await.unwrap().unwrap(),
        fixture.origin.data[16384..20480]
    );
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_cancelled, 1);
    assert_eq!(metrics.fills_completed, 1);
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture.close().await;
}

#[tokio::test]
async fn requested_last_byte_waits_for_tail_and_dropping_unpolled_stream_never_reads() {
    let fixture = setup(Behavior::BodyGated).await;
    let unpolled = source(&fixture, 17..8209).await;
    drop(unpolled);
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().block_lookups,
        0
    );
    let mut leader = source(&fixture, 17..8209).await;
    fixture.origin.gate.add_permits(8);
    let mut prefix = Vec::new();
    while prefix.len() < 8191 {
        prefix.extend_from_slice(&next(&mut leader).await.unwrap().unwrap());
    }
    assert_eq!(prefix, fixture.origin.data[17..8208]);
    assert_eq!(fixture.store.media_cache_metrics().unwrap().entries, 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), leader.next())
            .await
            .is_err(),
        "块尾未释放时不得交付最后字节"
    );
    fixture.origin.gate.close();
    assert_eq!(
        next(&mut leader).await.unwrap().unwrap().as_ref(),
        &fixture.origin.data[8208..8209]
    );
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_completed,
        1
    );
    assert_eq!(fixture.store.media_cache_metrics().unwrap().active_fills, 0);
    assert!(next(&mut leader).await.is_none());
    fixture.close().await;
}

#[tokio::test]
async fn slow_consumer_stops_fill_polling_and_cancellation_drops_all_fill_resources() {
    let fixture = setup(Behavior::BodyGated).await;
    let mut leader = source(&fixture, 17..8209).await;
    assert!(next(&mut leader).await.unwrap().is_ok());
    let received = fixture
        .store
        .media_cache_metrics()
        .unwrap()
        .fill_received_bytes;
    fixture.origin.gate.add_permits(2);
    wait_until(|| fixture.origin.sent_bytes.load(Ordering::SeqCst) == 3072).await;
    assert_eq!(
        fixture
            .store
            .media_cache_metrics()
            .unwrap()
            .fill_received_bytes,
        received
    );
    assert_eq!(fixture.store.media_cache_metrics().unwrap().active_fills, 1);
    drop(leader);
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(metrics.entries, 0);
    assert_eq!(metrics.fills_cancelled, 1);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture.close().await;
}

#[tokio::test]
async fn late_failure_can_forward_prefix_but_never_a_complete_response_or_cache_entry() {
    let fixture = setup(Behavior::Truncated).await;
    let mut leader = source(&fixture, 17..8209).await;
    let mut body = Vec::new();
    while let Ok(part) = next(&mut leader).await.expect("截断源不得正常结束") {
        body.extend_from_slice(&part);
    }
    assert_eq!(body, fixture.origin.data[17..8208]);
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.entries, 0);
    assert_eq!(metrics.fills_failed, 1);
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture
        .origin
        .behavior
        .store(Behavior::Normal as usize, Ordering::SeqCst);
    assert_eq!(
        reader(&fixture, 16384..20480).await.unwrap().unwrap(),
        fixture.origin.data[16384..20480]
    );
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_completed,
        1
    );
    fixture.close().await;
}

#[tokio::test]
async fn byte_tail_cross_block_and_whole_block_ranges_are_exact_and_warm_reads_skip_body_io() {
    let fixture = setup(Behavior::Normal).await;
    let size = fixture.origin.data.len();
    for range in [
        17..18,
        0..65536,
        32779..36864,
        65535..65538,
        65535..65538,
        size - 100..size - 50,
        size - 50..size,
    ] {
        assert_eq!(
            reader(&fixture, range.start as u64..range.end as u64)
                .await
                .unwrap()
                .unwrap(),
            fixture.origin.data[range]
        );
    }
    assert_eq!(
        *fixture.origin.ranges.lock().unwrap(),
        vec![0..65536, 65535..65538, 1048576..size]
    );
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_completed, 3);
    assert_eq!(metrics.fills_failed, 0);
    assert_eq!(metrics.hits, 4);
    assert_eq!(metrics.crossing_block_fallbacks, 2);
    assert_eq!(metrics.active_fills, 0);
    fixture.close().await;
}

#[tokio::test]
async fn full_fill_budget_uses_original_range_and_initial_failure_is_retriable() {
    let fixture = Fixture::new_with_policy(
        Some(MediaCacheConfig {
            max_fill_concurrency: 1,
            ..Default::default()
        }),
        ReadMode::default(),
        Behavior::BodyGated,
        MediaCachePolicy::Block64KibStream,
    )
    .await;
    let mut leader = source(&fixture, 17..8209).await;
    assert!(next(&mut leader).await.unwrap().is_ok());
    assert_eq!(
        reader(&fixture, 65561..65686).await.unwrap().unwrap(),
        fixture.origin.data[65561..65686]
    );
    assert_eq!(
        *fixture.origin.ranges.lock().unwrap(),
        vec![0..65536, 65561..65686]
    );
    assert_eq!(fixture.store.media_cache_metrics().unwrap().bypasses, 1);
    drop(leader);
    assert_eq!(fixture.store.media_cache_metrics().unwrap().active_fills, 0);
    fixture.close().await;
    let fixture = setup(Behavior::NotFound).await;
    assert!(reader(&fixture, 17..8209).await.unwrap().is_err());
    assert_eq!(fixture.store.media_cache_metrics().unwrap().fills_failed, 1);
    assert_eq!(fixture.store.media_cache_metrics().unwrap().active_fills, 0);
    assert_eq!(fixture.store.media_cache_metrics().unwrap().entries, 0);
    fixture.close().await;
}

#[tokio::test]
async fn http_prefix_cancellation_returns_media_permit_and_warm_cache_keeps_auth_and_metadata_checks()
 {
    let fixture = setup(Behavior::BodyGated).await;
    let mut response = fixture.request_range(17..8209).await;
    assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-length"], "8192");
    assert_eq!(
        response.headers()["content-range"],
        format!("bytes 17-8208/{}", fixture.origin.data.len())
    );
    let prefix = response.chunk().await.unwrap().unwrap();
    assert_eq!(prefix.as_ref(), &fixture.origin.data[17..17 + prefix.len()]);
    assert!(
        fixture
            .store
            .media_cache_metrics()
            .unwrap()
            .fill_received_bytes
            < 65536
    );
    drop(response);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().active_fills == 0).await;
    wait_until(|| fixture.state.media_slots.available_permits() == 32).await;
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_cancelled,
        1
    );
    fixture
        .origin
        .behavior
        .store(Behavior::Normal as usize, Ordering::SeqCst);
    fixture.origin.gate.close();
    for _ in 0..2 {
        assert_eq!(
            fixture
                .request_range(17..8209)
                .await
                .bytes()
                .await
                .unwrap()
                .as_ref(),
            &fixture.origin.data[17..8209]
        );
    }
    let gets = fixture.origin.gets.load(Ordering::SeqCst);
    let unauthenticated = fixture.client.get(fixture.url()).send().await.unwrap();
    assert_eq!(unauthenticated.status(), reqwest::StatusCode::UNAUTHORIZED);
    fixture.origin.head_length.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        fixture.request_range(17..8209).await.status(),
        reqwest::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), gets);
    fixture.close().await;
}

#[tokio::test]
async fn explicit_direct_streaming_mode_takes_precedence_over_progressive_cache_policy() {
    let fixture = Fixture::new_with_policy(
        Some(MediaCacheConfig::default()),
        ReadMode::Streaming,
        Behavior::BodyGated,
        MediaCachePolicy::Block64KibStream,
    )
    .await;
    let mut leader = source(&fixture, 17..8209).await;
    assert!(next(&mut leader).await.unwrap().is_ok());
    assert_eq!(
        *fixture.origin.ranges.lock().unwrap(),
        std::iter::once(17..8209).collect::<Vec<_>>()
    );
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_started,
        0
    );
    assert_eq!(fixture.store.media_cache_metrics().unwrap().bypasses, 1);
    drop(leader);
    fixture.close().await;
}

#[tokio::test]
async fn truncated_http_block_cannot_look_successful_after_requested_prefix_was_sent() {
    let fixture = setup(Behavior::Truncated).await;
    let response = fixture.request_range(17..8209).await;
    assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
    assert!(response.bytes().await.is_err());
    wait_until(|| fixture.state.media_slots.available_permits() == 32).await;
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_failed, 1);
    assert_eq!(metrics.entries, 0);
    assert_eq!(metrics.active_fills, 0);
    fixture.close().await;
}

#[tokio::test]
async fn one_byte_response_requires_validated_tail_and_streaming_entries_stay_weight_bounded() {
    let fixture = Fixture::new_with_policy(
        Some(MediaCacheConfig {
            capacity_bytes: 256 * 1024,
            ..Default::default()
        }),
        ReadMode::default(),
        Behavior::BodyGated,
        MediaCachePolicy::Block64KibStream,
    )
    .await;
    let leader = reader(&fixture, 17..18);
    wait_until(|| fixture.origin.sent_bytes.load(Ordering::SeqCst) == 1024).await;
    assert!(!leader.is_finished());
    assert_eq!(
        fixture
            .store
            .media_cache_metrics()
            .unwrap()
            .early_yielded_bytes,
        0
    );
    fixture.origin.gate.close();
    assert_eq!(leader.await.unwrap().unwrap(), fixture.origin.data[17..18]);
    for block in 1..16 {
        let start = block * 65536 + 17;
        assert_eq!(
            reader(&fixture, start..start + 1024)
                .await
                .unwrap()
                .unwrap(),
            fixture.origin.data[start as usize..start as usize + 1024]
        );
        let metrics = fixture.store.media_cache_metrics().unwrap();
        assert!(metrics.resident_weight_bytes <= 256 * 1024);
        assert!(metrics.entries <= 4);
        assert_eq!(metrics.active_fills, 0);
    }
    assert_eq!(
        "block-64k-stream".parse::<MediaCachePolicy>().unwrap(),
        MediaCachePolicy::Block64KibStream
    );
    assert!(
        fixture
            .store
            .clone()
            .with_media_cache_policy(
                MediaCacheConfig {
                    max_entry_bytes: 32768,
                    ..Default::default()
                },
                MediaCachePolicy::Block64KibStream,
            )
            .is_err()
    );
    fixture.close().await;
}
