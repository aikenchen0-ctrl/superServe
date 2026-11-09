use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, RawQuery, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::any,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vs_core::catalog::MediaAsset;
use vs_service::s3_publication::{Cleanup, Failure, S3PublicationConfig, S3Publisher};
use vs_storage::S3Config;

const MIB: usize = 1024 * 1024;

#[derive(Clone, Copy)]
#[repr(usize)]
enum Mode {
    Normal,
    GatePart,
    GateInitiate,
    GateComplete,
    Conflict,
    EmbeddedError,
    AbortFails,
    CommitResponseLost,
}

struct Upload {
    key: String,
    parts: BTreeMap<usize, Vec<u8>>,
}

#[derive(Default)]
struct Objects {
    published: HashMap<String, Vec<u8>>,
    uploads: HashMap<String, Upload>,
}

struct Origin {
    state: Mutex<Objects>,
    mode: AtomicUsize,
    initiated: AtomicUsize,
    parts: AtomicUsize,
    completions: AtomicUsize,
    puts: AtomicUsize,
    aborts: AtomicUsize,
    gate: Semaphore,
}

#[derive(Deserialize)]
struct Complete {
    #[serde(rename = "Part", default)]
    parts: Vec<Part>,
}

#[derive(Deserialize)]
struct Part {
    #[serde(rename = "PartNumber")]
    number: usize,
    #[serde(rename = "ETag")]
    etag: String,
}

fn response(status: StatusCode, body: impl Into<String>, etag: Option<&str>) -> Response {
    let body = body.into();
    let mut response = Response::builder()
        .status(status)
        .header("content-length", body.len());
    if let Some(etag) = etag {
        response = response.header("etag", etag);
    }
    response.body(Body::from(body)).unwrap()
}

fn error(status: StatusCode, code: &str) -> Response {
    response(status, format!("<Error><Code>{code}</Code></Error>"), None)
}

async fn object(
    State(origin): State<Arc<Origin>>,
    Path(key): Path<String>,
    RawQuery(query): RawQuery,
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
    let query = reqwest::Url::parse(&format!("http://fixture/?{}", query.unwrap_or_default()))
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect::<HashMap<_, _>>();
    let mode = origin.mode.load(Ordering::SeqCst);
    if method == Method::POST && query.contains_key("uploads") {
        let number = origin.initiated.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("upload-{number}");
        origin.state.lock().unwrap().uploads.insert(
            id.clone(),
            Upload {
                key: key.clone(),
                parts: BTreeMap::new(),
            },
        );
        if mode == Mode::GateInitiate as usize {
            let _ = origin.gate.acquire().await;
        }
        return response(
            StatusCode::OK,
            format!(
                "<InitiateMultipartUploadResult><Bucket>publisher</Bucket><Key>{key}</Key><UploadId>{id}</UploadId></InitiateMultipartUploadResult>"
            ),
            None,
        );
    }
    if method == Method::PUT && query.contains_key("uploadId") {
        let id = &query["uploadId"];
        let number = query["partNumber"].parse::<usize>().unwrap();
        let body = to_bytes(request.into_body(), 33 * MIB).await.unwrap();
        origin.parts.fetch_add(1, Ordering::SeqCst);
        if mode == Mode::GatePart as usize || mode == Mode::AbortFails as usize {
            let _ = origin.gate.acquire().await;
        }
        let mut state = origin.state.lock().unwrap();
        let Some(upload) = state.uploads.get_mut(id) else {
            return error(StatusCode::NOT_FOUND, "NoSuchUpload");
        };
        assert_eq!(upload.key, key);
        upload.parts.insert(number, body.to_vec());
        return response(StatusCode::OK, "", Some(&format!("\"part-{number}\"")));
    }
    if method == Method::DELETE && query.contains_key("uploadId") {
        origin.aborts.fetch_add(1, Ordering::SeqCst);
        if mode == Mode::AbortFails as usize {
            return error(StatusCode::FORBIDDEN, "AccessDenied");
        }
        origin
            .state
            .lock()
            .unwrap()
            .uploads
            .remove(&query["uploadId"]);
        return response(StatusCode::NO_CONTENT, "", None);
    }
    if method == Method::POST && query.contains_key("uploadId") {
        assert_eq!(headers["if-none-match"], "*");
        let body = to_bytes(request.into_body(), MIB).await.unwrap();
        let completed: Complete = quick_xml::de::from_reader(body.as_ref()).unwrap();
        origin.completions.fetch_add(1, Ordering::SeqCst);
        if mode == Mode::GateComplete as usize {
            let _ = origin.gate.acquire().await;
        }
        if mode == Mode::Conflict as usize {
            return error(StatusCode::CONFLICT, "ConditionalRequestConflict");
        }
        if mode == Mode::EmbeddedError as usize {
            return error(StatusCode::OK, "InternalError");
        }
        {
            let mut state = origin.state.lock().unwrap();
            if state.published.contains_key(&key) {
                return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
            }
            let upload = state.uploads.remove(&query["uploadId"]).unwrap();
            let mut data = Vec::new();
            for (index, part) in completed.parts.iter().enumerate() {
                assert_eq!(part.number, index + 1);
                assert_eq!(part.etag.trim_matches('"'), format!("part-{}", part.number));
                let bytes = &upload.parts[&part.number];
                if index + 1 < completed.parts.len() {
                    assert!(bytes.len() >= 5 * MIB);
                }
                data.extend_from_slice(bytes);
            }
            state.published.insert(key.clone(), data);
        }
        if mode == Mode::CommitResponseLost as usize {
            let _ = origin.gate.acquire().await;
        }
        return response(
            StatusCode::OK,
            "<CompleteMultipartUploadResult><ETag>\"complete\"</ETag></CompleteMultipartUploadResult>",
            Some("\"complete\""),
        );
    }
    if method == Method::PUT {
        assert_eq!(headers["if-none-match"], "*");
        let body = to_bytes(request.into_body(), 33 * MIB).await.unwrap();
        origin.puts.fetch_add(1, Ordering::SeqCst);
        let mut state = origin.state.lock().unwrap();
        if state.published.contains_key(&key) {
            return error(StatusCode::PRECONDITION_FAILED, "PreconditionFailed");
        }
        state.published.insert(key, body.to_vec());
        return response(StatusCode::OK, "", Some("\"complete\""));
    }
    let state = origin.state.lock().unwrap();
    let Some(data) = state.published.get(&key) else {
        return error(StatusCode::NOT_FOUND, "NoSuchKey");
    };
    if method == Method::HEAD {
        return Response::builder()
            .header("content-length", data.len())
            .header("etag", "\"complete\"")
            .body(Body::empty())
            .unwrap();
    }
    let range = if let Some(range) = headers.get("range") {
        let range =
            &http_range::HttpRange::parse(range.to_str().unwrap(), data.len() as u64).unwrap()[0];
        range.start as usize..(range.start + range.length) as usize
    } else {
        0..data.len()
    };
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-length", range.len())
        .header(
            "content-range",
            format!("bytes {}-{}/{}", range.start, range.end - 1, data.len()),
        )
        .header("etag", "\"complete\"")
        .body(Body::from(data[range].to_vec()))
        .unwrap()
}

