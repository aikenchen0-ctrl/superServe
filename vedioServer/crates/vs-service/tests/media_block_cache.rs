use std::{ops::Range, sync::atomic::Ordering};

use reqwest::StatusCode;
use vs_storage::{MediaCacheConfig, MediaCachePolicy, ReadMode};

#[path = "../examples/support/cache_fixture.rs"]
mod fixture;
use fixture::{Behavior, Fixture, TOKEN, read_store, wait_until};

async fn block_fixture(behavior: Behavior) -> Fixture {
    Fixture::new_with_policy(
        Some(MediaCacheConfig::default()),
        ReadMode::default(),
        behavior,
        MediaCachePolicy::Block64Kib,
    )
    .await
}

fn read(fixture: &Fixture, range: Range<u64>) -> tokio::task::JoinHandle<std::io::Result<Vec<u8>>> {
    tokio::spawn(read_store(
        fixture.store.clone(),
        fixture.origin.hash.clone(),
        fixture.origin.data.len() as u64,
        range,
    ))
}

#[tokio::test]
async fn neighboring_http_ranges_reuse_one_block_without_exposing_neighboring_bytes_or_skipping_checks()
 {
    let fixture = block_fixture(Behavior::Normal).await;
    for start in [17, 1024, 4097, 16384, 32768] {
        let range = start..start + 8192;
        let response = fixture.request_range(range.clone()).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-length"], "8192");
        assert_eq!(
            response.headers()["content-range"],
            format!(
                "bytes {}-{}/{}",
                range.start,
                range.end - 1,
                fixture.origin.data.len()
            )
        );
        assert_eq!(
            response.headers()["etag"],
            format!("\"{}\"", fixture.origin.hash)
        );
        assert_eq!(response.headers()["cache-control"], "private, max-age=300");
        assert_eq!(response.headers()["vary"], "Authorization");
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            &fixture.origin.data[range]
        );
    }
    assert_eq!(
        *fixture.origin.ranges.lock().unwrap(),
        std::iter::once(0..65536).collect::<Vec<_>>()
    );
    assert_eq!(fixture.origin.heads.load(Ordering::SeqCst), 5);
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.policy, MediaCachePolicy::Block64Kib);
    assert_eq!(metrics.fills_completed, 1);
    assert_eq!(metrics.fill_received_bytes, 65536);
    assert_eq!(metrics.extra_fill_range_bytes, 65536 - 8192);
    assert_eq!(metrics.reused_bytes, 4 * 8192);
    assert_eq!(metrics.requested_body_bytes, 5 * 8192);
    let unauthenticated = fixture
        .client
        .get(fixture.url())
        .header("range", "bytes=1-2")
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(fixture.origin.heads.load(Ordering::SeqCst), 5);
    fixture
        .origin
        .head_length
        .store(fixture.origin.data.len() as u64 + 1, Ordering::SeqCst);
    assert_eq!(
        fixture.request_range(17..8209).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.metrics().await["media_cache"]["policy"],
        "block-64k"
    );
    fixture.close().await;
}

#[tokio::test]
async fn tail_is_clipped_and_cross_block_ranges_keep_exact_keys() {
    let fixture = block_fixture(Behavior::Normal).await;
    let size = fixture.origin.data.len();
    for range in [
        size - 100..size - 50,
        size - 50..size,
        65500..65600,
        65500..65600,
    ] {
        let response = fixture.request_range(range.clone()).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            &fixture.origin.data[range]
        );
    }
    assert_eq!(
        *fixture.origin.ranges.lock().unwrap(),
        vec![1048576..size, 65500..65600]
    );
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.block_lookups, 2);
    assert_eq!(metrics.crossing_block_fallbacks, 2);
    assert_eq!(metrics.fill_received_bytes, 173 + 100);
    assert_eq!(metrics.extra_fill_range_bytes, 173 - 50);
    assert_eq!(metrics.fills_completed, 2);
    fixture.close().await;
}

#[tokio::test]
async fn different_ranges_share_loading_and_cancelled_owner_hands_off_without_wrong_slices() {
    let fixture = block_fixture(Behavior::HeadersGated).await;
    let leader = read(&fixture, 17..8209);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 1).await;
    let follower = read(&fixture, 16384..20480);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 2).await;
    let cancelled_follower = read(&fixture, 32768..36864);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 3).await;
    cancelled_follower.abort();
    assert!(cancelled_follower.await.unwrap_err().is_cancelled());
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 1);
    leader.abort();
    assert!(leader.await.unwrap_err().is_cancelled());
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 2).await;
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
async fn distinct_block_bypasses_to_original_range_when_fill_budget_is_full() {
    let fixture = Fixture::new_with_policy(
        Some(MediaCacheConfig {
            max_fill_concurrency: 1,
            ..Default::default()
        }),
        ReadMode::default(),
        Behavior::HeadersGated,
        MediaCachePolicy::Block64Kib,
    )
    .await;
    let leader = read(&fixture, 17..8209);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 1).await;
    let bypass = read(&fixture, 65561..65686);
    wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 2).await;
    assert_eq!(
        *fixture.origin.ranges.lock().unwrap(),
        vec![0..65536, 65561..65686]
    );
    fixture.origin.gate.close();
    assert_eq!(
        leader.await.unwrap().unwrap(),
        fixture.origin.data[17..8209]
    );
    assert_eq!(
        bypass.await.unwrap().unwrap(),
        fixture.origin.data[65561..65686]
    );
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_started, 1);
    assert_eq!(metrics.bypasses, 1);
    assert_eq!(metrics.active_fills, 0);
    fixture.close().await;
}

