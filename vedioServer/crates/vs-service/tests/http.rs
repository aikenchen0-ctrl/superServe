use std::sync::Arc;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;
use vs_service::{AppState, Role, router};
use vs_storage::MediaStore;

const TOKEN: &str = "test-only-service-token-0000000000000000";

struct Fixture {
    _dir: TempDir,
    state: Arc<AppState>,
    catalog: Vec<u8>,
    bytes: Vec<u8>,
    path: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..256 * 1024).map(|i| (i % 251) as u8).collect();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        std::fs::create_dir(dir.path().join("media")).unwrap();
        std::fs::write(dir.path().join("media").join(&hash), &bytes).unwrap();
        let catalog = serde_json::to_vec(&json!({
            "version": "test-v1",
            "items": [
                {"id": "video", "domain": "video", "tags": ["rust"], "prior": 0.8, "media_sha256": hash},
                {"id": "article", "domain": "article", "tags": ["storage"], "prior": 0.9, "media_sha256": null}
            ],
            "assets": [{"sha256": hash, "bytes": bytes.len(), "content_type": "video/mp4"}]
        })).unwrap();
        let store = MediaStore::filesystem(dir.path().to_str().unwrap()).unwrap();
        let state = Arc::new(AppState::new(&catalog, Some(store), TOKEN, 2, 1).unwrap());
        Self {
            _dir: dir,
            state,
            catalog,
            bytes,
            path: format!("/v1/media/{hash}"),
        }
    }

    fn app(&self) -> Router {
        router(self.state.clone(), Role::All)
    }

    fn get(&self, method: &str, headers: &[(&str, &str)]) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(&self.path)
            .header("authorization", format!("Bearer {TOKEN}"));
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).unwrap()
    }
}

