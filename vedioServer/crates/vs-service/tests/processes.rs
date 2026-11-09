use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

fn service_binary() -> std::path::PathBuf {
    let path = std::env::var_os("VS_TEST_SERVICE_BINARY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_vs-service").into());
    assert!(
        path.is_absolute() && path.is_file(),
        "服务测试制品须为已存在的绝对路径"
    );
    path
}

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(port: u16, catalog: &std::path::Path, token: &str) -> Process {
    Process(
        Command::new(service_binary())
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env("VS_ROLE", "api")
            .env("VS_CATALOG", catalog)
            .env("VS_SERVICE_TOKEN", token)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

fn available_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn two_processes_and_restart_preserve_results_from_same_snapshot() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    std::fs::write(&path, include_bytes!("../../../examples/catalog.json")).unwrap();
    let token = "process-test-only-token-00000000000000000000";
    let first_port = available_port();
    let mut second_port = available_port();
    while second_port == first_port {
        second_port = available_port();
    }
    let first = start(first_port, &path, token);
    let second = start(second_port, &path, token);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    async fn ready(client: &reqwest::Client, port: u16) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if client
                .get(format!("http://127.0.0.1:{port}/healthz"))
                .send()
                .await
                .is_ok()
            {
                break;
            }
            assert!(Instant::now() < deadline, "process_start_timeout");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    ready(&client, first_port).await;
    ready(&client, second_port).await;
    let request = json!({"request_id": "two-process", "domains": ["video", "article", "service"], "limit": 3, "profile": null});
    async fn query(client: &reqwest::Client, port: u16, token: &str, request: &Value) -> Value {
        client
            .post(format!("http://127.0.0.1:{port}/v1/recommendations"))
            .bearer_auth(token)
            .json(request)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    let before = query(&client, first_port, token, &request).await;
    assert_eq!(before, query(&client, second_port, token, &request).await);
    drop(first);
    assert_eq!(before, query(&client, second_port, token, &request).await);
    let restarted = start(first_port, &path, token);
    ready(&client, first_port).await;
    assert_eq!(before, query(&client, first_port, token, &request).await);
    drop(restarted);
    drop(second);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sigterm_drains_committed_journal_exits_zero_and_allows_restart() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let catalog = directory.path().join("catalog.json");
    let journal = directory.path().join("learning.jsonl");
    std::fs::write(&catalog, include_bytes!("../../../examples/catalog.json")).unwrap();
    let token = "sigterm-process-only-token-000000000000000000";
    let port = available_port();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let mut prior_bytes = Vec::new();
    for cycle in 0..2 {
        let stdout = directory.path().join(format!("cycle-{cycle}.stdout.log"));
        let mut command = Command::new(service_binary());
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("VS_") {
                command.env_remove(name);
            }
        }
        command
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env("VS_ROLE", "api")
            .env("VS_CATALOG", &catalog)
            .env("VS_SERVICE_TOKEN", token)
            .env("RUST_LOG", "vs_service=info")
            .env("VS_LEARNING_JOURNAL", &journal)
            .env("VS_LEARNING_SOURCE_ID", "sigterm-replica")
            .stdout(std::fs::File::create_new(&stdout).unwrap())
            .stderr(Stdio::null());
        let mut process = Process(command.spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(process.0.try_wait().unwrap().is_none(), "服务提前退出");
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/readyz"))
                .bearer_auth(token)
                .send()
                .await
                && response.status().is_success()
            {
                break;
            }
            assert!(Instant::now() < deadline, "服务未在期限内就绪");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let request = json!({
            "request_id":format!("sigterm-{cycle}"),"subject":"viewer",
            "domains":["video"],"limit":2
        });
        let response = client
            .post(format!("http://127.0.0.1:{port}/v1/feed"))
            .bearer_auth(token)
            .json(&request)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert!(response.headers().contains_key("x-learning-decision-id"));
        let _ = response.bytes().await.unwrap();
        let acknowledged = std::fs::read(&journal).unwrap();
        assert!(acknowledged.starts_with(&prior_bytes));
        assert!(acknowledged.len() > prior_bytes.len());
        // 仅向本用例持有的直接子进程发送SIGTERM，不按名称搜索或结束其他进程。
        let signal = Command::new("kill")
            .args(["-TERM", "--", &process.0.id().to_string()])
            .status()
            .unwrap();
        assert!(signal.success());
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "SIGTERM后服务未退出");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(status.success(), "SIGTERM退出失败：{status}");
        assert_eq!(std::fs::read(&journal).unwrap(), acknowledged);
        assert!(
            std::fs::read_to_string(stdout)
                .unwrap()
                .contains("service_shutdown_completed")
        );
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        drop(listener);
        prior_bytes = acknowledged;
    }
}
