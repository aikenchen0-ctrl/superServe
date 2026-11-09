use std::{
    env,
    io::{self, Read},
    path::Path,
};

use vs_service::{
    model_recall_probe::{ModelRecallProbe, probe_model_recall},
    qdrant_recall::QdrantConfig,
};

#[tokio::main]
async fn main() {
    match run().await {
        Ok(true) => {}
        Ok(false) => std::process::exit(2),
        Err(error) => {
            eprintln!("模型感知召回实验失败：{error}");
            std::process::exit(1);
        }
    }
}

async fn run() -> io::Result<bool> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err(io::Error::other(
            "用法：probe_model_recall <固定配置JSON> <新报告JSON>；环境指定VS_QDRANT_URL及可选VS_QDRANT_API_KEY",
        ));
    }
    let path = Path::new(&args[0]);
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 256 * 1024 {
        return Err(io::Error::other("模型召回配置超过256KiB"));
    }
    let config: ModelRecallProbe =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("模型召回配置JSON无效"))?;
    let endpoint = QdrantConfig {
        endpoint: env::var("VS_QDRANT_URL").map_err(|_| io::Error::other("缺少VS_QDRANT_URL"))?,
        api_key: env::var("VS_QDRANT_API_KEY").ok(),
        scoring: Default::default(),
    };
    let receipt = probe_model_recall(
        path.parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
        &config,
        endpoint,
        Path::new(&args[1]),
    )
    .await?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(receipt.all_model_top_k_retained)
}
