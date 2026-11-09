use std::{
    collections::HashMap,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::any,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vs_service::{
    AppState, Role,
    deployment::{
        DeploymentCredentials, DeploymentFailure, DeploymentRecall, DeploymentTarget,
        S3DeploymentRepository,
    },
    publication::publish_catalog,
    router,
};
use vs_storage::S3Config;

const PROFILE_TOKEN: &str = "deployment-profile-test-token-000000000";
const API_TOKEN: &str = "deployment-api-test-token-0000000000000";

#[derive(Clone, Copy)]
#[repr(usize)]
enum Mode {
    Normal,
    GateCommit,
    LostResponse,
    LostAndUnreadable,
    FailBeforeCommit,
    Oversize,
    MissingEtag,
    LostModelResponse,
    LostModelUnreadable,
    ModelChangedAfterHead,
    OversizeModel,
}

struct Origin {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    mode: AtomicUsize,
    commits: AtomicUsize,
    writes: AtomicUsize,
    etag_reads: AtomicUsize,
    entered: Semaphore,
    resume: Semaphore,
}

fn etag(data: &[u8]) -> String {
    format!("\"{:x}\"", Sha256::digest(data))
}
fn error(status: StatusCode, code: &str) -> Response {
    Response::builder()
        .status(status)
        .body(Body::from(format!("<Error><Code>{code}</Code></Error>")))
        .unwrap()
}

async fn object(
    State(origin): State<Arc<Origin>>,
    Path(key): Path<String>,
    request: Request,
) -> Response {
    assert!(
        request.headers()["authorization"]
            .to_str()
            .unwrap()
            .starts_with("AWS4-HMAC-SHA256 ")
    );
    let method = request.method().clone();
    let headers = request.headers().clone();
    let mode = origin.mode.load(Ordering::SeqCst);
    let active = key.ends_with("/active.json");
    let rank_model = key.starts_with("rank-models/");
    if method == Method::PUT {
        let data = to_bytes(
            request.into_body(),
            vs_service::rank_model::MAX_RANK_MODEL_BYTES,
        )
        .await
        .unwrap()
        .to_vec();
        assert!(headers.contains_key("if-match") ^ headers.contains_key("if-none-match"));
        origin.writes.fetch_add(1, Ordering::SeqCst);
        if active {
            origin.commits.fetch_add(1, Ordering::SeqCst);
            if mode == Mode::GateCommit as usize {
                origin.entered.add_permits(1);
                origin.resume.acquire().await.unwrap().forget();
            }
            if mode == Mode::FailBeforeCommit as usize {
                return error(StatusCode::INTERNAL_SERVER_ERROR, "InternalError");
            }
        }
        {
            let mut objects = origin.objects.lock().unwrap();
            let current = objects.get(&key);
            if let Some(expected) = headers.get("if-match") {
                if current.is_none_or(|data| etag(data) != expected.to_str().unwrap()) {
                    return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
                }
            } else {
                assert_eq!(headers["if-none-match"], "*");
                if current.is_some() {
                    return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
                }
            }
            objects.insert(key, data.clone());
        }
        if active
            && (mode == Mode::LostResponse as usize || mode == Mode::LostAndUnreadable as usize)
        {
            return std::future::pending().await;
        }
        if rank_model
            && matches!(mode, value if value == Mode::LostModelResponse as usize
            || value == Mode::LostModelUnreadable as usize)
        {
            return std::future::pending().await;
        }
        return Response::builder()
            .header("etag", etag(&data))
            .body(Body::empty())
            .unwrap();
    }
    if active
        && mode == Mode::LostAndUnreadable as usize
        && origin.commits.load(Ordering::SeqCst) > 0
    {
        return error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
    }
    if rank_model && mode == Mode::LostModelUnreadable as usize {
        return error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
    }
    let data = match origin.objects.lock().unwrap().get(&key) {
        Some(data) => data.clone(),
        None => return error(StatusCode::NOT_FOUND, "NoSuchKey"),
    };
    let mut response = Response::builder();
    if mode != Mode::MissingEtag as usize {
        response = response.header("etag", etag(&data));
    }
    if method == Method::HEAD {
        if rank_model && mode == Mode::ModelChangedAfterHead as usize {
            let mut changed = data.clone();
            changed[0] ^= 1;
            origin.objects.lock().unwrap().insert(key, changed);
        }
        return response
            .header(
                "content-length",
                if active && mode == Mode::Oversize as usize {
                    8193
                } else if rank_model && mode == Mode::OversizeModel as usize {
                    vs_service::rank_model::MAX_RANK_MODEL_BYTES + 1
                } else {
                    data.len()
                },
            )
            .body(Body::empty())
            .unwrap();
    }
    assert_eq!(method, Method::GET);
    if mode != Mode::MissingEtag as usize && !headers.contains_key("if-match") {
        return error(StatusCode::BAD_REQUEST, "MissingIfMatch");
    }
    if headers
        .get("if-match")
        .is_some_and(|expected| expected.as_bytes() != etag(&data).as_bytes())
    {
        return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
    }
    origin.etag_reads.fetch_add(1, Ordering::SeqCst);
    let range = if let Some(range) = headers.get("range") {
        let range =
            http_range::HttpRange::parse(range.to_str().unwrap(), data.len() as u64).unwrap();
        range[0].start as usize..(range[0].start + range[0].length) as usize
    } else {
        0..data.len()
    };
    response
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-length", range.len())
        .header(
            "content-range",
            format!("bytes {}-{}/{}", range.start, range.end - 1, data.len()),
        )
        .body(Body::from(data[range].to_vec()))
        .unwrap()
}

struct Fixture {
    directory: tempfile::TempDir,
    endpoint: String,
    repository: S3DeploymentRepository,
    origin: Arc<Origin>,
    target: DeploymentTarget,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.origin.resume.close();
        for task in &self.tasks {
            task.abort();
        }
    }
}
impl Fixture {
    fn catalog_bytes(&self) -> Vec<u8> {
        self.origin.objects.lock().unwrap()
            [&format!("catalogs/{}.json", self.target.catalog_sha256)]
            .clone()
    }

