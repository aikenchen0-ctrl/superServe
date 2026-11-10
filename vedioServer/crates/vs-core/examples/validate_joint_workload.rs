use std::{
    env,
    fs::File,
    io::{self, Read},
    path::Path,
};

use serde_json::json;
use vs_core::joint_workload::JointWorkload;

const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;

fn read_input(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(io::Error::other("联合工作负载超过16MiB"));
    }
    Ok(bytes)
}

fn run() -> io::Result<bool> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let require_closed = args.get(1).is_some_and(|value| value == "--require-closed");
    let expected_args = if require_closed { 2 } else { 1 };
    if args.len() != expected_args {
        return Err(io::Error::other(
            "用法：validate_joint_workload <联合工作负载JSON> [--require-closed]",
        ));
    }

    let bytes = read_input(Path::new(&args[0]))?;
    let workload: JointWorkload =
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("联合工作负载JSON无效"))?;
    let ordinary = workload
        .validate()
        .map_err(|error| io::Error::other(format!("普通校验拒绝：{error}")))?;
    let closed = workload.validate_closed_path();
    let closed_result = match &closed {
        Ok(summary) => json!({"passed":true,"summary":summary}),
        Err(error) => json!({"passed":false,"reason":error.to_string()}),
    };
    let receipt = json!({
        "schema":"joint-workload-validation-v1",
        "ordinary":{"passed":true,"summary":ordinary},
        "closed_path":closed_result,
        "require_closed":require_closed,
        "production_quality_claim":false,
        "scope":"输入关系和数据分域校验；不证明真实观看、推荐质量、线路字节、性能或物理集群"
    });
    serde_json::to_writer_pretty(io::stdout(), &receipt).map_err(io::Error::other)?;
    println!();
    Ok(!require_closed || closed.is_ok())
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("联合工作负载闭合门未通过，已输出结构化回执。\n");
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("联合工作负载校验失败：{error}");
            std::process::exit(1);
        }
    }
}
