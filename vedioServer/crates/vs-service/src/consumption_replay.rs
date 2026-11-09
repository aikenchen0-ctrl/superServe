use std::{
    collections::{BTreeMap, HashMap},
    io::{self, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    consumption::{
        ByteScope, ClientPlatform, ConsumptionBatch, ConsumptionEvent, ConsumptionObservation,
        normalize_consumption_with_limit,
    },
    feedback_evidence::{FeedbackEvidenceArchive, MAX_FEEDBACK_EVIDENCE_BYTES},
    learning_evidence::{PinnedEvidenceFile, read_pinned},
    upstream::{atomic_create::atomic_create, cumulative_delta::CounterWindow},
};

const MAX_STREAMS: usize = 1024;
const MAX_EVENTS: usize = 8192;
const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumptionReplayConfig {
    pub schema: String,
    pub evidence: PinnedEvidenceFile,
}

#[derive(Debug, Serialize)]
pub struct ConsumptionReplayReceipt {
    pub schema: &'static str,
    pub report_sha256: String,
    pub report_bytes: usize,
    pub interactions: usize,
    pub unique_events: usize,
    pub duplicate_events: usize,
    pub streams_with_missing_sequences: usize,
}

#[derive(Default, Serialize)]
struct Coverage {
    consumption_batches: usize,
    legacy_batches: usize,
    input_events: usize,
    unique_events: usize,
    duplicate_events: usize,
    streams_with_missing_sequences: usize,
}

#[derive(Serialize)]
struct MissingSequences {
    from: u64,
    until_exclusive: u64,
}

#[derive(Serialize)]
struct InteractionReport {
    interaction_ref: String,
    platform: ClientPlatform,
    generation: u64,
    unique_events: usize,
    duplicate_events: usize,
    first_sequence: u64,
    last_sequence: u64,
    missing_sequences: Vec<MissingSequences>,
    first_presentable_elapsed_ms: Option<u64>,
    last_position_ms: Option<u64>,
    visibility_declarations: usize,
    explicit_preferences: usize,
    byte_scope: Option<ByteScope>,
    active_ms: CounterWindow,
    rebuffer_ms: CounterWindow,
    transferred_bytes: CounterWindow,
}

struct Group<'a> {
    context: &'a ConsumptionBatch,
    events: BTreeMap<u64, &'a ConsumptionEvent>,
    duplicates: usize,
}

