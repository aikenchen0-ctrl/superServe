// SPDX-License-Identifier: MIT
// 从RecBole的time_based_split迁移全局时间掩码；额外按反馈截止和完整决策清除跨窗样本。
// Copyright (c) 2020 RUCAIBox
use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    DomainError,
    catalog::PublicCatalog,
    learning::{RankTrainingSet, validate_training_set},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemporalSplitConfig {
    pub schema: String,
    pub train_before: u64,
    pub validation_before: u64,
    pub embargo_seconds: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct WindowCounts {
    pub training: usize,
    pub validation: usize,
    pub test: usize,
    pub purged: usize,
}

#[derive(Debug, Serialize)]
pub struct TemporalSplitAudit {
    pub schema: &'static str,
    pub config: TemporalSplitConfig,
    pub source_before: u64,
    pub source_samples: usize,
    pub retained: WindowCounts,
    pub domains: BTreeMap<String, WindowCounts>,
    pub purged_decisions: usize,
    pub unknown_subject_samples: usize,
    pub validation_known_subject_samples: usize,
    pub test_known_subject_samples: usize,
    pub subject_disjoint_required: bool,
    pub model_selection_protected: bool,
}

pub struct TemporalSplit {
    pub training: RankTrainingSet,
    pub validation_indices: Vec<usize>,
    pub test_indices: Vec<usize>,
    pub purged_indices: Vec<usize>,
    pub audit: TemporalSplitAudit,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Window {
    Training,
    Validation,
    Test,
    Purged,
}

impl WindowCounts {
    fn add(&mut self, window: Window) {
        match window {
            Window::Training => self.training += 1,
            Window::Validation => self.validation += 1,
            Window::Test => self.test += 1,
            Window::Purged => self.purged += 1,
        }
    }
}

/// 输入必须是先冻结的可信证据；时间切分不能证明原始曝光、画像和目录确实在当时可用。
pub fn temporal_split(
    catalog: &PublicCatalog,
    source: &RankTrainingSet,
    config: &TemporalSplitConfig,
) -> Result<TemporalSplit, DomainError> {
    validate_training_set(catalog, source)?;
    let validation_from = config
        .train_before
        .checked_add(config.embargo_seconds)
        .ok_or(DomainError::Invalid("split_clock"))?;
    let test_from = config
        .validation_before
        .checked_add(config.embargo_seconds)
        .ok_or(DomainError::Invalid("split_clock"))?;
    if config.schema != "rank-temporal-split-v1"
        || config.train_before <= source.catalog_as_of
        || validation_from >= config.validation_before
        || test_from >= source.train_before
    {
        return Err(DomainError::Invalid("split_boundaries"));
    }
    let classify = |exposed: u64, feedback: u64| {
        if exposed < config.train_before {
            if feedback < config.train_before {
                Window::Training
            } else {
                Window::Purged
            }
        } else if exposed < validation_from {
            Window::Purged
        } else if exposed < config.validation_before {
            if feedback < config.validation_before {
                Window::Validation
            } else {
                Window::Purged
            }
        } else if exposed < test_from {
            Window::Purged
        } else {
            Window::Test
        }
    };
    let mut groups = HashMap::new();
    let mut evidence = HashSet::new();
    for sample in &source.samples {
        if !evidence.insert(sample.evidence_ref.as_str()) {
            return Err(DomainError::Invalid("split_duplicate_evidence"));
        }
        let subject = sample
            .request
            .profile
            .as_ref()
            .map(|profile| profile.subject.as_str());
        let window = classify(sample.exposed_at, sample.feedback_at);
        let (owner, group_window) = groups
            .entry(sample.request.request_id.as_str())
            .or_insert((subject, window));
        if *owner != subject {
            return Err(DomainError::Invalid("split_decision_identity"));
        }
        if *group_window != window {
            *group_window = Window::Purged;
        }
    }
    let mut training = RankTrainingSet {
        schema: source.schema.clone(),
        data_kind: source.data_kind,
        catalog_sha256: source.catalog_sha256.clone(),
        catalog_as_of: source.catalog_as_of,
        train_before: config.train_before,
        samples: Vec::new(),
    };
    let mut validation_indices = Vec::new();
    let mut test_indices = Vec::new();
    let mut purged_indices = Vec::new();
    let mut retained = WindowCounts::default();
    let domains_by_id: HashMap<_, _> = catalog
        .items
        .iter()
        .map(|item| (item.id.as_str(), item.domain.as_str()))
        .collect();
    let mut domains: BTreeMap<String, WindowCounts> = BTreeMap::new();
    for (index, sample) in source.samples.iter().enumerate() {
        let window = groups[sample.request.request_id.as_str()].1;
        retained.add(window);
        domains
            .entry(domains_by_id[sample.candidate_id.as_str()].to_owned())
            .or_default()
            .add(window);
        match window {
            Window::Training => training.samples.push(sample.clone()),
            Window::Validation => validation_indices.push(index),
            Window::Test => test_indices.push(index),
            Window::Purged => purged_indices.push(index),
        }
    }
    if validation_indices.is_empty() || test_indices.is_empty() {
        return Err(DomainError::Invalid("split_empty_holdout"));
    }
    // 训练窗口独立验证两类反馈和原时间/授权约束，不靠重采样补齐不足的数据。
    validate_training_set(catalog, &training)?;
    let trained_subjects: HashSet<_> = training
        .samples
        .iter()
        .filter_map(|sample| {
            sample
                .request
                .profile
                .as_ref()
                .map(|profile| profile.subject.as_str())
        })
        .collect();
    let known = |indices: &[usize]| {
        indices
            .iter()
            .filter(|index| {
                source.samples[**index]
                    .request
                    .profile
                    .as_ref()
                    .is_some_and(|profile| trained_subjects.contains(profile.subject.as_str()))
            })
            .count()
    };
    let audit = TemporalSplitAudit {
        schema: "rank-temporal-split-audit-v1",
        config: config.clone(),
        source_before: source.train_before,
        source_samples: source.samples.len(),
        retained,
        domains,
        purged_decisions: groups
            .values()
            .filter(|(_, window)| *window == Window::Purged)
            .count(),
        unknown_subject_samples: source
            .samples
            .iter()
            .filter(|sample| sample.request.profile.is_none())
            .count(),
        validation_known_subject_samples: known(&validation_indices),
        test_known_subject_samples: known(&test_indices),
        subject_disjoint_required: false,
        model_selection_protected: false,
    };
    Ok(TemporalSplit {
        training,
        validation_indices,
        test_indices,
        purged_indices,
        audit,
    })
}
