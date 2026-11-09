use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_service::consumption_replay::{ConsumptionReplayConfig, replay_consumption_evidence};

fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err(io::Error::other(
            "用法：replay_consumption <固定配置JSON> <新报告JSON>",
        ));
    }
    let path = Path::new(&args[0]);
    let mut bytes = Vec::new();
    File::open(path)?.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(io::Error::other("消费重建配置超过4KiB"));
    }
    let config: ConsumptionReplayConfig =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("消费重建配置JSON无效"))?;
    let root = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let receipt = replay_consumption_evidence(root, &config, Path::new(&args[1]))?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(reason) = run() {
        eprintln!("消费证据重建失败：{reason}");
        std::process::exit(1);
    }
}
