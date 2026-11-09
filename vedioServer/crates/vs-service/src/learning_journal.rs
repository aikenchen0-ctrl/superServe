use std::{
    collections::{HashMap, VecDeque},
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    learning::is_sha256,
    recommendation::{RecommendationRequest, RecommendationResponse, RequestContext},
    valid_id,
};

use crate::{ApiError, AppState, upstream::event_envelope::EventEnvelope};

pub const MAX_JOURNAL_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_DECISION_BYTES: usize = 64 * 1024;
const WRITE_SLOTS: usize = 4;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LearningCommitMode {
    #[default]
    Single,
    Grouped,
}

impl LearningCommitMode {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "single" => Ok(Self::Single),
            "grouped" => Ok(Self::Grouped),
            _ => Err("学习日志提交方式必须为single或grouped"),
        }
    }

    fn batch_limit(self) -> usize {
        match self {
            Self::Single => 1,
            Self::Grouped => WRITE_SLOTS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionPayload {
    pub snapshot_at: u64,
    pub issued_at: u64,
    pub subject: String,
    pub request: RecommendationRequest,
    pub returned_ids: Vec<String>,
    pub ranker: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionMetadata {
    pub catalog_sha256: String,
    pub model_sha256: Option<String>,
    pub previous_decision_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slate_policy: Option<vs_core::slate::SlatePolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionRecord {
    pub schema: String,
    pub decision_id: String,
    pub envelope: EventEnvelope<DecisionPayload, DecisionMetadata>,
}

fn decision_id(
    envelope: &EventEnvelope<DecisionPayload, DecisionMetadata>,
) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(if envelope.metadata.slate_policy.is_some() {
        b"vs-learning-decision-v2\0"
    } else {
        b"vs-learning-decision-v1\0"
    });
    hash.update(serde_json::to_vec(envelope).map_err(|_| "决策序列化失败")?);
    Ok(format!("{:x}", hash.finalize()))
}

impl DecisionRecord {
    fn validate(
        &self,
        catalog: &HashMap<&str, &Candidate>,
        catalog_sha256: &str,
    ) -> Result<(), String> {
        let envelope = &self.envelope;
        let payload = &envelope.payload;
        let expected_schema = if envelope.metadata.slate_policy.is_some() {
            "learning-decision-v2"
        } else {
            "learning-decision-v1"
        };
        if self.schema != expected_schema
            || envelope
                .metadata
                .slate_policy
                .as_ref()
                .is_some_and(|policy| policy.validate().is_err())
            || !valid_id(&envelope.aggregate_id)
            || envelope.sequence == 0
            || !valid_id(&payload.subject)
            || payload.snapshot_at > payload.issued_at
            || envelope.metadata.catalog_sha256 != catalog_sha256
            || !is_sha256(catalog_sha256)
            || payload
                .request
                .profile
                .as_ref()
                .is_some_and(|profile| profile.subject != payload.subject)
            || payload.returned_ids.len() > payload.request.limit
            || !matches!(
                (payload.ranker.as_str(), &envelope.metadata.model_sha256),
                ("tag-affinity-v1", None) | ("ftrl-ranker-v1", Some(_))
            )
            || envelope
                .metadata
                .model_sha256
                .as_ref()
                .is_some_and(|hash| !is_sha256(hash))
            || self.decision_id != decision_id(envelope)?
        {
            return Err("决策记录、主体、模型或目录绑定无效".into());
        }
        let context = RequestContext::new(&payload.request, payload.issued_at)
            .map_err(|_| "决策画像投影无效或过期")?;
        let mut seen = std::collections::HashSet::new();
        for id in &payload.returned_ids {
            if !seen.insert(id)
                || !catalog
                    .get(id.as_str())
                    .is_some_and(|item| context.allows(item))
            {
                return Err("决策包含未授权、重复或不存在的候选".into());
            }
        }
        Ok(())
    }
}

/// 导入完整、固定的日志快照；残缺尾部和中间缺行均拒绝，不自动修复来源。
pub(crate) fn parse_decisions(
    bytes: &[u8],
    catalog: &PublicCatalog,
    catalog_sha256: &str,
) -> Result<Vec<DecisionRecord>, String> {
    if bytes.len() > MAX_JOURNAL_BYTES || (!bytes.is_empty() && !bytes.ends_with(b"\n")) {
        return Err("决策日志超过预算或尾部不完整".into());
    }
    let mut records: Vec<DecisionRecord> = Vec::new();
    let catalog = catalog
        .items
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if line.len() > MAX_DECISION_BYTES {
            return Err("决策记录超过预算".into());
        }
        let record: DecisionRecord =
            serde_json::from_slice(line).map_err(|_| "决策日志JSON无效")?;
        record.validate(&catalog, catalog_sha256)?;
        let expected = records.len() as u64 + 1;
        let previous = records.last();
        if record.envelope.sequence != expected
            || record.envelope.metadata.previous_decision_id
                != previous.map_or("", |record| record.decision_id.as_str())
            || previous.is_some_and(|previous| {
                previous.envelope.aggregate_id != record.envelope.aggregate_id
                    || previous.envelope.payload.issued_at > record.envelope.payload.issued_at
            })
        {
            return Err("决策日志来源、顺序或前项指纹不连续".into());
        }
        records.push(record);
    }
    Ok(records)
}

struct JournalWriter {
    file: File,
    sequence: u64,
    bytes: usize,
    previous: String,
    last_issued_at: u64,
}

struct PendingWrite {
    payload: DecisionPayload,
    metadata: DecisionMetadata,
    reply: oneshot::Sender<Result<String, String>>,
    _permit: OwnedSemaphorePermit,
}

struct JournalQueue {
    pending: Mutex<VecDeque<PendingWrite>>,
    wake: Condvar,
    shutdown: AtomicBool,
}

struct WorkerLiveness {
    queue: Arc<JournalQueue>,
    usable: Arc<AtomicBool>,
}

impl Drop for WorkerLiveness {
    fn drop(&mut self) {
        self.usable.store(false, Ordering::Release);
        // 写者异常退出也要释放排队许可和确认通道，不能把等待者永久留在内存。
        let mut pending = self
            .queue
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.clear();
    }
}

pub(crate) struct LearningJournal {
    mode: LearningCommitMode,
    #[cfg(test)]
    writer: Arc<Mutex<JournalWriter>>,
    queue: Arc<JournalQueue>,
    worker: Mutex<Option<JoinHandle<()>>>,
    slots: Arc<Semaphore>,
    usable: Arc<AtomicBool>,
    counters: Arc<CommitCounters>,
}

#[derive(Default)]
struct CommitCounters {
    sync_calls: AtomicU64,
    committed_batches: AtomicU64,
    committed_records: AtomicU64,
    failures: AtomicU64,
    max_batch_records: AtomicU64,
}

impl LearningJournal {
    fn open(
        path: &Path,
        source_id: &str,
        catalog: &PublicCatalog,
        hash: &str,
        mode: LearningCommitMode,
    ) -> Result<Self, String> {
        if !valid_id(source_id) {
            return Err("学习日志副本标识无效".into());
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).map_err(|_| "学习日志打开失败")?;
        file.try_lock().map_err(|_| "学习日志已有写入者")?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_JOURNAL_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "学习日志读取失败")?;
        let mut sequence = 0;
        let mut previous = String::new();
        let mut last_issued_at = 0;
        if bytes.len() > MAX_JOURNAL_BYTES
            || (!bytes.is_empty() && !bytes.ends_with(b"\n"))
            || bytes.starts_with(b"\n")
            || bytes.windows(2).any(|pair| pair == b"\n\n")
        {
            return Err("学习日志超过预算、包含空行或尾部不完整".into());
        }
        let catalog = catalog
            .items
            .iter()
            .map(|item| (item.id.as_str(), item))
            .collect();
        // 启动逐行校验，避免为恢复而同时展开整份画像日志。
        let reader = BufReader::new(bytes.as_slice());
        for line in reader.split(b'\n') {
            let line = line.map_err(|_| "学习日志读取失败")?;
            if line.is_empty() {
                continue;
            }
            let record: DecisionRecord =
                serde_json::from_slice(&line).map_err(|_| "学习日志JSON无效")?;
            if line.len() + 1 > MAX_DECISION_BYTES
                || record.envelope.aggregate_id != source_id
                || record.envelope.sequence != sequence + 1
                || record.envelope.metadata.previous_decision_id != previous
                || record.envelope.payload.issued_at < last_issued_at
            {
                return Err("学习日志副本标识或顺序不匹配".into());
            }
            record.validate(&catalog, hash)?;
            sequence += 1;
            previous = record.decision_id;
            last_issued_at = record.envelope.payload.issued_at;
        }
        file.seek(SeekFrom::End(0))
            .map_err(|_| "学习日志定位失败")?;
        let writer = Arc::new(Mutex::new(JournalWriter {
            file,
            sequence,
            bytes: bytes.len(),
            previous,
            last_issued_at,
        }));
        let queue = Arc::new(JournalQueue {
            pending: Mutex::new(VecDeque::new()),
            wake: Condvar::new(),
            shutdown: AtomicBool::new(false),
        });
        let usable = Arc::new(AtomicBool::new(true));
        let counters = Arc::new(CommitCounters::default());
        let worker = spawn_worker(
            writer.clone(),
            queue.clone(),
            usable.clone(),
            source_id.to_string(),
            mode.batch_limit(),
            counters.clone(),
        )?;
        Ok(Self {
            mode,
            #[cfg(test)]
            writer,
            queue,
            worker: Mutex::new(Some(worker)),
            slots: Arc::new(Semaphore::new(WRITE_SLOTS)),
            usable,
            counters,
        })
    }

    async fn submit(
        &self,
        payload: DecisionPayload,
        metadata: DecisionMetadata,
        permit: OwnedSemaphorePermit,
    ) -> Result<String, String> {
        if !self.usable.load(Ordering::Acquire) {
            return Err("学习日志已停止写入".into());
        }
        let (reply, result) = oneshot::channel();
        {
            let mut pending = self
                .queue
                .pending
                .lock()
                .map_err(|_| "学习日志队列锁不可用")?;
            if !self.usable.load(Ordering::Acquire)
                || self.queue.shutdown.load(Ordering::Acquire)
                || pending.len() >= WRITE_SLOTS
            {
                return Err("学习日志队列不可接纳".into());
            }
            pending.push_back(PendingWrite {
                payload,
                metadata,
                reply,
                _permit: permit,
            });
        }
        self.queue.wake.notify_one();
        result.await.map_err(|_| "学习日志任务已退出")?
    }

    fn metrics(&self) -> LearningJournalMetrics {
        LearningJournalMetrics {
            mode: self.mode,
            sync_calls: self.counters.sync_calls.load(Ordering::Relaxed),
            committed_batches: self.counters.committed_batches.load(Ordering::Relaxed),
            committed_records: self.counters.committed_records.load(Ordering::Relaxed),
            failures: self.counters.failures.load(Ordering::Relaxed),
            max_batch_records: self.counters.max_batch_records.load(Ordering::Relaxed),
            usable: self.usable.load(Ordering::Acquire),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct LearningJournalMetrics {
    pub mode: LearningCommitMode,
    pub sync_calls: u64,
    pub committed_batches: u64,
    pub committed_records: u64,
    pub failures: u64,
    pub max_batch_records: u64,
    pub usable: bool,
}

fn spawn_worker(
    writer: Arc<Mutex<JournalWriter>>,
    queue: Arc<JournalQueue>,
    usable: Arc<AtomicBool>,
    source_id: String,
    batch_limit: usize,
    counters: Arc<CommitCounters>,
) -> Result<JoinHandle<()>, String> {
    std::thread::Builder::new()
        .name("vs-learning-journal".into())
        .spawn(move || {
            let _liveness = WorkerLiveness {
                queue: queue.clone(),
                usable: usable.clone(),
            };
            loop {
                let mut batch = Vec::new();
                {
                    let mut pending = match queue.pending.lock() {
                        Ok(pending) => pending,
                        Err(_) => {
                            usable.store(false, Ordering::Release);
                            break;
                        }
                    };
                    while pending.is_empty() && !queue.shutdown.load(Ordering::Acquire) {
                        pending = match queue.wake.wait(pending) {
                            Ok(pending) => pending,
                            Err(_) => {
                                usable.store(false, Ordering::Release);
                                return;
                            }
                        };
                    }
                    if pending.is_empty() && queue.shutdown.load(Ordering::Acquire) {
                        break;
                    }
                    // 只取已经到达的请求，不通过定时等待增加低负载延迟。
                    for _ in 0..batch_limit {
                        if let Some(request) = pending.pop_front() {
                            batch.push(request);
                        } else {
                            break;
                        }
                    }
                }
                let result = append_batch(&writer, &batch, &usable, &source_id, &counters);
                match result {
                    Ok(ids) => {
                        for (request, id) in batch.into_iter().zip(ids) {
                            let _ = request.reply.send(Ok(id));
                        }
                    }
                    Err(error) => {
                        counters.failures.fetch_add(1, Ordering::Relaxed);
                        for request in batch {
                            let _ = request.reply.send(Err(error.clone()));
                        }
                    }
                }
            }
        })
        .map_err(|_| "学习日志写入线程创建失败".into())
}

fn append_batch(
    writer: &Arc<Mutex<JournalWriter>>,
    requests: &[PendingWrite],
    usable: &AtomicBool,
    source_id: &str,
    counters: &CommitCounters,
) -> Result<Vec<String>, String> {
    let mut writer = writer.lock().map_err(|_| "学习日志锁不可用")?;
    if !usable.load(Ordering::Acquire) {
        return Err("学习日志已停止写入".into());
    }
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时钟不可用")?
        .as_secs();
    let mut next_sequence = writer.sequence;
    let mut previous = writer.previous.clone();
    let mut next_bytes = writer.bytes;
    let mut last_issued_at = writer.last_issued_at;
    let mut encoded = Vec::with_capacity(requests.len());
    for request in requests {
        if issued_at < last_issued_at || request.payload.snapshot_at > issued_at {
            return Err("系统时钟早于上一条决策".into());
        }
        RequestContext::new(&request.payload.request, issued_at)
            .map_err(|_| "写入时画像投影已经失效")?;
        next_sequence += 1;
        let mut record = DecisionRecord {
            schema: if request.metadata.slate_policy.is_some() {
                "learning-decision-v2"
            } else {
                "learning-decision-v1"
            }
            .into(),
            decision_id: String::new(),
            envelope: EventEnvelope {
                aggregate_id: source_id.to_string(),
                sequence: next_sequence,
                payload: DecisionPayload {
                    issued_at,
                    ..request.payload.clone()
                },
                metadata: DecisionMetadata {
                    previous_decision_id: previous.clone(),
                    ..request.metadata.clone()
                },
            },
        };
        record.decision_id = decision_id(&record.envelope)?;
        let mut bytes = serde_json::to_vec(&record).map_err(|_| "学习日志序列化失败")?;
        bytes.push(b'\n');
        if bytes.len() > MAX_DECISION_BYTES {
            return Err("决策记录超过单条预算".into());
        }
        next_bytes = next_bytes
            .checked_add(bytes.len())
            .ok_or("学习日志字节计数溢出")?;
        if next_bytes > MAX_JOURNAL_BYTES {
            usable.store(false, Ordering::Release);
            return Err("学习日志达到容量上限，须导出并切换新副本日志".into());
        }
        previous = record.decision_id.clone();
        last_issued_at = issued_at;
        encoded.push((bytes, record.decision_id));
    }
    for (bytes, _) in &encoded {
        if writer.file.write_all(bytes).is_err() {
            usable.store(false, Ordering::Release);
            return Err("学习日志写入失败，拒绝继续拼接".into());
        }
    }
    counters.sync_calls.fetch_add(1, Ordering::Relaxed);
    if writer.file.sync_data().is_err() {
        usable.store(false, Ordering::Release);
        return Err("学习日志持久化失败，拒绝继续拼接".into());
    }
    writer.sequence = next_sequence;
    writer.bytes = next_bytes;
    writer.previous = previous;
    writer.last_issued_at = last_issued_at;
    counters.committed_batches.fetch_add(1, Ordering::Relaxed);
    counters
        .committed_records
        .fetch_add(requests.len() as u64, Ordering::Relaxed);
    counters
        .max_batch_records
        .fetch_max(requests.len() as u64, Ordering::Relaxed);
    Ok(encoded.into_iter().map(|(_, id)| id).collect())
}

impl Drop for LearningJournal {
    fn drop(&mut self) {
        {
            let _pending = self
                .queue
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.queue.shutdown.store(true, Ordering::Release);
        }
        self.queue.wake.notify_one();
        if let Ok(mut worker) = self.worker.lock()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
    }
}

impl AppState {
    pub fn with_learning_journal(self, path: &Path, source_id: &str) -> Result<Self, String> {
        self.with_learning_journal_mode(path, source_id, LearningCommitMode::Single)
    }

    pub fn with_learning_journal_mode(
        mut self,
        path: &Path,
        source_id: &str,
        mode: LearningCommitMode,
    ) -> Result<Self, String> {
        if self.profile_authority || self.learning_journal.is_some() || self.feedback_log.is_some()
        {
            return Err("画像权威不能记录推荐决策，学习日志也不能重复挂载".into());
        }
        self.learning_journal = Some(Arc::new(LearningJournal::open(
            path,
            source_id,
            &self.catalog,
            &self.catalog_sha256,
            mode,
        )?));
        Ok(self)
    }

    pub async fn drain_learning_writes(&self) {
        if let Some(journal) = &self.learning_journal
            && let Ok(_permit) = journal.slots.acquire_many(WRITE_SLOTS as u32).await
        {
            journal.slots.close();
        }
    }
}

pub(crate) fn unix_time() -> Result<u64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "系统时钟不可用"))
}

pub(crate) fn snapshot(
    state: &AppState,
    request: &RecommendationRequest,
    subject: Option<&str>,
    now: u64,
) -> Option<DecisionPayload> {
    state.learning_journal.as_ref()?;
    Some(DecisionPayload {
        snapshot_at: now,
        issued_at: now,
        subject: subject?.into(),
        request: request.clone(),
        returned_ids: Vec::new(),
        ranker: String::new(),
    })
}

pub(crate) async fn capture(
    state: &AppState,
    snapshot: Option<DecisionPayload>,
    result: &RecommendationResponse,
) -> Result<Option<String>, ApiError> {
    let (Some(journal), Some(mut payload)) = (&state.learning_journal, snapshot) else {
        return Ok(None);
    };
    let journal = journal.clone();
    let permit = journal
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "学习日志写入预算已满"))?;
    payload.issued_at = unix_time()?;
    RequestContext::new(&payload.request, payload.issued_at)
        .map_err(|_| ApiError(StatusCode::FORBIDDEN, "决策记录时画像已失效"))?;
    payload.returned_ids = result.items.iter().map(|item| item.id.clone()).collect();
    payload.ranker = result.ranker.into();
    let metadata = DecisionMetadata {
        catalog_sha256: state.catalog_sha256.clone(),
        model_sha256: state.rank_model.as_ref().map(|model| model.sha256.clone()),
        previous_decision_id: String::new(),
        slate_policy: state.slate_policy.clone(),
    };
    // 取消等待者不取消已接纳写入；没有后续网关曝光的孤立决策不会进入训练样本。
    journal
        .submit(payload, metadata, permit)
        .await
        .map(Some)
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "学习日志不可用"))
}

