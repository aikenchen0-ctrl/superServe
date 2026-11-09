use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::StreamExt;
use opendal::{ErrorKind, Operator, Writer, services};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncReadExt,
    sync::{Semaphore, oneshot},
};
use vs_core::catalog::MediaAsset;
use vs_storage::S3Config;

const READ_BYTES: usize = 64 * 1024;
const MIB: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct S3PublicationConfig {
    pub part_bytes: usize,
    pub max_uploads: usize,
    pub operation_timeout_ms: u64,
    pub cleanup_timeout_ms: u64,
}

impl Default for S3PublicationConfig {
    fn default() -> Self {
        Self {
            part_bytes: 5 * MIB,
            max_uploads: 2,
            operation_timeout_ms: 30_000,
            cleanup_timeout_ms: 10_000,
        }
    }
}

impl S3PublicationConfig {
    pub fn validate(self) -> Result<Self, PublicationError> {
        if !(5 * MIB..=32 * MIB).contains(&self.part_bytes)
            || !(1..=16).contains(&self.max_uploads)
            || !(100..=120_000).contains(&self.operation_timeout_ms)
            || !(100..=30_000).contains(&self.cleanup_timeout_ms)
        {
            return Err(PublicationError::new(
                Failure::InvalidInput,
                "configuration",
            ));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    InvalidInput,
    Busy,
    Cancelled,
    Source,
    ContentMismatch,
    Storage,
    Conflict,
    TimedOut,
    WorkerStopped,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Cleanup {
    NotRequired,
    AbortAcknowledged,
    Unconfirmed,
}

#[derive(Debug, Serialize)]
pub struct PublicationError {
    pub kind: Failure,
    pub stage: &'static str,
    pub cleanup: Cleanup,
    pub commit_may_have_succeeded: bool,
}

impl PublicationError {
    fn new(kind: Failure, stage: &'static str) -> Self {
        Self {
            kind,
            stage,
            cleanup: Cleanup::NotRequired,
            commit_may_have_succeeded: false,
        }
    }
}

impl std::fmt::Display for PublicationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let description = match self.kind {
            Failure::InvalidInput => "发布参数无效",
            Failure::Busy => "上传并发预算已满或发布器已关闭",
            Failure::Cancelled => "上传已取消",
            Failure::Source => "源文件读取失败",
            Failure::ContentMismatch => "对象内容与声明不符",
            Failure::Storage => "存储操作失败",
            Failure::Conflict => "条件提交冲突，需重新发起整个上传",
            Failure::TimedOut => "存储或源读取操作超时",
            Failure::WorkerStopped => "上传工作任务异常结束",
        };
        write!(formatter, "{description}，阶段：{}", self.stage)
    }
}

impl std::error::Error for PublicationError {}

#[derive(Debug, Serialize)]
pub struct S3Publication {
    pub schema: &'static str,
    pub object_key: String,
    pub sha256: String,
    pub bytes: u64,
    pub created: bool,
    pub source_verified: bool,
    pub existing_object_readback_verified: bool,
    pub cleanup: Cleanup,
}

#[derive(Default)]
struct Counters {
    accepted: AtomicU64,
    created: AtomicU64,
    reused: AtomicU64,
    cancelled: AtomicU64,
    failed: AtomicU64,
    cleanup_unconfirmed: AtomicU64,
    commit_uncertain: AtomicU64,
    source_bytes: AtomicU64,
    commit_started: AtomicU64,
}

#[derive(Debug, Serialize)]
pub struct S3PublicationMetrics {
    pub config: S3PublicationConfig,
    pub active_uploads: usize,
    pub accepted: u64,
    pub created: u64,
    pub reused: u64,
    pub cancelled: u64,
    pub failed: u64,
    pub cleanup_unconfirmed: u64,
    pub commit_uncertain: u64,
    pub source_bytes: u64,
    pub commit_started: u64,
}

struct Inner {
    operator: Operator,
    config: S3PublicationConfig,
    slots: Arc<Semaphore>,
    counters: Counters,
}

#[derive(Clone)]
pub struct S3Publisher {
    inner: Arc<Inner>,
}

pub struct UploadHandle {
    cancel: Option<oneshot::Sender<()>>,
    result: oneshot::Receiver<Result<S3Publication, PublicationError>>,
}

impl UploadHandle {
    pub fn cancel(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
    }