struct Fixture {
    _directory: tempfile::TempDir,
    path: std::path::PathBuf,
    asset: MediaAsset,
    data: Vec<u8>,
    origin: Arc<Origin>,
    publisher: S3Publisher,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.origin.gate.close();
        self.task.abort();
    }
}

impl Fixture {
    async fn new(size: usize, mode: Mode, timeout: u64) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
        let asset = MediaAsset {
            sha256: format!("{:x}", Sha256::digest(&data)),
            bytes: size as u64,
            content_type: "application/octet-stream".into(),
        };
        let path = directory.path().join("upload.bin");
        std::fs::write(&path, &data).unwrap();
        let origin = Arc::new(Origin {
            state: Mutex::new(Objects::default()),
            mode: AtomicUsize::new(mode as usize),
            initiated: AtomicUsize::new(0),
            parts: AtomicUsize::new(0),
            completions: AtomicUsize::new(0),
            puts: AtomicUsize::new(0),
            aborts: AtomicUsize::new(0),
            gate: Semaphore::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/publisher/{*key}", any(object))
            .with_state(origin.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let publisher = S3Publisher::new(
            S3Config {
                endpoint,
                region: "us-east-1".into(),
                bucket: "publisher".into(),
                access_key_id: "fixture-access".into(),
                secret_access_key: "fixture-secret".into(),
            },
            S3PublicationConfig {
                operation_timeout_ms: timeout,
                cleanup_timeout_ms: 1000,
                ..Default::default()
            },
        )
        .unwrap();
        Self {
            _directory: directory,
            path,
            asset,
            data,
            origin,
            publisher,
            task,
        }
    }

    fn start(&self) -> vs_service::s3_publication::UploadHandle {
        self.publisher
            .start_file(self.path.clone(), self.asset.clone())
            .unwrap()
    }

    async fn idle(&self) {
        wait(|| self.publisher.metrics().active_uploads == 0).await;
    }
}

async fn wait(condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(6), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("S3协议夹具等待超时");
}

#[tokio::test]
async fn single_put_and_multipart_are_conditional_and_retries_verify_existing_content() {
    for size in [8192, 6 * MIB + 13] {
        let fixture = Fixture::new(size, Mode::Normal, 3000).await;
        let first = fixture.start().wait().await.unwrap();
        assert!(first.created && first.source_verified);
        assert!(!first.existing_object_readback_verified);
        assert_eq!(
            fixture.origin.state.lock().unwrap().published[&fixture.asset.object_key()],
            fixture.data
        );
        std::fs::remove_file(&fixture.path).unwrap();
        let retry = fixture.start().wait().await.unwrap();
        assert!(!retry.created && retry.existing_object_readback_verified);
        assert!(fixture.origin.state.lock().unwrap().uploads.is_empty());
        fixture.idle().await;
        if size < 5 * MIB {
            assert_eq!(fixture.origin.puts.load(Ordering::SeqCst), 1);
        } else {
            assert_eq!(fixture.origin.completions.load(Ordering::SeqCst), 1);
            assert!(fixture.origin.parts.load(Ordering::SeqCst) >= 2);
        }
    }
}

#[tokio::test]
async fn concurrent_multipart_loser_aborts_and_verifies_the_winner_without_overwrite() {
    let fixture = Fixture::new(6 * MIB + 13, Mode::GateComplete, 3000).await;
    let first = fixture.start();
    let second = fixture.start();
    wait(|| fixture.origin.completions.load(Ordering::SeqCst) == 2).await;
    fixture.origin.gate.close();
    let first = first.wait().await.unwrap();
    let second = second.wait().await.unwrap();
    assert_ne!(first.created, second.created);
    assert_eq!(fixture.origin.aborts.load(Ordering::SeqCst), 1);
    assert!(fixture.origin.state.lock().unwrap().uploads.is_empty());
    assert_eq!(
        fixture.origin.state.lock().unwrap().published[&fixture.asset.object_key()],
        fixture.data
    );
    fixture.idle().await;
}

#[tokio::test]
async fn bad_stream_digest_aborts_before_final_commit_and_corrupt_existing_is_not_reused() {
    let fixture = Fixture::new(11 * MIB + 13, Mode::Normal, 3000).await;
    let mut asset = fixture.asset.clone();
    asset.sha256 = "a".repeat(64);
    let error = fixture
        .publisher
        .start_file(fixture.path.clone(), asset)
        .unwrap()
        .wait()
        .await
        .unwrap_err();
    assert_eq!(error.kind, Failure::ContentMismatch);
    assert_eq!(error.cleanup, Cleanup::AbortAcknowledged);
    assert_eq!(fixture.origin.completions.load(Ordering::SeqCst), 0);
    assert!(fixture.origin.state.lock().unwrap().uploads.is_empty());
    assert!(fixture.origin.state.lock().unwrap().published.is_empty());
    let mut corrupt = fixture.data.clone();
    corrupt[0] ^= 1;
    fixture
        .origin
        .state
        .lock()
        .unwrap()
        .published
        .insert(fixture.asset.object_key(), corrupt.clone());
    let error = fixture.start().wait().await.unwrap_err();
    assert_eq!(error.kind, Failure::ContentMismatch);
    assert_eq!(
        fixture.origin.state.lock().unwrap().published[&fixture.asset.object_key()],
        corrupt
    );
}

#[tokio::test]
async fn dropped_waiter_keeps_cleanup_supervised_and_capacity_releases_after_abort() {
    let fixture = Fixture::new(16 * MIB + 13, Mode::GatePart, 3000).await;
    let handle = fixture.start();
    wait(|| fixture.origin.parts.load(Ordering::SeqCst) >= 1).await;
    drop(handle);
    fixture.origin.gate.close();
    fixture.idle().await;
    let metrics = fixture.publisher.metrics();
    assert_eq!(metrics.cancelled, 1);
    assert_eq!(fixture.origin.aborts.load(Ordering::SeqCst), 1);
    assert!(fixture.origin.state.lock().unwrap().uploads.is_empty());
    assert!(fixture.origin.state.lock().unwrap().published.is_empty());
}

#[tokio::test]
async fn commit_conflict_is_not_retried_as_the_same_close_and_embedded_errors_are_detected() {
    for (mode, kind) in [
        (Mode::Conflict, Failure::Conflict),
        (Mode::EmbeddedError, Failure::Storage),
    ] {
        let fixture = Fixture::new(6 * MIB + 13, mode, 3000).await;
        let error = fixture.start().wait().await.unwrap_err();
        assert_eq!(error.kind, kind);
        assert_eq!(fixture.origin.completions.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.origin.aborts.load(Ordering::SeqCst), 1);
        assert!(fixture.origin.state.lock().unwrap().uploads.is_empty());
        assert!(fixture.origin.state.lock().unwrap().published.is_empty());
    }
}

#[tokio::test]
async fn lost_initiate_reply_retains_unconfirmed_cleanup_and_remote_orphan_counterexample() {
    let fixture = Fixture::new(11 * MIB + 13, Mode::GateInitiate, 500).await;
    let error = fixture.start().wait().await.unwrap_err();
    assert_eq!(error.kind, Failure::TimedOut);
    assert_eq!(error.cleanup, Cleanup::Unconfirmed);
    assert_eq!(fixture.origin.aborts.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.origin.state.lock().unwrap().uploads.len(), 1);
    assert!(fixture.origin.state.lock().unwrap().published.is_empty());
    fixture.idle().await;
    assert_eq!(fixture.publisher.metrics().cleanup_unconfirmed, 1);
}

#[tokio::test]
async fn abort_rejection_is_not_reported_as_successful_cleanup() {
    let fixture = Fixture::new(16 * MIB + 13, Mode::AbortFails, 3000).await;
    let mut handle = fixture.start();
    wait(|| fixture.origin.parts.load(Ordering::SeqCst) >= 1).await;
    handle.cancel();
    fixture.origin.gate.close();
    let error = handle.wait().await.unwrap_err();
    assert_eq!(error.kind, Failure::Cancelled);
    assert_eq!(error.cleanup, Cleanup::Unconfirmed);
    assert_eq!(fixture.origin.state.lock().unwrap().uploads.len(), 1);
    fixture.idle().await;
    assert_eq!(fixture.publisher.metrics().cleanup_unconfirmed, 1);
}

#[tokio::test]
async fn lost_commit_reply_preserves_final_object_and_reports_uncertainty() {
    let fixture = Fixture::new(6 * MIB + 13, Mode::CommitResponseLost, 500).await;
    let error = fixture.start().wait().await.unwrap_err();
    assert_eq!(error.kind, Failure::TimedOut);
    assert!(error.commit_may_have_succeeded);
    assert_eq!(error.cleanup, Cleanup::Unconfirmed);
    assert_eq!(
        fixture.origin.state.lock().unwrap().published[&fixture.asset.object_key()],
        fixture.data
    );
    fixture.idle().await;
    fixture.origin.gate.close();
    let retry = fixture.start().wait().await.unwrap();
    assert!(!retry.created && retry.existing_object_readback_verified);
}

#[tokio::test]
async fn admission_budget_is_bounded_and_shutdown_stops_new_uploads() {
    let fixture = Fixture::new(11 * MIB + 13, Mode::GateInitiate, 3000).await;
    let mut first = fixture.start();
    let mut second = fixture.start();
    wait(|| fixture.publisher.metrics().active_uploads == 2).await;
    assert!(matches!(
        fixture.publisher.start_file(fixture.path.clone(), fixture.asset.clone()),
        Err(error) if error.kind == Failure::Busy
    ));
    first.cancel();
    second.cancel();
    fixture.origin.gate.close();
    assert_eq!(first.wait().await.unwrap_err().kind, Failure::Cancelled);
    assert_eq!(second.wait().await.unwrap_err().kind, Failure::Cancelled);
    fixture.publisher.shutdown().await;
    assert!(matches!(
        fixture.publisher.start_file(fixture.path.clone(), fixture.asset.clone()),
        Err(error) if error.kind == Failure::Busy
    ));
}

#[tokio::test]
async fn cancellation_after_commit_starts_does_not_delete_a_committed_object() {
    let fixture = Fixture::new(6 * MIB + 13, Mode::GateComplete, 3000).await;
    let mut handle = fixture.start();
    wait(|| fixture.origin.completions.load(Ordering::SeqCst) == 1).await;
    handle.cancel();
    fixture.origin.gate.close();
    let receipt = handle.wait().await.unwrap();
    assert!(receipt.created && receipt.source_verified);
    assert_eq!(
        fixture.origin.state.lock().unwrap().published[&fixture.asset.object_key()],
        fixture.data
    );
    assert_eq!(fixture.origin.aborts.load(Ordering::SeqCst), 0);
    fixture.idle().await;
    assert_eq!(fixture.publisher.metrics().created, 1);
}

#[test]
fn configuration_rejects_unbounded_parts_and_deadlines() {
    assert!(S3PublicationConfig::default().validate().is_ok());
    for config in [
        S3PublicationConfig {
            part_bytes: MIB,
            ..Default::default()
        },
        S3PublicationConfig {
            max_uploads: 0,
            ..Default::default()
        },
        S3PublicationConfig {
            max_uploads: 17,
            ..Default::default()
        },
        S3PublicationConfig {
            operation_timeout_ms: 0,
            ..Default::default()
        },
        S3PublicationConfig {
            cleanup_timeout_ms: 30_001,
            ..Default::default()
        },
    ] {
        assert!(config.validate().is_err());
    }
}
