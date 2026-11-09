use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_service::{deployment::S3DeploymentRepository, rank_model::MAX_RANK_MODEL_BYTES};
use vs_storage::S3Config;

fn required(name: &str) -> io::Result<String> {
    env::var(name).map_err(|_| io::Error::other(format!("缺少环境配置：{name}")))
}

fn read_bounded(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::Error::other("模型发布输入超过预算"));
    }
    Ok(bytes)
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err(
            io::Error::other("用法：publish_rank_model <固定目录JSON> <已训练模型JSON>").into(),
        );
    }
    let catalog = read_bounded(Path::new(&args[0]), 8 * 1024 * 1024)?;
    let model = read_bounded(Path::new(&args[1]), MAX_RANK_MODEL_BYTES)?;
    let repository = S3DeploymentRepository::new(
        S3Config {
            endpoint: required("VS_S3_ENDPOINT")?,
            region: required("VS_S3_REGION")?,
            bucket: required("VS_S3_BUCKET")?,
            access_key_id: required("VS_S3_ACCESS_KEY_ID")?,
            secret_access_key: required("VS_S3_SECRET_ACCESS_KEY")?,
        },
        5000,
    )?;
    let receipt = repository.publish_rank_model(&catalog, &model).await?;
    serde_json::to_writer_pretty(io::stdout(), &receipt)?;
    println!();
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("排序模型发布失败：{error}");
        std::process::exit(1);
    }
}
