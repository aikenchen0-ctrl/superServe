use std::{
    collections::BTreeMap,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use vs_coordination::profile_authority::ProfilePolicy;

const TOKEN: &str = "profile-consensus-process-token-0000000000";
const CATALOG: &[u8] = br#"{"version":"consensus-process-v1","assets":[],"items":[
{"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
{"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
{"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}]}"#;

struct Node(Child);
impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(config: &Path) -> Node {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-coordination"));
    command
        .env("VS_COORDINATION_CONFIG", config)
        .env("VS_COORDINATION_RUN_SECONDS", "120")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Node(command.spawn().unwrap())
}

async fn ready(client: &Client, port: u16, node: &mut Node) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(node.0.try_wait().unwrap().is_none(), "画像共识节点提前退出");
        if client
            .get(format!("http://127.0.0.1:{port}/metrics"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .is_ok_and(|response| response.status() == StatusCode::OK)
        {
            return;
        }
        assert!(Instant::now() < until, "画像共识节点未就绪");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn leader(client: &Client, ports: &BTreeMap<u64, u16>, nodes: &BTreeMap<u64, Node>) -> u64 {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            for id in nodes.keys() {
                let Ok(response) = client
                    .get(format!("http://127.0.0.1:{}/metrics", ports[id]))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                else {
                    continue;
                };
                let Ok(metrics) = response.json::<Value>().await else {
                    continue;
                };
                if metrics["state"] == "Leader" {
                    let response = client
                        .get(format!(
                            "http://127.0.0.1:{}/internal/lab/profile/writers/0",
                            ports[id]
                        ))
                        .bearer_auth(TOKEN)
                        .send()
                        .await;
                    if response.is_ok_and(|response| response.status() == StatusCode::OK) {
                        return *id;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("未获得可线性读取的画像多数派主节点")
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

async fn command(client: &Client, port: u16, value: Value, status: StatusCode) -> Value {
    // 每条写提案只发送一次，超时或丢响应不能自动重发。
    let response = post(client, port, "/internal/lab/profile/commands", &value).await;
    let actual = response.status();
    let bytes = response.bytes().await.unwrap();
    assert_eq!(
        actual,
        status,
        "画像提案返回：{}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

fn target(letter: char) -> Value {
    json!({"node_id":format!("writer-{letter}"),"incarnation":letter.to_string().repeat(22)})
}

fn change(id: &str, shard: u16, expected: Option<u64>, owner: Value) -> Value {
    json!({"operation":"set_profile_writer","change":{
        "operation_id":id,"shard":shard,"expected_revision":expected,"target":owner
    }})
}

fn event(subject: &str, id: &str, epoch: u64, owner: char, candidate: &str, kind: &str) -> Value {
    let policy = ProfilePolicy::from_catalog(CATALOG, 2).unwrap();
    json!({"operation":"commit_profile_event","shard":policy.shard_for(subject),
        "writer_epoch":epoch,"target":target(owner),"event":{
        "event_id":id,"subject":subject,"candidate_id":candidate,"kind":kind
    }})
}

async fn projection(client: &Client, port: u16, subject: &str) -> Value {
    let response = post(
        client,
        port,
        "/internal/lab/profile/projection",
        &json!({"subject":subject,"domains":["video","document","service"]}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = response.json().await.unwrap();
    value["profile"].clone()
}

async fn writer(client: &Client, port: u16, shard: u16) -> Value {
    let response = client
        .get(format!(
            "http://127.0.0.1:{port}/internal/lab/profile/writers/{shard}"
        ))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.json().await.unwrap()
}

#[tokio::test]
async fn three_process_quorum_fences_old_writers_and_recovers_facts_after_leader_and_full_restart()
{
    let _ = rustls::crypto::ring::default_provider().install_default();
    let dir = tempfile::tempdir().unwrap();
    let catalog = dir.path().join("catalog.json");
    std::fs::write(&catalog, CATALOG).unwrap();
    let mut ports = BTreeMap::new();
    while ports.len() < 3 {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        if !ports.values().any(|saved| *saved == port) {
            ports.insert(ports.len() as u64 + 1, port);
        }
    }
    let peers: BTreeMap<_, _> = ports
        .iter()
        .map(|(&id, port)| (id, format!("127.0.0.1:{port}")))
        .collect();
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let mut configs = BTreeMap::new();
    let mut nodes = BTreeMap::new();
    for (&id, &port) in &ports {
        let config = dir.path().join(format!("node-{id}.json"));
        std::fs::write(&config, serde_json::to_vec(&json!({
            "cluster_id":"profile-consensus-test","node_id":id,"bind":format!("127.0.0.1:{port}"),
            "data_dir":dir.path().join(format!("data-{id}")),"peers":peers,
            "voters":[1,2,3],"service_token":TOKEN,
            "profile_catalog":catalog,"profile_shard_count":2
        })).unwrap()).unwrap();
        let mut node = start(&config);
        ready(&client, port, &mut node).await;
        configs.insert(id, config);
        nodes.insert(id, node);
    }
    assert_eq!(
        post(&client, ports[&1], "/admin/initialize", &json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let first = leader(&client, &ports, &nodes).await;
    let port = ports[&first];
    let claimed = command(
        &client,
        port,
        change("initial", 0, None, target('a')),
        StatusCode::OK,
    )
    .await;
    let epoch_a = claimed["writer"]["revision"].as_u64().unwrap();
    let policy = ProfilePolicy::from_catalog(CATALOG, 2).unwrap();
    let subject = (0..100)
        .map(|id| format!("subject-{id}"))
        .find(|subject| policy.shard_for(subject) == 0)
        .unwrap();
    let hide = event(&subject, "hide", epoch_a, 'a', "document", "hide");
    assert_eq!(
        command(&client, port, hide.clone(), StatusCode::OK).await["event"]["accepted"],
        true
    );
    assert_eq!(
        command(&client, port, hide.clone(), StatusCode::OK).await["event"]["duplicate"],
        true
    );
    command(
        &client,
        port,
        event(&subject, "like", epoch_a, 'a', "video", "like"),
        StatusCode::OK,
    )
    .await;
    let changed = command(
        &client,
        port,
        change("replace", 0, Some(epoch_a), target('b')),
        StatusCode::OK,
    )
    .await;
    let epoch_b = changed["writer"]["revision"].as_u64().unwrap();
    assert!(epoch_b > epoch_a);
    assert_eq!(
        command(&client, port, hide, StatusCode::CONFLICT).await["outcome"],
        "fenced"
    );
    assert_eq!(
        command(
            &client,
            port,
            event(&subject, "hide", epoch_b, 'b', "document", "hide"),
            StatusCode::OK
        )
        .await["event"]["duplicate"],
        true
    );
    assert_eq!(
        command(
            &client,
            port,
            event(&subject, "hide", epoch_b, 'b', "document", "like"),
            StatusCode::CONFLICT
        )
        .await["outcome"],
        "conflict"
    );
    assert_eq!(
        projection(&client, port, &subject).await["blocked_ids"],
        json!(["document"])
    );
    assert_eq!(writer(&client, port, 0).await["events"], 2);
    // 杀主后多数派继续；不对旧主的不确定请求执行自动重发。
    drop(nodes.remove(&first));
    let second = leader(&client, &ports, &nodes).await;
    command(
        &client,
        ports[&second],
        event(&subject, "after-failover", epoch_b, 'b', "service", "like"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        command(
            &client,
            ports[&second],
            event(
                &subject,
                "old-after-failover",
                epoch_a,
                'a',
                "video",
                "like"
            ),
            StatusCode::CONFLICT
        )
        .await["outcome"],
        "fenced"
    );
    let mut restored = start(&configs[&first]);
    ready(&client, ports[&first], &mut restored).await;
    nodes.insert(first, restored);
    let second = leader(&client, &ports, &nodes).await;
    for id in ports
        .keys()
        .copied()
        .filter(|id| *id != second)
        .collect::<Vec<_>>()
    {
        drop(nodes.remove(&id));
    }
    // 旧主仍活着但失去多数派：线性投影和写入都不可返回成功。
    let read = post(
        &client,
        ports[&second],
        "/internal/lab/profile/projection",
        &json!({"subject":subject,"domains":["document"]}),
    )
    .await;
    assert!(matches!(
        read.status(),
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
    ));
    let uncertain = post(
        &client,
        ports[&second],
        "/internal/lab/profile/commands",
        &event(
            &subject,
            "minority-unknown",
            epoch_b,
            'b',
            "service",
            "like",
        ),
    )
    .await;
    assert!(matches!(
        uncertain.status(),
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
    ));
    // 未确认提案可能在恢复多数派后提交，不能宣称不存在。
    for &id in ports.keys().filter(|id| **id != second) {
        let mut node = start(&configs[&id]);
        ready(&client, ports[&id], &mut node).await;
        nodes.insert(id, node);
    }
    let restored_leader = leader(&client, &ports, &nodes).await;
    let final_owner = command(
        &client,
        ports[&restored_leader],
        change("final-owner", 0, Some(epoch_b), target('c')),
        StatusCode::OK,
    )
    .await;
    let epoch_c = final_owner["writer"]["revision"].as_u64().unwrap();
    assert_eq!(
        command(
            &client,
            ports[&restored_leader],
            event(&subject, "old-final", epoch_b, 'b', "video", "like"),
            StatusCode::CONFLICT
        )
        .await["outcome"],
        "fenced"
    );
    let final_event = command(
        &client,
        ports[&restored_leader],
        event(&subject, "final", epoch_c, 'c', "service", "like"),
        StatusCode::OK,
    )
    .await;
    let expected_version = final_event["event"]["profile_version"].clone();
    let expected_count = writer(&client, ports[&restored_leader], 0).await["events"].clone();
    assert_eq!(
        post(
            &client,
            ports[&restored_leader],
            "/admin/snapshot",
            &json!({})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let snapshot_index = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let metrics: Value = client
                .get(format!(
                    "http://127.0.0.1:{}/metrics",
                    ports[&restored_leader]
                ))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if let (Some(snapshot), Some(purged)) = (
                metrics["snapshot"]["index"].as_u64(),
                metrics["purged"]["index"].as_u64(),
            ) && snapshot > epoch_c
                && purged >= snapshot
            {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("快照与日志清理未在期限内实际完成");
    drop(nodes);
    let mut nodes = BTreeMap::new();
    for (&id, &port) in &ports {
        let mut node = start(&configs[&id]);
        ready(&client, port, &mut node).await;
        nodes.insert(id, node);
    }
    let final_leader = leader(&client, &ports, &nodes).await;
    let recovered = projection(&client, ports[&final_leader], &subject).await;
    assert_eq!(recovered["blocked_ids"], json!(["document"]));
    assert_eq!(recovered["version"], expected_version);
    assert_eq!(
        writer(&client, ports[&final_leader], 0).await["events"],
        expected_count
    );
    assert_eq!(
        command(
            &client,
            ports[&final_leader],
            event(&subject, "hide", epoch_c, 'c', "document", "hide"),
            StatusCode::OK
        )
        .await["outcome"],
        "duplicate"
    );
    assert_eq!(
        command(
            &client,
            ports[&final_leader],
            event(&subject, "after-restart-old", epoch_a, 'a', "video", "like"),
            StatusCode::CONFLICT
        )
        .await["outcome"],
        "fenced"
    );
    println!(
        "{}",
        json!({"schema":"profile-consensus-process-v1","physical_hosts":1,"voters":3,
        "initial_leader":first,"replacement_leader":second,"restart_leader":final_leader,
        "epochs":[epoch_a,epoch_b,epoch_c],"final_events":expected_count,
        "snapshot_and_purge_verified_index":snapshot_index,
        "minority_write_result":"unknown_not_retried","minority_projection_rejected":true,
        "hide_and_idempotency_recovered":true,"old_epochs_fenced_at_committed_fact_boundary":true,
        "physical_fault_domain_or_online_resharding_verified":false})
    );
    drop(nodes);
    for port in ports.values() {
        drop(std::net::TcpListener::bind(("127.0.0.1", *port)).unwrap());
    }
}
