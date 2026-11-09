use std::io;

use opendal::{Operator, services};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), io::Error> {
    let directory = tempfile::tempdir()?;
    let root = directory.path().join("objects");
    let staging = directory.path().join("staging");
    std::fs::create_dir(&root)?;
    std::fs::create_dir(&staging)?;
    let root = root
        .to_str()
        .ok_or_else(|| io::Error::other("夹具根目录编码无效"))?;
    let staging = staging
        .to_str()
        .ok_or_else(|| io::Error::other("夹具暂存目录编码无效"))?;
    let map = io::Error::other;
    let direct = Operator::new(services::Fs::default().root(root)).map_err(map)?;
    let mut writer = direct
        .writer_with("direct.bin")
        .if_not_exists(true)
        .chunk(64 * 1024)
        .await
        .map_err(map)?;
    let direct_visible_before_write = direct.exists("direct.bin").await.map_err(map)?;
    writer
        .write(vec![7_u8; 128 * 1024 + 13])
        .await
        .map_err(map)?;
    let direct_visible_before_close = direct.exists("direct.bin").await.map_err(map)?;
    writer.close().await.map_err(map)?;

    let atomic =
        Operator::new(services::Fs::default().root(root).atomic_write_dir(staging)).map_err(map)?;
    // 两个写者均在最终目标不存在时创建；关闭顺序固定，不依赖随机调度。
    let mut first = atomic
        .writer_with("race.bin")
        .if_not_exists(true)
        .await
        .map_err(map)?;
    let mut second = atomic
        .writer_with("race.bin")
        .if_not_exists(true)
        .await
        .map_err(map)?;
    first.write("first-value").await.map_err(map)?;
    second.write("second-value").await.map_err(map)?;
    let atomic_visible_before_close = atomic.exists("race.bin").await.map_err(map)?;
    first.close().await.map_err(map)?;
    let after_first = atomic.read("race.bin").await.map_err(map)?.to_vec();
    let second_result = second.close().await;
    let second_succeeded = second_result.is_ok();
    let second_error = second_result
        .err()
        .map(|error| format!("{:?}", error.kind()));
    let final_bytes = atomic.read("race.bin").await.map_err(map)?.to_vec();
    let report = json!({
        "schema":"fs-publication-probe-v1","backend":"opendal-service-fs 0.59.5",
        "data_kind":"synthetic","direct_visible_before_write":direct_visible_before_write,
        "direct_visible_before_close":direct_visible_before_close,
        "atomic_visible_before_close":atomic_visible_before_close,
        "first_close_value":String::from_utf8_lossy(&after_first),
        "second_close_succeeded":second_succeeded,"second_close_error":second_error,
        "final_value":String::from_utf8_lossy(&final_bytes),
        "second_replaced_first":second_succeeded && after_first!=final_bytes,
        "production_data_used":false,"physical_cluster_tested":false,
        "interpretation":"此探针记录本机发布包实际语义，不将Fs存在性条件外推为S3或不可覆盖发布保证。"
    });
    serde_json::to_writer_pretty(io::stdout(), &report).map_err(io::Error::other)?;
    println!();
    Ok(())
}
