use std::time::Duration;

use opendal::Operator;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_storage::{MediaStore, ReadMode};

use super::{
    Check, delete_check, ensure,
    measure::{self, Case, Consumption},
    storage_error,
};

pub async fn run(operators: &[Operator], store: MediaStore, seed: &str, bucket: &str) -> Check<()> {
    let mut checks = Vec::new();
    let mut owned = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(240), async {
        for mode in [
            ReadMode::Chunk64Kib,
            ReadMode::Chunk256Kib,
            ReadMode::Chunk1Mib,
            ReadMode::Streaming,
        ] {
            for budget in [None, Some(4096), Some(98_304)] {
                // 各条件独占对象，避免前一取消的状态污染下一对照。
                let mut data = vec![0; 3_145_801];
                for (offset, chunk) in data.chunks_mut(32).enumerate() {
                    let hash = Sha256::digest(
                        format!("{seed}:lifecycle:{mode:?}:{budget:?}:{offset}").as_bytes(),
                    );
                    chunk.copy_from_slice(&hash[..chunk.len()]);
                }
                let hash = format!("{:x}", Sha256::digest(&data));
                owned.push(hash.clone());
                operators[0]
                    .write_with(&format!("media/{hash}"), data.clone())
                    .if_not_exists(true)
                    .await
                    .map_err(storage_error)?;
                let case = Case {
                    name: budget.map_or_else(|| "full".into(), |n| format!("cancel-{n}")),
                    range: 0..data.len(),
                    consumption: budget.map_or(Consumption::Full, Consumption::Bytes),
                };
                let read =
                    measure::run_cases(store.clone().with_read_mode(mode), &hash, &data, &[case])
                        .await;
                let deletion = delete_check::delete_and_check(operators, &hash).await;
                checks.push(json!({
                    "read_mode": mode, "cancel_after_bytes": budget, "object_sha256": hash,
                    "read": read.as_ref().ok(), "read_error": read.as_ref().err(),
                    "immediate_delete": deletion
                }));
                read?;
            }
        }
        ensure(checks.len() == 12, "lifecycle_case_count")?;
        ensure(
            checks
                .iter()
                .all(|check| check["immediate_delete"]["passed"] == true),
            "lifecycle_delete_failed",
        )
    })
    .await
    .map_err(|_| "lifecycle_timeout".to_string())
    .and_then(|result| result);
    // 延后清理单独记录，成功不能覆盖即时删除的失败。
    let mut cleanup: Vec<Value> = Vec::new();
    for hash in &owned {
        if checks.iter().any(|check| {
            check["object_sha256"] == *hash && check["immediate_delete"]["passed"] == true
        }) {
            continue;
        }
        cleanup.push(delete_check::delete_and_check(operators, hash).await);
    }
    let cleaned = delete_check::outcome(&cleanup);
    println!(
        "{}",
        json!({
            "schema": "storage-cancel-lifecycle-v1", "seed": seed, "bucket": bucket,
            "passed": result.is_ok() && cleaned.is_ok(), "error": result.as_ref().err(),
            "checks": checks, "cleanup": cleanup, "cleanup_passed": cleaned.is_ok(),
            "owned_object_sha256": owned, "expected_cases": 12,
            "production_performance_claim": false
        })
    );
    result?;
    cleaned
}
