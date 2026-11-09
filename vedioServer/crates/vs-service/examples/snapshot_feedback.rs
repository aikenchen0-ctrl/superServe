use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};
use vs_service::feedback_log::{IggyFeedbackConfig, IggyFeedbackLog};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("反馈快照失败：{error}");
        std::process::exit(1);
    }
}

async fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let preserve_raw = args.len() == 5 && args[4] == "--raw-evidence";
    if args.len() != 4 && !preserve_raw {
        return Err(io::Error::other(
            "用法：snapshot_feedback <配置JSON> <起始偏移> <排他结束偏移> <新归档JSON> [--raw-evidence]",
        ));
    }
    let mut bytes = Vec::new();
    File::open(&args[0])?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        return Err(io::Error::other("反馈配置超过64KiB"));
    }
    let config: IggyFeedbackConfig =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("反馈配置JSON无效"))?;
    let token =
        env::var("VS_FEEDBACK_IGGY_TOKEN").map_err(|_| io::Error::other("缺少Iggy读取凭证"))?;
    let start: u64 = args[1]
        .to_str()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| io::Error::other("起始偏移无效"))?;
    let end: u64 = args[2]
        .to_str()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| io::Error::other("结束偏移无效"))?;
    let log = IggyFeedbackLog::new(config, token).map_err(io::Error::other)?;
    if preserve_raw {
        let receipt = log
            .snapshot_evidence(start, end, Path::new(&args[3]))
            .await?;
        serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    } else {
        let receipt = log.snapshot(start, end, Path::new(&args[3])).await?;
        serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    }
    println!();
    Ok(())
}
