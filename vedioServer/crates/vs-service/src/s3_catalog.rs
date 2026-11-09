use std::{future::IntoFuture, sync::Arc, time::Duration};

use futures_util::StreamExt;
use opendal::{ErrorKind, Operator};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use vs_core::{catalog::MediaAsset, valid_id};
use vs_storage::S3Config;

use crate::{
    publication::{
        CatalogPublication, MAX_CATALOG_BYTES, MAX_RELEASE_BYTES, catalog, catalog_release,
        decode_release, verify_catalog_release,
    },
    s3_publication::s3_operator,
};

const READ_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy)]
pub struct S3CatalogConfig {
    pub max_operations: usize,
    pub operation_timeout_ms: u64,
}

impl Default for S3CatalogConfig {
    fn default() -> Self {
        Self {
            max_operations: 2,
            operation_timeout_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogFailure {
    InvalidInput,
    Busy,
    Storage,
    TimedOut,
    ContentMismatch,
    Conflict,
}

#[derive(Debug, Serialize)]
pub struct CatalogError {
    pub kind: CatalogFailure,
    pub stage: &'static str,
    pub release_may_have_committed: bool,
}

impl CatalogError {
    fn new(kind: CatalogFailure, stage: &'static str) -> Self {
        Self {
            kind,
            stage,
            release_may_have_committed: false,
        }
    }
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let description = match self.kind {
            CatalogFailure::InvalidInput => "目录发布参数无效",
            CatalogFailure::Busy => "目录操作并发预算已满",
            CatalogFailure::Storage => "目录存储操作失败",
            CatalogFailure::TimedOut => "目录存储操作超时",
            CatalogFailure::ContentMismatch => "发布内容与声明不一致",
            CatalogFailure::Conflict => "发布键已绑定其他内容",
        };
        write!(formatter, "{description}，阶段：{}", self.stage)
    }
}

impl std::error::Error for CatalogError {}

#[derive(Clone)]
pub struct S3CatalogRepository {
    operator: Operator,
    config: S3CatalogConfig,
    slots: Arc<Semaphore>,
}

impl S3CatalogRepository {
    pub fn new(config: S3Config, limits: S3CatalogConfig) -> Result<Self, CatalogError> {
        if !(1..=8).contains(&limits.max_operations)
            || !(100..=120_000).contains(&limits.operation_timeout_ms)
        {
            return Err(CatalogError::new(CatalogFailure::InvalidInput, "limits"));
        }
        Ok(Self {
            operator: s3_operator(config)
                .map_err(|_| CatalogError::new(CatalogFailure::InvalidInput, "s3_configuration"))?,
            config: limits,
            slots: Arc::new(Semaphore::new(limits.max_operations)),
        })
    }

    async fn operation<T, E>(
        &self,
        stage: &'static str,
        future: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, CatalogError> {
        tokio::time::timeout(
            Duration::from_millis(self.config.operation_timeout_ms),
            future.into_future(),
        )
        .await
        .map_err(|_| CatalogError::new(CatalogFailure::TimedOut, stage))?
        .map_err(|_| CatalogError::new(CatalogFailure::Storage, stage))
    }

    async fn read_limited(
        &self,
        key: &str,
        maximum: usize,
        stage: &'static str,
    ) -> Result<Vec<u8>, CatalogError> {
        let metadata = self.operation(stage, self.operator.stat(key)).await?;
        let length = metadata.content_length();
        if length > maximum as u64 {
            return Err(CatalogError::new(CatalogFailure::ContentMismatch, stage));
        }
        let mut reader = self
            .operator
            .reader_with(key)
            .chunk(READ_BYTES)
            .concurrent(1);
        if let Some(etag) = metadata.etag() {
            reader = reader.if_match(etag);
        }
        let reader = self.operation(stage, reader).await?;
        let mut stream = self
            .operation(stage, reader.into_bytes_stream(0..length))
            .await?;
        let mut bytes = Vec::with_capacity(length as usize);
        while let Some(part) = self
            .operation(stage, async { stream.next().await.transpose() })
            .await?
        {
            if part.len() > length as usize - bytes.len() {
                return Err(CatalogError::new(CatalogFailure::ContentMismatch, stage));
            }
            bytes.extend_from_slice(&part);
        }
        if bytes.len() != length as usize {
            return Err(CatalogError::new(CatalogFailure::ContentMismatch, stage));
        }
        Ok(bytes)
    }

    async fn verify_asset(&self, asset: &MediaAsset) -> Result<(), CatalogError> {
        let key = asset.object_key();
        let metadata = self
            .operation("asset_metadata", self.operator.stat(&key))
            .await?;
        let length = metadata.content_length();
        if length != asset.bytes {
            return Err(CatalogError::new(
                CatalogFailure::ContentMismatch,
                "asset_length",
            ));
        }
        let mut reader = self
            .operator
            .reader_with(&key)
            .chunk(READ_BYTES)
            .concurrent(1);
        if let Some(etag) = metadata.etag() {
            reader = reader.if_match(etag);
        }
        let reader = self.operation("asset_reader", reader).await?;
        let mut stream = self
            .operation("asset_stream", reader.into_bytes_stream(0..length))
            .await?;
        let mut bytes = 0_u64;
        let mut hash = Sha256::new();
        while let Some(part) = self
            .operation("asset_body", async { stream.next().await.transpose() })
            .await?
        {
            bytes = bytes
                .checked_add(part.len() as u64)
                .filter(|bytes| *bytes <= length)
                .ok_or_else(|| {
                    CatalogError::new(CatalogFailure::ContentMismatch, "asset_length")
                })?;
            hash.update(&part);
        }
        if bytes != length || format!("{:x}", hash.finalize()) != asset.sha256 {
            return Err(CatalogError::new(
                CatalogFailure::ContentMismatch,
                "asset_digest",
            ));
        }
        Ok(())
    }

    async fn create_exact(
        &self,
        key: &str,
        bytes: &[u8],
        maximum: usize,
        stage: &'static str,
        final_commit: bool,
    ) -> Result<bool, CatalogError> {
        // 复用OpenDAL单次条件Put；不以先查后写代替服务端的不可覆盖条件。
        let result = tokio::time::timeout(
            Duration::from_millis(self.config.operation_timeout_ms),
            self.operator
                .write_with(key, bytes.to_vec())
                .if_not_exists(true)
                .into_future(),
        )
        .await;
        if matches!(result, Ok(Ok(_))) {
            return Ok(true);
        }
        let rejected = matches!(
            &result,
            Ok(Err(error)) if matches!(error.kind(), ErrorKind::ConditionNotMatch | ErrorKind::AlreadyExists)
        );
        // 条件竞争或响应丢失后只读核对；禁止覆盖、删除或盲重试提交。
        match self.read_limited(key, maximum, stage).await {
            Ok(existing) if existing == bytes => Ok(false),
            Ok(_) => Err(CatalogError::new(CatalogFailure::Conflict, stage)),
            Err(read_error) => {
                let kind = if result.is_err() {
                    CatalogFailure::TimedOut
                } else {
                    CatalogFailure::Storage
                };
                Err(CatalogError {
                    kind: if rejected { read_error.kind } else { kind },
                    stage,
                    release_may_have_committed: final_commit && !rejected,
                })
            }
        }
    }

    /// 顺序校验媒体并提交目录，最后条件创建版本记录；中断可留下未引用目录。
    pub async fn publish(&self, bytes: &[u8]) -> Result<CatalogPublication, CatalogError> {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| CatalogError::new(CatalogFailure::Busy, "admission"))?;
        let catalog = catalog(bytes)
            .map_err(|_| CatalogError::new(CatalogFailure::InvalidInput, "catalog"))?;
        for asset in &catalog.assets {
            self.verify_asset(asset).await?;
        }
        let release = catalog_release(&catalog, bytes);
        let release_bytes = serde_json::to_vec(&release)
            .map_err(|_| CatalogError::new(CatalogFailure::InvalidInput, "release_encoding"))?;
        let catalog_created = self
            .create_exact(
                &format!("catalogs/{}.json", release.catalog_sha256),
                bytes,
                MAX_CATALOG_BYTES,
                "catalog_commit",
                false,
            )
            .await?;
        let release_created = self
            .create_exact(
                &format!("releases/{}.json", release.version),
                &release_bytes,
                MAX_RELEASE_BYTES,
                "release_commit",
                true,
            )
            .await?;
        Ok(CatalogPublication {
            schema: "s3-catalog-publication-v1",
            assets_verified: release.asset_count,
            release,
            catalog_created,
            release_created,
        })
    }

    /// 只加载固定版本，不重读媒体正文；沿用发布阶段的资产验证边界。
    pub async fn load(&self, version: &str) -> Result<Vec<u8>, CatalogError> {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| CatalogError::new(CatalogFailure::Busy, "admission"))?;
        if !valid_id(version) {
            return Err(CatalogError::new(CatalogFailure::InvalidInput, "version"));
        }
        let marker = self
            .read_limited(
                &format!("releases/{version}.json"),
                MAX_RELEASE_BYTES,
                "release_read",
            )
            .await?;
        let release = decode_release(&marker, version)
            .map_err(|_| CatalogError::new(CatalogFailure::ContentMismatch, "release_decode"))?;
        let bytes = self
            .read_limited(
                &format!("catalogs/{}.json", release.catalog_sha256),
                MAX_CATALOG_BYTES,
                "catalog_read",
            )
            .await?;
        verify_catalog_release(&release, &bytes)
            .map_err(|_| CatalogError::new(CatalogFailure::ContentMismatch, "catalog_verify"))?;
        Ok(bytes)
    }
}
