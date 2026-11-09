use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;
use vs_service::{
    AppState, Role,
    feed_access::{FeedAccessConfig, FeedAccessKey},
    router,
};

const SERVICE_TOKEN: &str = "feed-access-integration-service-token";
const ISSUER: &str = "https://identity.example";
const AUDIENCE: &str = "feed-api";

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn signing_key(seed: u8) -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap()
}

fn config() -> FeedAccessConfig {
    FeedAccessConfig {
        issuer: ISSUER.into(),
        audience: AUDIENCE.into(),
        keys: vec![FeedAccessKey {
            kid: "gateway-1".into(),
            public_key: URL_SAFE_NO_PAD.encode(signing_key(11).public_key().as_ref()),
        }],
    }
}

fn token(claims: Value, seed: u8, typ: &str, kid: &str) -> String {
    let header = json!({"alg":"EdDSA","typ":typ,"kid":kid});
    let message = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );
    let signature = signing_key(seed).sign(message.as_bytes());
    format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}

fn claims(subject: &str, domains: Value) -> Value {
    let issued_at = now().saturating_sub(1);
    json!({
        "iss":ISSUER,
        "aud":AUDIENCE,
        "sub":subject,
        "iat":issued_at,
        "nbf":issued_at,
        "exp":issued_at + 120,
        "domains":domains
    })
}

fn state(directory: &TempDir, enabled: bool) -> Arc<AppState> {
    let catalog = br#"{"version":"feed-access-v1","items":[
        {"id":"video","domain":"video","tags":["rust"],"prior":0.8,"media_sha256":null},
        {"id":"article","domain":"article","tags":["storage"],"prior":0.6,"media_sha256":null}
    ],"assets":[]}"#;
    let mut state = AppState::new(catalog, None, SERVICE_TOKEN, 2, 1).unwrap();
    state = state
        .with_learning_journal(&directory.path().join("decisions.jsonl"), "feed-api")
        .unwrap();
    if enabled {
        state = state.with_feed_access(config()).unwrap();
    }
    Arc::new(state)
}

fn request(body: Value, bearer: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri("/internal/v2/feed")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {SERVICE_TOKEN}"));
    if let Some(token) = bearer {
        request = request.header("x-feed-identity", format!("Bearer {token}"));
    }
    request
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

async fn response_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await.unwrap()).unwrap()
}

#[tokio::test]
async fn signed_subject_is_used_for_feed_and_durable_decision() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(state(&directory, true), Role::Api);
    let signed = token(
        claims("stable-user-17", json!(["video"])),
        11,
        "vs-feed+jwt",
        "gateway-1",
    );
    let response = app
        .oneshot(request(
            json!({"request_id":"signed-feed","domains":["video"],"limit":1}),
            Some(&signed),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(response.headers().contains_key("x-learning-decision-id"));
    let body = response_body(response).await;
    assert_eq!(body["items"][0]["id"], "video");

    let journal: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("decisions.jsonl")).unwrap())
            .unwrap();
    assert_eq!(journal["envelope"]["payload"]["subject"], "stable-user-17");
    assert_eq!(
        journal["envelope"]["payload"]["request"]["domains"],
        json!(["video"])
    );
}

#[tokio::test]
async fn request_body_cannot_supply_or_override_subject() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(state(&directory, true), Role::Api);
    let signed = token(
        claims("stable-user-17", json!(["video"])),
        11,
        "vs-feed+jwt",
        "gateway-1",
    );
    let response = app
        .oneshot(request(
            json!({
                "request_id":"spoof-subject",
                "subject":"attacker-selected-user",
                "domains":["video"],
                "limit":1
            }),
            Some(&signed),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        std::fs::read(directory.path().join("decisions.jsonl"))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn domain_scope_and_token_validation_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(state(&directory, true), Role::Api);
    let in_scope = token(
        claims("stable-user-17", json!(["video"])),
        11,
        "vs-feed+jwt",
        "gateway-1",
    );
    let response = app
        .clone()
        .oneshot(request(
            json!({"request_id":"out-of-scope","domains":["article"],"limit":1}),
            Some(&in_scope),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let at = now().saturating_sub(200);
    let expired = json!({
        "iss":ISSUER,"aud":AUDIENCE,"sub":"stable-user-17",
        "iat":at,"nbf":at,"exp":at+60,"domains":["video"]
    });
    let unknown_key = token(
        claims("stable-user-17", json!(["video"])),
        11,
        "vs-feed+jwt",
        "unknown",
    );
    let wrong_type = token(
        claims("stable-user-17", json!(["video"])),
        11,
        "vs-consumption+jwt",
        "gateway-1",
    );
    let expired = token(expired, 11, "vs-feed+jwt", "gateway-1");
    for candidate in [unknown_key, wrong_type, expired] {
        let response = app
            .clone()
            .oneshot(request(
                json!({"request_id":"invalid-token","domains":["video"],"limit":1}),
                Some(&candidate),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    drop(app);
    assert!(
        std::fs::read(directory.path().join("decisions.jsonl"))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn route_is_disabled_without_configuration_and_outside_api_roles() {
    let directory = tempfile::tempdir().unwrap();
    let signed = token(
        claims("stable-user-17", json!(["video"])),
        11,
        "vs-feed+jwt",
        "gateway-1",
    );
    let body = json!({"request_id":"disabled","domains":["video"],"limit":1});

    let disabled = router(state(&directory, false), Role::Api)
        .oneshot(request(body.clone(), Some(&signed)))
        .await
        .unwrap();
    assert_eq!(disabled.status(), StatusCode::NOT_FOUND);

    let wrong_role = router(state(&directory, true), Role::Media)
        .oneshot(request(body, Some(&signed)))
        .await
        .unwrap();
    assert_eq!(wrong_role.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delegated_identity_route_requires_both_service_and_user_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let signed = token(
        claims("stable-user-17", json!(["video"])),
        11,
        "vs-feed+jwt",
        "gateway-1",
    );
    let body = json!({"request_id":"both-credentials","domains":["video"],"limit":1});

    let no_identity = router(state(&directory, true), Role::Api)
        .oneshot(request(body.clone(), None))
        .await
        .unwrap();
    assert_eq!(no_identity.status(), StatusCode::UNAUTHORIZED);

    let no_service = Request::builder()
        .method("POST")
        .uri("/internal/v2/feed")
        .header("content-type", "application/json")
        .header("x-feed-identity", format!("Bearer {signed}"))
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let rejected = router(state(&directory, true), Role::Api)
        .oneshot(no_service)
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);

    let accepted = router(state(&directory, true), Role::Api)
        .oneshot(request(body, Some(&signed)))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
}

#[test]
fn access_configuration_rejects_duplicate_keys_and_requires_api_state() {
    let catalog = br#"{"version":"feed-access-v1","items":[],"assets":[]}"#;
    let duplicate_keys = FeedAccessConfig {
        issuer: ISSUER.into(),
        audience: AUDIENCE.into(),
        keys: vec![config().keys[0].clone(), config().keys[0].clone()],
    };
    assert!(
        AppState::new(catalog, None, SERVICE_TOKEN, 1, 1)
            .unwrap()
            .with_feed_access(duplicate_keys)
            .is_err()
    );
    let configured = AppState::new(catalog, None, SERVICE_TOKEN, 1, 1)
        .unwrap()
        .with_feed_access(config())
        .unwrap();
    assert!(configured.with_feed_access(config()).is_err());
}
