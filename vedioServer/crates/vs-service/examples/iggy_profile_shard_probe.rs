// SPDX-License-Identifier: Apache-2.0
// HTTP消息结构局部改编自Apache Iggy固定提交91e0206367aad2d30259f7d45203832b08ae84e7。
// 保留上游许可与NOTICE，见LICENSES/iggy-*；不复制二进制协议、日志或共识实现。
use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    io,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::valid_id;

const MAX_SUBJECTS: usize = 4096;
const MAX_EVENTS_PER_SUBJECT: usize = 32;
const MAX_RESPONSE_BYTES: usize = 4096;
const MAX_READ_RESPONSE_BYTES: usize = 16 * 1024;
const READ_BATCH: usize = 8;
const MAX_RUN_SECONDS: u64 = 300;

#[derive(Serialize)]
struct ProbeEvent<'a> {
    schema: &'static str,
    run_id: &'a str,
    subject: String,
    sequence: usize,
}

#[derive(Deserialize)]
struct Confirmations {
    confirmations: Vec<Confirmation>,
}

#[derive(Deserialize)]
struct Confirmation {
    partition_id: u32,
    base_offset: u64,
}

#[derive(Serialize, Deserialize)]
struct PartitionContext {
    incarnation: u64,
    owner_generation: u64,
}

#[derive(Serialize, Deserialize)]
struct PolledMessages {
    context: PartitionContext,
    partition_id: u32,
    count: usize,
    messages: Vec<PolledMessage>,
}

#[derive(Serialize, Deserialize)]
struct PolledMessage {
    header: MessageHeader,
    payload: String,
}

#[derive(Serialize, Deserialize)]
struct MessageHeader {
    id: u128,
    offset: u64,
    payload_length: usize,
}

struct ExpectedMessage {
    offset: u64,
    id: u128,
    payload_bytes: usize,
    sha256: [u8; 32],
}

#[derive(Default)]
struct SubjectProgress {
    partition_id: Option<u32>,
    last_offset: Option<u64>,
}

#[derive(Serialize)]
struct ProbeReport {
    schema: &'static str,
    run_id: String,
    subjects: usize,
    events_per_subject: usize,
    messages_confirmed: usize,
    partitions_observed: usize,
    partition_counts: BTreeMap<u32, usize>,
    request_bytes: usize,
    response_bytes: usize,
    readback_messages: usize,
    readback_requests: usize,
    readback_response_bytes: usize,
    auto_commit: bool,
    logical_write_retries: usize,
    consumer_group_tested: bool,
    physical_cluster_tested: bool,
    durability: &'static str,
}

fn required(name: &str) -> Result<String, io::Error> {
    std::env::var(name).map_err(|_| io::Error::other(format!("缺少环境配置：{name}")))
}

fn bounded_count(name: &str, default: usize, maximum: usize) -> Result<usize, Box<dyn Error>> {
    let value = match std::env::var(name) {
        Ok(value) => value.parse()?,
        Err(std::env::VarError::NotPresent) => default,
        Err(error) => return Err(error.into()),
    };
    if value == 0 || value > maximum {
        return Err(io::Error::other(format!("{name}超出预算")).into());
    }
    Ok(value)
}

fn validate_segment(name: &str, value: &str) -> Result<(), io::Error> {
    if !valid_id(value) {
        return Err(io::Error::other(format!("{name}格式无效")));
    }
    Ok(())
}

fn validate_run_id(value: &str) -> Result<(), io::Error> {
    if value.len() > 24 {
        return Err(io::Error::other("探针运行标识最长24字节"));
    }
    validate_segment("run_id", value)
}

