use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, StatusCode};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_service::ProfileShard;

const API_TOKEN: &str = "consensus-read-api-only-token-000000000000";
const CONTROL_TOKEN: &str = "consensus-control-test-token-000000000000";
const ISSUER: &str = "https://synthetic-feed-identity.example";
const CATALOG: &[u8] = br#"{"version":"consensus-read-v1","assets":[],"items":[
{"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
{"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
{"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}]}"#;

struct Node(Child);
impl Node {
    fn stop(mut self) {
        self.0.kill().expect("无法终止本次实验子进程");
        self.0.wait().expect("无法等待本次实验子进程回收");
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn launch(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("VS_") {
            command.env_remove(key);
        }
    }
    command.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn coordinator(binary: &Path, config: &Path) -> Node {
    Node(
        launch(binary)
            .env("VS_COORDINATION_CONFIG", config)
            .env("VS_COORDINATION_RUN_SECONDS", "120")
            .spawn()
            .unwrap(),
    )
}

fn api(catalog: &Path, config: &Path, access: &Path, port: u16) -> Node {
    Node(
        launch(Path::new(env!("CARGO_BIN_EXE_vs-service")))
            .env("VS_ROLE", "api")
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env("VS_CATALOG", catalog)
            .env("VS_SERVICE_TOKEN", API_TOKEN)
            .env("VS_PROFILE_CONSENSUS_CONFIG", config)
            .env("VS_FEED_ACCESS_CONFIG", access)
            .spawn()
            .unwrap(),
    )
}

async fn rejected(mut command: Command) {
    let mut node = Node(command.spawn().unwrap());
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = node.0.try_wait().unwrap() {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("非法共识画像配置未及时退出");
    assert!(!status.success());
}

#[tokio::test]
async fn startup_rejects_relative_oversized_unknown_or_mixed_consensus_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = dir.path().join("catalog.json");
    std::fs::write(&catalog, CATALOG).unwrap();
    let valid = dir.path().join("reader.json");
    let config = json!({"cluster_id":"test","endpoints":["127.0.0.1:1"],
        "service_token":CONTROL_TOKEN,"shard_count":2,"minimum_applied_index":1});
    std::fs::write(&valid, serde_json::to_vec(&config).unwrap()).unwrap();
    let oversized = dir.path().join("large.json");
    std::fs::write(&oversized, vec![b' '; 8193]).unwrap();
    let unknown = dir.path().join("unknown.json");
    let mut unknown_value = config;
    unknown_value["allow_writes"] = json!(true);
    std::fs::write(&unknown, serde_json::to_vec(&unknown_value).unwrap()).unwrap();
    for case in [
        "relative",
        "size",
        "unknown",
        "single",
        "local",
        "media",
        "deployment",
    ] {
        let mut command = launch(Path::new(env!("CARGO_BIN_EXE_vs-service")));
        command
            .env("VS_ROLE", "api")
            .env("VS_BIND", "127.0.0.1:0")
            .env("VS_CATALOG", &catalog)
            .env("VS_SERVICE_TOKEN", API_TOKEN)
            .env("VS_PROFILE_CONSENSUS_CONFIG", &valid);
        match case {
            "relative" => {
                command.env("VS_PROFILE_CONSENSUS_CONFIG", "relative.json");
            }
            "size" => {
                command.env("VS_PROFILE_CONSENSUS_CONFIG", &oversized);
            }
            "unknown" => {
                command.env("VS_PROFILE_CONSENSUS_CONFIG", &unknown);
            }
            "single" => {
                command.env("VS_PROFILE_AUTHORITY_URL", "http://127.0.0.1:1");
            }
            "local" => {
                command.env("VS_PROFILE_EVENT_LOG", dir.path().join("events"));
            }
            "media" => {
                command.env("VS_ROLE", "media");
            }
            _ => {
                command.env("VS_DEPLOYMENT_CHANNEL", "test");
            }
        }
        rejected(command).await;
    }
    assert!(!dir.path().join("events").exists());
}

async fn ready(client: &Client, node: &mut Node, port: u16, control: bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            assert!(
                node.0.try_wait().unwrap().is_none(),
                "共识Feed实验程序提前退出"
            );
            let path = if control { "/metrics" } else { "/readyz" };
            let token = if control { CONTROL_TOKEN } else { API_TOKEN };
            if client
                .get(format!("http://127.0.0.1:{port}{path}"))
                .bearer_auth(token)
                .send()
                .await
                .is_ok_and(|response| response.status() == StatusCode::OK)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("共识Feed实验程序未及时就绪");
}

async fn leader(client: &Client, peers: &BTreeMap<u64, u16>, nodes: &BTreeMap<u64, Node>) -> u64 {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            for id in nodes.keys() {
                if let Ok(response) = client
                    .get(format!(
                        "http://127.0.0.1:{}/internal/lab/profile/writers/0",
                        peers[id]
                    ))
                    .bearer_auth(CONTROL_TOKEN)
                    .send()
                    .await
                    && response.status() == StatusCode::OK
                {
                    return *id;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("共识Feed实验未获得线性读取节点")
}

async fn command(client: &Client, port: u16, value: Value, status: StatusCode) -> Value {
    let response = client
        .post(format!(
            "http://127.0.0.1:{port}/internal/lab/profile/commands"
        ))
        .bearer_auth(CONTROL_TOKEN)
        .json(&value)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), status);
    response.json().await.unwrap()
}

async fn writer(client: &Client, port: u16) -> Value {
    client
        .get(format!(
            "http://127.0.0.1:{port}/internal/lab/profile/writers/0"
        ))
        .bearer_auth(CONTROL_TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn target(letter: char) -> Value {
    json!({"node_id":format!("writer-{letter}"),"incarnation":letter.to_string().repeat(22)})
}

fn event(subject: &str, id: &str, candidate: &str, kind: &str, epoch: u64, owner: char) -> Value {
    json!({"operation":"commit_profile_event","shard":0,"writer_epoch":epoch,"target":target(owner),
        "event":{"event_id":id,"subject":subject,"candidate_id":candidate,"kind":kind}})
}

async fn feed(client: &Client, port: u16, subject: &str) -> reqwest::Response {
    signed_feed(
        client,
        port,
        Some(&identity(subject, &["video", "document", "service"], 23)),
        json!({"request_id":"consensus-feed","domains":["video","document","service"],"limit":3}),
    )
    .await
}

fn identity(subject: &str, domains: &[&str], seed: u8) -> String {
    // 固定种子仅生成合成测试签名；服务配置只持有公钥。
    let key = Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({"alg":"EdDSA","typ":"vs-feed+jwt","kid":"synthetic-key"}))
            .unwrap(),
    );
    let issued = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .saturating_sub(1);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "iss":ISSUER,"aud":"feed-api","sub":subject,
            "iat":issued,"nbf":issued,"exp":issued+120,"domains":domains
        }))
        .unwrap(),
    );
    let message = format!("{header}.{claims}");
    format!(
        "{message}.{}",
        URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref())
    )
}

