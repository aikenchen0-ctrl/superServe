use std::{
    collections::HashSet,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};

const API_TOKEN: &str = "api-replica-test-token-0000000000000000";
const AUTHORITY_TOKEN: &str = "profile-authority-test-token-00000000000";

struct Node {
    process: Child,
    port: u16,
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

fn start(
    port: u16,
    role: &str,
    catalog: &Path,
    token: &str,
    log: Option<&Path>,
    authority: Option<u16>,
) -> Node {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    command
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_ROLE", role)
        .env("VS_CATALOG", catalog)
        .env("VS_SERVICE_TOKEN", token)
        .env_remove("VS_PROFILE_EVENT_LOG")
        .env_remove("VS_PROFILE_AUTHORITY_URL")
        .env_remove("VS_PROFILE_AUTHORITY_TOKEN")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path) = log {
        command.env("VS_PROFILE_EVENT_LOG", path);
    }
    if let Some(port) = authority {
        command
            .env(
                "VS_PROFILE_AUTHORITY_URL",
                format!("http://127.0.0.1:{port}"),
            )
            .env("VS_PROFILE_AUTHORITY_TOKEN", AUTHORITY_TOKEN);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Node {
        process: command.spawn().unwrap(),
        port,
    }
}

async fn live(client: &Client, node: &mut Node) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            node.process.try_wait().unwrap().is_none(),
            "测试服务提前退出"
        );
        if client
            .get(format!("http://127.0.0.1:{}/healthz", node.port))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return;
        }
        assert!(Instant::now() < deadline, "测试服务启动超时");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn post(client: &Client, port: u16, path: &str, body: &Value) -> reqwest::Response {
    client
        .post(format!("http://127.0.0.1:{port}{path}"))
        .bearer_auth(API_TOKEN)
        .json(body)
        .send()
        .await
        .unwrap()
}

async fn feed(client: &Client, port: u16) -> Value {
    post(
        client,
        port,
        "/v1/feed",
        &json!({
            "request_id":"shared-feed", "subject":"user-a",
            "domains":["video", "article", "service"], "limit":3
        }),
    )
    .await
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap()
}

#[tokio::test]
async fn replicas_share_updates_hide_restart_and_fail_closed_on_outage_or_drift() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("catalog.json");
    let drifted = directory.path().join("drifted.json");
    let data = include_bytes!("../../../examples/catalog.json");
    std::fs::write(&catalog, data).unwrap();
    let mut changed: Value = serde_json::from_slice(data).unwrap();
    changed["version"] = json!("drifted-v1");
    std::fs::write(&drifted, serde_json::to_vec(&changed).unwrap()).unwrap();
    let log = directory.path().join("profile-events.jsonl");
    let mut selected = HashSet::new();
    while selected.len() < 5 {
        selected.insert(
            std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port(),
        );
    }
    let ports: Vec<_> = selected.into_iter().collect();
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    let mut authority = start(
        ports[0],
        "profile",
        &catalog,
        AUTHORITY_TOKEN,
        Some(&log),
        None,
    );
    let mut a = start(ports[1], "api", &catalog, API_TOKEN, None, Some(ports[0]));
    let mut b = start(ports[2], "api", &catalog, API_TOKEN, None, Some(ports[0]));
    live(&client, &mut authority).await;
    live(&client, &mut a).await;
    live(&client, &mut b).await;
    let readiness = client
        .get(format!("http://127.0.0.1:{}/readyz", b.port))
        .bearer_auth(API_TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(readiness["profile_store"], "remote");
    assert_eq!(
        feed(&client, a.port).await["items"][0]["id"],
        "article-storage"
    );
    let like =
        json!({"event_id":"like-1","subject":"user-a","candidate_id":"video-rust","kind":"like"});
    let accepted: Value = post(&client, a.port, "/v1/profile/events", &like)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(accepted["accepted"], true);
    let first = feed(&client, a.port).await;
    assert_eq!(first["profile_version"], "memory-1");
    assert_eq!(first["items"][0]["id"], "video-rust");
    assert_eq!(feed(&client, b.port).await, first);
    let duplicate: Value = post(&client, b.port, "/v1/profile/events", &like)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["profile_version"], "memory-1");
    let conflicting_reuse = json!({
        "event_id": "like-1",
        "subject": "user-a",
        "candidate_id": "video-rust",
        "kind": "hide"
    });
    let conflict = post(&client, b.port, "/v1/profile/events", &conflicting_reuse).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let conflict: Value = conflict.json().await.unwrap();
    assert_eq!(conflict["error"], "profile_event_id_conflict");
    assert_eq!(feed(&client, a.port).await, first);
    let hide =
        json!({"event_id":"hide-1","subject":"user-a","candidate_id":"video-rust","kind":"hide"});
    assert!(
        post(&client, b.port, "/v1/profile/events", &hide)
            .await
            .status()
            .is_success()
    );
    let hidden = feed(&client, a.port).await;
    assert_eq!(hidden["profile_version"], "memory-2");
    assert!(
        hidden["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != "video-rust")
    );
    assert_eq!(feed(&client, b.port).await, hidden);
    // 新副本不导入用户历史，直接从权威端读取同一画像投影。
    drop(a);
    let mut c = start(ports[3], "api", &catalog, API_TOKEN, None, Some(ports[0]));
    live(&client, &mut c).await;
    assert_eq!(feed(&client, c.port).await, hidden);
    let internal = json!({"subject":"user-a","domains":["video"]});
    assert_eq!(
        post(
            &client,
            b.port,
            "/internal/v1/profile/projection",
            &internal
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post(
            &client,
            authority.port,
            "/internal/v1/profile/projection",
            &internal
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post(format!(
                "http://127.0.0.1:{}/internal/v1/profile/projection",
                authority.port
            ))
            .bearer_auth(AUTHORITY_TOKEN)
            .json(&internal)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let mut bad = start(ports[4], "api", &drifted, API_TOKEN, None, Some(ports[0]));
    live(&client, &mut bad).await;
    let request = json!({"request_id":"drift","subject":"user-a","domains":["video"],"limit":1});
    assert_eq!(
        post(&client, bad.port, "/v1/feed", &request).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        post(&client, bad.port, "/v1/profile/events", &like)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(feed(&client, b.port).await, hidden);
    drop(bad);
    // 断开权威端时不回退成匿名排序，避免重新曝光隐藏候选。
    drop(authority);
    assert_eq!(
        post(&client, b.port, "/v1/feed", &request).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        post(&client, b.port, "/v1/profile/events", &like)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        client
            .get(format!("http://127.0.0.1:{}/readyz", b.port))
            .bearer_auth(API_TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut restored = start(
        ports[0],
        "profile",
        &catalog,
        AUTHORITY_TOKEN,
        Some(&log),
        None,
    );
    live(&client, &mut restored).await;
    assert_eq!(feed(&client, b.port).await, hidden);
    assert_eq!(feed(&client, c.port).await, hidden);
    let repeated: Value = post(&client, c.port, "/v1/profile/events", &hide)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(repeated["duplicate"], true);
    assert_eq!(repeated["profile_version"], "memory-2");
}
