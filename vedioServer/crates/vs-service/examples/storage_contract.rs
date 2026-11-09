use std::{
    collections::HashSet,
    env,
    ops::Range,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{StreamExt, future::join_all};
use opendal::{ErrorKind, Operator, services};
use reqwest::{Client, StatusCode, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_service::{AppState, Role, router};
use vs_storage::{MediaStore, S3Config};

type Check<T> = Result<T, String>;

#[path = "support/cancel_lifecycle.rs"]
mod cancel_lifecycle;
#[path = "support/cancel_soak.rs"]
mod cancel_soak;
#[path = "support/delete_check.rs"]
mod delete_check;
#[path = "support/direct_cancel.rs"]
mod direct_cancel;
#[path = "support/measure.rs"]
mod measure;
#[path = "support/read_matrix.rs"]
mod read_matrix;

fn required(name: &str) -> Check<String> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing_{name}"))
}

fn storage_error(error: opendal::Error) -> String {
    // 只输出错误类别，避免上游诊断携带凭证或完整请求。
    format!("storage_{:?}", error.kind())
}

fn ensure(condition: bool, reason: &str) -> Check<()> {
    condition.then_some(()).ok_or_else(|| reason.to_string())
}

fn range_cases(size: usize) -> Vec<Range<usize>> {
    vec![
        0..1,
        0..65_536,
        17..262_161,
        524_288..1_572_864,
        1_048_319..1_113_855,
        size - 8_192..size,
        size - 1..size,
    ]
}

async fn read_exact(store: &MediaStore, key: &str, range: Range<usize>, data: &[u8]) -> Check<()> {
    let mut source = store
        .stream(key, range.start as u64..range.end as u64)
        .await
        .map_err(storage_error)?;
    let mut offset = range.start;
    while let Some(chunk) = source.next().await {
        let chunk = chunk.map_err(|error| format!("stream_{:?}", error.kind()))?;
        let end = offset
            .checked_add(chunk.len())
            .ok_or("range_length_overflow")?;
        ensure(end <= range.end, "range_overread")?;
        ensure(chunk.as_ref() == &data[offset..end], "range_bytes_mismatch")?;
        offset = end;
    }
    ensure(offset == range.end, "range_truncated")
}

async fn check_media(store: MediaStore, hash: &str, data: &[u8]) -> Check<usize> {
    let token = format!("storage-contract-{hash}");
    let catalog = serde_json::to_vec(&json!({
        "version": "storage-contract",
        "items": [],
        "assets": [{"sha256": hash, "bytes": data.len(), "content_type": "application/octet-stream"}]
    }))
    .map_err(|_| "catalog_serialization")?;
    let state = AppState::new(&catalog, Some(store), &token, 1, 2).map_err(str::to_string)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "media_bind_failed")?;
    let address = listener.local_addr().map_err(|_| "media_address_failed")?;
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let mut task = tokio::spawn(async move {
        axum::serve(listener, router(Arc::new(state), Role::Media))
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await
    });
    let result = async {
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "media_client_failed")?;
        let url = format!("http://{address}/v1/media/{hash}");
        let etag = format!("\"{hash}\"");
        let head = client
            .head(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|_| "media_head_failed")?;
        ensure(head.status() == StatusCode::OK, "media_head_status")?;
        ensure(
            head.headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                == Some(data.len().to_string().as_str()),
            "media_head_length",
        )?;
        ensure(
            head.headers().get("etag").and_then(|v| v.to_str().ok()) == Some(etag.as_str()),
            "media_head_etag",
        )?;
        ensure(
            head.bytes()
                .await
                .map_err(|_| "media_head_body")?
                .is_empty(),
            "media_head_not_empty",
        )?;
        let mut count = 1;
        for range in range_cases(data.len()) {
            let response = client
                .get(&url)
                .bearer_auth(&token)
                .header("range", format!("bytes={}-{}", range.start, range.end - 1))
                .send()
                .await
                .map_err(|_| "media_range_failed")?;
            ensure(
                response.status() == StatusCode::PARTIAL_CONTENT,
                "media_range_status",
            )?;
            let content_range = format!("bytes {}-{}/{}", range.start, range.end - 1, data.len());
            ensure(
                response
                    .headers()
                    .get("content-range")
                    .and_then(|v| v.to_str().ok())
                    == Some(content_range.as_str()),
                "media_content_range",
            )?;
            ensure(
                response
                    .bytes()
                    .await
                    .map_err(|_| "media_range_body")?
                    .as_ref()
                    == &data[range],
                "media_range_bytes",
            )?;
            count += 1;
        }
        let full = client
            .get(&url)
            .bearer_auth(&token)
            .header("range", "bytes=0-7")
            .header("if-range", "\"different-version\"")
            .send()
            .await
            .map_err(|_| "media_if_range_failed")?;
        ensure(full.status() == StatusCode::OK, "media_if_range_status")?;
        ensure(
            full.bytes().await.map_err(|_| "media_full_body")?.as_ref() == data,
            "media_full_bytes",
        )?;
        let unchanged = client
            .get(&url)
            .bearer_auth(&token)
            .header("if-none-match", &etag)
            .send()
            .await
            .map_err(|_| "media_conditional_failed")?;
        ensure(
            unchanged.status() == StatusCode::NOT_MODIFIED,
            "media_conditional_status",
        )?;
        ensure(
            unchanged
                .bytes()
                .await
                .map_err(|_| "media_conditional_body")?
                .is_empty(),
            "media_conditional_not_empty",
        )?;
        let invalid = client
            .get(&url)
            .bearer_auth(&token)
            .header("range", format!("bytes={}-", data.len()))
            .send()
            .await
            .map_err(|_| "media_invalid_range_failed")?;
        ensure(
            invalid.status() == StatusCode::RANGE_NOT_SATISFIABLE,
            "media_invalid_range_status",
        )?;
        let suffix = client
            .get(&url)
            .bearer_auth(&token)
            .header("range", "bytes=-31")
            .send()
            .await
            .map_err(|_| "media_suffix_failed")?;
        ensure(
            suffix.status() == StatusCode::PARTIAL_CONTENT,
            "media_suffix_status",
        )?;
        ensure(
            suffix
                .bytes()
                .await
                .map_err(|_| "media_suffix_body")?
                .as_ref()
                == &data[data.len() - 31..],
            "media_suffix_bytes",
        )?;
        Ok(count + 4)
    }
    .await;
    let _ = stop_tx.send(());
    // 即使合约检查失败，也回收此探针创建的媒体服务。
    match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
        Ok(Ok(Ok(()))) => result,
        Ok(_) => Err("media_shutdown_failed".into()),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err("media_shutdown_failed".into())
        }
    }
}

