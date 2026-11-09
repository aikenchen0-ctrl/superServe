use std::{env, io::Read};

use vs_service::deployment::{
    DeploymentActivation, DeploymentCredentials, DeploymentTarget, S3DeploymentRepository,
};
use vs_storage::S3Config;

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("缺少环境配置：{name}"))
}

async fn run() -> Result<(), String> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err(
            "用法：activate_deployment <通道> <前版本SHA256或none> <操作ID> <目标JSON文件>".into(),
        );
    }
    let channel = args[0].to_str().ok_or("通道编码无效")?;
    let predecessor = args[1].to_str().ok_or("前版本编码无效")?;
    let operation_id = args[2].to_str().ok_or("操作ID编码无效")?;
    let mut bytes = Vec::new();
    std::fs::File::open(&args[3])
        .map_err(|_| "目标文件打开失败")?
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| "目标文件读取失败")?;
    if bytes.len() > 8192 {
        return Err("目标文件超过8KiB".into());
    }
    let target: DeploymentTarget =
        serde_json::from_slice(&bytes).map_err(|_| "部署目标JSON无效")?;
    let repository = S3DeploymentRepository::new(
        S3Config {
            endpoint: required("VS_S3_ENDPOINT")?,
            region: required("VS_S3_REGION")?,
            bucket: required("VS_S3_BUCKET")?,
            access_key_id: required("VS_S3_ACCESS_KEY_ID")?,
            secret_access_key: required("VS_S3_SECRET_ACCESS_KEY")?,
        },
        5000,
    )
    .map_err(|error| error.to_string())?;
    let current = repository
        .load(channel)
        .await
        .map_err(|error| error.to_string())?;
    let expected_sha = if predecessor == "none" {
        None
    } else {
        Some(predecessor)
    };
    let receipt = if let Some(current) = current.as_ref().filter(|current| {
        current.record().operation_id == operation_id
            && current.record().target == target
            && current.record().previous_sha256.as_deref() == expected_sha
    }) {
        DeploymentActivation {
            record: current.record().clone(),
            sha256: current.sha256().to_owned(),
            write_acknowledged: false,
            reconciled_by_readback: true,
        }
    } else {
        if current.as_ref().map(|current| current.sha256()) != expected_sha {
            return Err("当前部署选择与指定前版本不符，请先核对，不自动改用新版本重试".into());
        }
        repository
            .activate(
                channel,
                current.as_ref(),
                operation_id,
                target,
                DeploymentCredentials {
                    profile_token: required("VS_PROFILE_AUTHORITY_TOKEN")?,
                    qdrant_api_key: env::var("VS_QDRANT_API_KEY").ok(),
                },
            )
            .await
            .map_err(|error| {
                let _ = serde_json::to_writer(std::io::stderr(), &error);
                eprintln!();
                error.to_string()
            })?
    };
    serde_json::to_writer_pretty(std::io::stdout(), &receipt).map_err(|_| "部署收据输出失败")?;
    println!();
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("部署选择失败：{error}");
        std::process::exit(1);
    }
}
