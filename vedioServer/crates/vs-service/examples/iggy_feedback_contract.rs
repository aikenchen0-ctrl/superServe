// 实验仅接入本机独立Iggy实例；管理凭证不得指向生产环境。
use std::{
    env, fs, io,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::learning::TrainingDataKind;
use vs_service::{
    AppState, Role,
    feedback_log::{IggyFeedbackConfig, IggyFeedbackLog},
    learning_evidence::GatewayLearningArchive,
    router,
};

#[derive(Serialize, Deserialize)]
struct Checkpoint {
    schema: String,
    run_id: String,
    config: IggyFeedbackConfig,
    archive_sha256: String,
    topic_created_at: u64,
    partition_created_at: u64,
    #[serde(default)]
    cluster_endpoints: Vec<String>,
    #[serde(default)]
    cluster_name: Option<String>,
}

fn loopback_endpoint(endpoint: &str) -> io::Result<String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| io::Error::other("实验地址无效"))?;
    ensure(
        url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|h| h == "127.0.0.1" || h == "[::1]")
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "仅允许无凭证的HTTP回环实验地址",
    )?;
    Ok(endpoint.trim_end_matches('/').to_owned())
}

fn checked_config(checkpoint: &Checkpoint, endpoint: &str) -> io::Result<IggyFeedbackConfig> {
    ensure(
        checkpoint.schema == "iggy-feedback-restart-checkpoint-v1"
            && (checkpoint.config.endpoint == endpoint
                || checkpoint
                    .cluster_endpoints
                    .iter()
                    .any(|allowed| allowed == endpoint)),
        "检查点或目标地址不在固定名单内",
    )?;
    let mut config = checkpoint.config.clone();
    config.endpoint = endpoint.to_owned();
    Ok(config)
}

fn validate_roster(
    metadata: &Value,
    endpoints: &[String],
    name: Option<&str>,
    min_view: u64,
) -> io::Result<()> {
    let nodes = metadata["nodes"]
        .as_array()
        .ok_or_else(|| io::Error::other("集群节点列表缺失"))?;
    ensure(
        nodes.len() == 3
            && endpoints.len() == 3
            && metadata["observed_view"]
                .as_u64()
                .is_some_and(|view| view >= min_view)
            && metadata["name"].as_str().is_some_and(|value| {
                !value.is_empty() && name.is_none_or(|expected| expected == value)
            })
            && nodes.iter().filter(|node| node["role"] == "leader").count() == 1,
        "集群名称、视图或主节点数量不符",
    )?;
    let mut actual = std::collections::HashSet::new();
    for node in nodes {
        ensure(
            node["ip"] == "127.0.0.1" && (node["role"] == "leader" || node["role"] == "follower"),
            "集群节点地址或角色无效",
        )?;
        let port = node["endpoints"]["http"]
            .as_u64()
            .filter(|port| *port > 0 && *port <= u16::MAX as u64)
            .ok_or_else(|| io::Error::other("集群HTTP端口无效"))?;
        ensure(
            actual.insert(format!("http://127.0.0.1:{port}")),
            "集群节点地址重复",
        )?;
    }
    ensure(
        endpoints.iter().all(|endpoint| actual.contains(endpoint)),
        "集群返回地址不匹配固定名单",
    )
}

