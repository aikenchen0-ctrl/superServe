use std::{env, io::Read};

use vs_service::s3_catalog::S3CatalogRepository;
use vs_storage::S3Config;

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("缺少环境配置：{name}"))
}

async fn run() -> Result<(), String> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() != 1 {
        return Err("用法：publish_s3_catalog <目录JSON>；S3配置由VS_S3_*环境提供。".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&arguments[0])
        .map_err(|_| "目录文件打开失败")?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "目录文件读取失败")?;
    let repository = S3CatalogRepository::new(
        S3Config {
            endpoint: required("VS_S3_ENDPOINT")?,
            region: required("VS_S3_REGION")?,
            bucket: required("VS_S3_BUCKET")?,
            access_key_id: required("VS_S3_ACCESS_KEY_ID")?,
            secret_access_key: required("VS_S3_SECRET_ACCESS_KEY")?,
        },
        Default::default(),
    )
    .map_err(|error| error.to_string())?;
    match repository.publish(&bytes).await {
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
        eprintln!("S3目录发布失败：{error}");
        std::process::exit(1);
    }
}
