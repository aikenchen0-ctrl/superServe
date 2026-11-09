use std::{
    fs,
    sync::{Arc, Barrier},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use vs_core::catalog::MediaAsset;
use vs_service::publication::{load_catalog_release, publish_catalog, publish_media_file};

struct Fixture {
    directory: TempDir,
    root: std::path::PathBuf,
    source: std::path::PathBuf,
    data: Vec<u8>,
    asset: MediaAsset,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("published");
        fs::create_dir(&root).unwrap();
        let source = directory.path().join("source.bin");
        let data: Vec<_> = (0..262_173).map(|index| (index % 251) as u8).collect();
        fs::write(&source, &data).unwrap();
        let asset = MediaAsset {
            sha256: format!("{:x}", Sha256::digest(&data)),
            bytes: data.len() as u64,
            content_type: "application/octet-stream".into(),
        };
        Self {
            directory,
            root,
            source,
            data,
            asset,
        }
    }

    fn catalog(&self, version: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version":version,
            "items":[{"id":"video","domain":"video","tags":["original"],"prior":0.5,"media_sha256":self.asset.sha256}],
            "assets":[self.asset]
        }))
        .unwrap()
    }
}

#[test]
fn corrupt_same_length_input_never_appears_at_final_key() {
    let fixture = Fixture::new();
    let mut corrupt = fixture.data.clone();
    corrupt[0] ^= 1;
    fs::write(&fixture.source, &corrupt).unwrap();
    assert!(publish_media_file(&fixture.root, &fixture.source, &fixture.asset).is_err());
    assert!(!fixture.root.join(fixture.asset.object_key()).exists());
    assert_eq!(fs::read_dir(fixture.root.join("media")).unwrap().count(), 0);
    assert_eq!(fs::read(&fixture.source).unwrap(), corrupt);
    fs::write(&fixture.source, b"truncated").unwrap();
    assert!(publish_media_file(&fixture.root, &fixture.source, &fixture.asset).is_err());
    assert_eq!(fs::read_dir(fixture.root.join("media")).unwrap().count(), 0);
}

