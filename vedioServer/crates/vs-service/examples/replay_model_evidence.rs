use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_service::{
    evidence_replay::{EvidenceReplayConfig, replay_model_evidence},
    learning_evidence::{EvidenceExportManifest, MAX_MANIFEST_BYTES},
};

fn read_bounded(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(io::Error::other("回放输入文件超过预算"));
    }
    Ok(bytes)
}

fn run() -> io::Result<bool> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err(io::Error::other(
            "用法：replay_model_evidence <固定目录JSON> <证据清单JSON> <回放配置JSON> <新报告JSON>",
        ));
    }
    let catalog = read_bounded(Path::new(&args[0]), 8 * 1024 * 1024)?;
    let manifest_path = Path::new(&args[1]);
    let manifest: EvidenceExportManifest =
        serde_json::from_slice(&read_bounded(manifest_path, MAX_MANIFEST_BYTES)?)
            .map_err(|_| io::Error::other("证据清单JSON无效"))?;
    let config: EvidenceReplayConfig =
        serde_json::from_slice(&read_bounded(Path::new(&args[2]), MAX_MANIFEST_BYTES)?)
            .map_err(|_| io::Error::other("回放配置JSON无效"))?;
    let root = manifest_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let receipt = replay_model_evidence(root, &catalog, &manifest, &config, Path::new(&args[3]))?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(receipt.exact
        && receipt.domain_coverage_passed != Some(false)
        && (!config
            .recall_audit
            .as_ref()
            .is_some_and(|audit| audit.require_full_retention)
            || receipt.recall_retention_passed == Some(true)))
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(2),
        Err(error) => {
            eprintln!("模型证据回放失败：{error}");
            std::process::exit(1);
        }
    }
}
