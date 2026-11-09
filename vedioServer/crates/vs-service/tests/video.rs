use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_service::{
    publication::{load_catalog_release, publish_catalog, publish_media_file},
    video::{Mp4Limits, prepare_mp4},
};

const INPUT: &[u8] = include_bytes!("fixtures/mp4/h264-aac-tail.mp4");
const TOKEN: &str = "video-contract-test-token-00000000000000";

#[test]
fn repack_preserves_media_bytes_and_already_front_loaded_input_is_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("input.mp4");
    let output = directory.path().join("output.mp4");
    fs::write(&source, INPUT).unwrap();
    let receipt = prepare_mp4(&source, &output, Mp4Limits::default()).unwrap();
    let bytes = fs::read(&output).unwrap();
    assert!(receipt.repacked);
    assert_eq!(receipt.schema, "prepared-mp4-v1");
    assert_eq!(bytes.len() as u64, receipt.asset.bytes);
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        receipt.asset.sha256
    );
    assert!(receipt.output_media_offset > receipt.input_media_offset);
    assert_eq!(
        &bytes[receipt.output_media_offset as usize..],
        &INPUT[receipt.input_media_offset as usize
            ..(receipt.input_media_offset + receipt.media_span_bytes) as usize],
    );
    assert_eq!(fs::read(&source).unwrap(), INPUT);

    let second_output = directory.path().join("second.mp4");
    let second = prepare_mp4(&output, &second_output, Mp4Limits::default()).unwrap();
    assert!(!second.repacked);
    assert_eq!(receipt.asset.sha256, second.asset.sha256);
    assert_eq!(fs::read(&second_output).unwrap(), bytes);
}

#[test]
fn invalid_or_unsupported_layout_never_publishes_partial_output() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("bad.mp4");
    let output = directory.path().join("absent.mp4");
    let moov_type = INPUT.windows(4).position(|value| value == b"moov").unwrap();
    let moov_start = moov_type - 4;
    let variants = [
        Vec::new(),
        b"not an mp4".to_vec(),
        INPUT[..INPUT.len() - 1].to_vec(),
        [INPUT, &INPUT[moov_start..]].concat(),
        [INPUT, b"\0\0\0\x08moof"].concat(),
        [INPUT, b"\0\0\0\x07free"].concat(),
        [INPUT, b"\0\0\0\x10free"].concat(),
    ];
    for data in variants {
        fs::write(&source, data).unwrap();
        assert!(prepare_mp4(&source, &output, Mp4Limits::default()).is_err());
        assert!(!output.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}

#[test]
fn budgets_reject_file_metadata_box_count_and_sparse_padding() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("input.mp4");
    let output = directory.path().join("absent.mp4");
    fs::write(&source, INPUT).unwrap();
    for limits in [
        Mp4Limits {
            max_input_bytes: INPUT.len() as u64 - 1,
            ..Default::default()
        },
        Mp4Limits {
            max_metadata_bytes: 32,
            ..Default::default()
        },
        Mp4Limits {
            max_top_level_boxes: 1,
            ..Default::default()
        },
        Mp4Limits {
            max_top_level_boxes: 0,
            ..Default::default()
        },
    ] {
        assert!(prepare_mp4(&source, &output, limits).is_err());
        assert!(!output.exists());
    }
    // 稀疏填充只分配文件长度；预检必须在上游可能分配同等大小前缀之前拒绝。
    let free_size = 16_u32 * 1024 * 1024;
    let mut header = free_size.to_be_bytes().to_vec();
    header.extend_from_slice(b"free");
    fs::write(&source, header).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_len(free_size as u64)
        .unwrap();
    let error = prepare_mp4(&source, &output, Mp4Limits::default()).unwrap_err();
    assert!(error.to_string().contains("元数据预算"));
    assert!(!output.exists());
}

#[test]
fn existing_output_and_input_file_are_never_overwritten() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("input.mp4");
    let output = directory.path().join("existing.mp4");
    fs::write(&source, INPUT).unwrap();
    fs::write(&output, b"existing").unwrap();
    assert!(prepare_mp4(&source, &output, Mp4Limits::default()).is_err());
    assert!(prepare_mp4(&source, &source, Mp4Limits::default()).is_err());
    assert_eq!(fs::read(&output).unwrap(), b"existing");
    assert_eq!(fs::read(&source).unwrap(), INPUT);
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
}

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn server(root: &Path, port: u16) -> Process {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    // 隔离运行环境，避免本机其他实验改变本次固定版本的行为。
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("VS_") {
            command.env_remove(name);
        }
    }
    command
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_ROLE", "all")
        .env("VS_SERVICE_TOKEN", TOKEN)
        .env("VS_PUBLICATION_ROOT", root)
        .env("VS_CATALOG_RELEASE", "video-contract-v1")
        .env("VS_STORAGE", "fs")
        .env("VS_MEDIA_ROOT", root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Process(command.spawn().unwrap())
}

#[tokio::test]
async fn prepared_video_is_recommended_and_delivered_by_real_http_process() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("published");
    fs::create_dir(&root).unwrap();
    let source = directory.path().join("input.mp4");
    let output = directory.path().join("output.mp4");
    fs::write(&source, INPUT).unwrap();
    let prepared = prepare_mp4(&source, &output, Mp4Limits::default()).unwrap();
    publish_media_file(&root, &output, &prepared.asset).unwrap();
    let catalog = serde_json::to_vec(&json!({
        "version": "video-contract-v1",
        "items": [{"id":"clip", "domain":"video", "tags":[], "prior":0.5,
            "media_sha256":prepared.asset.sha256}],
        "assets": [prepared.asset]
    }))
    .unwrap();
    publish_catalog(&root, &catalog).unwrap();
    assert_eq!(
        load_catalog_release(&root, "video-contract-v1").unwrap(),
        catalog
    );
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut process = server(&root, port);
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(process.0.try_wait().unwrap().is_none(), "视频服务提前退出");
        if let Ok(response) = client
            .get(format!("{base}/readyz"))
            .bearer_auth(TOKEN)
            .send()
            .await
            && response.status().is_success()
        {
            break;
        }
        assert!(Instant::now() < deadline, "视频服务启动超时");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let recommendations: Value = client
        .post(format!("{base}/v1/recommendations"))
        .bearer_auth(TOKEN)
        .json(&json!({"request_id":"video-contract","domains":["video"],"limit":1,"profile":null}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        recommendations["items"][0]["media_path"],
        format!("/v1/media/{}", prepared.asset.sha256)
    );
    let url = format!("{base}/v1/media/{}", prepared.asset.sha256);
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let prefix_end = prepared.output_media_offset - 1;
    let prefix = client
        .get(&url)
        .bearer_auth(TOKEN)
        .header("range", format!("bytes=0-{prefix_end}"))
        .send()
        .await
        .unwrap();
    assert_eq!(prefix.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(prefix.headers()["content-type"], "video/mp4");
    let bytes = fs::read(&output).unwrap();
    assert_eq!(
        prefix.bytes().await.unwrap().as_ref(),
        &bytes[..prepared.output_media_offset as usize]
    );
    let response = client
        .get(&url)
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        response.headers()["content-length"],
        bytes.len().to_string()
    );
    assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
    drop(process);
}
