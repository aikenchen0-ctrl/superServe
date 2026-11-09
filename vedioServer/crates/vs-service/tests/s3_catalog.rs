use std::{
    collections::HashMap,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
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
use vs_core::catalog::MediaAsset;
use vs_service::s3_catalog::{CatalogFailure, S3CatalogConfig, S3CatalogRepository};
use vs_storage::S3Config;

#[derive(Clone, Copy)]
#[repr(usize)]
enum Mode {
    Normal,
    GateRelease,
    RejectRelease,
    LostReleaseResponse,
    LostAndUnreadable,
    FailReads,
    ShortBody,
    ConflictRelease,
}

struct Origin {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    mode: AtomicUsize,
    puts: AtomicUsize,
    gets: AtomicUsize,
    entered: Semaphore,
    resume: Semaphore,
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
    let mode = origin.mode.load(Ordering::SeqCst);
    let release = key.starts_with("releases/");
    if method == Method::PUT {
        assert_eq!(request.headers()["if-none-match"], "*");
        assert!(request.uri().query().is_none(), "目录必须使用单次条件Put");
        let data = to_bytes(request.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        origin.puts.fetch_add(1, Ordering::SeqCst);
        if release && mode == Mode::GateRelease as usize {
            origin.entered.add_permits(1);
            origin.resume.acquire().await.unwrap().forget();
        }
        if release && mode == Mode::RejectRelease as usize {
            return error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
        }
        if release && mode == Mode::ConflictRelease as usize {
            return error(StatusCode::CONFLICT, "ConditionalRequestConflict");
        }
        {
            let mut objects = origin.objects.lock().unwrap();
            if objects.contains_key(&key) {
                return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
            }
            objects.insert(key, data.to_vec());
        }
        if release
            && matches!(mode, value if value == Mode::LostReleaseResponse as usize || value == Mode::LostAndUnreadable as usize)
        {
            return std::future::pending().await;
        }
        return Response::builder()
            .header("etag", "\"published\"")
            .body(Body::empty())
            .unwrap();
    }
    if mode == Mode::FailReads as usize || (release && mode == Mode::LostAndUnreadable as usize) {
        return error(StatusCode::SERVICE_UNAVAILABLE, "ServiceUnavailable");
    }
    let data = match origin.objects.lock().unwrap().get(&key) {
        Some(data) => data.clone(),
        None => return error(StatusCode::NOT_FOUND, "NoSuchKey"),
    };
    if method == Method::HEAD {
        return Response::builder()
            .header("content-length", data.len())
            .header("etag", "\"published\"")
            .body(Body::empty())
            .unwrap();
    }
    assert_eq!(method, Method::GET);
    if !key.starts_with("media/") || request.headers().contains_key("if-match") {
        assert_eq!(request.headers()["if-match"], "\"published\"");
    }
    origin.gets.fetch_add(1, Ordering::SeqCst);
    let range = if let Some(range) = request.headers().get("range") {
        let range =
            http_range::HttpRange::parse(range.to_str().unwrap(), data.len() as u64).unwrap();
        range[0].start as usize..(range[0].start + range[0].length) as usize
    } else {
        0..data.len()
    };
    let mut selected = data[range.clone()].to_vec();
    if mode == Mode::ShortBody as usize {
        selected.pop();
    }
    let body = if mode == Mode::ShortBody as usize {
        Body::from_stream(futures_util::stream::once(async move {
            Ok::<_, std::io::Error>(selected)
        }))
    } else {
        Body::from(selected)
    };
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-length", range.len())
        .header(
            "content-range",
            format!("bytes {}-{}/{}", range.start, range.end - 1, data.len()),
        )
        .header("etag", "\"published\"")
        .body(body)
        .unwrap()
}

struct Fixture {
    endpoint: String,
    repository: S3CatalogRepository,
    origin: Arc<Origin>,
    asset: MediaAsset,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    async fn new() -> Self {
        let data: Vec<u8> = (0..131_099).map(|index| (index % 251) as u8).collect();
        let asset = MediaAsset {
            sha256: format!("{:x}", Sha256::digest(&data)),
            bytes: data.len() as u64,
            content_type: "application/octet-stream".into(),
        };
        let origin = Arc::new(Origin {
            objects: Mutex::new(HashMap::from([(asset.object_key(), data)])),
            mode: AtomicUsize::new(Mode::Normal as usize),
            puts: AtomicUsize::new(0),
            gets: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            resume: Semaphore::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/catalog/{*key}", any(object))
            .with_state(origin.clone());
        let task = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        let repository = Self::repository(&endpoint, 2);
        Self {
            endpoint,
            repository,
            origin,
            asset,
            task,
        }
    }

    fn repository(endpoint: &str, max_operations: usize) -> S3CatalogRepository {
        S3CatalogRepository::new(
            S3Config {
                endpoint: endpoint.into(),
                region: "us-east-1".into(),
                bucket: "catalog".into(),
                access_key_id: "test-access".into(),
                secret_access_key: "test-secret".into(),
            },
            S3CatalogConfig {
                max_operations,
                operation_timeout_ms: 250,
            },
        )
        .unwrap()
    }

    fn catalog(&self, version: &str, tag: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version":version, "items":[
                {"id":"video","domain":"video","tags":[tag],"prior":0.5,"media_sha256":self.asset.sha256},
                {"id":"document","domain":"document","tags":[tag],"prior":0.4,"media_sha256":null}
            ], "assets":[self.asset]
        })).unwrap()
    }

    fn mode(&self, mode: Mode) {
        self.origin.mode.store(mode as usize, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn same_version_concurrency_has_one_creator_and_cross_client_verified_reuse() {
    let fixture = Fixture::new().await;
    let bytes = fixture.catalog("v1", "original");
    let other = Fixture::repository(&fixture.endpoint, 2);
    let (left, right) = tokio::join!(fixture.repository.publish(&bytes), other.publish(&bytes));
    let (left, right) = (left.unwrap(), right.unwrap());
    assert_ne!(left.release_created, right.release_created);
    assert_ne!(left.catalog_created, right.catalog_created);
    assert_eq!(other.load("v1").await.unwrap(), bytes);
    let retry = other.publish(&bytes).await.unwrap();
    assert!(!retry.catalog_created && !retry.release_created);
    assert_eq!(retry.assets_verified, 1);
}

#[tokio::test]
async fn maximum_catalog_uses_single_conditional_put_and_local_release_format() {
    let fixture = Fixture::new().await;
    let mut bytes = serde_json::to_vec(&json!({
        "version":"maximum", "items":[
            {"id":"document","domain":"document","tags":[],"prior":0.5,"media_sha256":null}
        ],"assets":[]
    }))
    .unwrap();
    bytes.resize(8 * 1024 * 1024, b' ');
    let receipt = fixture.repository.publish(&bytes).await.unwrap();
    assert_eq!(receipt.release.catalog_bytes, bytes.len());
    assert_eq!(fixture.repository.load("maximum").await.unwrap(), bytes);
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("catalogs")).unwrap();
    std::fs::create_dir(directory.path().join("releases")).unwrap();
    for (key, data) in fixture.origin.objects.lock().unwrap().iter() {
        if key.starts_with("catalogs/") || key.starts_with("releases/") {
            std::fs::write(directory.path().join(key), data).unwrap();
        }
    }
    assert_eq!(
        vs_service::publication::load_catalog_release(directory.path(), "maximum").unwrap(),
        bytes
    );
    bytes.push(b' ');
    let puts = fixture.origin.puts.load(Ordering::SeqCst);
    assert_eq!(
        fixture.repository.publish(&bytes).await.unwrap_err().kind,
        CatalogFailure::InvalidInput
    );
    assert_eq!(fixture.origin.puts.load(Ordering::SeqCst), puts);
}

#[tokio::test]
async fn competing_contents_cannot_rebind_version_and_old_readers_remain_pinned() {
    let fixture = Fixture::new().await;
    let left = fixture.catalog("v1", "left");
    let right = fixture.catalog("v1", "right");
    let (a, b) = tokio::join!(
        fixture.repository.publish(&left),
        fixture.repository.publish(&right)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let (winner, error) = match (a, b) {
        (Ok(_), Err(error)) => (&left, error),
        (Err(error), Ok(_)) => (&right, error),
        _ => panic!("异内容同版本竞争没有唯一结果"),
    };
    assert_eq!(error.kind, CatalogFailure::Conflict);
    assert!(!error.release_may_have_committed);
    let next = fixture.catalog("v2", "next");
    fixture.repository.publish(&next).await.unwrap();
    assert_eq!(fixture.repository.load("v1").await.unwrap(), *winner);
    assert_eq!(fixture.repository.load("v2").await.unwrap(), next);
}

#[tokio::test]
async fn release_is_invisible_until_commit_and_failed_stage_can_be_retried() {
    let fixture = Fixture::new().await;
    let bytes = fixture.catalog("staged", "topic");
    fixture.mode(Mode::RejectRelease);
    assert!(fixture.repository.publish(&bytes).await.is_err());
    assert!(fixture.repository.load("staged").await.is_err());
    assert!(
        fixture
            .origin
            .objects
            .lock()
            .unwrap()
            .keys()
            .any(|key| key.starts_with("catalogs/"))
    );
    fixture.mode(Mode::GateRelease);
    let writer = fixture.repository.clone();
    let data = bytes.clone();
    let pending = tokio::spawn(async move { writer.publish(&data).await });
    tokio::time::timeout(Duration::from_secs(3), fixture.origin.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(fixture.repository.load("staged").await.is_err());
    fixture.origin.resume.add_permits(1);
    let receipt = pending.await.unwrap().unwrap();
    assert!(!receipt.catalog_created && receipt.release_created);
    assert_eq!(fixture.repository.load("staged").await.unwrap(), bytes);
}

#[tokio::test]
async fn missing_corrupt_or_short_media_never_commits_a_release() {
    let fixture = Fixture::new().await;
    let bytes = fixture.catalog("bad", "topic");
    let data = fixture
        .origin
        .objects
        .lock()
        .unwrap()
        .remove(&fixture.asset.object_key())
        .unwrap();
    assert!(fixture.repository.publish(&bytes).await.is_err());
    let mut corrupt = data.clone();
    corrupt[19] ^= 1;
    fixture
        .origin
        .objects
        .lock()
        .unwrap()
        .insert(fixture.asset.object_key(), corrupt);
    assert_eq!(
        fixture.repository.publish(&bytes).await.unwrap_err().kind,
        CatalogFailure::ContentMismatch
    );
    fixture
        .origin
        .objects
        .lock()
        .unwrap()
        .insert(fixture.asset.object_key(), data);
    fixture.mode(Mode::ShortBody);
    assert!(fixture.repository.publish(&bytes).await.is_err());
    assert_eq!(fixture.origin.puts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn response_loss_is_reconciled_readonly_and_unreadable_commit_is_explicitly_uncertain() {
    let fixture = Fixture::new().await;
    fixture.mode(Mode::LostReleaseResponse);
    let bytes = fixture.catalog("lost", "topic");
    let receipt = fixture.repository.publish(&bytes).await.unwrap();
    assert!(!receipt.release_created);
    assert_eq!(fixture.origin.puts.load(Ordering::SeqCst), 2);
    fixture.mode(Mode::LostAndUnreadable);
    let next = fixture.catalog("uncertain", "topic");
    let error = fixture.repository.publish(&next).await.unwrap_err();
    assert_eq!(error.kind, CatalogFailure::TimedOut);
    assert!(error.release_may_have_committed);
    fixture.mode(Mode::Normal);
    assert_eq!(fixture.repository.load("uncertain").await.unwrap(), next);
    assert!(
        !fixture
            .repository
            .publish(&next)
            .await
            .unwrap()
            .release_created
    );
}

#[tokio::test]
async fn conditional_409_does_not_retry_put_or_claim_absence() {
    let fixture = Fixture::new().await;
    fixture.mode(Mode::ConflictRelease);
    let error = fixture
        .repository
        .publish(&fixture.catalog("conflict", "topic"))
        .await
        .unwrap_err();
    assert!(error.release_may_have_committed);
    assert_eq!(fixture.origin.puts.load(Ordering::SeqCst), 2);
    assert!(
        !fixture
            .origin
            .objects
            .lock()
            .unwrap()
            .contains_key("releases/conflict.json")
    );
}

#[tokio::test]
async fn tampered_marker_catalog_and_oversized_body_fail_closed_before_large_reads() {
    let fixture = Fixture::new().await;
    let bytes = fixture.catalog("guarded", "topic");
    let receipt = fixture.repository.publish(&bytes).await.unwrap();
    let key = "releases/guarded.json".to_string();
    let marker = fixture.origin.objects.lock().unwrap()[&key].clone();
    let value: Value = serde_json::from_slice(&marker).unwrap();
    for (field, invalid) in [
        ("schema", json!("future")),
        ("version", json!("other")),
        ("catalog_sha256", json!("../escape")),
        ("catalog_bytes", json!(8 * 1024 * 1024 + 1)),
        ("asset_count", json!(2)),
        ("asset_bytes", json!(1)),
    ] {
        let mut changed = value.clone();
        changed[field] = invalid;
        fixture
            .origin
            .objects
            .lock()
            .unwrap()
            .insert(key.clone(), serde_json::to_vec(&changed).unwrap());
        assert!(
            fixture.repository.load("guarded").await.is_err(),
            "应拒绝字段：{field}"
        );
    }
    fixture
        .origin
        .objects
        .lock()
        .unwrap()
        .insert(key.clone(), vec![b' '; 4097]);
    let gets = fixture.origin.gets.load(Ordering::SeqCst);
    assert!(fixture.repository.load("guarded").await.is_err());
    assert_eq!(fixture.origin.gets.load(Ordering::SeqCst), gets);
    fixture.origin.objects.lock().unwrap().insert(key, marker);
    let catalog_key = format!("catalogs/{}.json", receipt.release.catalog_sha256);
    let mut corrupt = bytes.clone();
    corrupt[0] = b' ';
    fixture
        .origin
        .objects
        .lock()
        .unwrap()
        .insert(catalog_key.clone(), corrupt);
    assert!(fixture.repository.load("guarded").await.is_err());
    fixture
        .origin
        .objects
        .lock()
        .unwrap()
        .insert(catalog_key, vec![b' '; 8 * 1024 * 1024 + 1]);
    assert!(fixture.repository.load("guarded").await.is_err());
    for version in ["../escape", "", "x/y"] {
        assert_eq!(
            fixture.repository.load(version).await.unwrap_err().kind,
            CatalogFailure::InvalidInput
        );
    }
}

#[tokio::test]
async fn concurrency_budget_and_cancellation_allow_safe_whole_operation_retry() {
    let fixture = Fixture::new().await;
    let repository = Fixture::repository(&fixture.endpoint, 1);
    let bytes = fixture.catalog("cancelled", "topic");
    fixture.mode(Mode::GateRelease);
    let writer = repository.clone();
    let data = bytes.clone();
    let pending = tokio::spawn(async move { writer.publish(&data).await });
    tokio::time::timeout(Duration::from_secs(3), fixture.origin.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert_eq!(
        repository.load("cancelled").await.unwrap_err().kind,
        CatalogFailure::Busy
    );
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    // 取消无法撤回已发出的Put；只释放客户端并发预算，再以固定版本核对。
    fixture.origin.resume.add_permits(1);
    fixture.mode(Mode::Normal);
    let receipt = repository.publish(&bytes).await.unwrap();
    assert!(!receipt.catalog_created);
    assert_eq!(repository.load("cancelled").await.unwrap(), bytes);
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn service(fixture: &Fixture, version: &str, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vs-service"));
    for name in [
        "VS_CATALOG",
        "VS_PUBLICATION_ROOT",
        "VS_PROFILE_EVENT_LOG",
        "VS_PROFILE_AUTHORITY_URL",
        "VS_PROFILE_AUTHORITY_TOKEN",
        "VS_QDRANT_URL",
    ] {
        command.env_remove(name);
    }
    command
        .env("VS_ROLE", "all")
        .env("VS_BIND", format!("127.0.0.1:{port}"))
        .env(
            "VS_SERVICE_TOKEN",
            "remote-catalog-process-token-0000000000",
        )
        .env("VS_PUBLICATION_BACKEND", "s3")
        .env("VS_CATALOG_RELEASE", version)
        .env("VS_STORAGE", "s3")
        .env("VS_S3_ENDPOINT", &fixture.endpoint)
        .env("VS_S3_REGION", "us-east-1")
        .env("VS_S3_BUCKET", "catalog")
        .env("VS_S3_ACCESS_KEY_ID", "test-access")
        .env("VS_S3_SECRET_ACCESS_KEY", "test-secret")
        .env("VS_RECALL_BACKEND", "grouped")
        .env("VS_MEDIA_CACHE_BYTES", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[tokio::test]
async fn service_loads_remote_pin_serves_media_and_restarts_without_moving_versions() {
    let fixture = Fixture::new().await;
    let bytes = fixture.catalog("process-v1", "topic");
    fixture.repository.publish(&bytes).await.unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut process = Process(service(&fixture, "process-v1", port).spawn().unwrap());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let token = "remote-catalog-process-token-0000000000";
    let endpoint = format!("http://127.0.0.1:{port}");
    async fn ready(
        client: &reqwest::Client,
        endpoint: &str,
        token: &str,
        process: &mut Process,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            assert!(
                process.0.try_wait().unwrap().is_none(),
                "远端目录进程提前退出"
            );
            if let Ok(response) = client
                .get(format!("{endpoint}/readyz"))
                .bearer_auth(token)
                .send()
                .await
                && response.status().is_success()
            {
                return response.json().await.unwrap();
            }
            assert!(Instant::now() < deadline, "远端目录进程启动超时");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    assert_eq!(
        ready(&client, &endpoint, token, &mut process).await["catalog_version"],
        "process-v1"
    );
    let media = client
        .get(format!("{endpoint}/v1/media/{}", fixture.asset.sha256))
        .bearer_auth(token)
        .header("range", "bytes=5-49")
        .send()
        .await
        .unwrap();
    assert_eq!(media.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        media.bytes().await.unwrap().as_ref(),
        &(5..50).map(|index| (index % 251) as u8).collect::<Vec<_>>()
    );
    fixture
        .repository
        .publish(&fixture.catalog("process-v2", "changed"))
        .await
        .unwrap();
    assert_eq!(
        ready(&client, &endpoint, token, &mut process).await["catalog_version"],
        "process-v1"
    );
    drop(process);
    let mut restarted = Process(service(&fixture, "process-v1", port).spawn().unwrap());
    assert_eq!(
        ready(&client, &endpoint, token, &mut restarted).await["catalog_version"],
        "process-v1"
    );
}

#[tokio::test]
async fn invalid_startup_combinations_exit_before_network_and_configuration_limits_are_bounded() {
    let fixture = Fixture::new().await;
    for (name, value) in [
        ("VS_STORAGE", "fs"),
        ("VS_PUBLICATION_ROOT", "."),
        ("VS_CATALOG", "anything"),
        ("VS_PUBLICATION_BACKEND", "other"),
    ] {
        let mut command = service(&fixture, "unused", 0);
        let process = command.env(name, value).spawn().unwrap();
        let mut process = Process(process);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(status) = process.0.try_wait().unwrap() {
                    assert!(!status.success());
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    fixture.mode(Mode::FailReads);
    assert!(fixture.repository.load("unavailable").await.is_err());
    assert_eq!(fixture.origin.puts.load(Ordering::SeqCst), 0);
    for (operations, timeout) in [(0, 1000), (9, 1000), (1, 99), (1, 120_001)] {
        let result = S3CatalogRepository::new(
            S3Config {
                endpoint: fixture.endpoint.clone(),
                region: "us-east-1".into(),
                bucket: "catalog".into(),
                access_key_id: "test-access".into(),
                secret_access_key: "test-secret".into(),
            },
            S3CatalogConfig {
                max_operations: operations,
                operation_timeout_ms: timeout,
            },
        );
        assert!(result.is_err());
    }
}
