use std::{fs, sync::Arc};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_core::catalog::PublicCatalog;
use vs_service::{AppState, Role, hls::publish_hls, publication::load_catalog_release, router};
use vs_storage::MediaStore;

const INPUT: &[u8] = include_bytes!("fixtures/mp4/h264-aac-tail.mp4");
const TOKEN: &str = "hls-contract-only-token-000000000000000";

#[test]
fn hls_assets_are_content_addressed_complete_and_reused_without_reencoding() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("published");
    fs::create_dir(&root).unwrap();
    let source = directory.path().join("input.mp4");
    fs::write(&source, INPUT).unwrap();
    let receipt = publish_hls(&root, &source, "hls-v1", "clip", 1).unwrap();
    let bytes = load_catalog_release(&root, "hls-v1").unwrap();
    let catalog: PublicCatalog = serde_json::from_slice(&bytes).unwrap();
    catalog.validate().unwrap();
    assert_eq!(receipt.tracks.len(), 2);
    assert_eq!(
        catalog.items[0].media_sha256.as_ref().unwrap(),
        &receipt.master_sha256
    );
    let master = fs::read_to_string(root.join("media").join(&receipt.master_sha256)).unwrap();
    assert!(master.contains("AUDIO=\"aud\""));
    assert!(master.contains("CODECS=\"avc1."));
    assert!(master.contains("mp4a.40.2"));
    for asset in &catalog.assets {
        let bytes = fs::read(root.join(asset.object_key())).unwrap();
        assert_eq!(bytes.len() as u64, asset.bytes);
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), asset.sha256);
    }
    for track in &receipt.tracks {
        assert!(!track.segments.is_empty());
        let mut previous_end = 0;
        let playlist = fs::read_to_string(root.join("media").join(&track.playlist_sha256)).unwrap();
        assert!(playlist.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(playlist.contains("#EXT-X-ENDLIST"));
        assert!(playlist.contains(&format!(
            "URI=\"/v1/media/{}/media.mp4\"",
            track.init_sha256
        )));
        for segment in &track.segments {
            assert_eq!(segment.start_ticks, previous_end);
            previous_end += segment.duration_ticks;
            assert!(playlist.contains(&format!("/v1/media/{}", segment.sha256)));
        }
    }
    let count = fs::read_dir(root.join("media")).unwrap().count();
    let retry = publish_hls(&root, &source, "hls-v1", "clip", 1).unwrap();
    assert_eq!(retry.master_sha256, receipt.master_sha256);
    assert!(!retry.catalog.release_created);
    assert_eq!(fs::read_dir(root.join("media")).unwrap().count(), count);
    assert_eq!(fs::read(source).unwrap(), INPUT);
}

#[test]
fn malformed_or_expansion_tables_never_publish_a_catalog() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("input.mp4");
    let stsz = INPUT.windows(4).position(|value| value == b"stsz").unwrap();
    let stts = INPUT.windows(4).position(|value| value == b"stts").unwrap();
    let moov = INPUT.windows(4).position(|value| value == b"moov").unwrap() - 4;
    let mut huge = INPUT.to_vec();
    huge[stsz + 12..stsz + 16].copy_from_slice(&u32::MAX.to_be_bytes());
    let mut missing_time = INPUT.to_vec();
    missing_time[stts + 12..stts + 16].copy_from_slice(&0_u32.to_be_bytes());
    for (index, bytes) in [
        Vec::new(),
        INPUT[..INPUT.len() - 1].to_vec(),
        huge,
        missing_time,
        [INPUT, &INPUT[moov..]].concat(),
        [INPUT, b"\0\0\0\x08moof"].concat(),
    ]
    .iter()
    .enumerate()
    {
        let root = directory.path().join(format!("case-{index}"));
        fs::create_dir(&root).unwrap();
        fs::write(&source, bytes).unwrap();
        assert!(publish_hls(&root, &source, "rejected-v1", "clip", 2).is_err());
        assert!(!root.join("releases/rejected-v1.json").exists());
    }
    let root = directory.path().join("payload-expansion");
    fs::create_dir(&root).unwrap();
    let mut repeated_payload = INPUT.to_vec();
    repeated_payload[stsz + 16..stsz + 20].copy_from_slice(&(INPUT.len() as u32).to_be_bytes());
    fs::write(&source, repeated_payload).unwrap();
    let error = publish_hls(&root, &source, "rejected-v1", "clip", 2).unwrap_err();
    assert!(error.to_string().contains("载荷预算"));
    assert!(!root.join("media").exists());
}

#[test]
fn changed_packaging_cannot_rebind_release_and_invalid_policy_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("published");
    fs::create_dir(&root).unwrap();
    let source = directory.path().join("input.mp4");
    fs::write(&source, INPUT).unwrap();
    publish_hls(&root, &source, "pinned-v1", "clip", 1).unwrap();
    let original = load_catalog_release(&root, "pinned-v1").unwrap();
    assert!(publish_hls(&root, &source, "pinned-v1", "clip", 2).is_err());
    assert_eq!(load_catalog_release(&root, "pinned-v1").unwrap(), original);
    for seconds in [0, 7, u32::MAX] {
        assert!(publish_hls(&root, &source, "invalid-v1", "clip", seconds).is_err());
        assert!(!root.join("releases/invalid-v1.json").exists());
    }
}

#[tokio::test]
async fn hls_manifest_and_segments_reuse_catalog_auth_range_and_recommendations() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.mp4");
    fs::write(&source, INPUT).unwrap();
    let receipt = publish_hls(directory.path(), &source, "http-v1", "clip", 1).unwrap();
    let bytes = load_catalog_release(directory.path(), "http-v1").unwrap();
    let store = MediaStore::filesystem(directory.path().to_str().unwrap()).unwrap();
    let state = Arc::new(
        AppState::new(&bytes, Some(store), TOKEN, 1, 1)
            .unwrap()
            .with_grouped_recall()
            .unwrap(),
    );
    let app = router(state, Role::All);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&receipt.media_path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&receipt.media_path)
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "application/vnd.apple.mpegurl"
    );
    assert!(
        to_bytes(response.into_body(), 4096)
            .await
            .unwrap()
            .starts_with(b"#EXTM3U")
    );
    let segment = &receipt.tracks[0].segments[0];
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/media/{}/media.mp4", segment.sha256))
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("range", "bytes=0-31")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(to_bytes(response.into_body(), 32).await.unwrap().len(), 32);
    for path in [
        format!("/v1/media/{}/index.m3u8", segment.sha256),
        format!("/v1/media/{}/media.mp4", receipt.master_sha256),
        format!("/v1/media/{}/other.mp4", segment.sha256),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    for (path, request) in [
        (
            "/v1/recommendations",
            r#"{"request_id":"hls","domains":["video"],"limit":1,"profile":null}"#,
        ),
        (
            "/v1/feed",
            r#"{"request_id":"hls-feed","subject":"viewer","domains":["video"],"limit":1}"#,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .header("content-type", "application/json")
                    .body(Body::from(request))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["items"][0]["media_path"], receipt.media_path);
    }
}
