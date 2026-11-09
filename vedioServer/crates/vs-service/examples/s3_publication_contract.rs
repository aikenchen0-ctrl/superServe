use std::{env, io::Write, sync::Arc, time::Duration};

use futures_util::StreamExt;
use opendal::{ErrorKind, Operator, services};
use serde_json::json;
use sha2::{Digest, Sha256};
use vs_core::catalog::MediaAsset;
use vs_service::deployment::{
    DeploymentCredentials, DeploymentRecall, DeploymentRecord, DeploymentSnapshot,
    DeploymentTarget, S3DeploymentRepository,
};
use vs_service::s3_catalog::S3CatalogRepository;
use vs_service::s3_publication::{Cleanup, Failure, S3PublicationConfig, S3Publisher};
use vs_storage::S3Config;

type Check<T> = Result<T, String>;
const MIB: usize = 1024 * 1024;

fn register_activation(
    keys: &mut Vec<String>,
    old: Option<&DeploymentSnapshot>,
    operation: &str,
    target: &DeploymentTarget,
    checkpoint: &vs_service::ProfileHistoryCheckpoint,
) -> Check<()> {
    let record = DeploymentRecord {
        schema: "deployment-activation-v1".into(),
        channel: "api".into(),
        generation: old.map_or(1, |old| old.record().generation + 1),
        operation_id: operation.into(),
        previous_sha256: old.map(|old| old.sha256().into()),
        target: target.clone(),
        profile_checkpoint: Some(checkpoint.clone()),
    };
    let bytes = serde_json::to_vec(&record).map_err(|_| "实验部署记录编码失败")?;
    keys.push(format!(
        "deployments/api/records/{:x}.json",
        Sha256::digest(&bytes)
    ));
    Ok(())
}

fn required(name: &str) -> Check<String> {
    env::var(name).map_err(|_| format!("缺少实验配置：{name}"))
}

fn asset(seed: &str, size: usize, path: &std::path::Path) -> Check<MediaAsset> {
    let mut file = std::io::BufWriter::with_capacity(
        64 * 1024,
        std::fs::File::create(path).map_err(|_| "合成输入创建失败")?,
    );
    let mut hash = Sha256::new();
    let mut remaining = size;
    let mut index = 0;
    while remaining > 0 {
        let digest = Sha256::digest(format!("{seed}:{index}"));
        let bytes = &digest[..remaining.min(32)];
        file.write_all(bytes).map_err(|_| "合成输入写入失败")?;
        hash.update(bytes);
        remaining -= bytes.len();
        index += 1;
    }
    file.flush().map_err(|_| "合成输入刷新失败")?;
    file.get_ref().sync_all().map_err(|_| "合成输入同步失败")?;
    Ok(MediaAsset {
        sha256: format!("{:x}", hash.finalize()),
        bytes: size as u64,
        content_type: "application/octet-stream".into(),
    })
}

async fn verify(operator: &Operator, asset: &MediaAsset) -> Check<()> {
    let mut stream = operator
        .reader_with(&asset.object_key())
        .chunk(64 * 1024)
        .concurrent(1)
        .await
        .map_err(|_| "真实对象读取器失败")?
        .into_bytes_stream(0..asset.bytes)
        .await
        .map_err(|_| "真实对象流失败")?;
    let mut hash = Sha256::new();
    let mut count = 0_u64;
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| "真实对象读取失败")?;
        count += part.len() as u64;
        hash.update(&part);
    }
    if count != asset.bytes || format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err("真实对象内容校验失败".into());
    }
    Ok(())
}

