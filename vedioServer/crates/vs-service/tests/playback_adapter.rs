use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{Router, body::Body, response::Response, routing::get};
use futures_util::stream;
use reqwest::Client;
use serde_json::json;
use vs_core::{
    playback::{PlaybackActivity, PlaybackPolicy},
    playback_adapter::{BufferedRange, Completion, PlayerAdapter, PlayerSnapshot, TransferOutcome},
};
use vs_service::hls::publish_hls;

fn snapshot(generation: u64, sequence: u64) -> PlayerSnapshot {
    PlayerSnapshot {
        generation,
        sequence,
        monotonic_ms: sequence * 10,
        position_ms: 0,
        tracks: vec![Vec::new()],
        buffered_bytes: 0,
        activity: PlaybackActivity::Active,
        playback_rate_milli: 1000,
        rebuffering: false,
        end_of_stream: false,
    }
}

struct Closed(Arc<AtomicBool>);
impl Drop for Closed {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct Server(tokio::task::JoinHandle<io::Result<()>>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn real_fragment_cancel_releases_transport_but_old_callback_cannot_commit_to_new_generation()
{
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("input.mp4");
    std::fs::write(&source, include_bytes!("fixtures/mp4/h264-aac-tail.mp4")).unwrap();
    let publication = publish_hls(directory.path(), &source, "adapter-v1", "clip", 1).unwrap();
    let hash = &publication
        .tracks
        .iter()
        .find(|track| track.kind == "video")
        .unwrap()
        .segments[0]
        .sha256;
    let data = Arc::new(std::fs::read(directory.path().join("media").join(hash)).unwrap());
    assert!(data.len() > 1024);
    let expected = data.len() as u64;
    let waiting = Arc::new(tokio::sync::Notify::new());
    let closed = Arc::new(AtomicBool::new(false));
    let yielded = Arc::new(AtomicU64::new(0));
    let app = Router::new().route(
        "/fragment.mp4",
        get({
            let waiting = waiting.clone();
            let closed = closed.clone();
            let yielded = yielded.clone();
            let data = data.clone();
            move || {
                let waiting = waiting.clone();
                let closed = closed.clone();
                let yielded = yielded.clone();
                let data = data.clone();
                async move {
                    let guard = Closed(closed);
                    let body = stream::unfold((false, data, guard), move |(sent, data, guard)| {
                        let waiting = waiting.clone();
                        let yielded = yielded.clone();
                        async move {
                            if sent {
                                waiting.notify_one();
                                std::future::pending::<()>().await;
                            }
                            yielded.fetch_add(1024, Ordering::SeqCst);
                            Some((
                                Ok::<_, io::Error>(data[..1024].to_vec()),
                                (true, data, guard),
                            ))
                        }
                    });
                    Response::builder()
                        .header("content-length", expected)
                        .header("content-type", "video/mp4")
                        .body(Body::from_stream(body))
                        .unwrap()
                }
            }
        }),
    );
    let app = app.route(
        "/complete.mp4",
        get({
            let data = data.clone();
            move || {
                let data = data.clone();
                async move {
                    Response::builder()
                        .header("content-length", data.len())
                        .body(Body::from(data.as_ref().clone()))
                        .unwrap()
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut server = Server(tokio::spawn(
        async move { axum::serve(listener, app).await },
    ));
    let client = Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let mut adapter = PlayerAdapter::new(PlaybackPolicy::default()).unwrap();
    let old = adapter
        .update(&snapshot(1, 1), Some(expected))
        .unwrap()
        .request
        .unwrap();
    let mut response = client
        .get(format!("http://{address}/fragment.mp4"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let received = response.chunk().await.unwrap().unwrap().len() as u64;
    assert_eq!(received, 1024);
    tokio::time::timeout(Duration::from_secs(2), waiting.notified())
        .await
        .unwrap();
    let mut hidden = snapshot(1, 2);
    hidden.activity = PlaybackActivity::Hidden;
    assert_eq!(
        adapter.update(&hidden, Some(expected)).unwrap().cancel,
        Some(old)
    );
    let next_generation = adapter.change_generation().unwrap();
    assert_eq!(next_generation.cancel, Some(old));
    // 尚未确认传输释放时，旧预留继续阻止新内容的取片。
    assert!(
        adapter
            .update(&snapshot(2, 1), Some(expected))
            .unwrap()
            .request
            .is_none()
    );
    drop(response);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !closed.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        adapter.transfer_finished(old, received, TransferOutcome::Cancelled),
        Completion::Discarded
    );
    let new = adapter
        .update(&snapshot(2, 2), Some(expected))
        .unwrap()
        .request
        .unwrap();
    assert_eq!(
        adapter.transfer_finished(old, expected, TransferOutcome::Complete),
        Completion::Stale
    );
    assert!(!adapter.release(old));
    let new_bytes = client
        .get(format!("http://{address}/complete.mp4"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(new_bytes.as_ref(), data.as_slice());
    assert_eq!(
        adapter.transfer_finished(new, new_bytes.len() as u64, TransferOutcome::Complete),
        Completion::ReadyForAppend
    );
    assert!(
        adapter
            .update(&snapshot(2, 3), None)
            .unwrap()
            .request
            .is_none()
    );
    let mut appended = snapshot(2, 4);
    appended.tracks = vec![vec![BufferedRange {
        start_ms: 0,
        end_ms: 1000,
    }]];
    appended.buffered_bytes = expected;
    let result = adapter.appended(new, &appended, None).unwrap();
    assert_eq!(result.feedback.buffered_media_ms, 1000);
    assert!(result.decision.start_playback);
    println!(
        "{}",
        json!({
            "schema":"playback-adapter-network-contract-v1",
            "fixture":"真实HLS视频片；测试端点在首块后阻塞以隔离取消机制",
            "fragment_bytes":expected,
            "cancelled_request_received_bytes":received,
            "cancelled_request_server_yielded_bytes":yielded.load(Ordering::SeqCst),
            "peer_body_released":closed.load(Ordering::SeqCst),
            "old_generation_completion_rejected":true,
            "new_generation_full_fragment_verified":true,
            "append_confirmation_required":true,
            "player_snapshot_source":"测试输入，非手机渲染",
        })
    );
    server.0.abort();
    let _ = (&mut server.0).await;
}
