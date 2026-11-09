// SPDX-License-Identifier: Apache-2.0
// 改编自 qdrant/qdrant，提交 222b2e44ab1c3f17e8246396ead6558e45041df7，
// lib/common/common/src/top_k.rs (median/2K path).
// 改动：使用完整 Ord 门槛和泛型值，省略小 K 排序分支。

use std::num::NonZeroUsize;

pub(crate) struct BufferedTopK<T: Ord + Clone> {
    k: NonZeroUsize,
    elements: Vec<T>,
    threshold: Option<T>,
}

impl<T: Ord + Clone> BufferedTopK<T> {
    pub(crate) fn new(k: NonZeroUsize) -> Self {
        Self {
            k,
            elements: Vec::with_capacity(k.get().saturating_mul(2)),
            threshold: None,
        }
    }

    pub(crate) fn push(&mut self, value: T) -> bool {
        if self.threshold.as_ref().is_none_or(|worst| value > *worst) {
            self.cold_insert(value);
            true
        } else {
            false
        }
    }

    #[inline(never)]
    fn cold_insert(&mut self, value: T) {
        self.elements.push(value);
        if self.elements.len() == self.k.get().saturating_mul(2) {
            let (_, kth, _) = self
                .elements
                .select_nth_unstable_by(self.k.get() - 1, |a, b| b.cmp(a));
            // 必须保留完整排序键；仅比较亲和度会丢失先验和ID同分边界。
            self.threshold = Some(kth.clone());
            self.elements.truncate(self.k.get());
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.elements.len()
    }

    pub(crate) fn capacity(&self) -> usize {
        self.elements.capacity()
    }

    pub(crate) fn threshold(&self) -> Option<&T> {
        // 仅在已保留至少K项后提供下界；未压缩前不提前剪枝。
        self.threshold.as_ref()
    }

    pub(crate) fn into_vec(mut self) -> Vec<T> {
        if self.elements.len() > self.k.get() {
            self.elements
                .select_nth_unstable_by(self.k.get() - 1, |a, b| b.cmp(a));
            self.elements.truncate(self.k.get());
        }
        self.elements
    }
}
