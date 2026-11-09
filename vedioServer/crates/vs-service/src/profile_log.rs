use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::PublicCatalog,
    profile::{MAX_PROFILE_SUBJECTS, ProfileEvent, ProfileEventFacts, ProfileState},
    valid_id,
};

use crate::profile_shards::ProfileShard;
use crate::upstream::{atomic_create::atomic_create, event_envelope::EventEnvelope};

const SCHEMA: &str = "profile-event-v2";
const LEGACY_SCHEMA: &str = "profile-event-v1";
const PROJECTION_VERSION: &str = "tag-additive-v1";
const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HISTORY_GUARDS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileHistoryCheckpoint {
    pub schema: String,
    pub projection_version: String,
    pub records: u64,
    pub bytes: u64,
    pub sha256: String,
}

impl ProfileHistoryCheckpoint {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != "profile-history-checkpoint-v1"
            || self.projection_version != PROJECTION_VERSION
            || self.bytes > MAX_LOG_BYTES
            || self.records > self.bytes
            || (self.bytes == 0) != (self.records == 0)
            || !valid_sha256(&self.sha256)
            || (self.bytes == 0 && self.sha256 != format!("{:x}", Sha256::digest([])))
        {
            return Err("画像历史水位无效".into());
        }
        Ok(())
    }

    pub fn guard(&self) -> String {
        // 固定字段编码生成短凭据；不把内容指纹解释成身份认证。
        format!(
            "{:x}",
            Sha256::digest(format!(
                "{}:{}:{}:{}:{}",
                self.schema, self.projection_version, self.records, self.bytes, self.sha256,
            ))
        )
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileSeal {
    schema: String,
    checkpoint: ProfileHistoryCheckpoint,
    destination: PathBuf,
}

fn seal_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".sealed.json");
    PathBuf::from(name)
}

fn shard_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".shard.json");
    PathBuf::from(name)
}

// 归档/恢复机制参考固定Qdrant 222b2e44ab1c3f17e8246396ead6558e45041df7
// src/common/snapshots.rs、lib/collection/src/common/snapshots_manager.rs。
// 不复制tar或存储内核；本地有界格式复用既有Apache-2.0 atomic_create。
// 来源及范围见THIRD_PARTY.md与contracts/profile-backup-v1.md。
const BACKUP_MAGIC: &[u8; 8] = b"VSPRBK1\n";
const MAX_BACKUP_HEADER: usize = 4096;

fn same_backup_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        // 输出文件尚未存在，不能canonicalize；保留路径名含ASCII固定后缀，
        // 同时对整路径使用Windows不区分ASCII大小写的拒绝规则。
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupHeader {
    schema: String,
    catalog_sha256: String,
    checkpoint: ProfileHistoryCheckpoint,
    subjects: usize,
    projection_sha256: String,
}

/// 不含主体、原始事件或路径；内容摘要不是匿名化证明或身份认证。
#[derive(Debug, Clone, Serialize)]
pub struct ProfileBackupReceipt {
    pub schema: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub checkpoint: ProfileHistoryCheckpoint,
    pub catalog_sha256: String,
    pub subjects: usize,
    pub projection_sha256: String,
    pub source_modified: bool,
    pub restored_writer_enabled: bool,
}

fn backup_catalog(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("备份目录超出8MiB预算".into());
    }
    let catalog: PublicCatalog = serde_json::from_slice(bytes).map_err(|_| "备份目录JSON无效")?;
    catalog.validate().map_err(|_| "备份目录内容无效")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn replay_projection(events: &[ObservedEvent]) -> Result<(usize, String), String> {
    let mut profiles = std::collections::BTreeMap::<String, ProfileState>::new();
    for observed in events {
        let event = &observed.payload.event;
        if !profiles.contains_key(&event.subject) && profiles.len() >= MAX_PROFILE_SUBJECTS {
            return Err("备份主体超过原画像预算".into());
        }
        profiles
            .entry(event.subject.clone())
            .or_default()
            .apply_observed(event, &observed.payload.facts)
            .map_err(|_| "备份不能重建有效画像")?;
    }
    let mut hash = Sha256::new();
    hash.update(b"profile-backup-projection-v1\0");
    for (subject, state) in &profiles {
        // 原projection对内部集合排序；固定空scopes和到期时间只用于重建比较，
        // 不发放投影或授权，也不将摘要作为可上线画像。
        let bytes = serde_json::to_vec(&state.projection(subject, Vec::new(), u64::MAX))
            .map_err(|_| "备份投影指纹编码失败")?;
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    Ok((profiles.len(), format!("{:x}", hash.finalize())))
}

fn backup_receipt(
    header: &BackupHeader,
    archive_sha256: String,
    bytes: u64,
) -> ProfileBackupReceipt {
    ProfileBackupReceipt {
        schema: "profile-backup-receipt-v1".into(),
        archive_sha256,
        archive_bytes: bytes,
        checkpoint: header.checkpoint.clone(),
        catalog_sha256: header.catalog_sha256.clone(),
        subjects: header.subjects,
        projection_sha256: header.projection_sha256.clone(),
        source_modified: false,
        restored_writer_enabled: false,
    }
}

/// 严格只读、有共享文件锁的离线备份；活动写者存在即失败，不截尾或封存源。
/// 快照校验及暂存后发布思路复用Qdrant，输出沿用原atomic_create，不复制tar解包器。
pub fn backup_profile_log(
    source: &Path,
    catalog_bytes: &[u8],
    destination: &Path,
) -> Result<ProfileBackupReceipt, String> {
    let catalog_sha256 = backup_catalog(catalog_bytes)?;
    let destination_parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .canonicalize()
        .map_err(|_| "备份输出父目录必须已存在")?;
    let destination = destination_parent.join(destination.file_name().ok_or("备份输出文件名无效")?);
    if destination.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".sealed.json")
            || name
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".shard.json")
    }) {
        return Err("备份归档不能使用画像封存标记保留后缀".into());
    }
    let canonical_source = source
        .canonicalize()
        .map_err(|_| "备份源不存在或不可规范化")?;
    let lexical_source = source
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .canonicalize()
        .map_err(|_| "备份源父目录不可规范化")?
        .join(source.file_name().ok_or("备份源文件名无效")?);
    if same_backup_path(&destination, &canonical_source)
        || same_backup_path(&destination, &seal_path(&canonical_source))
        || same_backup_path(&destination, &seal_path(&lexical_source))
        || same_backup_path(&destination, &shard_path(&canonical_source))
        || same_backup_path(&destination, &shard_path(&lexical_source))
    {
        return Err("备份输出不能占用源日志或其封存保留路径".into());
    }
    let (log, events) = ProfileEventLog::open_mode(source, &catalog_sha256, false, true)?;
    let (subjects, projection_sha256) = replay_projection(&events)?;
    drop(events);
    let checkpoint = log.checkpoint()?;
    let header = BackupHeader {
        schema: "profile-log-backup-v1".into(),
        catalog_sha256,
        checkpoint,
        subjects,
        projection_sha256,
    };
    let encoded = serde_json::to_vec(&header).map_err(|_| "备份头编码失败")?;
    if encoded.len() > MAX_BACKUP_HEADER {
        return Err("备份头超出预算".into());
    }
    let mut file = log.file.lock().map_err(|_| "备份日志锁损坏")?;
    file.file
        .seek(SeekFrom::Start(0))
        .map_err(|_| "备份源定位失败")?;
    let mut archive_hash = Sha256::new();
    atomic_create(&destination, |writer| {
        for part in [
            BACKUP_MAGIC.as_slice(),
            &(encoded.len() as u32).to_be_bytes(),
            &encoded,
        ] {
            writer.write_all(part)?;
            archive_hash.update(part);
        }
        let mut remaining = header.checkpoint.bytes;
        let mut payload_hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        while remaining > 0 {
            let maximum = remaining.min(buffer.len() as u64) as usize;
            let read = file.file.read(&mut buffer[..maximum])?;
            if read == 0 {
                return Err(std::io::Error::other("备份源提前结束"));
            }
            writer.write_all(&buffer[..read])?;
            payload_hash.update(&buffer[..read]);
            archive_hash.update(&buffer[..read]);
            remaining -= read as u64;
        }
        if format!("{:x}", payload_hash.finalize()) != header.checkpoint.sha256 {
            return Err(std::io::Error::other("备份期间源内容改变"));
        }
        if file.file.read(&mut buffer[..1])? != 0
            || file.file.metadata()?.len() != header.checkpoint.bytes
        {
            return Err(std::io::Error::other("备份期间源长度改变"));
        }
        Ok(())
    })
    .map_err(|_| "备份发布失败；不覆盖原制品，若输出存在须独立核对")?;
    let bytes = BACKUP_MAGIC.len() as u64 + 4 + encoded.len() as u64 + header.checkpoint.bytes;
    Ok(backup_receipt(
        &header,
        format!("{:x}", archive_hash.finalize()),
        bytes,
    ))
}

