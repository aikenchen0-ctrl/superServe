// SPDX-License-Identifier: MIT
// 加权缓存与异步加载守卫调用改编自 arthurprs/quick-cache 的README及src/sync.rs，
// 参考提交99809ceaeb8b494a5425054711b7bb02fceb79ee；实际内核使用锁定发布依赖。
// 增加内容寻址、精确范围、加载预算、完整性检查、按需轮询及取消观测。

use std::{
    io,
    ops::Range,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
};

use bytes::{Bytes, BytesMut};
use futures_util::{Stream, StreamExt, TryStreamExt, stream};
use opendal::FuturesBytesStream;
use quick_cache::{OptionsBuilder, Weighter, sync::Cache};
use serde::Serialize;
use tokio::sync::Semaphore;

use crate::{MediaStore, ReadMode};

const MIN_CHARGE: usize = 4096;
const BLOCK_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
pub enum MediaCachePolicy {
    #[default]
    #[serde(rename = "exact")]
    Exact,
    #[serde(rename = "block-64k")]
    Block64Kib,
    #[serde(rename = "block-64k-stream")]
    Block64KibStream,
}

impl std::str::FromStr for MediaCachePolicy {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "exact" => Ok(Self::Exact),
            "block-64k" => Ok(Self::Block64Kib),
            "block-64k-stream" => Ok(Self::Block64KibStream),
            _ => Err("媒体缓存策略必须为exact、block-64k或block-64k-stream"),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct MediaCacheConfig {
    pub capacity_bytes: u64,
    pub max_entry_bytes: usize,
    pub max_fill_concurrency: usize,
}

impl Default for MediaCacheConfig {
    fn default() -> Self {
        Self {
            capacity_bytes: 8 * 1024 * 1024,
            max_entry_bytes: 64 * 1024,
            max_fill_concurrency: 4,
        }
    }
}

impl MediaCacheConfig {
    pub fn validate(self) -> io::Result<Self> {
        if !(16 * 1024..=512 * 1024 * 1024).contains(&self.capacity_bytes)
            || !self.capacity_bytes.is_multiple_of(MIN_CHARGE as u64)
            || !(1..=1024 * 1024).contains(&self.max_entry_bytes)
            || self.max_entry_bytes as u64 > self.capacity_bytes / 4
            || !(1..=64).contains(&self.max_fill_concurrency)
        {
            return Err(io::Error::other("媒体缓存容量、条目或加载并发配置越界"));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
struct RangeKey {
    digest: [u8; 32],
    asset_bytes: u64,
    start: u64,
    end: u64,
}

impl RangeKey {
    fn new(hash: &str, asset_bytes: u64, range: Range<u64>) -> io::Result<Self> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
            || range.start >= range.end
            || range.end > asset_bytes
        {
            return Err(io::Error::other("已发布媒体的指纹、长度或范围无效"));
        }
        let mut digest = [0; 32];
        for (index, part) in hash.as_bytes().chunks_exact(2).enumerate() {
            let nibble = |value: u8| {
                if value.is_ascii_digit() {
                    value - b'0'
                } else {
                    value - b'a' + 10
                }
            };
            digest[index] = nibble(part[0]) * 16 + nibble(part[1]);
        }
        Ok(Self {
            digest,
            asset_bytes,
            start: range.start,
            end: range.end,
        })
    }
}

#[derive(Clone)]
struct ByteWeighter;

impl Weighter<RangeKey, Bytes> for ByteWeighter {
    fn weight(&self, _: &RangeKey, bytes: &Bytes) -> u64 {
        // 小条目也占用最低权重，避免微小Range造成元数据无界增长。
        bytes.len().max(MIN_CHARGE) as u64
    }
}

#[derive(Default)]
struct Counters {
    hits: AtomicU64,
    misses: AtomicU64,
    reused_after_miss: AtomicU64,
    reused_bytes: AtomicU64,
    fills_started: AtomicU64,
    fills_completed: AtomicU64,
    fills_failed: AtomicU64,
    fills_cancelled: AtomicU64,
    bypasses: AtomicU64,
    block_lookups: AtomicU64,
    crossing_block_fallbacks: AtomicU64,
    requested_body_bytes: AtomicU64,
    fill_range_bytes: AtomicU64,
    fill_received_bytes: AtomicU64,
    extra_fill_range_bytes: AtomicU64,
    early_yielded_bytes: AtomicU64,
}

#[derive(Debug, Serialize)]
pub struct MediaCacheMetrics {
    pub config: MediaCacheConfig,
    pub policy: MediaCachePolicy,
    pub resident_weight_bytes: u64,
    pub index_allocation_bytes: usize,
    pub entries: usize,
    pub active_fills: usize,
    pub hits: u64,
    pub misses: u64,
    pub reused_after_miss: u64,
    pub reused_bytes: u64,
    pub fills_started: u64,
    pub fills_completed: u64,
    pub fills_failed: u64,
    pub fills_cancelled: u64,
    pub bypasses: u64,
    pub block_lookups: u64,
    pub crossing_block_fallbacks: u64,
    pub requested_body_bytes: u64,
    pub fill_range_bytes: u64,
    pub fill_received_bytes: u64,
    pub extra_fill_range_bytes: u64,
    pub early_yielded_bytes: u64,
}

pub(crate) struct MediaCache {
    config: MediaCacheConfig,
    policy: MediaCachePolicy,
    entries: Cache<RangeKey, Bytes, ByteWeighter>,
    fill_slots: Arc<Semaphore>,
    counters: Arc<Counters>,
}

struct FillGuard {
    counters: Arc<Counters>,
    finished: bool,
}

impl FillGuard {
    fn finish(&mut self, success: bool) {
        let target = if success {
            &self.counters.fills_completed
        } else {
            &self.counters.fills_failed
        };
        target.fetch_add(1, Ordering::Relaxed);
        self.finished = true;
    }
}

impl Drop for FillGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.counters
                .fills_cancelled
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub struct PublishedStream {
    inner: StreamKind,
}

#[allow(
    clippy::large_enum_variant,
    reason = "默认直通路径保留流内联，避免每个无缓存请求新增一次堆分配"
)]
enum StreamKind {
    Direct(FuturesBytesStream),
    Memory(Option<Bytes>),
    Lazy(stream::BoxStream<'static, io::Result<Bytes>>),
}

impl PublishedStream {
    fn direct(source: FuturesBytesStream) -> Self {
        Self {
            inner: StreamKind::Direct(source),
        }
    }

