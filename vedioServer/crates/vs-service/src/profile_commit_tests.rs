use super::*;
use vs_core::profile::ProfileEventKind;

const TOKEN: &str = "profile-commit-test-token-00000000000000";
const CATALOG: &[u8] = br#"{"version":"commit-v1","items":[{"id":"video","domain":"video","tags":["rust"],"prior":0.5,"media_sha256":null}],"assets":[]}"#;

fn event() -> ProfileEvent {
    ProfileEvent {
        event_id: "cancelled-http-event".into(),
        subject: "user-a".into(),
        candidate_id: "video".into(),
        kind: ProfileEventKind::Like,
    }
}

#[tokio::test]
async fn cancelled_http_waiter_still_commits_log_and_projection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let state =
        Arc::new(AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap());
    let blocked = state.profile_commit_gate.lock().await;
    let handler = tokio::spawn(profile_events(
        State(state.clone()),
        HeaderMap::new(),
        Json(event()),
    ));
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.profile_write_slots.available_permits() == PROFILE_WRITE_CONCURRENCY {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    drop(blocked);
    tokio::time::timeout(Duration::from_secs(2), state.drain_profile_writes())
        .await
        .unwrap();
    let current = state
        .profiles
        .read()
        .await
        .get("user-a")
        .unwrap()
        .projection("user-a", vec!["video".into()], 100);
    assert_eq!(current.version, "memory-1");
    assert_eq!(current.interests[0].weight, 1.0);
    assert_eq!(state.counters.profile_events.load(Ordering::Relaxed), 1);
    drop(state);
    let restored = AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap();
    let replayed = restored
        .profiles
        .read()
        .await
        .get("user-a")
        .unwrap()
        .projection("user-a", vec!["video".into()], 100);
    assert_eq!(replayed.version, current.version);
    assert_eq!(replayed.interests[0].weight, current.interests[0].weight);
}

#[tokio::test]
async fn full_commit_budget_rejects_without_creating_profile() {
    let state = Arc::new(AppState::new(CATALOG, None, TOKEN, 1, 1).unwrap());
    let permit = state
        .profile_write_slots
        .acquire_many(PROFILE_WRITE_CONCURRENCY as u32)
        .await
        .unwrap();
    let response = profile_events(State(state.clone()), HeaderMap::new(), Json(event())).await;
    assert!(matches!(
        response,
        Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy"))
    ));
    assert!(state.profiles.read().await.is_empty());
    assert_eq!(state.counters.profile_events.load(Ordering::Relaxed), 0);
    drop(permit);
}

#[tokio::test]
async fn conflicting_event_id_returns_conflict_without_mutating_memory_profile() {
    let state = Arc::new(AppState::new(CATALOG, None, TOKEN, 1, 1).unwrap());
    let accepted = profile_events(State(state.clone()), HeaderMap::new(), Json(event()))
        .await
        .unwrap();
    assert!(accepted.0.accepted);

    let mut changed = event();
    changed.kind = ProfileEventKind::Hide;
    assert!(matches!(
        profile_events(State(state.clone()), HeaderMap::new(), Json(changed)).await,
        Err(ApiError(StatusCode::CONFLICT, "profile_event_id_conflict"))
    ));

    let profiles = state.profiles.read().await;
    let projection =
        profiles
            .get("user-a")
            .unwrap()
            .projection("user-a", vec!["video".into()], 100);
    assert_eq!(projection.version, "memory-1");
    assert!(projection.blocked_ids.is_empty());
}

