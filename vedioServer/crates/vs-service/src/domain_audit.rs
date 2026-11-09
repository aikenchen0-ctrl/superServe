// SPDX-License-Identifier: MIT
// 命中/相关条目比例及分组汇总机制改编自recommenders-team/recommenders，
// cc47866b0599721f8544d1cc850a5a1db091acb3：
// recommenders/evaluation/python_evaluation.py 的merge_ranking_true_pred/recall_at_k。
// Copyright (c) 2018-present Microsoft Corporation.
// Copyright (c) 2023-present Recommenders contributors.
// 适配：按领域累计明确反馈，不丢零命中/无标签领域；未知保持null。
// 来源与区别见THIRD_PARTY.md，许可见LICENSES/recommenders-MIT.txt。
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io,
};

use serde::{Deserialize, Serialize};
use vs_core::{
    catalog::PublicCatalog,
    learning::{MAX_MODEL_DOMAINS, MAX_TRAINING_SAMPLES},
    recommendation::{RecommendationResponse, RequestContext},
    replay::Judgment,
    valid_id,
};

#[cfg(test)]
#[path = "domain_audit_tests.rs"]
mod tests;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DomainAuditConfig {
    pub required_domains: Vec<String>,
    pub minimum_positive_labels: usize,
    pub maximum_positive_coverage_drop_basis_points: u16,
}

