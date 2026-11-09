use std::collections::{BTreeMap, HashMap, HashSet};

use crate::{catalog::PublicCatalog, recommendation::RequestContext};

pub const PERSONALIZED_RECALL_LIMIT: usize = 128;
pub const PRIOR_RECALL_LIMIT: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RecallScoring {
    #[default]
    Positive,
    Signed,
}

impl RecallScoring {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "positive" => Ok(Self::Positive),
            "signed" => Ok(Self::Signed),
            _ => Err("invalid_recall_scoring"),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Positive => "positive",
            Self::Signed => "signed",
        }
    }

    pub fn includes(self, weight: f32) -> bool {
        match self {
            Self::Positive => weight > 0.0,
            Self::Signed => weight != 0.0,
        }
    }
}

pub struct CatalogRecall {
    tags: BTreeMap<String, u32>,
    domains: BTreeMap<String, Vec<usize>>,
    ids: HashMap<String, usize>,
}

#[derive(Default)]
pub struct PriorSelection {
    pub indices: Vec<usize>,
    pub examined: usize,
    pub neutral_first: bool,
}

impl CatalogRecall {
    pub fn new(catalog: &PublicCatalog) -> Self {
        let mut tags = BTreeMap::new();
        let mut domains: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        let mut ids = HashMap::new();
        for (index, item) in catalog.items.iter().enumerate() {
            for tag in &item.tags {
                tags.insert(tag.clone(), 0);
            }
            domains.entry(item.domain.clone()).or_default().push(index);
            ids.insert(item.id.clone(), index);
        }
        // 字典按完整标签排序，不使用可能碰撞的哈希维度。
        for (index, value) in tags.values_mut().enumerate() {
            *value = index as u32;
        }
        for indices in domains.values_mut() {
            indices.sort_unstable_by(|a, b| {
                catalog.items[*b]
                    .prior
                    .total_cmp(&catalog.items[*a].prior)
                    .then_with(|| catalog.items[*a].id.cmp(&catalog.items[*b].id))
            });
        }
        Self { tags, domains, ids }
    }

    pub fn vector(&self, tags: &[String]) -> (Vec<u32>, Vec<f32>) {
        let mut indices: Vec<_> = tags
            .iter()
            .filter_map(|tag| self.tags.get(tag).copied())
            .collect();
        indices.sort_unstable();
        let weight = 1.0 / tags.len().max(1) as f32;
        let values = vec![weight; indices.len()];
        (indices, values)
    }

    pub fn query(&self, context: &RequestContext<'_>) -> (Vec<u32>, Vec<f32>) {
        self.query_with_scoring(context, RecallScoring::Positive)
    }

    pub fn query_with_scoring(
        &self,
        context: &RequestContext<'_>,
        scoring: RecallScoring,
    ) -> (Vec<u32>, Vec<f32>) {
        let mut weighted: Vec<_> = context
            .interests()
            .iter()
            .filter_map(|(tag, weight)| {
                self.tags
                    .get(*tag)
                    .copied()
                    .filter(|_| scoring.includes(*weight))
                    .map(|index| (index, *weight))
            })
            .collect();
        weighted.sort_unstable_by_key(|(index, _)| *index);
        weighted.into_iter().unzip()
    }

    pub fn prior(&self, catalog: &PublicCatalog, context: &RequestContext<'_>) -> Vec<usize> {
        self.prior_with_scoring(catalog, context, RecallScoring::Positive)
            .indices
    }

    pub fn prior_with_scoring(
        &self,
        catalog: &PublicCatalog,
        context: &RequestContext<'_>,
        scoring: RecallScoring,
    ) -> PriorSelection {
        let neutral_first =
            scoring == RecallScoring::Signed && context.only_nonpositive_interests();
        let mut selection = PriorSelection {
            neutral_first,
            ..Default::default()
        };
        if neutral_first {
            // 先跨场景收齐零分候选，再补负分；软负反馈不变成永久排除条件。
            self.append_prior(catalog, context, Some(true), &mut selection);
            if selection.indices.len() < PRIOR_RECALL_LIMIT {
                self.append_prior(catalog, context, Some(false), &mut selection);
            }
        } else {
            self.append_prior(catalog, context, None, &mut selection);
        }
        selection
    }

    fn append_prior(
        &self,
        catalog: &PublicCatalog,
        context: &RequestContext<'_>,
        neutral: Option<bool>,
        selection: &mut PriorSelection,
    ) {
        let mut routes: Vec<_> = self
            .domains
            .iter()
            .filter(|(domain, _)| context.includes_domain(domain))
            .map(|(_, indices)| indices.iter().copied())
            .collect();
        // 轮流读取每个场景，避免全局热门先验占满预算。
        while selection.indices.len() < PRIOR_RECALL_LIMIT {
            let before = selection.indices.len();
            for route in &mut routes {
                for index in route.by_ref() {
                    selection.examined += 1;
                    let item = &catalog.items[index];
                    if context.allows(item)
                        && neutral.is_none_or(|expected| {
                            context.affinity(item).total_cmp(&0.0).is_eq() == expected
                        })
                    {
                        selection.indices.push(index);
                        break;
                    }
                }
                if selection.indices.len() == PRIOR_RECALL_LIMIT {
                    break;
                }
            }
            if selection.indices.len() == before {
                break;
            }
        }
    }

    pub fn merge(
        &self,
        catalog: &PublicCatalog,
        context: &RequestContext<'_>,
        prior: Vec<usize>,
        ids: &[String],
    ) -> Vec<usize> {
        let mut selected = prior;
        let mut seen: HashSet<_> = selected.iter().copied().collect();
        for id in ids.iter().take(PERSONALIZED_RECALL_LIMIT) {
            if let Some(index) = self.ids.get(id).copied()
                && context.allows(&catalog.items[index])
                && seen.insert(index)
            {
                selected.push(index);
            }
        }
        selected
    }
}