fn checked_backup(
    source: &Path,
    catalog_bytes: &[u8],
    expected_sha256: &str,
    temporary_parent: &Path,
) -> Result<(tempfile::NamedTempFile, ProfileBackupReceipt), String> {
    let catalog_sha256 = backup_catalog(catalog_bytes)?;
    if !valid_sha256(expected_sha256) {
        return Err("备份归档必须固定小写SHA256".into());
    }
    let mut input = File::open(source).map_err(|_| "备份归档不可读")?;
    input.try_lock_shared().map_err(|_| "备份归档正被独占")?;
    let length = input.metadata().map_err(|_| "备份归档元数据不可读")?.len();
    if length > MAX_LOG_BYTES + MAX_BACKUP_HEADER as u64 + 12 || length < 12 {
        return Err("备份归档长度超出预算".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut remaining = length;
    while remaining > 0 {
        let maximum = remaining.min(buffer.len() as u64) as usize;
        let read = input
            .read(&mut buffer[..maximum])
            .map_err(|_| "备份归档读取失败")?;
        if read == 0 {
            return Err("备份归档提前结束".into());
        }
        hash.update(&buffer[..read]);
        remaining -= read as u64;
    }
    if input
        .read(&mut buffer[..1])
        .map_err(|_| "备份尾部读取失败")?
        != 0
    {
        return Err("备份归档长度改变".into());
    }
    if format!("{:x}", hash.finalize()) != expected_sha256 {
        return Err("备份归档摘要不符，未发布恢复日志".into());
    }
    input
        .seek(SeekFrom::Start(0))
        .map_err(|_| "备份归档定位失败")?;
    let mut prefix = [0_u8; 12];
    input.read_exact(&mut prefix).map_err(|_| "备份头不完整")?;
    if &prefix[..8] != BACKUP_MAGIC {
        return Err("备份格式无效".into());
    }
    let header_bytes = u32::from_be_bytes(prefix[8..].try_into().unwrap()) as usize;
    if !(1..=MAX_BACKUP_HEADER).contains(&header_bytes) {
        return Err("备份头长度无效".into());
    }
    let mut bytes = vec![0; header_bytes];
    input.read_exact(&mut bytes).map_err(|_| "备份头提前结束")?;
    let header: BackupHeader = serde_json::from_slice(&bytes).map_err(|_| "备份头内容无效")?;
    header.checkpoint.validate()?;
    if header.schema != "profile-log-backup-v1"
        || header.catalog_sha256 != catalog_sha256
        || header.subjects > MAX_PROFILE_SUBJECTS
        || !valid_sha256(&header.projection_sha256)
        || length != 12 + header_bytes as u64 + header.checkpoint.bytes
    {
        return Err("备份头、目录指纹或长度不符".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(temporary_parent).map_err(|_| "恢复暂存目录不可用")?;
    let mut second_hash = Sha256::new();
    second_hash.update(prefix);
    second_hash.update(&bytes);
    let mut remaining = header.checkpoint.bytes;
    while remaining > 0 {
        let maximum = remaining.min(buffer.len() as u64) as usize;
        let read = input
            .read(&mut buffer[..maximum])
            .map_err(|_| "恢复载荷读取失败")?;
        if read == 0 {
            return Err("备份原始载荷提前结束".into());
        }
        second_hash.update(&buffer[..read]);
        temporary
            .as_file_mut()
            .write_all(&buffer[..read])
            .map_err(|_| "恢复暂存失败")?;
        remaining -= read as u64;
    }
    if input
        .read(&mut buffer[..1])
        .map_err(|_| "恢复尾部读取失败")?
        != 0
        || format!("{:x}", second_hash.finalize()) != expected_sha256
    {
        return Err("备份原始载荷长度改变".into());
    }
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|_| "恢复暂存同步失败")?;
    let (log, events) = ProfileEventLog::open_mode(temporary.path(), &catalog_sha256, false, true)?;
    let (subjects, projection_sha256) = replay_projection(&events)?;
    if log.checkpoint()? != header.checkpoint
        || subjects != header.subjects
        || projection_sha256 != header.projection_sha256
    {
        return Err("备份日志、序号或投影重建不符".into());
    }
    drop(events);
    drop(log);
    Ok((
        temporary,
        backup_receipt(&header, expected_sha256.into(), length),
    ))
}

/// 验证归档且严格重放；只写指定目录的临时文件，结束即删除。
pub fn verify_profile_backup(
    archive: &Path,
    catalog_bytes: &[u8],
    expected_sha256: &str,
    scratch_directory: &Path,
) -> Result<ProfileBackupReceipt, String> {
    let (_, receipt) = checked_backup(archive, catalog_bytes, expected_sha256, scratch_directory)?;
    Ok(receipt)
}

/// 只恢复为封存日志用于演练，不自动启用写者。标记先发布，崩溃最多留下不可启动目标。
pub fn restore_profile_backup(
    archive: &Path,
    catalog_bytes: &[u8],
    expected_sha256: &str,
    destination: &Path,
) -> Result<ProfileBackupReceipt, String> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = parent.canonicalize().map_err(|_| "恢复父目录必须已存在")?;
    let target = parent.join(destination.file_name().ok_or("恢复目标文件名无效")?);
    if target.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".sealed.json")
            || name
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".shard.json")
    }) {
        return Err("恢复日志不能占用画像封存标记保留后缀".into());
    }
    let marker = seal_path(&target);
    let occupied = |path: &Path| -> Result<bool, String> {
        match std::fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("恢复目标或封存路径状态不可读".into()),
        }
    };
    if occupied(&target)? || occupied(&marker)? || occupied(&shard_path(&target))? {
        return Err("恢复目标或封存标记已存在，拒绝覆盖".into());
    }
    let (mut temporary, receipt) =
        checked_backup(archive, catalog_bytes, expected_sha256, &parent)?;
    let seal = serde_json::to_vec(&ProfileSeal {
        schema: "profile-log-seal-v1".into(),
        checkpoint: receipt.checkpoint.clone(),
        destination: target.clone(),
    })
    .map_err(|_| "恢复封存记录编码失败")?;
    if seal.len() > 4096 {
        return Err("恢复封存记录超出4KiB，未发布".into());
    }
    atomic_create(&marker, |writer| writer.write_all(&seal))
        .map_err(|_| "恢复封存记录发布失败；目标不得作为写者启动")?;
    temporary
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|_| "恢复暂存定位失败")?;
    atomic_create(&target, |writer| {
        let copied = std::io::copy(temporary.as_file_mut(), writer)?;
        if copied != receipt.checkpoint.bytes {
            return Err(std::io::Error::other("恢复长度改变"));
        }
        Ok(())
    })
    .map_err(|_| "恢复日志发布失败；封存标记保留，不自动清除或启动写者")?;
    Ok(receipt)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventRecord {
    schema: String,
    envelope: ObservedEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProfilePayload {
    pub event: ProfileEvent,
    pub facts: ProfileEventFacts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProfileMetadata {
    catalog_sha256: String,
    projection_version: String,
}

pub(crate) type ObservedEvent = EventEnvelope<ProfilePayload, ProfileMetadata>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyRecord {
    schema: String,
    event: ProfileEvent,
}

#[derive(Deserialize)]
struct RecordSchema {
    schema: String,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

fn event_fingerprint(event: &ProfileEvent) -> [u8; 32] {
    event.idempotency_fingerprint()
}

fn observed(
    event: &ProfileEvent,
    facts: &ProfileEventFacts,
    sequence: u64,
    catalog_sha256: &str,
) -> ObservedEvent {
    EventEnvelope {
        aggregate_id: event.subject.clone(),
        sequence,
        payload: ProfilePayload {
            event: event.clone(),
            facts: facts.clone(),
        },
        metadata: ProfileMetadata {
            catalog_sha256: catalog_sha256.to_string(),
            projection_version: PROJECTION_VERSION.to_string(),
        },
    }
}

fn validate(observed: &ObservedEvent, previous: u64) -> Result<(), String> {
    let event = &observed.payload.event;
    if !valid_id(&event.event_id)
        || !valid_id(&event.subject)
        || !valid_id(&event.candidate_id)
        || observed.aggregate_id != event.subject
        || previous.checked_add(1) != Some(observed.sequence)
        || !valid_sha256(&observed.metadata.catalog_sha256)
        || observed.metadata.projection_version != PROJECTION_VERSION
        || observed.payload.facts.validate().is_err()
    {
        return Err("画像日志的事件、序号、特征或投影规则版本无效".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendResult {
    Appended,
    Duplicate,
}

pub struct ProfileEventLog {
    file: Mutex<LogWriter>,
    event_fingerprints: Mutex<HashMap<String, [u8; 32]>>,
    catalog_sha256: String,
    guards: Mutex<HashMap<String, ProfileHistoryCheckpoint>>,
    usable: AtomicBool,
}

struct LogWriter {
    file: File,
    failed: bool,
    sequences: HashMap<String, u64>,
    hash: Sha256,
    records: u64,
    bytes: u64,
    sealed: bool,
}

impl ProfileEventLog {
    #[cfg(test)]
    pub(crate) fn with_writer_locked_for_test(&self, action: impl FnOnce()) {
        let _writer = self.file.lock().unwrap();
        action();
    }

    #[cfg(test)]
    pub(crate) fn append_waiting_for_writer_for_test(&self) -> bool {
        self.event_fingerprints.try_lock().is_err()
    }

    pub fn open(
        path: impl AsRef<Path>,
        catalog_sha256: &str,
    ) -> Result<(Self, Vec<ObservedEvent>), String> {
        Self::open_inner(path.as_ref(), catalog_sha256, false)
    }

    pub fn open_shard(
        path: &Path,
        catalog_sha256: &str,
        shard: &ProfileShard,
    ) -> Result<(Self, Vec<ObservedEvent>), String> {
        shard.validate()?;
        if path.file_name().is_some_and(|name| {
            let name = name.to_string_lossy().to_ascii_lowercase();
            name.ends_with(".sealed.json") || name.ends_with(".shard.json")
        }) {
            return Err("分片日志不能占用封存或分片标记保留后缀".into());
        }
        if !path.try_exists().map_err(|_| "分片日志状态不可读")?
            && std::fs::symlink_metadata(shard_path(path)).is_ok()
        {
            return Err("分片标记已存在但日志缺失，禁止自动重建为空日志".into());
        }
        Self::open_layout(path, catalog_sha256, false, false, Some(shard))
    }

    fn open_inner(
        path: &Path,
        catalog_sha256: &str,
        handoff: bool,
    ) -> Result<(Self, Vec<ObservedEvent>), String> {
        Self::open_mode(path, catalog_sha256, handoff, false)
    }

    fn open_mode(
        path: &Path,
        catalog_sha256: &str,
        handoff: bool,
        read_only: bool,
    ) -> Result<(Self, Vec<ObservedEvent>), String> {
        Self::open_layout(path, catalog_sha256, handoff, read_only, None)
    }

    fn open_layout(
        path: &Path,
        catalog_sha256: &str,
        handoff: bool,
        read_only: bool,
        shard: Option<&ProfileShard>,
    ) -> Result<(Self, Vec<ObservedEvent>), String> {
        if !valid_sha256(catalog_sha256) {
            return Err("画像日志目录指纹无效".into());
        }
        let path = path.to_path_buf();
        if !path.try_exists().map_err(|_| "画像日志状态不可读")?
            && std::fs::symlink_metadata(shard_path(&path)).is_ok()
        {
            return Err("分片标记已存在但日志缺失，禁止创建替代空日志".into());
        }
        if !handoff
            && !read_only
            && seal_path(&path)
                .try_exists()
                .map_err(|_| "画像封存状态不可读")?
        {
            return Err("画像日志已经封存，禁止重新作为写入权威启动".into());
        }
        if !read_only
            && let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)
                .map_err(|_| "profile_log_parent_unavailable".to_string())?;
        }
        let mut options = OpenOptions::new();
        options
            .create(!handoff && !read_only)
            .truncate(false)
            .read(true)
            .write(!read_only);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let existing = options
            .open(&path)
            .map_err(|_| "profile_log_open_failed".to_string())?;
        if read_only {
            existing.try_lock_shared()
        } else {
            existing.try_lock()
        }
        .map_err(|_| "profile_log_writer_already_active".to_string())?;
        let path = path
            .canonicalize()
            .map_err(|_| "画像日志规范路径读取失败")?;
        if !handoff
            && !read_only
            && seal_path(&path)
                .try_exists()
                .map_err(|_| "画像封存状态不可读")?
        {
            return Err("画像日志已经封存，禁止重新作为写入权威启动".into());
        }
        #[cfg(unix)]
        if !read_only {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = existing
                .metadata()
                .map_err(|_| "profile_log_metadata_failed".to_string())?
                .permissions();
            permissions.set_mode(0o600);
            std::fs::set_permissions(&path, permissions)
                .map_err(|_| "profile_log_permissions_failed".to_string())?;
        }
        let metadata = existing
            .metadata()
            .map_err(|_| "profile_log_metadata_failed".to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_LOG_BYTES {
            return Err("profile_log_capacity_reached".into());
        }
        // 持有原日志独占锁后才固定身份；先验证身份再读尾部，错配置不触发修尾。
        // 标记不是全局fence；复制日志和标记仍不能安全地产生第二个写者。
        match std::fs::symlink_metadata(shard_path(&path)) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err("画像分片标记必须是普通文件，不接受符号链接或目录".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("画像分片标记状态不可读".into()),
        }
        match File::open(shard_path(&path)) {
            Ok(marker) => {
                let mut bytes = Vec::new();
                marker
                    .take(1025)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "画像分片标记不可读")?;
                let persisted: ProfileShard =
                    serde_json::from_slice(&bytes).map_err(|_| "画像分片标记格式无效")?;
                persisted.validate()?;
                if bytes.len() > 1024 || shard != Some(&persisted) {
                    return Err("画像日志分片身份不符，禁止更改分片或退回无分片启动".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(shard) = shard {
                    if metadata.len() != 0 {
                        return Err("已有非空日志不能自动登记为分片，须先完成独立迁移".into());
                    }
                    let bytes = serde_json::to_vec(shard).map_err(|_| "分片标记编码失败")?;
                    atomic_create(&shard_path(&path), |writer| writer.write_all(&bytes))
                        .map_err(|_| "分片标记不可覆盖发布失败")?;
                }
            }
            Err(_) => return Err("画像分片标记状态不可读".into()),
        }

        let mut events = Vec::new();
        let mut event_fingerprints = HashMap::new();
        let mut sequences = HashMap::new();
        let mut reader = BufReader::new(
            existing
                .try_clone()
                .map_err(|_| "profile_log_clone_failed".to_string())?,
        );
        let mut line = Vec::new();
        let mut line_number = 0;
        let mut valid_length = 0_u64;
        let mut hash = Sha256::new();
        loop {
            line.clear();
            let read = reader
                .by_ref()
                .take((MAX_RECORD_BYTES + 2) as u64)
                .read_until(b'\n', &mut line)
                .map_err(|_| format!("profile_log_read_failed:{line_number}"))?;
            if read == 0 {
                break;
            }
            if read_only && valid_length + read as u64 > metadata.len() {
                return Err("只读源日志读取期间增长，未发布或修复".into());
            }
            if line.len() > MAX_RECORD_BYTES + 1 {
                return Err(format!("profile_log_record_too_large:{line_number}"));
            }
            if !line.ends_with(b"\n") {
                if handoff || read_only {
                    return Err("只读或转移源有未完成尾部，未修复、封存或改写".into());
                }
                drop(reader);
                existing
                    .set_len(valid_length)
                    .and_then(|_| existing.sync_data())
                    .map_err(|error| format!("profile_log_truncated_tail_repair_failed:{error}"))?;
                break;
            }
            hash.update(&line);
            line.pop();
            let schema: RecordSchema = serde_json::from_slice(&line)
                .map_err(|_| format!("profile_log_record_invalid:{line_number}"))?;
            if schema.schema == LEGACY_SCHEMA {
                return Err(
                    "旧版画像日志缺少历史特征；请使用原目录及其指纹离线迁移到新文件".into(),
                );
            }
            let record: EventRecord = serde_json::from_slice(&line)
                .map_err(|_| format!("profile_log_record_invalid:{line_number}"))?;
            if record.schema != SCHEMA {
                return Err(format!("profile_log_record_invalid:{line_number}"));
            }
            let event = &record.envelope.payload.event;
            if shard.is_some_and(|shard| !shard.owns(&event.subject)) {
                return Err("画像日志含其他分片主体，禁止启动".into());
            }
            let previous = sequences.get(&event.subject).copied().unwrap_or(0);
            validate(&record.envelope, previous)?;
            let key = Self::key(&event.subject, &event.event_id);
            if event_fingerprints
                .insert(key, event_fingerprint(event))
                .is_some()
            {
                return Err(format!("profile_log_record_invalid:{line_number}"));
            }
            sequences.insert(event.subject.clone(), record.envelope.sequence);
            events.push(record.envelope);
            valid_length += read as u64;
            line_number += 1;
        }
        if read_only && valid_length != metadata.len() {
            return Err("只读源日志读取期间长度改变，未发布或修复".into());
        }
        Ok((
            Self {
                file: Mutex::new(LogWriter {
                    file: existing,
                    failed: false,
                    sequences,
                    hash,
                    records: line_number as u64,
                    bytes: valid_length,
                    sealed: read_only,
                }),
                event_fingerprints: Mutex::new(event_fingerprints),
                catalog_sha256: catalog_sha256.to_string(),
                guards: Mutex::new(HashMap::new()),
                usable: AtomicBool::new(true),
            },
            events,
        ))
    }

    pub fn append(
        &self,
        event: &ProfileEvent,
        facts: &ProfileEventFacts,
    ) -> Result<AppendResult, String> {
        let key = Self::key(&event.subject, &event.event_id);
        let fingerprint = event_fingerprint(event);
        let mut event_fingerprints = self
            .event_fingerprints
            .lock()
            .map_err(|_| "profile_log_lock_poisoned".to_string())?;
        let mut file = self
            .file
            .lock()
            .map_err(|_| "profile_log_lock_poisoned".to_string())?;
        if file.failed {
            return Err("profile_log_requires_restart".into());
        }
        if file.sealed {
            return Err("画像日志已经封存，禁止继续写入".into());
        }
        if let Some(existing) = event_fingerprints.get(&key) {
            return if existing == &fingerprint {
                Ok(AppendResult::Duplicate)
            } else {
                Err("profile_event_id_conflict".into())
            };
        }
        let previous = file.sequences.get(&event.subject).copied().unwrap_or(0);
        let sequence = previous.checked_add(1).ok_or("画像日志序号已达上限")?;
        let envelope = observed(event, facts, sequence, &self.catalog_sha256);
        validate(&envelope, previous)?;
        let record = EventRecord {
            schema: SCHEMA.to_string(),
            envelope,
        };
        let bytes = serde_json::to_vec(&record).map_err(|_| "profile_log_encode_failed")?;
        if bytes.len() + 1 > MAX_RECORD_BYTES {
            return Err("profile_log_record_too_large".into());
        }
        let length = file
            .file
            .seek(SeekFrom::End(0))
            .map_err(|_| "profile_log_seek_failed".to_string())?;
        if length + bytes.len() as u64 + 1 > MAX_LOG_BYTES {
            return Err("profile_log_capacity_reached".into());
        }
        let write = file
            .file
            .write_all(&bytes)
            .and_then(|_| file.file.write_all(b"\n"))
            .and_then(|_| file.file.flush())
            .and_then(|_| file.file.sync_data());
        if write.is_err() {
            // 部分写入或同步失败后结果不确定，必须重启重放，禁止继续拼接损坏尾部。
            file.failed = true;
            self.usable.store(false, Ordering::Release);
            return Err("profile_log_append_failed".into());
        }
        file.hash.update(&bytes);
        file.hash.update(b"\n");
        file.records += 1;
        file.bytes += bytes.len() as u64 + 1;
        event_fingerprints.insert(key, fingerprint);
        file.sequences.insert(event.subject.clone(), sequence);
        Ok(AppendResult::Appended)
    }

    fn checkpoint_locked(file: &LogWriter) -> Result<ProfileHistoryCheckpoint, String> {
        if file.failed {
            return Err("画像日志状态不确定，必须重启重放".into());
        }
        Ok(ProfileHistoryCheckpoint {
            schema: "profile-history-checkpoint-v1".into(),
            projection_version: PROJECTION_VERSION.into(),
            records: file.records,
            bytes: file.bytes,
            sha256: format!("{:x}", file.hash.clone().finalize()),
        })
    }

    pub fn checkpoint(&self) -> Result<ProfileHistoryCheckpoint, String> {
        let file = self.file.lock().map_err(|_| "画像日志锁已损坏")?;
        Self::checkpoint_locked(&file)
    }

    /// 首次核对历史前缀；只缓存已经证明存在的前缀，追加写入不改变该证明。
    pub fn verify_checkpoint(
        &self,
        checkpoint: &ProfileHistoryCheckpoint,
    ) -> Result<String, String> {
        checkpoint.validate()?;
        let guard = checkpoint.guard();
        let mut file = self.file.lock().map_err(|_| "画像日志锁已损坏")?;
        let current = Self::checkpoint_locked(&file)?;
        if checkpoint.bytes > current.bytes || checkpoint.records > current.records {
            return Err("画像历史尚未追平指定水位".into());
        }
        {
            let guards = self.guards.lock().map_err(|_| "历史凭据缓存锁已损坏")?;
            if guards.get(&guard) == Some(checkpoint) {
                return Ok(guard);
            }
            if guards.len() >= MAX_HISTORY_GUARDS {
                return Err("画像历史凭据缓存已满".into());
            }
        }
        if checkpoint == &current {
            self.guards
                .lock()
                .map_err(|_| "历史凭据缓存锁已损坏")?
                .insert(guard.clone(), checkpoint.clone());
            return Ok(guard);
        }
        file.file
            .seek(SeekFrom::Start(0))
            .map_err(|_| "画像历史读取定位失败")?;
        let checked = (|| {
            let mut remaining = checkpoint.bytes;
            let mut hash = Sha256::new();
            let mut records = 0_u64;
            let mut last = None;
            let mut buffer = [0_u8; 64 * 1024];
            while remaining > 0 {
                let maximum = remaining.min(buffer.len() as u64) as usize;
                let read = file
                    .file
                    .read(&mut buffer[..maximum])
                    .map_err(|_| "画像历史前缀读取失败")?;
                if read == 0 {
                    return Err("画像历史前缀提前结束");
                }
                hash.update(&buffer[..read]);
                records += buffer[..read].iter().filter(|byte| **byte == b'\n').count() as u64;
                last = Some(buffer[read - 1]);
                remaining -= read as u64;
            }
            if records != checkpoint.records
                || (checkpoint.bytes > 0 && last != Some(b'\n'))
                || format!("{:x}", hash.finalize()) != checkpoint.sha256
            {
                return Err("画像历史前缀与指定水位不符");
            }
            Ok(())
        })();
        file.file
            .seek(SeekFrom::End(0))
            .map_err(|_| "画像历史恢复写入位置失败")?;
        checked?;
        self.guards
            .lock()
            .map_err(|_| "历史凭据缓存锁已损坏")?
            .insert(guard.clone(), checkpoint.clone());
        Ok(guard)
    }

    pub fn accepts_guard(&self, guard: &str) -> bool {
        self.usable.load(Ordering::Acquire)
            && self
                .guards
                .lock()
                .is_ok_and(|guards| guards.contains_key(guard))
    }

    pub fn contains(&self, event: &ProfileEvent) -> Result<bool, String> {
        let key = Self::key(&event.subject, &event.event_id);
        let fingerprint = event_fingerprint(event);
        let events = self
            .event_fingerprints
            .lock()
            .map_err(|_| "profile_log_lock_poisoned".to_string())?;
        match events.get(&key) {
            None => Ok(false),
            Some(existing) if existing == &fingerprint => Ok(true),
            Some(_) => Err("profile_event_id_conflict".into()),
        }
    }

    fn key(subject: &str, event_id: &str) -> String {
        format!("{subject}\u{0}{event_id}")
    }
}

#[derive(Debug, Serialize)]
pub struct ProfileHistoryHandoff {
    pub schema: &'static str,
    pub checkpoint: ProfileHistoryCheckpoint,
    pub source_sealed: bool,
    pub destination_created: bool,
}

/// 停机转移：持有源文件独占锁封存，再不可覆盖发布完整副本；失败后源仍保持封存。
pub fn handoff_profile_log(
    source: &Path,
    destination: &Path,
    catalog_sha256: &str,
) -> Result<ProfileHistoryHandoff, String> {
    if destination.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".shard.json")
    }) {
        return Err("转移日志不能占用分片标记保留后缀".into());
    }
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "转移源不存在")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("转移源必须是普通文件".into());
    }
    let source_path = source
        .canonicalize()
        .map_err(|_| "转移源规范路径读取失败")?;
    let source = source_path.as_path();
    if destination.try_exists().map_err(|_| "转移目标状态不可读")? {
        return Err("转移目标已存在，禁止覆盖".into());
    }
    if seal_path(destination)
        .try_exists()
        .map_err(|_| "目标封存状态不可读")?
    {
        return Err("转移目标已有封存记录，禁止复用".into());
    }
    if shard_path(destination)
        .try_exists()
        .map_err(|_| "转移目标分片状态不可读")?
    {
        return Err("转移目标已有分片记录，禁止复用".into());
    }
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let destination = parent
        .canonicalize()
        .map_err(|_| "转移目标父目录不存在")?
        .join(destination.file_name().ok_or("转移目标文件名无效")?);
    let marker = seal_path(source);
    let marker_parent = marker
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if destination
        == marker_parent
            .canonicalize()
            .map_err(|_| "封存路径无效")?
            .join(marker.file_name().ok_or("封存文件名无效")?)
    {
        return Err("转移目标不能占用源封存记录".into());
    }
    let (log, events) = ProfileEventLog::open_inner(source, catalog_sha256, true)?;
    let mut profiles: HashMap<String, ProfileState> = HashMap::new();
    for observed in &events {
        let event = &observed.payload.event;
        if !profiles.contains_key(&event.subject) && profiles.len() >= MAX_PROFILE_SUBJECTS {
            return Err("转移源画像主体数超过限制，未封存".into());
        }
        profiles
            .entry(event.subject.clone())
            .or_default()
            .apply_observed(event, &observed.payload.facts)
            .map_err(|_| "转移源无法重建有效画像，未封存")?;
    }
    drop(profiles);
    drop(events);
    let checkpoint = log.checkpoint()?;
    log.file
        .lock()
        .map_err(|_| "画像日志锁已损坏")?
        .file
        .sync_all()
        .map_err(|_| "转移源同步失败，未封存")?;
    let encoded = serde_json::to_vec(&ProfileSeal {
        schema: "profile-log-seal-v1".into(),
        checkpoint: checkpoint.clone(),
        destination: destination.clone(),
    })
    .map_err(|_| "封存记录编码失败")?;
    if encoded.len() > 4096 {
        return Err("封存记录超过4KiB，未封存".into());
    }
    match atomic_create(&marker, |writer| writer.write_all(&encoded)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut bytes = Vec::new();
            File::open(&marker)
                .map_err(|_| "封存记录读取失败")?
                .take(4097)
                .read_to_end(&mut bytes)
                .map_err(|_| "封存记录读取失败")?;
            let seal: ProfileSeal = serde_json::from_slice(&bytes).map_err(|_| "封存记录无效")?;
            if bytes.len() > 4096
                || seal.schema != "profile-log-seal-v1"
                || seal.checkpoint != checkpoint
                || seal.destination != destination
            {
                return Err("源日志与封存水位不符".into());
            }
        }
        Err(_) => return Err("封存记录发布失败，未创建目标".into()),
    }
    let mut file = log.file.lock().map_err(|_| "画像日志锁已损坏")?;
    file.sealed = true;
    log.usable.store(false, Ordering::Release);
    file.file
        .seek(SeekFrom::Start(0))
        .map_err(|_| "转移源定位失败")?;
    atomic_create(&destination, |writer| {
        let mut hash = Sha256::new();
        let mut remaining = checkpoint.bytes;
        let mut buffer = [0_u8; 64 * 1024];
        while remaining > 0 {
            let maximum = remaining.min(buffer.len() as u64) as usize;
            let read = file.file.read(&mut buffer[..maximum])?;
            if read == 0 {
                return Err(std::io::Error::other("转移源提前结束"));
            }
            hash.update(&buffer[..read]);
            writer.write_all(&buffer[..read])?;
            remaining -= read as u64;
        }
        if format!("{:x}", hash.finalize()) != checkpoint.sha256 {
            return Err(std::io::Error::other("转移源与封存指纹不符"));
        }
        Ok(())
    })
    .map_err(|_| "转移目标发布失败；源保持封存，可核对后重试")?;
    Ok(ProfileHistoryHandoff {
        schema: "profile-history-handoff-v1",
        checkpoint,
        source_sealed: true,
        destination_created: true,
    })
}

