use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::get,
};
use futures_util::StreamExt;
use vs_storage::{MediaStore, S3Config};

#[derive(Clone)]
struct S3Fixture {
    reads: Arc<AtomicUsize>,
}

async fn object(State(state): State<S3Fixture>, method: Method, headers: HeaderMap) -> Response {
    assert!(
        headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("AWS4-HMAC-SHA256 ")
    );
    let bytes = b"0123456789abcdef";
    let mut builder = Response::builder()
        .header("etag", "\"fixture-etag\"")
        .header("last-modified", "Thu, 05 Nov 2026 00:00:00 GMT");
    if method == Method::HEAD {
        return builder
            .header("content-length", bytes.len())
            .body(Body::empty())
            .unwrap();
    }
    state.reads.fetch_add(1, Ordering::Relaxed);
    let ranges =
        http_range::HttpRange::parse(headers["range"].to_str().unwrap(), bytes.len() as u64)
            .unwrap();
    assert_eq!(ranges.len(), 1);
    let range = &ranges[0];
    let start = range.start as usize;
    let end = (range.start + range.length) as usize;
    builder = builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            "content-range",
            format!("bytes {}-{}/{}", start, end - 1, bytes.len()),
        )
        .header("content-length", range.length);
    builder
        .body(Body::from(bytes[start..end].to_vec()))
        .unwrap()
}

#[tokio::test]
async fn s3_adapter_uses_signed_requests_and_reads_only_selected_range() {
    let state = S3Fixture {
        reads: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/test-bucket/media/test", get(object))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await
            .unwrap();
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let store = MediaStore::s3(S3Config {
            endpoint: format!("http://{address}"),
            region: "us-east-1".into(),
            bucket: "test-bucket".into(),
            access_key_id: "fixture-access".into(),
            secret_access_key: "fixture-secret".into(),
        })
        .unwrap();
        assert_eq!(store.size("media/test").await.unwrap(), 16);
        let metadata = store.http_metrics().unwrap();
        assert_eq!(metadata.head_requests, 1);
        assert_eq!(metadata.response_body_bytes, 0);
        assert_eq!(metadata.abandoned_exchanges, 0);
        let mut source = store.stream("media/test", 4..9).await.unwrap();
        let mut received = Vec::new();
        while let Some(part) = source.next().await {
            received.extend_from_slice(&part.unwrap());
        }
        assert_eq!(received, b"45678");
        assert_eq!(state.reads.load(Ordering::Relaxed), 1);
        let metrics = store.http_metrics().unwrap();
        assert_eq!(metrics.get_requests, 1);
        assert_eq!(metrics.response_body_bytes, received.len() as u64);
        assert_eq!(metrics.active_exchanges, 0);
        assert_eq!(metrics.abandoned_exchanges, 0);
        assert_eq!(metrics.transport_errors, 0);
    })
    .await;
    let _ = stop_tx.send(());
    task.await.unwrap();
    result.unwrap();
}
