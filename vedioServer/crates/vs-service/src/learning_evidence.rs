use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::PublicCatalog,
    event_order::{InteractionOrder, SampleChronology},
    learning::{
        PreferenceFeedback, RankTrainingSet, TrainingDataKind, TrainingSample, is_sha256,
        validate_training_set,
    },
    valid_id,
};

use crate::{
    learning_journal::{DecisionRecord, MAX_JOURNAL_BYTES, parse_decisions},
    rank_model::MAX_TRAINING_BYTES,
    upstream::atomic_create::atomic_create,
};

pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_GATEWAY_EVENTS: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedEvidenceFile {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceExportManifest {
    pub schema: String,
    pub data_kind: TrainingDataKind,
    pub catalog_sha256: String,
    pub catalog_as_of: u64,
    pub train_before: u64,
    pub decision_logs: Vec<PinnedEvidenceFile>,
    pub gateway_source_id: String,
    pub gateway_events: PinnedEvidenceFile,
    pub excluded_subjects: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayEventKind {
    Visible,
    Like,
    Dislike,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayLearningEvent {
    pub event_id: String,
    pub decision_id: String,
    pub subject: String,
    pub candidate_id: String,
    pub at: u64,
    pub kind: GatewayEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<InteractionOrder>,
}

/// 网关必须验证用户身份和显示回调；该文件是可信来源的声明，不是渲染证明。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayLearningArchive {
    pub schema: String,
    pub source_id: String,
    pub data_kind: TrainingDataKind,
    pub events: Vec<GatewayLearningEvent>,
}

#[derive(Debug, Serialize)]
pub struct EvidenceExportReceipt {
    pub schema: &'static str,
    pub training_sha256: String,
    pub catalog_sha256: String,
    pub decision_log_sha256: Vec<String>,
    pub gateway_events_sha256: String,
    pub data_kind: TrainingDataKind,
    pub train_before: u64,
    pub samples: usize,
    pub duplicate_events: usize,
    pub excluded_events: usize,
    pub deferred_feedback: usize,
    pub visible_without_label: usize,
    pub issued_without_visibility: usize,
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub evidence_boundary: &'static str,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

pub(crate) fn read_pinned(
    root: &Path,
    evidence: &PinnedEvidenceFile,
    limit: usize,
    total: &mut usize,
) -> io::Result<Vec<u8>> {
    if !is_sha256(&evidence.sha256) {
        return Err(invalid("来源文件指纹无效"));
    }
    let relative = evidence
        .path
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value),
            _ => Err(invalid("来源路径必须是清单目录下的相对普通路径")),
        })
        .collect::<io::Result<PathBuf>>()?;
    if relative.as_os_str().is_empty() {
        return Err(invalid("来源路径不能为空"));
    }
    let root = root.canonicalize()?;
    let resolved = root.join(relative).canonicalize()?;
    if !resolved.starts_with(&root) {
        return Err(invalid("来源路径解析后超出清单目录"));
    }
    let file = File::open(resolved)?;
    // 活动写入者持有独占锁；导出使用停写文件或不可变快照，不追随增长中的日志。
    file.try_lock_shared()
        .map_err(|_| invalid("来源文件仍在写入或锁不可用"))?;
    let mut bytes = Vec::new();
    let remaining = limit.min(MAX_INPUT_BYTES.saturating_sub(*total));
    (&file).take(remaining as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit || total.saturating_add(bytes.len()) > MAX_INPUT_BYTES {
        return Err(invalid("证据文件或合计输入超过预算"));
    }
    if format!("{:x}", Sha256::digest(&bytes)) != evidence.sha256 {
        return Err(invalid("来源文件内容与固定指纹不符"));
    }
    *total += bytes.len();
    Ok(bytes)
}

fn exposure_id(decision_id: &str, candidate_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{decision_id}:{candidate_id}"))
    )
}

pub(crate) struct PreparedEvidence {
    pub catalog: PublicCatalog,
    pub decisions: HashMap<String, DecisionRecord>,
    pub samples: Vec<TrainingSample>,
    pub visible_by_decision: HashMap<String, usize>,
    pub duplicate_events: usize,
    pub excluded_events: usize,
    pub deferred_feedback: usize,
    pub visible_without_label: usize,
    pub issued_without_visibility: usize,
    pub input_bytes: usize,
}

