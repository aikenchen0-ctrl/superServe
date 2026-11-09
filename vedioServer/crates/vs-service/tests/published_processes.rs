use std::{
    collections::HashSet,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::catalog::MediaAsset;
use vs_service::publication::{publish_catalog, publish_media_file};

const TOKEN: &str = "published-replica-test-token-0000000000";

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(root: &Path, version: &str, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    for name in [
        "VS_CATALOG",
        "VS_PROFILE_EVENT_LOG",
        "VS_PROFILE_AUTHORITY_URL",
        "VS_PROFILE_AUTHORITY_TOKEN",
        "VS_QDRANT_URL",
    ] {
        command.env_remove(name);
    }
    command
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_ROLE", "all")
        .env("VS_SERVICE_TOKEN", TOKEN)
        .env("VS_PUBLICATION_ROOT", root)
        .env("VS_CATALOG_RELEASE", version)
        .env("VS_STORAGE", "fs")
        .env("VS_MEDIA_ROOT", root)
        .env("VS_MEDIA_CACHE_BYTES", "1048576")
        .env("VS_MEDIA_CACHE_ENTRY_BYTES", "65536")
        .env("VS_MEDIA_CACHE_FILLS", "2")
        .env("VS_RECALL_BACKEND", "grouped")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

async fn ready(client: &Client, port: u16, process: &mut Process) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(process.0.try_wait().unwrap().is_none(), "发布副本提前退出");
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{port}/readyz"))
            .bearer_auth(TOKEN)
            .send()
            .await
            && response.status().is_success()
        {
            return response.json().await.unwrap();
        }
        assert!(Instant::now() < deadline, "发布副本启动超时");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn pinned_releases_run_on_two_processes_and_new_release_does_not_move_old_reader() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("published");
    std::fs::create_dir(&root).unwrap();
    let source = directory.path().join("input.bin");
    let data: Vec<u8> = (0..131_099).map(|index| (index % 251) as u8).collect();
    std::fs::write(&source, &data).unwrap();
    let asset = MediaAsset {
        sha256: format!("{:x}", Sha256::digest(&data)),
        bytes: data.len() as u64,
        content_type: "application/octet-stream".into(),
    };
    publish_media_file(&root, &source, &asset).unwrap();
    let bytes = serde_json::to_vec(&json!({
        "version":"pinned-v1","items":[
            {"id":"old-item","domain":"video","tags":["topic"],"prior":0.5,"media_sha256":asset.sha256}
        ],"assets":[asset]
    })).unwrap();
    let publication = publish_catalog(&root, &bytes).unwrap();
    let mut ports = HashSet::new();
    while ports.len() < 3 {
        ports.insert(
            std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port(),
        );
    }
    let ports: Vec<_> = ports.into_iter().collect();
    let mut first = Process(command(&root, "pinned-v1", ports[0]).spawn().unwrap());
    let mut second = Process(command(&root, "pinned-v1", ports[1]).spawn().unwrap());
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    for (port, process) in [(ports[0], &mut first), (ports[1], &mut second)] {
        let state = ready(&client, port, process).await;
        assert_eq!(state["catalog_sha256"], publication.release.catalog_sha256);
    }
    async fn query(client: &Client, port: u16) -> Value {
        client
            .post(format!("http://127.0.0.1:{port}/v1/recommendations"))
            .bearer_auth(TOKEN)
            .json(&json!({"request_id":"published","domains":["video"],"limit":1,"profile":null}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    let original = query(&client, ports[0]).await;
    assert_eq!(original, query(&client, ports[1]).await);
    for _ in 0..2 {
        let response = client
            .get(format!(
                "http://127.0.0.1:{}/v1/media/{}",
                ports[0], asset.sha256
            ))
            .bearer_auth(TOKEN)
            .header("range", "bytes=13-4108")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.bytes().await.unwrap().as_ref(), &data[13..4109]);
    }
    let metrics: Value = client
        .get(format!("http://127.0.0.1:{}/v1/metrics", ports[0]))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(metrics["media_cache"]["fills_completed"], 1);
    assert_eq!(metrics["media_cache"]["hits"], 1);

    let mut changed: Value = serde_json::from_slice(&bytes).unwrap();
    changed["version"] = json!("pinned-v2");
    changed["items"][0]["id"] = json!("new-item");
    publish_catalog(&root, &serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(original, query(&client, ports[0]).await);
    let mut next = Process(command(&root, "pinned-v2", ports[2]).spawn().unwrap());
    ready(&client, ports[2], &mut next).await;
    assert_eq!(query(&client, ports[2]).await["items"][0]["id"], "new-item");
    drop(first);
    let mut restarted = Process(command(&root, "pinned-v1", ports[0]).spawn().unwrap());
    ready(&client, ports[0], &mut restarted).await;
    assert_eq!(original, query(&client, ports[0]).await);
    drop((restarted, second, next));
}

#[test]
fn publication_configuration_rejects_ambiguous_or_mismatched_roots() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("published");
    let other = directory.path().join("other");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&other).unwrap();
    publish_catalog(
        &root,
        br#"{"version":"configured-v1","items":[],"assets":[]}"#,
    )
    .unwrap();
    for (mode, expected) in [
        ("mixed-catalog", "固定发布版本与VS_CATALOG不能同时配置"),
        ("wrong-root", "媒体根目录必须与发布根目录一致"),
        ("incomplete", "必须同时有效配置"),
        ("s3", "仅支持本地文件存储"),
    ] {
        let mut configured = command(&root, "configured-v1", 0);
        match mode {
            "mixed-catalog" => {
                configured.env("VS_CATALOG", "examples/catalog.json");
            }
            "wrong-root" => {
                configured.env("VS_MEDIA_ROOT", &other);
            }
            "incomplete" => {
                configured.env_remove("VS_CATALOG_RELEASE");
            }
            "s3" => {
                configured.env("VS_STORAGE", "s3");
            }
            _ => unreachable!(),
        }
        let mut child = configured.stderr(Stdio::piped()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("错误配置未拒绝：{mode}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success(), "{mode}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "{mode}"
        );
    }
}
