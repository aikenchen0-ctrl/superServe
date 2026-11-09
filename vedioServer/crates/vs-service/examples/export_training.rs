use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_service::learning_evidence::{
    EvidenceExportManifest, MAX_MANIFEST_BYTES, export_training_evidence,
};

fn read_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("导出输入超过预算"));
    }
    Ok(bytes)
}

fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err(io::Error::other(
            "用法：export_training <固定目录JSON> <证据清单JSON> <新训练文件>",
        ));
    }
    let catalog = read_bounded(Path::new(&args[0]), 8 * 1024 * 1024)?;
    let manifest_path = Path::new(&args[1]);
    let manifest: EvidenceExportManifest =
        serde_json::from_slice(&read_bounded(manifest_path, MAX_MANIFEST_BYTES)?)
            .map_err(|_| io::Error::other("证据清单JSON无效"))?;
    let root = manifest_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let receipt = export_training_evidence(root, &catalog, &manifest, Path::new(&args[2]))?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("学习证据导出失败：{error}");
        std::process::exit(1);
    }
}