fn unique_gateway_events(
    archive: &GatewayLearningArchive,
) -> io::Result<(Vec<&GatewayLearningEvent>, usize)> {
    let mut seen: HashMap<&str, &GatewayLearningEvent> = HashMap::new();
    let mut duplicates = 0;
    for event in &archive.events {
        if !valid_id(&event.event_id)
            || !is_sha256(&event.decision_id)
            || !valid_id(&event.subject)
            || !valid_id(&event.candidate_id)
            || event.order.as_ref().is_some_and(|order| {
                archive.schema == "gateway-learning-events-v1" || !order.is_valid()
            })
        {
            return Err(invalid("网关事件标识、顺序或版本无效"));
        }
        if let Some(previous) = seen.get_mut(event.event_id.as_str()) {
            let original = *previous;
            if (
                &original.decision_id,
                &original.subject,
                &original.candidate_id,
                original.at,
                original.kind,
            ) != (
                &event.decision_id,
                &event.subject,
                &event.candidate_id,
                event.at,
                event.kind,
            ) || original
                .order
                .as_ref()
                .zip(event.order.as_ref())
                .is_some_and(|(a, b)| a != b)
            {
                return Err(invalid("同一事件ID被用于不同内容或冲突顺序"));
            }
            // 迁移时同一原始事件可补齐缺失顺序，但不能改写已存在的时间或其他字段。
            if original.order.is_none() && event.order.is_some() {
                *previous = event;
            }
            duplicates += 1;
        } else {
            seen.insert(&event.event_id, event);
        }
    }
    let events: Vec<_> = seen.into_values().collect();
    let mut ordered: Vec<_> = events
        .iter()
        .copied()
        .filter(|event| event.order.is_some())
        .collect();
    ordered.sort_unstable_by(|a, b| {
        let a = a.order.as_ref().unwrap();
        let b = b.order.as_ref().unwrap();
        (&a.interaction_id, a.generation, a.sequence).cmp(&(
            &b.interaction_id,
            b.generation,
            b.sequence,
        ))
    });
    for pair in ordered.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let (left, right) = (a.order.as_ref().unwrap(), b.order.as_ref().unwrap());
        if left.same_stream(right)
            && (!left.precedes(right)
                || a.at > b.at
                || (&a.subject, &a.decision_id, &a.candidate_id)
                    != (&b.subject, &b.decision_id, &b.candidate_id))
        {
            return Err(invalid("同一交互代次存在序号冲突、时间倒退或主体/候选串用"));
        }
    }
    Ok((events, duplicates))
}