    fn model_bytes(&self, prior_weight: f64) -> Vec<u8> {
        let mut weights = vec![0.0; 18];
        weights[1] = prior_weight;
        serde_json::to_vec(&vs_core::learning::LinearRankModel {
            schema: "ftrl-ranker-v1".into(),
            feature_schema: "profile-candidate-6-v1".into(),
            objective: "explicit-preference-v1".into(),
            catalog_version: self.target.catalog_version.clone(),
            catalog_sha256: self.target.catalog_sha256.clone(),
            data_kind: vs_core::learning::TrainingDataKind::Synthetic,
            trained_before: 1,
            training_samples: 2,
            positive_samples: 1,
            domains: vec!["document".into(), "video".into()],
            weights,
        })
        .unwrap()
    }
    fn config(&self) -> S3Config {
        S3Config {
            endpoint: self.endpoint.clone(),
            region: "us-east-1".into(),
            bucket: "deployment".into(),
            access_key_id: "test-access".into(),
            secret_access_key: "test-secret".into(),
        }
    }
    fn credentials() -> DeploymentCredentials {
        DeploymentCredentials {
            profile_token: PROFILE_TOKEN.into(),
            qdrant_api_key: None,
        }
    }
    async fn new() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let directory = tempfile::tempdir().unwrap();
        let bytes = br#"{"version":"deployment-v1","assets":[],"items":[
            {"id":"video","domain":"video","tags":["rust"],"prior":0.5,"media_sha256":null},
            {"id":"document","domain":"document","tags":["rust"],"prior":0.4,"media_sha256":null}
        ]}"#;
        let publication = publish_catalog(directory.path(), bytes).unwrap();
        let state = Arc::new(
            AppState::new_with_profile_log(
                bytes,
                None,
                PROFILE_TOKEN,
                2,
                1,
                Some(&directory.path().join("events.jsonl")),
            )
            .unwrap()
            .into_profile_authority()
            .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let profile = format!("http://{}", listener.local_addr().unwrap());
        let profile_task = tokio::spawn(async move {
            axum::serve(listener, router(state, Role::Profile))
                .await
                .unwrap()
        });
        let origin = Arc::new(Origin {
            objects: Mutex::new(HashMap::from([
                (
                    "releases/deployment-v1.json".into(),
                    serde_json::to_vec(&publication.release).unwrap(),
                ),
                (
                    format!("catalogs/{}.json", publication.release.catalog_sha256),
                    bytes.to_vec(),
                ),
            ])),
            mode: AtomicUsize::new(Mode::Normal as usize),
            commits: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            etag_reads: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            resume: Semaphore::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let routes = Router::new()
            .route("/deployment/{*key}", any(object))
            .with_state(origin.clone());
        let storage_task = tokio::spawn(async { axum::serve(listener, routes).await.unwrap() });
        let repository = S3DeploymentRepository::new(
            S3Config {
                endpoint: endpoint.clone(),
                region: "us-east-1".into(),
                bucket: "deployment".into(),
                access_key_id: "test-access".into(),
                secret_access_key: "test-secret".into(),
            },
            250,
        )
        .unwrap();
        Self {
            directory,
            endpoint,
            repository,
            origin,
            target: DeploymentTarget {
                rank_model_sha256: None,
                profile_minimum: None,
                catalog_version: "deployment-v1".into(),
                catalog_sha256: publication.release.catalog_sha256,
                profile_authority: profile,
                recall: DeploymentRecall::Grouped,
            },
            tasks: vec![profile_task, storage_task],
        }
    }
    fn mode(&self, mode: Mode) {
        self.origin.mode.store(mode as usize, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn activation_history_pins_one_bundle_and_idempotent_retry_does_not_write() {
    let f = Fixture::new().await;
    assert!(f.repository.load("main").await.unwrap().is_none());
    let activated = f
        .repository
        .activate(
            "main",
            None,
            "first",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    assert!(activated.write_acknowledged);
    let snapshot = f.repository.load("main").await.unwrap().unwrap();
    assert_eq!(snapshot.record().generation, 1);
    assert_eq!(snapshot.sha256(), activated.sha256);
    assert!(snapshot.record().previous_sha256.is_none());
    assert_eq!(
        f.repository.load_catalog(&snapshot).await.unwrap(),
        std::fs::read(
            f.directory
                .path()
                .join(format!("catalogs/{}.json", f.target.catalog_sha256))
        )
        .unwrap()
    );
    let writes = f.origin.writes.load(Ordering::SeqCst);
    let retry = f
        .repository
        .activate(
            "main",
            None,
            "first",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    assert!(retry.reconciled_by_readback && !retry.write_acknowledged);
    assert_eq!(writes, f.origin.writes.load(Ordering::SeqCst));
    f.repository.ensure_current(&snapshot).await.unwrap();
}

#[tokio::test]
async fn concurrent_initial_and_next_activations_have_one_winner_without_blind_retry() {
    let f = Fixture::new().await;
    let other = S3DeploymentRepository::new(f.config(), 250).unwrap();
    let (left, right) = tokio::join!(
        f.repository.activate(
            "main",
            None,
            "left",
            f.target.clone(),
            Fixture::credentials()
        ),
        other.activate(
            "main",
            None,
            "right",
            f.target.clone(),
            Fixture::credentials()
        )
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let loser = match (left, right) {
        (Ok(_), Err(e)) | (Err(e), Ok(_)) => e,
        _ => unreachable!(),
    };
    assert_eq!(loser.kind, DeploymentFailure::Conflict);
    let old = f.repository.load("main").await.unwrap().unwrap();
    let (left, right) = tokio::join!(
        f.repository.activate(
            "main",
            Some(&old),
            "next-left",
            f.target.clone(),
            Fixture::credentials()
        ),
        other.activate(
            "main",
            Some(&old),
            "next-right",
            f.target.clone(),
            Fixture::credentials()
        )
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let new = other.load("main").await.unwrap().unwrap();
    assert_eq!(new.record().generation, 2);
    assert_eq!(new.record().previous_sha256.as_deref(), Some(old.sha256()));
    assert!(f.repository.ensure_current(&old).await.is_err());
}

#[tokio::test]
async fn rollback_uses_new_generation_so_stale_snapshot_cannot_win_after_return_to_same_target() {
    let f = Fixture::new().await;
    f.repository
        .activate(
            "main",
            None,
            "first",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let old = f.repository.load("main").await.unwrap().unwrap();
    let mut catalog = f.target.clone();
    catalog.recall = DeploymentRecall::Catalog;
    f.repository
        .activate(
            "main",
            Some(&old),
            "second",
            catalog,
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let middle = f.repository.load("main").await.unwrap().unwrap();
    f.repository
        .activate(
            "main",
            Some(&middle),
            "rollback",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let latest = f.repository.load("main").await.unwrap().unwrap();
    assert_eq!(latest.record().target, old.record().target);
    assert_eq!(latest.record().generation, 3);
    assert_ne!(latest.sha256(), old.sha256());
    let error = f
        .repository
        .activate(
            "main",
            Some(&old),
            "stale",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, DeploymentFailure::Conflict);
    assert!(!error.activation_may_have_succeeded);
}

#[tokio::test]
async fn race_after_preflight_is_still_rejected_by_storage_if_match() {
    let f = Fixture::new().await;
    f.repository
        .activate(
            "main",
            None,
            "first",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let old = f.repository.load("main").await.unwrap().unwrap();
    f.mode(Mode::GateCommit);
    let repository = f.repository.clone();
    let target = f.target.clone();
    let before = old.clone();
    let pending = tokio::spawn(async move {
        repository
            .activate(
                "main",
                Some(&before),
                "slow",
                target,
                Fixture::credentials(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), f.origin.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    f.mode(Mode::Normal);
    let other = S3DeploymentRepository::new(f.config(), 250).unwrap();
    let winner = other
        .activate(
            "main",
            Some(&old),
            "fast",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    f.origin.resume.add_permits(1);
    let loser = pending.await.unwrap().unwrap_err();
    assert_eq!(loser.kind, DeploymentFailure::Conflict);
    assert!(!loser.activation_may_have_succeeded);
    assert_eq!(
        f.repository.load("main").await.unwrap().unwrap().sha256(),
        winner.sha256
    );
}

#[tokio::test]
async fn failed_profile_catalog_or_index_preconditions_never_commit() {
    let f = Fixture::new().await;
    for case in [
        "missing-catalog",
        "wrong-catalog",
        "profile-down",
        "bad-token",
        "index-down",
    ] {
        let mut target = f.target.clone();
        let mut credentials = Fixture::credentials();
        match case {
            "missing-catalog" => target.catalog_version = "missing".into(),
            "wrong-catalog" => target.catalog_sha256 = "b".repeat(64),
            "profile-down" => target.profile_authority = "http://127.0.0.1:1".into(),
            "bad-token" => {
                credentials.profile_token = "wrong-profile-token-00000000000000000".into()
            }
            "index-down" => {
                target.recall = DeploymentRecall::Qdrant {
                    endpoint: "http://127.0.0.1:1".into(),
                    scoring: "signed".into(),
                }
            }
            _ => unreachable!(),
        }
        let error = f
            .repository
            .activate("main", None, case, target, credentials)
            .await
            .unwrap_err();
        assert_eq!(
            error.kind,
            DeploymentFailure::Prerequisite,
            "先决错误：{case}"
        );
        assert!(!error.activation_may_have_succeeded);
    }
    assert_eq!(f.origin.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn lost_commit_response_is_reconciled_or_explicitly_uncertain_and_never_deleted() {
    let f = Fixture::new().await;
    f.mode(Mode::LostResponse);
    let receipt = f
        .repository
        .activate(
            "main",
            None,
            "lost",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    assert!(receipt.reconciled_by_readback && !receipt.write_acknowledged);
    f.mode(Mode::Normal);
    let old = f.repository.load("main").await.unwrap().unwrap();
    f.origin.commits.store(0, Ordering::SeqCst);
    f.mode(Mode::LostAndUnreadable);
    let error = f
        .repository
        .activate(
            "main",
            Some(&old),
            "uncertain",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, DeploymentFailure::Uncertain);
    assert!(error.activation_may_have_succeeded);
    f.mode(Mode::Normal);
    assert_eq!(
        f.repository
            .load("main")
            .await
            .unwrap()
            .unwrap()
            .record()
            .generation,
        2
    );
}

#[tokio::test]
async fn failed_commit_and_cancelled_waiter_leave_history_but_do_not_claim_activation_absent() {
    let f = Fixture::new().await;
    f.mode(Mode::FailBeforeCommit);
    let error = f
        .repository
        .activate(
            "main",
            None,
            "failure",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, DeploymentFailure::Uncertain);
    assert!(f.repository.load("main").await.unwrap().is_none());
    assert!(
        f.origin
            .objects
            .lock()
            .unwrap()
            .keys()
            .any(|key| key.contains("/records/"))
    );
    f.mode(Mode::GateCommit);
    let repository = f.repository.clone();
    let target = f.target.clone();
    let pending = tokio::spawn(async move {
        repository
            .activate("main", None, "cancelled", target, Fixture::credentials())
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), f.origin.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    f.origin.resume.add_permits(1);
    f.mode(Mode::Normal);
    // 已发送的Put可能继续；重试整个操作只能确认相同记录，不能改用新前版本。
    f.repository
        .activate(
            "main",
            None,
            "cancelled",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    assert_eq!(
        f.repository
            .load("main")
            .await
            .unwrap()
            .unwrap()
            .record()
            .operation_id,
        "cancelled"
    );
}

#[tokio::test]
async fn record_history_oversize_missing_etag_and_cross_scope_fail_closed() {
    let f = Fixture::new().await;
    let receipt = f
        .repository
        .activate(
            "main",
            None,
            "first",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let old = f.repository.load("main").await.unwrap().unwrap();
    let history = format!("deployments/main/records/{}.json", receipt.sha256);
    let saved = f.origin.objects.lock().unwrap().remove(&history).unwrap();
    assert!(f.repository.load("main").await.is_err());
    f.origin.objects.lock().unwrap().insert(history, saved);
    for mode in [Mode::Oversize, Mode::MissingEtag] {
        f.mode(mode);
        assert!(f.repository.load("main").await.is_err());
    }
    f.mode(Mode::Normal);
    let mut config = f.config();
    config.bucket = "other".into();
    let other = S3DeploymentRepository::new(config, 250).unwrap();
    assert!(other.load_catalog(&old).await.is_err());
    assert!(
        other
            .activate(
                "main",
                Some(&old),
                "cross-scope",
                f.target.clone(),
                Fixture::credentials()
            )
            .await
            .is_err()
    );
    for version in ["../bad", "", "a/b", ".", ".."] {
        assert!(f.repository.load(version).await.is_err());
    }
    let active = "deployments/main/active.json";
    for value in [
        json!({"schema":"other"}),
        {
            let mut value = serde_json::to_value(&receipt.record).unwrap();
            value["generation"] = json!(0);
            value
        },
        {
            let mut value = serde_json::to_value(&receipt.record).unwrap();
            value["previous_sha256"] = json!("a".repeat(64));
            value
        },
    ] {
        f.origin
            .objects
            .lock()
            .unwrap()
            .insert(active.into(), serde_json::to_vec(&value).unwrap());
        assert!(f.repository.load("main").await.is_err());
    }
}

#[tokio::test]
async fn library_state_cannot_claim_selection_with_missing_profile_or_wrong_recall_configuration() {
    let f = Fixture::new().await;
    f.repository
        .activate(
            "main",
            None,
            "first",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let snapshot = f.repository.load("main").await.unwrap().unwrap();
    let bytes = f.repository.load_catalog(&snapshot).await.unwrap();
    assert!(
        AppState::new(&bytes, None, API_TOKEN, 1, 1)
            .unwrap()
            .with_deployment_snapshot(&snapshot)
            .is_err()
    );
    let state = || {
        AppState::new(&bytes, None, API_TOKEN, 1, 1)
            .unwrap()
            .with_profile_remote(vs_service::ProfileRemoteConfig {
                endpoint: f.target.profile_authority.clone(),
                token: PROFILE_TOKEN.into(),
            })
            .unwrap()
    };
    assert!(state().with_deployment_snapshot(&snapshot).is_err());
    assert!(
        state()
            .with_grouped_recall()
            .unwrap()
            .with_profile_history(snapshot.record().profile_checkpoint.clone().unwrap())
            .unwrap()
            .with_deployment_snapshot(&snapshot)
            .is_ok()
    );
    assert!(
        AppState::new(&bytes, None, API_TOKEN, 1, 1)
            .unwrap()
            .with_profile_remote(vs_service::ProfileRemoteConfig {
                endpoint: "http://127.0.0.1:1".into(),
                token: PROFILE_TOKEN.into(),
            })
            .unwrap()
            .with_grouped_recall()
            .unwrap()
            .with_deployment_snapshot(&snapshot)
            .is_err()
    );
}

#[tokio::test]
async fn invalid_endpoints_and_configuration_fail_before_any_write() {
    let f = Fixture::new().await;
    for endpoint in [
        "http://user:secret@localhost",
        "http://localhost/path",
        "http://localhost/?token=x",
        "file:///data",
        "http://localhost/#x",
    ] {
        let mut target = f.target.clone();
        target.profile_authority = endpoint.into();
        assert_eq!(
            f.repository
                .activate("main", None, "invalid", target, Fixture::credentials())
                .await
                .unwrap_err()
                .kind,
            DeploymentFailure::InvalidInput
        );
    }
    for timeout in [99, 30_001] {
        assert!(S3DeploymentRepository::new(f.config(), timeout).is_err());
    }
    assert_eq!(f.origin.writes.load(Ordering::SeqCst), 0);
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn authority_switch_requires_final_watermark_and_rejects_empty_then_accepts_sealed_copy() {
    let mut f = Fixture::new().await;
    f.repository
        .activate(
            "main",
            None,
            "before-events",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let old = f.repository.load("main").await.unwrap().unwrap();
    assert_eq!(old.record().profile_checkpoint.as_ref().unwrap().records, 0);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    for (id, kind) in [("first-like", "like"), ("first-hide", "hide")] {
        client
            .post(format!(
                "{}/internal/v1/profile/events",
                f.target.profile_authority
            ))
            .bearer_auth(PROFILE_TOKEN)
            .header("x-catalog-sha256", &f.target.catalog_sha256)
            .json(
                &json!({"event_id":id,"subject":"handoff-user","candidate_id":"video","kind":kind}),
            )
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    let history: Value = client
        .post(format!(
            "{}/internal/v1/profile/history",
            f.target.profile_authority
        ))
        .bearer_auth(PROFILE_TOKEN)
        .header("x-catalog-sha256", &f.target.catalog_sha256)
        .json(&json!({"minimum":null}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let final_watermark: vs_service::ProfileHistoryCheckpoint =
        serde_json::from_value(history["checkpoint"].clone()).unwrap();
    assert_eq!(final_watermark.records, 2);
    let bytes = std::fs::read(
        f.directory
            .path()
            .join(format!("catalogs/{}.json", f.target.catalog_sha256)),
    )
    .unwrap();
    let empty = Arc::new(
        AppState::new_with_profile_log(
            &bytes,
            None,
            PROFILE_TOKEN,
            2,
            1,
            Some(&f.directory.path().join("unrelated-events")),
        )
        .unwrap()
        .into_profile_authority()
        .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let app = router(empty, Role::Profile);
    let unrelated = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    let mut target = f.target.clone();
    target.profile_authority = endpoint;
    assert_eq!(
        f.repository
            .activate(
                "main",
                Some(&old),
                "missing-final",
                target.clone(),
                Fixture::credentials()
            )
            .await
            .unwrap_err()
            .stage,
        "handoff_checkpoint_required"
    );
    target.profile_minimum = Some(final_watermark.clone());
    assert_eq!(
        f.repository
            .activate(
                "main",
                Some(&old),
                "empty-copy",
                target,
                Fixture::credentials()
            )
            .await
            .unwrap_err()
            .stage,
        "profile_history"
    );
    unrelated.abort();
    let _ = unrelated.await;
    let task = f.tasks.remove(0);
    task.abort();
    let _ = task.await;
    let source = f.directory.path().join("events.jsonl");
    let destination = f.directory.path().join("transferred-events.jsonl");
    let receipt =
        vs_service::handoff_profile_log(&source, &destination, &f.target.catalog_sha256).unwrap();
    assert_eq!(receipt.checkpoint, final_watermark);
    let moved = Arc::new(
        AppState::new_with_profile_log(&bytes, None, PROFILE_TOKEN, 2, 1, Some(&destination))
            .unwrap()
            .into_profile_authority()
            .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let app = router(moved, Role::Profile);
    f.tasks.push(tokio::spawn(async {
        axum::serve(listener, app).await.unwrap()
    }));
    let mut target = f.target.clone();
    target.profile_authority = endpoint;
    target.profile_minimum = Some(receipt.checkpoint);
    let activated = f
        .repository
        .activate(
            "main",
            Some(&old),
            "sealed-copy",
            target,
            Fixture::credentials(),
        )
        .await
        .unwrap();
    assert_eq!(
        activated
            .record
            .profile_checkpoint
            .as_ref()
            .unwrap()
            .records,
        2
    );
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = Process(api(&f, &activated.sha256, port).spawn().unwrap());
    ready(&client, port, &mut child).await;
    let feed: Value = client.post(format!("http://127.0.0.1:{port}/v1/feed")).bearer_auth(API_TOKEN)
        .json(&json!({"request_id":"handoff","subject":"handoff-user","domains":["video","document"],"limit":2}))
        .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(feed["profile_version"], "memory-2");
    assert!(
        feed["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != "video")
    );
    println!(
        "{}",
        json!({"schema":"profile-history-handoff-contract-v1","passed":true,
        "checkpoint":final_watermark,"initial_deployment_checkpoint_records":0,
        "events_after_initial_deployment_preserved":true,"empty_history_rejected":true,
        "source_sealed":true,"selected_independent_api_preserves_hidden_items":true,
        "physical_cluster_tested":false})
    );
}

fn api(f: &Fixture, sha256: &str, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    for name in [
        "VS_CATALOG",
        "VS_CATALOG_RELEASE",
        "VS_PUBLICATION_ROOT",
        "VS_PUBLICATION_BACKEND",
        "VS_PROFILE_EVENT_LOG",
        "VS_PROFILE_AUTHORITY_URL",
        "VS_QDRANT_URL",
        "VS_RECALL_BACKEND",
        "VS_QDRANT_SCORING",
        "VS_RANK_MODEL",
        "VS_RANK_MODEL_SHA256",
    ] {
        command.env_remove(name);
    }
    command
        .env("VS_ROLE", "api")
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env("VS_SERVICE_TOKEN", API_TOKEN)
        .env("VS_S3_ENDPOINT", &f.endpoint)
        .env("VS_S3_REGION", "us-east-1")
        .env("VS_S3_BUCKET", "deployment")
        .env("VS_S3_ACCESS_KEY_ID", "test-access")
        .env("VS_S3_SECRET_ACCESS_KEY", "test-secret")
        .env("VS_DEPLOYMENT_CHANNEL", "main")
        .env("VS_DEPLOYMENT_SHA256", sha256)
        .env("VS_PROFILE_AUTHORITY_TOKEN", PROFILE_TOKEN)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

async fn ready(client: &reqwest::Client, port: u16, child: &mut Process) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            assert!(child.0.try_wait().unwrap().is_none(), "部署API进程提前退出");
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/readyz"))
                .bearer_auth(API_TOKEN)
                .send()
                .await
                && response.status().is_success()
            {
                return response.json().await.unwrap();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn independent_api_processes_pin_bundle_and_new_selection_does_not_move_old_readers() {
    let f = Fixture::new().await;
    let first = f
        .repository
        .activate(
            "main",
            None,
            "first",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = Process(api(&f, &first.sha256, port).spawn().unwrap());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    assert_eq!(
        ready(&client, port, &mut child).await["deployment"]["generation"],
        1
    );
    let old = f.repository.load("main").await.unwrap().unwrap();
    let next = f
        .repository
        .activate(
            "main",
            Some(&old),
            "second",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    assert_eq!(
        ready(&client, port, &mut child).await["deployment"]["sha256"],
        first.sha256
    );
    let body: Value = client.post(format!("http://127.0.0.1:{port}/v1/feed")).bearer_auth(API_TOKEN)
        .json(&json!({"request_id":"deployed","subject":"user","domains":["video","document"],"limit":2}))
        .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
    let next_port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut next_child = Process(api(&f, &next.sha256, next_port).spawn().unwrap());
    assert_eq!(
        ready(&client, next_port, &mut next_child).await["deployment"]["generation"],
        2
    );
    let mut stale = Process(api(&f, &first.sha256, 0).spawn().unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = stale.0.try_wait().unwrap() {
                assert!(!status.success());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "需要VS_TEST_QDRANT_BINARY指向官方Qdrant 1.20.0"]
async fn real_qdrant_deployment_prerequisites_and_selected_api_start_together() {
    let f = Fixture::new().await;
    let binary = std::env::var_os("VS_TEST_QDRANT_BINARY").expect("缺少真实Qdrant二进制");
    let version = Command::new(&binary).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "qdrant 1.20.0"
    );
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut command = Command::new(&binary);
    let storage_root = std::fs::canonicalize(f.directory.path()).unwrap();
    let qdrant_log = f.directory.path().join("qdrant-server.log");
    let output = std::fs::File::create(&qdrant_log).unwrap();
    command
        .arg("--disable-telemetry")
        .current_dir(f.directory.path())
        .env("QDRANT__SERVICE__HOST", "127.0.0.1")
        .env("QDRANT__SERVICE__HTTP_PORT", port.to_string())
        .env("QDRANT__SERVICE__GRPC_PORT", "0")
        .env("QDRANT__CLUSTER__ENABLED", "false")
        .env("QDRANT__STORAGE__STORAGE_PATH", storage_root.join("qdrant"))
        .env(
            "QDRANT__STORAGE__SNAPSHOTS_PATH",
            storage_root.join("snapshots"),
        )
        .env("QDRANT__SERVICE__API_KEY", "deployment-qdrant-test-key")
        .stdout(Stdio::from(output.try_clone().unwrap()))
        .stderr(Stdio::from(output));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut qdrant = Process(command.spawn().unwrap());
    let endpoint = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            assert!(qdrant.0.try_wait().unwrap().is_none(), "真实Qdrant提前退出");
            if client
                .get(format!("{endpoint}/readyz"))
                .header("api-key", "deployment-qdrant-test-key")
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let mut target = f.target.clone();
    target.recall = DeploymentRecall::Qdrant {
        endpoint: endpoint.clone(),
        scoring: "signed".into(),
    };
    let credentials = || DeploymentCredentials {
        profile_token: PROFILE_TOKEN.into(),
        qdrant_api_key: Some("deployment-qdrant-test-key".into()),
    };
    let error = f
        .repository
        .activate("main", None, "not-yet", target.clone(), credentials())
        .await
        .unwrap_err();
    assert_eq!(error.stage, "recall");
    assert_eq!(f.origin.writes.load(Ordering::SeqCst), 0);
    let bytes = std::fs::read(
        f.directory
            .path()
            .join(format!("catalogs/{}.json", target.catalog_sha256)),
    )
    .unwrap();
    let recall = vs_service::qdrant_recall::QdrantRecall::new(
        vs_service::qdrant_recall::QdrantConfig {
            endpoint,
            api_key: Some("deployment-qdrant-test-key".into()),
            scoring: vs_core::recall::RecallScoring::Signed,
        },
        target.catalog_sha256.clone(),
    )
    .unwrap();
    if let Err(error) = recall.publish(&bytes).await {
        let diagnostics = std::fs::read_to_string(&qdrant_log)
            .unwrap_or_default()
            .replace("deployment-qdrant-test-key", "[redacted]");
        panic!("真实索引发布失败：{error}；服务端诊断：{diagnostics}");
    }
    let activation = f
        .repository
        .activate("main", None, "ready", target, credentials())
        .await
        .unwrap();
    let api_port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut selected = api(&f, &activation.sha256, api_port);
    selected.env("VS_QDRANT_API_KEY", "deployment-qdrant-test-key");
    let mut selected = Process(selected.spawn().unwrap());
    let status = ready(&client, api_port, &mut selected).await;
    assert_eq!(status["recall_readiness"]["points_verified"], 2);
    assert_eq!(status["deployment"]["sha256"], activation.sha256);
    let api_url = format!("http://127.0.0.1:{api_port}");
    client.post(format!("{api_url}/v1/profile/events")).bearer_auth(API_TOKEN)
        .json(&json!({"event_id":"like","subject":"selected-user","candidate_id":"video","kind":"like"}))
        .send().await.unwrap().error_for_status().unwrap();
    let feed=client.post(format!("{api_url}/v1/feed")).bearer_auth(API_TOKEN)
        .json(&json!({"request_id":"selected","subject":"selected-user","domains":["video","document"],"limit":2}))
        .send().await.unwrap().error_for_status().unwrap();
    assert_eq!(feed.headers()["x-recall-mode"], "qdrant-signed-tags+prior");
    assert_eq!(
        feed.json::<Value>().await.unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    println!(
        "{}",
        json!({"schema":"deployment-qdrant-contract-v1","passed":true,
        "qdrant_version":"1.20.0","points":2,"unpublished_index_blocks_activation":true,
        "verified_activation_and_independent_api":true,"cross_domain_profile_feed":true,
        "physical_cluster_tested":false,"storage_backend":"deterministic-http-fixture"})
    );
}

#[tokio::test]
async fn rank_model_publication_is_immutable_idempotent_and_reconciles_lost_responses() {
    let f = Fixture::new().await;
    let catalog = f.catalog_bytes();
    let bytes = f.model_bytes(-10.0);
    let first = f
        .repository
        .publish_rank_model(&catalog, &bytes)
        .await
        .unwrap();
    assert!(first.write_acknowledged);
    let repeated = f
        .repository
        .publish_rank_model(&catalog, &bytes)
        .await
        .unwrap();
    assert!(repeated.reconciled_by_readback && !repeated.write_acknowledged);
    assert_eq!(first.sha256, repeated.sha256);
    let key = format!("rank-models/{}.json", first.sha256);
    assert_eq!(f.origin.objects.lock().unwrap()[&key], bytes);
    f.mode(Mode::LostModelResponse);
    let second = f
        .repository
        .publish_rank_model(&catalog, &f.model_bytes(10.0))
        .await
        .unwrap();
    assert!(second.reconciled_by_readback && !second.write_acknowledged);
    f.mode(Mode::LostModelUnreadable);
    let error = f
        .repository
        .publish_rank_model(&catalog, &f.model_bytes(5.0))
        .await
        .unwrap_err();
    assert_eq!(error.kind, DeploymentFailure::Uncertain);
    assert!(!error.activation_may_have_succeeded);
    f.mode(Mode::Normal);
    let third = f
        .repository
        .publish_rank_model(&catalog, &f.model_bytes(5.0))
        .await
        .unwrap();
    assert!(third.reconciled_by_readback);
    f.origin
        .objects
        .lock()
        .unwrap()
        .insert(key.clone(), b"externally-corrupted".to_vec());
    assert_eq!(
        f.repository
            .publish_rank_model(&catalog, &bytes)
            .await
            .unwrap_err()
            .kind,
        DeploymentFailure::Conflict
    );
    assert_eq!(
        f.origin.objects.lock().unwrap()[&key],
        b"externally-corrupted"
    );
    assert_eq!(f.origin.commits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_or_missing_models_and_incompatible_recall_cannot_activate() {
    let f = Fixture::new().await;
    let catalog = f.catalog_bytes();
    for mutation in 0..4 {
        let mut model: Value = serde_json::from_slice(&f.model_bytes(10.0)).unwrap();
        match mutation {
            0 => model["catalog_sha256"] = json!("a".repeat(64)),
            1 => model["feature_schema"] = json!("unknown"),
            2 => model["trained_before"] = json!(u64::MAX),
            _ => model["weights"] = json!([0.0]),
        }
        assert!(
            f.repository
                .publish_rank_model(&catalog, &serde_json::to_vec(&model).unwrap())
                .await
                .is_err()
        );
    }
    assert_eq!(f.origin.writes.load(Ordering::SeqCst), 0);
    for recall in [
        DeploymentRecall::ModelTopK,
        DeploymentRecall::ModelPruned,
        DeploymentRecall::ModelBlockMax,
    ] {
        let mut no_model = f.target.clone();
        no_model.recall = recall;
        assert_eq!(
            f.repository
                .activate("main", None, "no-model", no_model, Fixture::credentials())
                .await
                .unwrap_err()
                .kind,
            DeploymentFailure::InvalidInput
        );
    }
    let mut missing = f.target.clone();
    missing.recall = DeploymentRecall::Catalog;
    missing.rank_model_sha256 = Some("a".repeat(64));
    assert_eq!(
        f.repository
            .activate(
                "main",
                None,
                "missing-model",
                missing.clone(),
                Fixture::credentials(),
            )
            .await
            .unwrap_err()
            .stage,
        "rank_model_missing"
    );
    assert_eq!(f.origin.writes.load(Ordering::SeqCst), 0);
    for recall in [
        DeploymentRecall::Grouped,
        DeploymentRecall::Qdrant {
            endpoint: "http://127.0.0.1:1".into(),
            scoring: "signed".into(),
        },
    ] {
        let mut target = missing.clone();
        target.recall = recall;
        assert_eq!(
            f.repository
                .activate(
                    "main",
                    None,
                    "incompatible-model",
                    target,
                    Fixture::credentials(),
                )
                .await
                .unwrap_err()
                .kind,
            DeploymentFailure::InvalidInput
        );
    }
    assert_eq!(f.origin.writes.load(Ordering::SeqCst), 0);
    let publication = f
        .repository
        .publish_rank_model(&catalog, &f.model_bytes(10.0))
        .await
        .unwrap();
    let key = format!("rank-models/{}.json", publication.sha256);
    missing.rank_model_sha256 = Some(publication.sha256);
    for mode in [
        Mode::MissingEtag,
        Mode::OversizeModel,
        Mode::ModelChangedAfterHead,
    ] {
        let before = f.origin.commits.load(Ordering::SeqCst);
        f.mode(mode);
        assert!(
            f.repository
                .activate(
                    "main",
                    None,
                    "invalid-object",
                    missing.clone(),
                    Fixture::credentials(),
                )
                .await
                .is_err()
        );
        assert_eq!(f.origin.commits.load(Ordering::SeqCst), before);
        f.mode(Mode::Normal);
        f.origin
            .objects
            .lock()
            .unwrap()
            .insert(key.clone(), f.model_bytes(10.0));
    }
}

#[tokio::test]
#[ignore = "需要VS_TEST_MODEL_PUBLISHER指向已构建的publish_rank_model示例"]
async fn model_publisher_cli_matches_content_and_refuses_invalid_input_before_network_write() {
    let f = Fixture::new().await;
    let binary = std::env::var_os("VS_TEST_MODEL_PUBLISHER").expect("缺少模型发布示例路径");
    let catalog_path = f.directory.path().join("cli-catalog.json");
    let model_path = f.directory.path().join("cli-model.json");
    let model = f.model_bytes(-10.0);
    std::fs::write(&catalog_path, f.catalog_bytes()).unwrap();
    std::fs::write(&model_path, &model).unwrap();
    let output = |path: &std::path::Path| {
        let mut command = Command::new(&binary);
        command
            .arg(&catalog_path)
            .arg(path)
            .env("VS_S3_ENDPOINT", &f.endpoint)
            .env("VS_S3_REGION", "us-east-1")
            .env("VS_S3_BUCKET", "deployment")
            .env("VS_S3_ACCESS_KEY_ID", "test-access")
            .env("VS_S3_SECRET_ACCESS_KEY", "test-secret");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    };
    for attempt in 0..2 {
        let mut command = output(&model_path);
        let result = tokio::task::spawn_blocking(move || command.output().unwrap())
            .await
            .unwrap();
        assert!(result.status.success(), "模型发布CLI失败");
        let receipt: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(receipt["sha256"], format!("{:x}", Sha256::digest(&model)));
        assert_eq!(receipt["write_acknowledged"], attempt == 0);
        assert_eq!(receipt["reconciled_by_readback"], attempt == 1);
    }
    let before = f.origin.writes.load(Ordering::SeqCst);
    std::fs::write(&model_path, b"{}").unwrap();
    let mut command = output(&model_path);
    let failed = tokio::task::spawn_blocking(move || command.output().unwrap())
        .await
        .unwrap();
    assert!(!failed.status.success());
    assert_eq!(f.origin.writes.load(Ordering::SeqCst), before);
    println!(
        "{}",
        json!({"schema":"deployment-model-cli-contract-v1","passed":true,
        "storage_backend":"deterministic-http-fixture","same_model_retry_verified":true,
        "invalid_input_did_not_write":true})
    );
}

#[tokio::test]
async fn model_selection_checks_loaded_model_scope_while_legacy_targets_remain_baseline() {
    let f = Fixture::new().await;
    assert!(
        serde_json::to_value(&f.target)
            .unwrap()
            .get("rank_model_sha256")
            .is_none()
    );
    let catalog = f.catalog_bytes();
    let model_a = f.model_bytes(-10.0);
    let model_b = f.model_bytes(10.0);
    let published = f
        .repository
        .publish_rank_model(&catalog, &model_a)
        .await
        .unwrap();
    let baseline = f
        .repository
        .activate(
            "baseline",
            None,
            "baseline",
            f.target.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let baseline_snapshot = f.repository.load("baseline").await.unwrap().unwrap();
    assert!(
        f.repository
            .load_rank_model(&baseline_snapshot, &catalog)
            .await
            .unwrap()
            .is_none()
    );
    assert!(baseline.record.target.rank_model_sha256.is_none());
    let mut target = f.target.clone();
    target.recall = DeploymentRecall::Catalog;
    target.rank_model_sha256 = Some(published.sha256.clone());
    f.repository
        .activate("main", None, "with-model", target, Fixture::credentials())
        .await
        .unwrap();
    let snapshot = f.repository.load("main").await.unwrap().unwrap();
    let state = || {
        AppState::new(&catalog, None, API_TOKEN, 1, 1)
            .unwrap()
            .with_profile_remote(vs_service::ProfileRemoteConfig {
                endpoint: f.target.profile_authority.clone(),
                token: PROFILE_TOKEN.into(),
            })
            .unwrap()
            .with_profile_history(snapshot.record().profile_checkpoint.clone().unwrap())
            .unwrap()
    };
    assert!(state().with_deployment_snapshot(&snapshot).is_err());
    assert!(
        state()
            .with_rank_model(&model_b, &format!("{:x}", Sha256::digest(&model_b)))
            .unwrap()
            .with_deployment_snapshot(&snapshot)
            .is_err()
    );
    let selected = state()
        .with_rank_model(&model_a, &published.sha256)
        .unwrap()
        .with_deployment_snapshot(&snapshot)
        .unwrap();
    assert!(
        selected
            .with_rank_model(&model_b, &format!("{:x}", Sha256::digest(&model_b)))
            .is_err()
    );
    assert!(
        state()
            .with_rank_model(&model_a, &published.sha256)
            .unwrap()
            .with_deployment_snapshot(&baseline_snapshot)
            .is_err()
    );
    let mut other = f.config();
    other.bucket = "other".into();
    assert!(
        S3DeploymentRepository::new(other, 250)
            .unwrap()
            .load_rank_model(&snapshot, &catalog)
            .await
            .is_err()
    );
    assert!(
        f.repository
            .load_rank_model(&snapshot, b"{}")
            .await
            .is_err()
    );
    let mut target = snapshot.record().target.clone();
    target.recall = DeploymentRecall::ModelTopK;
    assert_eq!(
        serde_json::to_value(&target).unwrap()["recall"]["backend"],
        "model-topk"
    );
    f.repository
        .activate(
            "main",
            Some(&snapshot),
            "model-topk",
            target,
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let exact_snapshot = f.repository.load("main").await.unwrap().unwrap();
    let loaded = || {
        state()
            .with_rank_model(&model_a, &published.sha256)
            .unwrap()
    };
    assert!(loaded().with_deployment_snapshot(&exact_snapshot).is_err());
    assert!(
        loaded()
            .with_model_top_k()
            .unwrap()
            .with_deployment_snapshot(&snapshot)
            .is_err()
    );
    assert!(
        loaded()
            .with_deployment_snapshot(&snapshot)
            .unwrap()
            .with_model_top_k()
            .is_err()
    );
    assert!(
        loaded()
            .with_model_top_k()
            .unwrap()
            .with_deployment_snapshot(&exact_snapshot)
            .is_ok()
    );
    let mut target = exact_snapshot.record().target.clone();
    target.recall = DeploymentRecall::ModelPruned;
    assert_eq!(
        serde_json::to_value(&target).unwrap()["recall"]["backend"],
        "model-pruned"
    );
    f.repository
        .activate(
            "main",
            Some(&exact_snapshot),
            "model-pruned",
            target,
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let pruned_snapshot = f.repository.load("main").await.unwrap().unwrap();
    assert!(
        loaded()
            .with_model_top_k()
            .unwrap()
            .with_deployment_snapshot(&pruned_snapshot)
            .is_err()
    );
    assert!(
        loaded()
            .with_model_pruned()
            .unwrap()
            .with_deployment_snapshot(&exact_snapshot)
            .is_err()
    );
    assert!(
        loaded()
            .with_deployment_snapshot(&snapshot)
            .unwrap()
            .with_model_pruned()
            .is_err()
    );
    assert!(
        loaded()
            .with_model_pruned()
            .unwrap()
            .with_deployment_snapshot(&pruned_snapshot)
            .is_ok()
    );
    f.mode(Mode::MissingEtag);
    assert!(
        f.repository
            .load_rank_model(&snapshot, &catalog)
            .await
            .is_err()
    );
}

async fn selected_model_feed(client: &reqwest::Client, port: u16, expected: &str) -> Value {
    let response = client.post(format!("http://127.0.0.1:{port}/v1/feed"))
        .bearer_auth(API_TOKEN).json(&json!({
            "request_id":"pinned-model","subject":"subject-a","domains":["video","document"],"limit":2
        })).send().await.unwrap().error_for_status().unwrap();
    assert_eq!(response.headers()["x-rank-model-sha256"], expected);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["ranker"], "ftrl-ranker-v1");
    body
}

fn unused_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn independent_replicas_pin_model_across_upgrade_rollback_and_artifact_corruption() {
    check_independent_replicas(DeploymentRecall::Catalog).await;
}

#[tokio::test]
async fn exact_model_replicas_pin_backend_across_upgrade_rollback_and_artifact_corruption() {
    check_independent_replicas(DeploymentRecall::ModelTopK).await;
}

#[tokio::test]
async fn pruned_model_replicas_pin_backend_across_upgrade_rollback_and_artifact_corruption() {
    check_independent_replicas(DeploymentRecall::ModelPruned).await;
}

#[tokio::test]
async fn blockmax_model_replicas_pin_backend_across_upgrade_rollback_and_artifact_corruption() {
    check_independent_replicas(DeploymentRecall::ModelBlockMax).await;
}

async fn check_independent_replicas(recall: DeploymentRecall) {
    let f = Fixture::new().await;
    let catalog = f.catalog_bytes();
    let model_a = f
        .repository
        .publish_rank_model(&catalog, &f.model_bytes(-10.0))
        .await
        .unwrap();
    let model_b = f
        .repository
        .publish_rank_model(&catalog, &f.model_bytes(10.0))
        .await
        .unwrap();
    let mut target_a = f.target.clone();
    target_a.recall = recall;
    target_a.rank_model_sha256 = Some(model_a.sha256.clone());
    let first = f
        .repository
        .activate(
            "main",
            None,
            "model-a",
            target_a.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let old = f.repository.load("main").await.unwrap().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let mut replicas = Vec::new();
    for _ in 0..2 {
        let port = unused_port();
        let mut child = Process(api(&f, &first.sha256, port).spawn().unwrap());
        assert_eq!(
            ready(&client, port, &mut child).await["rank_model_sha256"],
            model_a.sha256
        );
        let metrics: Value = client
            .get(format!("http://127.0.0.1:{port}/v1/metrics"))
            .bearer_auth(API_TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            metrics["recall_backend"],
            serde_json::to_value(&target_a.recall).unwrap()["backend"]
        );
        replicas.push((port, child));
    }
    let mut target_b = target_a.clone();
    target_b.rank_model_sha256 = Some(model_b.sha256.clone());
    let second = f
        .repository
        .activate(
            "main",
            Some(&old),
            "model-b",
            target_b,
            Fixture::credentials(),
        )
        .await
        .unwrap();
    let middle = f.repository.load("main").await.unwrap().unwrap();
    let port_b = unused_port();
    let mut child_b = Process(api(&f, &second.sha256, port_b).spawn().unwrap());
    assert_eq!(
        ready(&client, port_b, &mut child_b).await["rank_model_sha256"],
        model_b.sha256
    );
    let rollback = f
        .repository
        .activate(
            "main",
            Some(&middle),
            "rollback-model-a",
            target_a.clone(),
            Fixture::credentials(),
        )
        .await
        .unwrap();
    assert_eq!(rollback.record.generation, 3);
    assert_ne!(rollback.sha256, first.sha256);
    assert_eq!(
        f.repository
            .activate(
                "main",
                Some(&old),
                "stale-model-a",
                target_a,
                Fixture::credentials(),
            )
            .await
            .unwrap_err()
            .kind,
        DeploymentFailure::Conflict
    );
    let port_r = unused_port();
    let mut child_r = Process(api(&f, &rollback.sha256, port_r).spawn().unwrap());
    ready(&client, port_r, &mut child_r).await;
    let before_reads = f.origin.etag_reads.load(Ordering::SeqCst);
    for (port, _) in &replicas {
        assert_eq!(
            selected_model_feed(&client, *port, &model_a.sha256).await["items"][0]["id"],
            "document"
        );
    }
    assert_eq!(
        selected_model_feed(&client, port_b, &model_b.sha256).await["items"][0]["id"],
        "video"
    );
    assert_eq!(
        selected_model_feed(&client, port_r, &model_a.sha256).await["items"][0]["id"],
        "document"
    );
    assert_eq!(f.origin.etag_reads.load(Ordering::SeqCst), before_reads);
    let key = format!("rank-models/{}.json", model_a.sha256);
    f.origin
        .objects
        .lock()
        .unwrap()
        .insert(key, b"corrupted-model".to_vec());
    let current = f.repository.load("main").await.unwrap().unwrap();
    assert!(
        f.repository
            .load_rank_model(&current, &catalog)
            .await
            .is_err()
    );
    let mut rejected = Process(api(&f, &rollback.sha256, 0).spawn().unwrap());
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
    assert_eq!(
        selected_model_feed(&client, replicas[0].0, &model_a.sha256).await["items"][0]["id"],
        "document"
    );
    println!(
        "{}",
        json!({
            "schema":"deployment-model-contract-v1","passed":true,
            "storage_backend":"deterministic-http-fixture","catalog_sha256":f.target.catalog_sha256,
            "model_a_sha256":model_a.sha256,"model_b_sha256":model_b.sha256,
            "model_a_bytes":model_a.bytes,"model_b_bytes":model_b.bytes,
            "recall_backend":serde_json::to_value(&rollback.record.target.recall).unwrap()["backend"],
            "independent_api_processes":4,"rollback_generation":3,"old_replicas_stay_pinned":true,
            "hot_path_storage_reads_added":0,"artifact_corruption_blocks_new_reader":true,
            "data_kind":"synthetic","physical_cluster_tested":false
        })
    );
}
