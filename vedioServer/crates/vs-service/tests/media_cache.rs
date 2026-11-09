use std::sync::atomic::Ordering;

use futures_util::StreamExt;
use reqwest::StatusCode;
use vs_storage::{MediaCacheConfig, ReadMode};

#[path = "../examples/support/cache_fixture.rs"]
mod fixture;
use fixture::{Behavior, Fixture, TOKEN, read_store, wait_until};

fn start_read(
    fixture: &Fixture,
    range: std::ops::Range<u64>,
) -> tokio::task::JoinHandle<std::io::Result<Vec<u8>>> {
    tokio::spawn(read_store(
        fixture.store.clone(),
        fixture.origin.hash.clone(),
        fixture.origin.data.len() as u64,
        range,
    ))
}

#[tokio::test]
async fn warm_http_ranges_avoid_body_reads_without_bypassing_authority_or_length_checks() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::Normal,
    )
    .await;
    let range = 17..4097;
    for _ in 0..2 {
        let response = fixture.request_range(range.clone()).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["cache-control"], "private, max-age=300");
        assert_eq!(response.headers()["vary"], "Authorization");
        assert_eq!(
            response.headers()["content-range"],
            format!("bytes 17-4096/{}", fixture.origin.data.len())
        );
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            &fixture.origin.data[range.clone()]
        );
    }
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.origin.heads.load(Ordering::SeqCst), 2);
    wait_until(|| fixture.state.media_slots.available_permits() == 32).await;
    let metrics = fixture.metrics().await;
    assert_eq!(metrics["media_cache"]["hits"], 1);
    assert_eq!(metrics["storage_http"]["response_body_bytes"], range.len());
    let unauthorized = fixture
        .client
        .get(fixture.url())
        .header("range", "bytes=17-4096")
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(fixture.store.media_cache_metrics().unwrap().hits, 1);
    fixture.origin.head_length.fetch_sub(1, Ordering::SeqCst);
    let changed = fixture.request_range(range).await;
    assert_eq!(changed.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(fixture.store.media_cache_metrics().unwrap().hits, 1);
    fixture.close().await;
}

#[tokio::test]
async fn validators_ranges_and_read_modes_keep_existing_http_semantics() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::Normal,
    )
    .await;
    for range in [65_531..65_542, 17..81, 18..82, 700_000..780_003] {
        let response = fixture.request_range(range.clone()).await;
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            &fixture.origin.data[range.clone()]
        );
    }
    let gets = fixture.origin.gets.load(Ordering::SeqCst);
    let head = fixture
        .client
        .head(fixture.url())
        .bearer_auth(TOKEN)
        .header("range", "bytes=17-80")
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(
        head.headers()["content-length"],
        fixture.origin.data.len().to_string()
    );
    let not_modified = fixture
        .client
        .get(fixture.url())
        .bearer_auth(TOKEN)
        .header("if-none-match", format!("W/\"{}\"", fixture.origin.hash))
        .send()
        .await
        .unwrap();
    assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);
    let invalid = fixture
        .client
        .get(fixture.url())
        .bearer_auth(TOKEN)
        .header("range", "bytes=9999999-")
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), gets);
    assert_eq!(fixture.store.media_cache_metrics().unwrap().bypasses, 1);
    let requested = fixture.origin.ranges.lock().unwrap().clone();
    assert_eq!(&requested[..3], &[65_531..65_542, 17..81, 18..82]);
    assert_eq!(requested[3].start, 700_000);
    assert_eq!(requested.last().unwrap().end, 780_003);
    fixture.close().await;
}

