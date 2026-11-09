use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use vs_coordination::profile_authority::ProfilePolicy;

#[path = "support/load_schedule.rs"]
mod schedule;

const TOKEN: &str = "synthetic-profile-load-only-token-000000000";
const CATALOG: &[u8] = br#"{"version":"profile-load-v1","assets":[],"items":[
{"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
{"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null},
{"id":"service","domain":"service","tags":["storage"],"prior":0.6,"media_sha256":null}]}"#;
const SUBJECTS: usize = 16;
const REQUESTS: usize = 192;
const RESPONSE_LIMIT: usize = 65_536;

type Check<T> = Result<T, Box<dyn std::error::Error>>;

struct Node(Child);
impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn client() -> Check<reqwest::Client> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Ok(reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(4))
        .pool_max_idle_per_host(32)
        .build()?)
}

async fn body(mut response: reqwest::Response) -> Check<(u16, Vec<u8>)> {
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > RESPONSE_LIMIT.saturating_sub(bytes.len()) {
            return Err(invalid("响应正文超过预算").into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, bytes))
}

async fn post(client: &reqwest::Client, url: &str, value: &Value) -> Check<Value> {
    let (status, bytes) = body(
        client
            .post(url)
            .bearer_auth(TOKEN)
            .json(value)
            .send()
            .await?,
    )
    .await?;
    if status != 200 {
        return Err(invalid(&format!("准备或核对请求失败：{status}")).into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn target() -> Value {
    json!({"node_id":"load-writer","incarnation":"aaaaaaaaaaaaaaaaaaaaaa"})
}

fn event(
    policy: &ProfilePolicy,
    subject: &str,
    id: &str,
    candidate: &str,
    kind: &str,
    epochs: &[u64; 2],
) -> Value {
    let shard = policy.shard_for(subject);
    json!({"operation":"commit_profile_event","shard":shard,"writer_epoch":epochs[usize::from(shard)],
        "target":target(),"event":{"event_id":id,"subject":subject,"candidate_id":candidate,"kind":kind}})
}

fn request(index: usize, policy: &ProfilePolicy, epochs: &[u64; 2]) -> (&'static str, Value) {
    let subject_index = (index / 3) % SUBJECTS;
    let subject = format!("subject-{subject_index}");
    match index % 3 {
        0 => (
            "/internal/lab/profile/commands",
            event(
                policy,
                &subject,
                &format!("load-{index}"),
                if index.is_multiple_of(2) {
                    "video"
                } else {
                    "service"
                },
                "like",
                epochs,
            ),
        ),
        1 => (
            "/internal/lab/profile/commands",
            event(
                policy,
                &subject,
                &format!("seed-{subject_index}"),
                "document",
                "hide",
                epochs,
            ),
        ),
        _ => (
            "/internal/lab/profile/projection",
            json!({"subject":subject,"domains":["video","document","service"]}),
        ),
    }
}

async fn measured(
    client: reqwest::Client,
    endpoint: String,
    index: usize,
    policy: ProfilePolicy,
    epochs: [u64; 2],
) -> (String, Option<u16>, usize, usize) {
    let (path, value) = request(index, &policy, &epochs);
    let encoded = serde_json::to_vec(&value).unwrap();
    let request_bytes = encoded.len();
    let result = async {
        body(
            client
                .post(format!("{endpoint}{path}"))
                .bearer_auth(TOKEN)
                .header("content-type", "application/json")
                .body(encoded)
                .send()
                .await?,
        )
        .await
    }
    .await;
    let Ok((status, bytes)) = result else {
        return ("unknown_transport".into(), None, request_bytes, 0);
    };
    if matches!(status, 503 | 504) {
        let outcome = match bytes.as_slice() {
            bytes if bytes == "画像尚未确认提案预算已满".as_bytes() => {
                "unknown_write_budget"
            }
            bytes if bytes == "协调请求预算已满".as_bytes() => "unknown_request_budget",
            _ => "unknown_or_rejected",
        };
        return (outcome.into(), Some(status), request_bytes, bytes.len());
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let valid_version = |value: &Value| {
        value
            .as_str()
            .and_then(|version| version.strip_prefix("memory-"))
            .and_then(|number| number.parse::<u64>().ok())
            .is_some_and(|version| version > 0)
    };
    let verified = if index % 3 == 2 {
        value["schema"] == "profile-consensus-projection-v1"
            && value["catalog_sha256"] == policy.catalog_sha256
            && value["profile"]["subject"] == format!("subject-{}", (index / 3) % SUBJECTS)
            && value["profile"]["scopes"] == json!(["video", "document", "service"])
            && value["profile"]["blocked_ids"] == json!(["document"])
            && valid_version(&value["profile"]["version"])
    } else if index % 3 == 1 {
        value["outcome"] == "duplicate"
            && value["event"]["duplicate"] == true
            && value["event"]["accepted"] == false
            && valid_version(&value["event"]["profile_version"])
            && value["writer"]["owner"] == target()
            && value["writer"]["revision"]
                == epochs
                    [usize::from(policy.shard_for(&format!("subject-{}", (index / 3) % SUBJECTS)))]
    } else {
        value["outcome"] == "applied"
            && value["event"]["accepted"] == true
            && value["event"]["duplicate"] == false
            && valid_version(&value["event"]["profile_version"])
            && value["writer"]["owner"] == target()
            && value["writer"]["revision"]
                == epochs
                    [usize::from(policy.shard_for(&format!("subject-{}", (index / 3) % SUBJECTS)))]
    };
    let outcome = if status != 200 || !verified {
        "protocol_error"
    } else {
        match index % 3 {
            0 => "new_confirmed",
            1 => "duplicate_confirmed",
            _ => "read_verified",
        }
    };
    (outcome.into(), Some(status), request_bytes, bytes.len())
}

async fn live(client: &reqwest::Client, ports: &[u16], nodes: &mut [Node]) -> Check<()> {
    let until = Instant::now() + Duration::from_secs(10);
    for (port, node) in ports.iter().zip(nodes) {
        loop {
            if node.0.try_wait()?.is_some() {
                return Err(invalid("实验节点提前退出，查看节点stderr").into());
            }
            if client
                .get(format!("http://127.0.0.1:{port}/metrics"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            if Instant::now() >= until {
                return Err(invalid("实验节点未及时就绪").into());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    Ok(())
}

async fn leader(client: &reqwest::Client, ports: &[u16]) -> Check<String> {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        for port in ports {
            let endpoint = format!("http://127.0.0.1:{port}");
            if let Ok(response) = client
                .get(format!("{endpoint}/metrics"))
                .bearer_auth(TOKEN)
                .send()
                .await
                && let Ok((200, bytes)) = body(response).await
                && serde_json::from_slice::<Value>(&bytes)?["state"] == "Leader"
                && client
                    .get(format!("{endpoint}/internal/lab/profile/writers/0"))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success())
            {
                return Ok(endpoint);
            }
        }
        if Instant::now() >= until {
            return Err(invalid("未获得画像实验主节点").into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn emit(value: Value) -> Check<()> {
    println!("{value}");
    io::stdout().flush()?;
    Ok(())
}

fn publish(path: &Path, value: &Value) -> Check<()> {
    // 仅创建新的实验收据，不覆盖既有结果。
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

async fn run() -> Check<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 5 {
        return Err(invalid("参数：服务程序绝对路径 新实验目录 投票数 预填事件数 请求速率").into());
    }
    let binary = PathBuf::from(&args[0]);
    let root = PathBuf::from(&args[1]);
    let number = |index: usize| -> Check<usize> {
        Ok(args[index]
            .to_str()
            .ok_or_else(|| invalid("参数编码无效"))?
            .parse()?)
    };
    let voters = number(2)?;
    let prefill = number(3)?;
    let rate = number(4)?;
    if !binary.is_absolute()
        || !binary.is_file()
        || !root.is_absolute()
        || !matches!(voters, 1 | 3)
        || !matches!(prefill, 16 | 128)
        || !(1..=1000).contains(&rate)
    {
        return Err(invalid("实验路径、投票数、预填数或速率无效").into());
    }
    std::fs::create_dir(&root)?;
    let catalog_path = root.join("catalog.json");
    std::fs::write(&catalog_path, CATALOG)?;
    let policy = ProfilePolicy::from_catalog(CATALOG, 2)?;
    let client = client()?;
    let mut reservations = Vec::new();
    for _ in 0..voters {
        reservations.push(std::net::TcpListener::bind("127.0.0.1:0")?);
    }
    let ports: Vec<_> = reservations
        .iter()
        .map(|listener| listener.local_addr().unwrap().port())
        .collect();
    let peers: BTreeMap<_, _> = ports
        .iter()
        .enumerate()
        .map(|(index, port)| (index as u64 + 1, format!("127.0.0.1:{port}")))
        .collect();
    let mut nodes = Vec::new();
    drop(reservations);
    for (index, port) in ports.iter().enumerate() {
        let id = index + 1;
        let config = root.join(format!("node-{id}.json"));
        std::fs::write(
            &config,
            serde_json::to_vec(&json!({
                "cluster_id":"profile-load-lab","node_id":id,"bind":format!("127.0.0.1:{port}"),
                "data_dir":root.join(format!("node-{id}")),"peers":peers,
                "voters":(1..=voters).collect::<Vec<_>>(),"service_token":TOKEN,
                "profile_catalog":catalog_path,"profile_shard_count":2
            }))?,
        )?;
        let mut command = Command::new(&binary);
        command
            .env("VS_COORDINATION_CONFIG", &config)
            .env("VS_COORDINATION_RUN_SECONDS", "120")
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(
                root.join(format!("stderr-{id}.log")),
            )?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        nodes.push(Node(command.spawn()?));
    }
    let pids: Vec<_> = nodes.iter().map(|node| node.0.id()).collect();
    live(&client, &ports, &mut nodes).await?;
    emit(
        json!({"schema":"profile-load-lifecycle-v1","phase":"processes","pids":pids,"probe_pid":std::process::id()}),
    )?;
    if std::env::var("VS_PROFILE_LOAD_SUPERVISED").as_deref() == Ok("1") {
        // 采样器核对真实PID后才允许进入准备/测量，防止短单元先退出导致身份读取竞态。
        let mut byte = [0];
        io::stdin().read_exact(&mut byte)?;
        if byte != [b'1'] {
            return Err(invalid("负载采样握手无效").into());
        }
    }
    let response = client
        .post(format!("http://127.0.0.1:{}/admin/initialize", ports[0]))
        .bearer_auth(TOKEN)
        .send()
        .await?;
    if response.status().as_u16() != 204 {
        return Err(invalid("实验集群初始化失败").into());
    }
    let endpoint = leader(&client, &ports).await?;
    let commands = format!("{endpoint}/internal/lab/profile/commands");
    let mut epochs = [0; 2];
    for (shard, epoch) in epochs.iter_mut().enumerate() {
        let value = post(&client, &commands, &json!({"operation":"set_profile_writer","change":{
            "operation_id":format!("initial-{shard}"),"shard":shard,"expected_revision":null,"target":target()
        }})).await?;
        *epoch = value["writer"]["revision"]
            .as_u64()
            .ok_or_else(|| invalid("未获得写者代次"))?;
    }
    let mut before = [0_u64; SUBJECTS];
    for index in 0..prefill {
        let subject_index = index % SUBJECTS;
        let subject = format!("subject-{subject_index}");
        let (id, candidate, kind) = if index < SUBJECTS {
            (format!("seed-{subject_index}"), "document", "hide")
        } else {
            (format!("prefill-{index}"), "video", "like")
        };
        let value = post(
            &client,
            &commands,
            &event(&policy, &subject, &id, candidate, kind, &epochs),
        )
        .await?;
        if value["outcome"] != "applied" {
            return Err(invalid("实验预填未被确认").into());
        }
        before[subject_index] += 1;
    }
    // 预填与连接预热不进入测量延迟，资源采样以phase边界另记。
    for _ in 0..4 {
        post(
            &client,
            &format!("{endpoint}/internal/lab/profile/projection"),
            &json!({"subject":"subject-0","domains":["video","document","service"]}),
        )
        .await?;
    }
    emit(
        json!({"schema":"profile-load-lifecycle-v1","phase":"measure","pids":pids,"probe_pid":std::process::id()}),
    )?;
    let start = Instant::now();
    let samples = schedule::run(REQUESTS, rate as u32, 32, |index| {
        measured(
            client.clone(),
            endpoint.clone(),
            index,
            policy.clone(),
            epochs,
        )
    })
    .await;
    let elapsed_ns = start.elapsed().as_nanos() as u64;
    // 换代命令与在途事件同序；屏障之后旧epoch不能再追加，核对有确定的截止边界。
    for (shard, epoch) in epochs.iter().enumerate() {
        let value = post(
            &client,
            &commands,
            &json!({"operation":"set_profile_writer","change":{
                "operation_id":format!("settle-{shard}"),"shard":shard,
                "expected_revision":epoch,"target":target()
            }}),
        )
        .await?;
        if value["outcome"] != "applied" {
            return Err(invalid("测量后写者屏障未被确认，不能核对最终事实").into());
        }
    }
    let mut outcomes = BTreeMap::<String, usize>::new();
    let mut confirmed = [0_u64; SUBJECTS];
    let mut unknown = [0_u64; SUBJECTS];
    for sample in &samples {
        *outcomes.entry(sample.outcome.clone()).or_default() += 1;
        if sample.sequence % 3 == 0 {
            let subject = (sample.sequence / 3) % SUBJECTS;
            if sample.outcome == "new_confirmed" {
                confirmed[subject] += 1;
            }
            if sample.outcome.starts_with("unknown") {
                unknown[subject] += 1;
            }
        }
    }
    let mut projections = Vec::new();
    let mut correctness = !outcomes.contains_key("protocol_error");
    let mut final_records = 0;
    for index in 0..SUBJECTS {
        let value = post(
            &client,
            &format!("{endpoint}/internal/lab/profile/projection"),
            &json!({"subject":format!("subject-{index}"),"domains":["video","document","service"]}),
        )
        .await?;
        let version = value["profile"]["version"]
            .as_str()
            .and_then(|version| version.strip_prefix("memory-"))
            .and_then(|version| version.parse::<u64>().ok())
            .ok_or_else(|| invalid("最终画像版本无效"))?;
        correctness &= value["profile"]["blocked_ids"] == json!(["document"])
            && version >= before[index] + confirmed[index]
            && version <= before[index] + confirmed[index] + unknown[index];
        final_records += version;
        projections.push(
            json!({"subject_index":index,"before":before[index],"confirmed_new":confirmed[index],
            "unknown_new":unknown[index],"final_version":version}),
        );
    }
    let value = client
        .get(format!("{endpoint}/internal/lab/profile/writers/0"))
        .bearer_auth(TOKEN)
        .send()
        .await?;
    let (status, bytes) = body(value).await?;
    correctness &=
        status == 200 && serde_json::from_slice::<Value>(&bytes)?["events"] == final_records;
    let summary = |kind| {
        json!({
        "attempted_scheduled":schedule::percentiles(samples.iter().filter(|sample|sample.sequence%3 == kind && sample.service_ns.is_some()).map(|sample|sample.scheduled_elapsed_ns)),
            "service":schedule::percentiles(samples.iter().filter(|sample|sample.sequence%3 == kind).filter_map(|sample|sample.service_ns)),
        "verified_scheduled":schedule::percentiles(samples.iter().filter(|sample|sample.sequence%3 == kind && (sample.outcome.ends_with("confirmed") || sample.outcome == "read_verified")).map(|sample|sample.scheduled_elapsed_ns))
        })
    };
    let report = json!({
        "schema":"profile-load-report-v1","build":if cfg!(debug_assertions) { "debug" } else { "release" },
        "physical_hosts":1,"voters":voters,"raft_groups":1,"prefill_events":prefill,"subjects":SUBJECTS,
        "offered_rate":rate,"scheduled_requests":REQUESTS,"client_inflight_limit":32,"elapsed_ns":elapsed_ns,
        "outcomes":outcomes,"latency":{"new":summary(0),"duplicate":summary(1),"read":summary(2)},
        "samples":samples,"final_projections":projections,"final_events":final_records,
        "correctness_passed":correctness,"production_capacity_claimed":false,
        "payload_bytes_not_wire_billing":true,"retries":0,"unbounded_queue":false,
        "latency_excludes_dropped_arrivals_but_outcomes_keep_them":true,
        "writer_barrier_before_final_reconciliation":true
        ,"dispatch_lag":schedule::percentiles(samples.iter().filter_map(|sample|sample.dispatch_lag_ns))
        ,"quantile_method":"exact_nearest_rank_no_resampling"
        ,"few_samples_not_stable_population_p99":true
    });
    publish(&root.join("report.json"), &report)?;
    emit(
        json!({"schema":"profile-load-lifecycle-v1","phase":"measured","pids":pids,"probe_pid":std::process::id(),"correctness":correctness}),
    )?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(nodes);
    for port in ports {
        drop(std::net::TcpListener::bind(("127.0.0.1", port))?);
    }
    emit(
        json!({"schema":"profile-load-lifecycle-v1","phase":"reclaimed","pids":pids,"probe_pid":std::process::id()}),
    )?;
    if !correctness {
        return Err(invalid("画像负载最终事实核对失败，已保留报告").into());
    }
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Check<()> {
    run().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workload_budget_keeps_unique_events_below_capacity_and_duplicate_ids_bound_to_subject() {
        let policy = ProfilePolicy::from_catalog(CATALOG, 2).unwrap();
        let mut kinds = [0; 3];
        for index in 0..REQUESTS {
            kinds[index % 3] += 1;
            let (_, value) = request(index, &policy, &[1, 2]);
            let subject_index = (index / 3) % SUBJECTS;
            if index % 3 == 1 {
                assert_eq!(value["event"]["event_id"], format!("seed-{subject_index}"));
            }
        }
        assert_eq!(kinds, [64, 64, 64]);
        assert!(128 + kinds[0] <= vs_coordination::profile_authority::MAX_EVENTS);
    }

    #[tokio::test]
    async fn forged_success_redirect_oversize_and_budget_outcomes_are_not_silently_accepted() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        for case in [
            "correct",
            "subject",
            "hidden",
            "epoch",
            "malformed",
            "oversize",
            "redirect",
            "write_budget",
            "request_budget",
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let seen = calls.clone();
            let policy = ProfilePolicy::from_catalog(CATALOG, 2).unwrap();
            let projection = json!({"schema":"profile-consensus-projection-v1","catalog_sha256":policy.catalog_sha256,
                "profile":{"subject":"subject-0","scopes":["video","document","service"],
                "blocked_ids":["document"],"version":"memory-1"}});
            let app = axum::Router::new().fallback(axum::routing::any(move || {
                seen.fetch_add(1, Ordering::Relaxed);
                let mut projection = projection.clone();
                async move {
                    let mut response = axum::http::Response::builder();
                    let body = match case {
                        "subject" => {
                            projection["profile"]["subject"] = json!("forged");
                            serde_json::to_vec(&projection).unwrap()
                        }
                        "hidden" => {
                            projection["profile"]["blocked_ids"] = json!([]);
                            serde_json::to_vec(&projection).unwrap()
                        }
                        "epoch" => serde_json::to_vec(
                            &json!({"outcome":"applied","writer":{"revision":99},
                            "event":{"accepted":true,"duplicate":false}}),
                        )
                        .unwrap(),
                        "malformed" => b"{".to_vec(),
                        "oversize" => vec![b' '; RESPONSE_LIMIT + 1],
                        "redirect" => {
                            response = response.status(307).header("location", "/unexpected");
                            Vec::new()
                        }
                        "write_budget" => {
                            response = response.status(503);
                            "画像尚未确认提案预算已满".as_bytes().to_vec()
                        }
                        "request_budget" => {
                            response = response.status(503);
                            "协调请求预算已满".as_bytes().to_vec()
                        }
                        _ => serde_json::to_vec(&projection).unwrap(),
                    };
                    response.body(axum::body::Body::from(body)).unwrap()
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let index = if case == "epoch" { 0 } else { 2 };
            let outcome = measured(client().unwrap(), endpoint, index, policy, [1, 2]).await;
            task.abort();
            let _ = task.await;
            let expected = match case {
                "correct" => "read_verified",
                "oversize" => "unknown_transport",
                "write_budget" => "unknown_write_budget",
                "request_budget" => "unknown_request_budget",
                _ => "protocol_error",
            };
            assert_eq!(outcome.0, expected, "反例：{case}");
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
    }
}
