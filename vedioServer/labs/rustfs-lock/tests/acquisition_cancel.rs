use async_trait::async_trait;
use futures::poll;
use rustfs_lock::{
    LockError, LockId, LockInfo, LockRequest, LockResponse, LockStats, LockStatus, LockType,
    ObjectKey, Result,
    client::{LockClient, local::LocalClient},
    distributed_lock::DistributedLockGuard,
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};
use tokio::{
    sync::{Notify, oneshot, watch},
    task::JoinHandle,
    time::{sleep, timeout},
};
use vs_rustfs_lock_lab::DistributedLock;

const WAIT: Duration = Duration::from_secs(2);
const TTL: Duration = Duration::from_secs(3600);

#[derive(Clone, Copy, Debug)]
enum Gate {
    Open,
    BeforeGrant,
    BeforeReply,
    Reject,
}

#[derive(Debug)]
struct Remote {
    gate: Gate,
    entered: Notify,
    returned: Notify,
    proceed: watch::Sender<bool>,
    held: Mutex<HashMap<LockId, LockInfo>>,
    servers: Mutex<Vec<JoinHandle<()>>>,
    releases: AtomicUsize,
    release_failures: AtomicUsize,
}

impl Remote {
    fn new(gate: Gate) -> Arc<Self> {
        Arc::new(Self {
            gate,
            entered: Notify::new(),
            returned: Notify::new(),
            proceed: watch::channel(false).0,
            held: Mutex::new(HashMap::new()),
            servers: Mutex::new(Vec::new()),
            releases: AtomicUsize::new(0),
            release_failures: AtomicUsize::new(0),
        })
    }

    fn count(&self) -> usize {
        self.held.lock().unwrap().len()
    }

    async fn finish(&self) {
        self.proceed.send_replace(true);
        let servers = std::mem::take(&mut *self.servers.lock().unwrap());
        for server in servers {
            timeout(WAIT, server).await.unwrap().unwrap();
        }
    }
}

#[derive(Debug)]
struct Client(Arc<Remote>);

#[async_trait]
impl LockClient for Client {
    async fn acquire_lock(&self, request: &LockRequest) -> Result<LockResponse> {
        let remote = self.0.clone();
        let request = request.clone();
        let (tx, rx) = oneshot::channel();
        // 模拟已发出的远端请求；本地等待被取消不会撤销远端的授权动作。
        let server = tokio::spawn(async move {
            remote.entered.notify_one();
            if matches!(remote.gate, Gate::Reject) {
                let _ = tx.send(LockResponse::failure(
                    "unrecoverable quorum failure: injected",
                    Duration::ZERO,
                ));
                return;
            }
            if matches!(remote.gate, Gate::BeforeGrant) {
                remote
                    .proceed
                    .subscribe()
                    .wait_for(|open| *open)
                    .await
                    .unwrap();
            }
            let now = SystemTime::now();
            let info = LockInfo {
                // 返回不同于请求的锁号，验证回收使用实际授予的锁号。
                id: LockId::new_unique(&request.resource),
                resource: request.resource,
                lock_type: request.lock_type,
                status: LockStatus::Acquired,
                owner: request.owner,
                acquired_at: now,
                expires_at: now + request.ttl,
                last_refreshed: now,
                metadata: request.metadata,
                priority: request.priority,
                wait_start_time: None,
            };
            remote
                .held
                .lock()
                .unwrap()
                .insert(info.id.clone(), info.clone());
            if matches!(remote.gate, Gate::BeforeReply) {
                remote
                    .proceed
                    .subscribe()
                    .wait_for(|open| *open)
                    .await
                    .unwrap();
            }
            let _ = tx.send(LockResponse::success(info, Duration::ZERO));
        });
        self.0.servers.lock().unwrap().push(server);
        let response = rx
            .await
            .map_err(|_| LockError::internal("test server closed"))?;
        self.0.returned.notify_one();
        Ok(response)
    }

    async fn release(&self, id: &LockId) -> Result<bool> {
        self.0.releases.fetch_add(1, Ordering::SeqCst);
        if self
            .0
            .release_failures
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err(LockError::internal("injected release failure"));
        }
        Ok(self.0.held.lock().unwrap().remove(id).is_some())
    }

    async fn refresh(&self, id: &LockId) -> Result<bool> {
        Ok(self.0.held.lock().unwrap().contains_key(id))
    }

    async fn force_release(&self, id: &LockId) -> Result<bool> {
        self.release(id).await
    }

    async fn check_status(&self, id: &LockId) -> Result<Option<LockInfo>> {
        Ok(self.0.held.lock().unwrap().get(id).cloned())
    }

    async fn get_stats(&self) -> Result<LockStats> {
        Ok(LockStats::default())
    }

    async fn close(&self) -> Result<()> {
        Ok(())
    }

    async fn is_online(&self) -> bool {
        true
    }

    async fn is_local(&self) -> bool {
        false
    }
}

