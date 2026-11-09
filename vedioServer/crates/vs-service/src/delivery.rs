// SPDX-License-Identifier: MIT
// 访问器流程改编自undef1nd/sfv的examples/priority.rs，
// 参考提交2ea1221def3ec81b6b18d62bbb15d081d0f74aea；版权见LICENSES/sfv-MIT.txt。
// 新增CMCD v1子集、资源限制与正文生命周期观测，不保存逐会话状态。

use std::{
    convert::Infallible,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, Method, header},
    middleware::Next,
    response::Response,
};
use futures_util::{StreamExt, stream};
use serde::Serialize;
use sfv::{
    BareItemFromInput, KeyRef, Parser, Version,
    visitor::{
        DictionaryVisitor, EntryVisitor, Ignored, InnerListVisitor, ItemVisitor, ParameterVisitor,
    },
};
use sha2::{Digest, Sha256};

use crate::{
    AppState,
    playback_access::{ClientLinkage, VerifiedPlaybackGrant},
};

const MAX_CMCD_BYTES: usize = 4096;

#[derive(Debug, Default, Clone, Serialize)]
pub struct ClientData {
    pub session_sha256: Option<String>,
    pub content_id: Option<String>,
    pub recommendation_request_id: Option<String>,
    pub buffer_ms: Option<u64>,
    pub measured_kbps: Option<u64>,
    pub duration_ms: Option<u64>,
    pub encoded_kbps: Option<u64>,
    pub object_type: Option<&'static str>,
    pub startup: Option<bool>,
    pub buffer_starved: Option<bool>,
    pub version: Option<u64>,
}

#[derive(Debug)]
pub enum ClientReport {
    Absent,
    Accepted(ClientData),
    Invalid,
    UnsupportedVersion,
}

#[derive(Default)]
struct Visitor {
    data: ClientData,
    invalid: u16,
}

impl<'de> DictionaryVisitor<'de> for Visitor {
    type Out = Self;
    type Error = Infallible;

    fn entry(&mut self, key: &'de KeyRef) -> Result<impl EntryVisitor<'de>, Self::Error> {
        Ok(match key.as_str() {
            "sid" => Some(Field(0, self)),
            "cid" => Some(Field(1, self)),
            "vs-rid" => Some(Field(2, self)),
            "bl" => Some(Field(3, self)),
            "mtp" => Some(Field(4, self)),
            "d" => Some(Field(5, self)),
            "br" => Some(Field(6, self)),
            "ot" => Some(Field(7, self)),
            "su" => Some(Field(8, self)),
            "bs" => Some(Field(9, self)),
            "v" => Some(Field(10, self)),
            _ => None,
        })
    }

    fn finish(self) -> Result<Self::Out, Self::Error> {
        Ok(self)
    }
}

struct Field<'a>(u8, &'a mut Visitor);

impl<'de> EntryVisitor<'de> for Field<'_> {
    type Error = Infallible;

    fn item(self) -> Result<impl ItemVisitor<'de>, Self::Error> {
        Ok(self)
    }

    fn inner_list(self) -> Result<impl InnerListVisitor<'de>, Self::Error> {
        self.1.invalid |= 1 << self.0;
        Ok(Ignored)
    }
}

fn integer(value: &BareItemFromInput<'_>, maximum: u64) -> Option<u64> {
    value
        .as_integer()
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value <= maximum)
}

fn identifier(value: &BareItemFromInput<'_>) -> Option<String> {
    value
        .as_string()
        .map(|value| value.as_str())
        .filter(|value| value.len() <= 64 && vs_core::valid_id(value))
        .map(str::to_string)
}

