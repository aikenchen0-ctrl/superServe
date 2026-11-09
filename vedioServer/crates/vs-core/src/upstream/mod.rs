pub(crate) mod bounded_heap;
pub(crate) mod buffered_top_k;
pub(crate) mod ftrl;
pub(crate) mod hlsjs_buffer;
pub(crate) mod media3_load_control;
pub(crate) mod mmr;

#[cfg(test)]
mod tests {
    use super::{bounded_heap::BoundedHeap, buffered_top_k::BufferedTopK};
    use std::num::NonZeroUsize;

    #[test]
    fn imported_selectors_match_sort_across_compaction_boundaries_and_full_ties() {
        for k in [1, 2, 31, 32, 33, 128, 600] {
            let mut values: Vec<_> = (0..513).map(|i| (i % 3, (i * 17) % 29, i)).collect();
            for reverse in [false, true] {
                if reverse {
                    values.reverse();
                }
                let limit = NonZeroUsize::new(k).unwrap();
                let mut heap = BoundedHeap::new(limit);
                let mut buffered = BufferedTopK::new(limit);
                for &value in &values {
                    heap.push(value);
                    buffered.push(value);
                }
                let mut expected = values.clone();
                expected.sort_unstable_by(|a, b| b.cmp(a));
                expected.truncate(k);
                let mut heap = heap.into_vec();
                heap.sort_unstable_by(|a, b| b.cmp(a));
                let mut buffered = buffered.into_vec();
                buffered.sort_unstable_by(|a, b| b.cmp(a));
                assert_eq!(heap, expected);
                assert_eq!(buffered, expected);
            }
        }
    }

    #[test]
    fn imported_selectors_handle_empty_input_and_repeated_identical_keys() {
        let limit = NonZeroUsize::new(4).unwrap();
        assert!(BoundedHeap::<i32>::new(limit).into_vec().is_empty());
        assert!(BufferedTopK::<i32>::new(limit).into_vec().is_empty());
        let mut heap = BoundedHeap::new(limit);
        let mut buffered = BufferedTopK::new(limit);
        for _ in 0..100 {
            heap.push(-2);
            buffered.push(-2);
        }
        assert_eq!(heap.into_vec(), vec![-2; 4]);
        assert_eq!(buffered.into_vec(), vec![-2; 4]);
    }
}