    fn memory(bytes: Bytes) -> Self {
        Self {
            inner: StreamKind::Memory(Some(bytes)),
        }
    }
}

impl Stream for PublishedStream {
    type Item = io::Result<Bytes>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match &mut self.get_mut().inner {
            StreamKind::Direct(source) => Pin::new(source).poll_next(cx),
            StreamKind::Memory(bytes) => Poll::Ready(bytes.take().map(Ok)),
            StreamKind::Lazy(source) => source.as_mut().poll_next(cx),
        }
    }
}

impl MediaCache {
    pub(crate) fn new(config: MediaCacheConfig, policy: MediaCachePolicy) -> io::Result<Self> {
        let config = config.validate()?;
        if policy != MediaCachePolicy::Exact && config.max_entry_bytes < BLOCK_BYTES as usize {
            return Err(io::Error::other("64KiB块缓存需要至少64KiB条目预算"));
        }
        let options = OptionsBuilder::new()
            .shards(4)
            .weight_capacity(config.capacity_bytes)
            .estimated_items_capacity(config.capacity_bytes as usize / MIN_CHARGE)
            .build()
            .map_err(io::Error::other)?;
        Ok(Self {
            entries: Cache::with_options(
                options,
                ByteWeighter,
                Default::default(),
                Default::default(),
            ),
            fill_slots: Arc::new(Semaphore::new(config.max_fill_concurrency)),
            counters: Arc::default(),
            config,
            policy,
        })
    }

    pub(crate) fn metrics(&self) -> MediaCacheMetrics {
        let read = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        // 分别观测逻辑权重和索引分配；不把它们当作进程RSS或仍被响应体持有的总字节。
        MediaCacheMetrics {
            config: self.config,
            policy: self.policy,
            resident_weight_bytes: self.entries.weight(),
            index_allocation_bytes: self.entries.memory_used().total(),
            entries: self.entries.len(),
            active_fills: self.config.max_fill_concurrency - self.fill_slots.available_permits(),
            hits: read(&self.counters.hits),
            misses: read(&self.counters.misses),
            reused_after_miss: read(&self.counters.reused_after_miss),
            reused_bytes: read(&self.counters.reused_bytes),
            fills_started: read(&self.counters.fills_started),
            fills_completed: read(&self.counters.fills_completed),
            fills_failed: read(&self.counters.fills_failed),
            fills_cancelled: read(&self.counters.fills_cancelled),
            bypasses: read(&self.counters.bypasses),
            block_lookups: read(&self.counters.block_lookups),
            crossing_block_fallbacks: read(&self.counters.crossing_block_fallbacks),
            requested_body_bytes: read(&self.counters.requested_body_bytes),
            fill_range_bytes: read(&self.counters.fill_range_bytes),
            fill_received_bytes: read(&self.counters.fill_received_bytes),
            extra_fill_range_bytes: read(&self.counters.extra_fill_range_bytes),
            early_yielded_bytes: read(&self.counters.early_yielded_bytes),
        }
    }