pub(crate) fn prepare_evidence(
    root: &Path,
    catalog_bytes: &[u8],
    manifest: &EvidenceExportManifest,
) -> io::Result<PreparedEvidence> {
    if catalog_bytes.len() > 8 * 1024 * 1024 {
        return Err(invalid("导出目录超过预算"));
    }
    let catalog: PublicCatalog =
        serde_json::from_slice(catalog_bytes).map_err(|_| invalid("导出目录JSON无效"))?;
    catalog
        .validate()
        .map_err(|_| invalid("导出目录结构无效"))?;
    if manifest.schema != "learning-evidence-export-v1"
        || manifest.catalog_sha256 != format!("{:x}", Sha256::digest(catalog_bytes))
        || manifest.catalog_as_of >= manifest.train_before
        || manifest.decision_logs.is_empty()
        || manifest.decision_logs.len() > 16
        || !valid_id(&manifest.gateway_source_id)
        || manifest.excluded_subjects.len() > 10_000
        || manifest
            .excluded_subjects
            .iter()
            .any(|subject| !valid_id(subject))
    {
        return Err(invalid("导出清单的版本、目录、截止时间或容量无效"));
    }
    let excluded: HashSet<_> = manifest
        .excluded_subjects
        .iter()
        .map(String::as_str)
        .collect();
    if excluded.len() != manifest.excluded_subjects.len() {
        return Err(invalid("排除主体重复"));
    }
    let mut total = 0;
    let mut decisions: HashMap<String, DecisionRecord> = HashMap::new();
    let mut sources = HashSet::new();
    for evidence in &manifest.decision_logs {
        let bytes = read_pinned(root, evidence, MAX_JOURNAL_BYTES, &mut total)?;
        let records = parse_decisions(&bytes, &catalog, &manifest.catalog_sha256)
            .map_err(|_| invalid("决策日志的内容、序号或指纹链无效"))?;
        let Some(first) = records.first() else {
            return Err(invalid("导出来源中存在空决策日志"));
        };
        if !sources.insert(first.envelope.aggregate_id.clone()) {
            return Err(invalid("不同日志使用了同一副本标识，不能合并"));
        }
        for record in records {
            if record.envelope.payload.snapshot_at < manifest.catalog_as_of
                || decisions
                    .insert(record.decision_id.clone(), record)
                    .is_some()
            {
                return Err(invalid("决策早于目录快照或存在重复决策"));
            }
        }
    }
    let bytes = read_pinned(root, &manifest.gateway_events, MAX_INPUT_BYTES, &mut total)?;
    let archive = crate::feedback_evidence::read_learning_archive(&bytes)?;
    if !matches!(
        archive.schema.as_str(),
        "gateway-learning-events-v1" | "gateway-learning-events-v2"
    ) || archive.source_id != manifest.gateway_source_id
        || archive.data_kind != manifest.data_kind
        || archive.events.len() > MAX_GATEWAY_EVENTS
    {
        return Err(invalid("网关来源、数据类型或事件容量无效"));
    }
    let (events, duplicate_events) = unique_gateway_events(&archive)?;
    let mut visible: HashMap<(&str, &str), Vec<&GatewayLearningEvent>> = HashMap::new();
    let mut feedback: HashMap<(&str, &str), &GatewayLearningEvent> = HashMap::new();
    let mut excluded_events = 0;
    let mut deferred_feedback = 0;
    for event in events {
        let decision = decisions
            .get(&event.decision_id)
            .ok_or_else(|| invalid("网关事件引用未知决策"))?;
        let payload = &decision.envelope.payload;
        if event.subject != payload.subject
            || !payload.returned_ids.contains(&event.candidate_id)
            || event.at < payload.issued_at
        {
            return Err(invalid("网关事件串主体、候选未返回或时间早于决策"));
        }
        if excluded.contains(event.subject.as_str()) {
            excluded_events += 1;
            continue;
        }
        if event.at >= manifest.train_before {
            deferred_feedback += usize::from(event.kind != GatewayEventKind::Visible);
            continue;
        }
        let key = (event.decision_id.as_str(), event.candidate_id.as_str());
        match event.kind {
            GatewayEventKind::Visible => {
                // 合并时保留候选可见项，以便在反馈到达后优先匹配相同交互代次。
                visible.entry(key).or_default().push(event);
            }
            GatewayEventKind::Like | GatewayEventKind::Dislike => {
                if feedback.insert(key, event).is_some() {
                    return Err(invalid("同一决策和候选有多个明确反馈，需上游先消解"));
                }
            }
        }
    }
    let mut samples = Vec::new();
    let mut sample_bytes = 512_usize;
    let mut joined = HashSet::new();
    for (key, event) in &feedback {
        let exposures = visible
            .get(key)
            .ok_or_else(|| invalid("明确反馈没有匹配的可见性事件"))?;
        let same_stream = |exposure: &GatewayLearningEvent| {
            exposure
                .order
                .as_ref()
                .zip(event.order.as_ref())
                .is_some_and(|(a, b)| a.same_stream(b))
        };
        let exposure = exposures
            .iter()
            .copied()
            .filter(|exposure| {
                if exposure.at > event.at {
                    return false;
                }
                match exposure.order.as_ref().zip(event.order.as_ref()) {
                    Some((a, b)) if a.same_stream(b) => a.precedes(b),
                    _ => exposure.at < event.at,
                }
            })
            .min_by_key(|exposure| {
                (
                    !same_stream(exposure),
                    exposure.at,
                    if same_stream(exposure) {
                        exposure.order.as_ref().unwrap().sequence
                    } else {
                        0
                    },
                    exposure.event_id.as_str(),
                )
            })
            .ok_or_else(|| invalid("反馈没有先行可见事件；同秒事件需要同一交互代次的有效顺序"))?;
        let payload = &decisions[event.decision_id.as_str()].envelope.payload;
        let mut request = payload.request.clone();
        // 客户端请求ID可能跨重试复用；训练身份改用服务端决策ID，原ID仍留在来源日志。
        request.request_id = event.decision_id.clone();
        let sample = TrainingSample {
            exposure_id: exposure_id(&event.decision_id, &event.candidate_id),
            evidence_ref: event.event_id.clone(),
            profile_as_of: payload.snapshot_at,
            exposed_at: exposure.at,
            feedback_at: event.at,
            chronology: exposure
                .order
                .as_ref()
                .zip(event.order.as_ref())
                .filter(|(a, b)| a.same_stream(b))
                .map(|(exposure, feedback)| SampleChronology {
                    source_id: archive.source_id.clone(),
                    exposure: exposure.clone(),
                    feedback: feedback.clone(),
                }),
            request,
            candidate_id: event.candidate_id.clone(),
            feedback: match event.kind {
                GatewayEventKind::Like => PreferenceFeedback::Like,
                _ => PreferenceFeedback::Dislike,
            },
        };
        // 一个决策可产生多个样本；在克隆更多画像前控制展开后的字节，避免输入小而输出暴涨。
        sample_bytes = sample_bytes
            .saturating_add(serde_json::to_vec(&sample).map_err(io::Error::other)?.len() + 1);
        if sample_bytes > MAX_TRAINING_BYTES {
            return Err(invalid("样本展开超过训练文件预算"));
        }
        samples.push(sample);
        joined.insert(*key);
    }
    samples.sort_unstable_by(|a, b| {
        (a.feedback_at, &a.exposure_id).cmp(&(b.feedback_at, &b.exposure_id))
    });
    let mut visible_by_decision = HashMap::new();
    for (decision, _) in visible.keys() {
        *visible_by_decision
            .entry((*decision).to_string())
            .or_default() += 1;
    }
    let issued_without_visibility = decisions
        .values()
        .filter(|decision| {
            decision.envelope.payload.issued_at < manifest.train_before
                && !excluded.contains(decision.envelope.payload.subject.as_str())
                && !visible_by_decision.contains_key(&decision.decision_id)
        })
        .count();
    Ok(PreparedEvidence {
        catalog,
        decisions,
        samples,
        visible_by_decision,
        duplicate_events,
        excluded_events,
        deferred_feedback,
        visible_without_label: visible.len() - joined.len(),
        issued_without_visibility,
        input_bytes: total,
    })
}

