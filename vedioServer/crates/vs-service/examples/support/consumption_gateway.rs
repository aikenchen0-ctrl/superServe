use std::{
    collections::HashMap,
    io::{self, Read},
    path::Path,
    sync::Mutex,
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderValue, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::json;
use tower::ServiceExt;
use vs_core::learning::TrainingDataKind;
use vs_service::{
    AppState, Role,
    consumption::{ClientPlatform, ConsumptionBatch, normalize_consumption},
    feedback_log::IggyFeedbackConfig,
    playback_access::PlaybackGrantResponse,
    router,
};

const MAX_GRANTS: usize = 8;

struct Binding {
    decision_id: String,
    candidate_id: String,
    issued_at: u64,
    expires_at: u64,
}

/// 本机合成实验网关，不是生产登录或匿名事件接收器。
pub struct ConsumptionGateway {
    feedback: Router,
    authorization: HeaderValue,
    bindings: Mutex<HashMap<String, Binding>>,
}

impl ConsumptionGateway {
    pub async fn load(path: &Path, catalog: &[u8], token: &str) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::other("实验反馈配置必须为绝对路径"));
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(65537)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 65536 {
            return Err(io::Error::other("实验反馈配置超过64KiB"));
        }
        let config: IggyFeedbackConfig =
            serde_json::from_slice(&bytes).map_err(|_| io::Error::other("实验反馈配置JSON无效"))?;
        let endpoint = reqwest::Url::parse(&config.endpoint)
            .map_err(|_| io::Error::other("实验反馈地址无效"))?;
        let loopback = endpoint
            .host_str()
            .and_then(|host| host.parse::<std::net::Ipv4Addr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if !loopback
            || endpoint.scheme() != "http"
            || !config.fallback_endpoints.is_empty()
            || config.source_id != "playback-lab"
            || config.data_kind != TrainingDataKind::Synthetic
        {
            return Err(io::Error::other(
                "实验反馈只允许固定回环HTTP及playback-lab合成来源",
            ));
        }
        let broker_token = std::env::var("VS_FEEDBACK_IGGY_TOKEN")
            .map_err(|_| io::Error::other("缺少实验反馈读取写入凭据"))?;
        Self::create(catalog, token, config, broker_token).await
    }

    async fn create(
        catalog: &[u8],
        token: &str,
        config: IggyFeedbackConfig,
        broker_token: String,
    ) -> io::Result<Self> {
        let state = AppState::new(catalog, None, token, 1, 1)
            .map_err(io::Error::other)?
            .with_feedback_log(config, broker_token)
            .map_err(io::Error::other)?;
        state.verify_feedback_readiness().await?;
        Ok(Self {
            feedback: router(std::sync::Arc::new(state), Role::Feedback),
            authorization: HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| io::Error::other("实验网关凭据格式无效"))?,
            bindings: Mutex::new(HashMap::new()),
        })
    }

    pub fn register(&self, grant: &PlaybackGrantResponse, at: u64) -> io::Result<()> {
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| io::Error::other("实验消费绑定不可用"))?;
        bindings.retain(|_, binding| binding.expires_at > at);
        if bindings.len() >= MAX_GRANTS
            || bindings.contains_key(&grant.playback_id)
            || grant.expires_at <= at
        {
            return Err(io::Error::other("实验消费绑定已满、重复或过期"));
        }
        let decision_id = grant
            .decision_id
            .clone()
            .ok_or_else(|| io::Error::other("播放授权缺少持久决策关联"))?;
        bindings.insert(
            grant.playback_id.clone(),
            Binding {
                decision_id,
                candidate_id: grant.candidate_id.clone(),
                issued_at: at,
                expires_at: grant.expires_at,
            },
        );
        Ok(())
    }

    fn allows(&self, batch: &ConsumptionBatch, at: u64) -> bool {
        self.bindings.lock().ok().is_some_and(|bindings| {
            bindings.get(&batch.interaction_id).is_some_and(|binding| {
                batch.platform == ClientPlatform::Web
                    && batch.data_kind == TrainingDataKind::Synthetic
                    && batch.source_id == "playback-lab"
                    && batch.subject == "local-lab-viewer"
                    && batch.generation == 1
                    && batch.decision_id == binding.decision_id
                    && batch.candidate_id == binding.candidate_id
                    && at >= binding.issued_at
                    && at < binding.expires_at
                    && batch.events.iter().all(|event| {
                        event.observed_at >= binding.issued_at
                            && event.observed_at < binding.expires_at
                    })
            })
        })
    }

    pub async fn submit(&self, batch: ConsumptionBatch, at: u64) -> Response {
        if !self.allows(&batch, at) {
            return (StatusCode::FORBIDDEN, "消费声明不属于当前有效实验播放实例").into_response();
        }
        let normalized = match normalize_consumption(&batch, at) {
            Ok(value) => value,
            Err(reason) => return (StatusCode::BAD_REQUEST, reason).into_response(),
        };
        let bytes = match serde_json::to_vec(&batch) {
            Ok(bytes) if bytes.len() <= 32 * 1024 => bytes,
            _ => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        };
        let request = Request::builder()
            .method("POST")
            .uri("/internal/v1/consumption/events")
            .header(header::AUTHORIZATION, self.authorization.clone())
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(bytes))
            .unwrap();
        // 复用正式反馈写入预算、取消与未知确认语义；浏览器不持内部凭据。
        let response = self.feedback.clone().oneshot(request).await.unwrap();
        if response.status() != StatusCode::ACCEPTED {
            return response;
        }
        #[derive(Deserialize)]
        struct Confirmation {
            schema: String,
            commit: serde_json::Value,
        }
        let bytes = match to_bytes(response.into_body(), 8192).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "反馈确认读取失败，结果未知",
                )
                    .into_response();
            }
        };
        let confirmation: Confirmation = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "反馈确认格式无效，结果未知",
                )
                    .into_response();
            }
        };
        if confirmation.schema != "consumption-confirmation-v1"
            || confirmation.commit["durability"] != "persisted"
        {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "反馈未确认持久化，结果未知",
            )
                .into_response();
        }
        (
            StatusCode::ACCEPTED,
            axum::Json(json!({
                "schema":"playback-lab-consumption-v1",
                "summary":normalized.summary,
                "learning_events":normalized.learning.events.len(),
                "persisted":true,
                "commit":confirmation.commit,
                "scope":"真实浏览器观测加实验消息确认，不是生产登录或物理持久性证明"
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, extract::State, routing::post};
    use serde_json::Value;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn grant(id: &str) -> PlaybackGrantResponse {
        PlaybackGrantResponse {
            schema: "playback-grant-v1".into(),
            candidate_id: "clip".into(),
            decision_id: Some("a".repeat(64)),
            recommendation_request_id: Some("request".into()),
            catalog_sha256: "b".repeat(64),
            playback_id: id.into(),
            protocol: "hls".into(),
            media_path: "/unused".into(),
            expires_at: 200,
            credential_transport: "path".into(),
        }
    }

    fn batch() -> ConsumptionBatch {
        serde_json::from_value(json!({
            "schema":"client-consumption-v1","source_id":"playback-lab","data_kind":"synthetic",
            "platform":"web","subject":"local-lab-viewer","decision_id":"a".repeat(64),
            "candidate_id":"clip","interaction_id":"playback","generation":1,
            "events":[{"event_id":"event","sequence":1,"elapsed_ms":1000,"observed_at":101,
                "observation":{"kind":"progress","transferred_bytes":100,"byte_scope":"web_xhr_body"}}]
        })).unwrap()
    }

    fn gateway(fail: bool) -> (ConsumptionGateway, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/internal/v1/consumption/events",
                post(
                    move |State(calls): State<Arc<AtomicUsize>>,
                          request: axum::extract::Request| async move {
                        assert_eq!(
                            request.headers()[header::AUTHORIZATION],
                            "Bearer private-token"
                        );
                        let bytes = to_bytes(request.into_body(), 32768).await.unwrap();
                        let value: Value = serde_json::from_slice(&bytes).unwrap();
                        assert_eq!(value["interaction_id"], "playback");
                        calls.fetch_add(1, Ordering::SeqCst);
                        if fail {
                            return StatusCode::SERVICE_UNAVAILABLE.into_response();
                        }
                        (
                            StatusCode::ACCEPTED,
                            Json(json!({
                                "schema":"consumption-confirmation-v1",
                                "commit":{"durability":"persisted","base_offset":0}
                            })),
                        )
                            .into_response()
                    },
                ),
            )
            .with_state(calls.clone());
        (
            ConsumptionGateway {
                feedback: app,
                authorization: HeaderValue::from_static("Bearer private-token"),
                bindings: Mutex::new(HashMap::new()),
            },
            calls,
        )
    }

    #[tokio::test]
    async fn only_current_server_issued_binding_reaches_feedback_and_response_hides_credential() {
        let (gateway, calls) = gateway(false);
        assert_eq!(
            gateway.submit(batch(), 102).await.status(),
            StatusCode::FORBIDDEN
        );
        gateway.register(&grant("playback"), 100).unwrap();
        for field in [
            "subject",
            "decision_id",
            "candidate_id",
            "interaction_id",
            "generation",
            "platform",
        ] {
            let mut value = serde_json::to_value(batch()).unwrap();
            value[field] = match field {
                "decision_id" => json!("c".repeat(64)),
                "generation" => json!(2),
                "platform" => json!("ios"),
                _ => json!("another"),
            };
            assert_eq!(
                gateway
                    .submit(serde_json::from_value(value).unwrap(), 102)
                    .await
                    .status(),
                StatusCode::FORBIDDEN,
                "{field}"
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let response = gateway.submit(batch(), 102).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private-token"));
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["persisted"], true);
        assert_eq!(value["summary"]["last_known_transferred_bytes"], 100);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn expiry_and_events_outside_binding_never_write_and_unknown_is_not_retried() {
        let (gateway, calls) = gateway(true);
        gateway.register(&grant("playback"), 100).unwrap();
        assert_eq!(
            gateway.submit(batch(), 200).await.status(),
            StatusCode::FORBIDDEN
        );
        let mut value = batch();
        value.events[0].observed_at = 99;
        assert_eq!(
            gateway.submit(value, 102).await.status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            gateway.submit(batch(), 102).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn bounded_registry_never_replaces_existing_identity_and_only_reclaims_expired_bindings() {
        let (gateway, _) = gateway(false);
        for index in 0..8 {
            gateway
                .register(&grant(&format!("playback-{index}")), 100)
                .unwrap();
        }
        assert!(gateway.register(&grant("overflow"), 100).is_err());
        assert!(gateway.register(&grant("playback-0"), 100).is_err());
        let mut value = grant("replacement");
        value.expires_at = 300;
        gateway.register(&value, 200).unwrap();
        assert_eq!(gateway.bindings.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn configuration_refuses_remote_dns_fallback_observed_and_wrong_source_before_network() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let original = json!({
            "endpoint":"http://127.0.0.1:1","stream_id":1,"topic_id":1,
            "partition_id":1,"source_id":"playback-lab","data_kind":"synthetic",
            "operation_timeout_ms":100
        });
        for field in ["remote", "dns", "https", "fallback", "source", "kind"] {
            let mut config = original.clone();
            match field {
                "remote" => config["endpoint"] = json!("http://192.168.1.1:8080"),
                "dns" => config["endpoint"] = json!("http://localhost:8080"),
                "https" => config["endpoint"] = json!("https://127.0.0.1:8080"),
                "fallback" => config["fallback_endpoints"] = json!(["http://127.0.0.1:2"]),
                "source" => config["source_id"] = json!("another"),
                "kind" => config["data_kind"] = json!("observed"),
                _ => unreachable!(),
            }
            std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
            assert!(
                ConsumptionGateway::load(&path, b"{}", "unused")
                    .await
                    .is_err(),
                "{field}"
            );
        }
        assert!(
            ConsumptionGateway::load(Path::new("relative.json"), b"{}", "unused")
                .await
                .is_err()
        );
    }
}
