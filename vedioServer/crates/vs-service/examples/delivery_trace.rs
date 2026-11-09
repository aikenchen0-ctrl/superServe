use std::{
    env, io,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use reqwest::Client;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{
    playback::{PlaybackActivity, PlaybackPolicy},
    playback_adapter::{BufferedRange, Completion, PlayerAdapter, PlayerSnapshot, TransferOutcome},
};
use vs_service::{
    AppState, Role,
    hls::{HlsPublication, publish_hls},
    playback_policy::PlaybackPolicyResponse,
    publication::load_catalog_release,
    router,
};
use vs_storage::MediaStore;

#[derive(Serialize)]
struct Transfer {
    action: &'static str,
    asset_sha256: String,
    expected_object_bytes: u64,
    application_received_bytes: u64,
    response_status: u16,
    headers_us: u64,
    first_body_us: Option<u64>,
    duration_us: u64,
    cancel_requested_after_first_chunk: bool,
    complete_hash_verified: bool,
}

async fn get(
    client: &Client,
    base: &str,
    token: &str,
    hash: &str,
    expected: u64,
    action: &'static str,
    cancel: bool,
) -> Result<Transfer, Box<dyn std::error::Error>> {
    let started = Instant::now();
    let mut response = client
        .get(format!("{base}/v1/media/{hash}"))
        .bearer_auth(token)
        .header(
            "cmcd-session",
            r#"sid="delivery-trace-session",cid="clip",vs-rid="window-feed",v=1"#,
        )
        .header(
            "cmcd-request",
            if action == "initialization" {
                "bl=0,su"
            } else {
                "bl=1000,mtp=8000"
            },
        )
        .send()
        .await?
        .error_for_status()?;
    let status = response.status().as_u16();
    let headers_us = started.elapsed().as_micros() as u64;
    let mut hash_state = Sha256::new();
    let mut bytes = 0_u64;
    let mut first_body_us = None;
    while let Some(chunk) = response.chunk().await? {
        if first_body_us.is_none() {
            first_body_us = Some(started.elapsed().as_micros() as u64);
        }
        bytes += chunk.len() as u64;
        hash_state.update(&chunk);
        if cancel {
            break;
        }
    }
    drop(response);
    let verified = bytes == expected && format!("{:x}", hash_state.finalize()) == hash;
    if !cancel && !verified {
        return Err(io::Error::other("完整读取的长度或散列不符").into());
    }
    Ok(Transfer {
        action,
        asset_sha256: hash.into(),
        expected_object_bytes: expected,
        application_received_bytes: bytes,
        response_status: status,
        headers_us,
        first_body_us,
        duration_us: started.elapsed().as_micros() as u64,
        cancel_requested_after_first_chunk: cancel,
        complete_hash_verified: verified,
    })
}

async fn snapshot(client: &Client, base: &str, token: &str) -> Result<Value, reqwest::Error> {
    client
        .get(format!("{base}/v1/metrics"))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

async fn controlled_window(
    client: &Client,
    base: &str,
    token: &str,
    publication: &HlsPublication,
    catalog: &vs_core::catalog::PublicCatalog,
    transfers: &mut Vec<Transfer>,
) -> Result<Value, Box<dyn std::error::Error>> {
    let policy: PlaybackPolicyResponse = client
        .get(format!("{base}/v1/playback/policy"))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    policy
        .verify(&publication.catalog.release.catalog_sha256)
        .map_err(io::Error::other)?;
    let mut adapter = PlayerAdapter::new(policy.policy)?;
    let start = transfers.len();
    let mut fetches = 0;
    let mut positions = vec![0_usize; publication.tracks.len()];
    let mut ends_ms = vec![0_u64; publication.tracks.len()];
    let mut buffer_bytes = 0_u64;
    let mut decisions = Vec::new();
    let size = |hash: &str| {
        catalog
            .assets
            .iter()
            .find(|asset| asset.sha256 == hash)
            .map(|asset| asset.bytes)
            .ok_or_else(|| io::Error::other("控制器引用资产缺失"))
    };
    for hash in std::iter::once(&publication.master_sha256).chain(
        publication
            .tracks
            .iter()
            .flat_map(|track| [&track.playlist_sha256, &track.init_sha256]),
    ) {
        transfers.push(
            get(
                client,
                base,
                token,
                hash,
                size(hash)?,
                "controlled-metadata",
                false,
            )
            .await?,
        );
    }
    let next_bytes = |positions: &[usize]| -> Option<u64> {
        let bytes: u64 = publication
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(index, track)| track.segments.get(positions[index]))
            .map(|segment| segment.bytes)
            .sum();
        (bytes != 0).then_some(bytes)
    };
    let model_snapshot = |sequence, ends_ms: &[u64], buffered_bytes, done| PlayerSnapshot {
        generation: 1,
        sequence,
        monotonic_ms: sequence,
        position_ms: 0,
        tracks: ends_ms
            .iter()
            .map(|end| {
                if *end == 0 {
                    Vec::new()
                } else {
                    vec![BufferedRange {
                        start_ms: 0,
                        end_ms: *end,
                    }]
                }
            })
            .collect(),
        buffered_bytes,
        activity: PlaybackActivity::Active,
        playback_rate_milli: 1000,
        rebuffering: false,
        end_of_stream: done,
    };
    let mut sequence = 1_u64;
    let initial = model_snapshot(
        sequence,
        &ends_ms,
        buffer_bytes,
        next_bytes(&positions).is_none(),
    );
    let mut update = adapter.update(&initial, next_bytes(&positions))?;
    for _ in 0..1025 {
        decisions.push(json!({"adapter":update}));
        let Some(ticket) = update.request else {
            sequence += 1;
            let mut hidden = model_snapshot(
                sequence,
                &ends_ms,
                buffer_bytes,
                next_bytes(&positions).is_none(),
            );
            hidden.activity = PlaybackActivity::Hidden;
            decisions.push(json!({"adapter":adapter.update(&hidden, next_bytes(&positions))?}));
            break;
        };
        let before = buffer_bytes;
        for (index, track) in publication.tracks.iter().enumerate() {
            if let Some(segment) = track.segments.get(positions[index]) {
                transfers.push(
                    get(
                        client,
                        base,
                        token,
                        &segment.sha256,
                        segment.bytes,
                        "controlled-window",
                        false,
                    )
                    .await?,
                );
                buffer_bytes += segment.bytes;
                ends_ms[index] = (segment.start_ticks + segment.duration_ticks) * 1000
                    / u64::from(track.timescale);
                positions[index] += 1;
                fetches += 1;
            }
        }
        if adapter.transfer_finished(ticket, buffer_bytes - before, TransferOutcome::Complete)
            != Completion::ReadyForAppend
        {
            return Err(io::Error::other("已验证媒体未通过下载票据检查").into());
        }
        sequence += 1;
        let appended = model_snapshot(
            sequence,
            &ends_ms,
            buffer_bytes,
            next_bytes(&positions).is_none(),
        );
        // 此探针显式模拟播放器追加；只有原生播放器回调才能提供真实追加/渲染证据。
        update = adapter.appended(ticket, &appended, next_bytes(&positions))?;
    }
    Ok(json!({
        "policy":policy,
        "policy_fetches":1,
        "per_fragment_decision_rpcs":0,
        "media_fragment_fetches":fetches,
        "application_received_bytes_including_metadata":transfers[start..].iter().map(|value| value.application_received_bytes).sum::<u64>(),
        "requests_including_metadata":transfers.len()-start,
        "decisions":decisions,
        "adapter":"range-intersection-generation-and-append-v1",
        "buffer_model":"分片时间线和模拟追加回调；已通过适配器预留/下载/追加两阶段，但未连接手机渲染器",
        "actual_memory_or_watching_measured":false
    }))
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<_> = env::args_os().skip(1).collect();
    if !(2..=3).contains(&args.len()) {
        return Err(io::Error::other(
            "用法：delivery_trace <封存MP4> <目标分片秒数1至6> [最大缓冲毫秒]",
        )
        .into());
    }
    let seconds = args[1]
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| io::Error::other("目标分片秒数无效"))?;
    let directory = tempfile::tempdir()?;
    let mut policy = PlaybackPolicy::default();
    if let Some(raw) = args.get(2) {
        policy.max_buffer_ms = raw
            .to_str()
            .and_then(|raw| raw.parse().ok())
            .ok_or_else(|| io::Error::other("最大缓冲毫秒无效"))?;
    }
    policy.validate()?;
    let publication = publish_hls(
        directory.path(),
        Path::new(&args[0]),
        "delivery-trace-v1",
        "clip",
        seconds,
    )?;
    let bytes = load_catalog_release(directory.path(), "delivery-trace-v1")?;
    let catalog: vs_core::catalog::PublicCatalog = serde_json::from_slice(&bytes)?;
    let store = MediaStore::filesystem(directory.path().to_str().ok_or("路径编码无效")?)?;
    let token = format!(
        "{:x}",
        Sha256::digest(directory.path().as_os_str().as_encoded_bytes())
    );
    let state = Arc::new(
        AppState::new(&bytes, Some(store), &token, 2, 4)
            .map_err(io::Error::other)?
            .with_delivery_observation()
            .with_playback_policy(policy)
            .map_err(io::Error::other)?,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let base = format!("http://{address}");
    let server = tokio::spawn(async move { axum::serve(listener, router(state, Role::All)).await });
    // 所有错误路径都先退出实验服务，再向调用者返回，不遗留后台进程。
    let result = async {
        let client = Client::builder().no_proxy().timeout(Duration::from_secs(5)).build()?;
        let recommendation: Value = client.post(format!("{base}/v1/recommendations"))
            .bearer_auth(&token).json(&json!({
                "request_id":"window-feed","domains":["video"],"limit":1,"profile":null
            })).send().await?.error_for_status()?.json().await?;
        if recommendation["items"][0]["media_path"] != publication.media_path {
            return Err(io::Error::other("推荐没有返回本次固定HLS入口").into());
        }
        let size = |hash: &str| catalog.assets.iter().find(|asset| asset.sha256 == hash)
            .map(|asset| asset.bytes).ok_or_else(|| io::Error::other("资产不在目录中"));
        let mut transfers = Vec::new();
        transfers.push(get(&client, &base, &token, &publication.master_sha256,
            size(&publication.master_sha256)?, "manifest", false).await?);
        for track in &publication.tracks {
            transfers.push(get(&client, &base, &token, &track.playlist_sha256,
                size(&track.playlist_sha256)?, "manifest", false).await?);
            transfers.push(get(&client, &base, &token, &track.init_sha256,
                size(&track.init_sha256)?, "initialization", false).await?);
            let first = &track.segments[0];
            transfers.push(get(&client, &base, &token, &first.sha256, first.bytes, "first-window", false).await?);
        }
        let window_bytes: u64 = transfers.iter().map(|value| value.application_received_bytes).sum();
        let initial_requests = transfers.len();
        let first_window = snapshot(&client, &base, &token).await?;
        for track in &publication.tracks {
            for segment in track.segments.iter().skip(1) {
                transfers.push(get(&client, &base, &token, &segment.sha256,
                    segment.bytes, "remaining-window", false).await?);
            }
        }
        let full_bytes: u64 = transfers.iter().map(|value| value.application_received_bytes).sum();
        if full_bytes != publication.catalog.release.asset_bytes {
            return Err(io::Error::other("完整资产读取与发布目录字节和不符").into());
        }
        let full_assets = snapshot(&client, &base, &token).await?;
        let controlled = controlled_window(&client, &base, &token, &publication, &catalog, &mut transfers).await?;
        let segment = publication.tracks.iter().flat_map(|track| &track.segments)
            .max_by_key(|segment| segment.bytes).ok_or("缺少媒体片")?;
        transfers.push(get(&client, &base, &token, &segment.sha256, segment.bytes, "cancel-probe", true).await?);
        let deadline = Instant::now() + Duration::from_secs(2);
        let final_metrics = loop {
            let metrics = snapshot(&client, &base, &token).await?;
            if metrics["delivery"]["active_bodies"] == 0 { break metrics; }
            if Instant::now() >= deadline { return Err(io::Error::other("观测正文未在预算内释放").into()); }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        if final_metrics["delivery"]["valid_reports"].as_u64() != Some(transfers.len() as u64) {
            return Err(io::Error::other("CMCD有效请求与实际媒体请求数不符").into());
        }
        Ok::<_, Box<dyn std::error::Error>>(json!({
            "schema":"delivery-window-trace-v1",
            "recommendation_request_id":"window-feed",
            "catalog_sha256":publication.catalog.release.catalog_sha256,
            "source_bytes":publication.source_bytes,
            "first_window_including_manifests_bytes":window_bytes,
            "first_window_requests":initial_requests,
            "full_asset_bytes":full_bytes,
            "controlled_window":controlled,
            "transfers":transfers,
            "first_window_server_metrics":first_window,
            "full_assets_server_metrics":full_assets,
            "final_server_metrics":final_metrics,
            "client_cmcd_values_are_synthetic":true,
            "rendered_bytes_or_watched_time_measured":false,
            "server_address":address.to_string(),
            "server_stopped":true,
            "limitations":"客户端收到字节不等于已渲染；取消请求可能晚于服务端完成产出；没有真实QoE或带宽收益结论"
        }))
    }.await;
    server.abort();
    let _ = server.await;
    let receipt = result?;
    serde_json::to_writer_pretty(io::stdout(), &receipt)?;
    println!();
    Ok(())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("vs_service::delivery=info")
        .with_writer(io::stderr)
        .init();
    if let Err(error) = run().await {
        eprintln!("交付窗口实验失败：{error}");
        std::process::exit(1);
    }
}
