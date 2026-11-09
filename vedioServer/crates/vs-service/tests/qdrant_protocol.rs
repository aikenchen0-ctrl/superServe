use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Response},
    routing::post,
};
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{recall::RecallScoring, recommendation::RecommendationRequest};
use vs_service::{
    AppState, Role,
    qdrant_recall::{QdrantConfig, QdrantRecall},
    router,
};

const TOKEN: &str = "test-recall-protocol-service-token-00000000";

#[derive(Clone)]
struct Fixture {
    mode: &'static str,
    fingerprint: String,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn query(
    State(state): State<Fixture>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    assert_eq!(headers["api-key"], "test-recall-key");
    state.requests.lock().unwrap().push(body);
    if state.mode == "timeout" {
        return std::future::pending().await;
    }
    let point = |id: &str, fingerprint: &str| {
        json!({
            "payload":{"candidate_id":id,"catalog_sha256":fingerprint}
        })
    };
    let bytes = match state.mode {
        "oversize" => {
            let mut bytes = vec![b' '; 262_145];
            bytes.extend_from_slice(br#"{"result":{"points":[]}}"#);
            bytes
        }
        "catalog" => {
            serde_json::to_vec(&json!({"result":{"points":[point("safe","wrong-catalog")]}}))
                .unwrap()
        }
        "count" => serde_json::to_vec(
            &json!({"result":{"points":vec![point("safe",&state.fingerprint);129]}}),
        )
        .unwrap(),
        _ => serde_json::to_vec(&json!({"result":{"points":[
            point("hidden",&state.fingerprint), point("other-domain",&state.fingerprint),
            point("not-published",&state.fingerprint), point("safe",&state.fingerprint),
            point("safe",&state.fingerprint)
        ]}}))
        .unwrap(),
    };
    if state.mode == "redirect" {
        return Response::builder()
            .status(307)
            .header("location", "/unexpected")
            .body(Body::empty())
            .unwrap();
    }
    // 分块响应不提供 Content-Length，验证累计正文上限。
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from_stream(futures_util::stream::iter(
            bytes
                .chunks(32_768)
                .map(|chunk| Ok::<_, std::convert::Infallible>(chunk.to_vec()))
                .collect::<Vec<_>>(),
        )))
        .unwrap()
}

async fn unexpected_redirect(State(state): State<Fixture>) -> Json<Value> {
    state
        .requests
        .lock()
        .unwrap()
        .push(json!({"redirect_followed":true}));
    Json(json!({"result":{"points":[]}}))
}

#[tokio::test]
async fn query_filters_budget_and_untrusted_results_are_checked_before_ranking() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let catalog = serde_json::to_vec(&json!({
        "version":"protocol-v1","assets":[],
        "items":[
            {"id":"hidden","domain":"video","tags":["rust"],"prior":1.0,"media_sha256":null},
            {"id":"safe","domain":"video","tags":["rust"],"prior":0.4,"media_sha256":null},
            {"id":"other-domain","domain":"article","tags":["rust"],"prior":1.0,"media_sha256":null},
            {"id":"prior","domain":"video","tags":["general"],"prior":0.5,"media_sha256":null}
        ]
    })).unwrap();
    let fingerprint = format!("{:x}", Sha256::digest(&catalog));
    let client = Client::builder().no_proxy().build().unwrap();
    for mode in [
        "mixed",
        "signed",
        "nonpositive",
        "catalog",
        "oversize",
        "count",
        "redirect",
        "timeout",
    ] {
        let fixture = Fixture {
            mode,
            fingerprint: fingerprint.clone(),
            requests: Arc::new(Mutex::new(Vec::new())),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let routes = Router::new()
            .route("/collections/{name}/points/query", post(query))
            .route("/unexpected", post(unexpected_redirect))
            .with_state(fixture.clone());
        let qdrant_task = tokio::spawn(async move {
            axum::serve(listener, routes).await.unwrap();
        });
        let state = Arc::new(
            AppState::new(&catalog, None, TOKEN, 1, 1)
                .unwrap()
                .with_qdrant_recall(QdrantConfig {
                    endpoint,
                    api_key: Some("test-recall-key".into()),
                    scoring: if matches!(mode, "signed" | "nonpositive") {
                        RecallScoring::Signed
                    } else {
                        RecallScoring::Positive
                    },
                })
                .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router(state, Role::Api))
                .await
                .unwrap();
        });
        for (event_id, candidate_id, kind) in [
            (
                "interest",
                "safe",
                if mode == "nonpositive" {
                    "skip"
                } else {
                    "like"
                },
            ),
            ("hide", "hidden", "hide"),
        ] {
            client.post(format!("{api}/v1/profile/events")).bearer_auth(TOKEN).json(&json!({
                "event_id":event_id,"subject":"test-user","candidate_id":candidate_id,"kind":kind
            })).send().await.unwrap().error_for_status().unwrap();
        }
        if mode == "signed" {
            client
                .post(format!("{api}/v1/profile/events"))
                .bearer_auth(TOKEN)
                .json(&json!({
                    "event_id":"skip","subject":"test-user","candidate_id":"prior","kind":"skip"
                }))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
        let response = client
            .post(format!("{api}/v1/feed"))
            .bearer_auth(TOKEN)
            .json(&json!({
                "request_id":"protocol-request","subject":"test-user","domains":["video"],"limit":5
            }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert_eq!(
            response.headers()["x-recall-mode"],
            match mode {
                "mixed" => "qdrant-tags+prior",
                "signed" => "qdrant-signed-tags+prior",
                "nonpositive" => "prior-nonpositive",
                _ => "prior-degraded",
            }
        );
        assert_eq!(response.headers()["x-request-id"], "protocol-request");
        let result: Value = response.json().await.unwrap();
        assert_eq!(
            result["profile_version"],
            if mode == "signed" {
                "memory-3"
            } else {
                "memory-2"
            }
        );
        assert_eq!(result["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            result["items"][0]["id"],
            if mode == "nonpositive" {
                "prior"
            } else {
                "safe"
            }
        );
        assert!(
            result["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["domain"] == "video" && item["id"] != "hidden")
        );
        {
            let requests = fixture.requests.lock().unwrap();
            if mode == "nonpositive" {
                assert!(requests.is_empty());
            } else {
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0]["using"], "tags");
                assert_eq!(requests[0]["limit"], 128);
                assert_eq!(requests[0]["with_vector"], false);
                if mode == "signed" {
                    let values = requests[0]["query"]["values"].as_array().unwrap();
                    assert!(values.iter().any(|value| value.as_f64().unwrap() < 0.0));
                    assert!(values.iter().any(|value| value.as_f64().unwrap() > 0.0));
                }
                assert_eq!(
                    requests[0]["filter"]["must"][0]["match"]["value"],
                    fingerprint
                );
                assert_eq!(
                    requests[0]["filter"]["must"][1]["match"]["any"],
                    json!(["video"])
                );
                assert_eq!(
                    requests[0]["filter"]["must_not"][0]["match"]["any"],
                    json!(["hidden"])
                );
            }
        }
        for task in [task, qdrant_task] {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
    }
}

#[tokio::test]
async fn signed_vectors_are_opt_in_and_invalid_vectors_never_reach_the_index() {
    let fixture = Fixture {
        mode: "mixed",
        fingerprint: "a".repeat(64),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let routes = Router::new()
        .route("/collections/{name}/points/query", post(query))
        .with_state(fixture.clone());
    let task = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
    let client = |scoring| {
        QdrantRecall::new(
            QdrantConfig {
                endpoint: endpoint.clone(),
                api_key: Some("test-recall-key".into()),
                scoring,
            },
            fixture.fingerprint.clone(),
        )
        .unwrap()
    };
    let request = RecommendationRequest {
        request_id: "signed-query".into(),
        domains: vec!["video".into()],
        limit: 10,
        profile: None,
    };
    let positive = client(RecallScoring::Positive);
    let signed = client(RecallScoring::Signed);
    assert!(positive.query(&request, vec![0], vec![-0.5]).await.is_err());
    for (indices, values) in [
        (vec![0], vec![0.0]),
        (vec![0], vec![f32::NAN]),
        (vec![0], vec![f32::INFINITY]),
        (vec![0], vec![-1.01]),
        (vec![0, 0], vec![0.5, -0.5]),
        (vec![1, 0], vec![0.5, -0.5]),
        (vec![0, 1], vec![0.5]),
        ((0..129).collect(), vec![0.5; 129]),
    ] {
        assert!(signed.query(&request, indices, values).await.is_err());
    }
    assert!(fixture.requests.lock().unwrap().is_empty());
    signed
        .query(&request, vec![0, 1], vec![1.0, -0.5])
        .await
        .unwrap();
    {
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["query"]["values"], json!([1.0, -0.5]));
        assert_eq!(requests[0]["limit"], 128);
        assert!(requests[0]["score_threshold"].as_f64().unwrap() > 0.0);
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}