impl<'de> ItemVisitor<'de> for Field<'_> {
    type Out = ();
    type Error = Infallible;

    fn bare_item(
        self,
        value: BareItemFromInput<'de>,
    ) -> Result<impl ParameterVisitor<'de, Out = ()>, Self::Error> {
        let data = &mut self.1.data;
        // 结构化字段重复键取最后一项；类型错误也覆盖先前有效值，避免拼接出不存在的报告。
        let valid = match self.0 {
            0 => {
                data.session_sha256 = value
                    .as_string()
                    .map(|value| value.as_str())
                    .filter(|value| !value.is_empty() && value.len() <= 64)
                    .map(|value| format!("{:x}", Sha256::digest(value.as_bytes())));
                data.session_sha256.is_some()
            }
            1 => {
                data.content_id = identifier(&value);
                data.content_id.is_some()
            }
            2 => {
                data.recommendation_request_id = identifier(&value);
                data.recommendation_request_id.is_some()
            }
            3 => {
                data.buffer_ms = integer(&value, 86_400_000);
                data.buffer_ms.is_some()
            }
            4 => {
                data.measured_kbps = integer(&value, 1_000_000_000);
                data.measured_kbps.is_some()
            }
            5 => {
                data.duration_ms = integer(&value, 86_400_000);
                data.duration_ms.is_some()
            }
            6 => {
                data.encoded_kbps = integer(&value, 1_000_000_000);
                data.encoded_kbps.is_some()
            }
            7 => {
                data.object_type = value.as_token().and_then(|value| match value.as_str() {
                    "m" => Some("m"),
                    "a" => Some("a"),
                    "v" => Some("v"),
                    "av" => Some("av"),
                    "i" => Some("i"),
                    "c" => Some("c"),
                    "tt" => Some("tt"),
                    "k" => Some("k"),
                    "o" => Some("o"),
                    _ => None,
                });
                data.object_type.is_some()
            }
            8 => {
                data.startup = value.as_boolean();
                data.startup.is_some()
            }
            9 => {
                data.buffer_starved = value.as_boolean();
                data.buffer_starved.is_some()
            }
            10 => {
                data.version = integer(&value, u32::MAX as u64);
                data.version.is_some()
            }
            _ => unreachable!(),
        };
        if valid {
            self.1.invalid &= !(1 << self.0);
        } else {
            self.1.invalid |= 1 << self.0;
        }
        Ok(Ignored)
    }
}

/// 仅支持四个CMCD请求头中的v1标量子集；不解析URL提示、不拉取客户端声明的对象。
pub fn parse_client_report(headers: &HeaderMap, query: Option<&str>) -> ClientReport {
    let mut input = Vec::new();
    let mut present = false;
    for name in ["cmcd-object", "cmcd-request", "cmcd-session", "cmcd-status"] {
        for value in headers.get_all(name) {
            present = true;
            if input.len().saturating_add(value.len()).saturating_add(1) > MAX_CMCD_BYTES {
                return ClientReport::Invalid;
            }
            if !input.is_empty() {
                input.push(b',');
            }
            input.extend_from_slice(value.as_bytes());
        }
    }
    if !present {
        let Some(query) = query else {
            return ClientReport::Absent;
        };
        if query.len() > MAX_CMCD_BYTES * 3 {
            return ClientReport::Invalid;
        }
        let mut entries = form_urlencoded::parse(query.as_bytes()).filter(|(key, _)| key == "CMCD");
        let Some((_, value)) = entries.next() else {
            return ClientReport::Absent;
        };
        if entries.next().is_some() || value.len() > MAX_CMCD_BYTES {
            return ClientReport::Invalid;
        }
        input.extend_from_slice(value.as_bytes());
    }
    if input.is_empty() {
        return ClientReport::Invalid;
    }
    let parsed = match Parser::new(&input)
        .with_version(Version::Rfc8941)
        .parse_dictionary_with_visitor(Visitor::default())
    {
        Ok(value) => value,
        Err(_) => return ClientReport::Invalid,
    };
    if parsed.data.version.is_some_and(|version| version != 1) {
        return ClientReport::UnsupportedVersion;
    }
    if parsed.invalid != 0 {
        return ClientReport::Invalid;
    }
    ClientReport::Accepted(parsed.data)
}

