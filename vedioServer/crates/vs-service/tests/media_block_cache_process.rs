use std::{
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const TOKEN: &str = "media-block-cache-process-token-000000000";

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(root: &Path, catalog: &Path, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    command
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_ROLE", "media")
        .env("VS_CATALOG", catalog)
        .env("VS_STORAGE", "fs")
        .env("VS_MEDIA_ROOT", root)
        .env("VS_SERVICE_TOKEN", TOKEN)
        .env("VS_MEDIA_READ_MODE", "chunk-64k")
        .env("VS_MEDIA_CACHE_BYTES", "8388608")
        .env("VS_MEDIA_CACHE_ENTRY_BYTES", "65536")
        .env("VS_MEDIA_CACHE_FILLS", "2")
        .env_remove("VS_MEDIA_CACHE_POLICY")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn media_process_pins_explicit_block_policy_and_rejects_invalid_startup_before_listening() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir(root.join("media")).unwrap();
    let data: Vec<_> = (0..131245)
        .map(|i| ((i * 31 + i / 127) % 256) as u8)
        .collect();
    let hash = format!("{:x}", Sha256::digest(&data));
    std::fs::write(root.join("media").join(&hash), &data).unwrap();
    let catalog = root.join("catalog.json");
    std::fs::write(
        &catalog,
        serde_json::to_vec(&json!({
            "version":"block-cache-process","items":[],
            "assets":[{"sha256":hash,"bytes":data.len(),"content_type":"video/mp4"}]
        }))
        .unwrap(),
    )
    .unwrap();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let mut receipts = Vec::new();
    for policy in ["exact", "block-64k", "block-64k-stream"] {
        let port = port();
        let mut start = command(root, &catalog, port);
        if policy != "exact" {
            start.env("VS_MEDIA_CACHE_POLICY", policy);
        }
        let mut process = Process(start.spawn().unwrap());
        let pid = process.0.id();
        let endpoint = format!("http://127.0.0.1:{port}");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(process.0.try_wait().unwrap().is_none(), "媒体进程提前退出");
            if client
                .get(format!("{endpoint}/readyz"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            assert!(Instant::now() < deadline, "媒体进程启动超时");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for start in [17, 1024] {
            let end = start + 8192;
            let response = client
                .get(format!("{endpoint}/v1/media/{hash}"))
                .bearer_auth(TOKEN)
                .header("range", format!("bytes={start}-{}", end - 1))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
            assert_eq!(
                response.headers()["content-range"],
                format!("bytes {start}-{}/{}", end - 1, data.len())
            );
            assert_eq!(response.bytes().await.unwrap().as_ref(), &data[start..end]);
        }
        let metrics = client
            .get(format!("{endpoint}/v1/metrics"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(metrics["media_cache"]["policy"], policy);
        assert_eq!(
            metrics["media_cache"]["fills_completed"],
            if policy == "exact" { 2 } else { 1 }
        );
        assert_eq!(
            metrics["media_cache"]["fill_received_bytes"],
            if policy == "exact" { 16384 } else { 65536 }
        );
        assert_eq!(metrics["media_cache"]["active_fills"], 0);
        drop(process);
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
        );
        receipts.push(json!({"policy":policy,"pid":pid,"port":port,
            "cache":metrics["media_cache"],"listener_remaining":false,"body_correct":true}));
    }
    let mut rejected = Vec::new();
    for (name, capacity, entry, policy) in [
        ("disabled", "0", "65536", "block-64k"),
        ("undersized", "8388608", "32768", "block-64k"),
        ("stream-disabled", "0", "65536", "block-64k-stream"),
        ("stream-undersized", "8388608", "32768", "block-64k-stream"),
        ("unknown", "8388608", "65536", "block"),
    ] {
        let port = port();
        let mut process = Process(
            command(root, &catalog, port)
                .env("VS_MEDIA_CACHE_BYTES", capacity)
                .env("VS_MEDIA_CACHE_ENTRY_BYTES", entry)
                .env("VS_MEDIA_CACHE_POLICY", policy)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "无效配置未及时退出");
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert!(!status.success());
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
        );
        let mut message = String::new();
        process
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut message)
            .unwrap();
        rejected.push(json!({"case":name,"status":status.code(),"stderr":message,
            "listener_remaining":false}));
    }
    if let Some(output) = std::env::var_os("VS_TEST_MEDIA_BLOCK_OUTPUT") {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(output)
            .unwrap();
        serde_json::to_writer_pretty(
            &mut file,
            &json!({
                "schema":"media-block-cache-process-contract-v1",
                "successful_processes":receipts,"rejected_configurations":rejected,
                "scope":"同机独立Rust服务和本地文件对象；不是物理多机或真实S3集群"
            }),
        )
        .unwrap();
    }
}