pub(crate) fn check_ready(state: &AppState) -> Result<(), ApiError> {
    if state
        .learning_journal
        .as_ref()
        .is_some_and(|journal| !journal.usable.load(Ordering::Acquire))
    {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "学习日志不可用"));
    }
    Ok(())
}

pub(crate) fn metrics(state: &AppState) -> Option<LearningJournalMetrics> {
    state
        .learning_journal
        .as_ref()
        .map(|journal| journal.metrics())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (
        tempfile::TempDir,
        Arc<AppState>,
        DecisionPayload,
        DecisionMetadata,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let catalog = br#"{"version":"journal-v1","items":[],"assets":[]}"#;
        let state = Arc::new(
            AppState::new(
                catalog,
                None,
                "journal-unit-token-0000000000000000000",
                1,
                1,
            )
            .unwrap()
            .with_learning_journal(&directory.path().join("decisions.jsonl"), "source")
            .unwrap(),
        );
        let now = unix_time().unwrap();
        let request = RecommendationRequest {
            request_id: "request".into(),
            domains: vec!["video".into()],
            limit: 1,
            profile: None,
        };
        let payload = snapshot(&state, &request, Some("subject"), now).unwrap();
        let metadata = DecisionMetadata {
            catalog_sha256: state.catalog_sha256.clone(),
            model_sha256: None,
            previous_decision_id: String::new(),
            slate_policy: None,
        };
        (
            directory,
            state,
            DecisionPayload {
                ranker: "tag-affinity-v1".into(),
                ..payload
            },
            metadata,
        )
    }

    #[tokio::test]
    async fn mixed_slate_journal_keeps_v1_hashes_and_rejects_policy_tampering_or_downgrade() {
        let (directory, state, payload, metadata) = fixture();
        let catalog = state.catalog.clone();
        let catalog_hash = state.catalog_sha256.clone();
        let journal = state.learning_journal.as_ref().unwrap();
        for slate_policy in [
            None,
            Some(vs_core::slate::SlatePolicy {
                schema: vs_core::slate::POLICY_SCHEMA.into(),
                candidates_limit: 5,
                relevance_milli: 300,
            }),
            None,
        ] {
            let permit = journal.slots.clone().try_acquire_owned().unwrap();
            journal
                .submit(
                    payload.clone(),
                    DecisionMetadata {
                        slate_policy,
                        ..metadata.clone()
                    },
                    permit,
                )
                .await
                .unwrap();
        }
        drop(state);
        let bytes = std::fs::read(directory.path().join("decisions.jsonl")).unwrap();
        let records = parse_decisions(&bytes, &catalog, &catalog_hash).unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.schema.as_str())
                .collect::<Vec<_>>(),
            [
                "learning-decision-v1",
                "learning-decision-v2",
                "learning-decision-v1"
            ]
        );
        // 用旧字段集合独立计算指纹，防止可选字段改变旧日志身份。
        #[derive(Serialize)]
        struct OldMetadata<'a> {
            catalog_sha256: &'a str,
            model_sha256: Option<&'a str>,
            previous_decision_id: &'a str,
        }
        let original = &records[0].envelope;
        let old = EventEnvelope {
            aggregate_id: original.aggregate_id.clone(),
            sequence: original.sequence,
            payload: original.payload.clone(),
            metadata: OldMetadata {
                catalog_sha256: &catalog_hash,
                model_sha256: None,
                previous_decision_id: "",
            },
        };
        let mut hash = Sha256::new();
        hash.update(b"vs-learning-decision-v1\0");
        hash.update(serde_json::to_vec(&old).unwrap());
        assert_eq!(records[0].decision_id, format!("{:x}", hash.finalize()));
        for case in ["tamper", "downgrade", "remove", "invalid-policy"] {
            let mut changed = records.clone();
            match case {
                "tamper" => {
                    changed[1]
                        .envelope
                        .metadata
                        .slate_policy
                        .as_mut()
                        .unwrap()
                        .relevance_milli = 500
                }
                "downgrade" => changed[1].schema = "learning-decision-v1".into(),
                "remove" => changed[1].envelope.metadata.slate_policy = None,
                "invalid-policy" => {
                    changed[1]
                        .envelope
                        .metadata
                        .slate_policy
                        .as_mut()
                        .unwrap()
                        .relevance_milli = 1001;
                    changed[1].decision_id = decision_id(&changed[1].envelope).unwrap();
                }
                _ => unreachable!(),
            }
            let mut serialized = Vec::new();
            for record in changed {
                serialized.extend_from_slice(&serde_json::to_vec(&record).unwrap());
                serialized.push(b'\n');
            }
            assert!(
                parse_decisions(&serialized, &catalog, &catalog_hash).is_err(),
                "{case}"
            );
        }
        let reopened = AppState::new(
            br#"{"version":"journal-v1","items":[],"assets":[]}"#,
            None,
            "journal-unit-token-0000000000000000000",
            1,
            1,
        )
        .unwrap()
        .with_learning_journal(&directory.path().join("decisions.jsonl"), "source")
        .unwrap();
        assert_eq!(
            reopened
                .learning_journal
                .as_ref()
                .unwrap()
                .writer
                .lock()
                .unwrap()
                .sequence,
            3
        );
    }

    #[tokio::test]
    async fn quota_or_io_failure_does_not_advance_sequence_and_blocks_further_success() {
        for io_failure in [false, true] {
            let (directory, state, payload, metadata) = fixture();
            let journal = state.learning_journal.as_ref().unwrap();
            {
                let mut writer = journal.writer.lock().unwrap();
                if io_failure {
                    // 用只读文件注入实际写入失败，不能把失败当成已确认的决策。
                    let read_only = directory.path().join("read-only.bin");
                    std::fs::write(&read_only, b"fixed").unwrap();
                    writer.file = File::open(read_only).unwrap();
                } else {
                    writer.bytes = MAX_JOURNAL_BYTES;
                }
            }
            let permit = journal.slots.clone().try_acquire_owned().unwrap();
            assert!(
                journal
                    .submit(payload.clone(), metadata.clone(), permit)
                    .await
                    .is_err()
            );
            assert!(check_ready(&state).is_err());
            let permit = journal.slots.clone().try_acquire_owned().unwrap();
            assert!(journal.submit(payload, metadata, permit).await.is_err());
            assert_eq!(journal.writer.lock().unwrap().sequence, 0);
        }
    }

    #[tokio::test]
    async fn full_write_budget_rejects_before_a_background_write_is_started() {
        let (_directory, state, payload, _metadata) = fixture();
        let journal = state.learning_journal.as_ref().unwrap();
        let permit = journal
            .slots
            .clone()
            .acquire_many_owned(WRITE_SLOTS as u32)
            .await
            .unwrap();
        let result = RecommendationResponse {
            request_id: "request".into(),
            catalog_version: "journal-v1".into(),
            profile_version: None,
            ranker: "tag-affinity-v1",
            considered: 0,
            items: vec![],
        };
        assert!(capture(&state, Some(payload), &result).await.is_err());
        assert_eq!(journal.writer.lock().unwrap().sequence, 0);
        assert!(check_ready(&state).is_ok());
        drop(permit);
    }

    type WriteResult = oneshot::Receiver<Result<String, String>>;

    fn enqueue_together(
        journal: &LearningJournal,
        payload: &DecisionPayload,
        metadata: &DecisionMetadata,
    ) -> Vec<WriteResult> {
        let mut pending = journal.queue.pending.lock().unwrap();
        let replies = (0..WRITE_SLOTS)
            .map(|index| {
                let (reply, receiver) = oneshot::channel();
                let mut payload = payload.clone();
                payload.request.request_id = format!("batch-{index}");
                pending.push_back(PendingWrite {
                    payload,
                    metadata: metadata.clone(),
                    reply,
                    _permit: journal.slots.clone().try_acquire_owned().unwrap(),
                });
                receiver
            })
            .collect();
        drop(pending);
        journal.queue.wake.notify_one();
        replies
    }

    #[tokio::test]
    async fn simultaneous_requests_share_a_barrier_only_in_grouped_mode_and_keep_chain_order() {
        for mode in [LearningCommitMode::Single, LearningCommitMode::Grouped] {
            let (directory, state, payload, metadata) = fixture();
            drop(state);
            let catalog = br#"{"version":"journal-v1","items":[],"assets":[]}"#;
            let state = Arc::new(
                AppState::new(
                    catalog,
                    None,
                    "journal-unit-token-0000000000000000000",
                    1,
                    1,
                )
                .unwrap()
                .with_learning_journal_mode(
                    &directory.path().join("decisions.jsonl"),
                    "source",
                    mode,
                )
                .unwrap(),
            );
            let journal = state.learning_journal.as_ref().unwrap();
            let replies = enqueue_together(journal, &payload, &metadata);
            let mut ids = Vec::new();
            for reply in replies {
                ids.push(
                    tokio::time::timeout(std::time::Duration::from_secs(2), reply)
                        .await
                        .unwrap()
                        .unwrap()
                        .unwrap(),
                );
            }
            state.drain_learning_writes().await;
            let metrics = journal.metrics();
            assert_eq!(metrics.committed_records, 4);
            assert_eq!(
                metrics.sync_calls,
                if mode == LearningCommitMode::Grouped {
                    1
                } else {
                    4
                }
            );
            drop(state);
            let records = parse_decisions(
                &std::fs::read(directory.path().join("decisions.jsonl")).unwrap(),
                &serde_json::from_slice(catalog).unwrap(),
                &format!("{:x}", Sha256::digest(catalog)),
            )
            .unwrap();
            assert_eq!(
                records
                    .iter()
                    .map(|record| &record.decision_id)
                    .collect::<Vec<_>>(),
                ids.iter().collect::<Vec<_>>()
            );
            assert_eq!(records[3].envelope.sequence, 4);
        }
    }

    #[tokio::test]
    async fn dropped_waiters_keep_admission_until_real_commit_and_drain_waits_for_writer() {
        let (_directory, state, payload, metadata) = fixture();
        let journal = state.learning_journal.as_ref().unwrap();
        {
            let _writer_guard = journal.writer.lock().unwrap();
            let mut replies = enqueue_together(journal, &payload, &metadata);
            assert!(
                replies.iter_mut().all(|reply| matches!(
                    reply.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ))
            );
            drop(replies);
            assert!(journal.slots.clone().try_acquire_owned().is_err());
            assert_eq!(
                journal.counters.committed_records.load(Ordering::Relaxed),
                0
            );
        }
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.drain_learning_writes(),
        )
        .await
        .unwrap();
        assert_eq!(journal.metrics().committed_records, 4);
    }

    #[tokio::test]
    async fn group_capacity_failure_rejects_every_member_before_any_write() {
        for io_failure in [false, true] {
            let (directory, state, payload, metadata) = fixture();
            drop(state);
            let catalog = br#"{"version":"journal-v1","items":[],"assets":[]}"#;
            let state = Arc::new(
                AppState::new(
                    catalog,
                    None,
                    "journal-unit-token-0000000000000000000",
                    1,
                    1,
                )
                .unwrap()
                .with_learning_journal_mode(
                    &directory.path().join("decisions.jsonl"),
                    "source",
                    LearningCommitMode::Grouped,
                )
                .unwrap(),
            );
            let journal = state.learning_journal.as_ref().unwrap();
            if io_failure {
                let path = directory.path().join("read-only.bin");
                std::fs::write(&path, b"unchanged").unwrap();
                journal.writer.lock().unwrap().file = File::open(path).unwrap();
            } else {
                journal.writer.lock().unwrap().bytes = MAX_JOURNAL_BYTES - 1;
            }
            for reply in enqueue_together(journal, &payload, &metadata) {
                assert!(reply.await.unwrap().is_err());
            }
            assert_eq!(journal.metrics().sync_calls, 0);
            assert_eq!(journal.writer.lock().unwrap().sequence, 0);
            assert_eq!(
                journal
                    .writer
                    .lock()
                    .unwrap()
                    .file
                    .metadata()
                    .unwrap()
                    .len(),
                if io_failure { 9 } else { 0 }
            );
            assert!(check_ready(&state).is_err());
        }
    }
}