#[tokio::test]
async fn concurrent_misses_share_one_read_and_cancelled_waiter_keeps_owner_running() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::HeadersGated,
    )
    .await;
    let leader = start_read(&fixture, 100..8292);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 1).await;
    let mut followers: Vec<_> = (0..8).map(|_| start_read(&fixture, 100..8292)).collect();
    wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 9).await;
    let cancelled = followers.pop().unwrap();
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert_eq!(fixture.store.media_cache_metrics().unwrap().active_fills, 1);
    fixture.origin.gate.close();
    for handle in std::iter::once(leader).chain(followers) {
        assert_eq!(
            handle.await.unwrap().unwrap(),
            fixture.origin.data[100..8292]
        );
    }
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 1);
    assert_eq!(metrics.fills_started, 1);
    assert_eq!(metrics.fills_completed, 1);
    assert_eq!(metrics.fills_cancelled, 0);
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(metrics.reused_after_miss, 7);
    fixture.close().await;
}

#[tokio::test]
async fn cancelled_owner_releases_read_and_transfers_loading_to_a_waiter() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::HeadersGated,
    )
    .await;
    let leader = start_read(&fixture, 0..8192);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 1).await;
    let follower = start_read(&fixture, 0..8192);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 2).await;
    leader.abort();
    assert!(leader.await.unwrap_err().is_cancelled());
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 2).await;
    assert_eq!(fixture.store.media_cache_metrics().unwrap().active_fills, 1);
    fixture.origin.gate.close();
    assert_eq!(
        follower.await.unwrap().unwrap(),
        fixture.origin.data[..8192]
    );
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_started, 2);
    assert_eq!(metrics.fills_completed, 1);
    assert_eq!(metrics.fills_cancelled, 1);
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture.close().await;
}

#[tokio::test]
async fn fill_budget_bypasses_other_ranges_without_starting_extra_cache_buffers() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig {
            max_fill_concurrency: 1,
            ..Default::default()
        }),
        ReadMode::default(),
        Behavior::HeadersGated,
    )
    .await;
    let first = start_read(&fixture, 0..8192);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 1).await;
    let second = start_read(&fixture, 8192..16384);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 2).await;
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_started, 1);
    assert_eq!(metrics.active_fills, 1);
    assert_eq!(metrics.bypasses, 1);
    fixture.origin.gate.close();
    assert_eq!(first.await.unwrap().unwrap(), fixture.origin.data[..8192]);
    assert_eq!(
        second.await.unwrap().unwrap(),
        fixture.origin.data[8192..16384]
    );
    assert_eq!(fixture.store.media_cache_metrics().unwrap().active_fills, 0);
    fixture.close().await;
}

#[tokio::test]
async fn lazy_body_cancellation_does_not_prefetch_or_publish_partial_bytes() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::BodyGated,
    )
    .await;
    let unpolled = fixture
        .store
        .published_stream(
            &fixture.origin.hash,
            fixture.origin.data.len() as u64,
            0..8192,
        )
        .await
        .unwrap();
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 0);
    drop(unpolled);
    let partial = start_read(&fixture, 0..8192);
    wait_until(|| fixture.origin.sent_bytes.load(Ordering::SeqCst) >= 1024).await;
    partial.abort();
    assert!(partial.await.unwrap_err().is_cancelled());
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.entries, 0);
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(metrics.fills_cancelled, 1);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture
        .origin
        .behavior
        .store(Behavior::Normal as usize, Ordering::SeqCst);
    fixture.origin.gate.close();
    let retry = start_read(&fixture, 0..8192).await.unwrap().unwrap();
    assert_eq!(retry, fixture.origin.data[..8192]);
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_completed,
        1
    );
    fixture.close().await;
}

#[tokio::test]
async fn failed_origin_is_not_cached_and_later_retry_can_fill() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::NotFound,
    )
    .await;
    assert!(start_read(&fixture, 0..8192).await.unwrap().is_err());
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.entries, 0);
    assert_eq!(metrics.fills_failed, 1);
    assert_eq!(metrics.active_fills, 0);
    fixture
        .origin
        .behavior
        .store(Behavior::Normal as usize, Ordering::SeqCst);
    assert_eq!(
        start_read(&fixture, 0..8192).await.unwrap().unwrap(),
        fixture.origin.data[..8192]
    );
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_completed,
        1
    );
    fixture.close().await;
}