fn cluster(gates: [Gate; 3]) -> (DistributedLock, Vec<Arc<Remote>>) {
    let remotes: Vec<_> = gates.into_iter().map(Remote::new).collect();
    let clients = remotes
        .iter()
        .map(|r| Arc::new(Client(r.clone())) as Arc<dyn LockClient>)
        .collect();
    (
        DistributedLock::new("cancel-lab".into(), clients, 3),
        remotes,
    )
}

async fn acquire(
    lock: &DistributedLock,
    kind: LockType,
    budget: Duration,
) -> Result<Option<DistributedLockGuard>> {
    let key = ObjectKey::new("cancel-lab", "synthetic-object");
    match kind {
        LockType::Shared => lock.rlock_guard(key, "lab", budget, TTL).await,
        LockType::Exclusive => lock.lock_guard(key, "lab", budget, TTL).await,
    }
}

async fn entered(remotes: &[Arc<Remote>]) {
    for remote in remotes {
        timeout(WAIT, remote.entered.notified()).await.unwrap();
    }
}

async fn finish(remotes: &[Arc<Remote>]) {
    for remote in remotes {
        remote.finish().await;
    }
}

async fn expect_counts(remotes: &[Arc<Remote>], expected: &[usize]) {
    let result = timeout(WAIT, async {
        loop {
            if remotes
                .iter()
                .map(|r| r.count())
                .eq(expected.iter().copied())
            {
                break;
            }
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await;
    assert!(
        result.is_ok(),
        "remote leases: actual={:?}, expected={expected:?}",
        remotes.iter().map(|r| r.count()).collect::<Vec<_>>()
    );
}

async fn cancel_mixed(kind: LockType, release_failures: usize) {
    let (lock, remotes) = cluster([Gate::Open, Gate::BeforeReply, Gate::BeforeGrant]);
    remotes[0]
        .release_failures
        .store(release_failures, Ordering::SeqCst);
    let mut acquisition = Box::pin(acquire(&lock, kind, Duration::from_secs(10)));
    assert!(poll!(acquisition.as_mut()).is_pending());
    entered(&remotes).await;
    timeout(WAIT, remotes[0].returned.notified()).await.unwrap();
    // 消费第一个成功结果；另外两个请求分别停在授予后与授予前。
    assert!(poll!(acquisition.as_mut()).is_pending());
    assert_eq!(
        remotes.iter().map(|r| r.count()).collect::<Vec<_>>(),
        [1, 1, 0]
    );
    drop(acquisition);
    finish(&remotes).await;
    expect_counts(&remotes, &[0, 0, 0]).await;
    assert_eq!(
        remotes[0].releases.load(Ordering::SeqCst),
        1 + release_failures
    );
}

#[tokio::test(start_paused = true)]
async fn shared_cancel_releases_collected_and_late_grants() {
    cancel_mixed(LockType::Shared, 0).await;
}

#[tokio::test(start_paused = true)]
async fn exclusive_cancel_releases_collected_and_late_grants() {
    cancel_mixed(LockType::Exclusive, 0).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_cleanup_retries_transient_release_failures() {
    cancel_mixed(LockType::Shared, 2).await;
}

async fn cancel_before_reply(gate: Gate) {
    let (lock, remotes) = cluster([gate; 3]);
    let mut acquisition = Box::pin(acquire(&lock, LockType::Shared, Duration::from_secs(10)));
    assert!(poll!(acquisition.as_mut()).is_pending());
    entered(&remotes).await;
    drop(acquisition);
    finish(&remotes).await;
    expect_counts(&remotes, &[0, 0, 0]).await;
}

#[tokio::test(start_paused = true)]
async fn cancel_before_any_grant_reclaims_late_successes() {
    cancel_before_reply(Gate::BeforeGrant).await;
}

#[tokio::test(start_paused = true)]
async fn cancel_with_unobserved_grants_reclaims_them() {
    cancel_before_reply(Gate::BeforeReply).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_collects_completed_but_unconsumed_results() {
    let (lock, remotes) = cluster([Gate::Open; 3]);
    let mut acquisition = Box::pin(acquire(&lock, LockType::Shared, Duration::from_secs(10)));
    assert!(poll!(acquisition.as_mut()).is_pending());
    entered(&remotes).await;
    for remote in &remotes {
        timeout(WAIT, remote.returned.notified()).await.unwrap();
    }
    // 不再轮询仲裁 Future；此时成功结果仍属于 JoinSet。
    drop(acquisition);
    finish(&remotes).await;
    expect_counts(&remotes, &[0, 0, 0]).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_releases_real_local_client_lease() {
    let local = Arc::new(LocalClient::new());
    let remotes = vec![
        Remote::new(Gate::BeforeReply),
        Remote::new(Gate::BeforeGrant),
    ];
    let clients: Vec<Arc<dyn LockClient>> = vec![
        local.clone(),
        Arc::new(Client(remotes[0].clone())),
        Arc::new(Client(remotes[1].clone())),
    ];
    let lock = DistributedLock::new("real-local-cancel".into(), clients, 3);
    let mut acquisition = Box::pin(acquire(&lock, LockType::Shared, Duration::from_secs(10)));
    assert!(poll!(acquisition.as_mut()).is_pending());
    entered(&remotes).await;
    timeout(WAIT, async {
        while local.list_lock_leases().await.is_empty() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert!(poll!(acquisition.as_mut()).is_pending());
    drop(acquisition);
    finish(&remotes).await;
    let released = timeout(WAIT, async {
        while !local.list_lock_leases().await.is_empty() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .is_ok();
    assert!(
        released,
        "the real LocalClient lease survived caller cancellation"
    );
    expect_counts(&remotes, &[0, 0]).await;
}

#[tokio::test(start_paused = true)]
async fn shared_success_keeps_quorum_and_releases_spare_then_guard() {
    let (lock, remotes) = cluster([Gate::Open, Gate::Open, Gate::BeforeReply]);
    let mut acquisition = Box::pin(acquire(&lock, LockType::Shared, Duration::from_secs(10)));
    assert!(poll!(acquisition.as_mut()).is_pending());
    entered(&remotes).await;
    let guard = acquisition.await.unwrap().unwrap();
    finish(&remotes).await;
    expect_counts(&remotes, &[1, 1, 0]).await;
    drop(guard);
    expect_counts(&remotes, &[0, 0, 0]).await;
    assert!(
        remotes
            .iter()
            .all(|r| r.releases.load(Ordering::SeqCst) == 1)
    );
}

#[tokio::test(start_paused = true)]
async fn exclusive_success_keeps_all_grants_until_guard_drop() {
    let (lock, remotes) = cluster([Gate::Open; 3]);
    let guard = acquire(&lock, LockType::Exclusive, Duration::from_secs(10))
        .await
        .unwrap()
        .unwrap();
    finish(&remotes).await;
    expect_counts(&remotes, &[1, 1, 1]).await;
    drop(guard);
    expect_counts(&remotes, &[0, 0, 0]).await;
    assert!(
        remotes
            .iter()
            .all(|r| r.releases.load(Ordering::SeqCst) == 1)
    );
}

#[tokio::test(start_paused = true)]
async fn explicit_quorum_failure_rolls_back_successes() {
    let (lock, remotes) = cluster([Gate::Open, Gate::Open, Gate::Reject]);
    let result = acquire(&lock, LockType::Exclusive, Duration::from_secs(10)).await;
    assert!(!matches!(result, Ok(Some(_))));
    finish(&remotes).await;
    expect_counts(&remotes, &[0, 0, 0]).await;
}

// 上游总预算使用 std::time::Instant；该对照使用真实时钟，避免与虚拟时间混用。
#[tokio::test]
async fn explicit_timeout_collects_pending_late_grants() {
    let (lock, remotes) = cluster([Gate::BeforeReply; 3]);
    let mut acquisition = Box::pin(acquire(&lock, LockType::Shared, Duration::from_millis(200)));
    assert!(poll!(acquisition.as_mut()).is_pending());
    entered(&remotes).await;
    let result = acquisition.await;
    assert!(!matches!(result, Ok(Some(_))));
    finish(&remotes).await;
    expect_counts(&remotes, &[0, 0, 0]).await;
}

#[test]
fn cancellation_outside_entered_runtime_still_cleans_up() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (lock, remotes) = cluster([Gate::BeforeReply; 3]);
    let mut acquisition = Box::pin(acquire(&lock, LockType::Shared, Duration::from_secs(10)));
    runtime.block_on(async {
        assert!(poll!(acquisition.as_mut()).is_pending());
        entered(&remotes).await;
    });
    drop(acquisition);
    runtime.block_on(async {
        finish(&remotes).await;
        expect_counts(&remotes, &[0, 0, 0]).await;
    });
}