pub fn export_training_evidence(
    root: &Path,
    catalog_bytes: &[u8],
    manifest: &EvidenceExportManifest,
    target: &Path,
) -> io::Result<EvidenceExportReceipt> {
    let prepared = prepare_evidence(root, catalog_bytes, manifest)?;
    let training = RankTrainingSet {
        schema: if prepared
            .samples
            .iter()
            .any(|sample| sample.chronology.is_some())
        {
            "rank-training-v2"
        } else {
            "rank-training-v1"
        }
        .into(),
        data_kind: manifest.data_kind,
        catalog_sha256: manifest.catalog_sha256.clone(),
        catalog_as_of: manifest.catalog_as_of,
        train_before: manifest.train_before,
        samples: prepared.samples,
    };
    validate_training_set(&prepared.catalog, &training)
        .map_err(|_| invalid("导出样本的授权、时间、类型或正负反馈覆盖无效"))?;
    let output = serde_json::to_vec(&training).map_err(io::Error::other)?;
    if output.len() > MAX_TRAINING_BYTES {
        return Err(invalid("导出样本超过训练文件预算"));
    }
    let receipt = EvidenceExportReceipt {
        schema: "learning-evidence-receipt-v1",
        training_sha256: format!("{:x}", Sha256::digest(&output)),
        catalog_sha256: manifest.catalog_sha256.clone(),
        decision_log_sha256: manifest
            .decision_logs
            .iter()
            .map(|file| file.sha256.clone())
            .collect(),
        gateway_events_sha256: manifest.gateway_events.sha256.clone(),
        data_kind: manifest.data_kind,
        train_before: manifest.train_before,
        samples: training.samples.len(),
        duplicate_events: prepared.duplicate_events,
        excluded_events: prepared.excluded_events,
        deferred_feedback: prepared.deferred_feedback,
        visible_without_label: prepared.visible_without_label,
        issued_without_visibility: prepared.issued_without_visibility,
        input_bytes: prepared.input_bytes,
        output_bytes: output.len(),
        evidence_boundary: "可信网关声明；没有渲染证明、随机探索概率或无偏评价保证",
    };
    atomic_create(target, |writer| writer.write_all(&output))?;
    Ok(receipt)
}