fn post_request(body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/recommendations")
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn post_request_with_trace(body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/recommendations")
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json")
        .header(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn post_json(path: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

#[tokio::test]
async fn service_auth_and_role_boundaries() {
    let f = Fixture::new();
    let response = f
        .app()
        .oneshot(Request::builder().uri(&f.path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let response = router(f.state.clone(), Role::Api)
        .oneshot(f.get("GET", &[]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = f
        .app()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = f
        .app()
        .oneshot(
            Request::builder()
                .uri("/v1/metrics")
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let metrics: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert!(metrics["storage_http"].is_null());
    assert_eq!(metrics["storage_read_mode"], "chunk-64k");
}

#[tokio::test]
async fn single_ranges_return_only_requested_bytes() {
    let f = Fixture::new();
    let len = f.bytes.len();
    for (header, start, end) in [
        ("bytes=0-0".to_string(), 0, 1),
        ("bytes=3-17".to_string(), 3, 18),
        ("bytes=-19".to_string(), len - 19, len),
        (format!("bytes={}-", len - 7), len - 7, len),
        ("bytes=0-999999999".to_string(), 0, len),
    ] {
        let response = f
            .app()
            .oneshot(f.get("GET", &[("range", &header)]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()["content-length"],
            (end - start).to_string()
        );
        let body = to_bytes(response.into_body(), len + 1).await.unwrap();
        assert_eq!(&body[..], &f.bytes[start..end]);
    }
}

#[tokio::test]
async fn unsatisfiable_and_multi_ranges_do_not_return_full_media() {
    let f = Fixture::new();
    for range in [
        "bytes=999999999-",
        "bytes=5-2",
        "bytes=0-1,4-5",
        "bytes=-0",
        "bytes=x-y",
    ] {
        let response = f
            .app()
            .oneshot(f.get("GET", &[("range", range)]))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::RANGE_NOT_SATISFIABLE,
            "{range}"
        );
        assert_eq!(
            response.headers()["content-range"],
            format!("bytes */{}", f.bytes.len())
        );
        assert!(to_bytes(response.into_body(), 1).await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn head_cache_validator_and_if_range_follow_http_semantics() {
    let f = Fixture::new();
    let response = f
        .app()
        .oneshot(f.get("HEAD", &[("range", "bytes=1-9")]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-length"],
        f.bytes.len().to_string()
    );
    let etag = response.headers()["etag"].to_str().unwrap().to_string();
    assert!(to_bytes(response.into_body(), 1).await.unwrap().is_empty());
    assert_eq!(f.state.media_slots.available_permits(), 1);
    let response = f
        .app()
        .oneshot(f.get("GET", &[("if-none-match", &format!("\"other\", W/{etag}"))]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    let response = f
        .app()
        .oneshot(f.get("GET", &[("range", "bytes=1-9"), ("if-range", "\"stale\"")]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        &to_bytes(response.into_body(), f.bytes.len()).await.unwrap()[..],
        f.bytes.as_slice()
    );
}

#[tokio::test]
async fn permit_lives_with_body_and_returns_on_cancellation() {
    let f = Fixture::new();
    let response = f.app().oneshot(f.get("GET", &[])).await.unwrap();
    assert_eq!(f.state.media_slots.available_permits(), 0);
    let overloaded = f.app().oneshot(f.get("GET", &[])).await.unwrap();
    assert_eq!(overloaded.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(overloaded.headers()["retry-after"], "1");
    drop(response);
    assert_eq!(f.state.media_slots.available_permits(), 1);
    let resumed = f
        .app()
        .oneshot(f.get("GET", &[("range", "bytes=1-3")]))
        .await
        .unwrap();
    assert_eq!(resumed.status(), StatusCode::PARTIAL_CONTENT);
}

#[tokio::test]
async fn unknown_or_missing_published_objects_fail_closed() {
    let f = Fixture::new();
    let request = Request::builder()
        .uri(format!("/v1/media/{}", "0".repeat(64)))
        .header("authorization", format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        f.app().oneshot(request).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let file = f
        ._dir
        .path()
        .join("media")
        .join(f.path.rsplit('/').next().unwrap());
    std::fs::write(file, b"truncated").unwrap();
    assert_eq!(
        f.app().oneshot(f.get("GET", &[])).await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn independent_instances_share_catalog_not_personal_request_state() {
    let f = Fixture::new();
    let other = router(
        Arc::new(AppState::new(&f.catalog, None, TOKEN, 2, 1).unwrap()),
        Role::Api,
    );
    let base = json!({"request_id": "multi-node", "domains": ["video", "article"], "limit": 2, "profile": null});
    let a = f.app().oneshot(post_request(base.clone())).await.unwrap();
    let b = other.oneshot(post_request(base.clone())).await.unwrap();
    assert_eq!(
        a.headers()["x-catalog-sha256"],
        b.headers()["x-catalog-sha256"]
    );
    assert_eq!(a.headers()["cache-control"], "no-store");
    let a = to_bytes(a.into_body(), 16_384).await.unwrap();
    let b = to_bytes(b.into_body(), 16_384).await.unwrap();
    assert_eq!(a, b);

    let mut personalized = base.clone();
    personalized["profile"] = json!({
        "subject": "a", "version": "p1", "scopes": ["video", "article"], "expires_at": 4102444800_u64,
        "interests": [{"tag": "rust", "weight": 1.0}], "blocked_ids": [], "denied_tags": []
    });
    let response = f
        .app()
        .oneshot(post_request(personalized.clone()))
        .await
        .unwrap();
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await.unwrap()).unwrap();
    assert_eq!(body["items"][0]["id"], "video");
    personalized["profile"]["expires_at"] = json!(0);
    assert_eq!(
        f.app()
            .oneshot(post_request(personalized))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let again = f.app().oneshot(post_request(base)).await.unwrap();
    assert_eq!(a, to_bytes(again.into_body(), 16_384).await.unwrap());
}

#[tokio::test]
async fn oversized_requests_are_rejected_before_ranking() {
    let f = Fixture::new();
    let body = json!({"request_id": "x".repeat(70_000), "domains": ["video"], "limit": 1, "profile": null});
    let response = f.app().oneshot(post_request(body)).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn recommendation_returns_trace_id_for_media_observation_only() {
    let f = Fixture::new();
    let response = f
        .app()
        .oneshot(post_request_with_trace(json!({
            "request_id": "trace-response",
            "domains": ["video"],
            "limit": 1,
            "profile": null
        })))
        .await
        .unwrap();
    assert_eq!(
        response.headers().get("x-vs-trace-id").unwrap(),
        "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    assert!(!response.headers().contains_key("traceparent"));
    assert!(!response.headers().contains_key("tracestate"));
}

#[tokio::test]
async fn profile_events_feed_and_hide_form_a_minimal_loop() {
    let f = Fixture::new();
    let event = json!({
        "event_id": "event-1",
        "subject": "user-a",
        "candidate_id": "video",
        "kind": "like"
    });
    let response = f
        .app()
        .oneshot(post_json("/v1/profile/events", event.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let first: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(first["accepted"], true);
    assert_eq!(first["profile_version"], "memory-1");

    let response = f
        .app()
        .oneshot(post_json("/v1/profile/events", event))
        .await
        .unwrap();
    let duplicate: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(duplicate["accepted"], false);
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["profile_version"], "memory-1");

    let feed = json!({
        "request_id": "feed-1",
        "subject": "user-a",
        "domains": ["video", "article"],
        "limit": 2
    });
    let response = f.app().oneshot(post_json("/v1/feed", feed)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let personalized: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await.unwrap()).unwrap();
    assert_eq!(personalized["profile_version"], "memory-1");
    assert_eq!(personalized["items"][0]["id"], "video");

    let hide = json!({
        "event_id": "event-2",
        "subject": "user-a",
        "candidate_id": "video",
        "kind": "hide"
    });
    let response = f
        .app()
        .oneshot(post_json("/v1/profile/events", hide))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = f
        .app()
        .oneshot(post_json(
            "/v1/feed",
            json!({
                "request_id": "feed-2",
                "subject": "user-a",
                "domains": ["video", "article"],
                "limit": 2
            }),
        ))
        .await
        .unwrap();
    let hidden: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await.unwrap()).unwrap();
    assert_eq!(hidden["profile_version"], "memory-2");
    assert_eq!(hidden["items"][0]["id"], "article");

    let response = f
        .app()
        .oneshot(
            Request::builder()
                .uri("/v1/metrics")
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let metrics: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(metrics["profile_subjects"], 1);
    assert_eq!(metrics["profile_events"], 2);
    assert_eq!(metrics["duplicate_profile_events"], 1);
}

#[tokio::test]
async fn profile_log_rebuilds_feed_after_state_restart() {
    let f = Fixture::new();
    let log_path = f._dir.path().join("profile").join("events.jsonl");
    let first_state = Arc::new(
        AppState::new_with_profile_log(&f.catalog, None, TOKEN, 2, 1, Some(&log_path)).unwrap(),
    );
    let response = router(first_state, Role::Api)
        .oneshot(post_json(
            "/v1/profile/events",
            json!({
                "event_id": "restart-event-1",
                "subject": "restart-user",
                "candidate_id": "video",
                "kind": "like"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);

    let restarted_state = Arc::new(
        AppState::new_with_profile_log(&f.catalog, None, TOKEN, 2, 1, Some(&log_path)).unwrap(),
    );
    let response = router(restarted_state, Role::Api)
        .oneshot(post_json(
            "/v1/feed",
            json!({
                "request_id": "restart-feed-1",
                "subject": "restart-user",
                "domains": ["video"],
                "limit": 1
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await.unwrap()).unwrap();
    assert_eq!(body["profile_version"], "memory-1");
    assert_eq!(body["items"][0]["id"], "video");
}
