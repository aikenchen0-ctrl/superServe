use super::*;
use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::post};
use std::sync::Mutex;
use vs_core::{
    learning::{LinearRankModel, TrainingDataKind},
    recommendation::{Interest, ProfileProjection},
};

#[derive(Clone)]
struct Fixture {
    reply: Arc<Mutex<(StatusCode, Value)>>,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn answer(State(state): State<Fixture>, Json(body): Json<Value>) -> axum::response::Response {
    state.requests.lock().unwrap().push(body);
    let (status, body) = state.reply.lock().unwrap().clone();
    (status, Json(body)).into_response()
}

#[tokio::test]
async fn transport_rejects_foreign_duplicate_filtered_and_oversized_candidates() {
    let catalog_bytes = serde_json::to_vec(&json!({
        "version":"model-protocol","assets":[],
        "items":[
            {"id":"safe","domain":"video","tags":["focus"],"prior":0.9,"media_sha256":null},
            {"id":"hidden","domain":"video","tags":["focus"],"prior":0.8,"media_sha256":null},
            {"id":"denied","domain":"video","tags":["denied"],"prior":0.7,"media_sha256":null},
            {"id":"foreign","domain":"article","tags":["focus"],"prior":0.6,"media_sha256":null}
        ]
    }))
    .unwrap();
    let catalog: PublicCatalog = serde_json::from_slice(&catalog_bytes).unwrap();
    let mut weights = vec![0.0; 12];
    weights[1] = -5.0;
    let model = LearnedRanker::new(
        &LinearRankModel {
            schema: "ftrl-ranker-v1".into(),
            feature_schema: "profile-candidate-6-v1".into(),
            objective: "explicit-preference-v1".into(),
            catalog_version: catalog.version.clone(),
            catalog_sha256: format!("{:x}", Sha256::digest(&catalog_bytes)),
            data_kind: TrainingDataKind::Synthetic,
            trained_before: 1,
            training_samples: 2,
            positive_samples: 1,
            domains: vec!["video".into()],
            weights,
        },
        &catalog,
    )
    .unwrap();
    let mut request = RecommendationRequest {
        request_id: "protocol".into(),
        domains: vec!["video".into()],
        limit: 1,
        profile: Some(ProfileProjection {
            subject: "subject".into(),
            version: "p1".into(),
            expires_at: 200,
            scopes: vec!["video".into()],
            interests: vec![Interest {
                tag: "focus".into(),
                weight: 1.0,
            }],
            blocked_ids: vec!["hidden".into()],
            denied_tags: vec!["denied".into()],
        }),
    };
    let fixture = Fixture {
        reply: Arc::new(Mutex::new((
            StatusCode::OK,
            json!({"result":{"points":[]}}),
        ))),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let routes = Router::new()
        .route("/collections/{name}/points/query", post(answer))
        .with_state(fixture.clone());
    let task = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
    let mut recall = QdrantModelRecall::new(
        QdrantConfig {
            endpoint,
            api_key: None,
            scoring: Default::default(),
        },
        &catalog_bytes,
    )
    .unwrap();
    assert!(recall.query(&request, 100, &model, 1).await.is_err());
    // 此测试只检验HTTP与本地过滤；完整发布验证由独立真实进程合约覆盖。
    recall.verified = true;
    let point = |id: &str| {
        json!({"id":point_id(&recall.catalog_sha256,id),"score":-4.5,"payload":{"candidate_id":id,
        "catalog_sha256":recall.catalog_sha256,"projection":MODEL_RECALL_SCHEMA}})
    };
    let good = point("safe");
    let mut wrong_catalog = good.clone();
    wrong_catalog["payload"]["catalog_sha256"] = json!("f".repeat(64));
    let mut wrong_projection = good.clone();
    wrong_projection["payload"]["projection"] = json!("other");
    let mut invalid_score = good.clone();
    invalid_score["score"] = json!("NaN");
    let mut wrong_id = good.clone();
    wrong_id["id"] = json!(point_id(&"f".repeat(64), "safe"));
    let mut missing_id = good.clone();
    missing_id.as_object_mut().unwrap().remove("id");
    let mut mismatched_id = good.clone();
    mismatched_id["payload"]["candidate_id"] = json!("hidden");
    for points in [
        vec![wrong_catalog],
        vec![wrong_projection],
        vec![invalid_score],
        vec![wrong_id],
        vec![missing_id],
        vec![mismatched_id],
        vec![point("unknown")],
        vec![point("hidden")],
        vec![point("denied")],
        vec![point("foreign")],
        vec![good.clone(), good.clone()],
    ] {
        *fixture.reply.lock().unwrap() = (StatusCode::OK, json!({"result":{"points":points}}));
        assert!(recall.query(&request, 100, &model, 2).await.is_err());
    }
    *fixture.reply.lock().unwrap() = (
        StatusCode::OK,
        json!({
            "result":{"points":[good.clone(),good.clone(),good.clone()]}
        }),
    );
    assert!(recall.query(&request, 100, &model, 2).await.is_err());
    *fixture.reply.lock().unwrap() = (StatusCode::OK, json!({"padding":"x".repeat(262145)}));
    assert!(recall.query(&request, 100, &model, 2).await.is_err());
    *fixture.reply.lock().unwrap() = (StatusCode::TEMPORARY_REDIRECT, json!({}));
    assert!(recall.query(&request, 100, &model, 2).await.is_err());
    *fixture.reply.lock().unwrap() = (StatusCode::OK, json!({"result":{"points":[good]}}));
    let accepted = recall.query(&request, 100, &model, 2).await.unwrap();
    assert_eq!(accepted.indices, vec![0]);
    assert!(accepted.response_body_bytes > 0 && accepted.request_body_bytes > 0);
    assert_eq!(recall.mapping_key_bytes(), 4 * 36);
    for id in ["unknown", "hidden", "denied", "foreign"] {
        let mut compact = point(id);
        compact.as_object_mut().unwrap().remove("payload");
        *fixture.reply.lock().unwrap() = (StatusCode::OK, json!({"result":{"points":[compact]}}));
        assert!(
            recall
                .query_with_response(&request, 100, &model, 2, ModelRecallResponse::IdOnly)
                .await
                .is_err()
        );
    }
    let compact = json!({"id":point_id(&recall.catalog_sha256,"safe"),"score":-4.5});
    *fixture.reply.lock().unwrap() = (StatusCode::OK, json!({"result":{"points":[compact]}}));
    let compact = recall
        .query_with_response(&request, 100, &model, 2, ModelRecallResponse::IdOnly)
        .await
        .unwrap();
    assert_eq!(compact.indices, accepted.indices);
    assert!(compact.response_body_bytes < accepted.response_body_bytes);
    let last = fixture.requests.lock().unwrap().last().unwrap().clone();
    assert_eq!(last["with_payload"], false);
    let count = fixture.requests.lock().unwrap().len();
    assert!(recall.query(&request, 100, &model, 513).await.is_err());
    assert!(recall.query(&request, 100, &model, 0).await.is_err());
    request.profile.as_mut().unwrap().expires_at = 100;
    assert!(recall.query(&request, 100, &model, 2).await.is_err());
    assert_eq!(count, fixture.requests.lock().unwrap().len());
    {
        let requests = fixture.requests.lock().unwrap();
        assert!(requests[0].get("score_threshold").is_none());
        assert!(
            requests[0]["query"]["values"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_f64().unwrap() < 0.0)
        );
        assert_eq!(
            requests[0]["filter"]["must_not"][0]["match"]["any"],
            json!(["hidden"])
        );
        assert_eq!(
            requests[0]["filter"]["must_not"][1]["match"]["any"],
            json!(["denied"])
        );
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
}