#[tokio::test]
async fn truncated_origin_never_publishes_a_complete_entry() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::Truncated,
    )
    .await;
    assert!(start_read(&fixture, 0..8192).await.unwrap().is_err());
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.entries, 0);
    assert_eq!(metrics.fills_failed, 1);
    assert_eq!(metrics.active_fills, 0);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture.close().await;
}

#[tokio::test]
async fn dropping_http_body_cancels_cache_fill_and_returns_media_permit() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        Behavior::BodyGated,
    )
    .await;
    let response = fixture.request_range(0..8192).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    wait_until(|| fixture.origin.sent_bytes.load(Ordering::SeqCst) >= 1024).await;
    drop(response);
    wait_until(|| {
        fixture.store.media_cache_metrics().unwrap().active_fills == 0
            && fixture.state.media_slots.available_permits() == 32
    })
    .await;
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_cancelled, 1);
    assert_eq!(metrics.entries, 0);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture.close().await;
}

#[tokio::test]
async fn streaming_mode_retains_early_bytes_and_cancellation_even_with_cache_enabled() {
    let fixture = Fixture::new(
        Some(MediaCacheConfig::default()),
        ReadMode::Streaming,
        Behavior::BodyGated,
    )
    .await;
    let mut source = fixture
        .store
        .published_stream(
            &fixture.origin.hash,
            fixture.origin.data.len() as u64,
            0..8192,
        )
        .await
        .unwrap();
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), source.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!first.is_empty() && first.len() <= 1024);
    assert_eq!(first.as_ref(), &fixture.origin.data[..first.len()]);
    drop(source);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.bypasses, 1);
    assert_eq!(metrics.fills_started, 0);
    fixture.close().await;
}

#[tokio::test]
async fn scan_weight_is_bounded_and_independent_stores_do_not_share_entries() {
    let config = MediaCacheConfig {
        capacity_bytes: 16 * 1024,
        max_entry_bytes: 4096,
        max_fill_concurrency: 1,
    };
    let first = Fixture::new(Some(config), ReadMode::default(), Behavior::Normal).await;
    let second = Fixture::new(Some(config), ReadMode::default(), Behavior::Normal).await;
    for fixture in [&first, &second] {
        assert_eq!(
            start_read(fixture, 0..4096).await.unwrap().unwrap(),
            fixture.origin.data[..4096]
        );
        assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 1);
    }
    for index in 1..80 {
        let range = index * 4096..(index + 1) * 4096;
        let expected = first.origin.data[range.clone()].to_vec();
        assert_eq!(
            start_read(&first, range.start as u64..range.end as u64)
                .await
                .unwrap()
                .unwrap(),
            expected
        );
        let metrics = first.store.media_cache_metrics().unwrap();
        assert!(metrics.resident_weight_bytes <= config.capacity_bytes);
        assert!(metrics.entries <= config.capacity_bytes as usize / 4096);
    }
    assert_eq!(second.origin.gets.load(Ordering::SeqCst), 1);
    first.close().await;
    second.close().await;
}

#[test]
fn cache_limits_reject_unbounded_or_incoherent_configuration() {
    assert!(MediaCacheConfig::default().validate().is_ok());
    for config in [
        MediaCacheConfig {
            capacity_bytes: 0,
            ..Default::default()
        },
        MediaCacheConfig {
            capacity_bytes: 16_385,
            ..Default::default()
        },
        MediaCacheConfig {
            max_entry_bytes: 0,
            ..Default::default()
        },
        MediaCacheConfig {
            max_entry_bytes: 2 * 1024 * 1024,
            ..Default::default()
        },
        MediaCacheConfig {
            max_fill_concurrency: 0,
            ..Default::default()
        },
        MediaCacheConfig {
            max_fill_concurrency: 65,
            ..Default::default()
        },
    ] {
        assert!(config.validate().is_err());
    }
}
