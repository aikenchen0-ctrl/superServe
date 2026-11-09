use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::any,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tower::ServiceExt;
use vs_core::learning::{LinearRankModel, TrainingDataKind};
use vs_service::{
    AppState, Role,
    consumption_access::{ConsumptionAccessConfig, ConsumptionAccessKey},
    consumption_replay::{ConsumptionReplayConfig, replay_consumption_evidence},
    evidence_replay::{EvidenceReplayConfig, replay_model_evidence},
    feedback_evidence::FeedbackEvidenceArchive,
    feedback_log::{IggyFeedbackConfig, IggyFeedbackLog},
    learning_evidence::{
        EvidenceExportManifest, GatewayLearningArchive, PinnedEvidenceFile,
        export_training_evidence,
    },
    router,
};

const TOKEN: &str = "feedback-ingress-contract-token-000000000000";
const BROKER_TOKEN: &str = "feedback-broker-test-credential";
const CLIENT_PATH: &str = "/v1/client/consumption/events";
const CATALOG: &[u8] = br#"{"version":"feedback-v1","items":[
 {"id":"video","domain":"video","tags":["rust"],"prior":0.8,"media_sha256":null},
 {"id":"article","domain":"article","tags":["storage"],"prior":0.2,"media_sha256":null}
],"assets":[]}"#;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn id(bytes: &[u8]) -> u128 {
    u128::from_be_bytes(Sha256::digest(bytes)[..16].try_into().unwrap())
}

fn signing_key(seed: u8) -> Ed25519KeyPair {
    // 固定种子仅用于独立签发的协议测试，生产发行者持有自己的私钥。
    Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap()
}

fn access_config(seeds: &[u8]) -> ConsumptionAccessConfig {
    ConsumptionAccessConfig {
        issuer: "https://identity.example".into(),
        audience: "consumption-ingress".into(),
        keys: seeds
            .iter()
            .map(|seed| ConsumptionAccessKey {
                kid: format!("issuer-{seed}"),
                public_key: URL_SAFE_NO_PAD.encode(signing_key(*seed).public_key().as_ref()),
            })
            .collect(),
    }
}

fn client_claims(batch: &Value, at: u64) -> Value {
    json!({
        "iss":"https://identity.example","aud":"consumption-ingress","sub":batch["subject"],
        "iat":at,"nbf":at,"exp":at+120,
        "source_id":batch["source_id"],"data_kind":batch["data_kind"],"platform":batch["platform"],
        "decision_id":batch["decision_id"],"candidate_id":batch["candidate_id"],
        "interaction_id":batch["interaction_id"],"generation":batch["generation"]
    })
}

fn sign_token(seed: u8, claims: &Value, header: Value) -> String {
    let message = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap())
    );
    let signature = signing_key(seed).sign(message.as_bytes());
    format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}

fn client_token(batch: &Value, at: u64) -> String {
    sign_token(
        7,
        &client_claims(batch, at),
        json!({
            "alg":"EdDSA","typ":"vs-consumption+jwt","kid":"issuer-7"
        }),
    )
}

#[derive(Clone, Copy)]
#[repr(usize)]
enum Mode {
    Normal,
    MissingDurability,
    Replicated,
    WrongCoordinates,
    EmptyConfirmation,
    EarlyAccepted,
    LostResponse,
    Gate,
    WrongOffset,
    WrongPayload,
    WrongPartition,
    EmptyPoll,
    Oversize,
    TopicMissing,
    TopicDenied,
    TopicReplicated,
    TopicImplicitPersisted,
    TopicOffsetOnlyPersisted,
    TopicWrongId,
    TopicWrongPartition,
    TopicMissingPolicy,
    TopicDuplicatePartition,
    TopicBadCount,
    TopicMissingCreatedAt,
    TopicRedirect,
    TopicOversize,
    TopicGate,
    TopicRecreated,
    PartitionRecreated,
    TopicBodyGate,
}

struct Origin {
    coordinate: u32,
    messages: Mutex<Vec<(u128, Vec<u8>)>>,
    mode: AtomicUsize,
    writes: AtomicUsize,
    reads: AtomicUsize,
    topic_reads: AtomicUsize,
    entered: Semaphore,
    resume: Semaphore,
}

#[derive(Serialize)]
struct PollReply {
    partition_id: u32,
    current_offset: u64,
    count: usize,
    messages: Vec<PollMessage>,
}
#[derive(Serialize)]
struct PollMessage {
    header: Header,
    payload: String,
}
#[derive(Serialize)]
struct Header {
    id: u128,
    offset: u64,
    payload_length: usize,
}

async fn topic(State(origin): State<Arc<Origin>>, request: Request) -> Response {
    assert_eq!(request.method(), Method::GET);
    assert_eq!(
        request.headers()["authorization"],
        format!("Bearer {BROKER_TOKEN}")
    );
    assert_eq!(request.uri().query(), Some("consistency=linearizable"));
    origin.topic_reads.fetch_add(1, Ordering::SeqCst);
    let mode = origin.mode.load(Ordering::SeqCst);
    if mode == Mode::TopicGate as usize {
        origin.entered.add_permits(1);
        origin.resume.acquire().await.unwrap().forget();
    }
    if mode == Mode::TopicMissing as usize {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }
    if mode == Mode::TopicDenied as usize {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())
            .unwrap();
    }
    if mode == Mode::TopicRedirect as usize {
        return Response::builder()
            .status(StatusCode::TEMPORARY_REDIRECT)
            .header("location", "/streams/1/topics/1?consistency=linearizable")
            .body(Body::empty())
            .unwrap();
    }
    if mode == Mode::TopicOversize as usize {
        return Response::builder()
            .body(Body::from(vec![b'x'; 256 * 1024 + 1]))
            .unwrap();
    }
    if mode == Mode::TopicBodyGate as usize {
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from_stream(futures_util::stream::once(
                std::future::pending::<Result<Vec<u8>, std::io::Error>>(),
            )))
            .unwrap();
    }
    let mut details = json!({
        "id":origin.coordinate,"created_at":1000000_u64,"name":"feedback",
        "partitions_count":1,"partitions":[{"id":origin.coordinate,"created_at":1000001_u64,"current_offset":0}],
        "messages_count":0,
        "options":{
            "durability":{"value":"persisted","explicit":true},
            "consumer_offset_durability":{"value":"replicated","explicit":false}
        }
    });
    if mode == Mode::TopicReplicated as usize {
        details["options"]["durability"]["value"] = json!("replicated");
    } else if mode == Mode::TopicImplicitPersisted as usize {
        details["options"]["durability"]["explicit"] = json!(false);
    } else if mode == Mode::TopicOffsetOnlyPersisted as usize {
        details["options"]["durability"]["value"] = json!("replicated");
        details["options"]["consumer_offset_durability"]["value"] = json!("persisted");
    } else if mode == Mode::TopicWrongId as usize {
        details["id"] = json!(2);
    } else if mode == Mode::TopicWrongPartition as usize {
        details["partitions"][0]["id"] = json!(2);
    } else if mode == Mode::TopicMissingPolicy as usize {
        details["options"]
            .as_object_mut()
            .unwrap()
            .remove("durability");
    } else if mode == Mode::TopicDuplicatePartition as usize {
        details["partitions_count"] = json!(2);
        details["partitions"] =
            json!([{"id":1,"created_at":1000001},{"id":1,"created_at":1000002}]);
    } else if mode == Mode::TopicBadCount as usize {
        details["partitions_count"] = json!(2);
    } else if mode == Mode::TopicMissingCreatedAt as usize {
        details.as_object_mut().unwrap().remove("created_at");
    } else if mode == Mode::TopicRecreated as usize {
        details["created_at"] = json!(2000000);
    } else if mode == Mode::PartitionRecreated as usize {
        details["partitions"][0]["created_at"] = json!(2000001);
    }
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&details).unwrap()))
        .unwrap()
}

async fn object(State(origin): State<Arc<Origin>>, request: Request) -> Response {
    let query: HashMap<String, String> =
        form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    assert_eq!(
        request.headers()["authorization"],
        format!("Bearer {BROKER_TOKEN}")
    );
    let mode = origin.mode.load(Ordering::SeqCst);
    if request.method() == Method::POST {
        assert!(query.is_empty(), "禁止使用ack=none");
        let bytes = to_bytes(request.into_body(), 65536).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["partitioning"]["kind"], "partition_id");
        assert_eq!(
            body["partitioning"]["value"],
            STANDARD.encode(origin.coordinate.to_le_bytes())
        );
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        let payload = STANDARD
            .decode(body["messages"][0]["payload"].as_str().unwrap())
            .unwrap();
        let message_id: u128 = body["messages"][0]["id"].as_str().unwrap().parse().unwrap();
        assert_eq!(message_id, id(&payload));
        let offset = {
            let mut messages = origin.messages.lock().unwrap();
            let offset = messages.len() as u64;
            messages.push((message_id, payload));
            offset
        };
        origin.writes.fetch_add(1, Ordering::SeqCst);
        if mode == Mode::Gate as usize {
            origin.entered.add_permits(1);
            origin.resume.acquire().await.unwrap().forget();
        }
        if mode == Mode::LostResponse as usize {
            return std::future::pending().await;
        }
        let mut response = Response::builder().status(if mode == Mode::EarlyAccepted as usize {
            StatusCode::ACCEPTED
        } else {
            StatusCode::CREATED
        });
        if mode != Mode::MissingDurability as usize {
            response = response.header(
                "iggy-durability",
                if mode == Mode::Replicated as usize {
                    "replicated"
                } else {
                    "persisted"
                },
            );
        }
        let confirmations = if mode == Mode::EmptyConfirmation as usize {
            json!({"confirmations":[]})
        } else {
            json!({"confirmations":[{"stream_id":origin.coordinate,"topic_id":origin.coordinate,
                "partition_id":if mode == Mode::WrongCoordinates as usize {2} else {origin.coordinate},
                "base_offset":offset}]})
        };
        return response
            .body(Body::from(serde_json::to_vec(&confirmations).unwrap()))
            .unwrap();
    }
    assert_eq!(request.method(), Method::GET);
    assert_eq!(query["kind"], "offset");
    assert_eq!(query["consumer_id"], "1");
    assert_eq!(query["partition_id"], origin.coordinate.to_string());
    assert_eq!(query["auto_commit"], "false");
    origin.reads.fetch_add(1, Ordering::SeqCst);
    if mode == Mode::Oversize as usize {
        return Response::builder()
            .body(Body::from(vec![b'x'; 512 * 1024 + 1]))
            .unwrap();
    }
    let start: usize = query["value"].parse().unwrap();
    let count: usize = query["count"].parse().unwrap();
    let messages = origin.messages.lock().unwrap();
    let polled = if mode == Mode::EmptyPoll as usize {
        vec![]
    } else {
        messages
            .iter()
            .enumerate()
            .skip(start)
            .take(count)
            .map(|(offset, (id, bytes))| PollMessage {
                header: Header {
                    id: *id,
                    offset: offset as u64 + u64::from(mode == Mode::WrongOffset as usize),
                    payload_length: bytes.len(),
                },
                payload: if mode == Mode::WrongPayload as usize {
                    STANDARD.encode(b"changed")
                } else {
                    STANDARD.encode(bytes)
                },
            })
            .collect()
    };
    let reply = PollReply {
        partition_id: if mode == Mode::WrongPartition as usize {
            2
        } else {
            origin.coordinate
        },
        current_offset: messages.len().saturating_sub(1) as u64,
        count: polled.len(),
        messages: polled,
    };
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&reply).unwrap()))
        .unwrap()
}

