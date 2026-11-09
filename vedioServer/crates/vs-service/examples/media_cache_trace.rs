use std::{env, ops::Range, sync::atomic::Ordering, time::Instant};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_storage::{MediaCacheConfig, ReadMode};

#[path = "support/cache_fixture.rs"]
mod fixture;
use fixture::{Behavior, Fixture, TOKEN, wait_until};

#[derive(Serialize)]
struct Timing {
    headers_ns: u64,
    first_body_ns: u64,
    complete_ns: u64,
    bytes: usize,
    warm: bool,
}

fn elapsed(start: Instant) -> u64 {
    start.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

fn percentiles(values: impl Iterator<Item = u64>) -> Option<Value> {
    let mut values: Vec<_> = values.collect();
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let at = |percent: usize| values[(percent * values.len()).div_ceil(100) - 1];
    Some(json!({"samples":values.len(),"p50_ns":at(50),"p95_ns":at(95),"p99_ns":at(99)}))
}

async fn measure(fixture: &Fixture, range: Range<usize>) -> Result<Timing, String> {
    let before = fixture
        .store
        .media_cache_metrics()
        .map_or(0, |metrics| metrics.hits);
    let start = Instant::now();
    let mut response = fixture.request_range(range.clone()).await;
    let headers_ns = elapsed(start);
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
    {
        return Err("媒体响应状态或元数据不符".into());
    }
    let mut bytes = Vec::new();
    let mut first_body_ns = None;
    while let Some(part) = response.chunk().await.map_err(|_| "媒体响应正文失败")? {
        if !part.is_empty() && first_body_ns.is_none() {
            first_body_ns = Some(elapsed(start));
        }
        bytes.extend_from_slice(&part);
    }
    let complete_ns = elapsed(start);
    if bytes != fixture.origin.data[range] {
        return Err("媒体正文与请求范围不符，停止收益测量".into());
    }
    let after = fixture
        .store
        .media_cache_metrics()
        .map_or(0, |metrics| metrics.hits);
    Ok(Timing {
        headers_ns,
        first_body_ns: first_body_ns.ok_or("媒体正文为空")?,
        complete_ns,
        bytes: bytes.len(),
        warm: after > before,
    })
}

fn trace(name: &str, samples: usize) -> Vec<Range<usize>> {
    (0..samples)
        .map(|index| match name {
            "hot" => 0..8192,
            "scan" => index * 4096..index * 4096 + 4096,
            "mixed" => {
                let item = if index % 4 == 3 {
                    8 + index / 4
                } else {
                    index % 4
                };
                item * 4096..item * 4096 + 4096
            }
            "oversize" => 100..131_172,
            _ => unreachable!(),
        })
        .collect()
}

async fn run_cell(name: &str, samples: usize, capacity: u64) -> Result<Value, String> {
    let config = MediaCacheConfig {
        capacity_bytes: capacity,
        ..Default::default()
    };
    let direct = Fixture::new(None, ReadMode::default(), Behavior::Normal).await;
    let cached = Fixture::new(Some(config), ReadMode::default(), Behavior::Normal).await;
    let ranges = trace(name, samples);
    let trace_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(
                &ranges
                    .iter()
                    .map(|range| [range.start, range.end])
                    .collect::<Vec<_>>()
            )
            .map_err(|_| "请求轨迹编码失败")?
        )
    );
    let mut rows = Vec::new();
    for (index, range) in ranges.into_iter().enumerate() {
        let direct_first = [true, false, false, true][index % 4];
        let (baseline, cache) = if direct_first {
            (
                measure(&direct, range.clone()).await?,
                measure(&cached, range).await?,
            )
        } else {
            let cache = measure(&cached, range.clone()).await?;
            (measure(&direct, range).await?, cache)
        };
        rows.push(json!({
            "first":if direct_first {"direct"}else{"cached"},
            "direct":baseline,"cached":cache
        }));
    }
    let stats = |key: &str, field: &str, warm: Option<bool>| {
        percentiles(rows.iter().filter_map(|row| {
            if warm.is_some_and(|warm| row[key]["warm"].as_bool() != Some(warm)) {
                return None;
            }
            row[key][field].as_u64()
        }))
    };
    wait_until(|| {
        direct.state.media_slots.available_permits() == 32
            && cached.state.media_slots.available_permits() == 32
    })
    .await;
    let report = json!({
        "workload":name,"samples":samples,"cache_config":config,
        "asset_sha256":direct.origin.hash,"trace_sha256":trace_hash,
        "quality_gate":{"passed":true,"rule":"相同资产、完整响应元数据和精确有序字节"},
        "direct_first_body":stats("direct","first_body_ns",None),
        "cached_first_body":stats("cached","first_body_ns",None),
        "cached_cold_first_body":stats("cached","first_body_ns",Some(false)),
        "cached_warm_first_body":stats("cached","first_body_ns",Some(true)),
        "direct_complete":stats("direct","complete_ns",None),
        "cached_complete":stats("cached","complete_ns",None),
        "direct_http":direct.store.http_metrics(),
        "cached_http":cached.store.http_metrics(),
        "cache":cached.store.media_cache_metrics(),
        "client_bytes":rows.iter().map(|row|row["direct"]["bytes"].as_u64().unwrap()).sum::<u64>(),
        "client_bytes_equal":true,
        "measurements":rows
    });
    direct.close().await;
    cached.close().await;
    Ok(report)
}

