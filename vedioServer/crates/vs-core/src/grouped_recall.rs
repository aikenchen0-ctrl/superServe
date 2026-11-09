use std::{
    cmp::Ordering,
    collections::{BTreeMap, BinaryHeap},
    num::NonZeroUsize,
    sync::Arc,
};

use crate::{
    DomainError,
    catalog::{Candidate, PublicCatalog},
    recall::PERSONALIZED_RECALL_LIMIT,
    recommendation::{RequestContext, rank_order},
    upstream::{bounded_heap::BoundedHeap, buffered_top_k::BufferedTopK},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupHeadStrategy {
    All,
    Heap,
    Buffered,
}

pub struct GroupedRecall {
    catalog: Arc<PublicCatalog>,
    group_offsets: Box<[usize]>,
    members: Box<[usize]>,
}

#[derive(Default, Debug)]
pub struct GroupedSelection {
    pub indices: Vec<usize>,
    pub groups_examined: usize,
    pub groups_scored: usize,
    pub candidates_examined: usize,
    pub peak_heads: usize,
    pub head_buffer_bytes: usize,
    pub output_buffer_bytes: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GroupedIndexLayout {
    pub storage: &'static str,
    pub groups: usize,
    pub members: usize,
    pub retained_buffers: usize,
    pub object_bytes: usize,
    pub group_slots_bytes: usize,
    pub member_slots_bytes: usize,
    pub retained_payload_bytes: usize,
}

#[derive(Clone, Copy)]
struct Head<'a> {
    candidate: &'a Candidate,
    index: usize,
    group: usize,
    position: usize,
    affinity: f32,
}

impl Ord for Head<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        // 标准库最大堆需要将“最好排在最前”的排序键反转。
        rank_order(
            other.candidate,
            other.affinity,
            self.candidate,
            self.affinity,
        )
    }
}

impl PartialOrd for Head<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Head<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for Head<'_> {}

impl GroupedRecall {
    pub fn new(catalog: Arc<PublicCatalog>) -> Result<Self, DomainError> {
        catalog.validate()?;
        let mut grouped: BTreeMap<_, Vec<usize>> = BTreeMap::new();
        for (index, item) in catalog.items.iter().enumerate() {
            // 保留标签顺序，避免浮点加法重排改变最终排序的近分边界。
            grouped
                .entry((item.domain.clone(), item.tags.clone()))
                .or_default()
                .push(index);
        }
        let mut group_offsets = Vec::with_capacity(grouped.len() + 1);
        let mut members = Vec::with_capacity(catalog.items.len());
        group_offsets.push(0);
        for mut indices in grouped.into_values() {
            indices.sort_unstable_by(|a, b| {
                rank_order(&catalog.items[*a], 0.0, &catalog.items[*b], 0.0)
            });
            members.extend(indices);
            group_offsets.push(members.len());
        }
        // 发布后只读；连续成员与偏移表避免每组分配和增长预留。
        Ok(Self {
            catalog,
            group_offsets: group_offsets.into_boxed_slice(),
            members: members.into_boxed_slice(),
        })
    }

    pub fn group_count(&self) -> usize {
        self.group_offsets.len() - 1
    }

    pub(crate) fn catalog(&self) -> &PublicCatalog {
        &self.catalog
    }

    pub(crate) fn member_groups(&self) -> impl Iterator<Item = &[usize]> {
        self.group_offsets
            .windows(2)
            .map(|offsets| &self.members[offsets[0]..offsets[1]])
    }

    pub fn allocation_layout(&self) -> GroupedIndexLayout {
        let object_bytes = std::mem::size_of::<Self>();
        let group_slots_bytes = std::mem::size_of_val(self.group_offsets.as_ref());
        let member_slots_bytes = std::mem::size_of_val(self.members.as_ref());
        // 仅统计对象与持有的切片；共享目录、分配器元数据和构建临时分配不在此口径。
        GroupedIndexLayout {
            storage: "flat-boxed-usize-v1",
            groups: self.group_count(),
            members: self.members.len(),
            retained_buffers: usize::from(!self.group_offsets.is_empty())
                + usize::from(!self.members.is_empty()),
            object_bytes,
            group_slots_bytes,
            member_slots_bytes,
            retained_payload_bytes: object_bytes + group_slots_bytes + member_slots_bytes,
        }
    }

