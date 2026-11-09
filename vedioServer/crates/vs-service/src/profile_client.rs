use std::time::Duration;

use crate::profile_log::ProfileHistoryCheckpoint;
use crate::profile_shards::ProfileShard;
use axum::http::StatusCode;
use reqwest::{Client, RequestBuilder, Response, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use vs_core::{
    profile::{ProfileEvent, ProfileEventResult},
    recommendation::ProfileProjection,
    valid_id,
};

pub struct ProfileRemoteConfig {
    pub endpoint: String,
    pub token: String,
}

#[derive(Clone)]
pub(crate) struct ProfileClient {
    client: Client,
    endpoint: String,
    token: String,
    catalog_sha256: String,
    history: Option<ProfileHistoryCheckpoint>,
    pub(crate) shard: Option<ProfileShard>,
}

#[derive(Debug)]
pub(crate) struct ProfileClientError {
    pub status: StatusCode,
    pub code: &'static str,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectionRequest {
    pub subject: String,
    pub domains: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectionResponse {
    pub profile: Option<ProfileProjection>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryRequest {
    pub minimum: Option<ProfileHistoryCheckpoint>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryResponse {
    pub checkpoint: ProfileHistoryCheckpoint,
    pub guard: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorResponse {
    error: String,
}

fn unavailable() -> ProfileClientError {
    ProfileClientError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "profile_authority_unavailable",
    }
}

fn mismatch() -> ProfileClientError {
    ProfileClientError {
        status: StatusCode::CONFLICT,
        code: "profile_catalog_mismatch",
    }
}

impl ProfileClient {
    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn new(config: ProfileRemoteConfig, catalog_sha256: String) -> Result<Self, String> {
        let url = Url::parse(&config.endpoint).map_err(|_| "invalid_profile_endpoint")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("invalid_profile_endpoint".into());
        }
        if !(32..=256).contains(&config.token.len())
            || !config.token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("invalid_profile_service_token".into());
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_millis(500))
            .timeout(Duration::from_secs(2))
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|_| "profile_client_build_failed")?;
        Ok(Self {
            client,
            endpoint: url.as_str().trim_end_matches('/').to_string(),
            token: config.token,
            catalog_sha256,
            history: None,
            shard: None,
        })
    }

    pub(crate) fn with_history(
        mut self,
        checkpoint: ProfileHistoryCheckpoint,
    ) -> Result<Self, String> {
        checkpoint.validate()?;
        self.history = Some(checkpoint);
        Ok(self)
    }

    pub(crate) fn history(&self) -> Option<&ProfileHistoryCheckpoint> {
        self.history.as_ref()
    }

    fn post(&self, path: &str) -> RequestBuilder {
        let builder = self
            .client
            .post(format!("{}{path}", self.endpoint))
            .bearer_auth(&self.token)
            .header("x-catalog-sha256", &self.catalog_sha256);
        let builder = match &self.shard {
            Some(shard) => builder.header("x-profile-shard-guard", shard.guard()),
            None => builder,
        };
        match &self.history {
            Some(history) => builder.header("x-profile-history-guard", history.guard()),
            None => builder,
        }
    }

    async fn response(&self, builder: RequestBuilder) -> Result<Response, ProfileClientError> {
        let response = builder.send().await.map_err(|_| unavailable())?;
        if response.status() == StatusCode::CONFLICT {
            let body: ErrorResponse = self.json(response).await?;
            if body.error == "profile_event_id_conflict" {
                return Err(ProfileClientError {
                    status: StatusCode::CONFLICT,
                    code: "profile_event_id_conflict",
                });
            }
            if self.shard.is_some()
                && matches!(
                    body.error.as_str(),
                    "画像分片身份不符" | "主体不属于当前画像分片"
                )
            {
                return Err(ProfileClientError {
                    status: StatusCode::CONFLICT,
                    code: "画像分片身份或主体归属不符",
                });
            }
            return Err(mismatch());
        }
        if !response.status().is_success() {
            let status = match response.status() {
                StatusCode::BAD_REQUEST
                | StatusCode::FORBIDDEN
                | StatusCode::NOT_FOUND
                | StatusCode::INSUFFICIENT_STORAGE => response.status(),
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            return Err(ProfileClientError {
                status,
                code: "profile_authority_rejected",
            });
        }
        Ok(response)
    }

    async fn json<T: DeserializeOwned>(
        &self,
        mut response: Response,
    ) -> Result<T, ProfileClientError> {
        const MAX_BYTES: usize = 65_536;
        if response
            .content_length()
            .is_some_and(|len| len > MAX_BYTES as u64)
        {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if chunk.len() > MAX_BYTES - bytes.len() {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| unavailable())
    }

    fn check_catalog(&self, response: &Response) -> Result<(), ProfileClientError> {
        let guard = self.shard.as_ref().map(ProfileShard::guard);
        if response
            .headers()
            .get("x-profile-shard-guard")
            .and_then(|value| value.to_str().ok())
            != guard.as_deref()
        {
            return Err(ProfileClientError {
                status: StatusCode::CONFLICT,
                code: "画像分片身份不符",
            });
        }
        if response
            .headers()
            .get("x-catalog-sha256")
            .and_then(|h| h.to_str().ok())
            != Some(self.catalog_sha256.as_str())
        {
            return Err(mismatch());
        }
        if let Some(history) = &self.history
            && response
                .headers()
                .get("x-profile-history-guard")
                .and_then(|value| value.to_str().ok())
                != Some(history.guard().as_str())
        {
            return Err(ProfileClientError {
                status: StatusCode::CONFLICT,
                code: "画像历史凭据不符",
            });
        }
        Ok(())
    }

    pub(crate) async fn checkpoint(
        &self,
        minimum: Option<&ProfileHistoryCheckpoint>,
    ) -> Result<ProfileHistoryCheckpoint, ProfileClientError> {
        let response = self
            .response(
                // 新前缀尚未注册，校验请求不携带依赖该注册的guard。
                self.client
                    .post(format!("{}/internal/v1/profile/history", self.endpoint))
                    .bearer_auth(&self.token)
                    .header("x-catalog-sha256", &self.catalog_sha256)
                    .json(&HistoryRequest {
                        minimum: minimum.cloned(),
                    }),
            )
            .await?;
        if response
            .headers()
            .get("x-catalog-sha256")
            .and_then(|value| value.to_str().ok())
            != Some(self.catalog_sha256.as_str())
        {
            return Err(mismatch());
        }
        let result: HistoryResponse = self.json(response).await?;
        result.checkpoint.validate().map_err(|_| unavailable())?;
        if result.guard != minimum.unwrap_or(&result.checkpoint).guard()
            || minimum.is_some_and(|minimum| {
                minimum.bytes > result.checkpoint.bytes
                    || minimum.records > result.checkpoint.records
                    || (minimum.bytes == result.checkpoint.bytes && minimum != &result.checkpoint)
            })
        {
            return Err(unavailable());
        }
        Ok(result.checkpoint)
    }

    pub async fn projection(
        &self,
        subject: &str,
        domains: &[String],
    ) -> Result<Option<ProfileProjection>, ProfileClientError> {
        let response = self
            .response(
                self.post("/internal/v1/profile/projection")
                    .json(&ProjectionRequest {
                        subject: subject.to_string(),
                        domains: domains.to_vec(),
                    }),
            )
            .await?;
        self.check_catalog(&response)?;
        let body: ProjectionResponse = self.json(response).await?;
        if body
            .profile
            .as_ref()
            .is_some_and(|profile| profile.subject != subject || profile.scopes != domains)
        {
            return Err(unavailable());
        }
        Ok(body.profile)
    }

    pub async fn event(
        &self,
        event: &ProfileEvent,
    ) -> Result<ProfileEventResult, ProfileClientError> {
        let response = self
            .response(self.post("/internal/v1/profile/events").json(event))
            .await?;
        self.check_catalog(&response)?;
        let result: ProfileEventResult = self.json(response).await?;
        if result.accepted == result.duplicate || !valid_id(&result.profile_version) {
            return Err(unavailable());
        }
        Ok(result)
    }

    pub async fn ready(&self) -> Result<(), ProfileClientError> {
        let response = self
            .response(
                self.client
                    .get(format!("{}/readyz", self.endpoint))
                    .bearer_auth(&self.token),
            )
            .await?;
        let body: serde_json::Value = self.json(response).await?;
        if body["catalog_sha256"] != self.catalog_sha256 {
            return Err(mismatch());
        }
        if body["ready"] != true
            || body["profile_authority"] != true
            || body["profile_log_enabled"] != true
        {
            return Err(unavailable());
        }
        if body["profile_shard"] != serde_json::json!(self.shard) {
            return Err(unavailable());
        }
        if let Some(history) = &self.history {
            self.checkpoint(Some(history)).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Response, routing::post};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn history_checkpoint_rejects_forged_guard_invalid_watermark_large_body_and_redirect() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let checkpoint = ProfileHistoryCheckpoint {
            schema: "profile-history-checkpoint-v1".into(),
            projection_version: "tag-additive-v1".into(),
            records: 1,
            bytes: 300,
            sha256: "a".repeat(64),
        };
        for case in [
            "guard",
            "schema",
            "regression",
            "same-length-fork",
            "oversize",
            "redirect",
            "valid-append",
        ] {
            let returned = checkpoint.clone();
            let app = Router::new().route(
                "/internal/v1/profile/history",
                post(move || {
                    let mut returned = returned.clone();
                    async move {
                        let original_guard = returned.guard();
                        match case {
                            "schema" => returned.schema = "future".into(),
                            "regression" => {
                                returned.records = 0;
                                returned.bytes = 0;
                                returned.sha256 = format!("{:x}", Sha256::digest([]));
                            }
                            "same-length-fork" => returned.sha256 = "b".repeat(64),
                            "valid-append" => {
                                returned.records = 2;
                                returned.bytes = 600;
                                returned.sha256 = "b".repeat(64);
                            }
                            _ => {}
                        }
                        let response = serde_json::json!({"checkpoint":returned,
                        "guard":if case=="guard" {"wrong".to_string()} else {original_guard}});
                        if case == "redirect" {
                            return Response::builder()
                                .status(307)
                                .header("location", "/unexpected")
                                .body(Body::empty())
                                .unwrap();
                        }
                        let body = if case == "oversize" {
                            let tail = serde_json::to_vec(&response).unwrap();
                            Body::from_stream(futures_util::stream::iter([
                                Ok::<_, std::io::Error>(vec![b' '; 65_536]),
                                Ok(tail),
                            ]))
                        } else {
                            Body::from(response.to_string())
                        };
                        Response::builder()
                            .header("x-catalog-sha256", "a".repeat(64))
                            .body(body)
                            .unwrap()
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
            let client = ProfileClient::new(
                ProfileRemoteConfig {
                    endpoint,
                    token: "history-protocol-profile-token-000000000".into(),
                },
                "a".repeat(64),
            )
            .unwrap();
            assert_eq!(
                client.checkpoint(Some(&checkpoint)).await.is_ok(),
                case == "valid-append",
                "历史响应：{case}"
            );
            task.abort();
            let _ = task.await;
        }
    }

    #[tokio::test]
    async fn forged_subject_oversized_body_wrong_catalog_and_redirect_fail_closed() {
        let catalog = "a".repeat(64);
        for case in ["subject", "size", "catalog", "redirect"] {
            let redirects = Arc::new(AtomicUsize::new(0));
            let count = redirects.clone();
            let returned_catalog = if case == "catalog" {
                "b".repeat(64)
            } else {
                catalog.clone()
            };
            let app = Router::new().route("/internal/v1/profile/projection", post(move || {
                let returned_catalog = returned_catalog.clone();
                async move {
                    let mut response = Response::builder().header("x-catalog-sha256", returned_catalog);
                    let body = if case == "size" {
                        let mut tail = vec![b' '; 32_769];
                        tail.extend_from_slice(br#"{"profile":null}"#);
                        Body::from_stream(futures_util::stream::iter([
                            Ok::<_, std::convert::Infallible>(vec![b' '; 32_768]),
                            Ok(tail),
                        ]))
                    } else if case == "redirect" {
                        response = response.status(307).header("location", "/unexpected");
                        Body::empty()
                    } else {
                        Body::from(serde_json::to_vec(&json!({"profile":{
                            "subject":"other-user", "version":"memory-1", "scopes":["video"],
                            "expires_at":4102444800_u64, "interests":[], "blocked_ids":[], "denied_tags":[]
                        }})).unwrap())
                    };
                    response.body(body).unwrap()
                }
            })).route("/unexpected", post(move || {
                count.fetch_add(1, Ordering::SeqCst);
                async { "unexpected" }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let client = ProfileClient::new(
                ProfileRemoteConfig {
                    endpoint,
                    token: "test-only-profile-authority-token-0000000".into(),
                },
                catalog.clone(),
            )
            .unwrap();
            let error = client
                .projection("user-a", &["video".into()])
                .await
                .unwrap_err();
            assert_eq!(
                error.status,
                if case == "catalog" {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            );
            assert_eq!(redirects.load(Ordering::SeqCst), 0);
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
        }
    }
}