async fn verify_object(stores: &[MediaStore], key: &str, hash: &str, data: &[u8]) -> Check<Value> {
    for store in stores {
        ensure(
            store.size(key).await.map_err(storage_error)? == data.len() as u64,
            "object_size",
        )?;
        read_exact(store, key, 0..data.len(), data).await?;
        for range in range_cases(data.len()) {
            read_exact(store, key, range, data).await?;
        }
    }
    let mut http_checks = 0;
    for store in stores {
        http_checks += check_media(store.clone(), hash, data).await?;
    }
    Ok(json!({
        "endpoint_count": stores.len(),
        "object_bytes": data.len(),
        "object_sha256": hash,
        "full_reads": stores.len(),
        "direct_range_checks": stores.len() * range_cases(data.len()).len(),
        "http_checks": http_checks,
        "performance_claim": false
    }))
}

async fn validate(
    operators: &[Operator],
    stores: &[MediaStore],
    key: &str,
    race_key: &str,
    hash: &str,
    data: &[u8],
) -> Check<Value> {
    operators[0]
        .write_with(key, data.to_vec())
        .if_not_exists(true)
        .await
        .map_err(storage_error)?;
    let mut checks = verify_object(stores, key, hash, data).await?;
    // 竞争从不同端点发起；一个成功之外必须是条件失败，不能吞掉网络错误。
    let results = join_all(
        operators
            .iter()
            .enumerate()
            .map(|(index, operator)| async move {
                operator
                    .write_with(race_key, format!("winner-{index}").into_bytes())
                    .if_not_exists(true)
                    .await
            }),
    )
    .await;
    let winners: Vec<_> = results
        .iter()
        .enumerate()
        .filter(|(_, result)| result.is_ok())
        .map(|(index, _)| index)
        .collect();
    ensure(winners.len() == 1, "conditional_write_winner_count")?;
    for error in results.into_iter().filter_map(Result::err) {
        ensure(
            error.kind() == ErrorKind::ConditionNotMatch,
            "conditional_write_unexpected_error",
        )?;
    }
    let expected = format!("winner-{}", winners[0]);
    for operator in operators {
        let value = operator
            .read(race_key)
            .await
            .map_err(storage_error)?
            .to_vec();
        ensure(value == expected.as_bytes(), "conditional_write_divergence")?;
    }
    checks["conditional_winners"] = json!(winners.len());
    checks["conditional_payload_bytes"] = json!(8);
    Ok(checks)
}

