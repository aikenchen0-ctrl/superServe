use std::sync::Arc;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, HeaderValue, Request, StatusCode},
};
use futures_util::StreamExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_service::{
    AppState, Role,
    delivery::{ClientReport, parse_client_report},
    router,
};
use vs_storage::MediaStore;

const TOKEN: &str = "delivery-contract-only-token-000000000000";

fn parsed(input: &str) -> ClientReport {
    let mut headers = HeaderMap::new();
    headers.insert("cmcd-session", HeaderValue::from_str(input).unwrap());
    parse_client_report(&headers, None)
}

#[test]
fn structured_fields_preserve_quotes_escapes_duplicates_and_typed_values() {
    let report = parsed(
        r#"sid="a,b=\"c",cid="clip",vs-rid="feed-1",bl=200,bl=900,mtp=8000,d=2000,br=300,ot=v,su,bs=?0"#,
    );
    let ClientReport::Accepted(data) = report else {
        panic!("结构化报告未解析");
    };
    assert_eq!(
        data.session_sha256,
        Some(format!("{:x}", Sha256::digest(b"a,b=\"c")))
    );
    assert_eq!(data.content_id.as_deref(), Some("clip"));
    assert_eq!(data.recommendation_request_id.as_deref(), Some("feed-1"));
    assert_eq!(data.buffer_ms, Some(900));
    assert_eq!(data.measured_kbps, Some(8000));
    assert_eq!(data.duration_ms, Some(2000));
    assert_eq!(data.encoded_kbps, Some(300));
    assert_eq!(data.object_type, Some("v"));
    assert_eq!(data.startup, Some(true));
    assert_eq!(data.buffer_starved, Some(false));
    assert!(matches!(
        parsed(r#"bl="bad",bl=400"#),
        ClientReport::Accepted(_)
    ));
    assert!(matches!(
        parsed(r#"bl=400,bl="bad""#),
        ClientReport::Invalid
    ));
    assert!(matches!(parsed("bl=(),bl=400"), ClientReport::Accepted(_)));
    assert!(matches!(
        parsed("unknown=(1 2);foo,bl=400"),
        ClientReport::Accepted(_)
    ));
}

#[test]
fn invalid_and_future_reports_are_bounded_and_not_misinterpreted() {
    for input in [
        "bl=-1",
        "bl=1.5",
        "bl=86400001",
        "ot=unknown",
        "sid=token",
        r#"cid="../secret""#,
        r#"vs-rid="feed/1""#,
        "v",
        "bl=1,",
        "x=@100",
    ] {
        assert!(matches!(parsed(input), ClientReport::Invalid), "{input}");
    }
    assert!(matches!(
        parsed(&format!("x=\"{}\"", "a".repeat(4096))),
        ClientReport::Invalid
    ));
    assert!(matches!(
        parsed("v=2,bl=(1000;v)"),
        ClientReport::UnsupportedVersion
    ));
    assert!(matches!(
        parse_client_report(&HeaderMap::new(), None),
        ClientReport::Absent
    ));
}

#[test]
fn query_mode_decodes_once_and_headers_always_take_precedence() {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("CMCD", r#"sid="session",cid="clip",bl=400"#)
        .finish();
    let ClientReport::Accepted(data) = parse_client_report(&HeaderMap::new(), Some(&query)) else {
        panic!("查询报告未解析");
    };
    assert_eq!(data.buffer_ms, Some(400));
    assert!(matches!(
        parse_client_report(&HeaderMap::new(), Some("CMCD=bl%3D1&CMCD=bl%3D2")),
        ClientReport::Invalid
    ));
    let mut headers = HeaderMap::new();
    headers.insert("cmcd-request", HeaderValue::from_static("bl=700"));
    headers.append("cmcd-request", HeaderValue::from_static("bl=800"));
    let ClientReport::Accepted(data) = parse_client_report(&headers, Some(&query)) else {
        panic!("请求头报告未解析");
    };
    assert_eq!(data.buffer_ms, Some(800));
    assert!(data.content_id.is_none());
    headers.insert("cmcd-request", HeaderValue::from_static("bl=\"wrong\""));
    assert!(matches!(
        parse_client_report(&headers, Some(&query)),
        ClientReport::Invalid
    ));
}

struct Fixture {
    _directory: tempfile::TempDir,
    app: Router,
    path: String,
    bytes: usize,
}

impl Fixture {
    fn new(enabled: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data: Vec<_> = (0..262_144).map(|value| (value % 251) as u8).collect();
        let hash = format!("{:x}", Sha256::digest(&data));
        std::fs::create_dir(directory.path().join("media")).unwrap();
        std::fs::write(directory.path().join("media").join(&hash), &data).unwrap();
        let catalog = serde_json::to_vec(&serde_json::json!({
            "version":"delivery-v1","items":[],
            "assets":[{"sha256":hash,"bytes":data.len(),"content_type":"video/mp4"}]
        }))
        .unwrap();
        let store = MediaStore::filesystem(directory.path().to_str().unwrap()).unwrap();
        let state = AppState::new(&catalog, Some(store), TOKEN, 1, 1).unwrap();
        let state = if enabled {
            state.with_delivery_observation()
        } else {
            state
        };
        Self {
            _directory: directory,
            app: router(Arc::new(state), Role::All),
            path: format!("/v1/media/{hash}"),
            bytes: data.len(),
        }
    }

    fn request(&self, method: &str, extra: &[(&str, &str)]) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(&self.path)
            .header("authorization", format!("Bearer {TOKEN}"));
        for (name, value) in extra {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).unwrap()
    }

    async fn metrics(&self) -> Value {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/metrics")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap()
    }
}

#[tokio::test]
async fn full_final_chunk_and_unpolled_or_partial_body_have_distinct_outcomes() {
    let f = Fixture::new(true);
    let response = f
        .app
        .clone()
        .oneshot(f.request("GET", &[("range", "bytes=0-31")]))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    let mut body = response.into_body().into_data_stream();
    assert_eq!(body.next().await.unwrap().unwrap().len(), 32);
    drop(body);
    let response = f.app.clone().oneshot(f.request("GET", &[])).await.unwrap();
    drop(response);
    let response = f.app.clone().oneshot(f.request("GET", &[])).await.unwrap();
    let mut body = response.into_body().into_data_stream();
    let yielded = body.next().await.unwrap().unwrap().len();
    assert!(yielded > 0 && yielded < f.bytes);
    drop(body);
    let metrics = f.metrics().await;
    assert_eq!(metrics["delivery"]["requests"], 3);
    assert_eq!(metrics["delivery"]["completed_bodies"], 1);
    assert_eq!(metrics["delivery"]["dropped_bodies"], 2);
    assert_eq!(metrics["delivery"]["active_bodies"], 0);
    assert_eq!(metrics["delivery"]["yielded_bytes"], 32 + yielded);
    assert_eq!(metrics["media_slots_available"], 1);
}

#[tokio::test]
async fn optional_client_data_cannot_change_delivery_auth_or_bodyless_semantics() {
    let f = Fixture::new(true);
    let unauthorized = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&f.path)
                .header("cmcd-session", "v=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(f.metrics().await["delivery"]["requests"], 0);
    for input in ["bl=1000,su", "bl=\"bad\"", "v=2,bl=(1000;v)"] {
        let response = f
            .app
            .clone()
            .oneshot(f.request("GET", &[("cmcd-request", input), ("range", "bytes=0-0")]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(to_bytes(response.into_body(), 1).await.unwrap().len(), 1);
    }
    for (method, headers, expected) in [
        ("HEAD", vec![], StatusCode::OK),
        (
            "GET",
            vec![("if-none-match", "*")],
            StatusCode::NOT_MODIFIED,
        ),
        (
            "GET",
            vec![("range", "bytes=999999-")],
            StatusCode::RANGE_NOT_SATISFIABLE,
        ),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(f.request(method, &headers))
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        drop(response);
    }
    let metrics = f.metrics().await;
    assert_eq!(metrics["delivery"]["valid_reports"], 1);
    assert_eq!(metrics["delivery"]["invalid_reports"], 1);
    assert_eq!(metrics["delivery"]["unsupported_reports"], 1);
    assert_eq!(metrics["delivery"]["completed_bodies"], 3);
    assert_eq!(metrics["delivery"]["non_media_responses"], 3);
    assert_eq!(metrics["delivery"]["yielded_bytes"], 3);
    assert_eq!(metrics["media_slots_available"], 1);
}

#[tokio::test]
async fn observation_is_disabled_by_default() {
    let f = Fixture::new(false);
    let response = f
        .app
        .clone()
        .oneshot(f.request(
            "GET",
            &[("cmcd-request", "bl=\"bad\""), ("range", "bytes=0-0")],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(to_bytes(response.into_body(), 1).await.unwrap().len(), 1);
    assert!(f.metrics().await["delivery"].is_null());
}

#[tokio::test]
async fn trace_context_is_observation_only_and_does_not_authorize_media() {
    let f = Fixture::new(true);
    let response = f
        .app
        .clone()
        .oneshot(f.request(
            "GET",
            &[
                (
                    "traceparent",
                    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                ),
                ("tracestate", "vendor=value"),
                ("range", "bytes=0-0"),
            ],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(to_bytes(response.into_body(), 1).await.unwrap().len(), 1);

    let unauthorized = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&f.path)
                .header(
                    "traceparent",
                    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(f.metrics().await["delivery"]["requests"], 1);
}