#[derive(Debug, Serialize)]
pub struct ProfileLogMigration {
    pub schema: &'static str,
    pub events: usize,
    pub source_bytes: u64,
    pub destination_bytes: u64,
    pub source_sha256: String,
    pub destination_sha256: String,
    pub original_catalog_sha256: String,
    pub source_unchanged: bool,
}

/// 仅向新文件发布；原目录身份由操作者提供并核对，不从当前目录推测历史。
pub fn migrate_legacy_profile_log(
    source: &Path,
    destination: &Path,
    original_catalog_bytes: &[u8],
    expected_catalog_sha256: &str,
) -> Result<ProfileLogMigration, String> {
    let catalog_sha256 = format!("{:x}", Sha256::digest(original_catalog_bytes));
    if !valid_sha256(expected_catalog_sha256)
        || catalog_sha256 != expected_catalog_sha256
        || original_catalog_bytes.len() > 8 * 1024 * 1024
    {
        return Err("原目录指纹不符或超过大小限制".into());
    }
    let catalog: PublicCatalog =
        serde_json::from_slice(original_catalog_bytes).map_err(|_| "原目录格式无效")?;
    catalog.validate().map_err(|_| "原目录校验失败")?;
    let candidates: HashMap<_, _> = catalog
        .items
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let file = File::open(source).map_err(|_| "旧版画像日志读取失败")?;
    file.try_lock_shared()
        .map_err(|_| "旧版日志仍有活动写入者，不能迁移")?;
    let source_bytes = file.metadata().map_err(|_| "旧版日志属性读取失败")?.len();
    if source_bytes > MAX_LOG_BYTES {
        return Err("旧版画像日志超过容量限制".into());
    }
    let mut reader = BufReader::new(&file);
    let mut line = Vec::new();
    let mut bytes = Vec::new();
    let mut source_hash = Sha256::new();
    let mut seen = HashSet::new();
    let mut profiles: HashMap<String, ProfileState> = HashMap::new();
    let mut sequences: HashMap<String, u64> = HashMap::new();
    let mut events = 0;
    loop {
        line.clear();
        let read = reader
            .by_ref()
            .take((MAX_RECORD_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "旧版日志记录读取失败")?;
        if read == 0 {
            break;
        }
        // 迁移不能修补源文件；任何未完成尾部都必须先独立恢复。
        if line.len() > MAX_RECORD_BYTES + 1 || !line.ends_with(b"\n") {
            return Err("旧版日志有越界记录或未完成尾部，迁移未发布".into());
        }
        source_hash.update(&line);
        let record: LegacyRecord =
            serde_json::from_slice(&line).map_err(|_| "旧版日志记录格式无效")?;
        let event = record.event;
        if record.schema != LEGACY_SCHEMA
            || !seen.insert(ProfileEventLog::key(&event.subject, &event.event_id))
        {
            return Err("迁移只接受无重复记录的旧版画像日志".into());
        }
        if !profiles.contains_key(&event.subject) && profiles.len() >= MAX_PROFILE_SUBJECTS {
            return Err("迁移后的画像主体数超过限制".into());
        }
        let candidate = candidates
            .get(event.candidate_id.as_str())
            .ok_or("原目录缺少历史候选，不能迁移")?;
        profiles
            .entry(event.subject.clone())
            .or_default()
            .apply(&event, candidate)
            .map_err(|_| "旧版事件无法应用到原目录")?;
        let previous = sequences.get(&event.subject).copied().unwrap_or(0);
        let sequence = previous.checked_add(1).ok_or("画像日志序号已达上限")?;
        let envelope = observed(
            &event,
            &ProfileEventFacts::from(*candidate),
            sequence,
            &catalog_sha256,
        );
        validate(&envelope, previous)?;
        let mut encoded = serde_json::to_vec(&EventRecord {
            schema: SCHEMA.to_string(),
            envelope,
        })
        .map_err(|_| "迁移事件编码失败")?;
        encoded.push(b'\n');
        if encoded.len() > MAX_RECORD_BYTES
            || bytes.len() as u64 + encoded.len() as u64 > MAX_LOG_BYTES
        {
            return Err("迁移后的画像日志超过容量限制，未发布".into());
        }
        bytes.extend(encoded);
        sequences.insert(event.subject, sequence);
        events += 1;
    }
    atomic_create(destination, |writer| writer.write_all(&bytes))
        .map_err(|error| format!("迁移文件发布失败，禁止覆盖已有目标：{error}"))?;
    Ok(ProfileLogMigration {
        schema: "profile-log-migration-v1",
        events,
        source_bytes,
        destination_bytes: bytes.len() as u64,
        source_sha256: format!("{:x}", source_hash.finalize()),
        destination_sha256: format!("{:x}", Sha256::digest(&bytes)),
        original_catalog_sha256: catalog_sha256,
        source_unchanged: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use vs_core::profile::{ProfileEvent, ProfileEventKind};
    const CATALOG_SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn facts() -> ProfileEventFacts {
        ProfileEventFacts {
            domain: "video".into(),
            tags: vec!["rust".into()],
        }
    }

    fn event(id: &str) -> ProfileEvent {
        ProfileEvent {
            event_id: id.into(),
            subject: "user-a".into(),
            candidate_id: "video".into(),
            kind: ProfileEventKind::Like,
        }
    }

    #[test]
    fn append_is_deduplicated_across_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("profile.jsonl");
        let (log, events) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        assert!(events.is_empty());
        assert_eq!(
            log.append(&event("event-1"), &facts()).unwrap(),
            AppendResult::Appended
        );
        assert_eq!(
            log.append(&event("event-1"), &facts()).unwrap(),
            AppendResult::Duplicate
        );
        drop(log);
        let (log, events) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            log.append(&event("event-1"), &facts()).unwrap(),
            AppendResult::Duplicate
        );
    }

    #[test]
    fn event_id_reuse_with_changed_payload_is_rejected_after_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("profile.jsonl");
        let original = event("event-1");
        let mut changed = original.clone();
        changed.kind = vs_core::profile::ProfileEventKind::Hide;

        let (log, _) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        assert_eq!(
            log.append(&original, &facts()).unwrap(),
            AppendResult::Appended
        );
        let checkpoint = log.checkpoint().unwrap();
        assert!(log.contains(&original).unwrap());
        assert_eq!(
            log.contains(&changed).unwrap_err(),
            "profile_event_id_conflict"
        );
        assert_eq!(
            log.append(&changed, &facts()).unwrap_err(),
            "profile_event_id_conflict"
        );
        changed = original.clone();
        changed.candidate_id = "document".into();
        assert_eq!(
            log.append(&changed, &facts()).unwrap_err(),
            "profile_event_id_conflict"
        );
        assert_eq!(log.checkpoint().unwrap(), checkpoint);
        drop(log);

        let bytes_before = std::fs::read(&path).unwrap();
        let (log, replayed) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        assert_eq!(replayed.len(), 1);
        assert_eq!(
            log.append(&changed, &facts()).unwrap_err(),
            "profile_event_id_conflict"
        );
        assert_eq!(log.checkpoint().unwrap(), checkpoint);
        drop(log);
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before);
        let (log, _) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        let mut other_subject = original.clone();
        other_subject.subject = "user-b".into();
        assert_eq!(
            log.append(&other_subject, &facts()).unwrap(),
            AppendResult::Appended
        );
        assert_eq!(log.checkpoint().unwrap().records, 2);
    }

    #[test]
    fn valid_seal_can_resume_only_to_its_original_destination() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source");
        let destination = dir.path().canonicalize().unwrap().join("destination");
        let (log, _) = ProfileEventLog::open(&source, CATALOG_SHA).unwrap();
        log.append(&event("first"), &facts()).unwrap();
        let checkpoint = log.checkpoint().unwrap();
        drop(log);
        let marker = serde_json::to_vec(&ProfileSeal {
            schema: "profile-log-seal-v1".into(),
            checkpoint: checkpoint.clone(),
            destination: destination.clone(),
        })
        .unwrap();
        atomic_create(&seal_path(&source), |writer| writer.write_all(&marker)).unwrap();
        assert!(ProfileEventLog::open(&source, CATALOG_SHA).is_err());
        assert!(handoff_profile_log(&source, &dir.path().join("another"), CATALOG_SHA).is_err());
        let receipt = handoff_profile_log(&source, &destination, CATALOG_SHA).unwrap();
        assert_eq!(receipt.checkpoint, checkpoint);
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            std::fs::read(&source).unwrap()
        );
        assert!(handoff_profile_log(&source, &destination, CATALOG_SHA).is_err());
    }

    #[test]
    fn changed_sealed_source_cannot_be_reissued_as_another_checkpoint() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source");
        let destination = dir.path().canonicalize().unwrap().join("destination");
        let (log, _) = ProfileEventLog::open(&source, CATALOG_SHA).unwrap();
        log.append(&event("first"), &facts()).unwrap();
        let checkpoint = log.checkpoint().unwrap();
        drop(log);
        let marker = serde_json::to_vec(&ProfileSeal {
            schema: "profile-log-seal-v1".into(),
            checkpoint,
            destination: destination.clone(),
        })
        .unwrap();
        atomic_create(&seal_path(&source), |writer| writer.write_all(&marker)).unwrap();
        let original = std::fs::read_to_string(&source).unwrap();
        std::fs::write(&source, original.replace("first", "other")).unwrap();
        assert!(handoff_profile_log(&source, &destination, CATALOG_SHA).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn prefix_guard_budget_is_bounded_and_failed_proofs_do_not_take_slots() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("source");
        let (log, _) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        let mut checkpoints = Vec::new();
        for index in 0..MAX_HISTORY_GUARDS + 1 {
            log.append(&event(&format!("event-{index}")), &facts())
                .unwrap();
            checkpoints.push(log.checkpoint().unwrap());
        }
        let mut invalid = checkpoints[0].clone();
        invalid.sha256 = "b".repeat(64);
        for _ in 0..MAX_HISTORY_GUARDS + 1 {
            assert!(log.verify_checkpoint(&invalid).is_err());
        }
        for checkpoint in checkpoints.iter().take(MAX_HISTORY_GUARDS) {
            let guard = log.verify_checkpoint(checkpoint).unwrap();
            assert!(log.accepts_guard(&guard));
        }
        assert!(log.verify_checkpoint(checkpoints.last().unwrap()).is_err());
        assert!(log.verify_checkpoint(&checkpoints[0]).is_ok());
    }

    #[test]
    fn malformed_records_fail_closed() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("profile.jsonl");
        std::fs::write(&path, b"{\"schema\":\"wrong\"}\n").unwrap();
        assert!(ProfileEventLog::open(&path, CATALOG_SHA).is_err());
    }

    #[test]
    fn incomplete_final_record_is_discarded_before_future_appends() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("profile.jsonl");
        let (log, _) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        log.append(&event("event-1"), &facts()).unwrap();
        drop(log);
        let valid_length = std::fs::metadata(&path).unwrap().len();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"schema\":\"profile-event-v1\"")
            .unwrap();

        let (log, events) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), valid_length);
        assert_eq!(
            log.append(&event("event-2"), &facts()).unwrap(),
            AppendResult::Appended
        );
    }

    #[test]
    fn a_second_writer_cannot_open_the_same_local_log() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("profile.jsonl");
        let (log, _) = ProfileEventLog::open(&path, CATALOG_SHA).unwrap();
        assert!(matches!(
            ProfileEventLog::open(&path, CATALOG_SHA),
            Err(error) if error == "profile_log_writer_already_active"
        ));
        drop(log);
        assert!(ProfileEventLog::open(&path, CATALOG_SHA).is_ok());
    }

    #[test]
    fn envelope_corruption_and_unknown_projection_rules_fail_without_rewriting() {
        let directory = tempdir().unwrap();
        let original = directory.path().join("original.jsonl");
        let (log, _) = ProfileEventLog::open(&original, CATALOG_SHA).unwrap();
        log.append(&event("event-1"), &facts()).unwrap();
        drop(log);
        let bytes = std::fs::read(&original).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        for (field, replacement) in [
            ("/envelope/sequence", serde_json::json!(2)),
            ("/envelope/aggregate_id", serde_json::json!("other-user")),
            (
                "/envelope/metadata/projection_version",
                serde_json::json!("future-rule"),
            ),
            (
                "/envelope/metadata/catalog_sha256",
                serde_json::json!("bad-hash"),
            ),
            (
                "/envelope/payload/facts/tags",
                serde_json::json!(["repeated", "repeated"]),
            ),
            ("/schema", serde_json::json!("profile-event-v3")),
        ] {
            let mut damaged = value.clone();
            *damaged.pointer_mut(field).unwrap() = replacement;
            let mut damaged_bytes = serde_json::to_vec(&damaged).unwrap();
            damaged_bytes.push(b'\n');
            let path = directory.path().join("damaged.jsonl");
            std::fs::write(&path, &damaged_bytes).unwrap();
            assert!(
                ProfileEventLog::open(&path, CATALOG_SHA).is_err(),
                "{field}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), damaged_bytes);
        }
        let duplicated = [bytes.as_slice(), bytes.as_slice()].concat();
        std::fs::write(&original, &duplicated).unwrap();
        assert!(ProfileEventLog::open(&original, CATALOG_SHA).is_err());
        assert_eq!(std::fs::read(&original).unwrap(), duplicated);
    }

    #[test]
    fn legacy_migration_is_explicit_pinned_and_never_overwrites_either_file() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("v1.jsonl");
        let destination = directory.path().join("v2.jsonl");
        let legacy = format!(
            "{}\n",
            serde_json::json!({"schema":LEGACY_SCHEMA,"event":event("legacy-1")})
        );
        std::fs::write(&source, &legacy).unwrap();
        assert!(
            ProfileEventLog::open(&source, CATALOG_SHA)
                .err()
                .unwrap()
                .contains("离线迁移")
        );
        let catalog = br#"{"version":"original","items":[{"id":"video","domain":"video","tags":["original-tag"],"prior":0.5,"media_sha256":null}],"assets":[]}"#;
        let fingerprint = format!("{:x}", Sha256::digest(catalog));
        assert!(migrate_legacy_profile_log(&source, &destination, catalog, CATALOG_SHA).is_err());
        assert!(!destination.exists());
        let active = File::options()
            .read(true)
            .write(true)
            .open(&source)
            .unwrap();
        active.try_lock().unwrap();
        assert!(migrate_legacy_profile_log(&source, &destination, catalog, &fingerprint).is_err());
        drop(active);
        let receipt =
            migrate_legacy_profile_log(&source, &destination, catalog, &fingerprint).unwrap();
        assert_eq!(receipt.events, 1);
        assert_eq!(std::fs::read(&source).unwrap(), legacy.as_bytes());
        let final_bytes = std::fs::read(&destination).unwrap();
        assert!(migrate_legacy_profile_log(&source, &destination, catalog, &fingerprint).is_err());
        assert!(migrate_legacy_profile_log(&source, &source, catalog, &fingerprint).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), legacy.as_bytes());
        assert_eq!(std::fs::read(&destination).unwrap(), final_bytes);
        let (_, events) = ProfileEventLog::open(&destination, CATALOG_SHA).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].metadata.catalog_sha256, fingerprint);
        assert_eq!(events[0].payload.facts.tags, ["original-tag"]);
    }

    #[test]
    fn legacy_migration_rejects_torn_unknown_missing_or_duplicate_history() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("v1.jsonl");
        let destination = directory.path().join("v2.jsonl");
        let catalog = br#"{"version":"original","items":[{"id":"video","domain":"video","tags":[],"prior":0.5,"media_sha256":null}],"assets":[]}"#;
        let fingerprint = format!("{:x}", Sha256::digest(catalog));
        let legacy = format!(
            "{}\n",
            serde_json::json!({"schema":LEGACY_SCHEMA,"event":event("legacy-1")})
        );
        let mut missing = event("missing");
        missing.candidate_id = "absent".into();
        let missing = format!(
            "{}\n",
            serde_json::json!({"schema":LEGACY_SCHEMA,"event":missing})
        );
        for bytes in [
            b"{".to_vec(),
            b"{\"schema\":\"unknown\"}\n".to_vec(),
            missing.into_bytes(),
            legacy.repeat(2).into_bytes(),
        ] {
            std::fs::write(&source, &bytes).unwrap();
            assert!(
                migrate_legacy_profile_log(&source, &destination, catalog, &fingerprint).is_err()
            );
            assert!(!destination.exists());
            assert_eq!(std::fs::read(&source).unwrap(), bytes);
        }
    }
}