async fn run() -> Check<bool> {
    let endpoints: Vec<_> = required("VS_LAB_ENDPOINTS")?
        .split(',')
        .map(str::to_string)
        .collect();
    if !(2..=8).contains(&endpoints.len()) {
        return Err("实验要求2至8个独立回环端点".into());
    }
    for endpoint in &endpoints {
        let url = reqwest::Url::parse(endpoint).map_err(|_| "实验端点无效")?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("仅允许显式回环实验端点".into());
        }
    }
    let bucket = required("VS_LAB_BUCKET")?;
    if !bucket.starts_with("video-lab-") {
        return Err("实验只接受独立video-lab桶".into());
    }
    let access = required("VS_LAB_ACCESS_KEY")?;
    let secret = required("VS_LAB_SECRET_KEY")?;
    let directory = tempfile::tempdir().map_err(|_| "实验临时目录创建失败")?;
    let seed = format!(
        "multipart-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "时钟无效")?
            .as_nanos()
    );
    let paths: Vec<_> = (0..3)
        .map(|index| directory.path().join(format!("source-{index}")))
        .collect();
    let assets: Vec<_> = [6 * MIB + 173, 11 * MIB + 79, 31 * MIB + 137]
        .iter()
        .enumerate()
        .map(|(index, size)| asset(&format!("{seed}:{index}"), *size, &paths[index]))
        .collect::<Result<_, _>>()?;
    let config = |index: usize| S3Config {
        endpoint: endpoints[index].clone(),
        region: "us-east-1".into(),
        bucket: bucket.clone(),
        access_key_id: access.clone(),
        secret_access_key: secret.clone(),
    };
    let publishers: Vec<_> = (0..3)
        .map(|index| {
            S3Publisher::new(
                config(index % 2),
                S3PublicationConfig {
                    max_uploads: if index == 2 { 1 } else { 2 },
                    ..Default::default()
                },
            )
            .map_err(|_| "发布器配置失败".into())
        })
        .collect::<Check<_>>()?;
    let operators: Vec<_> = endpoints
        .iter()
        .map(|endpoint| {
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
            .map_err(|_| "实验读写适配失败".to_string())
        })
        .collect::<Check<_>>()?;
    let repositories: Vec<_> = (0..endpoints.len())
        .map(|index| {
            S3CatalogRepository::new(config(index), Default::default())
                .map_err(|_| "真实目录适配失败".to_string())
        })
        .collect::<Check<_>>()?;
    let catalog = |version: &str, tag: &str| {
        serde_json::to_vec(&json!({
        "version":version,"items":[
            {"id":"video","domain":"video","tags":[tag],"prior":0.5,"media_sha256":assets[0].sha256},
            {"id":"document","domain":"document","tags":[tag],"prior":0.4,"media_sha256":null}
        ],"assets":[assets[0].clone(),assets[1].clone()]
    })).map_err(|_| "合成目录编码失败".to_string())
    };
    let initial = catalog("remote-v1", "original")?;
    let competing = [
        catalog("remote-race", "left")?,
        catalog("remote-race", "right")?,
    ];
    let next = catalog("remote-v2", "next")?;
    let profile_token = format!("lab-{:x}", Sha256::digest(seed.as_bytes()));
    let profile_state = Arc::new(
        vs_service::AppState::new_with_profile_log(
            &initial,
            None,
            &profile_token,
            2,
            1,
            Some(&directory.path().join("events.jsonl")),
        )
        .map_err(|_| "实验画像状态初始化失败")?
        .into_profile_authority()
        .map_err(|_| "实验画像角色初始化失败")?,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "实验画像端口失败")?;
    let profile_endpoint = format!(
        "http://{}",
        listener.local_addr().map_err(|_| "实验画像地址失败")?
    );
    let profile_app = vs_service::router(profile_state.clone(), vs_service::Role::Profile);
    let profile_task = tokio::spawn(async move {
        let _ = axum::serve(listener, profile_app).await;
    });
    let deployments: Vec<_> = (0..endpoints.len())
        .map(|index| {
            S3DeploymentRepository::new(config(index), 5000)
                .map_err(|_| "部署仓库初始化失败".to_string())
        })
        .collect::<Check<_>>()?;
    let target = DeploymentTarget {
        rank_model_sha256: None,
        profile_minimum: None,
        catalog_version: "remote-v1".into(),
        catalog_sha256: format!("{:x}", Sha256::digest(&initial)),
        profile_authority: profile_endpoint,
        recall: DeploymentRecall::Grouped,
    };
    let profile_checkpoint = profile_state
        .profile_history_checkpoint()
        .map_err(|_| "实验画像水位读取失败")?;
    let credentials = || DeploymentCredentials {
        profile_token: profile_token.clone(),
        qdrant_api_key: None,
    };
    let mut owned_keys: Vec<_> = assets.iter().map(MediaAsset::object_key).collect();
    for bytes in [&initial, &competing[0], &competing[1], &next] {
        owned_keys.push(format!("catalogs/{:x}.json", Sha256::digest(bytes)));
    }
    for version in ["remote-v1", "remote-race", "remote-v2"] {
        owned_keys.push(format!("releases/{version}.json"));
    }
    owned_keys.push("deployments/api/active.json".into());
    let mut stages = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(180), async {
        let first = publishers[0].start_file(paths[0].clone(), assets[0].clone())
            .map_err(|_| "首次上传未接纳")?.wait().await.map_err(|error| format!("首次上传：{error}"))?;
        if !first.created { return Err("首次上传未创建独立对象".into()); }
        for operator in &operators { verify(operator, &assets[0]).await?; }
        let retry = publishers[1].start_file(paths[0].clone(), assets[0].clone())
            .map_err(|_| "重试未接纳")?.wait().await.map_err(|error| format!("重试：{error}"))?;
        if retry.created || !retry.existing_object_readback_verified { return Err("重试没有验证复用".into()); }
        stages.push(json!({"stage":"multipart-and-retry","passed":true,"first":first,"retry":retry,"readback_endpoints":operators.len()}));
        let left = publishers[0].start_file(paths[1].clone(), assets[1].clone()).map_err(|_| "竞争上传未接纳")?;
        let right = publishers[1].start_file(paths[1].clone(), assets[1].clone()).map_err(|_| "竞争上传未接纳")?;
        let (left, right) = tokio::join!(left.wait(), right.wait());
        let left = left.map_err(|error| format!("竞争左端：{error}"))?;
        let right = right.map_err(|error| format!("竞争右端：{error}"))?;
        if left.created == right.created || left.cleanup == Cleanup::Unconfirmed || right.cleanup == Cleanup::Unconfirmed {
            return Err("竞争未得到一个创建者和确认的失败方处理".into());
        }
        for operator in &operators { verify(operator, &assets[1]).await?; }
        stages.push(json!({"stage":"two-endpoint-race","passed":true,"left":left,"right":right,"readback_endpoints":operators.len()}));
        let first = repositories[0].publish(&initial).await.map_err(|error| format!("远端目录发布：{error}"))?;
        let retry = repositories[1].publish(&initial).await.map_err(|error| format!("远端目录重试：{error}"))?;
        if !first.release_created || retry.release_created || retry.catalog_created {
            return Err("远端目录未获得唯一创建与跨端点复用".into());
        }
        for repository in &repositories {
            if repository.load("remote-v1").await.map_err(|error| format!("远端目录读取：{error}"))? != initial {
                return Err("跨端点目录不一致".into());
            }
        }
        let (left, right) = tokio::join!(repositories[0].publish(&competing[0]), repositories[1].publish(&competing[1]));
        let (winner, loser) = match (left, right) {
            (Ok(_), Err(error)) => (&competing[0], error),
            (Err(error), Ok(_)) => (&competing[1], error),
            _ => return Err("异内容竞争没有产生唯一赢家".into()),
        };
        if loser.kind != vs_service::s3_catalog::CatalogFailure::Conflict {
            return Err("异内容竞争没有报告内容冲突".into());
        }
        repositories[0].publish(&next).await.map_err(|error| format!("远端新版本发布：{error}"))?;
        for repository in &repositories {
            for (version, expected) in [("remote-v1", &initial), ("remote-race", winner), ("remote-v2", &next)] {
                if repository.load(version).await.map_err(|error| format!("远端固定版本读取：{error}"))? != *expected {
                    return Err("新版本或竞争改变了既有固定版本".into());
                }
            }
        }
        stages.push(json!({"stage":"remote-catalog-release","passed":true,"first":first,"retry":retry,
            "competing_release_unique_winner":true,"loser":loser,"fixed_versions_verified":3,
            "readback_endpoints":repositories.len(),"qdrant_readiness_claim":false}));
        register_activation(&mut owned_keys, None, "activate-first", &target, &profile_checkpoint)?;
        let activation = deployments[0].activate("api",None,"activate-first",target.clone(),credentials())
            .await.map_err(|error| format!("真实部署初次激活：{error}"))?;
        let old = deployments[1].load("api").await.map_err(|error| error.to_string())?.ok_or("真实部署记录缺失")?;
        let old_left = deployments[0].load("api").await.map_err(|error| error.to_string())?.ok_or("真实左端部署记录缺失")?;
        if old_left.sha256() != old.sha256() { return Err("真实端点前版本不一致".into()); }
        let mut alternate = target.clone();
        alternate.recall = DeploymentRecall::Catalog;
        register_activation(&mut owned_keys, Some(&old), "activate-left", &target, &profile_checkpoint)?;
        register_activation(&mut owned_keys, Some(&old), "activate-right", &alternate, &profile_checkpoint)?;
        let (left,right) = tokio::join!(
            deployments[0].activate("api",Some(&old_left),"activate-left",target.clone(),credentials()),
            deployments[1].activate("api",Some(&old),"activate-right",alternate,credentials())
        );
        let loser = match (left,right) {
            (Ok(_),Err(error)) | (Err(error),Ok(_)) => error,
            _ => return Err("真实条件替换没有唯一赢家".into()),
        };
        stages.push(json!({"stage":"deployment-update-race-observation","loser":loser}));
        if loser.kind != vs_service::deployment::DeploymentFailure::Conflict {
            return Err(format!("真实条件替换没有报告前版本冲突：{loser}"));
        }
        let current = deployments[0].load("api").await.map_err(|error| error.to_string())?.ok_or("真实新部署记录缺失")?;
        if current.record().generation != 2 { return Err("真实部署代次没有前进".into()); }
        register_activation(&mut owned_keys, Some(&current), "activate-rollback", &target, &profile_checkpoint)?;
        let rollback = deployments[0].activate("api",Some(&current),"activate-rollback",target.clone(),credentials())
            .await.map_err(|error| format!("真实回退激活：{error}"))?;
        let stale = deployments[1].activate("api",Some(&old),"stale-publisher",target.clone(),credentials())
            .await.err().ok_or("真实旧发布者错误覆盖了新代次")?;
        if stale.kind != vs_service::deployment::DeploymentFailure::Conflict {
            return Err("真实旧发布者未被明确拒绝".into());
        }
        for repository in &deployments {
            let selected = repository.load("api").await.map_err(|error| error.to_string())?.ok_or("跨端点部署记录缺失")?;
            if selected.sha256() != rollback.sha256 || selected.record().generation != 3 {
                return Err("跨端点部署代次不一致".into());
            }
        }
        stages.push(json!({"stage":"deployment-conditional-activation","passed":true,
            "initial":activation,"rollback":rollback,"competing_update_unique_winner":true,
            "loser":loser,"stale_writer":stale,"readback_endpoints":deployments.len(),
            "profile_authority_verified":true,"profile_single_writer_migration_claim":false}));
        let cancelled = &publishers[2];
        let mut pending = cancelled.start_file(paths[2].clone(), assets[2].clone()).map_err(|_| "取消上传未接纳")?;
        tokio::time::timeout(Duration::from_secs(30), async {
            while cancelled.metrics().source_bytes < 11 * MIB as u64 && cancelled.metrics().active_uploads>0 {
                tokio::task::yield_now().await;
            }
        }).await.map_err(|_| "取消注入点等待超时")?;
        pending.cancel();
        let outcome = pending.wait().await;
        cancelled.shutdown().await;
        let error = outcome.map(|_| ()).err().ok_or("取消注入晚于提交，未覆盖取消案例")?;
        if error.kind != Failure::Cancelled || error.cleanup != Cleanup::AbortAcknowledged {
            return Err("真实取消清理未得到确认".into());
        }
        for operator in &operators {
            match operator.stat(&assets[2].object_key()).await {
                Err(error) if error.kind()==ErrorKind::NotFound => {}
                _ => return Err("取消对象仍可见或验证失败".into()),
            }
        }
        stages.push(json!({"stage":"cancel-after-multipart-start","passed":true,"error":error,"metrics":cancelled.metrics()}));
        Ok::<_,String>(())
    }).await.map_err(|_| "真实分段实验超时".to_string()).and_then(|value| value);
    for publisher in &publishers {
        tokio::time::timeout(Duration::from_secs(45), publisher.shutdown())
            .await
            .map_err(|_| "发布器排空超时")?;
    }
    profile_task.abort();
    let _ = profile_task.await;
    profile_state.drain_profile_writes().await;
    let mut cleanup = Vec::new();
    for key in &owned_keys {
        let deleted = tokio::time::timeout(Duration::from_secs(12), operators[0].delete(key)).await;
        let passed = matches!(deleted, Ok(Ok(())));
        cleanup.push(json!({"object_key":key,"deleted":passed}));
    }
    let cleanup_ok = cleanup.iter().all(|value| value["deleted"] == true);
    let passed = result.is_ok() && cleanup_ok;
    let report = json!({
        "schema":"s3-publication-contract-v3","data_kind":"synthetic","seed":seed,
        "endpoint_count":endpoints.len(),"assets":assets,"stages":stages,
        "passed":passed,"error":result.err(),"cleanup":cleanup,
        "publisher_metrics":publishers.iter().map(S3Publisher::metrics).collect::<Vec<_>>(),
        "incomplete_upload_listing":"由外部运行器继续核对桶的未完成上传列表",
        "performance_claim":false,"physical_cluster_tested":false
    });
    serde_json::to_writer_pretty(std::io::stdout(), &report).map_err(|_| "实验收据输出失败")?;
    println!();
    Ok(passed)
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(true) => {}
        Ok(false) => {
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("S3分段发布实验失败：{error}");
            std::process::exit(1);
        }
    }
}