#[tokio::test]
async fn incomplete_or_failed_blocks_are_not_published_and_neighbor_retry_is_independent() {
    for behavior in [Behavior::Truncated, Behavior::NotFound] {
        let fixture = block_fixture(behavior).await;
        assert!(read(&fixture, 17..8209).await.unwrap().is_err());
        let metrics = fixture.store.media_cache_metrics().unwrap();
        assert_eq!(metrics.entries, 0);
        assert_eq!(metrics.fills_failed, 1);
        assert_eq!(metrics.active_fills, 0);
        fixture
            .origin
            .behavior
            .store(Behavior::Normal as usize, Ordering::SeqCst);
        assert_eq!(
            read(&fixture, 16384..20480).await.unwrap().unwrap(),
            fixture.origin.data[16384..20480]
        );
        assert_eq!(
            fixture.store.media_cache_metrics().unwrap().fills_completed,
            1
        );
        fixture.close().await;
    }
}

#[tokio::test]
async fn block_budget_and_policy_are_validated_and_streaming_preserves_exact_direct_reads() {
    let fixture = block_fixture(Behavior::Normal).await;
    assert!(
        fixture
            .store
            .clone()
            .with_media_cache_policy(
                MediaCacheConfig {
                    max_entry_bytes: 32768,
                    ..Default::default()
                },
                MediaCachePolicy::Block64Kib,
            )
            .is_err()
    );
    assert_eq!(MediaCachePolicy::default(), MediaCachePolicy::Exact);
    assert_eq!(
        "exact".parse::<MediaCachePolicy>().unwrap(),
        MediaCachePolicy::Exact
    );
    assert_eq!(
        "block-64k".parse::<MediaCachePolicy>().unwrap(),
        MediaCachePolicy::Block64Kib
    );
    for invalid in ["", "block", "block-128k", "BLOCK-64K", "block-64k "] {
        assert!(invalid.parse::<MediaCachePolicy>().is_err());
    }
    fixture.close().await;
    let fixture = Fixture::new_with_policy(
        Some(MediaCacheConfig::default()),
        ReadMode::Streaming,
        Behavior::Normal,
        MediaCachePolicy::Block64Kib,
    )
    .await;
    let response = fixture
        .client
        .get(fixture.url())
        .bearer_auth(TOKEN)
        .header("range", "bytes=17-8208")
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.bytes().await.unwrap().as_ref(),
        &fixture.origin.data[17..8209]
    );
    assert_eq!(
        *fixture.origin.ranges.lock().unwrap(),
        std::iter::once(17..8209).collect::<Vec<_>>()
    );
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().fills_started,
        0
    );
    fixture.close().await;
}

#[tokio::test]
async fn block_entries_remain_weight_bounded_during_eviction() {
    let config = MediaCacheConfig {
        capacity_bytes: 256 * 1024,
        ..Default::default()
    };
    let fixture = Fixture::new_with_policy(
        Some(config),
        ReadMode::default(),
        Behavior::Normal,
        MediaCachePolicy::Block64Kib,
    )
    .await;
    for block in 0..16 {
        let start = block * 65536 + 17;
        assert_eq!(
            read(&fixture, start..start + 1024).await.unwrap().unwrap(),
            fixture.origin.data[start as usize..start as usize + 1024]
        );
        let metrics = fixture.store.media_cache_metrics().unwrap();
        assert!(metrics.resident_weight_bytes <= config.capacity_bytes);
        assert!(metrics.entries <= 4);
        assert_eq!(metrics.active_fills, 0);
    }
    fixture.close().await;
}

#[tokio::test]
async fn unpolled_block_does_not_start_io_and_dropping_http_body_releases_fill_and_permit() {
    let fixture = block_fixture(Behavior::BodyGated).await;
    let unpolled = fixture
        .store
        .published_stream(
            &fixture.origin.hash,
            fixture.origin.data.len() as u64,
            17..8209,
        )
        .await
        .unwrap();
    drop(unpolled);
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture.store.media_cache_metrics().unwrap().block_lookups,
        0
    );
    let response = fixture.request_range(17..8209).await;
    wait_until(|| fixture.store.media_cache_metrics().unwrap().active_fills == 1).await;
    drop(response);
    wait_until(|| fixture.store.media_cache_metrics().unwrap().active_fills == 0).await;
    wait_until(|| fixture.state.media_slots.available_permits() == 32).await;
    let metrics = fixture.store.media_cache_metrics().unwrap();
    assert_eq!(metrics.fills_cancelled, 1);
    assert_eq!(metrics.entries, 0);
    assert_eq!(fixture.store.http_metrics().unwrap().active_exchanges, 0);
    fixture.close().await;
}
