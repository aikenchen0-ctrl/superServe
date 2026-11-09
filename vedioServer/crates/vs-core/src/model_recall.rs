use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use serde::{Deserialize, Serialize};

use crate::{
    DomainError,
    catalog::PublicCatalog,
    learning::LearnedRanker,
    recommendation::{RecommendationRequest, RequestContext, validate_model_catalog},
};

pub const MODEL_RECALL_SCHEMA: &str = "domain-tag-linear-f32-v1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SparseProjection {
    pub indices: Vec<u32>,
    pub values: Vec<f32>,
}

struct DomainDimensions {
    bias: u32,
    prior: u32,
    tags: BTreeMap<String, u32>,
}

/// 公开目录决定向量字典，模型只参与查询；f32投影和重排分组使其仍是近似候选路径。
pub struct ModelRecallProjection {
    catalog: Arc<PublicCatalog>,
    domains: BTreeMap<String, DomainDimensions>,
    dimensions: u32,
}

impl ModelRecallProjection {
    pub fn new(catalog: Arc<PublicCatalog>) -> Result<Self, DomainError> {
        catalog.validate()?;
        let mut tags: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for item in &catalog.items {
            tags.entry(item.domain.clone())
                .or_default()
                .extend(item.tags.iter().cloned());
        }
        let mut next = 1;
        let mut domains = BTreeMap::new();
        for (domain, tags) in tags {
            let bias = next;
            let prior = next + 1;
            next += 2;
            let tags = tags
                .into_iter()
                .map(|tag| {
                    let dimension = next;
                    next += 1;
                    (tag, dimension)
                })
                .collect();
            domains.insert(domain, DomainDimensions { bias, prior, tags });
        }
        Ok(Self {
            catalog,
            domains,
            dimensions: next,
        })
    }

    pub fn catalog(&self) -> &PublicCatalog {
        &self.catalog
    }

    pub fn dimensions(&self) -> u32 {
        self.dimensions
    }

    pub fn point(&self, index: usize) -> Result<SparseProjection, DomainError> {
        let item = self
            .catalog
            .items
            .get(index)
            .ok_or(DomainError::Invalid("模型召回候选越界"))?;
        let dimensions = &self.domains[&item.domain];
        let mut values = vec![(0, 1.0), (dimensions.bias, 1.0)];
        if item.prior != 0.0 {
            values.push((dimensions.prior, item.prior));
        }
        let scale = 1.0 / item.tags.len().max(1) as f32;
        values.extend(item.tags.iter().map(|tag| (dimensions.tags[tag], scale)));
        Ok(sparse(values))
    }

    pub fn query(
        &self,
        request: &RecommendationRequest,
        now: u64,
        model: &LearnedRanker,
    ) -> Result<SparseProjection, DomainError> {
        let context = RequestContext::new(request, now)?;
        validate_model_catalog(&self.catalog, now, Some(model))?;
        // 公共存在维度使冷启动、空标签及全零模型仍有交集；该小常数也纳入精度审计。
        let mut values = vec![(0, 1e-20)];
        for (domain, dimensions) in &self.domains {
            if !context.includes_domain(domain) {
                continue;
            }
            let weights = model.weights_for_domain(domain);
            let bias = weights[0] + weights[5] * f64::from(context.has_nonzero_interest());
            if bias != 0.0 {
                values.push((dimensions.bias, bias as f32));
            }
            if weights[1] != 0.0 {
                values.push((dimensions.prior, weights[1] as f32));
            }
            for (tag, interest) in context.interests() {
                let Some(dimension) = dimensions.tags.get(*tag) else {
                    continue;
                };
                let interest = f64::from(*interest);
                let coefficient = weights[2] * interest.max(0.0)
                    + weights[3] * interest.min(0.0)
                    + weights[4] * f64::from(interest != 0.0);
                if coefficient != 0.0 {
                    values.push((*dimension, coefficient as f32));
                }
            }
        }
        Ok(sparse(values))
    }
}

fn sparse(mut values: Vec<(u32, f32)>) -> SparseProjection {
    values.sort_unstable_by_key(|(index, _)| *index);
    let (indices, values) = values.into_iter().unzip();
    SparseProjection { indices, values }
}
