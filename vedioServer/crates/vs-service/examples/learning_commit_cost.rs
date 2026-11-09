use std::{
    env, io,
    path::Path,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::future::join_all;
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_service::{AppState, LearningCommitMode, Role, router};

const TOKEN: &str = "learning-commit-cost-token-000000000000000";
const REQUESTS: usize = 64;

async fn run_case(
    root: &Path,
    catalog: &[u8],
    label: &str,
    mode: Option<LearningCommitMode>,
    concurrency: usize,
    repeat: usize,
) -> Result<Value, Box<dyn std::error::Error>> {
    let source = format!("{label}-c{concurrency}-r{repeat}");
    let path = root.join(format!("{source}.jsonl"));
    let state = AppState::new(catalog, None, TOKEN, 4, 1).map_err(io::Error::other)?;
    let state = Arc::new(if let Some(mode) = mode {
        state
            .with_learning_journal_mode(&path, &source, mode)
            .map_err(io::Error::other)?
    } else {
        state
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app_state = state.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, router(app_state, Role::Api))
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });
    // 成功和错误路径都关闭自有服务，避免测量失败后留下端口。
    let outcome = async {
        let client = Client::builder().no_proxy().retry(reqwest::retry::never())
            .timeout(Duration::from_secs(5)).build()?;
        let expires = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() + 60;
        let mut times = Vec::new();
        let mut decisions = Vec::new();
        let mut expected_items = None;
        let started = Instant::now();
        for wave in 0..REQUESTS / concurrency {
            let replies = join_all((0..concurrency).map(|offset| {
                let client = &client;
                let endpoint = &endpoint;
                let index = wave * concurrency + offset;
                async move {
                    let body = json!({
                        "request_id":format!("request-{index}"),"domains":["video","article"],"limit":10,
                        "profile":{"subject":"synthetic-person","version":"p1",
                            "scopes":["video","article"],"expires_at":expires,
                            "interests":[{"tag":"rust","weight":0.8},{"tag":"storage","weight":-0.4}],
                            "blocked_ids":[],"denied_tags":[]}
                    });
                    let clock = Instant::now();
                    let response = client.post(format!("{endpoint}/v1/recommendations"))
                        .bearer_auth(TOKEN).json(&body).send().await?.error_for_status()?;
                    let decision = response.headers().get("x-learning-decision-id")
                        .and_then(|value| value.to_str().ok()).map(str::to_owned);
                    let result: Value = response.json().await?;
                    Ok::<_, reqwest::Error>((clock.elapsed().as_nanos(), decision, result))
                }
            })).await;
            for reply in replies {
                let (elapsed, decision, result) = reply?;
                if mode.is_some() != decision.is_some() {
                    return Err(io::Error::other("采集模式与决策标识不匹配").into());
                }
                if let Some(expected) = &expected_items {
                    if expected != &result["items"] {
                        return Err(io::Error::other("同输入的推荐结果发生变化").into());
                    }
                } else {
                    expected_items = Some(result["items"].clone());
                }
                times.push(elapsed);
                if let Some(decision) = decision { decisions.push(decision); }
            }
        }
        let total_us = started.elapsed().as_micros();
        let metrics: Value = client.get(format!("{endpoint}/v1/metrics")).bearer_auth(TOKEN)
            .send().await?.error_for_status()?.json().await?;
        times.sort_unstable();
        let percentile = |p: usize| times[(p * times.len()).div_ceil(100) - 1];
        let items_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&expected_items)?));
        if mode.is_some() && metrics["learning_journal"]["committed_records"] != REQUESTS {
            return Err(io::Error::other("成功响应与持久化计数不一致").into());
        }
        Ok::<_, Box<dyn std::error::Error>>(json!({
            "mode":label,"concurrency":concurrency,"repeat":repeat,"requests":REQUESTS,
            "latency_samples_ns":times,"p50_ns":percentile(50),"p95_ns":percentile(95),
            "p99_ns":percentile(99),"total_us":total_us,
            "items_sha256":items_sha256,"decision_ids":decisions,"metrics":metrics["learning_journal"]
        }))
    }.await;
    state.drain_learning_writes().await;
    let _ = shutdown_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), server).await???;
    drop(state);
    let mut report = outcome?;
    if mode.is_some() {
        let bytes = std::fs::read(&path)?;
        let records: Vec<Value> = bytes
            .split_inclusive(|byte| *byte == b'\n')
            .map(serde_json::from_slice)
            .collect::<Result<_, _>>()?;
        let ids: std::collections::HashSet<_> = report["decision_ids"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        if records.len() != REQUESTS || ids.len() != REQUESTS {
            return Err(io::Error::other("日志记录或唯一决策数量不符").into());
        }
        for (index, record) in records.iter().enumerate() {
            let previous = if index == 0 {
                ""
            } else {
                records[index - 1]["decision_id"].as_str().unwrap()
            };
            if record["envelope"]["sequence"] != index + 1
                || record["envelope"]["metadata"]["previous_decision_id"] != previous
                || !ids.contains(record["decision_id"].as_str().unwrap())
            {
                return Err(io::Error::other("HTTP确认与日志指纹链不一致").into());
            }
        }
        report["journal_bytes"] = json!(bytes.len());
        report["journal_sha256"] = json!(format!("{:x}", Sha256::digest(bytes)));
    } else {
        report["journal_bytes"] = json!(0);
    }
    report.as_object_mut().unwrap().remove("decision_ids");
    Ok(report)
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() != 1 {
        return Err(io::Error::other("用法：learning_commit_cost <已存在的独立实验目录>").into());
    }
    let root = Path::new(&arguments[0]);
    if !root.is_dir() {
        return Err(io::Error::other("实验目录不存在").into());
    }
    let items: Vec<_> = (0..256)
        .map(|index| {
            json!({
                "id":format!("candidate-{index}"),"domain":if index%2==0 {"video"} else {"article"},
                "tags":if index%3==0 {vec!["rust","storage"]} else {vec!["rust"]},
                "prior":(index%11) as f32/10.0,"media_sha256":null
            })
        })
        .collect();
    let catalog =
        serde_json::to_vec(&json!({"version":"commit-cost-v1","items":items,"assets":[]}))?;
    let modes = [
        ("off", None),
        ("single", Some(LearningCommitMode::Single)),
        ("grouped", Some(LearningCommitMode::Grouped)),
    ];
    let mut cells = Vec::new();
    for repeat in 0..2 {
        for concurrency in [1, 4] {
            for offset in 0..3 {
                let (label, mode) = modes[(repeat + offset) % 3];
                cells.push(run_case(root, &catalog, label, mode, concurrency, repeat).await?);
            }
        }
    }
    if cells
        .iter()
        .any(|cell| cell["items_sha256"] != cells[0]["items_sha256"])
    {
        return Err(io::Error::other("不同采集方式改变了推荐结果").into());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema":"learning-commit-cost-v1","data_kind":"synthetic",
            "build":if cfg!(debug_assertions) {"debug"} else {"release"},
            "quality_gate_passed":true,"catalog_sha256":format!("{:x}",Sha256::digest(&catalog)),
            "intentional_batch_wait_us":0,"write_slots":4,"candidates":256,"cells":cells,
            "boundary":"同机HTTP、固定两轮与热缓存；无真实曝光、并发容量、掉电或生产QoE结论"
        }))?
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("学习日志成本对照失败：{error}");
        std::process::exit(1);
    }
}
