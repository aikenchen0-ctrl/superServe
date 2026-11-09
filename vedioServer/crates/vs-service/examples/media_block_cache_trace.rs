use std::{ops::Range, sync::atomic::Ordering};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_storage::{MediaCacheConfig, MediaCachePolicy, ReadMode};

#[path = "support/cache_fixture.rs"]
mod fixture;
use fixture::{Behavior, Fixture};

fn ranges(workload: &str, size: usize) -> Vec<Range<usize>> {
    match workload {
        "neighbor-hot" => (0..64)
            .map(|i| (i % 40) * 1024..(i % 40) * 1024 + 8192)
            .collect(),
        "single-cold" => std::iter::once(17..8209).collect(),
        "scatter-cold" => (0..16).map(|i| i * 65536 + 17..i * 65536 + 8209).collect(),
        "cross-block" => (0..64)
            .map(|i| 65536 - 4096 + (i % 16) * 64..65536 + 4096 + (i % 16) * 64)
            .collect(),
        "short-tail" => (0..64)
            .map(|i| size - 173 + (i % 16) * 4..size - 173 + (i % 16) * 4 + 32)
            .collect(),
        "large-bypass" => (0..4).map(|i| i * 4096..i * 4096 + 131072).collect(),
        _ => unreachable!(),
    }
}

async fn run_cell(workload: &str, reverse: bool) -> Result<Value, String> {
    let variants = [
        Fixture::new(None, ReadMode::default(), Behavior::Normal).await,
        Fixture::new(
            Some(MediaCacheConfig::default()),
            ReadMode::default(),
            Behavior::Normal,
        )
        .await,
        Fixture::new_with_policy(
            Some(MediaCacheConfig::default()),
            ReadMode::default(),
            Behavior::Normal,
            MediaCachePolicy::Block64Kib,
        )
        .await,
        Fixture::new_with_policy(
            Some(MediaCacheConfig::default()),
            ReadMode::default(),
            Behavior::Normal,
            MediaCachePolicy::Block64KibStream,
        )
        .await,
    ];
    let names = ["direct", "exact", "block-64k", "block-64k-stream"];
    let ranges = ranges(workload, variants[0].origin.data.len());
    let trace_sha256 = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(
                &ranges
                    .iter()
                    .map(|range| [range.start, range.end])
                    .collect::<Vec<_>>()
            )
            .map_err(|_| "轨迹编码失败")?
        )
    );
    let client_body_bytes = ranges.iter().map(|range| range.len() as u64).sum::<u64>();
    let orders = [[0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2]];
    for (i, range) in ranges.iter().enumerate() {
        let mut order = orders[i % orders.len()];
        if reverse {
            order.reverse();
        }
        for index in order {
            let fixture = &variants[index];
            let response = fixture.request_range(range.clone()).await;
            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
                || response.headers()["content-length"] != range.len().to_string()
                || response.headers()["etag"] != format!("\"{}\"", fixture.origin.hash)
                || response.headers()["content-range"]
                    != format!(
                        "bytes {}-{}/{}",
                        range.start,
                        range.end - 1,
                        fixture.origin.data.len()
                    )
                || response.headers()["vary"] != "Authorization"
            {
                return Err("块缓存轨迹响应状态或范围不一致".into());
            }
            let body = response
                .bytes()
                .await
                .map_err(|_| "块缓存轨迹响应正文读取失败")?;
            if body.as_ref() != &fixture.origin.data[range.clone()] {
                return Err("块缓存轨迹正文与固定源不符".into());
            }
        }
    }
    let mut results = Vec::new();
    for (name, fixture) in names.into_iter().zip(variants) {
        let metrics = fixture.store.media_cache_metrics();
        let upstream = fixture.store.http_metrics().ok_or("源站HTTP指标缺失")?;
        if upstream.active_exchanges != 0
            || fixture.state.media_slots.available_permits() != 32
            || metrics
                .as_ref()
                .is_some_and(|metrics| metrics.active_fills != 0)
        {
            return Err("块缓存轨迹未回收正文或许可".into());
        }
        results.push(json!({
            "variant":name,"client_requests":ranges.len(),"client_body_bytes":client_body_bytes,
            "origin_gets":fixture.origin.gets.load(Ordering::SeqCst),
            "origin_heads":fixture.origin.heads.load(Ordering::SeqCst),
            "origin_body_bytes":fixture.origin.sent_bytes.load(Ordering::SeqCst),
            "origin_ranges":fixture.origin.ranges.lock().unwrap().iter()
                .map(|range|[range.start,range.end]).collect::<Vec<_>>(),
            "storage_http":upstream,"cache":metrics,
            "response_correct":true,"body_and_permits_reclaimed":true
        }));
        fixture.close().await;
    }
    Ok(json!({
        "workload":workload,"reverse_variant_order":reverse,
        "trace_sha256":trace_sha256,"results":results,
        "quality_gate":"状态、长度、内容范围、ETag、Vary及所有正文逐字节一致",
    }))
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(report) => {
            if let Err(error) = serde_json::to_writer(std::io::stdout(), &report) {
                eprintln!("块缓存轨迹报告写入失败：{error}");
                std::process::exit(1);
            }
            println!();
        }
        Err(error) => {
            eprintln!("块缓存轨迹失败：{error}");
            std::process::exit(1);
        }
    }
}

async fn run() -> Result<Value, String> {
    if std::env::args_os().len() != 1 {
        return Err("固定块缓存轨迹不接受额外参数".into());
    }
    let mut cells = Vec::new();
    for reverse in [false, true] {
        for workload in [
            "neighbor-hot",
            "single-cold",
            "scatter-cold",
            "cross-block",
            "short-tail",
            "large-bypass",
        ] {
            cells.push(run_cell(workload, reverse).await?);
        }
    }
    Ok(json!({
        "schema":"media-block-cache-trace-v2",
        "build":if cfg!(debug_assertions){"debug"}else{"release"},
        "data_kind":"deterministic-synthetic-HTTP-object-source",
        "cache":MediaCacheConfig::default(),"block_bytes":65536,
        "cells":cells,
        "scope":{
            "network":"同机HTTP源与真实S3签名请求，非真实对象存储集群或公网",
            "origin_body":"夹具HTTP正文产出，不含HTTP头、TLS、重传及内部存储读取",
            "latency_or_cpu_ranking":false,"rss_measured":false,
            "cluster_or_cross_node_cache":false,"online_default_changed":false,
            "prefetch":"没有后台预取，按需填充会多读同一块其他字节"
        }
    }))
}