    pub fn select(&self, context: &RequestContext<'_>) -> GroupedSelection {
        let strategy = if self.group_count() <= PERSONALIZED_RECALL_LIMIT {
            GroupHeadStrategy::All
        } else {
            GroupHeadStrategy::Buffered
        };
        self.select_with_strategy(context, strategy)
    }

    pub fn select_with_strategy(
        &self,
        context: &RequestContext<'_>,
        strategy: GroupHeadStrategy,
    ) -> GroupedSelection {
        let mut selected = GroupedSelection::default();
        let mut heads = Vec::new();
        let limit = NonZeroUsize::new(PERSONALIZED_RECALL_LIMIT).expect("固定候选上限非零");
        let mut bounded = (strategy == GroupHeadStrategy::Heap).then(|| BoundedHeap::new(limit));
        let mut buffered =
            (strategy == GroupHeadStrategy::Buffered).then(|| BufferedTopK::new(limit));
        for (group, offsets) in self.group_offsets.windows(2).enumerate() {
            selected.groups_examined += 1;
            let representative = &self.catalog.items[self.members[offsets[0]]];
            if !context.allows_features(representative) {
                continue;
            }
            if let Some(mut head) = self.next_head(group, 0, 0.0, context, &mut selected) {
                head.affinity = context.affinity(head.candidate);
                selected.groups_scored += 1;
                match strategy {
                    GroupHeadStrategy::All => {
                        heads.push(head);
                        selected.peak_heads = heads.len();
                    }
                    GroupHeadStrategy::Heap => {
                        let bounded = bounded.as_mut().expect("有界堆已初始化");
                        bounded.push(head);
                        selected.peak_heads = selected.peak_heads.max(bounded.len());
                    }
                    GroupHeadStrategy::Buffered => {
                        let buffered = buffered.as_mut().expect("缓冲选择器已初始化");
                        // 插入触发压缩前，最多同时存放2K个元素。
                        let before = buffered.len();
                        if buffered.push(head) {
                            selected.peak_heads = selected.peak_heads.max(before + 1);
                        }
                    }
                }
            }
        }
        let buffer_capacity = match strategy {
            GroupHeadStrategy::All => heads.capacity(),
            GroupHeadStrategy::Heap => {
                let bounded = bounded.expect("有界堆已初始化");
                let capacity = bounded.capacity();
                heads = bounded.into_vec();
                capacity.max(heads.capacity())
            }
            GroupHeadStrategy::Buffered => {
                let buffered = buffered.expect("缓冲选择器已初始化");
                let capacity = buffered.capacity();
                heads = buffered.into_vec();
                capacity
            }
        };
        let mut heap = BinaryHeap::from(heads);
        selected.head_buffer_bytes = buffer_capacity * std::mem::size_of::<Head<'_>>();
        while let Some(head) = heap.pop() {
            selected.indices.push(head.index);
            if selected.indices.len() == PERSONALIZED_RECALL_LIMIT {
                break;
            }
            if let Some(next) = self.next_head(
                head.group,
                head.position + 1,
                head.affinity,
                context,
                &mut selected,
            ) {
                heap.push(next);
            }
        }
        selected.output_buffer_bytes = selected.indices.capacity() * std::mem::size_of::<usize>();
        selected
    }

    fn next_head<'a>(
        &'a self,
        group: usize,
        start: usize,
        affinity: f32,
        context: &RequestContext<'_>,
        selected: &mut GroupedSelection,
    ) -> Option<Head<'a>> {
        let indices = &self.members[self.group_offsets[group]..self.group_offsets[group + 1]];
        for (offset, &index) in indices[start..].iter().enumerate() {
            selected.candidates_examined += 1;
            let candidate = &self.catalog.items[index];
            // 同组领域与有序标签已校验；成员只需逐项检查隐藏ID。
            if context.allows_id(&candidate.id) {
                return Some(Head {
                    candidate,
                    index,
                    group,
                    position: start + offset,
                    affinity,
                });
            }
        }
        None
    }
}
