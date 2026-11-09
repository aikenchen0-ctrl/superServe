use std::{
    env,
    io::{self, Read},
};

use sha2::{Digest, Sha256};
use vs_core::catalog::PublicCatalog;
use vs_service::qdrant_recall::{QdrantConfig, QdrantRecall};

#[tokio::main]
async fn main() -> Result<(), io::Error> {
    let path = env::var("VS_CATALOG").map_err(|_| io::Error::other("缺少 VS_CATALOG"))?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(io::Error::other("目录超过 8 MiB"));
    }
    let catalog: PublicCatalog =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("目录 JSON 无效"))?;
    catalog
        .validate()
        .map_err(|_| io::Error::other("目录校验失败"))?;
    let client = QdrantRecall::new(
        QdrantConfig {
            endpoint: env::var("VS_QDRANT_URL")
                .map_err(|_| io::Error::other("缺少 VS_QDRANT_URL"))?,
            api_key: env::var("VS_QDRANT_API_KEY").ok(),
            scoring: vs_core::recall::RecallScoring::Positive,
        },
        format!("{:x}", Sha256::digest(&bytes)),
    )
    .map_err(io::Error::other)?;
    let receipt = client.publish(&bytes).await.map_err(io::Error::other)?;
    println!("{receipt}");
    Ok(())
}
