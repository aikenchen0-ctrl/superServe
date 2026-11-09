use std::{
    env, io,
    net::{Ipv4Addr, SocketAddrV4},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{DefaultBodyLimit, Path as RoutePath, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use tokio::net::TcpListener;
use tower::ServiceExt;
use vs_core::learning::TrainingDataKind;
use vs_service::consumption::{ClientPlatform, ConsumptionBatch, normalize_consumption};
use vs_service::{
    AppState, Role,
    hls::{HlsLayout, publish_hls_with_layout},
    publication::load_catalog_release,
    router,
};
use vs_storage::MediaStore;

#[path = "support/cache_probe.rs"]
mod cache_probe;
#[path = "support/consumption_gateway.rs"]
mod consumption_gateway;
#[path = "support/live_proxy.rs"]
mod live_proxy;

#[derive(Clone)]
struct Lab {
    internal: Router,
    authorization: HeaderValue,
    origin: String,
    media_path: String,
    live: Option<live_proxy::LiveProxy>,
    web_control: Option<Arc<WebControl>>,
    cache_probe: Option<Arc<cache_probe::CacheProbe>>,
    worker_asset: Arc<WorkerAssetMetrics>,
    embedded_worker: bool,
    consumption: Option<Arc<consumption_gateway::ConsumptionGateway>>,
}

#[derive(Default)]
struct WorkerAssetMetrics {
    responses: AtomicU64,
    yielded_bytes: AtomicU64,
}

fn embedded_worker_mode(value: &str) -> io::Result<bool> {
    match value {
        "external" => Ok(false),
        "embedded" => Ok(true),
        _ => Err(io::Error::other("播放工作器模式仅支持external或embedded")),
    }
}

struct WebControl {
    javascript: Bytes,
    wasm: Bytes,
    wasm_sha256: String,
}

impl WebControl {
    fn load(directory: &Path) -> io::Result<Self> {
        use io::Read;
        use sha2::{Digest, Sha256};
        fn read(path: &Path, limit: u64) -> io::Result<Bytes> {
            let mut data = Vec::new();
            std::fs::File::open(path)?
                .take(limit + 1)
                .read_to_end(&mut data)?;
            if data.is_empty() || data.len() as u64 > limit {
                return Err(io::Error::other("Web控制资源为空或超过预算"));
            }
            Ok(data.into())
        }
        let javascript = read(&directory.join("playback.js"), 128 * 1024)?;
        let wasm = read(&directory.join("playback_bg.wasm"), 512 * 1024)?;
        if !wasm.starts_with(b"\0asm\x01\0\0\0") {
            return Err(io::Error::other("Web控制资源不是有效的Wasm文件头"));
        }
        Ok(Self {
            wasm_sha256: format!("{:x}", Sha256::digest(&wasm)),
            javascript,
            wasm,
        })
    }
}

fn asset(content_type: &'static str, bytes: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}

async fn boundary(State(lab): State<Lab>, request: Request, next: Next) -> Response {
    let expected_host = lab.origin.trim_start_matches("http://");
    let headers = request.headers();
    let invalid_origin = headers
        .get(header::ORIGIN)
        .is_some_and(|value| value.as_bytes() != lab.origin.as_bytes());
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(expected_host)
        || invalid_origin
        || headers
            .get("sec-fetch-site")
            .is_some_and(|value| value == "cross-site")
    {
        return (StatusCode::FORBIDDEN, "只允许本机同源访问").into_response();
    }
    let csp = if lab.web_control.is_some() {
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
         media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; \
         object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    } else {
        "default-src 'self'; script-src 'self'; style-src 'self'; \
         media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; \
         object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    };
    let mut response = next.run(request).await;
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cross-origin-resource-policy", "same-origin"),
        ("content-security-policy", csp),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

async fn policy(State(lab): State<Lab>) -> Response {
    let request = Request::builder()
        .uri("/v1/playback/policy")
        .header(header::AUTHORIZATION, lab.authorization)
        .body(Body::empty())
        .unwrap();
    lab.internal.oneshot(request).await.unwrap()
}

async fn web_script(State(lab): State<Lab>) -> Response {
    match lab.web_control {
        Some(control) => (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            control.javascript.clone(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Rust时间控制尚未启用").into_response(),
    }
}

async fn web_wasm(State(lab): State<Lab>) -> Response {
    match lab.web_control {
        Some(control) => (
            [(header::CONTENT_TYPE, "application/wasm")],
            control.wasm.clone(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Rust时间控制尚未启用").into_response(),
    }
}

async fn media(State(lab): State<Lab>, mut request: Request) -> Response {
    // 只分派既有媒体路由；业务接口与内部令牌不进入浏览器的路由空间。
    // 内外路由各自解析参数，避免外层路径参数污染内部提取器。
    request.extensions_mut().clear();
    request
        .headers_mut()
        .insert(header::AUTHORIZATION, lab.authorization);
    lab.internal.oneshot(request).await.unwrap()
}

async fn metrics(State(lab): State<Lab>) -> Response {
    let request = Request::builder()
        .uri("/v1/metrics")
        .header(header::AUTHORIZATION, lab.authorization)
        .body(Body::empty())
        .unwrap();
    let response = lab.internal.oneshot(request).await.unwrap();
    let bytes = match to_bytes(response.into_body(), 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["live_proxy"] = lab.live.as_ref().map(|proxy| proxy.metrics()).into();
    value["worker_script"] = json!({
        "responses": lab.worker_asset.responses.load(Ordering::Relaxed),
        "yielded_body_bytes": lab.worker_asset.yielded_bytes.load(Ordering::Relaxed),
        "scope": "静态工作器GET响应产出，不是客户端线路字节或下载完成证明",
    });
    Json(value).into_response()
}

async fn playback_grant(State(lab): State<Lab>) -> Response {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // 本机实验只为固定测试主体和素材签发；此适配不冒充生产用户登录。
    let profile = json!({
            "subject": "local-lab-viewer", "version": "browser-lab-v1",
            "scopes": ["video"], "expires_at": at + 120,
            "interests": [], "blocked_ids": [], "denied_tags": []
    });
    let mut nonce = [0; 16];
    use ring::rand::SecureRandom;
    if ring::rand::SystemRandom::new().fill(&mut nonce).is_err() {
        return (StatusCode::SERVICE_UNAVAILABLE, "实验推荐请求标识生成失败").into_response();
    }
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let request = Request::builder()
        .method(Method::POST)
        .uri("/v1/recommendations")
        .header(header::AUTHORIZATION, lab.authorization.clone())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "request_id": URL_SAFE_NO_PAD.encode(nonce),
                "domains": ["video"], "limit": 1, "profile": profile,
            })
            .to_string(),
        ))
        .unwrap();
    let recommended = lab.internal.clone().oneshot(request).await.unwrap();
    if !recommended.status().is_success() {
        return recommended;
    }
    let Some(receipt) = recommended
        .headers()
        .get("x-playback-decision-receipt")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
    else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "推荐没有生成可验证播放收据",
        )
            .into_response();
    };
    let Ok(bytes) = to_bytes(recommended.into_body(), 64 * 1024).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(result) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if result["items"][0]["id"] != "clip" {
        return (StatusCode::CONFLICT, "实验返回候选与固定素材不匹配").into_response();
    }
    let payload = json!({
        "candidate_id": "clip", "ttl_seconds": 120, "profile": profile,
        "decision_receipt": receipt,
    });
    let request = Request::builder()
        .method(Method::POST)
        .uri("/internal/v1/playback/grants")
        .header(header::AUTHORIZATION, lab.authorization)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap();
    let response = lab.internal.oneshot(request).await.unwrap();
    if !response.status().is_success() || lab.consumption.is_none() {
        return response;
    }
    let bytes = match to_bytes(response.into_body(), 8192).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let grant: vs_service::playback_access::PlaybackGrantResponse =
        match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
    if lab
        .consumption
        .as_ref()
        .unwrap()
        .register(&grant, at)
        .is_err()
    {
        return (StatusCode::SERVICE_UNAVAILABLE, "实验消费实例绑定失败").into_response();
    }
    let mut grant = serde_json::to_value(grant).unwrap();
    grant["consumption_generation"] = json!(1);
    Json(grant).into_response()
}

async fn consumption(State(lab): State<Lab>, Json(batch): Json<ConsumptionBatch>) -> Response {
    if batch.platform != ClientPlatform::Web
        || batch.data_kind != TrainingDataKind::Synthetic
        || batch.subject != "local-lab-viewer"
        || batch.source_id != "playback-lab"
    {
        return (StatusCode::BAD_REQUEST, "实验只接受固定Web合成来源").into_response();
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_secs());
    if let Some(gateway) = lab.consumption {
        return gateway.submit(batch, at).await;
    }
    match normalize_consumption(&batch, at) {
        Ok(result) => Json(json!({
            "schema": "playback-lab-consumption-v1",
            "summary": result.summary,
            "learning_events": result.learning.events.len(),
            "persisted": false,
        }))
        .into_response(),
        Err(reason) => (StatusCode::BAD_REQUEST, reason).into_response(),
    }
}

async fn live_media(
    State(lab): State<Lab>,
    RoutePath(filename): RoutePath<String>,
    method: Method,
) -> Response {
    match lab.live {
        Some(proxy) => proxy.get(&filename, method).await,
        None => (StatusCode::NOT_FOUND, "直播实验尚未启用").into_response(),
    }
}

fn lab_router(lab: Lab) -> Router {
    Router::new()
        .route("/favicon.ico", get(|| async { StatusCode::NO_CONTENT }))
        .route(
            "/",
            get(|| async {
                asset(
                    "text/html; charset=utf-8",
                    include_bytes!("../../../labs/playback/index.html"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("../../../labs/playback/app.js"),
                )
            }),
        )
        .route(
            "/app.css",
            get(|| async {
                asset(
                    "text/css; charset=utf-8",
                    include_bytes!("../../../labs/playback/app.css"),
                )
            }),
        )
        .route(
            "/vendor/hls.min.js",
            get(|| async {
                asset(
                    "text/javascript",
                    include_bytes!("../../../labs/playback/vendor/hls.min.js"),
                )
            }),
        )
        .route(
            "/vendor/hls.worker.js",
            get(|State(lab): State<Lab>, method: Method| async move {
                let bytes = include_bytes!("../../../labs/playback/vendor/hls.worker.js");
                if method == Method::GET {
                    lab.worker_asset.responses.fetch_add(1, Ordering::Relaxed);
                    lab.worker_asset
                        .yielded_bytes
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                }
                asset("text/javascript", bytes)
            }),
        )
        .route(
            "/lab/config",
            get(|State(lab): State<Lab>| async move {
                Json(json!({
                    "schema": "browser-playback-lab-v1",
                    "media_path": lab.media_path,
                    "mode": "vod",
                    "live_media_path": lab.live.as_ref().map(|_| "/live/lab/lab.m3u8"),
                    "hls_version": "1.7.4",
                    "worker_mode": if lab.embedded_worker { "embedded" } else { "external" },
                    "consumption_persistence": lab.consumption.is_some(),
                    "rust_time_control": lab.web_control.as_ref().map(|control| json!({
                        "wasm_sha256": control.wasm_sha256,
                        "wasm_bytes": control.wasm.len(),
                        "javascript_bytes": control.javascript.len(),
                    }))
                }))
            }),
        )
        .route("/lab/metrics", get(metrics))
        .route("/lab/policy", get(policy))
        .route(
            "/lab/cache-origin",
            get(|State(lab): State<Lab>| async move {
                cache_probe::metrics(State(lab.cache_probe)).await
            }),
        )
        .route(
            "/lab/cache-origin/release",
            post(|State(lab): State<Lab>| async move {
                cache_probe::release(State(lab.cache_probe)).await
            }),
        )
        .route(
            "/lab/cache-probe",
            get(|State(lab): State<Lab>| async move {
                if lab.cache_probe.is_none() {
                    return StatusCode::NOT_FOUND.into_response();
                }
                asset(
                    "text/html; charset=utf-8",
                    include_bytes!("../../../labs/playback/cache-probe.html"),
                )
            }),
        )
        .route(
            "/lab/cache-probe.js",
            get(|| async {
                asset(
                    "text/javascript; charset=utf-8",
                    include_bytes!("../../../labs/playback/cache-probe.js"),
                )
            }),
        )
        .route("/lab/playback", post(playback_grant))
        .route("/control/playback.js", get(web_script))
        .route("/control/playback_bg.wasm", get(web_wasm))
        .route(
            "/lab/consumption",
            post(consumption).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/live/lab/{filename}", get(live_media))
        .route("/v1/playback/{token}/{sha256}/{filename}", get(media))
        .route("/v1/media/{sha256}", get(media))
        .route("/v1/media/{sha256}/{filename}", get(media))
        .layer(middleware::from_fn_with_state(lab.clone(), boundary))
        .with_state(lab)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .with_ansi(false)
        .with_writer(io::stderr)
        .init();
    let args: Vec<_> = env::args_os().skip(1).collect();
    if !(3..=4).contains(&args.len()) {
        return Err(io::Error::other(
            "用法：playback_lab <发布目录> <源MP4> <本机端口，0为自动分配> [本机Xiu的HLS端口]",
        )
        .into());
    }
    let root = Path::new(&args[0]).canonicalize()?;
    let embedded_worker = match env::var("VS_LAB_WORKER_MODE") {
        Ok(value) => embedded_worker_mode(&value)?,
        Err(env::VarError::NotPresent) => false,
        Err(_) => return Err(io::Error::other("播放工作器模式编码无效").into()),
    };
    let layout = match env::var("VS_LAB_CHUNK_MS") {
        Ok(value) => HlsLayout::Chunked {
            target_ms: value
                .parse()
                .map_err(|_| io::Error::other("实验片内时长无效"))?,
        },
        Err(env::VarError::NotPresent) => HlsLayout::Single,
        Err(_) => return Err(io::Error::other("实验片内时长编码无效").into()),
    };
    let publication = publish_hls_with_layout(
        &root,
        Path::new(&args[1]),
        "browser-lab-v1",
        "clip",
        2,
        layout,
    )?;
    if env::var_os("VS_LAB_CACHE_PROBE").is_some() {
        let mut receipt = std::fs::File::create_new(root.join("packaging.json"))?;
        serde_json::to_writer_pretty(&mut receipt, &publication)?;
    }
    let catalog = load_catalog_release(&root, "browser-lab-v1")?;
    let cache_origin = match env::var("VS_LAB_CACHE_PROBE") {
        Ok(policy) => {
            let entry_bytes = env::var("VS_LAB_CACHE_ENTRY_BYTES")
                .unwrap_or_else(|_| "65536".into())
                .parse()?;
            Some(cache_probe::CacheProbe::start(&root, &publication, &policy, entry_bytes).await?)
        }
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err(io::Error::other("缓存起播实验策略编码无效").into()),
    };
    let store = match &cache_origin {
        Some(origin) => origin.probe.store.clone(),
        None => MediaStore::filesystem(
            root.to_str()
                .ok_or_else(|| io::Error::other("发布路径编码无效"))?,
        )?,
    };
    // 每次启动使用临时内部令牌，仅在进程内分派时注入。
    let token = format!(
        "playback-lab-{}-{}",
        std::process::id(),
        tempfile::Builder::new()
            .prefix("private-")
            .tempdir()?
            .path()
            .display()
    );
    // 临时目录可能包含空格，令牌只使用其SHA256。
    use sha2::{Digest, Sha256};
    let token = format!("{:x}", Sha256::digest(token.as_bytes()));
    let mut signing_key = [0; 32];
    use ring::rand::SecureRandom;
    ring::rand::SystemRandom::new()
        .fill(&mut signing_key)
        .map_err(|_| io::Error::other("本机签名密钥生成失败"))?;
    let app = AppState::new(&catalog, Some(store), &token, 2, 16)
        .map_err(io::Error::other)?
        .with_playback_access(&signing_key, "playback-lab")
        .map_err(io::Error::other)?
        .with_learning_journal(&root.join("decisions.jsonl"), "playback-lab")
        .map_err(io::Error::other)?
        .with_delivery_observation();
    let port: u16 = args[2]
        .to_str()
        .ok_or_else(|| io::Error::other("端口编码无效"))?
        .parse()?;
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let consumption = match env::var_os("VS_LAB_FEEDBACK_CONFIG") {
        Some(path) => Some(Arc::new(
            consumption_gateway::ConsumptionGateway::load(Path::new(&path), &catalog, &token)
                .await?,
        )),
        None => None,
    };
    let lab = Lab {
        internal: router(Arc::new(app), Role::All),
        authorization: HeaderValue::from_str(&format!("Bearer {token}"))?,
        origin: origin.clone(),
        media_path: publication.media_path,
        cache_probe: cache_origin.as_ref().map(|origin| origin.probe.clone()),
        worker_asset: Arc::default(),
        embedded_worker,
        consumption,
        web_control: env::var_os("VS_PLAYBACK_WASM_DIR")
            .map(|directory| WebControl::load(Path::new(&directory)).map(Arc::new))
            .transpose()?,
        live: args
            .get(3)
            .map(|port| -> Result<_, Box<dyn std::error::Error>> {
                let port: u16 = port
                    .to_str()
                    .ok_or_else(|| io::Error::other("直播端口编码无效"))?
                    .parse()?;
                if port == 0 {
                    return Err(io::Error::other("直播上游端口不能为0").into());
                }
                Ok(live_proxy::LiveProxy::new(port)?)
            })
            .transpose()?,
    };
    println!("本机播放实验入口：{origin}");
    axum::serve(listener, lab_router(lab))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use vs_service::hls::publish_hls;

    #[tokio::test]
    async fn browser_boundary_preserves_ranges_and_hides_internal_routes() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.mp4");
        std::fs::write(
            &input,
            include_bytes!("../tests/fixtures/mp4/h264-aac-tail.mp4"),
        )
        .unwrap();
        let publication =
            publish_hls(directory.path(), &input, "browser-lab-v1", "clip", 1).unwrap();
        let catalog = load_catalog_release(directory.path(), "browser-lab-v1").unwrap();
        let token = "browser-lab-test-token-00000000000000";
        let app = AppState::new(
            &catalog,
            Some(MediaStore::filesystem(directory.path().to_str().unwrap()).unwrap()),
            token,
            2,
            16,
        )
        .unwrap();
        let media = format!(
            "/v1/media/{}/media.mp4",
            publication.tracks[0].segments[0].sha256
        );
        let gateway = lab_router(Lab {
            internal: router(Arc::new(app), Role::Media),
            authorization: HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
            origin: "http://127.0.0.1:1234".into(),
            media_path: publication.media_path,
            live: None,
            web_control: None,
            cache_probe: None,
            worker_asset: Arc::default(),
            embedded_worker: false,
            consumption: None,
        });
        for (path, host, origin, status) in [
            ("/lab/config", "127.0.0.1:1234", None, StatusCode::OK),
            ("/lab/config", "evil.invalid", None, StatusCode::FORBIDDEN),
            (
                "/lab/config",
                "127.0.0.1:1234",
                Some("https://evil.invalid"),
                StatusCode::FORBIDDEN,
            ),
            ("/v1/metrics", "127.0.0.1:1234", None, StatusCode::NOT_FOUND),
            (
                "/control/playback_bg.wasm",
                "127.0.0.1:1234",
                None,
                StatusCode::NOT_FOUND,
            ),
            (
                "/lab/cache-probe",
                "127.0.0.1:1234",
                None,
                StatusCode::NOT_FOUND,
            ),
            (
                "/lab/cache-origin",
                "127.0.0.1:1234",
                None,
                StatusCode::NOT_FOUND,
            ),
            (
                "/v1/recommendations",
                "127.0.0.1:1234",
                None,
                StatusCode::NOT_FOUND,
            ),
            (
                media.as_str(),
                "127.0.0.1:1234",
                None,
                StatusCode::PARTIAL_CONTENT,
            ),
        ] {
            let mut request = Request::builder().uri(path).header(header::HOST, host);
            if let Some(origin) = origin {
                request = request.header(header::ORIGIN, origin);
            }
            if path == media {
                request = request.header(header::RANGE, "bytes=0-15");
            }
            let response = gateway
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status, "{path}");
            assert!(!response.headers().contains_key(header::AUTHORIZATION));
            let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            if path == media {
                assert_eq!(bytes.len(), 16);
            } else {
                assert!(!String::from_utf8_lossy(&bytes).contains(token));
            }
        }
        for method in [Method::HEAD, Method::GET] {
            let response = gateway
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method.clone())
                        .uri("/vendor/hls.worker.js")
                        .header(header::HOST, "127.0.0.1:1234")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let bytes = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
            if method == Method::GET {
                use sha2::{Digest, Sha256};
                assert_eq!(bytes.len(), 118366);
                assert_eq!(
                    format!("{:x}", Sha256::digest(&bytes)),
                    "8553e459962fdbb5813fc2d2cb45d171c7f9e91cfb82a3e44789e438e61aa743"
                );
            } else {
                assert!(bytes.is_empty());
            }
        }
        let response = gateway
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/lab/metrics")
                    .header(header::HOST, "127.0.0.1:1234")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let metrics: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(metrics["worker_script"]["responses"], 1);
        assert_eq!(metrics["worker_script"]["yielded_body_bytes"], 118366);
        let response = gateway
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/lab/consumption")
                    .header(header::HOST, "127.0.0.1:1234")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "schema":"client-consumption-v1","source_id":"playback-lab",
                            "data_kind":"synthetic","platform":"web","subject":"local-lab-viewer",
                            "decision_id":"a".repeat(64),"candidate_id":"clip",
                            "interaction_id":"legacy-instance","generation":1,
                            "events":[{"event_id":"legacy-progress","sequence":1,"elapsed_ms":1000,
                                "observed_at":1,"observation":{"kind":"progress",
                                    "transferred_bytes":100,"byte_scope":"web_xhr_body"}}]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(body["schema"], "playback-lab-consumption-v1");
        assert_eq!(body["persisted"], false);
        assert_eq!(body["summary"]["last_known_transferred_bytes"], 100);
        assert!(!embedded_worker_mode("external").unwrap());
        assert!(embedded_worker_mode("embedded").unwrap());
        for invalid in ["", "inline", "Embedded", "embedded "] {
            assert!(embedded_worker_mode(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn gated_real_media_origin_keeps_last_byte_and_cancellation_releases_probe_resources() {
        use futures_util::StreamExt;
        use std::time::Duration;
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.mp4");
        std::fs::write(
            &input,
            include_bytes!("../tests/fixtures/mp4/h264-aac-tail.mp4"),
        )
        .unwrap();
        let publication = publish_hls(directory.path(), &input, "probe-v1", "clip", 1).unwrap();
        let segment = &publication
            .tracks
            .iter()
            .find(|track| track.kind == "video")
            .unwrap()
            .segments[0];
        let expected = std::fs::read(directory.path().join("media").join(&segment.sha256)).unwrap();
        let origin = cache_probe::CacheProbe::start(
            directory.path(),
            &publication,
            "block-64k-stream",
            65536,
        )
        .await
        .unwrap();
        let mut body = origin
            .probe
            .store
            .published_stream(&segment.sha256, segment.bytes, 0..segment.bytes)
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(3), body.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first.len(), expected.len() - 1);
        assert_eq!(first.as_ref(), &expected[..expected.len() - 1]);
        assert_eq!(origin.probe.store.media_cache_metrics().unwrap().entries, 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), body.next())
                .await
                .is_err()
        );
        assert_eq!(origin.probe.metrics()["tail_waiters"], 1);
        origin.probe.release();
        assert_eq!(
            body.next().await.unwrap().unwrap().as_ref(),
            &expected[expected.len() - 1..]
        );
        assert!(body.next().await.is_none());
        assert_eq!(
            origin
                .probe
                .store
                .media_cache_metrics()
                .unwrap()
                .fills_completed,
            1
        );
        assert_eq!(origin.probe.metrics()["origin_active_bodies"], 0);
        assert_eq!(origin.probe.metrics()["tail_waiters"], 0);
        drop(body);
        let origin = cache_probe::CacheProbe::start(
            directory.path(),
            &publication,
            "block-64k-stream",
            65536,
        )
        .await
        .unwrap();
        let mut body = origin
            .probe
            .store
            .published_stream(&segment.sha256, segment.bytes, 0..segment.bytes)
            .await
            .unwrap();
        assert!(body.next().await.unwrap().is_ok());
        drop(body);
        assert_eq!(
            origin
                .probe
                .store
                .media_cache_metrics()
                .unwrap()
                .active_fills,
            0
        );
        assert_eq!(origin.probe.store.media_cache_metrics().unwrap().entries, 0);
        assert_eq!(
            origin.probe.store.http_metrics().unwrap().active_exchanges,
            0
        );
        assert!(
            cache_probe::CacheProbe::start(directory.path(), &publication, "unknown", 65536)
                .await
                .is_err()
        );
        assert!(
            cache_probe::CacheProbe::start(directory.path(), &publication, "direct", 1)
                .await
                .is_err()
        );
    }
}
