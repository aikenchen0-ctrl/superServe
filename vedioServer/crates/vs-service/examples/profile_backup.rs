use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};
use vs_service::{backup_profile_log, restore_profile_backup, verify_profile_backup};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    let valid = matches!(arguments.first().map(String::as_str), Some("create"))
        && arguments.len() == 4
        || matches!(
            arguments.first().map(String::as_str),
            Some("verify" | "restore")
        ) && arguments.len() == 5;
    if !valid {
        return Err(io::Error::other("用法：profile_backup create <目录JSON> <已停止日志> <新归档>；verify|restore <目录JSON> <归档> <固定SHA256> <暂存目录|新恢复日志>").into());
    }
    let mut catalog = Vec::new();
    File::open(&arguments[1])?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut catalog)?;
    let receipt = match arguments[0].as_str() {
        "create" => {
            backup_profile_log(Path::new(&arguments[2]), &catalog, Path::new(&arguments[3]))
        }
        "verify" => verify_profile_backup(
            Path::new(&arguments[2]),
            &catalog,
            &arguments[3],
            Path::new(&arguments[4]),
        ),
        "restore" => restore_profile_backup(
            Path::new(&arguments[2]),
            &catalog,
            &arguments[3],
            Path::new(&arguments[4]),
        ),
        _ => unreachable!(),
    }
    .map_err(io::Error::other)?;
    serde_json::to_writer_pretty(io::stdout(), &receipt)?;
    println!();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("画像备份/恢复演练失败：{error}");
        std::process::exit(1);
    }
}
