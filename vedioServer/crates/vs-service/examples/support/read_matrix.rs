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

fn cases(size: usize) -> Vec<Case> {
    vec![
        Case {
            name: "prefix".into(),
            range: 0..4096,
            consumption: Consumption::Full,
        },
        Case {
            name: "unaligned".into(),
            range: 17..65_590,
            consumption: Consumption::Full,
        },
        Case {
            name: "tail".into(),
            range: size - 8192..size,
            consumption: Consumption::Full,
        },
        Case {
            name: "full".into(),
            range: 0..size,
            consumption: Consumption::Full,
        },
        Case {
            name: "cancel-4k".into(),
            range: 0..size,
            consumption: Consumption::Bytes(4096),
        },
        Case {
            name: "cancel-96k".into(),
            range: 0..size,
            consumption: Consumption::Bytes(98_304),
        },
        Case {
            name: "cancel-half".into(),
            range: 0..size,
            consumption: Consumption::Bytes(size / 2),
        },
    ]
}

pub async fn run(operators: &[Operator], store: MediaStore, seed: &str, bucket: &str) -> Check<()> {
    // 数据规模和消费预算先固定；第三对象只用于留出检查，不按其结果改参数。
    let objects: Vec<_> = [393_241, 3_145_801, 5_243_871]
        .into_iter()
        .enumerate()
        .map(|(index, size)| {
            let mut data = vec![0; size];
            for (offset, chunk) in data.chunks_mut(32).enumerate() {
                let hash = Sha256::digest(format!("{seed}:matrix:{index}:{offset}").as_bytes());
                chunk.copy_from_slice(&hash[..chunk.len()]);
            }
            let hash = format!("{:x}", Sha256::digest(&data));
            (hash, data)
        })
        .collect();
    let modes = [
        ReadMode::Chunk64Kib,
        ReadMode::Chunk256Kib,
        ReadMode::Chunk1Mib,
        ReadMode::Streaming,
    ];
    let mut groups: Vec<Value> = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(300), async {
        for (object_index, (hash, data)) in objects.iter().enumerate() {
            operators[0]
                .write_with(&format!("media/{hash}"), data.clone())
                .if_not_exists(true)
                .await
                .map_err(storage_error)?;
            let cases = cases(data.len());
            for repetition in 0..2 {
                // 改变执行顺序，减轻固定先后顺序的偏差；缓存状态仍不能视为受控。
                for slot in 0..modes.len() {
                    let index = if repetition == 0 {
                        slot
                    } else {
                        modes.len() - 1 - slot
                    };
                    let mode = modes[(index + object_index) % modes.len()];
                    let mut group =
                        measure::run_cases(store.clone().with_read_mode(mode), hash, data, &cases)
                            .await?;
                    group["object_index"] = json!(object_index);
                    group["partition"] = json!(if object_index == 2 {
                        "holdout"
                    } else {
                        "exploration"
                    });
                    group["repetition"] = json!(repetition);
                    groups.push(group);
                }
            }
        }
        ensure(groups.len() == 24, "read_matrix_group_count")
    })
    .await
    .map_err(|_| "read_matrix_timeout".to_string())
    .and_then(|result| result);
    // 各对象独立清理并记录失败阶段，首个失败不跳过其余对象。
    let mut cleanup_checks = Vec::new();
    for (hash, _) in &objects {
        cleanup_checks.push(delete_check::delete_and_check(operators, hash).await);
    }
    let cleanup = delete_check::outcome(&cleanup_checks);
    println!(
        "{}",
        json!({
            "schema": "storage-read-matrix-v1", "seed": seed, "bucket": bucket, "passed": result.is_ok() && cleanup.is_ok(),
            "owned_object_sha256": objects.iter().map(|(hash, _)| hash).collect::<Vec<_>>(),
            "error": result.as_ref().err(), "cleanup_passed": cleanup.is_ok(), "cleanup_error": cleanup.as_ref().err(),
            "cleanup_checks": cleanup_checks,
            "groups": groups, "expected_samples": 168,
            "cache_controlled": false, "cpu_measured": false, "rss_measured": false,
            "production_performance_claim": false, "concurrent_consumers": 1,
            "candidate_policy_changed_after_holdout": false
        })
    );
    result?;
    cleanup
}
