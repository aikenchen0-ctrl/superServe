use std::{sync::Arc, time::Duration};

use reqwest::Client;
use serde_json::{Value, json};
use vs_core::recall::RecallScoring;
use vs_service::{AppState, ProfileRemoteConfig, Role, qdrant_recall::QdrantConfig, router};

const TOKEN: &str = "grouped-feed-api-token-000000000000000000";
const PROFILE_TOKEN: &str = "grouped-feed-profile-token-00000000000000";

async fn serve(state: Arc<AppState>, role: Role) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task =
        tokio::spawn(async move { axum::serve(listener, router(state, role)).await.unwrap() });
    (endpoint, task)
}

async fn post(client: &Client, endpoint: &str, path: &str, body: &Value) -> reqwest::Response {
    client
        .post(format!("{endpoint}{path}"))
        .bearer_auth(TOKEN)
        .json(body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
}

#[tokio::test]
async fn grouped_replicas_follow_shared_profiles_and_match_the_full_scan_after_hide() {
    let mut items: Vec<_> = (0..260)
        .map(|i| {
            json!({
                "id":format!("video-{i:03}"),"domain":"video","tags":["shared"],
                "prior":if i >= 200 {0.9} else {0.1},"media_sha256":null
            })
        })
        .collect();
    items.extend((0..20).map(|i| {
        json!({
            "id":format!("article-{i:03}"),"domain":"article","tags":[],
            "prior":0.5,"media_sha256":null
        })
    }));
    let bytes = serde_json::to_vec(&json!({"version":"grouped-http-v1","items":items,"assets":[]}))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let authority = Arc::new(
        AppState::new_with_profile_log(
            &bytes,
            None,
            PROFILE_TOKEN,
            1,
            1,
            Some(&directory.path().join("events.jsonl")),
        )
        .unwrap()
        .into_profile_authority()
        .unwrap(),
    );
    let (profile_url, profile_task) = serve(authority.clone(), Role::Profile).await;
    let state = |grouped| {
        let state = AppState::new(&bytes, None, TOKEN, 2, 1)
            .unwrap()
            .with_profile_remote(ProfileRemoteConfig {
                endpoint: profile_url.clone(),
                token: PROFILE_TOKEN.into(),
            })
            .unwrap();
        Arc::new(if grouped {
            state.with_grouped_recall().unwrap()
        } else {
            state
        })
    };
    let (api_a, task_a) = serve(state(true), Role::Api).await;
    let (api_b, task_b) = serve(state(true), Role::Api).await;
    let (baseline, baseline_task) = serve(state(false), Role::Api).await;
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap();
    post(
        &client,
        &api_a,
        "/v1/profile/events",
        &json!({
            "event_id":"liked","subject":"user-a","candidate_id":"video-000","kind":"like"
        }),
    )
    .await;
    let feed = json!({"request_id":"grouped-http","subject":"user-a","domains":["video","article"],"limit":10});
    for hidden in [false, true] {
        if hidden {
            post(
                &client,
                &api_b,
                "/v1/profile/events",
                &json!({
                    "event_id":"hidden","subject":"user-a","candidate_id":"video-200","kind":"hide"
                }),
            )
            .await;
        }
        let full: Value = post(&client, &baseline, "/v1/feed", &feed)
            .await
            .json()
            .await
            .unwrap();
        for endpoint in [&api_a, &api_b] {
            let response = post(&client, endpoint, "/v1/feed", &feed).await;
            assert_eq!(response.headers()["x-recall-mode"], "grouped-tags");
            assert_eq!(response.headers()["cache-control"], "no-store");
            let grouped: Value = response.json().await.unwrap();
            assert_eq!(grouped["items"], full["items"]);
            assert_eq!(grouped["profile_version"], full["profile_version"]);
            assert!(grouped["considered"].as_u64().unwrap() <= 128);
            assert_eq!(
                grouped["items"][0]["id"],
                if hidden { "video-201" } else { "video-200" }
            );
        }
    }
    let metrics: Value = client
        .get(format!("{api_a}/v1/metrics"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(metrics["recall_backend"], "grouped");
    assert_eq!(metrics["recall_enabled"], true);
    assert_eq!(metrics["recall_queries"], 0);
    assert_eq!(metrics["grouped_queries"], 2);
    assert_eq!(metrics["grouped_groups_scored"], 4);
    for task in [task_a, task_b, baseline_task, profile_task] {
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }
    authority.drain_profile_writes().await;
}

#[test]
fn grouped_and_remote_index_backends_are_mutually_exclusive() {
    let bytes = br#"{"version":"empty-v1","items":[],"assets":[]}"#;
    let state = || AppState::new(bytes, None, TOKEN, 1, 1).unwrap();
    let config = || QdrantConfig {
        endpoint: "http://127.0.0.1:6333".into(),
        api_key: None,
        scoring: RecallScoring::Signed,
    };
    assert!(
        state()
            .with_grouped_recall()
            .unwrap()
            .with_qdrant_recall(config())
            .is_err()
    );
    assert!(
        state()
            .with_qdrant_recall(config())
            .unwrap()
            .with_grouped_recall()
            .is_err()
    );
    let directory = tempfile::tempdir().unwrap();
    let state_with_log = || {
        AppState::new_with_profile_log(
            bytes,
            None,
            TOKEN,
            1,
            1,
            Some(&directory.path().join("events.jsonl")),
        )
        .unwrap()
    };
    assert!(
        state_with_log()
            .into_profile_authority()
            .unwrap()
            .with_grouped_recall()
            .is_err()
    );
    assert!(
        state_with_log()
            .with_grouped_recall()
            .unwrap()
            .into_profile_authority()
            .is_err()
    );
}
