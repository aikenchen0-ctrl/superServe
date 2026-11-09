use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_core::training_split::TemporalSplitConfig;
use vs_service::rank_model::{
    MAX_TRAINING_BYTES, train_and_publish_rank_model, train_and_publish_temporal_rank_model,
};

fn read_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("输入文件超过预算"));
    }
    Ok(bytes)
}

fn run() -> io::Result<()> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if !(3..=4).contains(&arguments.len()) {
        return Err(io::Error::other(
            "用法：train_ranker <固定目录JSON> <冻结训练样本JSON> <新模型文件> [固定时间切分配置JSON]",
        ));
    }
    let catalog = read_bounded(Path::new(&arguments[0]), 8 * 1024 * 1024)?;
    let training = read_bounded(Path::new(&arguments[1]), MAX_TRAINING_BYTES)?;
    let receipt = if let Some(path) = arguments.get(3) {
        let config: TemporalSplitConfig =
            serde_json::from_slice(&read_bounded(Path::new(path), 4096)?)
                .map_err(|_| io::Error::other("时间切分配置JSON无效"))?;
        train_and_publish_temporal_rank_model(
            &catalog,
            &training,
            &config,
            Path::new(&arguments[2]),
        )?
    } else {
        train_and_publish_rank_model(&catalog, &training, Path::new(&arguments[2]))?
    };
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("排序模型训练发布失败：{error}");
        std::process::exit(1);
    }
}