#[test]
fn concurrent_asset_publish_has_one_creator_and_verified_reuse() {
    let fixture = Fixture::new();
    let gate = Arc::new(Barrier::new(8));
    let receipts = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let gate = gate.clone();
                let fixture = &fixture;
                scope.spawn(move || {
                    gate.wait();
                    publish_media_file(&fixture.root, &fixture.source, &fixture.asset).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(receipts.iter().filter(|receipt| receipt.created).count(), 1);
    assert!(receipts.iter().all(|receipt| receipt.verified));
    assert_eq!(
        fs::read(fixture.root.join(fixture.asset.object_key())).unwrap(),
        fixture.data
    );
    assert_eq!(fs::read_dir(fixture.root.join("media")).unwrap().count(), 1);
    // 重试只验证已有对象，原始上传已不再是必要资源。
    fs::remove_file(&fixture.source).unwrap();
    assert!(
        !publish_media_file(&fixture.root, &fixture.source, &fixture.asset)
            .unwrap()
            .created
    );
}

#[test]
fn corrupt_existing_object_is_not_silently_repaired_or_reused() {
    let fixture = Fixture::new();
    publish_media_file(&fixture.root, &fixture.source, &fixture.asset).unwrap();
    let final_path = fixture.root.join(fixture.asset.object_key());
    let mut changed = fixture.data.clone();
    changed[8] ^= 1;
    fs::write(&final_path, &changed).unwrap();
    assert!(publish_media_file(&fixture.root, &fixture.source, &fixture.asset).is_err());
    assert!(publish_catalog(&fixture.root, &fixture.catalog("bad-v1")).is_err());
    assert_eq!(fs::read(&final_path).unwrap(), changed);
    assert!(!fixture.root.join("releases/bad-v1.json").exists());
}

#[test]
fn catalog_commit_requires_assets_and_preserves_pinned_history() {
    let fixture = Fixture::new();
    let first = fixture.catalog("release-v1");
    assert!(publish_catalog(&fixture.root, &first).is_err());
    assert!(!fixture.root.join("releases/release-v1.json").exists());
    publish_media_file(&fixture.root, &fixture.source, &fixture.asset).unwrap();
    let receipt = publish_catalog(&fixture.root, &first).unwrap();
    assert!(receipt.catalog_created && receipt.release_created);
    assert_eq!(receipt.assets_verified, 1);
    assert_eq!(
        load_catalog_release(&fixture.root, "release-v1").unwrap(),
        first
    );
    let retry = publish_catalog(&fixture.root, &first).unwrap();
    assert!(!retry.catalog_created && !retry.release_created);
    let mut changed: Value = serde_json::from_slice(&first).unwrap();
    changed["items"][0]["tags"] = json!(["changed"]);
    let changed_same_version = serde_json::to_vec(&changed).unwrap();
    assert!(publish_catalog(&fixture.root, &changed_same_version).is_err());
    assert_eq!(
        load_catalog_release(&fixture.root, "release-v1").unwrap(),
        first
    );
    changed["version"] = json!("release-v2");
    let second = serde_json::to_vec(&changed).unwrap();
    publish_catalog(&fixture.root, &second).unwrap();
    assert_eq!(
        load_catalog_release(&fixture.root, "release-v2").unwrap(),
        second
    );
    assert_eq!(
        load_catalog_release(&fixture.root, "release-v1").unwrap(),
        first
    );
}

#[test]
fn interrupted_catalog_stage_is_not_a_release_and_retry_can_complete() {
    let fixture = Fixture::new();
    publish_media_file(&fixture.root, &fixture.source, &fixture.asset).unwrap();
    let catalog = fixture.catalog("resume-v1");
    let hash = format!("{:x}", Sha256::digest(&catalog));
    fs::create_dir(fixture.root.join("catalogs")).unwrap();
    fs::write(
        fixture.root.join("catalogs").join(format!("{hash}.json")),
        &catalog,
    )
    .unwrap();
    assert!(load_catalog_release(&fixture.root, "resume-v1").is_err());
    let receipt = publish_catalog(&fixture.root, &catalog).unwrap();
    assert!(!receipt.catalog_created);
    assert!(receipt.release_created);
    assert_eq!(
        load_catalog_release(&fixture.root, "resume-v1").unwrap(),
        catalog
    );
}

#[test]
fn competing_catalogs_cannot_rebind_one_release_version() {
    let fixture = Fixture::new();
    publish_media_file(&fixture.root, &fixture.source, &fixture.asset).unwrap();
    let catalogs: Vec<_> = (0..8)
        .map(|index| {
            let mut value: Value = serde_json::from_slice(&fixture.catalog("race-v1")).unwrap();
            value["items"][0]["tags"] = json!([format!("tag-{index}")]);
            serde_json::to_vec(&value).unwrap()
        })
        .collect();
    let gate = Arc::new(Barrier::new(8));
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = catalogs
            .iter()
            .map(|bytes| {
                let fixture = &fixture;
                let gate = gate.clone();
                scope.spawn(move || {
                    gate.wait();
                    publish_catalog(&fixture.root, bytes)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let winner = results.iter().position(|result| result.is_ok()).unwrap();
    assert_eq!(
        load_catalog_release(&fixture.root, "race-v1").unwrap(),
        catalogs[winner]
    );
}

#[test]
fn malformed_or_modified_release_artifacts_fail_closed() {
    let fixture = Fixture::new();
    publish_media_file(&fixture.root, &fixture.source, &fixture.asset).unwrap();
    let catalog = fixture.catalog("guarded-v1");
    let receipt = publish_catalog(&fixture.root, &catalog).unwrap();
    let release_path = fixture.root.join("releases/guarded-v1.json");
    let original = fs::read(&release_path).unwrap();
    let value: Value = serde_json::from_slice(&original).unwrap();
    for (field, replacement) in [
        ("schema", json!("future-release")),
        ("version", json!("another-v1")),
        ("catalog_sha256", json!("../escape")),
        ("catalog_bytes", json!(9 * 1024 * 1024)),
        ("asset_count", json!(99)),
        ("asset_bytes", json!(0)),
    ] {
        let mut invalid = value.clone();
        invalid[field] = replacement;
        fs::write(&release_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(
            load_catalog_release(&fixture.root, "guarded-v1").is_err(),
            "{field}"
        );
    }
    fs::write(&release_path, &original).unwrap();
    let catalog_path = fixture
        .root
        .join("catalogs")
        .join(format!("{}.json", receipt.release.catalog_sha256));
    let mut modified = catalog.clone();
    modified.push(b' ');
    fs::write(catalog_path, &modified).unwrap();
    assert!(load_catalog_release(&fixture.root, "guarded-v1").is_err());
    assert!(load_catalog_release(&fixture.root, "../guarded-v1").is_err());
    assert!(load_catalog_release(&fixture.root, "missing-v1").is_err());
    assert_eq!(fs::read(&release_path).unwrap(), original);
}

#[test]
fn invalid_asset_declarations_and_non_file_inputs_are_rejected() {
    let fixture = Fixture::new();
    let mut invalid = fixture.asset.clone();
    invalid.sha256 = "../escape".into();
    assert!(publish_media_file(&fixture.root, &fixture.source, &invalid).is_err());
    assert!(publish_media_file(&fixture.root, fixture.directory.path(), &fixture.asset).is_err());
    assert!(
        publish_media_file(
            &fixture.root.join("missing"),
            &fixture.source,
            &fixture.asset
        )
        .is_err()
    );
}
