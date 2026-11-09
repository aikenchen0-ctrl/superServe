use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
};

use futures_util::Stream;
use http::{Method, Request, Response, StatusCode, header};
use opendal::{Buffer, HttpBody, HttpTransport, Result};
use opendal_http_transport_reqwest::ReqwestTransport;
use serde::Serialize;

#[derive(Default)]
pub(crate) struct HttpCounters {
    requests: AtomicU64,
    get_requests: AtomicU64,
    head_requests: AtomicU64,
    response_body_bytes: AtomicU64,
    transport_errors: AtomicU64,
    status_errors: AtomicU64,
    active_exchanges: AtomicU64,
    abandoned_exchanges: AtomicU64,
    abandoned_before_headers: AtomicU64,
    abandoned_during_body: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct HttpMetricsSnapshot {
    pub requests: u64,
    pub get_requests: u64,
    pub head_requests: u64,
    pub response_body_bytes: u64,
    pub transport_errors: u64,
    pub status_errors: u64,
    pub active_exchanges: u64,
    pub abandoned_exchanges: u64,
    pub abandoned_before_headers: u64,
    pub abandoned_during_body: u64,
}

impl HttpCounters {
    pub(crate) fn snapshot(&self) -> HttpMetricsSnapshot {
        // 各字段是独立的进程内计数；并发读取不是事务快照。
        HttpMetricsSnapshot {
            requests: self.requests.load(Ordering::Relaxed),
            get_requests: self.get_requests.load(Ordering::Relaxed),
            head_requests: self.head_requests.load(Ordering::Relaxed),
            response_body_bytes: self.response_body_bytes.load(Ordering::Relaxed),
            transport_errors: self.transport_errors.load(Ordering::Relaxed),
            status_errors: self.status_errors.load(Ordering::Relaxed),
            active_exchanges: self.active_exchanges.load(Ordering::Relaxed),
            abandoned_exchanges: self.abandoned_exchanges.load(Ordering::Relaxed),
            abandoned_before_headers: self.abandoned_before_headers.load(Ordering::Relaxed),
            abandoned_during_body: self.abandoned_during_body.load(Ordering::Relaxed),
        }
    }
}

struct Exchange {
    counters: Arc<HttpCounters>,
    finished: bool,
    received_headers: bool,
}

impl Exchange {
    fn start(counters: Arc<HttpCounters>) -> Self {
        counters.active_exchanges.fetch_add(1, Ordering::Relaxed);
        Self {
            counters,
            finished: false,
            received_headers: false,
        }
    }

    fn response_started(mut self) -> Self {
        self.received_headers = true;
        self
    }

    fn finish(&mut self) {
        if !self.finished {
            self.finished = true;
            self.counters
                .active_exchanges
                .fetch_sub(1, Ordering::Relaxed);
        }
    }
}

impl Drop for Exchange {
    fn drop(&mut self) {
        if !self.finished {
            self.counters
                .abandoned_exchanges
                .fetch_add(1, Ordering::Relaxed);
            // 本地取消阶段不能证明远端对象锁已经释放。
            if self.received_headers {
                self.counters
                    .abandoned_during_body
                    .fetch_add(1, Ordering::Relaxed);
            } else {
                self.counters
                    .abandoned_before_headers
                    .fetch_add(1, Ordering::Relaxed);
            }
            self.finish();
        }
    }
}

struct ObservedBody {
    inner: Box<dyn Stream<Item = Result<Buffer>> + Send + Sync + Unpin>,
    exchange: Exchange,
    expected: Option<u64>,
    consumed: u64,
}

impl Stream for ObservedBody {
    type Item = Result<Buffer>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let value = Pin::new(&mut self.inner).poll_next(cx);
        match &value {
            Poll::Ready(Some(Ok(bytes))) => {
                let size = bytes.len() as u64;
                self.consumed += size;
                self.exchange
                    .counters
                    .response_body_bytes
                    .fetch_add(size, Ordering::Relaxed);
                // 消费完声明长度即可结束；调用方未再轮询 EOF 不应记为放弃。
                if self.expected == Some(self.consumed) {
                    self.exchange.finish();
                }
            }
            Poll::Ready(Some(Err(_))) => {
                if !self.exchange.finished {
                    self.exchange
                        .counters
                        .transport_errors
                        .fetch_add(1, Ordering::Relaxed);
                    self.exchange.finish();
                }
            }
            Poll::Ready(None) => {
                if !self.exchange.finished
                    && self.expected.is_some_and(|size| size != self.consumed)
                {
                    self.exchange
                        .counters
                        .transport_errors
                        .fetch_add(1, Ordering::Relaxed);
                }
                self.exchange.finish();
            }
            Poll::Pending => {}
        }
        value
    }
}

pub(crate) struct ObservedTransport {
    pub(crate) counters: Arc<HttpCounters>,
}