#[derive(Default)]
pub(crate) struct DeliveryCounters {
    requests: AtomicU64,
    active_bodies: AtomicU64,
    completed_bodies: AtomicU64,
    dropped_bodies: AtomicU64,
    dropped_before_headers: AtomicU64,
    failed_bodies: AtomicU64,
    non_media_responses: AtomicU64,
    yielded_bytes: AtomicU64,
    valid_reports: AtomicU64,
    invalid_reports: AtomicU64,
    unsupported_reports: AtomicU64,
    linkage_claims: AtomicU64,
    verified_playback_linkages: AtomicU64,
    verified_recommendation_linkages: AtomicU64,
    unverified_linkage_claims: AtomicU64,
}

#[derive(Debug, Serialize)]
pub struct DeliveryMetrics {
    pub requests: u64,
    pub active_bodies: u64,
    pub completed_bodies: u64,
    pub dropped_bodies: u64,
    pub dropped_before_headers: u64,
    pub failed_bodies: u64,
    pub non_media_responses: u64,
    pub yielded_bytes: u64,
    pub valid_reports: u64,
    pub invalid_reports: u64,
    pub unsupported_reports: u64,
    pub linkage_claims: u64,
    pub verified_playback_linkages: u64,
    pub verified_recommendation_linkages: u64,
    pub unverified_linkage_claims: u64,
}

impl DeliveryCounters {
    pub(crate) fn snapshot(&self) -> DeliveryMetrics {
        DeliveryMetrics {
            requests: self.requests.load(Ordering::Relaxed),
            active_bodies: self.active_bodies.load(Ordering::Relaxed),
            completed_bodies: self.completed_bodies.load(Ordering::Relaxed),
            dropped_bodies: self.dropped_bodies.load(Ordering::Relaxed),
            dropped_before_headers: self.dropped_before_headers.load(Ordering::Relaxed),
            failed_bodies: self.failed_bodies.load(Ordering::Relaxed),
            non_media_responses: self.non_media_responses.load(Ordering::Relaxed),
            yielded_bytes: self.yielded_bytes.load(Ordering::Relaxed),
            valid_reports: self.valid_reports.load(Ordering::Relaxed),
            invalid_reports: self.invalid_reports.load(Ordering::Relaxed),
            unsupported_reports: self.unsupported_reports.load(Ordering::Relaxed),
            linkage_claims: self.linkage_claims.load(Ordering::Relaxed),
            verified_playback_linkages: self.verified_playback_linkages.load(Ordering::Relaxed),
            verified_recommendation_linkages: self
                .verified_recommendation_linkages
                .load(Ordering::Relaxed),
            unverified_linkage_claims: self.unverified_linkage_claims.load(Ordering::Relaxed),
        }
    }
}

struct Observation {
    counters: Arc<DeliveryCounters>,
    client: ClientReport,
    catalog_sha256: String,
    asset_sha256: Option<String>,
    status: Option<u16>,
    range: Option<String>,
    started: Instant,
    headers_us: u64,
    expected: u64,
    yielded: u64,
    outcome: &'static str,
    linkage: &'static str,
    body_started: bool,
}

