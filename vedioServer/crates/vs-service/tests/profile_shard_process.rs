use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha2::Digest;
use vs_service::ProfileShard;

const TOKEN: &str = "process-shards-profile-token-000000000000";
const CATALOG: &[u8] = br#"{"version":"process-shards-v1","assets":[],"items":[
    {"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
    {"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
    {"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}
]}"#;

struct Node(Child);
impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(catalog: &Path, role: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    // 清除外部VS配置，避免实验继承部署选择或真实服务凭据。
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("VS_") {
            command.env_remove(key);
        }
    }
    command
        .env("VS_BIND", "127.0.0.1:0")
        .env("VS_ROLE", role)
        .env("VS_CATALOG", catalog)
        .env("VS_SERVICE_TOKEN", TOKEN)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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

fn shard(index: u16) -> ProfileShard {
    ProfileShard {
        schema: "profile-shard-v1".into(),
        count: 2,
        index,
    }
}

async fn ready(client: &Client, node: &mut Node, port: u16) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            assert!(node.0.try_wait().unwrap().is_none(), "分片测试进程提前退出");
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/readyz"))
                .bearer_auth(TOKEN)
                .send()
                .await
                && response.status() == StatusCode::OK
            {
                return response.json().await.unwrap();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("分片测试进程未及时就绪")
}

async fn post(client: &Client, port: u16, path: &str, body: &Value) -> reqwest::Response {
    client
        .post(format!("http://127.0.0.1:{port}{path}"))
        .bearer_auth(TOKEN)
        .json(body)
        .send()
        .await
        .unwrap()
}

async fn rejected(mut command: Command) {
    let mut node = Node(command.spawn().unwrap());
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = node.0.try_wait().unwrap() {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("非法配置进程没有及时退出");
    assert!(!status.success(), "非法配置必须以失败退出");
}

#[tokio::test]
async fn actual_service_processes_preserve_sharded_history_and_reject_layout_change() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let catalog = dir.path().join("catalog.json");
    std::fs::write(&catalog, CATALOG).unwrap();
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let mut ports = Vec::new();
    while ports.len() < 4 {
        let candidate = port();
        if !ports.contains(&candidate) {
            ports.push(candidate);
        }
    }
    let mut owners = Vec::new();
    for (index, &port) in ports.iter().take(2).enumerate() {
        let mut command = command(&catalog, "profile");
        command
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env(
                "VS_PROFILE_EVENT_LOG",
                dir.path().join(format!("events-{index}")),
            )
            .env(
                "VS_PROFILE_SHARD",
                serde_json::to_string(&shard(index as u16)).unwrap(),
            );
        let mut node = Node(command.spawn().unwrap());
        let receipt = ready(&client, &mut node, port).await;
        assert_eq!(receipt["profile_shard"], json!(shard(index as u16)));
        owners.push(node);
    }
    let config = dir.path().join("shards.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&json!({
            "schema":"profile-shards-v1","shards":(0..2).rev().map(|index|json!({
                "shard":shard(index as u16),
                "endpoint":format!("http://127.0.0.1:{}", ports[index]),"token":TOKEN
            })).collect::<Vec<_>>()
        }))
        .unwrap(),
    )
    .unwrap();
    let mut replicas = Vec::new();
    for &port in &ports[2..] {
        let mut command = command(&catalog, "api");
        command
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env("VS_PROFILE_SHARDS_CONFIG", &config);
        let mut node = Node(command.spawn().unwrap());
        let receipt = ready(&client, &mut node, port).await;
        assert_eq!(receipt["profile_store"], "remote");
        replicas.push(node);
    }
    let mut expected_records = [0_usize; 2];
    let mut first_by_owner = [None, None];
    for value in 0..32 {
        let subject = format!("synthetic-user-{value}");
        let index = usize::from(!shard(0).owns(&subject));
        expected_records[index] += 1;
        first_by_owner[index].get_or_insert(subject.clone());
        let event = json!({"event_id":"same-event-id","subject":subject,
            "candidate_id":"document","kind":"hide"});
        let accepted = post(&client, ports[2], "/v1/profile/events", &event).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(accepted.json::<Value>().await.unwrap()["accepted"], true);
        let duplicate = post(&client, ports[3], "/v1/profile/events", &event).await;
        assert_eq!(duplicate.status(), StatusCode::OK);
        assert_eq!(duplicate.json::<Value>().await.unwrap()["duplicate"], true);
        let request = json!({"request_id":"process-feed","subject":subject,
            "domains":["video","document","service"],"limit":3});
        let response = post(&client, ports[3], "/v1/feed", &request).await;
        assert_eq!(response.status(), StatusCode::OK);
        let feed: Value = response.json().await.unwrap();
        assert_eq!(feed["profile_version"], "memory-1");
        assert!(
            feed["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["id"] != "document")
        );
    }
    drop(replicas);
    drop(owners);
    let mut original = Vec::new();
    for (index, &expected) in expected_records.iter().enumerate() {
        let bytes = std::fs::read(dir.path().join(format!("events-{index}"))).unwrap();
        assert_eq!(
            bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .count(),
            expected
        );
        assert!(expected > 0);
        original.push(bytes);
    }
    let mut wrong = command(&catalog, "profile");
    wrong
        .env("VS_PROFILE_EVENT_LOG", dir.path().join("events-0"))
        .env(
            "VS_PROFILE_SHARD",
            serde_json::to_string(&shard(1)).unwrap(),
        );
    rejected(wrong).await;
    let mut downgrade = command(&catalog, "profile");
    downgrade.env("VS_PROFILE_EVENT_LOG", dir.path().join("events-0"));
    rejected(downgrade).await;
    let mut mixed = command(&catalog, "api");
    mixed.env("VS_PROFILE_SHARDS_CONFIG", &config).env(
        "VS_PROFILE_AUTHORITY_URL",
        format!("http://127.0.0.1:{}", ports[0]),
    );
    rejected(mixed).await;
    let mut relative = command(&catalog, "api");
    relative.env("VS_PROFILE_SHARDS_CONFIG", "relative.json");
    rejected(relative).await;
    let mut oversized = command(&catalog, "api");
    let large = dir.path().join("large.json");
    std::fs::write(&large, vec![b' '; 16_385]).unwrap();
    oversized.env("VS_PROFILE_SHARDS_CONFIG", &large);
    rejected(oversized).await;
    for index in 0..2 {
        let path = dir.path().join(format!("events-{index}"));
        assert_eq!(std::fs::read(&path).unwrap(), original[index]);
        let mut owner = command(&catalog, "profile");
        owner
            .env("VS_BIND", format!("127.0.0.1:{}", ports[index]))
            .env("VS_PROFILE_EVENT_LOG", &path)
            .env(
                "VS_PROFILE_SHARD",
                serde_json::to_string(&shard(index as u16)).unwrap(),
            );
        let mut owner = Node(owner.spawn().unwrap());
        ready(&client, &mut owner, ports[index]).await;
        let subject = first_by_owner[index].as_ref().unwrap();
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/internal/v1/profile/projection",
                ports[index]
            ))
            .bearer_auth(TOKEN)
            .header(
                "x-catalog-sha256",
                format!("{:x}", sha2::Sha256::digest(CATALOG)),
            )
            .header("x-profile-shard-guard", shard(index as u16).guard())
            .json(&json!({"subject":subject,"domains":["video","document","service"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let projection: Value = response.json().await.unwrap();
        assert_eq!(projection["profile"]["version"], "memory-1");
        assert_eq!(projection["profile"]["blocked_ids"], json!(["document"]));
        drop(owner);
        assert_eq!(std::fs::read(&path).unwrap(), original[index]);
    }
    println!(
        "{}",
        json!({"schema":"profile-shard-process-receipt-v1","physical_hosts":1,
        "owner_processes":2,"api_processes":2,"synthetic_subjects":32,"records_per_shard":expected_records,
        "restart_hidden_projection_verified":true,"changed_layout_and_downgrade_rejected":true,
        "physical_cluster_or_live_migration_tested":false,"kill_after_ack_not_power_loss":true})
    );
}
