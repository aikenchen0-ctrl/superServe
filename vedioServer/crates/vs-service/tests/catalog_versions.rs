use std::{path::Path, sync::Arc, time::Duration};

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_service::{AppState, ProfileRemoteConfig, Role, router};

const API_TOKEN: &str = "catalog-version-api-token-000000000000";
const PROFILE_TOKEN: &str = "catalog-version-profile-token-000000000";

struct Server {
    url: String,
    state: Arc<AppState>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn stop(self) {
        self.task.abort();
        self.state.drain_profile_writes().await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self.task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("测试服务退出超时");
    }
}

async fn serve(state: AppState, role: Role) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(state);
    let app = router(state.clone(), role);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server { url, state, task }
}

fn authority(bytes: &[u8], log: &Path) -> AppState {
    AppState::new_with_profile_log(bytes, None, PROFILE_TOKEN, 1, 1, Some(log))
        .unwrap()
        .into_profile_authority()
        .unwrap()
}

fn replica(bytes: &[u8], endpoint: &str) -> AppState {
    AppState::new(bytes, None, API_TOKEN, 2, 1)
        .unwrap()
        .with_profile_remote(ProfileRemoteConfig {
            endpoint: endpoint.into(),
            token: PROFILE_TOKEN.into(),
        })
        .unwrap()
        .with_grouped_recall()
        .unwrap()
}

async fn post(client: &Client, url: &str, body: &Value) -> reqwest::Response {
    client
        .post(url)
        .bearer_auth(API_TOKEN)
        .json(body)
        .send()
        .await
        .unwrap()
}

fn catalog(changed: bool) -> Vec<u8> {
    let items = if changed {
        json!([
            {"id":"stable","domain":"video","tags":["new-topic"],"prior":1.0,"media_sha256":null},
            {"id":"new-item","domain":"video","tags":["old-topic"],"prior":0.0,"media_sha256":null}
        ])
    } else {
        json!([
            {"id":"stable","domain":"video","tags":["old-topic"],"prior":1.0,"media_sha256":null},
            {"id":"removed","domain":"video","tags":["old-topic"],"prior":0.0,"media_sha256":null}
        ])
    };
    serde_json::to_vec(&json!({
        "version":if changed {"catalog-v2"} else {"catalog-v1"},
        "items":items,"assets":[]
    }))
    .unwrap()
}

#[tokio::test]
async fn publication_restart_preserves_facts_and_blocks_stale_replicas() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().unwrap();
    let log = directory.path().join("events.jsonl");
    let old_catalog = catalog(false);
    let new_catalog = catalog(true);
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    let old_authority = serve(authority(&old_catalog, &log), Role::Profile).await;
    let old_api = serve(replica(&old_catalog, &old_authority.url), Role::Api).await;
    let first =
        json!({"event_id":"first-like","subject":"user-a","candidate_id":"stable","kind":"like"});
    for event in [
        first.clone(),
        json!({"event_id":"first-hide","subject":"user-a","candidate_id":"removed","kind":"hide"}),
    ] {
        post(
            &client,
            &format!("{}/v1/profile/events", old_api.url),
            &event,
        )
        .await
        .error_for_status()
        .unwrap();
    }
    old_api.stop().await;
    old_authority.stop().await;

    let new_authority = serve(authority(&new_catalog, &log), Role::Profile).await;
    let api_a = serve(replica(&new_catalog, &new_authority.url), Role::Api).await;
    let api_b = serve(replica(&new_catalog, &new_authority.url), Role::Api).await;
    let stale_api = serve(replica(&old_catalog, &new_authority.url), Role::Api).await;
    let stale = client
        .get(format!("{}/readyz", stale_api.url))
        .bearer_auth(API_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(
        post(
            &client,
            &format!("{}/v1/profile/events", stale_api.url),
            &first
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    let duplicate: Value = post(&client, &format!("{}/v1/profile/events", api_b.url), &first)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["profile_version"], "memory-2");
    let feed = json!({"request_id":"versions","subject":"user-a","domains":["video"],"limit":2});
    for api in [&api_a, &api_b] {
        let response = post(&client, &format!("{}/v1/feed", api.url), &feed).await;
        assert_eq!(
            response.headers()["x-catalog-sha256"],
            format!("{:x}", Sha256::digest(&new_catalog))
        );
        let body: Value = response.error_for_status().unwrap().json().await.unwrap();
        assert_eq!(body["profile_version"], "memory-2");
        assert_eq!(body["items"][0]["id"], "new-item");
        assert_eq!(body["items"][0]["affinity"], 0.5);
        assert_eq!(body["items"][1]["affinity"], 0.0);
    }
    post(
        &client,
        &format!("{}/v1/profile/events", api_a.url),
        &json!({"event_id":"second-like","subject":"user-a","candidate_id":"stable","kind":"like"}),
    )
    .await
    .error_for_status()
    .unwrap();
    let changed: Value = post(&client, &format!("{}/v1/feed", api_b.url), &feed)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(changed["profile_version"], "memory-3");
    assert_eq!(changed["items"][0]["id"], "stable");
    assert_eq!(changed["items"][0]["affinity"], 1.0);
    for server in [api_a, api_b, stale_api, new_authority] {
        server.stop().await;
    }

    // 回到旧目录仍使用提交时特征，不把新版本事件重新解释为旧标签。
    let rollback = serve(authority(&old_catalog, &log), Role::Profile).await;
    let projection: Value = client
        .post(format!("{}/internal/v1/profile/projection", rollback.url))
        .bearer_auth(PROFILE_TOKEN)
        .header(
            "x-catalog-sha256",
            format!("{:x}", Sha256::digest(&old_catalog)),
        )
        .json(&json!({"subject":"user-a","domains":["video"]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(projection["profile"]["version"], "memory-3");
    assert_eq!(projection["profile"]["blocked_ids"], json!(["removed"]));
    assert_eq!(
        projection["profile"]["interests"],
        json!([{"tag":"new-topic","weight":1.0},{"tag":"old-topic","weight":0.5}])
    );
    rollback.stop().await;
}
