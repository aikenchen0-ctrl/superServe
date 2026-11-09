use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    body::Body,
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::stream;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct LiveProxy {
    client: reqwest::Client,
    port: u16,
    slots: Arc<Semaphore>,
    requests: Arc<AtomicU64>,
    yielded_bytes: Arc<AtomicU64>,
}

fn allowed_file(filename: &str) -> bool {
    filename == "lab.m3u8"
        || filename.strip_suffix(".ts").is_some_and(|stem| {
            !stem.is_empty() && stem.len() <= 10 && stem.bytes().all(|byte| byte.is_ascii_digit())
        })
}

impl LiveProxy {
    pub fn new(port: u16) -> Result<Self, reqwest::Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .no_proxy()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(8))
                .build()?,
            port,
            slots: Arc::new(Semaphore::new(8)),
            requests: Arc::new(AtomicU64::new(0)),
            yielded_bytes: Arc::new(AtomicU64::new(0)),
        })
    }

    pub fn metrics(&self) -> Value {
        json!({
            "requests": self.requests.load(Ordering::Relaxed),
            "yielded_body_bytes": self.yielded_bytes.load(Ordering::Relaxed),
            "available_permits": self.slots.available_permits(),
            "capacity": 8
        })
    }

    pub async fn get(&self, filename: &str, method: Method) -> Response {
        if !allowed_file(filename) {
            return (StatusCode::NOT_FOUND, "直播资源名称不在允许范围").into_response();
        }
        let permit = match self.slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, "直播读取已满").into_response(),
        };
        // 目的地址、房间和文件类型均固定，浏览器不能选择上游URL或传递内部凭证。
        let endpoint = format!("http://127.0.0.1:{}/live/lab/{filename}", self.port);
        self.requests.fetch_add(1, Ordering::Relaxed);
        let upstream = match self.client.request(method.clone(), endpoint).send().await {
            Ok(response) => response,
            Err(_) => return (StatusCode::BAD_GATEWAY, "直播上游不可用").into_response(),
        };
        let status = upstream.status();
        if status == StatusCode::NOT_FOUND {
            return (status, "直播片段尚未就绪或已过期").into_response();
        }
        if status != StatusCode::OK {
            return (StatusCode::BAD_GATEWAY, "直播上游响应无效").into_response();
        }
        let limit = if filename == "lab.m3u8" {
            128 * 1024
        } else {
            8 * 1024 * 1024
        };
        if upstream.content_length().is_some_and(|bytes| bytes > limit) {
            return (StatusCode::BAD_GATEWAY, "直播资源超过实验预算").into_response();
        }
        let content_type = if filename == "lab.m3u8" {
            "application/vnd.apple.mpegurl"
        } else {
            "video/mp2t"
        };
        if method == Method::HEAD {
            return ([(header::CONTENT_TYPE, content_type)], Body::empty()).into_response();
        }
        let counter = self.yielded_bytes.clone();
        let body = stream::try_unfold(
            (upstream, permit, counter, 0_u64),
            move |(mut upstream, permit, counter, mut received)| async move {
                match upstream.chunk().await.map_err(std::io::Error::other)? {
                    Some(bytes) => {
                        received += bytes.len() as u64;
                        if received > limit {
                            return Err(std::io::Error::other("直播正文超过实验预算"));
                        }
                        counter.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                        Ok(Some((bytes, (upstream, permit, counter, received))))
                    }
                    None => Ok(None),
                }
            },
        );
        // 许可和上游响应跟随正文存活，浏览器取消即释放；不先将整个片段收进内存。
        (
            [(header::CONTENT_TYPE, content_type)],
            Body::from_stream(body),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Bytes, routing::get};
    use futures_util::StreamExt;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn fixed_origin_streaming_rejects_redirects_and_releases_permits_on_drop() {
        let app = Router::new()
            .route(
                "/live/lab/0.ts",
                get(|| async {
                    let chunks = stream::once(async {
                        Ok::<_, std::io::Error>(Bytes::from_static(b"first-block"))
                    })
                    .chain(stream::pending());
                    Body::from_stream(chunks)
                }),
            )
            .route(
                "/live/lab/1.ts",
                get(|| async {
                    (
                        StatusCode::FOUND,
                        [(header::LOCATION, "http://127.0.0.1:1/private")],
                    )
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let proxy = LiveProxy::new(port).unwrap();
        for filename in [
            "../secret",
            "lab.m3u8?url=x",
            "http://evil/x.ts",
            "x.ts",
            "1.ts/other",
        ] {
            assert_eq!(
                proxy.get(filename, Method::GET).await.status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(proxy.metrics()["requests"], 0);
        let response = proxy.get("0.ts", Method::GET).await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap(), "first-block");
        assert_eq!(proxy.metrics()["available_permits"], 7);
        drop(body);
        assert_eq!(proxy.metrics()["available_permits"], 8);
        assert_eq!(
            proxy.get("1.ts", Method::GET).await.status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(proxy.metrics()["available_permits"], 8);
        server.abort();
    }
}