    fn lookup_key(&self, mut key: RangeKey) -> RangeKey {
        self.counters
            .requested_body_bytes
            .fetch_add(key.end - key.start, Ordering::Relaxed);
        if self.policy != MediaCachePolicy::Exact {
            let start = key.start / BLOCK_BYTES * BLOCK_BYTES;
            let end = start.saturating_add(BLOCK_BYTES).min(key.asset_bytes);
            if key.end <= end {
                self.counters.block_lookups.fetch_add(1, Ordering::Relaxed);
                key.start = start;
                key.end = end;
            } else {
                self.counters
                    .crossing_block_fallbacks
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
        key
    }

    fn start_fill(&self, length: usize, requested_length: u64) -> FillGuard {
        self.counters.fills_started.fetch_add(1, Ordering::Relaxed);
        self.counters
            .fill_range_bytes
            .fetch_add(length as u64, Ordering::Relaxed);
        self.counters
            .extra_fill_range_bytes
            .fetch_add(length as u64 - requested_length, Ordering::Relaxed);
        FillGuard {
            counters: self.counters.clone(),
            finished: false,
        }
    }

    async fn read(
        &self,
        store: &MediaStore,
        key: RangeKey,
        object_key: &str,
    ) -> io::Result<PublishedStream> {
        let requested = key.start..key.end;
        let requested_length = requested.end - requested.start;
        let key = self.lookup_key(key);
        let length = (key.end - key.start) as usize;
        if let Some(bytes) = self.entries.get(&key) {
            self.counters.hits.fetch_add(1, Ordering::Relaxed);
            self.counters
                .reused_bytes
                .fetch_add(requested_length, Ordering::Relaxed);
            return memory_slice(bytes, key, requested);
        }
        self.counters.misses.fetch_add(1, Ordering::Relaxed);
        match self.entries.get_value_or_guard_async(&key).await {
            Ok(bytes) => {
                self.counters
                    .reused_after_miss
                    .fetch_add(1, Ordering::Relaxed);
                self.counters
                    .reused_bytes
                    .fetch_add(requested_length, Ordering::Relaxed);
                memory_slice(bytes, key, requested)
            }
            Err(guard) => {
                let Ok(_permit) = self.fill_slots.clone().try_acquire_owned() else {
                    self.counters.bypasses.fetch_add(1, Ordering::Relaxed);
                    drop(guard);
                    return store
                        .stream(object_key, requested)
                        .await
                        .map(PublishedStream::direct)
                        .map_err(io::Error::other);
                };
                let mut fill = self.start_fill(length, requested_length);
                let result = async {
                    let mut source = store
                        .stream(object_key, key.start..key.end)
                        .await
                        .map_err(io::Error::other)?;
                    let mut buffer = BytesMut::with_capacity(length);
                    while let Some(part) = source.next().await {
                        let part = part?;
                        self.counters
                            .fill_received_bytes
                            .fetch_add(part.len() as u64, Ordering::Relaxed);
                        if part.len() > length - buffer.len() {
                            return Err(io::Error::other("存储正文超过请求范围，拒绝缓存"));
                        }
                        buffer.extend_from_slice(&part);
                    }
                    if buffer.len() != length {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "存储正文未完成，拒绝缓存",
                        ));
                    }
                    Ok(buffer.freeze())
                }
                .await;
                fill.finish(result.is_ok());
                let bytes = result?;
                // 守卫由当前响应体持有；取消会释放读取和许可，库负责唤醒下一等待者。
                let _ = guard.insert(bytes.clone());
                memory_slice(bytes, key, requested)
            }
        }
    }