    pub async fn wait(mut self) -> Result<S3Publication, PublicationError> {
        (&mut self.result).await.unwrap_or_else(|_| {
            let mut error = PublicationError::new(Failure::WorkerStopped, "worker");
            error.cleanup = Cleanup::Unconfirmed;
            error.commit_may_have_succeeded = true;
            Err(error)
        })
    }
}

impl Drop for UploadHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub(crate) fn s3_operator(config: S3Config) -> opendal::Result<Operator> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    opendal_http_transport_reqwest::install_default();
    Operator::new(
        services::S3::default()
            .endpoint(&config.endpoint)
            .region(&config.region)
            .bucket(&config.bucket)
            .access_key_id(&config.access_key_id)
            .secret_access_key(&config.secret_access_key)
            .disable_config_load()
            .disable_ec2_metadata(),
    )
}

impl S3Publisher {
    pub fn new(config: S3Config, limits: S3PublicationConfig) -> Result<Self, PublicationError> {
        let limits = limits.validate()?;
        // 复用已锁定OpenDAL S3写入器，不复制签名、分段调度和底层不安全实现。
        let operator = s3_operator(config)
            .map_err(|_| PublicationError::new(Failure::InvalidInput, "s3_configuration"))?;
        Ok(Self {
            inner: Arc::new(Inner {
                operator,
                config: limits,
                slots: Arc::new(Semaphore::new(limits.max_uploads)),
                counters: Counters::default(),
            }),
        })
    }