fn same_context(a: &ConsumptionBatch, b: &ConsumptionBatch) -> bool {
    a.subject == b.subject
        && a.decision_id == b.decision_id
        && a.candidate_id == b.candidate_id
        && a.platform == b.platform
        && a.interaction_id == b.interaction_id
        && a.generation == b.generation
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn group_batches(batches: &[ConsumptionBatch]) -> io::Result<(Vec<Group<'_>>, usize)> {
    let mut groups: BTreeMap<(&str, u64), Group<'_>> = BTreeMap::new();
    let mut seen: HashMap<&str, (&ConsumptionBatch, &ConsumptionEvent)> = HashMap::new();
    let mut duplicates = 0;
    for batch in batches {
        let key = (batch.interaction_id.as_str(), batch.generation);
        if !groups.contains_key(&key) && groups.len() >= MAX_STREAMS {
            return Err(invalid("重建交互代次超过1024项"));
        }
        let group = groups.entry(key).or_insert_with(|| Group {
            context: batch,
            events: BTreeMap::new(),
            duplicates: 0,
        });
        if !same_context(group.context, batch) {
            return Err(invalid("同一交互代次跨批串用主体、决策、候选或平台"));
        }
        for event in &batch.events {
            if let Some((context, original)) = seen.get(event.event_id.as_str()) {
                if !same_context(context, batch) || *original != event {
                    return Err(invalid("同一来源事件ID跨批内容或交互绑定冲突"));
                }
                group.duplicates += 1;
                duplicates += 1;
                continue;
            }
            if group.events.insert(event.sequence, event).is_some() {
                return Err(invalid("同一交互代次的序号被不同事件占用"));
            }
            seen.insert(&event.event_id, (batch, event));
        }
    }
    Ok((groups.into_values().collect(), duplicates))
}

fn interaction_report(group: Group<'_>, at: u64) -> io::Result<InteractionReport> {
    let mut reconstructed = group.context.clone();
    reconstructed.events = group
        .events
        .values()
        .map(|event| (*event).clone())
        .collect();
    // 批次的接收顺序不等于事件顺序；按唯一序号还原后复用原验证链。
    let normalized =
        normalize_consumption_with_limit(&reconstructed, at, MAX_EVENTS).map_err(invalid)?;
    let summary = normalized.summary;
    let context = group.context;
    let identity = serde_json::to_vec(&(
        "consumption-interaction-v1",
        &context.source_id,
        &context.subject,
        &context.decision_id,
        &context.candidate_id,
        context.platform,
        &context.interaction_id,
        context.generation,
    ))
    .map_err(io::Error::other)?;
    let mut report = InteractionReport {
        interaction_ref: hash(&identity),
        platform: context.platform,
        generation: context.generation,
        unique_events: group.events.len(),
        duplicate_events: group.duplicates,
        first_sequence: *group.events.first_key_value().unwrap().0,
        last_sequence: *group.events.last_key_value().unwrap().0,
        missing_sequences: Vec::new(),
        first_presentable_elapsed_ms: summary.first_presentable_elapsed_ms,
        last_position_ms: summary.last_position_ms,
        visibility_declarations: summary.visibility_declarations,
        explicit_preferences: summary.explicit_preferences,
        byte_scope: summary.byte_scope,
        active_ms: CounterWindow::default(),
        rebuffer_ms: CounterWindow::default(),
        transferred_bytes: CounterWindow::default(),
    };
    let mut expected = 1;
    let mut joint_duration: Option<(u64, u64, u64)> = None;
    for event in group.events.values() {
        if event.sequence > expected {
            report.missing_sequences.push(MissingSequences {
                from: expected,
                until_exclusive: event.sequence,
            });
        }
        expected = event.sequence + 1;
        if let ConsumptionObservation::Progress {
            active_ms,
            rebuffer_ms,
            transferred_bytes,
            ..
        } = event.observation
        {
            if let (Some(active), Some(waiting)) = (active_ms, rebuffer_ms) {
                if let Some((previous_active, previous_waiting, elapsed)) = joint_duration
                    && (active < previous_active
                        || waiting < previous_waiting
                        || active - previous_active + waiting - previous_waiting
                            > event.elapsed_ms - elapsed)
                {
                    return Err(invalid("同区间活动和等待增量之和超过已流逝时间"));
                }
                joint_duration = Some((active, waiting, event.elapsed_ms));
            }
            report
                .active_ms
                .observe(active_ms, event.sequence, event.elapsed_ms, true)
                .map_err(invalid)?;
            report
                .rebuffer_ms
                .observe(rebuffer_ms, event.sequence, event.elapsed_ms, true)
                .map_err(invalid)?;
            report
                .transferred_bytes
                .observe(transferred_bytes, event.sequence, event.elapsed_ms, false)
                .map_err(invalid)?;
        }
    }
    Ok(report)
}

/// 单份固定证据内重建；摘要可核查但不证明来源真实性、真实观看或匿名化。
pub fn replay_consumption_evidence(
    root: &Path,
    config: &ConsumptionReplayConfig,
    target: &Path,
) -> io::Result<ConsumptionReplayReceipt> {
    if config.schema != "consumption-replay-v1" {
        return Err(invalid("消费重建配置版本无效"));
    }
    let mut input_bytes = 0;
    let bytes = read_pinned(
        root,
        &config.evidence,
        MAX_FEEDBACK_EVIDENCE_BYTES,
        &mut input_bytes,
    )?;
    let archive: FeedbackEvidenceArchive =
        serde_json::from_slice(&bytes).map_err(|_| invalid("消费重建需要原始反馈证据归档"))?;
    let mut batches = Vec::new();
    let mut coverage = Coverage::default();
    archive.visit_payloads(|payload, projected| {
        if let Some(events) = projected.consumption_events {
            coverage.consumption_batches += 1;
            coverage.input_events += events;
            if coverage.input_events > MAX_EVENTS {
                return Err(invalid("消费重建原始事件超过8192项"));
            }
            batches.push(
                serde_json::from_slice::<ConsumptionBatch>(payload)
                    .map_err(|_| invalid("已校验消费载荷读取失败"))?,
            );
        } else {
            coverage.legacy_batches += 1;
        }
        Ok(())
    })?;
    // 旧学习事件不含QoE；即使存在也不能推测或补零。
    if batches.is_empty() {
        return Err(invalid("原始证据没有消费批次，不能生成QoE重建报告"));
    }
    let (groups, duplicates) = group_batches(&batches)?;
    coverage.duplicate_events = duplicates;
    let mut interactions = groups
        .into_iter()
        .map(|group| interaction_report(group, archive.captured_at))
        .collect::<io::Result<Vec<_>>>()?;
    interactions.sort_unstable_by(|a, b| a.interaction_ref.cmp(&b.interaction_ref));
    for interaction in &interactions {
        coverage.unique_events += interaction.unique_events;
        coverage.streams_with_missing_sequences +=
            usize::from(!interaction.missing_sequences.is_empty());
    }
    let receipt = ConsumptionReplayReceipt {
        schema: "consumption-replay-receipt-v1",
        report_sha256: String::new(),
        report_bytes: 0,
        interactions: interactions.len(),
        unique_events: coverage.unique_events,
        duplicate_events: coverage.duplicate_events,
        streams_with_missing_sequences: coverage.streams_with_missing_sequences,
    };
    let report = serde_json::json!({
        "schema":"consumption-replay-report-v1",
        "source_evidence_sha256":config.evidence.sha256,
        "data_kind":archive.data_kind,
        "coverage":coverage,
        "interactions":interactions,
        "scope":{
            "single_fixed_archive":true,
            "initial_cumulative_policy":"baseline_only",
            "unknown_values_interpolated":false,
            "missing_sequences_filled":false,
            "counter_window_spans_may_contain_missing_events":true,
            "cross_counter_windows_are_not_assumed_aligned":true,
            "complete_interaction_lifetimes_proven":false,
            "cross_archive_or_partition_deduplication":false,
            "raw_subjects_or_interaction_ids_in_report":false,
            "hashes_prove_anonymity":false,
            "native_devices_or_actual_rendering_proven":false,
            "wire_billing_or_production_gate_passed":false
        }
    });
    let report = serde_json::to_vec_pretty(&report).map_err(io::Error::other)?;
    if report.len() > MAX_REPORT_BYTES {
        return Err(invalid("消费重建报告超过4MiB"));
    }
    atomic_create(target, |writer| writer.write_all(&report))?;
    Ok(ConsumptionReplayReceipt {
        report_sha256: hash(&report),
        report_bytes: report.len(),
        ..receipt
    })
}