async fn run_burst(cache: bool) -> Result<Value, String> {
    let fixture = Fixture::new(
        cache.then(MediaCacheConfig::default),
        ReadMode::default(),
        Behavior::HeadersGated,
    )
    .await;
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let client = fixture.client.clone();
        let url = fixture.url();
        tasks.push(tokio::spawn(async move {
            client
                .get(url)
                .bearer_auth(TOKEN)
                .header("range", "bytes=0-8191")
                .send()
                .await?
                .error_for_status()?
                .bytes()
                .await
        }));
    }
    if cache {
        wait_until(|| fixture.store.media_cache_metrics().unwrap().misses == 16).await;
    } else {
        wait_until(|| fixture.origin.gets.load(Ordering::SeqCst) == 16).await;
    }
    fixture.origin.gate.close();
    for task in tasks {
        let bytes = task
            .await
            .map_err(|_| "并发读取任务退出")?
            .map_err(|_| "并发媒体请求失败")?;
        if bytes.as_ref() != &fixture.origin.data[..8192] {
            return Err("并发媒体正文不一致".into());
        }
    }
    wait_until(|| fixture.state.media_slots.available_permits() == 32).await;
    let result = json!({
        "cache_enabled":cache,"clients":16,"client_bytes":16*8192,
        "quality_gate_passed":true,"storage_http":fixture.store.http_metrics(),
        "cache":fixture.store.media_cache_metrics(),
        "timing_claim":false,"gate":"等待同一批请求进入后才释放源站响应头；该同步屏障不代表生产延迟。"
    });
    fixture.close().await;
    Ok(result)
}

async fn run() -> Result<Value, String> {
    if cfg!(debug_assertions) {
        return Err("成本测量必须使用release构建；调试合约使用media_cache测试。".into());
    }
    let samples = match env::var("CACHE_SAMPLES") {
        Ok(value) => value.parse::<usize>().map_err(|_| "样本数必须是整数")?,
        Err(env::VarError::NotPresent) => 64,
        Err(_) => return Err("样本数配置编码无效".into()),
    };
    if !(16..=256).contains(&samples) || !samples.is_multiple_of(4) {
        return Err("样本数必须为16至256之间的4的倍数".into());
    }
    let mut cells = Vec::new();
    for capacity in [256 * 1024, 8 * 1024 * 1024] {
        for workload in ["hot", "scan", "mixed", "oversize"] {
            eprintln!("测量缓存轨迹：{workload}，容量{capacity}字节，{samples}对");
            cells.push(run_cell(workload, samples, capacity).await?);
        }
    }
    let direct_burst = run_burst(false).await?;
    let cached_burst = run_burst(true).await?;
    Ok(json!({
        "schema":"media-cache-trace-v1","build":"release","data_kind":"synthetic",
        "samples_per_cell":samples,"cells":cells,
        "burst":{"direct":direct_burst,"cached":cached_burst},
        "quality_gate_passed":true,
        "timing_scope":"本机客户端经媒体HTTP与签名S3夹具；记录响应头、首个非空正文块和完成时间，不是视频首帧。",
        "memory_scope":"缓存逻辑权重、索引分配和加载许可；不等于进程RSS，响应体仍可持有已淘汰的Bytes。",
        "network_scope":"存储HTTP请求及被读取的正文；不含TCP/TLS/HTTP头物理字节，客户端交付字节保持相同。",
        "production_performance_claim":false,"physical_cluster_tested":false
    }))
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(report) => {
            if serde_json::to_writer_pretty(std::io::stdout(), &report).is_err() {
                eprintln!("缓存报告输出失败");
                std::process::exit(1);
            }
            println!();
        }
        Err(error) => {
            eprintln!("缓存测量失败：{error}");
            std::process::exit(1);
        }
    }
}
