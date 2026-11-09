use std::{ops::Range, sync::Arc};

use opendal::{FuturesBytesStream, HttpTransporter, OperationContext, Operator, Result, services};

mod media_cache;
mod observability;
pub use media_cache::{MediaCacheConfig, MediaCacheMetrics, MediaCachePolicy, PublishedStream};
pub use observability::HttpMetricsSnapshot;
use observability::{HttpCounters, ObservedTransport};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize)]
pub enum ReadMode {
    #[default]
    #[serde(rename = "chunk-64k")]
    Chunk64Kib,
    #[serde(rename = "chunk-256k")]
    Chunk256Kib,
    #[serde(rename = "chunk-1m")]
    Chunk1Mib,
    #[serde(rename = "stream")]
    Streaming,
}

impl std::str::FromStr for ReadMode {
    type Err = &'static str;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "chunk-64k" => Ok(Self::Chunk64Kib),
            "chunk-256k" => Ok(Self::Chunk256Kib),
            "chunk-1m" => Ok(Self::Chunk1Mib),
            "stream" => Ok(Self::Streaming),
            _ => Err("invalid_media_read_mode"),
        }
    }
}

#[derive(Clone)]
pub struct MediaStore {
    operator: Operator,
    http_counters: Option<Arc<HttpCounters>>,
    read_mode: ReadMode,
    cache: Option<Arc<media_cache::MediaCache>>,
}

pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl MediaStore {
    pub fn filesystem(root: &str) -> Result<Self> {
        Ok(Self {
            operator: Operator::new(services::Fs::default().root(root))?,
            http_counters: None,
            read_mode: ReadMode::default(),
            cache: None,
        })
    }

    pub fn s3(config: S3Config) -> Result<Self> {
        // 显式选用 ring；避免默认 TLS 提供器额外引入 AWS-LC 的构建链。
        let _ = rustls::crypto::ring::default_provider().install_default();
        // 0.59.5 的无提供器特性不自动安装传输器，必须显式初始化。
        opendal_http_transport_reqwest::install_default();
        let counters = Arc::new(HttpCounters::default());
        Ok(Self {
            operator: Operator::new(
                services::S3::default()
                    .endpoint(&config.endpoint)
                    .region(&config.region)
                    .bucket(&config.bucket)
                    .access_key_id(&config.access_key_id)
                    .secret_access_key(&config.secret_access_key)
                    .disable_config_load()
                    .disable_ec2_metadata(),
            )?
            .with_context(OperationContext::new().with_http_transport(
                HttpTransporter::new(ObservedTransport {
                    counters: counters.clone(),
                }),
            )),
            http_counters: Some(counters),
            read_mode: ReadMode::default(),
            cache: None,
        })
    }

    pub fn with_read_mode(mut self, mode: ReadMode) -> Self {
        self.read_mode = mode;
        self
    }

    pub fn read_mode(&self) -> ReadMode {
        self.read_mode
    }

    pub fn http_metrics(&self) -> Option<HttpMetricsSnapshot> {
        self.http_counters.as_ref().map(|value| value.snapshot())
    }

    pub async fn size(&self, key: &str) -> Result<u64> {
        Ok(self.operator.stat(key).await?.content_length())
    }

    pub async fn stream(&self, key: &str, range: Range<u64>) -> Result<FuturesBytesStream> {
        let reader = self.operator.reader_with(key).concurrent(1);
        // chunk 控制存储请求及整块缓冲；原生流式直接轮询正文，不能把二者当作同一粒度。
        let reader = match self.read_mode {
            ReadMode::Chunk64Kib => reader.chunk(64 * 1024),
            ReadMode::Chunk256Kib => reader.chunk(256 * 1024),
            ReadMode::Chunk1Mib => reader.chunk(1024 * 1024),
            ReadMode::Streaming => reader,
        };
        reader.await?.into_bytes_stream(range).await
    }
}

#[cfg(test)]
mod tests {
    use super::ReadMode;

    #[test]
    fn read_mode_is_bounded_and_preserves_default() {
        assert_eq!(ReadMode::default(), ReadMode::Chunk64Kib);
        for (value, mode) in [
            ("chunk-64k", ReadMode::Chunk64Kib),
            ("chunk-256k", ReadMode::Chunk256Kib),
            ("chunk-1m", ReadMode::Chunk1Mib),
            ("stream", ReadMode::Streaming),
        ] {
            assert_eq!(value.parse::<ReadMode>().unwrap(), mode);
        }
        for value in ["", "0", "unbounded", "STREAM", "stream "] {
            assert!(value.parse::<ReadMode>().is_err());
        }
    }
}
