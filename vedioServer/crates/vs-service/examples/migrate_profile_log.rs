use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use vs_service::migrate_legacy_profile_log;

fn run() -> Result<(), String> {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() != 4 {
        return Err("用法：migrate_profile_log <旧日志> <新日志> <原目录文件> <原目录SHA256>；源文件保持不变，目标必须不存在。".into());
    }
    let mut catalog = Vec::new();
    File::open(&arguments[2])
        .map_err(|_| "原目录文件打开失败")?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut catalog)
        .map_err(|_| "原目录文件读取失败")?;
    let expected = arguments[3].to_str().ok_or("原目录指纹编码无效")?;
    let receipt = migrate_legacy_profile_log(
        Path::new(&arguments[0]),
        Path::new(&arguments[1]),
        &catalog,
        expected,
    )?;
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(|_| "迁移收据输出失败")?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("画像日志迁移失败：{error}");
        std::process::exit(1);
    }
}
