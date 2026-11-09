use std::time::{Duration, Instant};

use opendal::{ErrorKind, Operator};
use serde_json::{Value, json};

use super::{Check, ensure, required, storage_error};

pub async fn cleanup_owned(operators: &[Operator], bucket: &str) -> Check<()> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(required("VS_LAB_RECEIPT")?)
        .map_err(|_| "cleanup_receipt_open")?
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| "cleanup_receipt_read")?;
    ensure(bytes.len() <= 1_048_576, "cleanup_receipt_too_large")?;
    let receipt: Value =
        serde_json::from_slice(&bytes).map_err(|_| "cleanup_receipt_invalid_json")?;
    ensure(
        matches!(
            receipt["schema"].as_str(),
            Some(
                "storage-cancel-lifecycle-v1"
                    | "storage-read-matrix-v1"
                    | "storage-direct-cancel-v1"
                    | "storage-cancel-soak-v1"
            )
        ) && receipt["bucket"] == bucket,
        "cleanup_receipt_scope_mismatch",
    )?;
    let hashes = receipt["owned_object_sha256"]
        .as_array()
        .ok_or("cleanup_receipt_objects_missing")?;
    ensure(
        !hashes.is_empty() && hashes.len() <= 24,
        "cleanup_receipt_object_count",
    )?;
    // 所有键在任何删除之前验证；只接受探针记录的内容摘要。
    let mut keys = std::collections::HashSet::new();
    for value in hashes {
        let hash = value.as_str().ok_or("cleanup_receipt_hash_type")?;
        ensure(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && keys.insert(hash),
            "cleanup_receipt_invalid_hash",
        )?;
    }
    let mut checks = Vec::new();
    for hash in hashes {
        checks.push(delete_and_check(operators, hash.as_str().unwrap()).await);
    }
    let result = outcome(&checks);
    println!(
        "{}",
        json!({
            "schema": "storage-owned-cleanup-v1", "bucket": bucket,
            "passed": result.is_ok(), "checks": checks,
            "original_experiment_passed": receipt["passed"]
        })
    );
    result
}

pub async fn delete_and_check(operators: &[Operator], hash: &str) -> Value {
    let key = format!("media/{hash}");
    let start = Instant::now();
    let mut stage = "delete";
    let mut endpoint = 0;
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        operators[0].delete(&key).await.map_err(storage_error)?;
        stage = "verify_absent";
        for (index, operator) in operators.iter().enumerate() {
            endpoint = index;
            match operator.stat(&key).await {
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(storage_error(error)),
                Ok(_) => return Err("object_remains_visible".into()),
            }
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "delete_check_timeout".to_string())
    .and_then(|result| result);
    json!({
        "object_sha256": hash, "passed": result.is_ok(),
        "error": result.err(), "stage": stage, "endpoint_index": endpoint,
        "elapsed_us": start.elapsed().as_micros()
    })
}

pub fn outcome(checks: &[Value]) -> Check<()> {
    if checks.iter().all(|check| check["passed"] == true) {
        Ok(())
    } else {
        Err("object_cleanup_failed".into())
    }
}
