use std::{future::Future, io, time::Duration};

use tokio::time::{Instant, timeout_at};

pub(crate) const DRAIN_BUDGET: Duration = Duration::from_secs(30);

async fn drain_phase(
    deadline: Instant,
    phase: &'static str,
    work: impl Future<Output = io::Result<()>>,
    failures: &mut Vec<&'static str>,
    expired: &mut bool,
) {
    // 已耗尽期限时不再开始后续工作，避免每阶段重置等待预算。
    if Instant::now() >= deadline {
        *expired = true;
        failures.push(phase);
        return;
    }
    match timeout_at(deadline, work).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => failures.push(phase),
        Err(_) => {
            *expired = true;
            failures.push(phase);
        }
    }
}

/// 只约束可让出执行权的排空等待，不承诺中断文件系统或运行时阻塞线程。
pub(crate) async fn finish(
    deadline: Instant,
    http: impl Future<Output = io::Result<()>>,
    profile: impl Future<Output = ()>,
    learning: impl Future<Output = ()>,
    feedback: impl Future<Output = ()>,
) -> io::Result<()> {
    let mut failures = Vec::new();
    let mut expired = false;
    drain_phase(deadline, "HTTP连接", http, &mut failures, &mut expired).await;
    // HTTP返回错误也须尝试排空已受理的提交，不能使用?提前跳过。
    drain_phase(
        deadline,
        "画像提交",
        async {
            profile.await;
            Ok(())
        },
        &mut failures,
        &mut expired,
    )
    .await;
    drain_phase(
        deadline,
        "学习提交",
        async {
            learning.await;
            Ok(())
        },
        &mut failures,
        &mut expired,
    )
    .await;
    drain_phase(
        deadline,
        "反馈提交",
        async {
            feedback.await;
            Ok(())
        },
        &mut failures,
        &mut expired,
    )
    .await;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(io::Error::new(
            if expired {
                io::ErrorKind::TimedOut
            } else {
                io::ErrorKind::Other
            },
            format!("服务排空未完成：{}", failures.join("、")),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    #[tokio::test]
    async fn success_requires_all_four_phases_in_order() {
        let phases = Arc::new(Mutex::new(Vec::new()));
        let mark = |name| {
            let phases = phases.clone();
            async move {
                phases.lock().unwrap().push(name);
            }
        };
        finish(
            Instant::now() + Duration::from_secs(2),
            async {
                mark("http").await;
                Ok(())
            },
            mark("profile"),
            mark("learning"),
            mark("feedback"),
        )
        .await
        .unwrap();
        assert_eq!(
            *phases.lock().unwrap(),
            ["http", "profile", "learning", "feedback"]
        );
    }

    #[tokio::test]
    async fn http_error_still_drains_commits_but_never_becomes_success() {
        let commits = Arc::new(Mutex::new(Vec::new()));
        let record = |name| {
            let commits = commits.clone();
            async move {
                commits.lock().unwrap().push(name);
            }
        };
        let error = finish(
            Instant::now() + Duration::from_secs(2),
            async { Err(io::Error::other("底层HTTP错误")) },
            record("profile"),
            record("learning"),
            record("feedback"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(error.to_string(), "服务排空未完成：HTTP连接");
        assert_eq!(
            *commits.lock().unwrap(),
            ["profile", "learning", "feedback"]
        );
    }

    #[tokio::test]
    async fn all_phases_share_one_deadline_and_later_work_does_not_get_new_budget() {
        let later_started = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_millis(40);
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            finish(
                deadline,
                async {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    Ok(())
                },
                std::future::pending(),
                async {
                    later_started.store(true, Ordering::Relaxed);
                },
                async {
                    later_started.store(true, Ordering::Relaxed);
                },
            ),
        )
        .await
        .expect("共同期限未生效")
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("学习提交"));
        assert!(error.to_string().contains("反馈提交"));
        assert!(!later_started.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn each_blocked_phase_is_a_failure_instead_of_a_warning_only() {
        for blocked in 0..4 {
            let phase = |index| async move {
                if index == blocked {
                    std::future::pending::<()>().await;
                }
            };
            let error = tokio::time::timeout(
                Duration::from_secs(2),
                finish(
                    Instant::now() + Duration::from_millis(30),
                    async {
                        phase(0).await;
                        Ok(())
                    },
                    phase(1),
                    phase(2),
                    phase(3),
                ),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            assert!(
                error
                    .to_string()
                    .contains(["HTTP连接", "画像提交", "学习提交", "反馈提交"][blocked])
            );
        }
    }

    #[tokio::test]
    async fn an_expired_deadline_does_not_poll_even_ready_phase_futures() {
        let called = AtomicBool::new(false);
        let error = finish(
            Instant::now() - Duration::from_secs(1),
            async {
                called.store(true, Ordering::Relaxed);
                Ok(())
            },
            async {
                called.store(true, Ordering::Relaxed);
            },
            async {},
            async {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(!called.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn real_http_body_blocks_graceful_exit_and_timeout_is_not_reported_as_success() {
        use axum::{Router, body::Body, routing::get};
        use tokio::{net::TcpListener, sync::Notify};

        let _ = rustls::crypto::ring::default_provider().install_default();
        let release = Arc::new(Notify::new());
        let stream_release = release.clone();
        let app = Router::new().route(
            "/slow",
            get(move || async move {
                Body::from_stream(futures_util::stream::once(async move {
                    stream_release.notified().await;
                    Ok::<_, io::Error>("tail")
                }))
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .into_future();
        let mut task = tokio::spawn(server);
        let response = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap()
            .get(format!("http://{address}/slow"))
            .send()
            .await
            .unwrap();
        stop.send(()).unwrap();
        let error = finish(
            Instant::now() + Duration::from_millis(40),
            async { (&mut task).await.map_err(io::Error::other)? },
            async {},
            async {},
            async {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(!task.is_finished(), "超时不是连接已回收");
        // 明确释放真实慢响应并join，不将取消等待当作任务被终止。
        release.notify_one();
        assert_eq!(response.text().await.unwrap(), "tail");
        tokio::time::timeout(Duration::from_secs(3), &mut task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);
    }
}
