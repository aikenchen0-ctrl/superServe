use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path as RoutePath, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::stream;
use serde_json::json;
use tokio::{net::TcpListener, sync::Semaphore};
use vs_service::hls::HlsPublication;
use vs_storage::{MediaCacheConfig, MediaCachePolicy, MediaStore, S3Config};

pub struct CacheProbe {
    objects: HashMap<String, Bytes>,
    gated_hash: String,
    gate: Semaphore,
    released: AtomicBool,
    tail_waiters: AtomicU64,
    gets: AtomicU64,
    heads: AtomicU64,
    sent_bytes: AtomicU64,
    active_bodies: AtomicU64,
    pub store: MediaStore,
    policy: String,
    entry_bytes: usize,
}

struct BodyGuard(Arc<CacheProbe>);
impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.0.active_bodies.fetch_sub(1, Ordering::SeqCst);
    }
}

struct TailGuard(Arc<CacheProbe>);
impl Drop for TailGuard {
    fn drop(&mut self) {
        self.0.tail_waiters.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct ProbeOrigin {
    pub probe: Arc<CacheProbe>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ProbeOrigin {
    fn drop(&mut self) {
        self.probe.release();
        self.task.abort();
    }
}

impl CacheProbe {
    pub async fn start(
        root: &Path,
        publication: &HlsPublication,
        policy: &str,
        entry_bytes: usize,
    ) -> io::Result<ProbeOrigin> {
        if !matches!(entry_bytes, 65536 | 262144) {
            return Err(io::Error::other("缓存起播实验条目仅支持65536或262144字节"));
        }
        let parsed = match policy {
            "direct" => None,
            value => Some(
                value
                    .parse::<MediaCachePolicy>()
                    .map_err(io::Error::other)?,
            ),
        };
        let gated_hash = publication
            .tracks
            .iter()
            .find(|track| track.kind == "video")
            .and_then(|track| track.segments.first())
            .ok_or_else(|| io::Error::other("起播实验缺少首个视频分片"))?
            .sha256
            .clone();
        let mut objects = HashMap::new();
        let mut total = 0;
        // 只载入本次本机发布的内容寻址文件，实验源不接受任意路径或上传。
        for entry in std::fs::read_dir(root.join("media"))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.len() != 64
                || !name.bytes().all(|value| value.is_ascii_hexdigit())
                || !entry.file_type()?.is_file()
            {
                return Err(io::Error::other("起播实验对象文件无效"));
            }
            total += entry.metadata()?.len();
            if total > 64 * 1024 * 1024 {
                return Err(io::Error::other("起播实验对象总量超过64MiB"));
            }
            objects.insert(name, Bytes::from(std::fs::read(entry.path())?));
        }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let store = MediaStore::s3(S3Config {
            endpoint,
            region: "us-east-1".into(),
            bucket: "playback-probe".into(),
            access_key_id: "fixture-access".into(),
            secret_access_key: "fixture-secret".into(),
        })
        .map_err(io::Error::other)?;
        let store = if let Some(policy) = parsed {
            store.with_media_cache_policy(
                MediaCacheConfig {
                    max_entry_bytes: entry_bytes,
                    ..Default::default()
                },
                policy,
            )?
        } else {
            store
        };
        let probe = Arc::new(Self {
            objects,
            gated_hash,
            store,
            policy: policy.into(),
            entry_bytes,
            gate: Semaphore::new(0),
            released: AtomicBool::new(false),
            tail_waiters: AtomicU64::new(0),
            gets: AtomicU64::new(0),
            heads: AtomicU64::new(0),
            sent_bytes: AtomicU64::new(0),
            active_bodies: AtomicU64::new(0),
        });
        let app = Router::new()
            .route("/playback-probe/media/{hash}", get(object))
            .with_state(probe.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(ProbeOrigin { probe, task })
    }

    pub fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.gate.close();
    }

    pub fn metrics(&self) -> serde_json::Value {
        json!({
            "schema":"cache-playback-origin-v1",
            "policy":self.policy,"entry_bytes":self.entry_bytes,
            "gated_sha256":self.gated_hash,
            "gated_bytes":self.objects[&self.gated_hash].len(),
            "tail_released":self.released.load(Ordering::SeqCst),
            "tail_waiters":self.tail_waiters.load(Ordering::SeqCst),
            "origin_gets":self.gets.load(Ordering::SeqCst),
            "origin_heads":self.heads.load(Ordering::SeqCst),
            "origin_body_bytes":self.sent_bytes.load(Ordering::SeqCst),
            "origin_active_bodies":self.active_bodies.load(Ordering::SeqCst),
            "cache":self.store.media_cache_metrics(),"storage_http":self.store.http_metrics(),
            "scope":"同机内存HTTP对象夹具；AWS4头仅检查存在，不验证密码签名；没有真实S3或线路成本结论"
        })
    }
}

pub async fn metrics(State(probe): State<Option<Arc<CacheProbe>>>) -> Response {
    match probe {
        Some(probe) => Json(probe.metrics()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub async fn release(State(probe): State<Option<Arc<CacheProbe>>>) -> Response {
    match probe {
        Some(probe) => {
            probe.release();
            Json(probe.metrics()).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn object(
    State(probe): State<Arc<CacheProbe>>,
    RoutePath(hash): RoutePath<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    if !headers
        .get("authorization")
        .is_some_and(|value| value.as_bytes().starts_with(b"AWS4-HMAC-SHA256 "))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(bytes) = probe.objects.get(&hash).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let builder = Response::builder()
        .header("etag", format!("\"{hash}\""))
        .header("last-modified", "Fri, 06 Nov 2026 00:00:00 GMT");
    if method == Method::HEAD {
        probe.heads.fetch_add(1, Ordering::SeqCst);
        return builder
            .header("content-length", bytes.len())
            .body(Body::empty())
            .unwrap();
    }
    let range = match headers
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| http_range::HttpRange::parse(value, bytes.len() as u64).ok())
    {
        Some(ranges) if ranges.len() == 1 => ranges[0],
        _ => return StatusCode::RANGE_NOT_SATISFIABLE.into_response(),
    };
    probe.gets.fetch_add(1, Ordering::SeqCst);
    probe.active_bodies.fetch_add(1, Ordering::SeqCst);
    let start = range.start as usize;
    let end = start + range.length as usize;
    let object_bytes = bytes.len();
    let gated = hash == probe.gated_hash && end == bytes.len();
    let guard = BodyGuard(probe.clone());
    let body = stream::unfold(
        (start, probe, bytes, guard),
        move |(offset, probe, bytes, guard)| async move {
            if offset >= end {
                return None;
            }
            if gated && offset == end - 1 {
                probe.tail_waiters.fetch_add(1, Ordering::SeqCst);
                let tail = TailGuard(probe.clone());
                if let Ok(permit) = probe.gate.acquire().await {
                    permit.forget();
                }
                drop(tail);
            }
            let limit = if gated && offset < end - 1 {
                end - 1
            } else {
                end
            };
            let next = (offset + 16 * 1024).min(limit);
            let part = bytes.slice(offset..next);
            probe
                .sent_bytes
                .fetch_add(part.len() as u64, Ordering::SeqCst);
            Some((Ok::<_, io::Error>(part), (next, probe, bytes, guard)))
        },
    );
    builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-length", range.length)
        .header(
            "content-range",
            format!("bytes {start}-{}/{object_bytes}", end - 1),
        )
        .body(Body::from_stream(body))
        .unwrap()
}
