use std::{env, io, path::Path};

use vs_core::catalog::MediaAsset;
use vs_service::publication::publish_media_file;

fn run() -> io::Result<()> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() != 5 {
        return Err(io::Error::other(
            "用法：publish_media <已存在发布根目录> <源文件> <SHA256> <字节数> <内容类型>",
        ));
    }
    let asset = MediaAsset {
        sha256: arguments[2]
            .to_str()
            .ok_or_else(|| io::Error::other("散列编码无效"))?
            .to_string(),
        bytes: arguments[3]
            .to_str()
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| io::Error::other("字节数无效"))?,
        content_type: arguments[4]
            .to_str()
            .ok_or_else(|| io::Error::other("内容类型编码无效"))?
            .to_string(),
    };
    let receipt = publish_media_file(Path::new(&arguments[0]), Path::new(&arguments[1]), &asset)?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("媒体发布失败：{error}");
        std::process::exit(1);
    }
}