struct Fixture {
    origin: Arc<Origin>,
    config: IggyFeedbackConfig,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        Self::with_coordinate(1).await
    }
    async fn with_coordinate(coordinate: u32) -> Self {
        let origin = Arc::new(Origin {
            coordinate,
            messages: Mutex::new(Vec::new()),
            mode: AtomicUsize::new(Mode::Normal as usize),
            writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            topic_reads: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            resume: Semaphore::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = IggyFeedbackConfig {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            fallback_endpoints: Vec::new(),
            stream_id: coordinate,
            topic_id: coordinate,
            partition_id: coordinate,
            source_id: "trusted-gateway".into(),
            data_kind: TrainingDataKind::Synthetic,
            operation_timeout_ms: 500,
        };
        let topic_path = format!("/streams/{coordinate}/topics/{coordinate}");
        let app = Router::new()
            .route(&format!("{topic_path}/messages"), any(object))
            .route(&topic_path, any(topic))
            .with_state(origin.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            origin,
            config,
            task,
        }
    }
    fn log(&self) -> IggyFeedbackLog {
        IggyFeedbackLog::new(self.config.clone(), BROKER_TOKEN.into()).unwrap()
    }
    fn state(&self) -> Arc<AppState> {
        self.state_with_config(self.config.clone())
    }
    fn state_with_config(&self, config: IggyFeedbackConfig) -> Arc<AppState> {
        Arc::new(
            AppState::new(CATALOG, None, TOKEN, 1, 1)
                .unwrap()
                .with_feedback_log(config, BROKER_TOKEN.into())
                .unwrap(),
        )
    }
    fn mode(&self, mode: Mode) {
        self.origin.mode.store(mode as usize, Ordering::SeqCst);
    }
    fn client_state(&self) -> Arc<AppState> {
        Arc::new(
            AppState::new(CATALOG, None, TOKEN, 1, 1)
                .unwrap()
                .with_feedback_log(self.config.clone(), BROKER_TOKEN.into())
                .unwrap()
                .with_consumption_access(access_config(&[7]))
                .unwrap(),
        )
    }
}

#[tokio::test]
async fn zero_based_broker_coordinates_support_readiness_append_and_snapshot() {
    let fixture = Fixture::with_coordinate(0).await;
    let readiness = fixture.log().verify_readiness().await.unwrap();
    assert_eq!(readiness.partition_id, 0);
    let response = call(
        router(fixture.state(), Role::Feedback),
        "/internal/v1/learning/events",
        Some(archive()),
        TOKEN,
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let receipt = json_body(response).await;
    assert_eq!(receipt["stream_id"], 0);
    assert_eq!(receipt["topic_id"], 0);
    assert_eq!(receipt["partition_id"], 0);
    let directory = tempfile::tempdir().unwrap();
    let snapshot = fixture
        .log()
        .snapshot(0, 1, &directory.path().join("zero.json"))
        .await
        .unwrap();
    assert_eq!(snapshot.events, 1);
    assert_eq!(snapshot.partition_id, 0);
}

#[tokio::test]
async fn readiness_reads_effective_message_policy_and_rejects_stale_or_incompatible_metadata() {
    let fixture = Fixture::new().await;
    let app = router(fixture.state(), Role::Feedback);
    let response = call(app.clone(), "/readyz", None, TOKEN).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["broker_checked"], true);
    assert_eq!(body["topic_readiness"]["durability"], "persisted");
    assert_eq!(
        body["topic_readiness"]["metadata_consistency"],
        "linearizable"
    );
    assert_eq!(body["append_permission_checked"], false);
    assert_eq!(body["durability_crash_tested"], false);
    for mode in [
        Mode::TopicMissing,
        Mode::TopicDenied,
        Mode::TopicReplicated,
        Mode::TopicImplicitPersisted,
        Mode::TopicOffsetOnlyPersisted,
        Mode::TopicWrongId,
        Mode::TopicWrongPartition,
        Mode::TopicMissingPolicy,
        Mode::TopicDuplicatePartition,
        Mode::TopicBadCount,
        Mode::TopicMissingCreatedAt,
        Mode::TopicRedirect,
        Mode::TopicOversize,
    ] {
        fixture.mode(mode);
        let before = fixture.origin.topic_reads.load(Ordering::SeqCst);
        assert_eq!(
            call(app.clone(), "/readyz", None, TOKEN).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            fixture.origin.topic_reads.load(Ordering::SeqCst),
            before + 1
        );
    }
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.origin.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn slow_probe_budget_is_separate_from_writes_and_cancelled_probe_releases_it() {
    let mut fixture = Fixture::new().await;
    fixture.config.operation_timeout_ms = 2000;
    fixture.mode(Mode::TopicGate);
    let state = fixture.state();
    let app = router(state.clone(), Role::Feedback);
    let probe_app = app.clone();
    let task = tokio::spawn(async move { call(probe_app, "/readyz", None, TOKEN).await });
    tokio::time::timeout(Duration::from_secs(1), fixture.origin.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert_eq!(
        call(app.clone(), "/readyz", None, TOKEN).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let accepted = call(
        app.clone(),
        "/internal/v1/learning/events",
        Some(archive()),
        TOKEN,
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    task.abort();
    let _ = task.await;
    let metrics = json_body(call(app.clone(), "/v1/metrics", None, TOKEN).await).await;
    assert_eq!(metrics["feedback_log"]["available_probe_slots"], 1);
    assert_eq!(metrics["feedback_log"]["available_slots"], 4);
    fixture.mode(Mode::Normal);
    fixture.origin.resume.add_permits(1);
    assert_eq!(
        call(app, "/readyz", None, TOKEN).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn readiness_timeout_is_bounded_without_producing_a_test_message() {
    let fixture = Fixture::new().await;
    fixture.mode(Mode::TopicGate);
    let started = std::time::Instant::now();
    assert!(fixture.log().verify_readiness().await.is_err());
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn readiness_switches_to_a_fallback_when_the_preferred_endpoint_is_unreachable() {
    let fixture = Fixture::new().await;
    let dead_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_endpoint = format!("http://{}", dead_listener.local_addr().unwrap());
    drop(dead_listener);
    let mut config = fixture.config.clone();
    config.endpoint = dead_endpoint;
    config.fallback_endpoints = vec![fixture.config.endpoint.clone()];
    let state = fixture.state_with_config(config);
    let app = router(state.clone(), Role::Feedback);

    assert_eq!(
        call(
            app.clone(),
            "/internal/v1/learning/events",
            Some(archive()),
            TOKEN
        )
        .await
        .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
    let ready = call(app.clone(), "/readyz", None, TOKEN).await;
    assert_eq!(ready.status(), StatusCode::OK);
    let ready_body = json_body(ready).await;
    assert_eq!(ready_body["topic_readiness"]["endpoint_index"], 1);
    assert_eq!(ready_body["feedback"]["endpoint_count"], 2);
    assert_eq!(ready_body["feedback"]["active_endpoint_index"], 1);

    let response = call(app, "/internal/v1/learning/events", Some(archive()), TOKEN).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .verify_feedback_readiness()
            .await
            .unwrap()
            .endpoint_index,
        1
    );
    assert_eq!(fixture.origin.topic_reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn uncertain_post_does_not_switch_to_a_fallback_or_retry() {
    for mode in [
        Mode::LostResponse,
        Mode::MissingDurability,
        Mode::EarlyAccepted,
    ] {
        let primary = Fixture::new().await;
        let fallback = Fixture::new().await;
        primary.mode(mode);
        let mut config = primary.config.clone();
        config.fallback_endpoints = vec![fallback.config.endpoint.clone()];
        let app = router(primary.state_with_config(config), Role::Feedback);

        assert_eq!(
            call(app.clone(), "/readyz", None, TOKEN).await.status(),
            StatusCode::OK
        );
        let response = call(app, "/internal/v1/learning/events", Some(archive()), TOKEN).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json_body(response).await["commit_state"], "unknown");
        assert_eq!(primary.origin.writes.load(Ordering::SeqCst), 1);
        assert_eq!(fallback.origin.writes.load(Ordering::SeqCst), 0);
        assert_eq!(fallback.origin.topic_reads.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn readiness_changes_future_writes_and_snapshot_ingress_after_primary_loss() {
    let primary = Fixture::new().await;
    let fallback = Fixture::new().await;
    let mut config = primary.config.clone();
    config.fallback_endpoints = vec![fallback.config.endpoint.clone()];
    let state = primary.state_with_config(config.clone());
    let app = router(state.clone(), Role::Feedback);
    assert_eq!(
        state
            .verify_feedback_readiness()
            .await
            .unwrap()
            .endpoint_index,
        0
    );
    assert_eq!(
        call(
            app.clone(),
            "/internal/v1/learning/events",
            Some(archive()),
            TOKEN
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    primary.task.abort();
    // 先等监听者退出，再验证后续请求；这不是物理集群或复制实验。
    while !primary.task.is_finished() {
        tokio::task::yield_now().await;
    }
    let failed = call(
        app.clone(),
        "/internal/v1/learning/events",
        Some(archive()),
        TOKEN,
    )
    .await;
    assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(failed).await["commit_state"], "unknown");
    assert_eq!(fallback.origin.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        state
            .verify_feedback_readiness()
            .await
            .unwrap()
            .endpoint_index,
        1
    );
    assert_eq!(
        call(app, "/internal/v1/learning/events", Some(archive()), TOKEN)
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    assert_eq!(primary.origin.writes.load(Ordering::SeqCst), 1);
    assert_eq!(fallback.origin.writes.load(Ordering::SeqCst), 1);
    let log = IggyFeedbackLog::new(config, BROKER_TOKEN.into()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let receipt = log
        .snapshot(0, 1, &directory.path().join("fallback.json"))
        .await
        .unwrap();
    assert_eq!(receipt.events, 1);
    assert_eq!(fallback.origin.reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn invalid_application_replies_never_probe_past_or_activate_a_fallback() {
    for mode in [
        Mode::TopicDenied,
        Mode::TopicRedirect,
        Mode::TopicReplicated,
        Mode::TopicOversize,
        Mode::TopicBodyGate,
    ] {
        let primary = Fixture::new().await;
        let fallback = Fixture::new().await;
        primary.mode(mode);
        let mut config = primary.config.clone();
        config.fallback_endpoints = vec![fallback.config.endpoint.clone()];
        let state = primary.state_with_config(config);
        let app = router(state.clone(), Role::Feedback);
        assert!(state.verify_feedback_readiness().await.is_err());
        let failed = call(
            app.clone(),
            "/internal/v1/learning/events",
            Some(archive()),
            TOKEN,
        )
        .await;
        assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(primary.origin.writes.load(Ordering::SeqCst), 0);
        assert_eq!(fallback.origin.topic_reads.load(Ordering::SeqCst), 0);
        assert_eq!(fallback.origin.writes.load(Ordering::SeqCst), 0);
        let metrics = json_body(call(app, "/v1/metrics", None, TOKEN).await).await;
        assert!(metrics["feedback_log"]["active_endpoint_index"].is_null());
    }
}

#[tokio::test]
async fn recreated_topic_or_partition_is_not_used_after_failover() {
    for mode in [Mode::TopicRecreated, Mode::PartitionRecreated] {
        let primary = Fixture::new().await;
        let fallback = Fixture::new().await;
        fallback.mode(mode);
        let mut config = primary.config.clone();
        config.fallback_endpoints = vec![fallback.config.endpoint.clone()];
        let state = primary.state_with_config(config);
        let app = router(state.clone(), Role::Feedback);
        state.verify_feedback_readiness().await.unwrap();
        primary.task.abort();
        while !primary.task.is_finished() {
            tokio::task::yield_now().await;
        }
        assert!(state.verify_feedback_readiness().await.is_err());
        let failed = call(app, "/internal/v1/learning/events", Some(archive()), TOKEN).await;
        assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(fallback.origin.writes.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn stalled_probe_addresses_share_one_deadline_and_no_background_retry() {
    let primary = Fixture::new().await;
    let fallback = Fixture::new().await;
    primary.mode(Mode::TopicGate);
    let mut config = primary.config.clone();
    config.fallback_endpoints = vec![fallback.config.endpoint.clone()];
    config.operation_timeout_ms = 400;
    let log = IggyFeedbackLog::new(config.clone(), BROKER_TOKEN.into()).unwrap();
    let started = std::time::Instant::now();
    assert_eq!(log.verify_readiness().await.unwrap().endpoint_index, 1);
    assert!(started.elapsed() < Duration::from_millis(650));
    fallback.mode(Mode::TopicGate);
    let log = IggyFeedbackLog::new(config, BROKER_TOKEN.into()).unwrap();
    let started = std::time::Instant::now();
    assert!(log.verify_readiness().await.is_err());
    assert!(started.elapsed() < Duration::from_millis(650));
    assert_eq!(primary.origin.topic_reads.load(Ordering::SeqCst), 2);
    assert_eq!(fallback.origin.topic_reads.load(Ordering::SeqCst), 2);
    assert_eq!(primary.origin.writes.load(Ordering::SeqCst), 0);
    assert_eq!(fallback.origin.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn consumption_capabilities_are_opt_in_and_cannot_access_internal_endpoints() {
    let fixture = Fixture::new().await;
    let batch = consumption("web", "video", &"a".repeat(64), now(), None);
    let token = client_token(&batch, now() - 1);
    assert_eq!(
        call(
            router(fixture.state(), Role::Feedback),
            CLIENT_PATH,
            Some(batch.clone()),
            &token
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let state = fixture.client_state();
    assert_eq!(
        call(
            router(state.clone(), Role::Api),
            CLIENT_PATH,
            Some(batch.clone()),
            &token
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let app = router(state, Role::Feedback);
    for path in ["/readyz", "/v1/metrics", "/internal/v1/consumption/events"] {
        assert_eq!(
            call(app.clone(), path, Some(batch.clone()), &token)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(app.clone(), CLIENT_PATH, Some(batch.clone()), TOKEN)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let accepted = call(app, CLIENT_PATH, Some(batch), &token).await;
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    assert_eq!(accepted.headers()["cache-control"], "no-store");
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn invalid_jwt_signature_registered_claims_and_header_extensions_never_reach_the_broker() {
    let fixture = Fixture::new().await;
    let batch = consumption("web", "video", &"a".repeat(64), now(), None);
    let at = now();
    let app = router(fixture.client_state(), Role::Feedback);
    let base = client_claims(&batch, at - 1);
    let header = json!({"alg":"EdDSA","typ":"vs-consumption+jwt","kid":"issuer-7"});
    let mut tokens = Vec::new();
    for (field, value) in [
        ("iss", json!("https://wrong.example")),
        ("aud", json!("different-audience")),
        ("sub", json!("../subject")),
        ("iat", json!(at + 30)),
        ("nbf", json!(at + 30)),
        ("exp", json!(at)),
        ("exp", json!(at + 301)),
        ("nbf", json!(at - 2)),
        ("generation", json!(0)),
        ("extra", json!("unexpected")),
    ] {
        let mut claims = base.clone();
        claims[field] = value;
        tokens.push(sign_token(7, &claims, header.clone()));
    }
    for field in ["iss", "aud", "sub", "iat", "nbf", "exp"] {
        let mut claims = base.clone();
        claims.as_object_mut().unwrap().remove(field);
        tokens.push(sign_token(7, &claims, header.clone()));
    }
    for (field, value) in [
        ("alg", json!("HS256")),
        ("alg", json!("none")),
        ("typ", json!("JWT")),
        ("kid", json!("unknown")),
        ("jku", json!("http://127.0.0.1:1/jwks")),
        ("crit", json!(["b64"])),
        ("b64", json!(false)),
    ] {
        let mut changed = header.clone();
        changed[field] = value;
        tokens.push(sign_token(7, &base, changed));
    }
    tokens.push(sign_token(9, &base, header));
    tokens.push("x".repeat(4097));
    for token in tokens {
        let rejected = call(app.clone(), CLIENT_PATH, Some(batch.clone()), &token).await;
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(rejected.headers()["cache-control"], "no-store");
        assert_eq!(rejected.headers()["www-authenticate"], "Bearer");
    }
    let duplicate_headers = axum::http::Request::builder()
        .method("POST")
        .uri(CLIENT_PATH)
        .header(
            "authorization",
            format!("Bearer {}", client_token(&batch, at - 1)),
        )
        .header("authorization", "Bearer other")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(
        app.oneshot(duplicate_headers).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.origin.topic_reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn capability_binding_rejects_cross_subject_decision_asset_instance_generation_and_platform()
{
    let fixture = Fixture::new().await;
    let batch = consumption("web", "video", &"a".repeat(64), now(), None);
    let token = client_token(&batch, now() - 1);
    let app = router(fixture.client_state(), Role::Feedback);
    for (field, value) in [
        ("subject", json!("other")),
        ("source_id", json!("other-source")),
        ("data_kind", json!("observed")),
        ("platform", json!("android")),
        ("decision_id", json!("b".repeat(64))),
        ("candidate_id", json!("other-video")),
        ("interaction_id", json!("other-interaction")),
        ("generation", json!(2)),
    ] {
        let mut changed = batch.clone();
        changed[field] = value;
        assert_eq!(
            call(app.clone(), CLIENT_PATH, Some(changed), &token)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let mut outside_window = batch.clone();
    outside_window["events"][0]["observed_at"] = json!(now() - 120);
    assert_eq!(
        call(app.clone(), CLIENT_PATH, Some(outside_window), &token)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let mut wrong_source = batch.clone();
    wrong_source["source_id"] = json!("not-this-collector");
    let wrong_token = client_token(&wrong_source, now() - 1);
    assert_eq!(
        call(app, CLIENT_PATH, Some(wrong_source), &wrong_token)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn public_consumption_reuses_persisted_confirmation_and_never_retries_unknown_writes() {
    let fixture = Fixture::new().await;
    fixture.mode(Mode::LostResponse);
    let batch = consumption("android", "video", &"a".repeat(64), now(), None);
    let token = client_token(&batch, now() - 1);
    let response = call(
        router(fixture.client_state(), Role::Feedback),
        CLIENT_PATH,
        Some(batch),
        &token,
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(response).await["commit_state"], "unknown");
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fixed_verification_key_rotation_requires_known_kids_and_never_fetches_token_keys() {
    let fixture = Fixture::new().await;
    let batch = consumption("ios", "article", &"a".repeat(64), now(), None);
    let claims = client_claims(&batch, now() - 1);
    let state = |seeds: &[u8]| {
        Arc::new(
            AppState::new(CATALOG, None, TOKEN, 1, 1)
                .unwrap()
                .with_feedback_log(fixture.config.clone(), BROKER_TOKEN.into())
                .unwrap()
                .with_consumption_access(access_config(seeds))
                .unwrap(),
        )
    };
    let app = router(state(&[7, 8]), Role::Feedback);
    for seed in [7, 8] {
        let token = sign_token(
            seed,
            &claims,
            json!({
                "alg":"EdDSA","typ":"vs-consumption+jwt","kid":format!("issuer-{seed}")
            }),
        );
        assert_eq!(
            call(app.clone(), CLIENT_PATH, Some(batch.clone()), &token)
                .await
                .status(),
            StatusCode::ACCEPTED
        );
    }
    let old_token = client_token(&batch, now() - 1);
    assert_eq!(
        call(
            router(state(&[8]), Role::Feedback),
            CLIENT_PATH,
            Some(batch),
            &old_token
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn capability_expiration_during_body_upload_is_checked_again_before_persisting() {
    let fixture = Fixture::new().await;
    let batch = consumption("web", "video", &"a".repeat(64), now(), None);
    let mut claims = client_claims(&batch, now());
    let expires = now() + 2;
    claims["exp"] = json!(expires);
    let token = sign_token(
        7,
        &claims,
        json!({
            "alg":"EdDSA","typ":"vs-consumption+jwt","kid":"issuer-7"
        }),
    );
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
    let body = Body::from_stream(futures_util::stream::once(async move {
        let _ = entered_tx.send(());
        resume_rx.await.unwrap();
        Ok::<_, std::io::Error>(serde_json::to_vec(&batch).unwrap())
    }));
    let request = axum::http::Request::builder()
        .method("POST")
        .uri(CLIENT_PATH)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    let app = router(fixture.client_state(), Role::Feedback);
    let task = tokio::spawn(async move { app.oneshot(request).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(1), entered_rx)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while now() < expires {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    resume_tx.send(()).unwrap();
    assert_eq!(task.await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn consumption_access_config_keeps_fixed_public_keys_and_feedback_role_boundaries() {
    assert!(
        AppState::new(CATALOG, None, TOKEN, 1, 1)
            .unwrap()
            .with_consumption_access(access_config(&[7]))
            .is_err()
    );
    let fixture = || {
        AppState::new(CATALOG, None, TOKEN, 1, 1)
            .unwrap()
            .with_feedback_log(
                IggyFeedbackConfig {
                    endpoint: "http://127.0.0.1:8090".into(),
                    fallback_endpoints: Vec::new(),
                    stream_id: 0,
                    topic_id: 0,
                    partition_id: 0,
                    source_id: "trusted-gateway".into(),
                    data_kind: TrainingDataKind::Synthetic,
                    operation_timeout_ms: 500,
                },
                BROKER_TOKEN.into(),
            )
            .unwrap()
    };
    for mutation in 0..7 {
        let mut config = access_config(&[7]);
        match mutation {
            0 => config.issuer.clear(),
            1 => config.audience = "../bad".into(),
            2 => config.keys.clear(),
            3 => config.keys = vec![config.keys[0].clone(); 2],
            4 => config.keys[0].public_key = URL_SAFE_NO_PAD.encode([0; 32]),
            5 => config.keys[0].public_key = URL_SAFE_NO_PAD.encode([1; 31]),
            _ => config.keys[0].kid = "../key".into(),
        }
        assert!(fixture().with_consumption_access(config).is_err());
    }
    assert!(
        fixture()
            .with_consumption_access(access_config(&[7]))
            .unwrap()
            .with_consumption_access(access_config(&[8]))
            .is_err()
    );
}

fn archive() -> Value {
    json!({"schema":"gateway-learning-events-v1","source_id":"trusted-gateway","data_kind":"synthetic",
        "events":[{"event_id":"visible","decision_id":"a".repeat(64),"subject":"subject",
            "candidate_id":"video","at":now(),"kind":"visible"}]})
}

fn consumption(
    platform: &str,
    candidate: &str,
    decision: &str,
    at: u64,
    preference: Option<&str>,
) -> Value {
    let signal = match platform {
        "android" => "android_rendered_first_frame",
        "ios" => "ios_view_appeared",
        _ => "web_video_frame_callback",
    };
    let mut events = vec![json!({
        "event_id":format!("{candidate}-visible"),"sequence":1,"elapsed_ms":300,
        "observed_at":at,"observation":{
            "kind":"visibility","signal":signal,"foreground":true,"visible_fraction_milli":1000
        }
    })];
    if let Some(value) = preference {
        events.push(json!({
            "event_id":format!("{candidate}-preference"),"sequence":2,"elapsed_ms":1600,
            "observed_at":at+1,"observation":{"kind":"preference","value":value}
        }));
    } else {
        events[0]["observation"] = json!({"kind":"first_presentable","signal":signal});
    }
    json!({
        "schema":"client-consumption-v1","source_id":"trusted-gateway","data_kind":"synthetic",
        "platform":platform,"subject":"subject","decision_id":decision,"candidate_id":candidate,
        "interaction_id":format!("{platform}-{candidate}"),"generation":1,"events":events
    })
}

async fn call(app: Router, path: &str, body: Option<Value>, token: &str) -> Response {
    let request = axum::http::Request::builder()
        .uri(path)
        .header("authorization", format!("Bearer {token}"));
    let request = if let Some(body) = body {
        request
            .method("POST")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    } else {
        request.body(Body::empty()).unwrap()
    };
    app.oneshot(request).await.unwrap()
}
async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap()
}

#[tokio::test]
async fn ingestion_is_role_gated_authenticated_bounded_and_validates_before_network() {
    let fixture = Fixture::new().await;
    let app = router(fixture.state(), Role::Feedback);
    assert_eq!(
        call(
            app.clone(),
            "/internal/v1/learning/events",
            Some(archive()),
            "wrong"
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            router(fixture.state(), Role::Api),
            "/internal/v1/learning/events",
            Some(archive()),
            TOKEN
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(app.clone(), "/v1/feed", Some(json!({})), TOKEN)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    for mutation in 0..7 {
        let mut body = archive();
        match mutation {
            0 => body["source_id"] = json!("wrong-source"),
            1 => body["data_kind"] = json!("observed"),
            2 => body["events"][0]["at"] = json!(now() + 100),
            3 => body["events"][0]["decision_id"] = json!("invalid"),
            4 => body["events"] = json!([]),
            5 => body["events"] = json!(vec![body["events"][0].clone(); 65]),
            _ => {
                let mut changed = body["events"][0].clone();
                changed["subject"] = json!("other");
                body["events"].as_array_mut().unwrap().push(changed);
            }
        }
        assert!(
            !call(
                app.clone(),
                "/internal/v1/learning/events",
                Some(body),
                TOKEN
            )
            .await
            .status()
            .is_success()
        );
    }
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn persisted_confirmation_is_required_and_lost_ack_never_triggers_automatic_retry() {
    for mode in [
        Mode::MissingDurability,
        Mode::Replicated,
        Mode::WrongCoordinates,
        Mode::EmptyConfirmation,
        Mode::EarlyAccepted,
        Mode::LostResponse,
    ] {
        let fixture = Fixture::new().await;
        fixture.mode(mode);
        let response = call(
            router(fixture.state(), Role::Feedback),
            "/internal/v1/learning/events",
            Some(archive()),
            TOKEN,
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json_body(response).await["commit_state"], "unknown");
        assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.origin.messages.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn fixed_offset_snapshot_refuses_gaps_tampering_and_overwrite_without_committing_cursor() {
    let fixture = Fixture::new().await;
    let app = router(fixture.state(), Role::Feedback);
    let body = archive();
    for _ in 0..2 {
        let response = call(
            app.clone(),
            "/internal/v1/learning/events",
            Some(body.clone()),
            TOKEN,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("gateway.json");
    let receipt = fixture.log().snapshot(0, 2, &path).await.unwrap();
    assert_eq!(receipt.events, 2);
    assert!(!receipt.auto_commit);
    assert_eq!(receipt.archive_sha256, hash(&std::fs::read(&path).unwrap()));
    assert!(fixture.log().snapshot(0, 2, &path).await.is_err());
    for mode in [
        Mode::WrongOffset,
        Mode::WrongPayload,
        Mode::WrongPartition,
        Mode::EmptyPoll,
        Mode::Oversize,
    ] {
        fixture.mode(mode);
        let target = directory.path().join(format!("bad-{}.json", mode as usize));
        assert!(fixture.log().snapshot(0, 2, &target).await.is_err());
        assert!(!target.exists());
    }
    let reads = fixture.origin.reads.load(Ordering::SeqCst);
    assert!(
        fixture
            .log()
            .snapshot(0, 129, &directory.path().join("large.json"))
            .await
            .is_err()
    );
    assert_eq!(fixture.origin.reads.load(Ordering::SeqCst), reads);
}

#[tokio::test]
async fn cancelled_http_waiters_keep_write_slots_until_remote_completion_and_drain() {
    let mut fixture = Fixture::new().await;
    fixture.config.operation_timeout_ms = 5000;
    fixture.mode(Mode::Gate);
    let state = fixture.state();
    let app = router(state.clone(), Role::Feedback);
    let mut requests = Vec::new();
    for _ in 0..4 {
        let app = app.clone();
        requests.push(tokio::spawn(async move {
            call(app, "/internal/v1/learning/events", Some(archive()), TOKEN).await
        }));
    }
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.origin.entered.acquire_many(4),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    for task in requests {
        task.abort();
        let _ = task.await;
    }
    let response = call(
        app.clone(),
        "/internal/v1/learning/events",
        Some(archive()),
        TOKEN,
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 4);
    let metrics = json_body(call(app, "/v1/metrics", None, TOKEN).await).await;
    assert_eq!(metrics["feedback_log"]["available_slots"], 0);
    fixture.origin.resume.add_permits(4);
    tokio::time::timeout(Duration::from_secs(2), state.drain_feedback_writes())
        .await
        .unwrap();
}

#[tokio::test]
async fn feedback_snapshot_reuses_existing_export_and_replay_without_inventing_negative_labels() {
    let fixture = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let journal = directory.path().join("decisions.jsonl");
    let state = Arc::new(
        AppState::new(CATALOG, None, TOKEN, 1, 1)
            .unwrap()
            .with_learning_journal(&journal, "rank-replica")
            .unwrap(),
    );
    let response = call(router(state.clone(), Role::Api), "/v1/feed",
        Some(json!({"request_id":"source","subject":"subject","domains":["video","article"],"limit":2})), TOKEN).await;
    let decision = response.headers()["x-learning-decision-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = json_body(response).await;
    state.drain_learning_writes().await;
    drop(state);
    let log_bytes = std::fs::read(&journal).unwrap();
    let record: Value = serde_json::from_str(
        std::str::from_utf8(&log_bytes)
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    let issued = record["envelope"]["payload"]["issued_at"].as_u64().unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while now() <= issued {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut archive = archive();
    archive["events"] = json!([
        {"event_id":"shown-video","decision_id":decision,"subject":"subject","candidate_id":"video","at":issued,"kind":"visible"},
        {"event_id":"liked-video","decision_id":decision,"subject":"subject","candidate_id":"video","at":issued+1,"kind":"like"},
        {"event_id":"shown-article","decision_id":decision,"subject":"subject","candidate_id":"article","at":issued,"kind":"visible"},
        {"event_id":"disliked-article","decision_id":decision,"subject":"subject","candidate_id":"article","at":issued+1,"kind":"dislike"}
    ]);
    let app = router(fixture.state(), Role::Feedback);
    for _ in 0..2 {
        let response = call(
            app.clone(),
            "/internal/v1/learning/events",
            Some(archive.clone()),
            TOKEN,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }
    let gateway = directory.path().join("gateway.json");
    let snapshot = fixture.log().snapshot(0, 2, &gateway).await.unwrap();
    let manifest = EvidenceExportManifest {
        schema: "learning-evidence-export-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: hash(CATALOG),
        catalog_as_of: issued.saturating_sub(1),
        train_before: issued + 2,
        decision_logs: vec![PinnedEvidenceFile {
            path: "decisions.jsonl".into(),
            sha256: hash(&log_bytes),
        }],
        gateway_source_id: "trusted-gateway".into(),
        gateway_events: PinnedEvidenceFile {
            path: "gateway.json".into(),
            sha256: snapshot.archive_sha256,
        },
        excluded_subjects: vec![],
    };
    let training = export_training_evidence(
        directory.path(),
        CATALOG,
        &manifest,
        &directory.path().join("training.json"),
    )
    .unwrap();
    assert_eq!(training.samples, 2);
    assert_eq!(training.duplicate_events, 4);
    let model = LinearRankModel {
        schema: "ftrl-ranker-v1".into(),
        feature_schema: "profile-candidate-6-v1".into(),
        objective: "explicit-preference-v1".into(),
        catalog_version: "feedback-v1".into(),
        catalog_sha256: hash(CATALOG),
        data_kind: TrainingDataKind::Synthetic,
        trained_before: 1,
        training_samples: 2,
        positive_samples: 1,
        domains: vec!["article".into(), "video".into()],
        weights: vec![0.0; 18],
    };
    let bytes = serde_json::to_vec(&model).unwrap();
    std::fs::write(directory.path().join("model.json"), &bytes).unwrap();
    let receipt = replay_model_evidence(
        directory.path(),
        CATALOG,
        &manifest,
        &EvidenceReplayConfig {
            schema: "model-evidence-replay-config-v1".into(),
            decisions_from: manifest.catalog_as_of,
            model: PinnedEvidenceFile {
                path: "model.json".into(),
                sha256: hash(&bytes),
            },
            samples_per_query: 6,
            warmup_per_query: 0,
            recall_audit: None,
            domain_audit: None,
        },
        &directory.path().join("replay.json"),
    )
    .unwrap();
    assert!(receipt.exact);
    let saved: GatewayLearningArchive =
        serde_json::from_slice(&std::fs::read(gateway).unwrap()).unwrap();
    assert_eq!(saved.events.len(), 8);
    println!(
        "{}",
        json!({"schema":"feedback-ingress-contract-v1", "passed":true,
        "storage_backend":"deterministic-http-fixture", "ingested_batches":2,
        "archived_events":8, "duplicate_events":4, "training_samples":2,
        "replayed_queries":receipt.queries, "exact":receipt.exact,
        "physical_cluster_tested":false, "real_terminal_rendering":false})
    );
}

#[test]
fn feedback_configuration_rejects_ambiguous_endpoints_coordinates_and_role_mixing() {
    let base = IggyFeedbackConfig {
        endpoint: "http://127.0.0.1:8090".into(),
        fallback_endpoints: Vec::new(),
        stream_id: 1,
        topic_id: 1,
        partition_id: 1,
        source_id: "gateway".into(),
        data_kind: TrainingDataKind::Synthetic,
        operation_timeout_ms: 1000,
    };
    for mutation in 0..11 {
        let mut config = base.clone();
        match mutation {
            0 => config.endpoint = "http://user:secret@127.0.0.1:8090".into(),
            1 => config.endpoint = "http://127.0.0.1:8090/path".into(),
            2 => config.endpoint = "http://127.0.0.1:8090/?x=1".into(),
            3 => config.operation_timeout_ms = 5001,
            4 => config.operation_timeout_ms = 1,
            5 => config.source_id = "../source".into(),
            6 => config.fallback_endpoints = vec![format!("{}/", config.endpoint)],
            7 => {
                config.fallback_endpoints = (8100..8104)
                    .map(|port| format!("http://127.0.0.1:{port}"))
                    .collect()
            }
            8 => config.fallback_endpoints = vec!["http://user:secret@127.0.0.1:8100".into()],
            9 => config.fallback_endpoints = vec!["http://127.0.0.1:8100/path".into()],
            _ => config.fallback_endpoints = vec!["https://127.0.0.1:8100".into()],
        }
        assert!(IggyFeedbackLog::new(config, BROKER_TOKEN.into()).is_err());
    }
    assert!(IggyFeedbackLog::new(base.clone(), "bad\ncredential".into()).is_err());
    let state = || {
        AppState::new(CATALOG, None, TOKEN, 1, 1)
            .unwrap()
            .with_feedback_log(base.clone(), BROKER_TOKEN.into())
            .unwrap()
    };
    assert!(state().with_grouped_recall().is_err());
    assert!(
        state()
            .with_profile_remote(vs_service::ProfileRemoteConfig {
                endpoint: "http://127.0.0.1:9000".into(),
                token: TOKEN.into(),
            })
            .is_err()
    );
    let directory = tempfile::tempdir().unwrap();
    assert!(
        state()
            .with_learning_journal(&directory.path().join("unused.jsonl"), "source")
            .is_err()
    );
    assert!(!directory.path().join("unused.jsonl").exists());
}

#[tokio::test]
async fn cross_platform_consumption_keeps_raw_evidence_and_reuses_cross_domain_training_and_replay()
{
    let fixture = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let journal = directory.path().join("decisions.jsonl");
    let state = Arc::new(
        AppState::new(CATALOG, None, TOKEN, 1, 1)
            .unwrap()
            .with_learning_journal(&journal, "consumption-replica")
            .unwrap(),
    );
    let response = call(router(state.clone(), Role::Api), "/v1/feed",
        Some(json!({"request_id":"consumption","subject":"subject","domains":["video","article"],"limit":2})), TOKEN).await;
    let decision = response.headers()["x-learning-decision-id"]
        .to_str()
        .unwrap()
        .to_string();
    let _ = json_body(response).await;
    state.drain_learning_writes().await;
    drop(state);
    let log_bytes = std::fs::read(&journal).unwrap();
    let record: Value = serde_json::from_slice(log_bytes.strip_suffix(b"\n").unwrap()).unwrap();
    let issued = record["envelope"]["payload"]["issued_at"].as_u64().unwrap();
    let app = router(fixture.client_state(), Role::Feedback);
    let mut capability_bytes = Vec::new();
    for (platform, candidate, preference) in [
        ("android", "video", Some("like")),
        ("ios", "article", Some("dislike")),
        ("web", "video", None),
    ] {
        let mut batch = consumption(platform, candidate, &decision, issued, preference);
        if preference.is_some() {
            batch["events"][1]["observed_at"] = json!(issued);
            batch["events"][1]["elapsed_ms"] = json!(650);
        }
        let token = client_token(&batch, issued);
        capability_bytes.push(token.len());
        let response = call(app.clone(), CLIENT_PATH, Some(batch), &token).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let confirmation = json_body(response).await;
        assert_eq!(confirmation["commit"]["durability"], "persisted");
        if platform == "web" {
            assert_eq!(confirmation["summary"]["visibility_declarations"], 0);
            assert!(confirmation["summary"]["last_known_transferred_bytes"].is_null());
        }
    }
    let mut legacy = archive();
    legacy["events"] = json!([{
        "event_id":"video-visible","decision_id":decision,"subject":"subject",
        "candidate_id":"video","at":issued,"kind":"visible"
    }]);
    assert_eq!(
        call(app, "/internal/v1/learning/events", Some(legacy), TOKEN)
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    {
        let stored = fixture.origin.messages.lock().unwrap();
        let raw_web: Value = serde_json::from_slice(&stored[2].1).unwrap();
        assert_eq!(raw_web["platform"], "web");
        assert_eq!(
            raw_web["events"][0]["observation"]["kind"],
            "first_presentable"
        );
    }
    let gateway = directory.path().join("gateway.json");
    let snapshot = fixture.log().snapshot(0, 4, &gateway).await.unwrap();
    assert_eq!(snapshot.consumption_batches, 3);
    assert_eq!(snapshot.consumption_events, 5);
    assert_eq!(snapshot.source_payload_sha256.len(), 4);
    assert_eq!(snapshot.events, 5);
    let mut manifest = EvidenceExportManifest {
        schema: "learning-evidence-export-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256: hash(CATALOG),
        catalog_as_of: issued - 1,
        train_before: issued + 2,
        decision_logs: vec![PinnedEvidenceFile {
            path: "decisions.jsonl".into(),
            sha256: hash(&log_bytes),
        }],
        gateway_source_id: "trusted-gateway".into(),
        gateway_events: PinnedEvidenceFile {
            path: "gateway.json".into(),
            sha256: snapshot.archive_sha256.clone(),
        },
        excluded_subjects: vec![],
    };
    let training = export_training_evidence(
        directory.path(),
        CATALOG,
        &manifest,
        &directory.path().join("training.json"),
    )
    .unwrap();
    assert_eq!(training.samples, 2);
    assert_eq!(training.duplicate_events, 1);
    let raw_path = directory.path().join("raw-evidence.json");
    let raw_receipt = fixture
        .log()
        .snapshot_evidence(0, 4, &raw_path)
        .await
        .unwrap();
    assert_eq!(raw_receipt.messages, 4);
    assert_eq!(raw_receipt.projected_learning_events, snapshot.events);
    let raw_bytes = std::fs::read(&raw_path).unwrap();
    let raw: FeedbackEvidenceArchive = serde_json::from_slice(&raw_bytes).unwrap();
    for (message, original) in raw
        .messages
        .iter()
        .zip(fixture.origin.messages.lock().unwrap().iter())
    {
        assert_eq!(
            STANDARD.decode(&message.payload_base64).unwrap(),
            original.1
        );
    }
    manifest.gateway_events = PinnedEvidenceFile {
        path: "raw-evidence.json".into(),
        sha256: hash(&raw_bytes),
    };
    let raw_training = export_training_evidence(
        directory.path(),
        CATALOG,
        &manifest,
        &directory.path().join("raw-training.json"),
    )
    .unwrap();
    assert_eq!(raw_training.training_sha256, training.training_sha256);
    let mut corrupted: Value = serde_json::from_slice(&raw_bytes).unwrap();
    corrupted["messages"][0]["offset"] = json!(4);
    let corrupt_bytes = serde_json::to_vec(&corrupted).unwrap();
    std::fs::write(
        directory.path().join("corrupt-evidence.json"),
        &corrupt_bytes,
    )
    .unwrap();
    manifest.gateway_events = PinnedEvidenceFile {
        path: "corrupt-evidence.json".into(),
        sha256: hash(&corrupt_bytes),
    };
    let corrupt_target = directory.path().join("corrupt-training.json");
    assert!(
        export_training_evidence(directory.path(), CATALOG, &manifest, &corrupt_target).is_err()
    );
    assert!(!corrupt_target.exists());
    manifest.gateway_events = PinnedEvidenceFile {
        path: "raw-evidence.json".into(),
        sha256: hash(&raw_bytes),
    };
    let exported: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("training.json")).unwrap())
            .unwrap();
    assert_eq!(exported["schema"], "rank-training-v2");
    for sample in exported["samples"].as_array().unwrap() {
        assert_eq!(sample["exposed_at"], sample["feedback_at"]);
        assert!(sample["chronology"].is_object());
    }
    let model = LinearRankModel {
        schema: "ftrl-ranker-v1".into(),
        feature_schema: "profile-candidate-6-v1".into(),
        objective: "explicit-preference-v1".into(),
        catalog_version: "feedback-v1".into(),
        catalog_sha256: hash(CATALOG),
        data_kind: TrainingDataKind::Synthetic,
        trained_before: 1,
        training_samples: 2,
        positive_samples: 1,
        domains: vec!["article".into(), "video".into()],
        weights: vec![0.0; 18],
    };
    let bytes = serde_json::to_vec(&model).unwrap();
    std::fs::write(directory.path().join("model.json"), &bytes).unwrap();
    let replay = replay_model_evidence(
        directory.path(),
        CATALOG,
        &manifest,
        &EvidenceReplayConfig {
            schema: "model-evidence-replay-config-v1".into(),
            decisions_from: issued - 1,
            model: PinnedEvidenceFile {
                path: "model.json".into(),
                sha256: hash(&bytes),
            },
            samples_per_query: 6,
            warmup_per_query: 0,
            recall_audit: None,
            domain_audit: None,
        },
        &directory.path().join("replay.json"),
    )
    .unwrap();
    assert!(replay.exact);
    println!(
        "{}",
        json!({
            "schema":"consumption-training-contract-v1","data_kind":"synthetic",
            "raw_batches":3,"raw_events":5,"legacy_batches":1,"projected_events":snapshot.events,
            "training_samples":training.samples,"duplicate_events":training.duplicate_events,
        "same_second_samples":2,"utc_seconds_modified":false,
            "replayed_queries":replay.queries,"replay_exact":replay.exact,
            "backend":"deterministic-http-fixture","real_devices_verified":false,
            "signed_consumption_capabilities_verified":3,
            "capability_bytes_per_request":capability_bytes
        })
    );
}

#[tokio::test]
async fn raw_snapshot_retains_qoe_only_payload_and_all_offsets_without_inventing_labels() {
    let fixture = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let at = now() - 1;
    let app = router(fixture.state(), Role::Feedback);
    let mut batch = consumption("web", "video", &"a".repeat(64), at, None);
    batch["events"].as_array_mut().unwrap().push(json!({
        "event_id":"progress","sequence":2,"elapsed_ms":1000,"observed_at":at,
        "observation":{"kind":"progress","position_ms":500,"active_ms":500,
            "rebuffer_ms":100,"transferred_bytes":12345,"byte_scope":"web_xhr_body"}
    }));
    for _ in 0..10 {
        assert_eq!(
            call(
                app.clone(),
                "/internal/v1/consumption/events",
                Some(batch.clone()),
                TOKEN
            )
            .await
            .status(),
            StatusCode::ACCEPTED
        );
    }
    let target = directory.path().join("raw.json");
    let receipt = fixture
        .log()
        .snapshot_evidence(0, 10, &target)
        .await
        .unwrap();
    assert_eq!(receipt.messages, 10);
    assert_eq!(receipt.projected_learning_events, 0);
    assert_eq!(receipt.consumption_events, 20);
    assert!(!receipt.auto_commit);
    assert!(receipt.raw_payloads_preserved);
    let bytes = std::fs::read(&target).unwrap();
    assert_eq!(hash(&bytes), receipt.archive_sha256);
    let raw: FeedbackEvidenceArchive = serde_json::from_slice(&bytes).unwrap();
    assert!(raw.learning_projection().unwrap().events.is_empty());
    assert_eq!(raw.messages.len(), 10);
    let payload: Value =
        serde_json::from_slice(&STANDARD.decode(&raw.messages[9].payload_base64).unwrap()).unwrap();
    assert_eq!(payload, batch);
    assert_eq!(
        payload["events"][1]["observation"]["transferred_bytes"],
        12345
    );
    let rebuilt = directory.path().join("rebuilt.json");
    let rebuilt_receipt = replay_consumption_evidence(
        directory.path(),
        &ConsumptionReplayConfig {
            schema: "consumption-replay-v1".into(),
            evidence: PinnedEvidenceFile {
                path: "raw.json".into(),
                sha256: receipt.archive_sha256.clone(),
            },
        },
        &rebuilt,
    )
    .unwrap();
    assert_eq!(rebuilt_receipt.interactions, 1);
    assert_eq!(rebuilt_receipt.unique_events, 2);
    assert_eq!(rebuilt_receipt.duplicate_events, 18);
    let rebuilt: Value = serde_json::from_slice(&std::fs::read(rebuilt).unwrap()).unwrap();
    assert!(rebuilt["interactions"][0]["transferred_bytes"]["observed_delta"].is_null());
    assert_eq!(
        rebuilt["interactions"][0]["transferred_bytes"]["baseline"],
        12345
    );
    assert!(
        fixture
            .log()
            .snapshot_evidence(0, 10, &target)
            .await
            .is_err()
    );
    assert_eq!(bytes, std::fs::read(target).unwrap());
    let partial_path = directory.path().join("partial.json");
    let partial = fixture
        .log()
        .snapshot_evidence(8, 10, &partial_path)
        .await
        .unwrap();
    assert_eq!(partial.messages, 2);
    let partial: FeedbackEvidenceArchive =
        serde_json::from_slice(&std::fs::read(partial_path).unwrap()).unwrap();
    assert_eq!(partial.messages[0].offset, 8);
    assert!(partial.learning_projection().unwrap().events.is_empty());
}

#[tokio::test]
async fn raw_evidence_rejects_tampering_missing_offsets_wrong_source_and_future_events() {
    let fixture = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let batch = consumption("web", "video", &"a".repeat(64), now() - 1, None);
    let app = router(fixture.state(), Role::Feedback);
    assert_eq!(
        call(app, "/internal/v1/consumption/events", Some(batch), TOKEN)
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    let path = directory.path().join("source.json");
    fixture.log().snapshot_evidence(0, 1, &path).await.unwrap();
    let original: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for change in [
        "schema", "source", "kind", "range", "missing", "offset", "id", "length", "hash", "base64",
        "future", "semantic", "oversize",
    ] {
        let mut value = original.clone();
        match change {
            "schema" => value["schema"] = json!("unknown"),
            "source" => value["source_id"] = json!("another-source"),
            "kind" => value["data_kind"] = json!("observed"),
            "range" => value["end_offset_exclusive"] = json!(129),
            "missing" => value["messages"] = json!([]),
            "offset" => value["messages"][0]["offset"] = json!(1),
            "id" => value["messages"][0]["message_id"] = json!("0"),
            "length" => value["messages"][0]["payload_length"] = json!(1),
            "hash" => value["messages"][0]["payload_sha256"] = json!("f".repeat(64)),
            "base64" => value["messages"][0]["payload_base64"] = json!("not-base64!"),
            "future" => value["captured_at"] = json!(1),
            "oversize" => value["messages"][0]["payload_base64"] = json!("A".repeat(44000)),
            "semantic" => {
                let raw = STANDARD
                    .decode(value["messages"][0]["payload_base64"].as_str().unwrap())
                    .unwrap();
                let mut batch: Value = serde_json::from_slice(&raw).unwrap();
                batch["events"][0]["observation"]["signal"] = json!("ios_ready_for_display");
                let raw = serde_json::to_vec(&batch).unwrap();
                value["messages"][0]["payload_base64"] = json!(STANDARD.encode(&raw));
                value["messages"][0]["payload_length"] = json!(raw.len());
                value["messages"][0]["payload_sha256"] = json!(hash(&raw));
                value["messages"][0]["message_id"] = json!(id(&raw).to_string());
            }
            _ => unreachable!(),
        }
        let raw: FeedbackEvidenceArchive = serde_json::from_value(value).unwrap();
        assert!(raw.learning_projection().is_err(), "未拒绝篡改：{change}");
    }
}

#[tokio::test]
async fn raw_snapshot_rejects_broker_corruption_before_publishing_any_file() {
    let fixture = Fixture::new().await;
    let app = router(fixture.state(), Role::Feedback);
    assert_eq!(
        call(app, "/internal/v1/learning/events", Some(archive()), TOKEN)
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    let directory = tempfile::tempdir().unwrap();
    for mode in [
        Mode::WrongOffset,
        Mode::WrongPayload,
        Mode::WrongPartition,
        Mode::EmptyPoll,
        Mode::Oversize,
    ] {
        fixture.mode(mode);
        let target = directory.path().join(format!("bad-{}.json", mode as usize));
        assert!(
            fixture
                .log()
                .snapshot_evidence(0, 1, &target)
                .await
                .is_err()
        );
        assert!(!target.exists());
    }
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn consumption_rejects_bad_batches_before_network_and_old_empty_archives_stay_invalid() {
    let fixture = Fixture::new().await;
    let app = router(fixture.state(), Role::Feedback);
    let body = consumption("web", "video", &"a".repeat(64), now() - 1, None);
    assert_eq!(
        call(
            app.clone(),
            "/internal/v1/consumption/events",
            Some(body.clone()),
            "wrong-token"
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    for changed in [
        json!({"path":"source_id","value":"wrong"}),
        json!({"path":"data_kind","value":"observed"}),
        json!({"path":"generation","value":0}),
    ] {
        let mut bad = body.clone();
        bad[changed["path"].as_str().unwrap()] = changed["value"].clone();
        assert_eq!(
            call(
                app.clone(),
                "/internal/v1/consumption/events",
                Some(bad),
                TOKEN
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        call(
            app.clone(),
            "/internal/v1/consumption/events",
            Some(body.clone()),
            TOKEN
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let directory = tempfile::tempdir().unwrap();
    let snapshot = fixture
        .log()
        .snapshot(0, 1, &directory.path().join("qoe-only.json"))
        .await
        .unwrap();
    assert_eq!(snapshot.events, 0);
    let mut empty = archive();
    empty["events"] = json!([]);
    let bytes = serde_json::to_vec(&empty).unwrap();
    fixture
        .origin
        .messages
        .lock()
        .unwrap()
        .push((id(&bytes), bytes));
    assert!(
        fixture
            .log()
            .snapshot(1, 2, &directory.path().join("bad-empty.json"))
            .await
            .is_err()
    );
    fixture.mode(Mode::MissingDurability);
    let response = call(app, "/internal/v1/consumption/events", Some(body), TOKEN).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(response).await["commit_state"], "unknown");
}

#[tokio::test]
async fn cancelled_consumption_waiters_keep_shared_write_budget_until_remote_completion() {
    let mut fixture = Fixture::new().await;
    fixture.config.operation_timeout_ms = 5000;
    fixture.mode(Mode::Gate);
    let state = fixture.state();
    let app = router(state.clone(), Role::Feedback);
    let body = consumption("android", "video", &"a".repeat(64), now() - 1, None);
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let app = app.clone();
        let body = body.clone();
        tasks.push(tokio::spawn(async move {
            call(app, "/internal/v1/consumption/events", Some(body), TOKEN).await
        }));
    }
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.origin.entered.acquire_many(4),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    assert_eq!(
        call(app, "/internal/v1/consumption/events", Some(body), TOKEN)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 4);
    fixture.origin.resume.add_permits(4);
    tokio::time::timeout(Duration::from_secs(2), state.drain_feedback_writes())
        .await
        .unwrap();
}

struct Process(std::process::Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
#[ignore = "需已构建playback_lab并由独立浏览器运行器提供目录、程序和素材"]
async fn actual_browser_batches_snapshot_and_reconstruct_without_exposing_internal_credentials() {
    use std::{
        path::PathBuf,
        process::{Command, Stdio},
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = PathBuf::from(std::env::var_os("VS_TEST_PLAYBACK_BROWSER_DIR").unwrap());
    assert!(directory.is_absolute());
    assert!(directory.to_string_lossy().starts_with("O:\\"));
    assert!(!directory.exists(), "须使用新的浏览器证据目录");
    std::fs::create_dir(&directory).unwrap();
    let published = directory.join("published");
    std::fs::create_dir(&published).unwrap();
    let external = std::env::var_os("VS_TEST_PLAYBACK_IGGY_CONFIG");
    let fixture = if external.is_none() {
        let mut fixture = Fixture::new().await;
        fixture.config.source_id = "playback-lab".into();
        fixture.config.operation_timeout_ms = 2000;
        Some(fixture)
    } else {
        None
    };
    // 真实后端只接受显式固定坐标及分离的读写凭据，不从夹具失败自动切换。
    let (config, writer, reader) = if let Some(path) = external {
        use std::io::Read;
        let path = PathBuf::from(path);
        assert!(path.is_absolute() && path.to_string_lossy().starts_with("O:\\"));
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .unwrap()
            .take(65537)
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(bytes.len() <= 65536);
        let config: IggyFeedbackConfig = serde_json::from_slice(&bytes).unwrap();
        let endpoint = reqwest::Url::parse(&config.endpoint).unwrap();
        assert_eq!(endpoint.scheme(), "http");
        assert_eq!(endpoint.host_str(), Some("127.0.0.1"));
        assert!(config.fallback_endpoints.is_empty());
        assert_eq!(config.source_id, "playback-lab");
        assert_eq!(config.data_kind, TrainingDataKind::Synthetic);
        let writer = std::env::var("VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN").unwrap();
        let reader = std::env::var("VS_TEST_PLAYBACK_IGGY_READER_TOKEN").unwrap();
        assert_ne!(writer, reader, "真实后端须使用分离的读写身份");
        (config, writer, reader)
    } else {
        (
            fixture.as_ref().unwrap().config.clone(),
            BROKER_TOKEN.to_owned(),
            BROKER_TOKEN.to_owned(),
        )
    };
    let backend = if fixture.is_some() {
        "deterministic-http-fixture"
    } else {
        "real-iggy-singleton"
    };
    let log = IggyFeedbackLog::new(config.clone(), reader).unwrap();
    let readiness = log.verify_readiness().await.unwrap();
    let config_path = directory.join("feedback.json");
    std::fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut command = Command::new(std::env::var_os("VS_TEST_PLAYBACK_LAB").unwrap());
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("VS_") {
            command.env_remove(name);
        }
    }
    command
        .arg(&published)
        .arg(std::env::var_os("VS_TEST_PLAYBACK_SOURCE").unwrap())
        .arg(port.to_string())
        .env("VS_LAB_FEEDBACK_CONFIG", &config_path)
        .env("VS_FEEDBACK_IGGY_TOKEN", &writer)
        .stdout(std::fs::File::create_new(directory.join("playback.stdout.log")).unwrap())
        .stderr(std::fs::File::create_new(directory.join("playback.stderr.log")).unwrap())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = Process(command.spawn().unwrap());
    let url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            assert!(child.0.try_wait().unwrap().is_none(), "播放程序提前退出");
            if let Ok(response) = client.get(format!("{url}/lab/config")).send().await
                && response.status().is_success()
            {
                let config: Value = response.json().await.unwrap();
                assert_eq!(config["consumption_persistence"], true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    let browser_fixture = serde_json::to_vec_pretty(&json!({
        "schema":"playback-consumption-fixture-v1","url":url,
        "physical_hosts":1,"message_backend":backend,
    }))
    .unwrap();
    assert!(!String::from_utf8_lossy(&browser_fixture).contains(&writer));
    std::fs::write(directory.join("browser-fixture.json"), browser_fixture).unwrap();
    let result_path = directory.join("browser-result.json");
    tokio::time::timeout(Duration::from_secs(120), async {
        while !result_path.exists() {
            assert!(child.0.try_wait().unwrap().is_none(), "播放程序提前退出");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    let browser_bytes = std::fs::read(result_path).unwrap();
    assert!(browser_bytes.len() < 32768);
    let browser: Value = serde_json::from_slice(&browser_bytes).unwrap();
    assert_eq!(browser["schema"], "playback-consumption-browser-v1");
    assert_eq!(browser["real_browser_decoding_verified"], true);
    assert_eq!(browser["unissued_instance_status"], 403);
    assert_eq!(browser["duplicate_offset"], 2);
    if let Some(fixture) = &fixture {
        assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 3);
    }
    let snapshot_path = directory.join("raw-evidence.json");
    let snapshot = log.snapshot_evidence(0, 3, &snapshot_path).await.unwrap();
    let replay_path = directory.join("consumption-report.json");
    let replay = replay_consumption_evidence(
        &directory,
        &ConsumptionReplayConfig {
            schema: "consumption-replay-v1".into(),
            evidence: PinnedEvidenceFile {
                path: "raw-evidence.json".into(),
                sha256: snapshot.archive_sha256.clone(),
            },
        },
        &replay_path,
    )
    .unwrap();
    assert_eq!(replay.interactions, 1);
    assert_eq!(
        replay.unique_events,
        browser["unique_events"].as_u64().unwrap() as usize
    );
    // 验收显式重传完整封存批次，包含检查点和尾批的全部唯一事件。
    assert_eq!(replay.duplicate_events, replay.unique_events);
    assert_eq!(replay.streams_with_missing_sequences, 0);
    let report: Value = serde_json::from_slice(&std::fs::read(&replay_path).unwrap()).unwrap();
    let stream = &report["interactions"][0];
    assert_eq!(stream["transferred_bytes"]["baseline"], 0);
    assert_eq!(
        stream["transferred_bytes"]["observed_delta"],
        browser["received_body_bytes"]
    );
    assert_eq!(stream["active_ms"]["observed_delta"], Value::Null);
    assert!(
        stream["first_presentable_elapsed_ms"]
            .as_u64()
            .is_some_and(|value| value > 0)
    );
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let rebound = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    drop(rebound);
    let receipt = json!({
        "schema":"playback-consumption-integration-v1","passed":true,
        "actual_browser_decoding_verified":true,"message_backend":backend,
        "batches":snapshot.messages,"unique_events":replay.unique_events,
        "duplicate_events":replay.duplicate_events,
        "client_body_bytes":browser["received_body_bytes"],
        "reconstructed_body_bytes":stream["transferred_bytes"]["observed_delta"],
        "first_known_bytes":0,"unknown_active_preserved":true,
        "unissued_instance_rejected":true,"internal_credentials_in_browser_fixture":false,
        "raw_evidence_sha256":snapshot.archive_sha256,"report_sha256":replay.report_sha256,
        "feedback_readiness":readiness,
        "physical_hosts":1,"real_iggy_cluster_or_native_devices_verified":false,
        "playback_process_killed_after_success":true,"tcp_port_reclaimed":true,
    });
    std::fs::write(
        directory.join("integration-receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    println!("{receipt}");
}

#[tokio::test]
#[ignore = "需要VS_TEST_FEEDBACK_SNAPSHOT指向已构建的snapshot_feedback示例"]
async fn independent_collectors_share_fixed_log_and_snapshot_cli_exports_the_complete_interval() {
    use std::process::{Command, Stdio};
    let _ = rustls::crypto::ring::default_provider().install_default();
    let fixture = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let config_path = directory.path().join("feedback.json");
    let dead_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = fixture.config.clone();
    config.endpoint = format!("http://{}", dead_listener.local_addr().unwrap());
    config.fallback_endpoints = vec![fixture.config.endpoint.clone()];
    drop(dead_listener);
    std::fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let access_path = directory.path().join("consumption-access.json");
    std::fs::write(
        &access_path,
        serde_json::to_vec(&access_config(&[7])).unwrap(),
    )
    .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let mut replicas = Vec::new();
    for _ in 0..2 {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("VS_") {
                command.env_remove(name);
            }
        }
        command
            .env("VS_BIND", format!("127.0.0.1:{port}"))
            .env("VS_ROLE", "feedback")
            .env("VS_SERVICE_TOKEN", TOKEN)
            .env("VS_FEEDBACK_CONFIG", &config_path)
            .env("VS_FEEDBACK_IGGY_TOKEN", BROKER_TOKEN)
            .env("VS_CONSUMPTION_ACCESS_CONFIG", &access_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut process = Process(command.spawn().unwrap());
        let endpoint = format!("http://127.0.0.1:{port}");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                assert!(
                    process.0.try_wait().unwrap().is_none(),
                    "反馈收集进程提前退出"
                );
                if let Ok(response) = client
                    .get(format!("{endpoint}/readyz"))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                    && response.status().is_success()
                {
                    let ready: Value = response.json().await.unwrap();
                    assert_eq!(ready["topic_readiness"]["endpoint_index"], 1);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        replicas.push((endpoint, process));
    }
    let mut offsets = Vec::new();
    let mut wire_bytes = 0;
    let mut payload_bytes = 0;
    for (index, (endpoint, _)) in replicas.iter().enumerate() {
        let (path, payload) = if index == 0 {
            ("/internal/v1/learning/events", archive())
        } else {
            let mut batch = consumption("web", "video", &"a".repeat(64), now(), None);
            batch["events"][0]["observation"] = json!({
                "kind":"visibility","signal":"web_video_frame_callback",
                "foreground":true,"visible_fraction_milli":1000
            });
            (CLIENT_PATH, batch)
        };
        let bearer = if index == 0 {
            TOKEN.to_string()
        } else {
            client_token(&payload, now() - 1)
        };
        let response = client
            .post(format!("{endpoint}{path}"))
            .bearer_auth(&bearer)
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let receipt: Value = response.json().await.unwrap();
        let receipt = if index == 0 {
            &receipt
        } else {
            &receipt["commit"]
        };
        offsets.push(receipt["base_offset"].as_u64().unwrap());
        wire_bytes += receipt["request_bytes"].as_u64().unwrap();
        payload_bytes += receipt["payload_bytes"].as_u64().unwrap();
    }
    assert_eq!(offsets, [0, 1]);
    drop(replicas);
    // 新实例必须在监听前拒绝不兼容的消息持久化策略。
    fixture.mode(Mode::TopicReplicated);
    let mut rejected = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("VS_") {
            rejected.env_remove(name);
        }
    }
    rejected
        .env("VS_BIND", "127.0.0.1:0")
        .env("VS_ROLE", "feedback")
        .env("VS_SERVICE_TOKEN", TOKEN)
        .env("VS_FEEDBACK_CONFIG", &config_path)
        .env("VS_FEEDBACK_IGGY_TOKEN", BROKER_TOKEN)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        rejected.creation_flags(0x08000000);
    }
    let mut rejected = Process(rejected.spawn().unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = rejected.0.try_wait().unwrap() {
                assert!(!status.success());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.origin.writes.load(Ordering::SeqCst), 2);
    fixture.mode(Mode::Normal);
    let target = directory.path().join("gateway.json");
    let mut command = Command::new(std::env::var_os("VS_TEST_FEEDBACK_SNAPSHOT").unwrap());
    command
        .args([
            config_path.as_os_str(),
            std::ffi::OsStr::new("0"),
            std::ffi::OsStr::new("2"),
            target.as_os_str(),
        ])
        .env("VS_FEEDBACK_IGGY_TOKEN", BROKER_TOKEN)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let (mut command, output) = tokio::task::spawn_blocking(move || {
        let output = command.output();
        (command, output)
    })
    .await
    .unwrap();
    let output = output.unwrap();
    assert!(
        output.status.success(),
        "快照CLI失败：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["events"], 2);
    assert_eq!(receipt["auto_commit"], false);
    assert_eq!(receipt["consumption_batches"], 1);
    assert_eq!(receipt["consumption_events"], 1);
    assert_eq!(
        receipt["source_payload_sha256"].as_array().unwrap().len(),
        2
    );
    let bytes = std::fs::read(&target).unwrap();
    assert_eq!(receipt["archive_sha256"], hash(&bytes));
    assert!(
        !tokio::task::spawn_blocking(move || command.output())
            .await
            .unwrap()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(bytes, std::fs::read(target).unwrap());
    let raw_target = directory.path().join("raw-evidence.json");
    let mut raw_command = Command::new(std::env::var_os("VS_TEST_FEEDBACK_SNAPSHOT").unwrap());
    raw_command
        .args([
            config_path.as_os_str(),
            std::ffi::OsStr::new("0"),
            std::ffi::OsStr::new("2"),
            raw_target.as_os_str(),
            std::ffi::OsStr::new("--raw-evidence"),
        ])
        .env("VS_FEEDBACK_IGGY_TOKEN", BROKER_TOKEN)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        raw_command.creation_flags(0x08000000);
    }
    let (mut raw_command, raw_output) = tokio::task::spawn_blocking(move || {
        let output = raw_command.output();
        (raw_command, output)
    })
    .await
    .unwrap();
    let raw_output = raw_output.unwrap();
    assert!(
        raw_output.status.success(),
        "原始反馈快照CLI失败：{}",
        String::from_utf8_lossy(&raw_output.stderr)
    );
    let raw_receipt: Value = serde_json::from_slice(&raw_output.stdout).unwrap();
    assert_eq!(raw_receipt["schema"], "iggy-feedback-evidence-snapshot-v1");
    assert_eq!(raw_receipt["raw_payloads_preserved"], true);
    let raw_bytes = std::fs::read(&raw_target).unwrap();
    assert_eq!(raw_receipt["archive_sha256"], hash(&raw_bytes));
    let raw_archive: FeedbackEvidenceArchive = serde_json::from_slice(&raw_bytes).unwrap();
    assert_eq!(raw_archive.learning_projection().unwrap().events.len(), 2);
    assert!(!String::from_utf8_lossy(&raw_output.stdout).contains("subject"));
    assert!(
        !tokio::task::spawn_blocking(move || raw_command.output())
            .await
            .unwrap()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(raw_bytes, std::fs::read(raw_target).unwrap());
    println!(
        "{}",
        json!({"schema":"feedback-independent-process-contract-v1","passed":true,
        "storage_backend":"deterministic-http-fixture","collectors":2,
        "confirmed_offsets":offsets,"payload_bytes":payload_bytes,
        "request_json_bytes":wire_bytes,"snapshot_events":2,"auto_commit":false,
        "consumption_batches":1,"legacy_batches":1,
        "unreachable_preferred_endpoint":true,"validated_fallback_index":1,
        "signed_client_consumption_process":true,"raw_evidence_cli_verified":true,
        "physical_cluster_tested":false,"incompatible_policy_blocks_new_process":true})
    );
}

#[tokio::test]
async fn already_collected_batches_reduce_rpc_and_json_bytes_without_waiting_to_fill_a_batch() {
    let mut cases = Vec::new();
    for batch_size in [1, 8, 64] {
        let fixture = Fixture::new().await;
        let app = router(fixture.state(), Role::Feedback);
        let events: Vec<_> = (0..64)
            .map(|index| {
                let mut event = archive()["events"][0].clone();
                event["event_id"] = json!(format!("visible-{index}"));
                event
            })
            .collect();
        let mut payload_bytes = 0;
        let mut request_json_bytes = 0;
        let mut accepted_events = 0;
        let started = std::time::Instant::now();
        for batch in events.chunks(batch_size) {
            let mut body = archive();
            body["events"] = json!(batch);
            let response = call(
                app.clone(),
                "/internal/v1/learning/events",
                Some(body),
                TOKEN,
            )
            .await;
            assert_eq!(response.status(), StatusCode::ACCEPTED);
            let receipt = json_body(response).await;
            payload_bytes += receipt["payload_bytes"].as_u64().unwrap();
            request_json_bytes += receipt["request_bytes"].as_u64().unwrap();
            accepted_events += receipt["events"].as_u64().unwrap();
        }
        assert_eq!(accepted_events, 64);
        cases.push(json!({
            "batch_size":batch_size, "events":accepted_events,
            "rpc":fixture.origin.writes.load(Ordering::SeqCst),
            "payload_bytes":payload_bytes, "request_json_bytes":request_json_bytes,
            "elapsed_ns":started.elapsed().as_nanos() as u64,
        }));
    }
    assert_eq!(cases[0]["rpc"], 64);
    assert_eq!(cases[1]["rpc"], 8);
    assert_eq!(cases[2]["rpc"], 1);
    assert!(
        cases[2]["request_json_bytes"].as_u64().unwrap()
            < cases[0]["request_json_bytes"].as_u64().unwrap()
    );
    println!(
        "{}",
        json!({
            "schema":"feedback-batch-cost-contract-v1", "passed":true,
            "build":if cfg!(debug_assertions) {"debug"} else {"release"},
            "backend":"deterministic-http-fixture", "data_kind":"synthetic", "cases":cases,
            "timer_fill_wait":false, "http_headers_in_byte_count":false,
            "actual_broker_fsync_measured":false, "physical_cluster_tested":false,
        })
    );
}