async fn cleanup_keys(operators: &[Operator], key: &str, race_key: &str) -> Check<()> {
    tokio::time::timeout(Duration::from_secs(20), async {
        // 仅删除本次种子生成的两个键，不枚举或清空整个桶。
        operators[0].delete(key).await.map_err(storage_error)?;
        operators[0].delete(race_key).await.map_err(storage_error)?;
        for operator in operators {
            for target in [key, race_key] {
                ensure(
                    matches!(operator.stat(target).await, Err(ref error) if error.kind() == ErrorKind::NotFound),
                    "cleanup_not_visible",
                )?;
            }
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "cleanup_timeout".to_string())?
}

async fn run() -> Check<()> {
    let phase = env::var("VS_LAB_PHASE").unwrap_or_else(|_| "contract".into());
    ensure(
        matches!(
            phase.as_str(),
            "contract"
                | "prepare"
                | "verify"
                | "cleanup"
                | "measure"
                | "read-matrix"
                | "cancel-lifecycle"
                | "direct-cancel"
                | "cancel-soak"
                | "cleanup-owned"
        ),
        "invalid_lab_phase",
    )?;
    let run_id = if phase == "cleanup-owned" {
        String::new()
    } else if matches!(
        phase.as_str(),
        "contract"
            | "measure"
            | "read-matrix"
            | "cancel-lifecycle"
            | "direct-cancel"
            | "cancel-soak"
    ) && std::env::var_os("VS_LAB_SEED").is_none()
    {
        // 未指定种子时保持独立数据；显式种子用于两种服务端的配对回放。
        format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "clock_error")?
                .as_nanos()
        )
    } else {
        let seed = required("VS_LAB_SEED")?;
        ensure(
            seed.len() == 48
                && seed
                    .bytes()
                    .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)),
            "invalid_lab_seed",
        )?;
        seed
    };
    let bucket = required("VS_LAB_BUCKET")?;
    ensure(
        bucket.starts_with("video-lab-")
            && bucket.len() <= 63
            && bucket
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-'),
        "lab_bucket_required",
    )?;
    let endpoints: Vec<_> = required("VS_LAB_ENDPOINTS")?
        .split(',')
        .map(str::to_string)
        .collect();
    ensure((2..=8).contains(&endpoints.len()), "lab_endpoint_count")?;
    let mut ports = HashSet::new();
    for endpoint in &endpoints {
        let url = Url::parse(endpoint).map_err(|_| "invalid_endpoint")?;
        ensure(
            url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "loopback_endpoint_required",
        )?;
        ensure(
            ports.insert(url.port_or_known_default().ok_or("missing_endpoint_port")?),
            "duplicate_loopback_endpoint",
        )?;
    }
    let access = required("VS_LAB_ACCESS_KEY")?;
    let secret = required("VS_LAB_SECRET_KEY")?;
    let mut operators = Vec::new();
    let mut stores = Vec::new();
    for endpoint in &endpoints {
        stores.push(
            MediaStore::s3(S3Config {
                endpoint: endpoint.clone(),
                region: "us-east-1".into(),
                bucket: bucket.clone(),
                access_key_id: access.clone(),
                secret_access_key: secret.clone(),
            })
            .map_err(storage_error)?,
        );
        operators.push(
            Operator::new(
                services::S3::default()
                    .endpoint(endpoint)
                    .region("us-east-1")
                    .bucket(&bucket)
                    .access_key_id(&access)
                    .secret_access_key(&secret)
                    .disable_config_load()
                    .disable_ec2_metadata(),
            )
            .map_err(storage_error)?,
        );
    }
    if phase == "read-matrix" {
        return read_matrix::run(&operators, stores[0].clone(), &run_id, &bucket).await;
    }
    if phase == "cancel-lifecycle" {
        return cancel_lifecycle::run(&operators, stores[0].clone(), &run_id, &bucket).await;
    }
    if phase == "direct-cancel" {
        return direct_cancel::run(&operators, &run_id, &bucket).await;
    }
    if phase == "cancel-soak" {
        return cancel_soak::run(&operators, &run_id, &bucket).await;
    }
    if phase == "cleanup-owned" {
        return delete_check::cleanup_owned(&operators, &bucket).await;
    }
    // 恢复阶段由独立种子重建期望字节；verify 路径不进行任何写入。
    let mut data = vec![0_u8; 3 * 1_048_576 + 73];
    for (index, chunk) in data.chunks_mut(32).enumerate() {
        let hash = Sha256::digest(format!("{run_id}:{index}").as_bytes());
        chunk.copy_from_slice(&hash[..chunk.len()]);
    }
    let hash = format!("{:x}", Sha256::digest(&data));
    let key = format!("media/{hash}");
    let race_key = format!("contract/{run_id}");
    if phase == "cleanup" {
        let result = cleanup_keys(&operators, &key, &race_key).await;
        println!(
            "{}",
            json!({"schema": "storage-recovery-phase-v1", "phase": phase,
                "seed": run_id, "passed": result.is_ok(), "error": result.as_ref().err()})
        );
        return result;
    }
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        match phase.as_str() {
            "contract" => validate(&operators, &stores, &key, &race_key, &hash, &data).await,
            "prepare" => {
                operators[0]
                    .write_with(&key, data.clone())
                    .if_not_exists(true)
                    .await
                    .map_err(storage_error)?;
                verify_object(&stores, &key, &hash, &data).await
            }
            "measure" => {
                operators[0]
                    .write_with(&key, data.clone())
                    .if_not_exists(true)
                    .await
                    .map_err(storage_error)?;
                measure::run(stores[0].clone(), &hash, &data).await
            }
            "verify" => verify_object(&stores, &key, &hash, &data).await,
            _ => unreachable!(),
        }
    })
    .await
    .map_err(|_| "contract_timeout".to_string())
    .and_then(|value| value);
    if !matches!(phase.as_str(), "contract" | "measure") {
        println!(
            "{}",
            json!({"schema": "storage-recovery-phase-v1", "phase": phase, "seed": run_id,
                "passed": result.is_ok(), "checks": result.as_ref().ok(),
                "error": result.as_ref().err(), "cleanup_attempted": false})
        );
        return result.map(|_| ());
    }
    let cleanup = cleanup_keys(&operators, &key, &race_key).await;
    println!(
        "{}",
        json!({
            "schema": if phase == "measure" { "storage-measure-v1" } else { "storage-contract-v1" },
            "passed": result.is_ok() && cleanup.is_ok(),
            "checks": result.as_ref().ok(),
            "error": result.as_ref().err(),
            "cleanup_passed": cleanup.is_ok(),
            "cleanup_error": cleanup.as_ref().err()
        })
    );
    result?;
    cleanup
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("storage_contract_failed: {error}");
        std::process::exit(1);
    }
}