impl Drop for Observation {
    fn drop(&mut self) {
        if self.body_started {
            self.counters.active_bodies.fetch_sub(1, Ordering::Relaxed);
        }
        let counter = match self.outcome {
            "complete" => &self.counters.completed_bodies,
            "failed" => &self.counters.failed_bodies,
            "no_media_body" => &self.counters.non_media_responses,
            "before_headers_drop" => &self.counters.dropped_before_headers,
            _ => &self.counters.dropped_bodies,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        let (client_report, data) = match &self.client {
            ClientReport::Absent => ("absent", None),
            ClientReport::Accepted(data) => ("accepted", Some(data)),
            ClientReport::Invalid => ("invalid", None),
            ClientReport::UnsupportedVersion => ("unsupported_version", None),
        };
        match self.linkage {
            "playback_verified" | "recommendation_verified" => {
                self.counters
                    .verified_playback_linkages
                    .fetch_add(1, Ordering::Relaxed);
                if self.linkage == "recommendation_verified" {
                    self.counters
                        .verified_recommendation_linkages
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
            "unverified" => {
                self.counters
                    .unverified_linkage_claims
                    .fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
        tracing::info!(
            target: "vs_service::delivery",
            operation = "media_delivery",
            catalog_sha256 = %self.catalog_sha256,
            asset_sha256 = ?self.asset_sha256,
            status = ?self.status,
            content_range = ?self.range,
            expected_body_bytes = self.expected,
            yielded_body_bytes = self.yielded,
            headers_us = self.headers_us,
            lifetime_us = self.started.elapsed().as_micros() as u64,
            outcome = self.outcome,
            linkage = self.linkage,
            client_report,
            client_buffer_ms = ?data.and_then(|value| value.buffer_ms),
            client_measured_kbps = ?data.and_then(|value| value.measured_kbps),
            client_duration_ms = ?data.and_then(|value| value.duration_ms),
            client_encoded_kbps = ?data.and_then(|value| value.encoded_kbps),
            client_object_type = ?data.and_then(|value| value.object_type),
            client_startup = ?data.and_then(|value| value.startup),
            client_buffer_starved = ?data.and_then(|value| value.buffer_starved),
        );
    }
}

pub(crate) async fn observe(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(counters) = state.delivery.clone() else {
        return next.run(request).await;
    };
    let client = parse_client_report(request.headers(), request.uri().query());
    counters.requests.fetch_add(1, Ordering::Relaxed);
    match &client {
        ClientReport::Accepted(_) => {
            counters.valid_reports.fetch_add(1, Ordering::Relaxed);
        }
        ClientReport::Invalid => {
            counters.invalid_reports.fetch_add(1, Ordering::Relaxed);
        }
        ClientReport::UnsupportedVersion => {
            counters.unsupported_reports.fetch_add(1, Ordering::Relaxed);
        }
        ClientReport::Absent => {}
    }
    let path = request.uri().path();
    let linkage = match &client {
        ClientReport::Accepted(data)
            if data.session_sha256.is_some()
                || data.content_id.is_some()
                || data.recommendation_request_id.is_some() =>
        {
            counters.linkage_claims.fetch_add(1, Ordering::Relaxed);
            "unverified"
        }
        _ => "none",
    };
    let hash_index = if path.starts_with("/v1/playback/") {
        4
    } else {
        3
    };
    let asset_sha256 = path
        .split('/')
        .nth(hash_index)
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_string);
    let is_head = request.method() == Method::HEAD;
    let started = Instant::now();
    // 守卫先于处理函数等待创建；HTTP等待被取消时，响应头前阶段也留下结束记录。
    let mut observation = Observation {
        counters: counters.clone(),
        client,
        catalog_sha256: state.catalog_sha256.clone(),
        asset_sha256,
        status: None,
        range: None,
        started,
        headers_us: 0,
        expected: 0,
        yielded: 0,
        outcome: "before_headers_drop",
        linkage,
        body_started: false,
    };
    let mut response = next.run(request).await;
    // 复用处理器完成签名与资源范围校验后的结果，不在观测路径重复验签。
    if let Some(verified) = response.extensions_mut().remove::<VerifiedPlaybackGrant>()
        && let ClientReport::Accepted(data) = &observation.client
        && observation.linkage != "none"
        && let Some(access) = state.playback_access.as_ref()
    {
        observation.linkage = match access.client_linkage(
            &verified,
            data.session_sha256.as_deref(),
            data.content_id.as_deref(),
            data.recommendation_request_id.as_deref(),
        ) {
            ClientLinkage::Direct => "playback_verified",
            ClientLinkage::Recommendation => "recommendation_verified",
            ClientLinkage::Mismatch => "unverified",
        };
    }
    let expected = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let bodyless = is_head || !response.status().is_success() || expected == 0;
    observation.status = Some(response.status().as_u16());
    observation.range = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    observation.headers_us = started.elapsed().as_micros() as u64;
    observation.expected = if bodyless { 0 } else { expected };
    observation.outcome = if bodyless { "no_media_body" } else { "dropped" };
    if bodyless {
        drop(observation);
        return response;
    }
    counters.active_bodies.fetch_add(1, Ordering::Relaxed);
    observation.body_started = true;
    let (parts, body) = response.into_parts();
    let wrapped = stream::unfold(
        (body.into_data_stream(), observation),
        |(mut body, mut observation)| async move {
            let value = body.next().await;
            match value {
                Some(Ok(bytes)) => {
                    observation.yielded += bytes.len() as u64;
                    observation
                        .counters
                        .yielded_bytes
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    if observation.yielded == observation.expected {
                        observation.outcome = "complete";
                    }
                    if observation.yielded > observation.expected {
                        observation.outcome = "failed";
                    }
                    Some((Ok::<_, axum::Error>(bytes), (body, observation)))
                }
                Some(Err(error)) => {
                    observation.outcome = "failed";
                    Some((Err(error), (body, observation)))
                }
                None => {
                    if observation.yielded != observation.expected {
                        observation.outcome = "failed";
                    }
                    drop(observation);
                    None
                }
            }
        },
    );
    Response::from_parts(parts, Body::from_stream(wrapped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::get};
    use std::time::Duration;
    use tower::ServiceExt;

    #[tokio::test]
    async fn cancelled_header_wait_keeps_a_distinct_terminal_observation() {
        let state = Arc::new(
            AppState::new(
                br#"{"version":"wait-v1","items":[],"assets":[]}"#,
                None,
                "observation-only-test-token-0000000000",
                1,
                1,
            )
            .unwrap()
            .with_delivery_observation(),
        );
        let entered = Arc::new(tokio::sync::Notify::new());
        let callback = entered.clone();
        let app = Router::new()
            .route(
                "/wait",
                get(move || {
                    let callback = callback.clone();
                    async move {
                        callback.notify_one();
                        std::future::pending::<&'static str>().await
                    }
                }),
            )
            .route_layer(axum::middleware::from_fn_with_state(state.clone(), observe));
        let task =
            tokio::spawn(app.oneshot(Request::builder().uri("/wait").body(Body::empty()).unwrap()));
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        task.abort();
        let _ = task.await;
        let snapshot = state.delivery.as_ref().unwrap().snapshot();
        assert_eq!(snapshot.requests, 1);
        assert_eq!(snapshot.dropped_before_headers, 1);
        assert_eq!(snapshot.dropped_bodies, 0);
        assert_eq!(snapshot.active_bodies, 0);
    }

    #[tokio::test]
    async fn short_or_failed_response_bodies_are_not_counted_as_client_drops() {
        let state = Arc::new(
            AppState::new(
                br#"{"version":"failure-v1","items":[],"assets":[]}"#,
                None,
                "observation-only-test-token-0000000000",
                1,
                1,
            )
            .unwrap()
            .with_delivery_observation(),
        );
        let app = Router::new()
            .route(
                "/short",
                get(|| async {
                    Response::builder()
                        .header("content-length", "8")
                        .body(Body::from("four"))
                        .unwrap()
                }),
            )
            .route(
                "/error",
                get(|| async {
                    let source = stream::iter([Err::<axum::body::Bytes, _>(
                        std::io::Error::other("读取失败"),
                    )]);
                    Response::builder()
                        .header("content-length", "8")
                        .body(Body::from_stream(source))
                        .unwrap()
                }),
            )
            .route_layer(axum::middleware::from_fn_with_state(state.clone(), observe));
        for path in ["/short", "/error"] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            let _ = axum::body::to_bytes(response.into_body(), 16).await;
        }
        let snapshot = state.delivery.as_ref().unwrap().snapshot();
        assert_eq!(snapshot.failed_bodies, 2);
        assert_eq!(snapshot.dropped_bodies, 0);
        assert_eq!(snapshot.completed_bodies, 0);
        assert_eq!(snapshot.active_bodies, 0);
        assert_eq!(snapshot.yielded_bytes, 4);
    }
}
