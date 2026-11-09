// SPDX-License-Identifier: Apache-2.0
// 改编自 qdrant/qdrant，提交 222b2e44ab1c3f17e8246396ead6558e45041df7，
// lib/common/common/src/fixed_length_priority_queue.rs.
// 改动：保留必要操作，移除 serde/bytemuck，使用完整 Ord 键。

use std::{cmp::Reverse, collections::BinaryHeap, num::NonZeroUsize};

pub(crate) struct BoundedHeap<T: Ord> {
    heap: BinaryHeap<Reverse<T>>,
    limit: NonZeroUsize,
}

impl<T: Ord> BoundedHeap<T> {
    pub(crate) fn new(limit: NonZeroUsize) -> Self {
        Self {
            heap: BinaryHeap::with_capacity(limit.get()),
            limit,
        }
    }

    pub(crate) fn push(&mut self, value: T) {
        if self.heap.len() < self.limit.get() {
            self.fill(value);
            return;
        }
        // 沿用上游快速拒绝路径，避免无效 PeekMut 的析构触发堆调整。
        if self.heap.peek().expect("非空有界堆").0 >= value {
            return;
        }
        *self.heap.peek_mut().expect("非空有界堆") = Reverse(value);
    }

    #[inline(never)]
    fn fill(&mut self, value: T) {
        self.heap.push(Reverse(value));
    }

    pub(crate) fn len(&self) -> usize {
        self.heap.len()
    }

    pub(crate) fn capacity(&self) -> usize {
        self.heap.capacity()
    }

    pub(crate) fn into_vec(self) -> Vec<T> {
        // 使用安全转换替代上游 bytemuck；无需新增依赖或引入不安全代码。
        self.heap
            .into_vec()
            .into_iter()
            .map(|Reverse(value)| value)
            .collect()
    }
}