    fn progressive(
        self: Arc<Self>,
        store: MediaStore,
        key: RangeKey,
        object_key: String,
    ) -> PublishedStream {
        // 生成器保留借用缓存的加载守卫，无需自引用结构、后台任务或另一份单飞表。
        let source = async_stream::stream! {
            let requested = key.start..key.end;
            let requested_length = requested.end - requested.start;
            let key = self.lookup_key(key);
            if let Some(bytes) = self.entries.get(&key) {
                self.counters.hits.fetch_add(1, Ordering::Relaxed);
                self.counters.reused_bytes.fetch_add(requested_length, Ordering::Relaxed);
                yield cached_slice(bytes, key, requested);
                return;
            }
            self.counters.misses.fetch_add(1, Ordering::Relaxed);
            let guard = match self.entries.get_value_or_guard_async(&key).await {
                Ok(bytes) => {
                    self.counters.reused_after_miss.fetch_add(1, Ordering::Relaxed);
                    self.counters.reused_bytes.fetch_add(requested_length, Ordering::Relaxed);
                    yield cached_slice(bytes, key, requested);
                    return;
                }
                Err(guard) => guard,
            };
            let Ok(permit) = self.fill_slots.clone().try_acquire_owned() else {
                self.counters.bypasses.fetch_add(1, Ordering::Relaxed);
                drop(guard);
                match store.stream(&object_key, requested).await {
                    Ok(mut source) => {
                        while let Some(part) = source.next().await {
                            let failed = part.is_err();
                            yield part;
                            if failed {
                                return;
                            }
                        }
                    }
                    Err(error) => yield Err(io::Error::other(error)),
                }
                return;
            };
            let length = (key.end - key.start) as usize;
            let mut fill = self.start_fill(length, requested_length);
            let requested_end = (requested.end - key.start) as usize;
            let mut emitted = (requested.start - key.start) as usize;
            let mut buffer = BytesMut::with_capacity(length);
            // 不使用chunk整块收集，否则生成器也无法提前交付底层尚未产出的数据。
            let result = match store.with_read_mode(ReadMode::Streaming)
                .stream(&object_key, key.start..key.end).await
            {
                Err(error) => Err(io::Error::other(error)),
                Ok(mut source) => loop {
                    let part = match source.next().await {
                        Some(Ok(part)) => part,
                        Some(Err(error)) => break Err(error),
                        None if buffer.len() == length => break Ok(buffer.freeze()),
                        None => break Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof, "存储正文未完成，拒绝缓存",
                        )),
                    };
                    self.counters.fill_received_bytes.fetch_add(part.len() as u64, Ordering::Relaxed);
                    if part.len() > length - buffer.len() {
                        break Err(io::Error::other("存储正文超过请求范围，拒绝缓存"));
                    }
                    let previous = buffer.len();
                    buffer.extend_from_slice(&part);
                    // 留住最后一字节，防止HTTP按Content-Length结束后丢弃尚未校验的块尾。
                    let ready = buffer.len().min(requested_end - 1);
                    if ready > emitted {
                        let bytes = part.slice(emitted - previous..ready - previous);
                        emitted = ready;
                        self.counters.early_yielded_bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                        yield Ok(bytes);
                    }
                },
            };
            fill.finish(result.is_ok());
            drop(permit);
            match result {
                Ok(bytes) => {
                    let _ = guard.insert(bytes.clone());
                    yield Ok(bytes.slice(emitted..requested_end));
                }
                Err(error) => {
                    drop(guard);
                    yield Err(error);
                }
            }
        }.boxed();
        PublishedStream {
            inner: StreamKind::Lazy(source),
        }
    }
}

fn memory_slice(bytes: Bytes, key: RangeKey, requested: Range<u64>) -> io::Result<PublishedStream> {
    cached_slice(bytes, key, requested).map(PublishedStream::memory)
}

fn cached_slice(bytes: Bytes, key: RangeKey, requested: Range<u64>) -> io::Result<Bytes> {
    if requested.start < key.start
        || requested.end > key.end
        || bytes.len() as u64 != key.end - key.start
    {
        return Err(io::Error::other("缓存正文与原请求范围不一致"));
    }
    Ok(bytes.slice((requested.start - key.start) as usize..(requested.end - key.start) as usize))
}

impl MediaStore {
    pub fn with_media_cache(self, config: MediaCacheConfig) -> io::Result<Self> {
        self.with_media_cache_policy(config, MediaCachePolicy::Exact)
    }

    pub fn with_media_cache_policy(
        mut self,
        config: MediaCacheConfig,
        policy: MediaCachePolicy,
    ) -> io::Result<Self> {
        self.cache = Some(Arc::new(MediaCache::new(config, policy)?));
        Ok(self)
    }

    pub fn media_cache_metrics(&self) -> Option<MediaCacheMetrics> {
        self.cache.as_ref().map(|cache| cache.metrics())
    }

    pub async fn published_stream(
        &self,
        hash: &str,
        asset_bytes: u64,
        range: Range<u64>,
    ) -> io::Result<PublishedStream> {
        let key = RangeKey::new(hash, asset_bytes, range.clone())?;
        let object_key = format!("media/{hash}");
        let Some(cache) = &self.cache else {
            return self
                .stream(&object_key, range)
                .await
                .map(PublishedStream::direct)
                .map_err(io::Error::other);
        };
        if key.end - key.start > cache.config.max_entry_bytes as u64
            || self.read_mode == ReadMode::Streaming
        {
            cache.counters.bypasses.fetch_add(1, Ordering::Relaxed);
            return self
                .stream(&object_key, range)
                .await
                .map(PublishedStream::direct)
                .map_err(io::Error::other);
        }
        let cache = cache.clone();
        let store = self.clone();
        if cache.policy == MediaCachePolicy::Block64KibStream {
            return Ok(cache.progressive(store, key, object_key));
        }
        // 不在处理函数中预取；客户端开始拉响应体后才加入合并或读取存储。
        let source = stream::once(async move { cache.read(&store, key, &object_key).await })
            .try_flatten()
            .boxed();
        Ok(PublishedStream {
            inner: StreamKind::Lazy(source),
        })
    }
}