impl HttpTransport for ObservedTransport {
    async fn fetch(&self, request: Request<Buffer>) -> Result<Response<HttpBody>> {
        self.counters.requests.fetch_add(1, Ordering::Relaxed);
        let is_head = request.method() == Method::HEAD;
        if is_head {
            self.counters.head_requests.fetch_add(1, Ordering::Relaxed);
        } else if request.method() == Method::GET {
            self.counters.get_requests.fetch_add(1, Ordering::Relaxed);
        }
        let mut exchange = Exchange::start(self.counters.clone());
        let response = match ReqwestTransport::default().fetch(request).await {
            Ok(response) => response,
            Err(error) => {
                self.counters
                    .transport_errors
                    .fetch_add(1, Ordering::Relaxed);
                exchange.finish();
                return Err(error);
            }
        };
        exchange = exchange.response_started();
        if !response.status().is_success() {
            self.counters.status_errors.fetch_add(1, Ordering::Relaxed);
        }
        let expected = if is_head
            || matches!(
                response.status(),
                StatusCode::NO_CONTENT | StatusCode::NOT_MODIFIED
            ) {
            Some(0)
        } else {
            response
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
        };
        if expected == Some(0) {
            exchange.finish();
        }
        Ok(response.map(|body| {
            body.map_inner(|inner| {
                Box::new(ObservedBody {
                    inner,
                    exchange,
                    expected,
                    consumed: 0,
                })
            })
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{StreamExt, stream};

    #[tokio::test]
    async fn complete_length_does_not_require_an_extra_eof_poll() {
        let counters = Arc::new(HttpCounters::default());
        let mut body = ObservedBody {
            inner: Box::new(stream::iter([Ok(Buffer::from(vec![1, 2, 3]))])),
            exchange: Exchange::start(counters.clone()).response_started(),
            expected: Some(3),
            consumed: 0,
        };
        assert_eq!(body.next().await.unwrap().unwrap().len(), 3);
        drop(body);
        let result = counters.snapshot();
        assert_eq!(result.response_body_bytes, 3);
        assert_eq!(result.active_exchanges, 0);
        assert_eq!(result.abandoned_exchanges, 0);
    }

    #[tokio::test]
    async fn early_drop_counts_only_consumed_bytes_and_releases_exchange() {
        let counters = Arc::new(HttpCounters::default());
        let mut body = ObservedBody {
            inner: Box::new(
                stream::iter([Ok(Buffer::from(vec![1, 2, 3]))]).chain(stream::pending()),
            ),
            exchange: Exchange::start(counters.clone()).response_started(),
            expected: Some(100),
            consumed: 0,
        };
        body.next().await.unwrap().unwrap();
        drop(body);
        let result = counters.snapshot();
        assert_eq!(result.response_body_bytes, 3);
        assert_eq!(result.active_exchanges, 0);
        assert_eq!(result.abandoned_exchanges, 1);
        assert_eq!(result.abandoned_before_headers, 0);
        assert_eq!(result.abandoned_during_body, 1);
    }

    #[test]
    fn cancellation_before_headers_releases_exchange() {
        let counters = Arc::new(HttpCounters::default());
        drop(Exchange::start(counters.clone()));
        assert_eq!(counters.snapshot().active_exchanges, 0);
        assert_eq!(counters.snapshot().abandoned_exchanges, 1);
        assert_eq!(counters.snapshot().abandoned_before_headers, 1);
        assert_eq!(counters.snapshot().abandoned_during_body, 0);
    }

    #[tokio::test]
    async fn truncated_body_records_one_error_not_cancellation() {
        let counters = Arc::new(HttpCounters::default());
        let mut body = ObservedBody {
            inner: Box::new(stream::empty()),
            exchange: Exchange::start(counters.clone()).response_started(),
            expected: Some(100),
            consumed: 0,
        };
        assert!(body.next().await.is_none());
        assert!(body.next().await.is_none());
        drop(body);
        let result = counters.snapshot();
        assert_eq!(result.transport_errors, 1);
        assert_eq!(result.active_exchanges, 0);
        assert_eq!(result.abandoned_exchanges, 0);
    }

    #[tokio::test]
    async fn unknown_length_completes_only_at_eof() {
        let counters = Arc::new(HttpCounters::default());
        let mut body = ObservedBody {
            inner: Box::new(stream::iter([Ok(Buffer::from(vec![1, 2, 3]))])),
            exchange: Exchange::start(counters.clone()).response_started(),
            expected: None,
            consumed: 0,
        };
        body.next().await.unwrap().unwrap();
        assert_eq!(counters.snapshot().active_exchanges, 1);
        assert!(body.next().await.is_none());
        drop(body);
        assert_eq!(counters.snapshot().abandoned_exchanges, 0);
        assert_eq!(counters.snapshot().active_exchanges, 0);
    }
}
