use std::{env, path::PathBuf};

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let result = if args.len() != 3 {
        Err(
            "用法：handoff_profile_log <已停写源日志> <不存在的目标日志> <当前目录SHA256>"
                .to_string(),
        )
    } else {
        args[2]
            .to_str()
            .ok_or_else(|| "目录指纹编码无效".to_string())
            .and_then(|hash| {
                vs_service::handoff_profile_log(
                    &PathBuf::from(&args[0]),
                    &PathBuf::from(&args[1]),
                    hash,
                )
            })
            .and_then(|receipt| {
                serde_json::to_writer_pretty(std::io::stdout(), &receipt)
                    .map_err(|_| "转移收据输出失败".into())
            })
    };
    if let Err(error) = result {
        eprintln!("画像日志转移失败：{error}");
        std::process::exit(1);
    }
    println!();
}
