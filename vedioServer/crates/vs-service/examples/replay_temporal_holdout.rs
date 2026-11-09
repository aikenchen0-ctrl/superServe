use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_service::temporal_replay::{TemporalReplayConfig, replay_temporal_holdout};

fn bounded(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::Error::other("留出回放输入超出预算"));
    }
    Ok(bytes)
}

fn run() -> io::Result<bool> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err(io::Error::other(
            "用法：replay_temporal_holdout <固定目录JSON> <固定回放配置JSON> <新报告JSON>",
        ));
    }
    let catalog = bounded(Path::new(&args[0]), 8 * 1024 * 1024)?;
    let path = Path::new(&args[1]);
    let config: TemporalReplayConfig = serde_json::from_slice(&bounded(path, 256 * 1024)?)
        .map_err(|_| io::Error::other("固定留出回放配置JSON无效"))?;
    let root = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let receipt = replay_temporal_holdout(root, &catalog, &config, Path::new(&args[2]))?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(receipt.domain_coverage_passed != Some(false))
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(2),
        Err(reason) => {
            eprintln!("固定留出回放失败：{reason}");
            std::process::exit(1);
        }
    }
}
