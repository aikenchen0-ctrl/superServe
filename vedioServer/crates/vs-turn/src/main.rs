use std::{
    io::{self, Read, Write},
    path::PathBuf,
};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> io::Result<()> {
    let path = PathBuf::from(
        std::env::var_os("VS_TURN_CONFIG")
            .ok_or_else(|| io::Error::other("必须指定TURN配置绝对路径"))?,
    );
    if !path.is_absolute() {
        return Err(io::Error::other("TURN配置须为绝对路径"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(16_385)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16_384 {
        return Err(io::Error::other("TURN配置超过16KiB"));
    }
    let config: vs_turn::TurnConfig =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("TURN配置格式无效"))?;
    let supervised = match std::env::var_os("VS_TURN_STOP_ON_STDIN_EOF") {
        None => false,
        Some(value) if value == "1" => true,
        Some(_) => return Err(io::Error::other("TURN管道停机开关只允许1或不设置")),
    };
    let (closed, mut parent) = tokio::sync::oneshot::channel();
    if supervised {
        // 独立线程避免阻塞运行时；即使父管道未关闭，全局到期仍可退出进程。
        std::thread::Builder::new()
            .name("turn-parent-pipe".into())
            .spawn(move || {
                let result = match io::stdin().read(&mut [0; 1]) {
                    Ok(0) => Ok(()),
                    _ => Err(io::Error::other("TURN父管道只允许关闭，不接受命令数据")),
                };
                let _ = closed.send(result);
            })?;
    }
    let until = config.expires_unix_seconds;
    let server = vs_turn::TurnHandle::start(config).await?;
    let bind = server.bind();
    let pid = std::process::id();
    println!(
        "{}",
        serde_json::json!({"schema":"turn-lab-ready-v1","pid":pid,"bind":bind,
            "expires_unix_seconds":until,"shutdown_on_stdin_eof":supervised})
    );
    io::stdout().flush()?;
    let mut failed = false;
    let reason = loop {
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                failed = result.is_err();
                break "ctrl_c";
            },
            result = &mut parent, if supervised => {
                if matches!(result, Ok(Ok(()))) { break "stdin_eof"; }
                failed = true;
                break "stdin_error";
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                if server.is_finished() { break "expired"; }
            }
        }
    };
    let stats = server.shutdown().await?;
    println!(
        "{}",
        serde_json::json!({"schema":"turn-lab-stopped-v1","pid":pid,"bind":bind,
            "reason":reason,"stats":stats})
    );
    io::stdout().flush()?;
    if failed {
        return Err(io::Error::other("TURN停机输入异常，已回收资源"));
    }
    Ok(())
}
