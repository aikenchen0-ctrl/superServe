use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_service::publication::publish_catalog;

fn run() -> io::Result<()> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() != 2 {
        return Err(io::Error::other(
            "用法：publish_catalog <已存在发布根目录> <目录JSON文件>",
        ));
    }
    let mut bytes = Vec::new();
    File::open(&arguments[1])?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    let receipt = publish_catalog(Path::new(&arguments[0]), &bytes)?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("目录发布失败：{error}");
        std::process::exit(1);
    }
}
