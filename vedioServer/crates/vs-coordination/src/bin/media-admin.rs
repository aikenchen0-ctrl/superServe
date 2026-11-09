use serde::de::DeserializeOwned;
use std::{
    env,
    fs::File,
    io::{self, Read, Write},
    path::Path,
};
use vs_coordination::{
    media_admin::{MaintenanceOutcome, MediaAdmin, MediaAdminConfig},
    media_registry::MediaNodeCommand,
};

fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<T> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 {
        return Err(io::Error::other("维护配置或命令文件超过16KiB"));
    }
    serde_json::from_slice(&bytes).map_err(|_| io::Error::other("维护配置或命令JSON无效"))
}

async fn run() -> io::Result<i32> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err(io::Error::other(
            "用法：media-admin <配置JSON> preview <节点ID>，或media-admin <配置JSON> apply|confirm <命令JSON>",
        ));
    }
    let client = MediaAdmin::new(read_json::<MediaAdminConfig>(Path::new(&args[0]))?)?;
    let mode = args[1]
        .to_str()
        .ok_or_else(|| io::Error::other("维护操作编码无效"))?;
    let value;
    let exit;
    if mode == "preview" {
        let id = args[2]
            .to_str()
            .ok_or_else(|| io::Error::other("节点标识编码无效"))?;
        value = serde_json::to_value(client.preview(id).await?)?;
        exit = 0;
    } else {
        let command: MediaNodeCommand = read_json(Path::new(&args[2]))?;
        let receipt = match mode {
            "apply" => client.apply(command).await?,
            "confirm" => client.confirm(command).await?,
            _ => return Err(io::Error::other("维护操作仅支持preview、apply或confirm")),
        };
        exit = match receipt.outcome {
            MaintenanceOutcome::Confirmed => 0,
            MaintenanceOutcome::Unknown => 3,
            _ => 2,
        };
        value = serde_json::to_value(receipt)?;
    }
    let mut output = io::stdout().lock();
    serde_json::to_writer_pretty(&mut output, &value)?;
    writeln!(output)?;
    Ok(exit)
}

#[tokio::main]
async fn main() {
    let exit = match run().await {
        Ok(exit) => exit,
        Err(error) => {
            eprintln!("媒体维护操作失败：{error}");
            1
        }
    };
    std::process::exit(exit);
}