impl DomainAuditConfig {
    pub fn validate(&self) -> io::Result<()> {
        if !(1..=MAX_MODEL_DOMAINS).contains(&self.required_domains.len())
            || !(1..=MAX_TRAINING_SAMPLES).contains(&self.minimum_positive_labels)
            || self.maximum_positive_coverage_drop_basis_points > 10_000
            || self.required_domains.iter().any(|domain| !valid_id(domain))
            || self.required_domains.iter().collect::<HashSet<_>>().len()
                != self.required_domains.len()
        {
            return Err(io::Error::other("领域审计的范围、证据数量或退化门槛无效"));
        }
        Ok(())
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct ReturnCounts {
    pub returned: usize,
    pub explicit_positive_returned: usize,
    pub explicit_negative_returned: usize,
    pub unjudged_returned: usize,
}

#[derive(Debug, Default)]
struct Counts {
    requests_in_scope: usize,
    multi_domain_requests: usize,
    requests_with_explicit_feedback: usize,
    explicit_positive_labels: usize,
    explicit_negative_labels: usize,
    baseline: ReturnCounts,
    model: ReturnCounts,
}

#[derive(Debug, Serialize)]
pub struct DomainRow {
    pub domain: String,
    pub requests_in_scope: usize,
    pub multi_domain_requests: usize,
    pub requests_with_explicit_feedback: usize,
    pub requests_without_explicit_feedback: usize,
    pub explicit_positive_labels: usize,
    pub explicit_negative_labels: usize,
    pub baseline: ReturnCounts,
    pub model: ReturnCounts,
    pub baseline_observed_positive_coverage: Option<f64>,
    pub model_observed_positive_coverage: Option<f64>,
    pub positive_coverage_delta: Option<f64>,
    pub required: bool,
    pub positive_coverage_gate_passed: Option<bool>,
    pub reason: &'static str,
}

#[derive(Debug, Serialize)]
pub struct DomainAuditReport {
    pub schema: &'static str,
    pub config: DomainAuditConfig,
    pub rows: Vec<DomainRow>,
    pub domains_with_positive_evidence: usize,
    pub domains_without_positive_evidence: Vec<String>,
    pub baseline_micro_observed_positive_coverage: Option<f64>,
    pub model_micro_observed_positive_coverage: Option<f64>,
    pub baseline_macro_observed_positive_coverage: Option<f64>,
    pub model_macro_observed_positive_coverage: Option<f64>,
    pub gate_passed: bool,
    pub quality_scope: &'static str,
    pub online_policy_changed: bool,
    pub production_gate_passed: bool,
}

fn fraction(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}

pub(crate) struct DomainAudit {
    config: DomainAuditConfig,
    candidates: HashMap<String, String>,
    counts: BTreeMap<String, Counts>,
}

impl DomainAudit {
    pub(crate) fn new(catalog: &PublicCatalog, config: &DomainAuditConfig) -> io::Result<Self> {
        config.validate()?;
        let mut counts = BTreeMap::new();
        let mut candidates = HashMap::new();
        for item in &catalog.items {
            counts
                .entry(item.domain.clone())
                .or_insert_with(Counts::default);
            if candidates
                .insert(item.id.clone(), item.domain.clone())
                .is_some()
            {
                return Err(io::Error::other("领域审计的目录包含重复候选"));
            }
        }
        if counts.len() > MAX_MODEL_DOMAINS
            || config
                .required_domains
                .iter()
                .any(|domain| !counts.contains_key(domain))
        {
            return Err(io::Error::other(
                "领域审计超出领域预算或要求目录中不存在的领域",
            ));
        }
        Ok(Self {
            config: config.clone(),
            candidates,
            counts,
        })
    }

    // 完整请求仍用原排序结果，不按领域压缩/补齐Top-K，也不将未返回项当负样本。
    pub(crate) fn observe(
        &mut self,
        context: &RequestContext,
        labels: &[Judgment],
        baseline: &RecommendationResponse,
        model: &RecommendationResponse,
    ) -> io::Result<()> {
        let mut known = HashMap::new();
        let mut labelled_domains = HashSet::new();
        for label in labels {
            let domain = self
                .candidates
                .get(&label.candidate_id)
                .ok_or_else(|| io::Error::other("领域标签不在冻结目录"))?;
            if label.relevance > 1
                || !context.includes_domain(domain)
                || known
                    .insert(label.candidate_id.as_str(), label.relevance)
                    .is_some()
            {
                return Err(io::Error::other("领域标签重复、级别无效或越权"));
            }
            labelled_domains.insert(domain.as_str());
        }
        let multi = self
            .counts
            .keys()
            .filter(|domain| context.includes_domain(domain))
            .count()
            > 1;
        for (domain, counts) in &mut self.counts {
            if context.includes_domain(domain) {
                counts.requests_in_scope += 1;
                counts.multi_domain_requests += usize::from(multi);
                counts.requests_with_explicit_feedback +=
                    usize::from(labelled_domains.contains(domain.as_str()));
            }
        }
        for label in labels {
            let counts = self
                .counts
                .get_mut(&self.candidates[&label.candidate_id])
                .unwrap();
            if label.relevance == 1 {
                counts.explicit_positive_labels += 1;
            } else {
                counts.explicit_negative_labels += 1;
            }
        }
        for (response, is_model) in [(baseline, false), (model, true)] {
            let mut seen = HashSet::new();
            for item in &response.items {
                let domain = self
                    .candidates
                    .get(&item.id)
                    .filter(|domain| *domain == &item.domain && context.includes_domain(domain))
                    .ok_or_else(|| io::Error::other("领域审计的返回候选或领域不匹配"))?;
                if !seen.insert(&item.id) {
                    return Err(io::Error::other("领域审计返回重复候选"));
                }
                let counts = self.counts.get_mut(domain).unwrap();
                let returns = if is_model {
                    &mut counts.model
                } else {
                    &mut counts.baseline
                };
                returns.returned += 1;
                match known.get(item.id.as_str()) {
                    Some(1) => returns.explicit_positive_returned += 1,
                    Some(0) => returns.explicit_negative_returned += 1,
                    _ => returns.unjudged_returned += 1,
                }
            }
        }
        Ok(())
    }

    pub(crate) fn finish(self) -> DomainAuditReport {
        let mut rows = Vec::new();
        let mut domains_without_positive_evidence = Vec::new();
        let (mut positive_total, mut baseline_hits, mut model_hits) = (0, 0, 0);
        let (mut baseline_macro, mut model_macro, mut macro_count) = (0.0, 0.0, 0);
        let mut gate_passed = true;
        for (domain, counts) in self.counts {
            let required = self.config.required_domains.contains(&domain);
            let positive = counts.explicit_positive_labels;
            let baseline = fraction(counts.baseline.explicit_positive_returned, positive);
            let model = fraction(counts.model.explicit_positive_returned, positive);
            positive_total += positive;
            baseline_hits += counts.baseline.explicit_positive_returned;
            model_hits += counts.model.explicit_positive_returned;
            if let (Some(b), Some(m)) = (baseline, model) {
                baseline_macro += b;
                model_macro += m;
                macro_count += 1;
            } else {
                domains_without_positive_evidence.push(domain.clone());
            }
            let sufficient = positive >= self.config.minimum_positive_labels;
            // 整数交叉相乘，门槛边界不受f64舍入影响；上游回放样本数量有界。
            let retained = counts.model.explicit_positive_returned as u128 * 10_000
                + u128::from(self.config.maximum_positive_coverage_drop_basis_points)
                    * positive as u128
                >= counts.baseline.explicit_positive_returned as u128 * 10_000;
            let passed = sufficient && retained;
            if required {
                gate_passed &= passed;
            }
            rows.push(DomainRow {
                domain,
                requests_in_scope: counts.requests_in_scope,
                multi_domain_requests: counts.multi_domain_requests,
                requests_with_explicit_feedback: counts.requests_with_explicit_feedback,
                requests_without_explicit_feedback: counts.requests_in_scope
                    - counts.requests_with_explicit_feedback,
                explicit_positive_labels: positive,
                explicit_negative_labels: counts.explicit_negative_labels,
                baseline: counts.baseline,
                model: counts.model,
                baseline_observed_positive_coverage: baseline,
                model_observed_positive_coverage: model,
                positive_coverage_delta: baseline.zip(model).map(|(b, m)| m - b),
                required,
                positive_coverage_gate_passed: required.then_some(passed),
                reason: if !required {
                    "not_required"
                } else if !sufficient {
                    "insufficient_positive_evidence"
                } else if !retained {
                    "positive_coverage_regressed"
                } else {
                    "within_configured_bound"
                },
            });
        }
        DomainAuditReport {
            schema: "domain-observed-feedback-audit-v1",
            config: self.config,
            rows,
            domains_with_positive_evidence: macro_count,
            domains_without_positive_evidence,
            baseline_micro_observed_positive_coverage: fraction(baseline_hits, positive_total),
            model_micro_observed_positive_coverage: fraction(model_hits, positive_total),
            baseline_macro_observed_positive_coverage: (macro_count > 0)
                .then(|| baseline_macro / macro_count as f64),
            model_macro_observed_positive_coverage: (macro_count > 0)
                .then(|| model_macro / macro_count as f64),
            gate_passed,
            quality_scope: "历史已显示且明确反馈候选的覆盖诊断；选择/曝光偏差未校正，未知不作负样本",
            online_policy_changed: false,
            production_gate_passed: false,
        }
    }
}