async fn cluster_metadata(client: &Client, endpoint: &str, token: &str) -> io::Result<Value> {
    let response = client
        .get(format!("{endpoint}/cluster/metadata"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(io::Error::other)?;
    ensure(response.status().is_success(), "集群元数据读取失败")?;
    let view = response
        .headers()
        .get("iggy-view")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| io::Error::other("集群视图声明缺失"))?;
    let mut body: Value = response.json().await.map_err(io::Error::other)?;
    body["observed_view"] = json!(view);
    Ok(body)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn required(name: &str) -> io::Result<String> {
    env::var(name).map_err(|_| io::Error::other(format!("缺少实验配置：{name}")))
}

fn ensure(condition: bool, message: &str) -> io::Result<()> {
    if condition {
        Ok(())
    } else {
        Err(io::Error::other(message))
    }
}

fn password(root: &str, run_id: &str, role: &str) -> String {
    hash(format!("{root}:{run_id}:{role}").as_bytes())
}

async fn login(client: &Client, endpoint: &str, user: &str, password: &str) -> io::Result<String> {
    let started = std::time::Instant::now();
    // 只等待登录与恢复就绪，不在这里重发任何反馈消息。
    let response = loop {
        let result = client
            .post(format!("{endpoint}/users/login"))
            .json(&json!({"username":user,"password":password}))
            .send()
            .await;
        match result {
            Ok(response)
                if response.status() != StatusCode::SERVICE_UNAVAILABLE
                    || started.elapsed() >= Duration::from_secs(20) =>
            {
                break response;
            }
            Err(error) if started.elapsed() >= Duration::from_secs(20) => {
                return Err(io::Error::other(format!("Iggy实验登录连接失败：{error}")));
            }
            _ => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    };
    ensure(response.status().is_success(), "Iggy实验登录被拒绝")?;
    let body: Value = response
        .json()
        .await
        .map_err(|_| io::Error::other("Iggy登录响应无效"))?;
    body["access_token"]["token"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| io::Error::other("Iggy未返回访问令牌"))
}

async fn create(
    client: &Client,
    endpoint: &str,
    token: &str,
    path: &str,
    body: Value,
) -> io::Result<Value> {
    let response = client
        .post(format!("{endpoint}{path}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| io::Error::other("Iggy实验资源创建失败"))?;
    ensure(response.status().is_success(), "Iggy拒绝创建实验资源")?;
    response
        .json()
        .await
        .map_err(|_| io::Error::other("Iggy资源响应无效"))
}

fn config(endpoint: &str, stream: &Value, topic: &Value) -> io::Result<IggyFeedbackConfig> {
    let id = |value: &Value| {
        value
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| io::Error::other("实验资源坐标无效"))
    };
    Ok(IggyFeedbackConfig {
        endpoint: endpoint.into(),
        fallback_endpoints: Vec::new(),
        stream_id: id(&stream["id"])?,
        topic_id: id(&topic["id"])?,
        partition_id: id(&topic["partitions"][0]["id"])?,
        source_id: "iggy-loopback-lab".into(),
        data_kind: TrainingDataKind::Synthetic,
        operation_timeout_ms: 5000,
    })
}

async fn seed(
    client: &Client,
    endpoint: &str,
    root_password: &str,
    target: &Path,
) -> io::Result<Value> {
    // 不复用旧目录或同名资源，失败时保留原始诊断，不重发未知写入。
    fs::create_dir(target)?;
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let run_id = format!("vsfeedback-{}-{}", std::process::id(), at.as_nanos());
    let root = login(
        client,
        endpoint,
        &required("VS_LAB_IGGY_USERNAME")?,
        root_password,
    )
    .await?;
    let cluster_endpoints: Vec<String> = match env::var("VS_LAB_IGGY_CLUSTER_ENDPOINTS") {
        Ok(raw) => {
            let values: Vec<String> = serde_json::from_str(&raw).map_err(io::Error::other)?;
            ensure(values.len() == 3, "集群实验必须显式指定三个地址")?;
            let values: Vec<_> = values
                .iter()
                .map(|value| loopback_endpoint(value))
                .collect::<io::Result<_>>()?;
            ensure(
                values
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == 3
                    && values.iter().any(|value| value == endpoint),
                "集群地址重复或缺少初始节点",
            )?;
            values
        }
        Err(env::VarError::NotPresent) => Vec::new(),
        Err(_) => return Err(io::Error::other("集群实验地址编码无效")),
    };
    let cluster_name = if cluster_endpoints.is_empty() {
        None
    } else {
        let metadata = cluster_metadata(client, endpoint, &root).await?;
        validate_roster(&metadata, &cluster_endpoints, None, 0)?;
        ensure(
            metadata["observed_view"] == 0 && metadata["nodes"][0]["role"] == "leader",
            "初始三节点视图或主节点不符",
        )?;
        Some(
            metadata["name"]
                .as_str()
                .ok_or_else(|| io::Error::other("缺少集群名称"))?
                .to_owned(),
        )
    };
    let stream = create(client, endpoint, &root, "/streams", json!({"name":run_id})).await?;
    let stream_id = stream["id"]
        .as_u64()
        .ok_or_else(|| io::Error::other("缺少实验流ID"))?;
    let path = format!("/streams/{stream_id}/topics");
    let topic_body = |name: &str, policy: &str| {
        json!({
            "name":name,"partitions_count":1,"compression_algorithm":"none",
            "message_expiry":u64::MAX,"max_topic_size":u64::MAX,
            "options":{"durability":policy,"consumer_offset_durability":"persisted",
                "segment_size":"1 MiB","preallocate_segments":"false"}
        })
    };
    let topic = create(
        client,
        endpoint,
        &root,
        &path,
        topic_body("feedback", "persisted"),
    )
    .await?;
    let wrong = create(
        client,
        endpoint,
        &root,
        &path,
        topic_body("offset-only", "replicated"),
    )
    .await?;
    let config = config(endpoint, &stream, &topic)?;
    for role in ["writer", "reader", "denied"] {
        let permissions = if role == "denied" {
            Value::Null
        } else {
            json!({
                "global":{
                    "manage_servers":false,"read_servers":false,"manage_users":false,
                    "read_users":false,"manage_streams":false,"read_streams":false,
                    "manage_topics":false,"read_topics":false,"poll_messages":false,"send_messages":false
                },
                "streams":{stream_id.to_string():{
                    "manage_stream":false,"read_stream":false,"manage_topics":false,
                    "read_topics":false,"poll_messages":false,"send_messages":false,
                    "topics":{config.topic_id.to_string():{
                        "manage_topic":false,"read_topic":true,"poll_messages":false,"send_messages":role=="writer"
                    }}
                }}
            })
        };
        create(
            client,
            endpoint,
            &root,
            "/users",
            json!({
                "username":format!("{run_id}-{role}"),
                "password":password(root_password, &run_id, role),
                "status":"active","permissions":permissions
            }),
        )
        .await?;
    }
    let token = async |role: &str| {
        login(
            client,
            endpoint,
            &format!("{run_id}-{role}"),
            &password(root_password, &run_id, role),
        )
        .await
    };
    let writer = token("writer").await?;
    let reader = token("reader").await?;
    let denied = token("denied").await?;
    ensure(
        IggyFeedbackLog::new(config.clone(), denied)
            .map_err(io::Error::other)?
            .verify_readiness()
            .await
            .is_err(),
        "无权限用户错误通过主题预检",
    )?;
    let wrong_config = self::config(endpoint, &stream, &wrong)?;
    ensure(
        IggyFeedbackLog::new(wrong_config, root)
            .map_err(io::Error::other)?
            .verify_readiness()
            .await
            .is_err(),
        "消费位点持久性错误替代消息持久性",
    )?;

    let service_token = hash(run_id.as_bytes());
    let state = Arc::new(
        AppState::new(
            br#"{"version":"feedback-lab","items":[],"assets":[]}"#,
            None,
            &service_token,
            1,
            1,
        )
        .map_err(io::Error::other)?
        .with_feedback_log(config.clone(), writer)
        .map_err(io::Error::other)?,
    );
    let readiness = state.verify_feedback_readiness().await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let collector = format!("http://{}", listener.local_addr()?);
    let server =
        tokio::spawn(async move { axum::serve(listener, router(state, Role::Feedback)).await });
    let result = async {
        let mut offsets = Vec::new();
        for index in 0..2 {
            let archive = json!({
                "schema":"gateway-learning-events-v1","source_id":config.source_id,"data_kind":"synthetic",
                "events":[{"event_id":format!("{run_id}-{index}"),"decision_id":hash(b"synthetic-decision"),
                    "subject":"synthetic-subject","candidate_id":"synthetic-video","at":at.as_secs(),"kind":"visible"}]
            });
            let response = client.post(format!("{collector}/internal/v1/learning/events"))
                .bearer_auth(&service_token).json(&archive).send().await.map_err(io::Error::other)?;
            ensure(response.status()==StatusCode::ACCEPTED, "真实Iggy未确认反馈写入")?;
            let receipt: Value = response.json().await.map_err(io::Error::other)?;
            ensure(receipt["durability"]=="persisted" && receipt["base_offset"]==index,
                "真实Iggy持久化或偏移确认不符")?;
            offsets.push(index);
        }
        // 只读者也通过主题预检，但必须没有追加权限；使用合法消息体排除格式拒绝。
        let response = client.post(format!("{endpoint}/streams/{}/topics/{}/messages",config.stream_id,config.topic_id))
            .bearer_auth(&reader).json(&json!({
                "partitioning":{"kind":"partition_id","value":STANDARD.encode(config.partition_id.to_le_bytes())},
                "messages":[{"id":"1","payload":STANDARD.encode(b"forbidden")}]
            })).send().await.map_err(io::Error::other)?;
        ensure(response.status()==StatusCode::FORBIDDEN, "只读者追加没有按权限拒绝")?;
        let log = IggyFeedbackLog::new(config.clone(), reader).map_err(io::Error::other)?;
        let snapshot = log.snapshot(0, 2, &target.join("before.json")).await?;
        ensure(snapshot.events==2 && !snapshot.auto_commit, "真实Iggy快照不完整")?;
        let checkpoint = Checkpoint {
            schema:"iggy-feedback-restart-checkpoint-v1".into(),run_id,config,
            archive_sha256:snapshot.archive_sha256,
            topic_created_at:readiness.topic_created_at,
            partition_created_at:readiness.partition_created_at,
            cluster_endpoints,
            cluster_name,
        };
        fs::write(target.join("checkpoint.json"), serde_json::to_vec_pretty(&checkpoint)?)?;
        Ok(json!({"phase":"seed","passed":true,"backend":if checkpoint.cluster_endpoints.is_empty() {"real-iggy-singleton"} else {"real-iggy-local-cluster"},
            "confirmed_offsets":offsets,"events":2,"read_only_append_denied":true,
            "no_permission_read_denied":true,"offset_durability_not_message_policy":true,
            "physical_cluster_tested":false,"data_kind":"synthetic"}))
    }.await;
    server.abort();
    let _ = server.await;
    result
}

async fn verify(
    client: &Client,
    endpoint: &str,
    root_password: &str,
    target: &Path,
) -> io::Result<Value> {
    let checkpoint: Checkpoint =
        serde_json::from_slice(&fs::read(target.join("checkpoint.json"))?)?;
    ensure(
        checkpoint.schema == "iggy-feedback-restart-checkpoint-v1"
            && checkpoint.config.endpoint == endpoint,
        "重启检查点或目标地址不符",
    )?;
    let token = login(
        client,
        endpoint,
        &format!("{}-reader", checkpoint.run_id),
        &password(root_password, &checkpoint.run_id, "reader"),
    )
    .await?;
    let log = IggyFeedbackLog::new(checkpoint.config, token).map_err(io::Error::other)?;
    let readiness = log.verify_readiness().await?;
    ensure(
        readiness.topic_created_at == checkpoint.topic_created_at
            && readiness.partition_created_at == checkpoint.partition_created_at,
        "主题或分区身份已变化",
    )?;
    let snapshot = log.snapshot(0, 2, &target.join("after.json")).await?;
    ensure(
        snapshot.archive_sha256 == checkpoint.archive_sha256 && snapshot.events == 2,
        "重启前后反馈快照不一致",
    )?;
    ensure(
        fs::read(target.join("before.json"))? == fs::read(target.join("after.json"))?,
        "重启前后反馈归档字节不一致",
    )?;
    Ok(
        json!({"phase":"verify","passed":true,"backend":"real-iggy-singleton",
        "archive_sha256":snapshot.archive_sha256,"events":2,"auto_commit":false,
        "restart_kind":"external-runner-recorded","power_loss_tested":false,"physical_cluster_tested":false}),
    )
}

fn cluster_checkpoint(target: &Path, endpoint: &str) -> io::Result<Checkpoint> {
    let checkpoint: Checkpoint =
        serde_json::from_slice(&fs::read(target.join("checkpoint.json"))?)?;
    ensure(
        checkpoint.cluster_endpoints.len() == 3 && checkpoint.cluster_name.is_some(),
        "此模式需要三节点实验检查点",
    )?;
    checked_config(&checkpoint, endpoint)?;
    Ok(checkpoint)
}

async fn cluster_verify(
    client: &Client,
    endpoint: &str,
    root_password: &str,
    target: &Path,
    extended: bool,
) -> io::Result<Value> {
    let checkpoint = cluster_checkpoint(target, endpoint)?;
    let stage = required("VS_LAB_IGGY_STAGE")?;
    ensure(vs_core::valid_id(&stage), "实验阶段标识无效")?;
    let snapshot_path = target.join(format!("{stage}.json"));
    ensure(!snapshot_path.exists(), "实验快照不能覆盖")?;
    let expected = fs::read(target.join(if extended {
        "expected-extended.json"
    } else {
        "before.json"
    }))?;
    let expected_archive: GatewayLearningArchive = serde_json::from_slice(&expected)?;
    let token = login(
        client,
        endpoint,
        &format!("{}-reader", checkpoint.run_id),
        &password(root_password, &checkpoint.run_id, "reader"),
    )
    .await?;
    let log = IggyFeedbackLog::new(checked_config(&checkpoint, endpoint)?, token.clone())
        .map_err(io::Error::other)?;
    let started = std::time::Instant::now();
    let mut attempts = 0;
    // 只重试只读观察；快照完整验证后才发布，不据失败推断日志不存在。
    loop {
        attempts += 1;
        let attempt = async {
            let readiness = log.verify_readiness().await?;
            ensure(
                readiness.topic_created_at == checkpoint.topic_created_at
                    && readiness.partition_created_at == checkpoint.partition_created_at,
                "恢复后的主题或分区创建身份不符",
            )?;
            let metadata = cluster_metadata(client, endpoint, &token).await?;
            validate_roster(
                &metadata,
                &checkpoint.cluster_endpoints,
                checkpoint.cluster_name.as_deref(),
                1,
            )?;
            log.snapshot(0, if extended { 3 } else { 2 }, &snapshot_path)
                .await?;
            ensure(
                fs::read(&snapshot_path)? == expected,
                "恢复快照与已确认反馈不一致",
            )?;
            Ok::<_, io::Error>(metadata)
        }
        .await;
        match attempt {
            Ok(metadata) => {
                return Ok(json!({
                    "phase":stage,"passed":true,"backend":"real-iggy-local-cluster",
                    "endpoint":endpoint,"events":expected_archive.events.len(),"archive_sha256":hash(&expected),
                    "metadata":metadata,"read_attempts":attempts,"elapsed_ms":started.elapsed().as_millis(),
                    "auto_commit":false,"physical_cluster_tested":false
                }));
            }
            Err(error) => {
                // 已发布却内容不符属于数据错误，不能用重试掩盖。
                if snapshot_path.exists() || started.elapsed() >= Duration::from_secs(45) {
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

async fn cluster_write(
    client: &Client,
    endpoint: &str,
    root_password: &str,
    target: &Path,
    quorum_lost: bool,
) -> io::Result<Value> {
    let checkpoint = cluster_checkpoint(target, endpoint)?;
    ensure(
        !target
            .join(if quorum_lost {
                "unknown-attempt.json"
            } else {
                "majority-attempt.json"
            })
            .exists(),
        "同一实验写入阶段不可重复发送",
    )?;
    let config = checked_config(&checkpoint, endpoint)?;
    let token = login(
        client,
        endpoint,
        &format!("{}-writer", checkpoint.run_id),
        &password(root_password, &checkpoint.run_id, "writer"),
    )
    .await?;
    let service_token = hash(checkpoint.run_id.as_bytes());
    let state = Arc::new(
        AppState::new(
            br#"{"version":"feedback-lab","items":[],"assets":[]}"#,
            None,
            &service_token,
            1,
            1,
        )
        .map_err(io::Error::other)?
        .with_feedback_log(config, token)
        .map_err(io::Error::other)?,
    );
    if !quorum_lost {
        state.verify_feedback_readiness().await?;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let collector = format!("http://{}", listener.local_addr()?);
    let server =
        tokio::spawn(async move { axum::serve(listener, router(state, Role::Feedback)).await });
    let archive: GatewayLearningArchive = serde_json::from_value(json!({
        "schema":"gateway-learning-events-v1","source_id":"iggy-loopback-lab","data_kind":"synthetic",
        "events":[{"event_id":format!("{}-{}",checkpoint.run_id,if quorum_lost {"unknown"} else {"majority"}),
            "decision_id":hash(b"synthetic-decision"),"subject":"synthetic-subject","candidate_id":"synthetic-video",
            "at":SystemTime::now().duration_since(UNIX_EPOCH).map_err(io::Error::other)?.as_secs(),"kind":"visible"}]
    }))?;
    // 写前不可覆盖记录意图；即使进程在返回前中断，也不自动再发。
    let intent = target.join(if quorum_lost {
        "unknown-attempt.json"
    } else {
        "majority-attempt.json"
    });
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(intent)?;
    std::io::Write::write_all(&mut file, &serde_json::to_vec(&archive)?)?;
    file.sync_all()?;
    let started = std::time::Instant::now();
    let result = async {
        let response = client.post(format!("{collector}/internal/v1/learning/events"))
            .bearer_auth(&service_token).json(&archive).send().await.map_err(io::Error::other)?;
        let status = response.status();
        let receipt: Value = response.json().await.map_err(io::Error::other)?;
        if quorum_lost {
            ensure(status == StatusCode::SERVICE_UNAVAILABLE && receipt["commit_state"] == "unknown",
                "多数派丢失时错误确认写入或缺少未知状态")?;
        } else {
            ensure(status == StatusCode::ACCEPTED && receipt["durability"] == "persisted"
                && receipt["base_offset"] == 2, "多数派未确认连续追加")?;
            let mut expected: GatewayLearningArchive = serde_json::from_slice(&fs::read(target.join("before.json"))?)?;
            expected.events.extend(archive.events);
            let mut output = fs::OpenOptions::new().write(true).create_new(true).open(target.join("expected-extended.json"))?;
            std::io::Write::write_all(&mut output,&serde_json::to_vec(&expected)?)?;
            output.sync_all()?;
        }
        Ok(json!({"passed":true,"phase":if quorum_lost {"quorum-loss"} else {"majority-append"},
            "backend":"real-iggy-local-cluster","endpoint":endpoint,"http_status":status.as_u16(),
            "receipt":receipt,"elapsed_ms":started.elapsed().as_millis(),
            "client_write_attempts":1,"automatic_retry":false,"absence_claim":false,"physical_cluster_tested":false}))
    }.await;
    server.abort();
    let _ = server.await;
    result
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Iggy反馈实验失败：{error}");
        std::process::exit(1);
    }
}

async fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    ensure(
        args.len() == 2,
        "用法：iggy_feedback_contract <seed|verify|cluster-verify|cluster-verify-extended|cluster-append|quorum-loss> <实验目录>",
    )?;
    let mode = args[0]
        .to_str()
        .ok_or_else(|| io::Error::other("实验模式编码无效"))?;
    let endpoint = loopback_endpoint(&required("VS_LAB_IGGY_ENDPOINT")?)?;
    let endpoint = endpoint.as_str();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(io::Error::other)?;
    let root_password = required("VS_LAB_IGGY_PASSWORD")?;
    let target = Path::new(&args[1]);
    let result = match mode {
        "seed" => seed(&client, endpoint, &root_password, target).await?,
        "verify" => verify(&client, endpoint, &root_password, target).await?,
        "cluster-verify" => {
            cluster_verify(&client, endpoint, &root_password, target, false).await?
        }
        "cluster-verify-extended" => {
            cluster_verify(&client, endpoint, &root_password, target, true).await?
        }
        "cluster-append" => cluster_write(&client, endpoint, &root_password, target, false).await?,
        "quorum-loss" => cluster_write(&client, endpoint, &root_password, target, true).await?,
        _ => return Err(io::Error::other("不支持的实验模式")),
    };
    serde_json::to_writer_pretty(io::stdout(), &result)?;
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint() -> Checkpoint {
        Checkpoint {
            schema: "iggy-feedback-restart-checkpoint-v1".into(),
            run_id: "test".into(),
            config: IggyFeedbackConfig {
                endpoint: "http://127.0.0.1:3000".into(),
                fallback_endpoints: Vec::new(),
                stream_id: 0,
                topic_id: 0,
                partition_id: 0,
                source_id: "test".into(),
                data_kind: TrainingDataKind::Synthetic,
                operation_timeout_ms: 1000,
            },
            archive_sha256: hash(b"test"),
            topic_created_at: 1,
            partition_created_at: 1,
            cluster_endpoints: (3000..3003)
                .map(|port| format!("http://127.0.0.1:{port}"))
                .collect(),
            cluster_name: Some("cluster".into()),
        }
    }

    #[test]
    fn experimental_addresses_never_accept_remote_hosts_credentials_or_extra_paths() {
        for value in [
            "https://127.0.0.1:3000",
            "http://localhost:3000",
            "http://example.com",
            "http://user:secret@127.0.0.1",
            "http://127.0.0.1/path",
            "http://127.0.0.1?token=x",
        ] {
            assert!(loopback_endpoint(value).is_err(), "地址不应被接受：{value}");
        }
        assert_eq!(
            loopback_endpoint("http://127.0.0.1:3000/").unwrap(),
            "http://127.0.0.1:3000"
        );
    }

    #[test]
    fn alternate_endpoint_requires_the_pinned_allowlist_without_changing_coordinates() {
        let checkpoint = checkpoint();
        let config = checked_config(&checkpoint, "http://127.0.0.1:3001").unwrap();
        assert_eq!(config.topic_id, 0);
        assert_eq!(config.endpoint, "http://127.0.0.1:3001");
        assert!(checked_config(&checkpoint, "http://127.0.0.1:9999").is_err());
        assert_eq!(checkpoint.config.endpoint, "http://127.0.0.1:3000");
    }

    #[test]
    fn healthy_labels_do_not_override_wrong_roster_multiple_leaders_or_stale_views() {
        let checkpoint = checkpoint();
        let metadata = json!({"name":"cluster","observed_view":1,"nodes":[
            {"ip":"127.0.0.1","role":"follower","status":"healthy","endpoints":{"http":3000}},
            {"ip":"127.0.0.1","role":"leader","status":"healthy","endpoints":{"http":3001}},
            {"ip":"127.0.0.1","role":"follower","status":"healthy","endpoints":{"http":3002}}
        ]});
        assert!(
            validate_roster(&metadata, &checkpoint.cluster_endpoints, Some("cluster"), 1).is_ok()
        );
        for index in 0..6 {
            let mut invalid = metadata.clone();
            match index {
                0 => invalid["observed_view"] = json!(0),
                1 => invalid["name"] = json!("another-cluster"),
                2 => invalid["nodes"][0]["role"] = json!("leader"),
                3 => invalid["nodes"][0]["ip"] = json!("example.com"),
                4 => invalid["nodes"][0]["endpoints"]["http"] = json!(9999),
                _ => invalid["nodes"][0]["endpoints"]["http"] = json!(3001),
            }
            assert!(
                validate_roster(&invalid, &checkpoint.cluster_endpoints, Some("cluster"), 1)
                    .is_err()
            );
        }
    }
}
