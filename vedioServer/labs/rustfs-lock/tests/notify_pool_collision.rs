use futures::poll;
use rustfs_lock::fast_lock::optimized_notify::OptimizedNotify;
use std::sync::atomic::Ordering;

async fn observe_writer_notification(other_index: usize, owner_index: usize) -> (bool, bool) {
    let other = OptimizedNotify::new();
    let owner = OptimizedNotify::new();
    other
        .notify_pool_index
        .store(other_index, Ordering::Relaxed);
    owner
        .notify_pool_index
        .store(owner_index, Ordering::Relaxed);

    // 固定合法的池碰撞和排队顺序，避免依赖睡眠、随机索引或机器负载。
    let mut other_wait = Box::pin(other.wait_for_write());
    let mut owner_wait = Box::pin(owner.wait_for_write());
    assert!(poll!(other_wait.as_mut()).is_pending());
    assert!(poll!(owner_wait.as_mut()).is_pending());
    assert_eq!(other.writer_waiters.load(Ordering::Acquire), 1);
    assert_eq!(owner.writer_waiters.load(Ordering::Acquire), 1);

    owner.notify_writer();
    let owner_woke = poll!(owner_wait.as_mut()).is_ready();
    let other_woke = poll!(other_wait.as_mut()).is_ready();
    drop(owner_wait);
    drop(other_wait);
    assert_eq!(owner.writer_waiters.load(Ordering::Acquire), 0);
    assert_eq!(other.writer_waiters.load(Ordering::Acquire), 0);
    (owner_woke, other_woke)
}

#[tokio::test]
async fn writer_notification_reaches_owner_with_distinct_pool_entries() {
    let (owner_woke, other_woke) = observe_writer_notification(1, 2).await;
    assert!(
        owner_woke,
        "owner notification was lost; other_woke={other_woke}"
    );
}

#[tokio::test]
async fn writer_notification_reaches_owner_with_colliding_pool_entries() {
    // 跨对象的无关等待者不应独占本对象唯一的一次唤醒。
    let (owner_woke, other_woke) = observe_writer_notification(0, 0).await;
    assert!(
        owner_woke,
        "owner notification was lost; other_woke={other_woke}"
    );
}