    pub fn start_file(
        &self,
        path: PathBuf,
        asset: MediaAsset,
    ) -> Result<UploadHandle, PublicationError> {
        asset
            .validate()
            .map_err(|_| PublicationError::new(Failure::InvalidInput, "asset"))?;
        if asset.bytes.div_ceil(self.inner.config.part_bytes as u64) > 10_000 {
            return Err(PublicationError::new(Failure::InvalidInput, "part_count"));
        }
        let permit = self
            .inner
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| PublicationError::new(Failure::Busy, "admission"))?;
        let (cancel, cancellation) = oneshot::channel();
        let (response, result) = oneshot::channel();
        let inner = self.inner.clone();
        inner.counters.accepted.fetch_add(1, Ordering::Relaxed);
        // 清理与许可属于工作任务；等待者消失仅发取消信号，不中断已知上传的清理。
        tokio::spawn(async move {
            let _permit = permit;
            let outcome = inner.publish(path, asset, cancellation).await;
            match &outcome {
                Ok(receipt) => {
                    let counter = if receipt.created {
                        &inner.counters.created
                    } else {
                        &inner.counters.reused
                    };
                    counter.fetch_add(1, Ordering::Relaxed);
                    if receipt.cleanup == Cleanup::Unconfirmed {
                        inner
                            .counters
                            .cleanup_unconfirmed
                            .fetch_add(1, Ordering::Relaxed);
                    }
                }
                Err(error) => {
                    let counter = if error.kind == Failure::Cancelled {
                        &inner.counters.cancelled
                    } else {
                        &inner.counters.failed
                    };
                    counter.fetch_add(1, Ordering::Relaxed);
                    if error.cleanup == Cleanup::Unconfirmed {
                        inner
                            .counters
                            .cleanup_unconfirmed
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    if error.commit_may_have_succeeded {
                        inner
                            .counters
                            .commit_uncertain
                            .fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            let _ = response.send(outcome);
        });
        Ok(UploadHandle {
            cancel: Some(cancel),
            result,
        })
    }

    pub fn metrics(&self) -> S3PublicationMetrics {
        let read = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        let counters = &self.inner.counters;
        S3PublicationMetrics {
            config: self.inner.config,
            active_uploads: self.inner.config.max_uploads - self.inner.slots.available_permits(),
            accepted: read(&counters.accepted),
            created: read(&counters.created),
            reused: read(&counters.reused),
            cancelled: read(&counters.cancelled),
            failed: read(&counters.failed),
            cleanup_unconfirmed: read(&counters.cleanup_unconfirmed),
            commit_uncertain: read(&counters.commit_uncertain),
            source_bytes: read(&counters.source_bytes),
            commit_started: read(&counters.commit_started),
        }
    }

    pub async fn shutdown(&self) {
        if let Ok(permit) = self
            .inner
            .slots
            .acquire_many(self.inner.config.max_uploads as u32)
            .await
        {
            self.inner.slots.close();
            drop(permit);
        }
    }
}

fn cancelled(signal: &mut oneshot::Receiver<()>) -> bool {
    !matches!(signal.try_recv(), Err(oneshot::error::TryRecvError::Empty))
}

impl Inner {
    async fn operation<T>(
        &self,
        stage: &'static str,
        operation: impl std::future::IntoFuture<Output = opendal::Result<T>>,
    ) -> Result<T, PublicationError> {
        tokio::time::timeout(
            Duration::from_millis(self.config.operation_timeout_ms),
            operation.into_future(),
        )
        .await
        .map_err(|_| PublicationError::new(Failure::TimedOut, stage))?
        .map_err(|_| PublicationError::new(Failure::Storage, stage))
    }

    async fn verify_existing(
        &self,
        asset: &MediaAsset,
        cancellation: &mut oneshot::Receiver<()>,
    ) -> Result<(), PublicationError> {
        let key = asset.object_key();
        let metadata = self
            .operation("verify_metadata", self.operator.stat(&key))
            .await?;
        if metadata.content_length() != asset.bytes {
            return Err(PublicationError::new(
                Failure::ContentMismatch,
                "verify_length",
            ));
        }
        let reader = self
            .operation(
                "verify_reader",
                self.operator
                    .reader_with(&key)
                    .chunk(READ_BYTES)
                    .concurrent(1),
            )
            .await?;
        let mut stream = self
            .operation("verify_stream", reader.into_bytes_stream(0..asset.bytes))
            .await?;
        let mut bytes = 0_u64;
        let mut hash = Sha256::new();
        loop {
            if cancelled(cancellation) {
                return Err(PublicationError::new(Failure::Cancelled, "verify_existing"));
            }
            let part = tokio::time::timeout(
                Duration::from_millis(self.config.operation_timeout_ms),
                stream.next(),
            )
            .await
            .map_err(|_| PublicationError::new(Failure::TimedOut, "verify_body"))?;
            let Some(part) = part else { break };
            let part = part.map_err(|_| PublicationError::new(Failure::Storage, "verify_body"))?;
            bytes += part.len() as u64;
            if bytes > asset.bytes {
                return Err(PublicationError::new(
                    Failure::ContentMismatch,
                    "verify_length",
                ));
            }
            hash.update(&part);
        }
        if bytes != asset.bytes || format!("{:x}", hash.finalize()) != asset.sha256 {
            return Err(PublicationError::new(
                Failure::ContentMismatch,
                "verify_digest",
            ));
        }
        Ok(())
    }

    async fn abort(&self, writer: &mut Writer, uncertain: bool) -> Cleanup {
        match tokio::time::timeout(
            Duration::from_millis(self.config.cleanup_timeout_ms),
            writer.abort(),
        )
        .await
        {
            Ok(Ok(())) if !uncertain => Cleanup::AbortAcknowledged,
            _ => Cleanup::Unconfirmed,
        }
    }

    async fn publish(
        &self,
        path: PathBuf,
        asset: MediaAsset,
        mut cancellation: oneshot::Receiver<()>,
    ) -> Result<S3Publication, PublicationError> {
        let key = asset.object_key();
        if cancelled(&mut cancellation) {
            return Err(PublicationError::new(Failure::Cancelled, "before_start"));
        }
        let exists = tokio::time::timeout(
            Duration::from_millis(self.config.operation_timeout_ms),
            self.operator.stat(&key),
        )
        .await
        .map_err(|_| PublicationError::new(Failure::TimedOut, "preflight"))?;
        match exists {
            Ok(_) => {
                self.verify_existing(&asset, &mut cancellation).await?;
                return Ok(receipt(&asset, false, false, Cleanup::NotRequired));
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(PublicationError::new(Failure::Storage, "preflight")),
        }
        let metadata = tokio::time::timeout(
            Duration::from_millis(self.config.operation_timeout_ms),
            tokio::fs::symlink_metadata(&path),
        )
        .await
        .map_err(|_| PublicationError::new(Failure::TimedOut, "source_metadata"))?
        .map_err(|_| PublicationError::new(Failure::Source, "source_metadata"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != asset.bytes
        {
            return Err(PublicationError::new(
                Failure::InvalidInput,
                "source_metadata",
            ));
        }
        let mut source = tokio::time::timeout(
            Duration::from_millis(self.config.operation_timeout_ms),
            tokio::fs::File::open(path),
        )
        .await
        .map_err(|_| PublicationError::new(Failure::TimedOut, "source_open"))?
        .map_err(|_| PublicationError::new(Failure::Source, "source_open"))?;
        let mut writer = self
            .operation(
                "writer",
                self.operator
                    .writer_with(&key)
                    .if_not_exists(true)
                    .content_type(&asset.content_type)
                    .chunk(self.config.part_bytes)
                    .concurrent(1),
            )
            .await?;
        let transfer = async {
            let mut buffer = vec![0_u8; READ_BYTES];
            let mut total = 0_u64;
            let mut hash = Sha256::new();
            loop {
                if cancelled(&mut cancellation) {
                    return Err(PublicationError::new(Failure::Cancelled, "transfer"));
                }
                let length = tokio::time::timeout(
                    Duration::from_millis(self.config.operation_timeout_ms),
                    source.read(&mut buffer),
                )
                .await
                .map_err(|_| PublicationError::new(Failure::TimedOut, "source_read"))?
                .map_err(|_| PublicationError::new(Failure::Source, "source_read"))?;
                if length == 0 {
                    break;
                }
                total += length as u64;
                if total > asset.bytes {
                    return Err(PublicationError::new(
                        Failure::ContentMismatch,
                        "source_length",
                    ));
                }
                hash.update(&buffer[..length]);
                // 不在请求中途丢弃创建上传ID的Future；先等当前有界操作结束，再观察取消。
                self.operation("write", writer.write(buffer[..length].to_vec()))
                    .await?;
                self.counters
                    .source_bytes
                    .fetch_add(length as u64, Ordering::Relaxed);
            }
            if total != asset.bytes || format!("{:x}", hash.finalize()) != asset.sha256 {
                return Err(PublicationError::new(
                    Failure::ContentMismatch,
                    "source_digest",
                ));
            }
            if cancelled(&mut cancellation) {
                return Err(PublicationError::new(Failure::Cancelled, "before_commit"));
            }
            Ok(())
        }
        .await;
        if let Err(mut error) = transfer {
            let uncertain = error.stage == "write";
            error.cleanup = self.abort(&mut writer, uncertain).await;
            return Err(error);
        }
        // 完成提交后不再按取消删除目标；响应丢失可能仍已提交，禁止重试同一次close。
        self.counters.commit_started.fetch_add(1, Ordering::Relaxed);
        let completed = tokio::time::timeout(
            Duration::from_millis(self.config.operation_timeout_ms),
            writer.close(),
        )
        .await;
        match completed {
            Ok(Ok(_)) => Ok(receipt(&asset, true, true, Cleanup::NotRequired)),
            Ok(Err(error)) if error.kind() == ErrorKind::ConditionNotMatch => {
                let cleanup = self.abort(&mut writer, false).await;
                self.verify_existing(&asset, &mut cancellation)
                    .await
                    .map_err(|mut error| {
                        error.cleanup = cleanup;
                        error
                    })?;
                Ok(receipt(&asset, false, true, cleanup))
            }
            outcome => {
                let kind = match &outcome {
                    Err(_) => Failure::TimedOut,
                    Ok(Err(error)) if error.kind() == ErrorKind::Conflict => Failure::Conflict,
                    _ => Failure::Storage,
                };
                let mut error = PublicationError::new(kind, "commit");
                error.cleanup = self.abort(&mut writer, kind != Failure::Conflict).await;
                error.commit_may_have_succeeded = kind != Failure::Conflict;
                Err(error)
            }
        }
    }
}

fn receipt(
    asset: &MediaAsset,
    created: bool,
    source_verified: bool,
    cleanup: Cleanup,
) -> S3Publication {
    S3Publication {
        schema: "s3-media-publication-v1",
        object_key: asset.object_key(),
        sha256: asset.sha256.clone(),
        bytes: asset.bytes,
        created,
        source_verified,
        existing_object_readback_verified: !created,
        cleanup,
    }
}
