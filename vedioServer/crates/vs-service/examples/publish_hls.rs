use std::{env, io, path::Path};

use vs_service::hls::{HlsLayout, publish_hls_with_layout};

fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if !(5..=6).contains(&args.len()) {
        return Err(io::Error::other(
            "用法：publish_hls <已存在发布根目录> <源MP4> <目录版本> <候选标识> <目标秒数1至6> [片内目标毫秒100至1000]",
        ));
    }
    let text = |index: usize| {
        args[index]
            .to_str()
            .ok_or_else(|| io::Error::other("参数编码无效"))
    };
    let seconds = text(4)?
        .parse()
        .map_err(|_| io::Error::other("分片时长无效"))?;
    let layout = if args.len() == 6 {
        HlsLayout::Chunked {
            target_ms: text(5)?
                .parse()
                .map_err(|_| io::Error::other("片内时长无效"))?,
        }
    } else {
        HlsLayout::Single
    };
    let receipt = publish_hls_with_layout(
        Path::new(&args[0]),
        Path::new(&args[1]),
        text(2)?,
        text(3)?,
        seconds,
        layout,
    )?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("HLS发布失败：{error}");
        std::process::exit(1);
    }
}
