use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::get,
};
use futures_util::{StreamExt, stream};
use vs_storage::{MediaStore, ReadMode, S3Config};

struct FixtureState {
    bytes: Vec<u8>,
    ranges: Mutex<Vec<(usize, usize)>>,
    blocking: Blocking,
    headers_gate: tokio::sync::Notify,
    body_dropped: Arc<AtomicBool>,
}

#[derive(Clone, Copy)]
enum Blocking {
    None,
    Tail,
    Headers,
}

struct BodyGuard(Arc<AtomicBool>);

impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

async fn object(
    State(state): State<Arc<FixtureState>>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let mut response = Response::builder()
        .header("etag", "\"read-modes\"")
        .header("last-modified", "Thu, 05 Nov 2026 00:00:00 GMT");
    if method == Method::HEAD {
        return response
            .header("content-length", state.bytes.len())
            .body(Body::empty())
            .unwrap();
    }
    let range =
        &http_range::HttpRange::parse(headers["range"].to_str().unwrap(), state.bytes.len() as u64)
            .unwrap()[0];
    let start = range.start as usize;
    let end = start + range.length as usize;
    state.ranges.lock().unwrap().push((start, end));
    if matches!(state.blocking, Blocking::Headers) {
        state.headers_gate.notified().await;
    }
    response = response
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-length", range.length)
        .header(
            "content-range",
            format!("bytes {}-{}/{}", start, end - 1, state.bytes.len()),
        );
    if !matches!(state.blocking, Blocking::Tail) {
        return response
            .body(Body::from(state.bytes[start..end].to_vec()))
            .unwrap();
    }
    // 首块之后永不完成；只有流式读取才能先返回首块，取消必须释放服务端正文。
    let guard = BodyGuard(state.body_dropped.clone());
    let body = stream::unfold(
        (start, state, guard),
        move |(offset, state, guard)| async move {
            if offset > start {
                std::future::pending::<()>().await;
            }
            let next = (offset + 16 * 1024).min(end);
            let data = state.bytes[offset..next].to_vec();
            Some((Ok::<_, std::io::Error>(data), (next, state, guard)))
        },
    );
    response.body(Body::from_stream(body)).unwrap()
}

struct Fixture {
    store: MediaStore,
    state: Arc<FixtureState>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Fixture {
    async fn new(blocking: Blocking) -> Self {
        let state = Arc::new(FixtureState {
            bytes: (0..1_048_749)
                .map(|index| ((index * 17 + index / 251) % 256) as u8)
                .collect(),
            ranges: Mutex::new(Vec::new()),
            blocking,
            headers_gate: tokio::sync::Notify::new(),
            body_dropped: Arc::new(AtomicBool::new(false)),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/read-modes/media/object", get(object).head(object))
            .with_state(state.clone());
        let (stop, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await
        });
        let store = MediaStore::s3(S3Config {
            endpoint: format!("http://{address}"),
            region: "us-east-1".into(),
            bucket: "read-modes".into(),
            access_key_id: "fixture-access".into(),
            secret_access_key: "fixture-secret".into(),
        })
        .unwrap();
        Self {
            store,
            state,
            stop: Some(stop),
            task,
        }
    }

    async fn close(mut self) {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn modes_preserve_exact_ranges_across_offsets_and_boundaries() {
    let fixture = Fixture::new(Blocking::None).await;
    let size = fixture.state.bytes.len();
    for (mode, max_request) in [
        (ReadMode::Chunk64Kib, Some(65_536)),
        (ReadMode::Chunk256Kib, Some(262_144)),
        (ReadMode::Chunk1Mib, Some(1_048_576)),
        (ReadMode::Streaming, None),
    ] {
        let store = fixture.store.clone().with_read_mode(mode);
        for range in [0..size, 17..size - 19, 65_531..196_625, size - 10_003..size] {
            fixture.state.ranges.lock().unwrap().clear();
            let mut input = store
                .stream("media/object", range.start as u64..range.end as u64)
                .await
                .unwrap();
            let mut actual = Vec::new();
            while let Some(part) = input.next().await {
                actual.extend_from_slice(&part.unwrap());
            }
            assert_eq!(actual, fixture.state.bytes[range.clone()]);
            let requests = fixture.state.ranges.lock().unwrap();
            let mut offset = range.start;
            for &(start, end) in requests.iter() {
                assert_eq!(start, offset);
                assert!(end > start && end <= range.end);
                assert!(max_request.is_none_or(|max| end - start <= max));
                offset = end;
            }
            assert_eq!(offset, range.end);
            if mode == ReadMode::Streaming {
                assert_eq!(requests.len(), 1);
            }
            assert_eq!(store.http_metrics().unwrap().active_exchanges, 0);
        }
    }
    fixture.close().await;
}

#[tokio::test]
async fn streaming_yields_before_blocked_tail_and_cancels_upstream() {
    let fixture = Fixture::new(Blocking::Tail).await;
    let store = fixture.store.clone().with_read_mode(ReadMode::Streaming);
    let size = fixture.state.bytes.len() as u64;
    let mut input = store.stream("media/object", 0..size).await.unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), input.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!first.is_empty() && first.len() <= 16 * 1024);
    assert_eq!(first.as_ref(), &fixture.state.bytes[..first.len()]);
    assert_eq!(store.http_metrics().unwrap().active_exchanges, 1);
    drop(input);
    assert_eq!(store.http_metrics().unwrap().active_exchanges, 0);
    assert_eq!(store.http_metrics().unwrap().abandoned_exchanges, 1);
    assert_eq!(store.http_metrics().unwrap().abandoned_during_body, 1);
    assert_eq!(store.http_metrics().unwrap().abandoned_before_headers, 0);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fixture.state.body_dropped.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn cancellation_while_waiting_for_headers_is_separate_from_body_drop() {
    let fixture = Fixture::new(Blocking::Headers).await;
    let store = fixture.store.clone();
    let reader = store.clone();
    let pending = tokio::spawn(async move {
        let mut stream = reader.stream("media/object", 0..4096).await.unwrap();
        stream.next().await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.state.ranges.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    let metrics = store.http_metrics().unwrap();
    assert_eq!(metrics.active_exchanges, 0);
    assert_eq!(metrics.abandoned_exchanges, 1);
    assert_eq!(metrics.abandoned_before_headers, 1);
    assert_eq!(metrics.abandoned_during_body, 0);
    fixture.state.headers_gate.notify_one();
    fixture.close().await;
}
