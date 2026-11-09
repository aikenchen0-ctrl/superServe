// 合约和成本工具共享夹具，各入口仅使用所需的故障与观测面。
#![allow(dead_code)]

use std::{
    ops::Range,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
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
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vs_service::{AppState, Role, router};
use vs_storage::{MediaCacheConfig, MediaCachePolicy, MediaStore, ReadMode, S3Config};

pub const TOKEN: &str = "cache-fixture-service-token-00000000000";

#[derive(Clone, Copy)]
#[repr(usize)]
pub enum Behavior {
    Normal,
    HeadersGated,
    BodyGated,
    NotFound,
    Truncated,
}

pub struct Origin {
    pub data: Vec<u8>,
    pub hash: String,
    pub gets: AtomicU64,
    pub heads: AtomicU64,
    pub head_length: AtomicU64,
    pub sent_bytes: AtomicU64,
    pub bodies_dropped: AtomicU64,
    pub behavior: AtomicUsize,
    pub gate: Semaphore,
    pub ranges: Mutex<Vec<Range<usize>>>,
}

struct BodyGuard(Arc<Origin>);

impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.0.bodies_dropped.fetch_add(1, Ordering::SeqCst);
    }
}

async fn object(State(state): State<Arc<Origin>>, method: Method, headers: HeaderMap) -> Response {
    assert!(
        headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("AWS4-HMAC-SHA256 ")
    );
    let builder = Response::builder()
        .header("etag", format!("\"{}\"", state.hash))
        .header("last-modified", "Fri, 06 Nov 2026 00:00:00 GMT");
    if method == Method::HEAD {
        state.heads.fetch_add(1, Ordering::SeqCst);
        return builder
            .header("content-length", state.head_length.load(Ordering::SeqCst))
            .body(Body::empty())
            .unwrap();
    }
    let range =
        &http_range::HttpRange::parse(headers["range"].to_str().unwrap(), state.data.len() as u64)
            .unwrap()[0];
    let start = range.start as usize;
    let end = start + range.length as usize;
    state.ranges.lock().unwrap().push(start..end);
    state.gets.fetch_add(1, Ordering::SeqCst);
    let behavior = state.behavior.load(Ordering::SeqCst);
    if behavior == Behavior::NotFound as usize {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }
    if behavior == Behavior::HeadersGated as usize
        && let Ok(permit) = state.gate.acquire().await
    {
        permit.forget();
    }
    let builder = builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-length", range.length)
        .header(
            "content-range",
            format!("bytes {}-{}/{}", start, end - 1, state.data.len()),
        );
    let guard = BodyGuard(state.clone());
    let body = stream::unfold(
        (start, state, guard),
        move |(offset, state, guard)| async move {
            let available_end = if behavior == Behavior::Truncated as usize {
                end - 1024.min(end - start)
            } else {
                end
            };
            if offset >= available_end {
                return None;
            }
            if offset > start
                && behavior == Behavior::BodyGated as usize
                && let Ok(permit) = state.gate.acquire().await
            {
                permit.forget();
            }
            let next = (offset + 1024).min(available_end);
            let bytes = state.data[offset..next].to_vec();
            state
                .sent_bytes
                .fetch_add(bytes.len() as u64, Ordering::SeqCst);
            Some((Ok::<_, std::io::Error>(bytes), (next, state, guard)))
        },
    );
    builder.body(Body::from_stream(body)).unwrap()
}

pub struct Fixture {
    pub origin: Arc<Origin>,
    pub store: MediaStore,
    pub client: Client,
    pub api: String,
    pub state: Arc<AppState>,
    origin_task: tokio::task::JoinHandle<()>,
    api_task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    pub async fn new(cache: Option<MediaCacheConfig>, mode: ReadMode, behavior: Behavior) -> Self {
        Self::new_with_policy(cache, mode, behavior, MediaCachePolicy::Exact).await
    }

    pub async fn new_with_policy(
        cache: Option<MediaCacheConfig>,
        mode: ReadMode,
        behavior: Behavior,
        policy: MediaCachePolicy,
    ) -> Self {
        let data: Vec<u8> = (0..1_048_749)
            .map(|index| ((index * 17 + index / 251) % 256) as u8)
            .collect();
        let hash = format!("{:x}", Sha256::digest(&data));
        let origin = Arc::new(Origin {
            head_length: AtomicU64::new(data.len() as u64),
            data,
            hash: hash.clone(),
            gets: AtomicU64::new(0),
            heads: AtomicU64::new(0),
            sent_bytes: AtomicU64::new(0),
            bodies_dropped: AtomicU64::new(0),
            behavior: AtomicUsize::new(behavior as usize),
            gate: Semaphore::new(0),
            ranges: Mutex::new(Vec::new()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/cache-fixture/media/{hash}", get(object))
            .with_state(origin.clone());
        let origin_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let store = MediaStore::s3(S3Config {
            endpoint: origin_url,
            region: "us-east-1".into(),
            bucket: "cache-fixture".into(),
            access_key_id: "fixture-access".into(),
            secret_access_key: "fixture-secret".into(),
        })
        .unwrap()
        .with_read_mode(mode);
        let store = match cache {
            Some(config) => store.with_media_cache_policy(config, policy).unwrap(),
            None => store,
        };
        let catalog = serde_json::to_vec(&json!({
            "version":"cache-fixture-v1","items":[],
            "assets":[{"sha256":hash,"bytes":origin.data.len(),"content_type":"video/mp4"}]
        }))
        .unwrap();
        let state = Arc::new(AppState::new(&catalog, Some(store.clone()), TOKEN, 1, 32).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let app = router(state.clone(), Role::Media);
        let api_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        Self {
            origin,
            store,
            client,
            api,
            state,
            origin_task,
            api_task,
        }
    }

    pub fn url(&self) -> String {
        format!("{}/v1/media/{}", self.api, self.origin.hash)
    }

    pub async fn request_range(&self, range: Range<usize>) -> reqwest::Response {
        self.client
            .get(self.url())
            .bearer_auth(TOKEN)
            .header("range", format!("bytes={}-{}", range.start, range.end - 1))
            .send()
            .await
            .unwrap()
    }

    pub async fn metrics(&self) -> Value {
        self.client
            .get(format!("{}/v1/metrics", self.api))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    pub async fn close(self) {
        self.origin.gate.close();
        self.api_task.abort();
        self.origin_task.abort();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self.api_task.is_finished() || !self.origin_task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("缓存夹具服务退出超时");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.origin.gate.close();
        self.api_task.abort();
        self.origin_task.abort();
    }
}

pub async fn read_store(
    store: MediaStore,
    hash: String,
    size: u64,
    range: Range<u64>,
) -> std::io::Result<Vec<u8>> {
    let mut source = store.published_stream(&hash, size, range).await?;
    let mut bytes = Vec::new();
    while let Some(part) = source.next().await {
        bytes.extend_from_slice(&part?);
    }
    Ok(bytes)
}

pub async fn wait_until(condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("缓存夹具条件等待超时");
}
