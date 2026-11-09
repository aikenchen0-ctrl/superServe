use vs_core::{
    DomainError,
    catalog::{Candidate, MediaAsset, PublicCatalog},
    recommendation::{Interest, ProfileProjection, RecommendationRequest, recommend},
};

fn catalog() -> PublicCatalog {
    PublicCatalog {
        version: "test-v1".into(),
        items: vec![
            Candidate {
                id: "video".into(),
                domain: "video".into(),
                tags: vec!["rust".into()],
                prior: 0.2,
                media_sha256: None,
            },
            Candidate {
                id: "article".into(),
                domain: "article".into(),
                tags: vec!["storage".into()],
                prior: 0.9,
                media_sha256: None,
            },
            Candidate {
                id: "service".into(),
                domain: "service".into(),
                tags: vec!["rust".into()],
                prior: 0.5,
                media_sha256: None,
            },
        ],
        assets: vec![],
    }
}

fn request() -> RecommendationRequest {
    RecommendationRequest {
        request_id: "request-1".into(),
        domains: vec!["video".into(), "article".into(), "service".into()],
        limit: 10,
        profile: Some(ProfileProjection {
            subject: "user-a".into(),
            version: "p1".into(),
            scopes: vec!["video".into(), "article".into(), "service".into()],
            expires_at: 100,
            interests: vec![Interest {
                tag: "rust".into(),
                weight: 1.0,
            }],
            blocked_ids: vec![],
            denied_tags: vec![],
        }),
    }
}

#[test]
fn shared_profile_ranks_multiple_domains_without_state_writeback() {
    let catalog = catalog();
    let mut a = request();
    let first = recommend(&catalog, &a, 50).unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|i| i.id.as_str())
            .collect::<Vec<_>>(),
        ["service", "video", "article"]
    );
    a.profile.as_mut().unwrap().interests[0].weight = -1.0;
    assert_eq!(recommend(&catalog, &a, 50).unwrap().items[0].id, "article");
    assert_eq!(
        recommend(&catalog, &request(), 50).unwrap().items[0].id,
        "service"
    );
}

#[test]
fn expiry_and_scope_fail_closed() {
    assert!(matches!(
        recommend(&catalog(), &request(), 100),
        Err(DomainError::Expired)
    ));
    let mut request = request();
    request.profile.as_mut().unwrap().scopes.pop();
    assert!(matches!(
        recommend(&catalog(), &request, 50),
        Err(DomainError::ScopeDenied)
    ));
}

#[test]
fn explicit_exclusions_override_positive_affinity() {
    let mut request = request();
    request
        .profile
        .as_mut()
        .unwrap()
        .blocked_ids
        .push("video".into());
    request
        .profile
        .as_mut()
        .unwrap()
        .denied_tags
        .push("rust".into());
    let result = recommend(&catalog(), &request, 50).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].id, "article");
}

#[test]
fn anonymous_and_input_order_are_deterministic() {
    let mut request = request();
    request.profile = None;
    let mut catalog = catalog();
    let first = recommend(&catalog, &request, 50).unwrap();
    catalog.items.reverse();
    let second = recommend(&catalog, &request, 50).unwrap();
    assert_eq!(
        first.items.iter().map(|i| &i.id).collect::<Vec<_>>(),
        second.items.iter().map(|i| &i.id).collect::<Vec<_>>()
    );
    assert_eq!(first.items[0].id, "article");
}

#[test]
fn malformed_and_unbounded_features_are_rejected() {
    let mut request = request();
    request.limit = 51;
    assert!(recommend(&catalog(), &request, 50).is_err());
    request.limit = 1;
    request.profile.as_mut().unwrap().interests[0].weight = f32::NAN;
    assert!(recommend(&catalog(), &request, 50).is_err());
    request.profile.as_mut().unwrap().interests[0].weight = 0.5;
    request.profile.as_mut().unwrap().interests.push(Interest {
        tag: "rust".into(),
        weight: 0.7,
    });
    assert!(recommend(&catalog(), &request, 50).is_err());
}

#[test]
fn catalog_rejects_duplicate_ids_path_keys_and_missing_assets() {
    let mut catalog = catalog();
    catalog.validate().unwrap();
    catalog.items[1].id = catalog.items[0].id.clone();
    assert!(catalog.validate().is_err());
    catalog.items[1].id = "article".into();
    catalog.assets.push(MediaAsset {
        sha256: "../private".into(),
        bytes: 10,
        content_type: "video/mp4".into(),
    });
    assert!(catalog.validate().is_err());
    catalog.assets.clear();
    catalog.items[0].media_sha256 = Some("a".repeat(64));
    assert!(catalog.validate().is_err());
}

#[test]
fn empty_tags_signed_zero_and_unknown_tags_use_the_same_neutral_tiebreak() {
    let mut catalog = catalog();
    catalog.items[0].tags.clear();
    catalog.items[0].prior = 0.95;
    catalog.items[1].tags = vec!["signed-zero".into()];
    catalog.items[1].prior = 0.8;
    catalog.items[2].tags = vec!["unknown".into()];
    let mut request = request();
    request.profile.as_mut().unwrap().interests = vec![Interest {
        tag: "signed-zero".into(),
        weight: -0.0,
    }];
    let result = recommend(&catalog, &request, 50).unwrap();
    assert_eq!(
        result
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["video", "article", "service"]
    );
    assert!(result.items.iter().all(|item| item.affinity.to_bits() == 0));
    catalog.items.reverse();
    assert_eq!(
        recommend(&catalog, &request, 50).unwrap().items[0].id,
        "video"
    );
}