async fn signed_feed(
    client: &Client,
    port: u16,
    identity: Option<&str>,
    body: Value,
) -> reqwest::Response {
    let request = client
        .post(format!("http://127.0.0.1:{port}/internal/v2/feed"))
        .bearer_auth(API_TOKEN)
        .json(&body);
    match identity {
        Some(token) => request.header("x-feed-identity", format!("Bearer {token}")),
        None => request,
    }
    .send()
    .await
    .unwrap()
}

async fn identity_rejections(client: &Client, port: u16, subject: &str) {
    let body =
        json!({"request_id":"rejected-feed","domains":["video","document","service"],"limit":3});
    let signed = identity(subject, &["video", "document", "service"], 23);
    let wrong_key = identity(subject, &["video", "document", "service"], 24);
    let video_only = identity(subject, &["video"], 23);
    for (token, request, status) in [
        (None, body.clone(), StatusCode::UNAUTHORIZED),
        (
            Some(wrong_key.as_str()),
            body.clone(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            Some(video_only.as_str()),
            body.clone(),
            StatusCode::FORBIDDEN,
        ),
        (
            Some(signed.as_str()),
            json!({"request_id":"forged-subject","subject":"other-subject",
                "domains":["video","document","service"],"limit":3}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let response = signed_feed(client, port, token, request).await;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    // 服务级令牌与用户签名分别校验，用户签名不能代替服务身份。
    let response = client
        .post(format!("http://127.0.0.1:{port}/internal/v2/feed"))
        .header("x-feed-identity", format!("Bearer {signed}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

async fn cold_subject(client: &Client, port: u16) {
    let response = feed(client, port, "synthetic-cold-subject").await;
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["profile_version"], Value::Null);
    assert_eq!(value["items"].as_array().unwrap().len(), 3);
}

async fn legacy_feed(client: &Client, port: u16, subject: &str) -> reqwest::Response {
    client
        .post(format!("http://127.0.0.1:{port}/v1/feed"))
        .bearer_auth(API_TOKEN)
        .json(&json!({"request_id":"consensus-feed","subject":subject,
            "domains":["video","document","service"],"limit":3}))
        .send()
        .await
        .unwrap()
}

async fn check_feed(client: &Client, port: u16, subject: &str, version: &str) -> Value {
    let response = feed(client, port, subject).await;
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["profile_version"], version);
    let items = value["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|item| item["id"] != "document"));
    value
}

#[tokio::test]
#[ignore = "需设置VS_TEST_COORDINATION_BINARY指向本轮已构建的独立协调程序"]
async fn actual_consensus_profiles_feed_two_api_processes_through_failover_and_quorum_loss() {
    let binary = PathBuf::from(
        std::env::var_os("VS_TEST_COORDINATION_BINARY").expect("缺少独立协调程序路径"),
    );
    assert!(binary.is_absolute() && binary.is_file());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let catalog = dir.path().join("catalog.json");
    std::fs::write(&catalog, CATALOG).unwrap();
    let client = Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    let reservations: Vec<_> = (0..5)
        .map(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap())
        .collect();
    let ports: Vec<_> = reservations
        .iter()
        .map(|listener| listener.local_addr().unwrap().port())
        .collect();
    let peers: BTreeMap<_, _> = (1..=3).map(|id| (id, ports[id as usize - 1])).collect();
    let addresses: BTreeMap<_, _> = peers
        .iter()
        .map(|(&id, port)| (id, format!("127.0.0.1:{port}")))
        .collect();
    drop(reservations);
    let mut configs = BTreeMap::new();
    let mut nodes = BTreeMap::new();
    for (&id, &port) in &peers {
        let config = dir.path().join(format!("node-{id}.json"));
        std::fs::write(
            &config,
            serde_json::to_vec(&json!({
                "cluster_id":"consensus-feed-test","node_id":id,"bind":format!("127.0.0.1:{port}"),
                "data_dir":dir.path().join(format!("data-{id}")),"peers":addresses,
                "voters":[1,2,3],"service_token":CONTROL_TOKEN,
                "profile_catalog":catalog,"profile_shard_count":2
            }))
            .unwrap(),
        )
        .unwrap();
        let mut node = coordinator(&binary, &config);
        ready(&client, &mut node, port, true).await;
        nodes.insert(id, node);
        configs.insert(id, config);
    }
    assert_eq!(
        client
            .post(format!("http://127.0.0.1:{}/admin/initialize", ports[0]))
            .bearer_auth(CONTROL_TOKEN)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let first = leader(&client, &peers, &nodes).await;
    let initial = command(
        &client,
        peers[&first],
        json!({"operation":"set_profile_writer","change":{
            "operation_id":"initial","shard":0,"expected_revision":null,"target":target('a')
        }}),
        StatusCode::OK,
    )
    .await;
    let epoch = initial["writer"]["revision"].as_u64().unwrap();
    let shard = ProfileShard {
        schema: "profile-shard-v1".into(),
        count: 2,
        index: 0,
    };
    let subject = (0..100)
        .map(|i| format!("synthetic-user-{i}"))
        .find(|s| shard.owns(s))
        .unwrap();
    for (id, candidate, kind) in [
        ("hide", "document", "hide"),
        ("like-video", "video", "like"),
    ] {
        command(
            &client,
            peers[&first],
            event(&subject, id, candidate, kind, epoch, 'a'),
            StatusCode::OK,
        )
        .await;
    }
    let minimum = writer(&client, peers[&first]).await["applied_index"]
        .as_u64()
        .unwrap();
    let read_config = dir.path().join("profile-reader.json");
    let access = dir.path().join("feed-access.json");
    let key = Ed25519KeyPair::from_seed_unchecked(&[23; 32]).unwrap();
    std::fs::write(
        &access,
        serde_json::to_vec(&json!({
            "issuer":ISSUER,"audience":"feed-api","keys":[{
                "kid":"synthetic-key",
                "public_key":URL_SAFE_NO_PAD.encode(key.public_key().as_ref())
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        &read_config,
        serde_json::to_vec(&json!({
            "cluster_id":"consensus-feed-test","endpoints":addresses.values().collect::<Vec<_>>(),
            "service_token":CONTROL_TOKEN,"shard_count":2,"minimum_applied_index":minimum
        }))
        .unwrap(),
    )
    .unwrap();
    let mut apis = Vec::new();
    for &port in &ports[3..] {
        let mut node = api(&catalog, &read_config, &access, port);
        ready(&client, &mut node, port, false).await;
        let readiness: Value = client
            .get(format!("http://127.0.0.1:{port}/readyz"))
            .bearer_auth(API_TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(readiness["profile_read_only"], true);
        apis.push(node);
    }
    let a = check_feed(&client, ports[3], &subject, "memory-2").await;
    assert_eq!(a, check_feed(&client, ports[4], &subject, "memory-2").await);
    identity_rejections(&client, ports[3], &subject).await;
    cold_subject(&client, ports[4]).await;
    check_feed(&client, ports[4], &subject, "memory-2").await;
    let legacy = legacy_feed(&client, ports[3], &subject).await;
    assert_eq!(legacy.status(), StatusCode::OK);
    assert_eq!(legacy.json::<Value>().await.unwrap(), a);
    let before = writer(&client, peers[&first]).await["events"].clone();
    let denied = client
        .post(format!("http://127.0.0.1:{}/v1/profile/events", ports[3]))
        .bearer_auth(API_TOKEN)
        .json(&json!({"event_id":"no-proxy-write","subject":subject,
            "candidate_id":"video","kind":"hide"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(writer(&client, peers[&first]).await["events"], before);
    nodes.remove(&first).unwrap().stop();
    let second = leader(&client, &peers, &nodes).await;
    command(
        &client,
        peers[&second],
        event(&subject, "like-service", "service", "like", epoch, 'a'),
        StatusCode::OK,
    )
    .await;
    check_feed(&client, ports[3], &subject, "memory-3").await;
    check_feed(&client, ports[4], &subject, "memory-3").await;
    identity_rejections(&client, ports[4], &subject).await;
    let survivor = second;
    let other = *nodes.keys().find(|&&id| id != survivor).unwrap();
    nodes.remove(&other).unwrap().stop();
    for &port in &ports[3..] {
        let response = feed(&client, port, &subject).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let response = client
            .get(format!("http://127.0.0.1:{port}/readyz"))
            .bearer_auth(API_TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    for id in [first, other] {
        let mut node = coordinator(&binary, &configs[&id]);
        ready(&client, &mut node, peers[&id], true).await;
        nodes.insert(id, node);
    }
    let restored = leader(&client, &peers, &nodes).await;
    let rotated = command(
        &client,
        peers[&restored],
        json!({"operation":"set_profile_writer","change":{
            "operation_id":"rotate","shard":0,"expected_revision":epoch,"target":target('b')
        }}),
        StatusCode::OK,
    )
    .await;
    let next_epoch = rotated["writer"]["revision"].as_u64().unwrap();
    assert_eq!(
        command(
            &client,
            peers[&restored],
            event(&subject, "stale", "video", "like", epoch, 'a'),
            StatusCode::CONFLICT
        )
        .await["outcome"],
        "fenced"
    );
    assert_eq!(
        command(
            &client,
            peers[&restored],
            event(&subject, "hide", "document", "hide", next_epoch, 'b'),
            StatusCode::OK
        )
        .await["outcome"],
        "duplicate"
    );
    for node in apis {
        node.stop();
    }
    let mut apis = Vec::new();
    for &port in &ports[3..] {
        let mut node = api(&catalog, &read_config, &access, port);
        ready(&client, &mut node, port, false).await;
        check_feed(&client, port, &subject, "memory-3").await;
        apis.push(node);
    }
    assert_eq!(writer(&client, peers[&restored]).await["events"], 3);
    for node in apis {
        node.stop();
    }
    for node in nodes.into_values() {
        node.stop();
    }
    for port in ports {
        drop(std::net::TcpListener::bind(("127.0.0.1", port)).unwrap());
    }
    println!(
        "{}",
        json!({"schema":"profile-consensus-feed-process-v1",
        "coordinators":3,"api_processes":2,"physical_hosts":1,
        "initial_leader":first,"replacement_leader":second,"restore_leader":restored,
        "minimum_applied_index":minimum,"catalog_sha256":format!("{:x}",Sha256::digest(CATALOG)),
        "hide_and_cross_domain_feed":true,"api_restart":true,"readonly_write_denied":true,
        "quorum_loss_feed_and_readiness_unavailable":true,"old_writer_fenced":true,
        "signed_subject_and_scope_verified":true,"forged_identity_rejected":true,
        "cold_subject_isolation_verified":true,"legacy_feed_compatibility_verified":true,
        "process_and_tcp_reclaimed":true,"synthetic_issuer_only":true,
        "local_fallback_or_new_event_retries":false,"production_admitted":false})
    );
}