fn loopback_endpoint(value: &str) -> io::Result<String> {
    let url = reqwest::Url::parse(value).map_err(|_| io::Error::other("实验地址无效"))?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(io::Error::other("只接受不含凭证和额外路径的HTTP回环地址"));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn message_id(payload: &[u8]) -> u128 {
    u128::from_be_bytes(Sha256::digest(payload)[..16].try_into().unwrap())
}

fn message_body(subject: &str, payload: &[u8]) -> Value {
    json!({
        "partitioning": {
            "kind": "messages_key",
            "value": STANDARD.encode(subject.as_bytes())
        },
        "messages": [{
            "id": message_id(payload).to_string(),
            "payload": STANDARD.encode(payload)
        }]
    })
}

fn record_confirmation(
    progress: &mut HashMap<String, SubjectProgress>,
    partition_counts: &mut BTreeMap<u32, usize>,
    subject: &str,
    partition_id: u32,
    offset: u64,
) -> Result<(), io::Error> {
    let subject_progress = progress.entry(subject.to_owned()).or_default();
    if subject_progress
        .partition_id
        .is_some_and(|previous| previous != partition_id)
        || subject_progress
            .last_offset
            .is_some_and(|previous| offset <= previous)
    {
        return Err(io::Error::other("同一subject发生跨分区或offset非单调"));
    }
    subject_progress.partition_id = Some(partition_id);
    subject_progress.last_offset = Some(offset);
    *partition_counts.entry(partition_id).or_default() += 1;
    Ok(())
}

async fn bounded_body(response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, io::Error> {
    let mut response = response;
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(io::Error::other("Iggy响应正文超过预算"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| io::Error::other("Iggy响应正文读取失败"))?
    {
        if chunk.len() > maximum.saturating_sub(bytes.len()) {
            return Err(io::Error::other("Iggy响应正文超过预算"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn send_one(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    stream: &str,
    topic: &str,
    subject: &str,
    payload: &[u8],
) -> Result<(usize, usize, Confirmation), Box<dyn Error>> {
    let body = serde_json::to_vec(&message_body(subject, payload))?;
    let request_bytes = body.len();
    let response = client
        .post(format!(
            "{endpoint}/streams/{stream}/topics/{topic}/messages"
        ))
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| io::Error::other("消息提交结果未知；未重试，不应推断消息不存在"))?;
    if response.status() != reqwest::StatusCode::CREATED
        || response
            .headers()
            .get("iggy-durability")
            .and_then(|value| value.to_str().ok())
            .is_none_or(|value| !value.eq_ignore_ascii_case("persisted"))
    {
        return Err(
            io::Error::other("Iggy未给出有效持久化确认；未重试，不应推断消息不存在").into(),
        );
    }
    let bytes = bounded_body(response, MAX_RESPONSE_BYTES).await?;
    let confirmations: Confirmations = serde_json::from_slice(&bytes)?;
    let [confirmation] = confirmations.confirmations.as_slice() else {
        return Err(io::Error::other("Iggy确认分区数量不是1").into());
    };
    Ok((
        request_bytes,
        bytes.len(),
        Confirmation {
            partition_id: confirmation.partition_id,
            base_offset: confirmation.base_offset,
        },
    ))
}

fn read_url(
    endpoint: &str,
    stream: &str,
    topic: &str,
    partition: u32,
    offset: u64,
    count: usize,
) -> io::Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(&format!(
        "{endpoint}/streams/{stream}/topics/{topic}/messages"
    ))
    .map_err(|_| io::Error::other("消息读取地址无效"))?;
    url.query_pairs_mut().extend_pairs([
        ("consumer_id", "1".into()),
        ("partition_id", partition.to_string()),
        ("kind", "offset".into()),
        ("value", offset.to_string()),
        ("count", count.to_string()),
        ("auto_commit", "false".into()),
    ]);
    Ok(url)
}

fn verify_readback(
    batch: &PolledMessages,
    partition: u32,
    expected: &[ExpectedMessage],
    incarnation: &mut Option<u64>,
) -> io::Result<()> {
    if expected.is_empty()
        || batch.partition_id != partition
        || batch.count != batch.messages.len()
        || batch.count == 0
        || batch.count > expected.len()
        || batch.context.owner_generation != 0
        || incarnation.is_some_and(|previous| previous != batch.context.incarnation)
    {
        return Err(io::Error::other("读回分区、数量或历史身份不符"));
    }
    for (message, expected) in batch.messages.iter().zip(expected) {
        let payload = STANDARD
            .decode(&message.payload)
            .map_err(|_| io::Error::other("读回消息编码无效"))?;
        if message.header.offset != expected.offset
            || message.header.id != expected.id
            || message.header.payload_length != expected.payload_bytes
            || payload.len() != expected.payload_bytes
            || <[u8; 32]>::from(Sha256::digest(&payload)) != expected.sha256
        {
            return Err(io::Error::other(
                "读回消息偏移、标识、长度或正文与确认记录不符",
            ));
        }
    }
    // 验证整页后才推进观察状态，失败页不构成已读证据。
    *incarnation = Some(batch.context.incarnation);
    Ok(())
}

fn remember_expected(
    pending: &mut BTreeMap<u32, Vec<ExpectedMessage>>,
    confirmation: &Confirmation,
    payload: &[u8],
) -> io::Result<()> {
    let partition = pending.entry(confirmation.partition_id).or_default();
    if partition
        .last()
        .is_some_and(|previous| previous.offset.checked_add(1) != Some(confirmation.base_offset))
    {
        return Err(io::Error::other(
            "专用实验分区的确认offset不连续；停止读回，不掩盖并发写入",
        ));
    }
    partition.push(ExpectedMessage {
        offset: confirmation.base_offset,
        id: message_id(payload),
        payload_bytes: payload.len(),
        sha256: Sha256::digest(payload).into(),
    });
    Ok(())
}

fn probe_client() -> Result<reqwest::Client, reqwest::Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

async fn readback(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    stream: &str,
    topic: &str,
    pending: &BTreeMap<u32, Vec<ExpectedMessage>>,
) -> Result<(usize, usize, usize), Box<dyn Error>> {
    let mut messages = 0;
    let mut requests = 0;
    let mut response_bytes = 0;
    for (&partition, expected) in pending {
        let mut cursor = 0;
        let mut incarnation = None;
        while cursor < expected.len() {
            let window = &expected[cursor..expected.len().min(cursor + READ_BATCH)];
            let url = read_url(
                endpoint,
                stream,
                topic,
                partition,
                window[0].offset,
                window.len(),
            )?;
            let response = client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| io::Error::other("固定offset读回失败，未改消费位点"))?;
            if response.status() != reqwest::StatusCode::OK {
                return Err(io::Error::other("固定offset读回被拒绝，未改消费位点").into());
            }
            let bytes = bounded_body(response, MAX_READ_RESPONSE_BYTES).await?;
            let batch: PolledMessages = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::other("读回消息响应格式无效"))?;
            verify_readback(&batch, partition, window, &mut incarnation)?;
            cursor += batch.count;
            messages += batch.count;
            requests += 1;
            response_bytes += bytes.len();
        }
    }
    Ok((messages, requests, response_bytes))
}

async fn run() -> Result<ProbeReport, Box<dyn Error>> {
    let endpoint = loopback_endpoint(&required("VS_IGGY_PROFILE_HTTP")?)?;
    let token = required("VS_IGGY_PROFILE_TOKEN")?;
    let stream = required("VS_IGGY_PROFILE_STREAM")?;
    let topic = required("VS_IGGY_PROFILE_TOPIC")?;
    let run_id = required("VS_IGGY_PROFILE_RUN_ID")?;
    validate_segment("stream", &stream)?;
    validate_segment("topic", &topic)?;
    validate_run_id(&run_id)?;
    let subjects = bounded_count("VS_IGGY_PROFILE_SUBJECTS", 256, MAX_SUBJECTS)?;
    let events_per_subject = bounded_count(
        "VS_IGGY_PROFILE_EVENTS_PER_SUBJECT",
        4,
        MAX_EVENTS_PER_SUBJECT,
    )?;
    if subjects.saturating_mul(events_per_subject) > 50_000 {
        return Err(io::Error::other("探针消息总数超过预算").into());
    }
    let client = probe_client()?;
    let mut progress = HashMap::with_capacity(subjects);
    let mut partition_counts = BTreeMap::new();
    let mut request_bytes = 0;
    let mut response_bytes = 0;
    let mut messages_confirmed = 0;
    let mut pending = BTreeMap::new();

    for subject_index in 0..subjects {
        let subject = format!("probe-{run_id}-user-{subject_index}");
        validate_segment("synthetic subject", &subject)?;
        for sequence in 0..events_per_subject {
            let event = ProbeEvent {
                schema: "profile-shard-probe-v1",
                run_id: &run_id,
                subject: subject.clone(),
                sequence,
            };
            let payload = serde_json::to_vec(&event)?;
            let (sent, received, confirmation) = send_one(
                &client, &endpoint, &token, &stream, &topic, &subject, &payload,
            )
            .await?;
            remember_expected(&mut pending, &confirmation, &payload)?;
            record_confirmation(
                &mut progress,
                &mut partition_counts,
                &subject,
                confirmation.partition_id,
                confirmation.base_offset,
            )?;
            request_bytes += sent;
            response_bytes += received;
            messages_confirmed += 1;
        }
    }
    if partition_counts.len() < 2 {
        return Err(
            io::Error::other("主体键只命中一个分区；确认topic至少配置两个partition后重跑").into(),
        );
    }
    let (readback_messages, readback_requests, readback_response_bytes) =
        readback(&client, &endpoint, &token, &stream, &topic, &pending).await?;
    Ok(ProbeReport {
        schema: "iggy-profile-shard-probe-v2",
        run_id,
        subjects,
        events_per_subject,
        messages_confirmed,
        partitions_observed: partition_counts.len(),
        partition_counts,
        request_bytes,
        response_bytes,
        readback_messages,
        readback_requests,
        readback_response_bytes,
        auto_commit: false,
        logical_write_retries: 0,
        consumer_group_tested: false,
        physical_cluster_tested: false,
        durability: "persisted",
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let report = tokio::time::timeout(Duration::from_secs(MAX_RUN_SECONDS), run())
        .await
        .map_err(|_| io::Error::other("探针超过总期限；在途写入可能已提交，禁止盲目重发"))??;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Body,
        extract::Request,
        http::Response,
        routing::{get, post},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn expected_messages(partition: u32, count: usize) -> BTreeMap<u32, Vec<ExpectedMessage>> {
        let mut pending = BTreeMap::new();
        for index in 0..count {
            remember_expected(
                &mut pending,
                &Confirmation {
                    partition_id: partition,
                    base_offset: 40 + index as u64,
                },
                format!("payload-{index}").as_bytes(),
            )
            .unwrap();
        }
        pending
    }

    fn batch(start: usize, count: usize) -> PolledMessages {
        PolledMessages {
            context: PartitionContext {
                incarnation: 7,
                owner_generation: 0,
            },
            partition_id: 2,
            count,
            messages: (start..start + count)
                .map(|index| {
                    let payload = format!("payload-{index}").into_bytes();
                    PolledMessage {
                        header: MessageHeader {
                            id: message_id(&payload),
                            offset: 40 + index as u64,
                            payload_length: payload.len(),
                        },
                        payload: STANDARD.encode(payload),
                    }
                })
                .collect(),
        }
    }

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (endpoint, task)
    }

    #[test]
    fn keyed_request_uses_subject_bytes_and_persists_payload() {
        let body = message_body("probe-run-user-7", br#"{"sequence":1}"#);
        assert_eq!(body["partitioning"]["kind"], "messages_key");
        assert_eq!(
            STANDARD
                .decode(body["partitioning"]["value"].as_str().unwrap())
                .unwrap(),
            b"probe-run-user-7"
        );
        assert_eq!(
            STANDARD
                .decode(body["messages"][0]["payload"].as_str().unwrap())
                .unwrap(),
            br#"{"sequence":1}"#
        );
    }

    #[test]
    fn same_subject_must_keep_partition_and_increasing_offsets() {
        let mut progress = HashMap::new();
        let mut partitions = BTreeMap::new();
        record_confirmation(&mut progress, &mut partitions, "user-a", 2, 10).unwrap();
        record_confirmation(&mut progress, &mut partitions, "user-a", 2, 12).unwrap();
        assert!(record_confirmation(&mut progress, &mut partitions, "user-a", 3, 13).is_err());
        assert!(record_confirmation(&mut progress, &mut partitions, "user-a", 2, 12).is_err());
    }

    #[test]
    fn message_ids_are_stable_for_identical_payloads() {
        assert_eq!(message_id(b"same"), message_id(b"same"));
        assert_ne!(message_id(b"same"), message_id(b"different"));
    }

    #[test]
    fn run_id_is_bounded_before_subject_ids_are_generated() {
        assert!(validate_run_id("run-2026-11-08").is_ok());
        assert!(validate_run_id("x".repeat(25).as_str()).is_err());
    }

    #[test]
    fn probe_never_accepts_remote_addresses_credentials_paths_or_queries() {
        for address in [
            "http://example.com",
            "http://localhost:8090",
            "https://127.0.0.1:8090",
            "http://user:password@127.0.0.1:8090",
            "http://127.0.0.1/path",
            "http://127.0.0.1/?token=secret",
            "http://127.0.0.1/#fragment",
        ] {
            assert!(loopback_endpoint(address).is_err());
        }
        assert_eq!(
            loopback_endpoint("http://127.0.0.1:8090/").unwrap(),
            "http://127.0.0.1:8090"
        );
        assert_eq!(
            loopback_endpoint("http://[::1]:8090/").unwrap(),
            "http://[::1]:8090"
        );
    }

    #[test]
    fn fixed_read_url_never_commits_or_uses_relative_cursor() {
        let url = read_url("http://127.0.0.1:8090", "stream", "topic", 0, 0, READ_BATCH).unwrap();
        let query: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query.get("partition_id").unwrap(), "0");
        assert_eq!(query.get("value").unwrap(), "0");
        assert_eq!(query.get("kind").unwrap(), "offset");
        assert_eq!(query.get("auto_commit").unwrap(), "false");
    }

    #[test]
    fn readback_checks_payload_coordinates_and_incarnation_before_advancing() {
        let pending = expected_messages(2, 3);
        let expected = &pending[&2];
        let mut incarnation = None;
        verify_readback(&batch(0, 2), 2, expected, &mut incarnation).unwrap();
        assert_eq!(incarnation, Some(7));
        for case in 0..9 {
            let mut damaged = batch(2, 1);
            match case {
                0 => damaged.partition_id = 3,
                1 => damaged.count = 0,
                2 => damaged.count = 2,
                3 => damaged.messages[0].header.offset += 1,
                4 => damaged.messages[0].header.id += 1,
                5 => damaged.messages[0].header.payload_length += 1,
                6 => damaged.messages[0].payload = STANDARD.encode(b"tampered"),
                7 => damaged.context.incarnation = 8,
                _ => damaged.context.owner_generation = 3,
            }
            assert!(
                verify_readback(&damaged, 2, &expected[2..], &mut incarnation).is_err(),
                "反例：{case}"
            );
            assert_eq!(incarnation, Some(7));
        }
        verify_readback(&batch(2, 1), 2, &expected[2..], &mut incarnation).unwrap();
    }

    #[test]
    fn partition_history_rejects_duplicate_reordered_gapped_and_overflowed_confirmations() {
        for offset in [40, 39, 42] {
            let mut pending = expected_messages(0, 1);
            assert!(
                remember_expected(
                    &mut pending,
                    &Confirmation {
                        partition_id: 0,
                        base_offset: offset
                    },
                    b"test"
                )
                .is_err()
            );
            assert_eq!(pending[&0].len(), 1);
        }
        let mut pending = BTreeMap::new();
        remember_expected(
            &mut pending,
            &Confirmation {
                partition_id: 0,
                base_offset: u64::MAX,
            },
            b"last",
        )
        .unwrap();
        assert!(
            remember_expected(
                &mut pending,
                &Confirmation {
                    partition_id: 0,
                    base_offset: 0
                },
                b"wrap"
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn real_http_fixture_reads_partial_pages_with_fixed_offsets_and_numeric_u128_ids() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let app = Router::new().route(
            "/streams/stream/topics/topic/messages",
            get(move |request: Request| {
                let calls = observed.clone();
                async move {
                    assert_eq!(request.headers()["authorization"], "Bearer synthetic");
                    let url =
                        reqwest::Url::parse(&format!("http://127.0.0.1{}", request.uri())).unwrap();
                    let query: HashMap<_, _> = url.query_pairs().collect();
                    assert_eq!(query.get("auto_commit").unwrap(), "false");
                    assert_eq!(query.get("kind").unwrap(), "offset");
                    assert_eq!(query.get("partition_id").unwrap(), "2");
                    let start: usize = query["value"].parse::<usize>().unwrap() - 40;
                    let count = query["count"].parse::<usize>().unwrap().min(2);
                    calls.fetch_add(1, Ordering::Relaxed);
                    let bytes = serde_json::to_vec(&batch(start, count)).unwrap();
                    Response::new(Body::from(bytes))
                }
            }),
        );
        let (endpoint, task) = serve(app).await;
        let result = readback(
            &probe_client().unwrap(),
            &endpoint,
            "synthetic",
            "stream",
            "topic",
            &expected_messages(2, 19),
        )
        .await;
        task.abort();
        let _ = task.await;
        let (messages, requests, bytes) = result.unwrap();
        assert_eq!(messages, 19);
        assert_eq!(requests, 10);
        assert_eq!(calls.load(Ordering::Relaxed), requests);
        assert!(bytes > 0);
    }

    #[tokio::test]
    async fn write_refusal_is_not_retried_or_followed_to_another_endpoint() {
        for status in [307, 503] {
            let attempts = Arc::new(AtomicUsize::new(0));
            let writes = attempts.clone();
            let redirects = Arc::new(AtomicUsize::new(0));
            let redirected = redirects.clone();
            let app = Router::new()
                .route(
                    "/streams/stream/topics/topic/messages",
                    post(move || {
                        writes.fetch_add(1, Ordering::Relaxed);
                        async move {
                            Response::builder()
                                .status(status)
                                .header("location", "/unexpected")
                                .body(Body::empty())
                                .unwrap()
                        }
                    }),
                )
                .route(
                    "/unexpected",
                    post(move || {
                        redirected.fetch_add(1, Ordering::Relaxed);
                        async { "unexpected" }
                    }),
                );
            let (endpoint, task) = serve(app).await;
            let result = send_one(
                &probe_client().unwrap(),
                &endpoint,
                "synthetic",
                "stream",
                "topic",
                "subject",
                b"payload",
            )
            .await;
            task.abort();
            let _ = task.await;
            assert!(result.is_err());
            assert_eq!(attempts.load(Ordering::Relaxed), 1);
            assert_eq!(redirects.load(Ordering::Relaxed), 0);
        }
    }

    #[tokio::test]
    async fn readback_rejects_empty_malformed_oversized_or_recreated_history() {
        for case in ["empty", "malformed", "oversized", "recreated"] {
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            let app = Router::new().route(
                "/streams/stream/topics/topic/messages",
                get(move || {
                    let observed = observed.clone();
                    async move {
                        let call = observed.fetch_add(1, Ordering::Relaxed);
                        let body = match case {
                            "malformed" => Body::from("{"),
                            "oversized" => Body::from_stream(futures_util::stream::iter([
                                Ok::<_, io::Error>(vec![b' '; MAX_READ_RESPONSE_BYTES]),
                                Ok(vec![b' '; 1]),
                            ])),
                            "recreated" => {
                                let mut value = batch(call, 1);
                                if call > 0 {
                                    value.context.incarnation += 1;
                                }
                                Body::from(serde_json::to_vec(&value).unwrap())
                            }
                            _ => Body::from(serde_json::to_vec(&batch(0, 0)).unwrap()),
                        };
                        Response::new(body)
                    }
                }),
            );
            let (endpoint, task) = serve(app).await;
            let result = readback(
                &probe_client().unwrap(),
                &endpoint,
                "synthetic",
                "stream",
                "topic",
                &expected_messages(2, 3),
            )
            .await;
            task.abort();
            let _ = task.await;
            assert!(result.is_err(), "反例：{case}");
            assert_eq!(
                calls.load(Ordering::Relaxed),
                if case == "recreated" { 2 } else { 1 }
            );
        }
    }
}
