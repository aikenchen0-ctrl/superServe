use std::{env, path::PathBuf};

use vs_core::catalog::MediaAsset;
use vs_service::s3_publication::{S3PublicationConfig, S3Publisher};
use vs_storage::S3Config;

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("缺少环境配置：{name}"))
}

async fn run() -> Result<(), String> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() != 4 {
        return Err("用法：publish_s3_media <源文件> <SHA256> <字节数> <内容类型>；S3配置由VS_S3_*环境提供。".into());
    }
    let asset = MediaAsset {
        sha256: arguments[1].to_str().ok_or("散列编码无效")?.into(),
        bytes: arguments[2]
            .to_str()
            .and_then(|value| value.parse().ok())
            .ok_or("字节数无效")?,
        content_type: arguments[3].to_str().ok_or("内容类型编码无效")?.into(),
    };
    let publisher = S3Publisher::new(
        S3Config {
            endpoint: required("VS_S3_ENDPOINT")?,
            region: required("VS_S3_REGION")?,
            bucket: required("VS_S3_BUCKET")?,
            access_key_id: required("VS_S3_ACCESS_KEY_ID")?,
            secret_access_key: required("VS_S3_SECRET_ACCESS_KEY")?,
        },
        S3PublicationConfig::default(),
    )
    .map_err(|error| error.to_string())?;
    let handle = publisher
        .start_file(PathBuf::from(&arguments[0]), asset)
        .map_err(|error| error.to_string())?;
    let outcome = handle.wait().await;
    publisher.shutdown().await;
    match outcome {
        Ok(receipt) => {
            serde_json::to_writer_pretty(std::io::stdout(), &receipt)
                .map_err(|_| "收据输出失败")?;
            println!();
            Ok(())
        }
        Err(error) => {
            let _ = serde_json::to_writer(std::io::stderr(), &error);
            eprintln!();
            Err(error.to_string())
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("S3媒体发布失败：{error}");
        std::process::exit(1);
    }
}
