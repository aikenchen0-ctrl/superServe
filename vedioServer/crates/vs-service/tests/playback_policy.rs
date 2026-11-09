use std::sync::Arc;

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use tower::ServiceExt;
use vs_core::playback::PlaybackPolicy;
use vs_service::{AppState, Role, playback_policy::PlaybackPolicyResponse, router};

const TOKEN: &str = "playback-policy-only-test-token-0000000000";
const CATALOG: &[u8] = br#"{"version":"policy-v1","items":[],"assets":[]}"#;

fn request(token: bool, etag: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().uri("/v1/playback/policy");
    if token {
        builder = builder.header("authorization", format!("Bearer {TOKEN}"));
    }
    if let Some(etag) = etag {
        builder = builder.header("if-none-match", etag);
    }
    builder.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn policy_is_authenticated_verifiable_and_cacheable_only_for_its_fixed_catalog() {
    let state = Arc::new(AppState::new(CATALOG, None, TOKEN, 1, 1).unwrap());
    let app = router(state.clone(), Role::Api);
    assert_eq!(
        app.clone()
            .oneshot(request(false, Some("*")))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = app.clone().oneshot(request(true, None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "private, max-age=300");
    let etag = response.headers()["etag"].to_str().unwrap().to_string();
    let catalog_hash = response.headers()["x-catalog-sha256"]
        .to_str()
        .unwrap()
        .to_string();
    let mut policy: PlaybackPolicyResponse =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    policy.verify(&catalog_hash).unwrap();
    assert!(policy.verify(&"f".repeat(64)).is_err());
    policy.policy.max_buffer_ms += 1;
    assert!(policy.verify(&catalog_hash).is_err());
    let response = app
        .clone()
        .oneshot(request(true, Some(&etag)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert!(
        to_bytes(response.into_body(), 4096)
            .await
            .unwrap()
            .is_empty()
    );
    for role in [Role::Media, Role::Profile] {
        assert_eq!(
            router(state.clone(), role)
                .oneshot(request(true, None))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn changed_policy_changes_etag_without_rebinding_old_instances() {
    let original = Arc::new(AppState::new(CATALOG, None, TOKEN, 1, 1).unwrap());
    let old = router(original, Role::All);
    let response = old.clone().oneshot(request(true, None)).await.unwrap();
    let etag = response.headers()["etag"].to_str().unwrap().to_string();
    let changed = AppState::new(CATALOG, None, TOKEN, 1, 1)
        .unwrap()
        .with_playback_policy(PlaybackPolicy {
            max_buffer_ms: 6000,
            ..Default::default()
        })
        .unwrap();
    let response = router(Arc::new(changed), Role::Api)
        .oneshot(request(true, Some(&etag)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_ne!(response.headers()["etag"], etag);
    assert_eq!(
        old.oneshot(request(true, Some(&etag)))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_MODIFIED
    );
}