#[tokio::test]
async fn invalid_events_do_not_allocate_empty_profiles() {
    let state = Arc::new(AppState::new(CATALOG, None, TOKEN, 1, 1).unwrap());
    let mut invalid = event();
    invalid.event_id = "../invalid".into();
    let response = profile_events(State(state.clone()), HeaderMap::new(), Json(invalid)).await;
    assert!(matches!(
        response,
        Err(ApiError(StatusCode::BAD_REQUEST, "invalid_profile_event"))
    ));
    assert!(state.profiles.read().await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_log_append_keeps_committed_feed_and_projection_readable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let state = Arc::new(
        AppState::new_with_profile_log(CATALOG, None, TOKEN, 2, 1, Some(&path))
            .unwrap()
            .into_profile_authority()
            .unwrap(),
    );
    assert!(
        profile_events(State(state.clone()), HeaderMap::new(), Json(event()))
            .await
            .unwrap()
            .0
            .accepted
    );

    let log = state.profile_log.as_ref().unwrap().clone();
    let blocked_log = log.clone();
    let (entered, wait_entered) = tokio::sync::oneshot::channel();
    let (release, wait_release) = tokio::sync::oneshot::channel::<()>();
    // 只阻塞真实文件写锁，继续走实际追加、同步和发布路径。
    let blocker = tokio::task::spawn_blocking(move || {
        blocked_log.with_writer_locked_for_test(|| {
            let _ = entered.send(());
            let _ = wait_release.blocking_recv();
        });
    });
    wait_entered.await.unwrap();

    let mut hide = event();
    hide.event_id = "slow-hide".into();
    hide.kind = ProfileEventKind::Hide;
    let commit = tokio::spawn(profile_events(
        State(state.clone()),
        HeaderMap::new(),
        Json(hide),
    ));
    tokio::time::timeout(Duration::from_secs(2), async {
        while !log.append_waiting_for_writer_for_test() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!commit.is_finished());
    assert_eq!(state.profile_count(), 1);

    let projection = tokio::time::timeout(
        Duration::from_secs(1),
        profile_projection(
            State(state.clone()),
            Json(ProjectionRequest {
                subject: "user-a".into(),
                domains: vec!["video".into()],
            }),
        ),
    )
    .await
    .expect("落盘等待不应阻塞已提交投影")
    .unwrap();
    let projection = projection.0.profile.unwrap();
    assert_eq!(projection.version, "memory-1");
    assert!(projection.blocked_ids.is_empty());

    for subject in ["user-a", "user-b"] {
        let feed = tokio::time::timeout(
            Duration::from_secs(1),
            feed_for_subject(
                state.clone(),
                FeedRequest {
                    request_id: format!("during-append-{subject}"),
                    subject: subject.into(),
                    domains: vec!["video".into()],
                    limit: 1,
                },
            ),
        )
        .await
        .expect("其他主体和当前主体的Feed不应等待落盘")
        .unwrap();
        let bytes = axum::body::to_bytes(feed.into_body(), 65_536)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["items"][0]["id"], "video");
        if subject == "user-a" {
            assert_eq!(body["profile_version"], "memory-1");
        }
    }

    release.send(()).unwrap();
    blocker.await.unwrap();
    let confirmed = commit.await.unwrap().unwrap().0;
    assert!(confirmed.accepted);
    assert_eq!(confirmed.profile_version, "memory-2");
    let feed = feed_for_subject(
        state.clone(),
        FeedRequest {
            request_id: "after-hide".into(),
            subject: "user-a".into(),
            domains: vec!["video".into()],
            limit: 1,
        },
    )
    .await
    .unwrap();
    let bytes = axum::body::to_bytes(feed.into_body(), 65_536)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["profile_version"], "memory-2");
    assert_eq!(body["items"], serde_json::json!([]));
    assert_eq!(state.profile_history_checkpoint().unwrap().records, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_append_waits_for_projection_before_history_or_readiness_and_survives_cancel() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let state =
        Arc::new(AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap());
    let held_projection = state.profiles.read().await;
    let handler = tokio::spawn(profile_events(
        State(state.clone()),
        HeaderMap::new(),
        Json(event()),
    ));
    let log = state.profile_log.as_ref().unwrap().clone();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let log = log.clone();
            if tokio::task::spawn_blocking(move || log.checkpoint().unwrap().records)
                .await
                .unwrap()
                == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(held_projection.is_empty());
    assert!(!handler.is_finished());
    assert!(state.profile_history_checkpoint().is_err());

    let mut history = tokio::spawn(profile_history(
        State(state.clone()),
        Json(HistoryRequest { minimum: None }),
    ));
    let mut readiness = tokio::spawn(ready(State(state.clone())));
    let (history_pending, readiness_pending) = tokio::join!(
        tokio::time::timeout(Duration::from_millis(30), &mut history),
        tokio::time::timeout(Duration::from_millis(30), &mut readiness)
    );
    assert!(history_pending.is_err());
    assert!(readiness_pending.is_err());

    handler.abort();
    assert!(handler.await.unwrap_err().is_cancelled());
    drop(held_projection);
    let history = tokio::time::timeout(Duration::from_secs(2), history)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .0;
    assert_eq!(history.checkpoint.records, 1);
    let readiness = readiness.await.unwrap().unwrap().0;
    assert_eq!(readiness["profile_history"]["records"], 1);
    state.drain_profile_writes().await;
    let published = state.profiles.read().await["user-a"].version();
    assert_eq!(published, "memory-1");
    assert_eq!(state.counters.profile_events.load(Ordering::Relaxed), 1);
    drop(log);
    drop(state);

    let restored = AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap();
    assert_eq!(
        restored.profiles.read().await["user-a"].version(),
        published
    );
    assert_eq!(restored.profile_history_checkpoint().unwrap().records, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_subject_events_preserve_versions_idempotency_and_replay() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let state =
        Arc::new(AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap());
    let events: Vec<_> = (0..12)
        .map(|index| ProfileEvent {
            event_id: format!("event-{}", index / 3),
            subject: format!("user-{}", index % 3),
            kind: ProfileEventKind::Impression,
            ..event()
        })
        .collect();
    let results = futures_util::future::join_all(events.iter().cloned().map(|event| {
        let state = state.clone();
        async move { profile_events(State(state), HeaderMap::new(), Json(event)).await }
    }))
    .await;
    assert!(
        results
            .iter()
            .all(|result| result.as_ref().unwrap().0.accepted)
    );
    for subject in 0..3 {
        let mut versions: Vec<_> = results
            .iter()
            .enumerate()
            .filter(|(index, _)| index % 3 == subject)
            .map(|(_, result)| result.as_ref().unwrap().0.profile_version.as_str())
            .collect();
        versions.sort_unstable();
        assert_eq!(versions, ["memory-1", "memory-2", "memory-3", "memory-4"]);
    }

    let mut conflicts = events.clone();
    for event in &mut conflicts {
        event.kind = ProfileEventKind::Hide;
    }
    for (batch, should_conflict) in [(events, false), (conflicts, true)] {
        let results = futures_util::future::join_all(batch.into_iter().map(|event| {
            let state = state.clone();
            async move { profile_events(State(state), HeaderMap::new(), Json(event)).await }
        }))
        .await;
        for result in results {
            if should_conflict {
                assert!(matches!(
                    result,
                    Err(ApiError(StatusCode::CONFLICT, "profile_event_id_conflict"))
                ));
            } else {
                let result = result.unwrap().0;
                assert!(result.duplicate);
                assert!(!result.accepted);
                assert_eq!(result.profile_version, "memory-4");
            }
        }
    }
    assert_eq!(state.profile_history_checkpoint().unwrap().records, 12);
    assert_eq!(state.counters.profile_events.load(Ordering::Relaxed), 12);
    assert_eq!(
        state
            .counters
            .duplicate_profile_events
            .load(Ordering::Relaxed),
        12
    );
    drop(state);
    let restored = AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&path)).unwrap();
    let profiles = restored.profiles.read().await;
    assert_eq!(profiles.len(), 3);
    for subject in ["user-0", "user-1", "user-2"] {
        let projection = profiles[subject].projection(subject, vec!["video".into()], 100);
        assert_eq!(projection.version, "memory-4");
        assert!(projection.blocked_ids.is_empty());
        assert!((projection.interests[0].weight - 0.04).abs() < f32::EPSILON);
    }
}
