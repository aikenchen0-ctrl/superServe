use std::{fs, path::Path, sync::Arc};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use vs_service::{
    AppState, Role, backup_profile_log, handoff_profile_log, restore_profile_backup, router,
    verify_profile_backup,
};

const TOKEN: &str = "profile-backup-authority-token-000000000000";
const CATALOG: &[u8] = br#"{"version":"backup-v1","assets":[],"items":[
 {"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},
 {"id":"document","domain":"document","tags":["storage"],"prior":0.4,"media_sha256":null}
]}"#;

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn authority(path: &Path) -> AppState {
    let _ = rustls::crypto::ring::default_provider().install_default();
    AppState::new_with_profile_log(CATALOG, None, TOKEN, 2, 1, Some(path))
        .unwrap()
        .into_profile_authority()
        .unwrap()
}

async fn seed(path: &Path) {
    let state = Arc::new(authority(path));
    let app = router(state, Role::Profile);
    for (id, subject, candidate, kind) in [
        ("one", "alice", "video", "like"),
        ("two", "alice", "document", "hide"),
        ("three", "bob", "document", "like"),
        ("four", "alice", "document", "like"),
    ] {
        let response = app.clone().oneshot(Request::builder()
            .method("POST").uri("/internal/v1/profile/events")
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("x-catalog-sha256", hash(CATALOG))
            .header("content-type", "application/json")
            .body(Body::from(json!({"event_id":id,"subject":subject,"candidate_id":candidate,"kind":kind}).to_string()))
            .unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

fn rewrite_header(bytes: &[u8], action: impl FnOnce(&mut Value)) -> Vec<u8> {
    let size = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let mut header: Value = serde_json::from_slice(&bytes[12..12 + size]).unwrap();
    action(&mut header);
    let encoded = serde_json::to_vec(&header).unwrap();
    let mut output = bytes[..8].to_vec();
    output.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
    output.extend_from_slice(&encoded);
    output.extend_from_slice(&bytes[12 + size..]);
    output
}

#[tokio::test]
async fn backup_is_deterministic_and_restores_identical_but_fenced_log() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let original = fs::read(&source).unwrap();
    let first = dir.path().join("first.backup");
    let second = dir.path().join("second.backup");
    let receipt = backup_profile_log(&source, CATALOG, &first).unwrap();
    assert_eq!(receipt.checkpoint.records, 4);
    assert_eq!(receipt.subjects, 2);
    assert_eq!(receipt.checkpoint.sha256, hash(&original));
    assert!(!receipt.source_modified && !receipt.restored_writer_enabled);
    assert_eq!(receipt.archive_sha256, hash(&fs::read(&first).unwrap()));
    assert_eq!(receipt.archive_bytes, fs::metadata(&first).unwrap().len());
    let again = backup_profile_log(&source, CATALOG, &second).unwrap();
    assert_eq!(receipt.archive_sha256, again.archive_sha256);
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    assert_eq!(fs::read(&source).unwrap(), original);
    assert!(!source.with_file_name("events.sealed.json").exists());
    assert!(backup_profile_log(&source, CATALOG, &first).is_err());
    let scratch = tempfile::tempdir().unwrap();
    let verified =
        verify_profile_backup(&first, CATALOG, &receipt.archive_sha256, scratch.path()).unwrap();
    assert_eq!(verified.projection_sha256, receipt.projection_sha256);
    assert_eq!(fs::read_dir(scratch.path()).unwrap().count(), 0);
    let restored = dir.path().join("restored");
    let reserved = source.with_file_name("events.sealed.json");
    assert!(restore_profile_backup(&first, CATALOG, &receipt.archive_sha256, &reserved).is_err());
    assert!(!reserved.exists());
    assert!(!dir.path().join("events.sealed.json.sealed.json").exists());
    restore_profile_backup(&first, CATALOG, &receipt.archive_sha256, &restored).unwrap();
    assert_eq!(fs::read(&restored).unwrap(), original);
    assert!(restored.with_file_name("restored.sealed.json").exists());
    assert!(AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&restored)).is_err());
    assert!(restore_profile_backup(&first, CATALOG, &receipt.archive_sha256, &restored).is_err());
    let restored_backup = dir.path().join("restored.backup");
    let restored_receipt = backup_profile_log(&restored, CATALOG, &restored_backup).unwrap();
    assert_eq!(restored_receipt.archive_sha256, receipt.archive_sha256);
    // 源不被备份封存，仍可由原机制重启；恢复副本没有写权限。
    drop(authority(&source));
}

#[tokio::test]
async fn active_writer_missing_or_torn_source_is_not_modified_or_published() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let original = fs::read(&source).unwrap();
    let state = authority(&source);
    let output = dir.path().join("active.backup");
    assert!(backup_profile_log(&source, CATALOG, &output).is_err());
    assert!(!output.exists());
    drop(state);
    let missing = dir.path().join("missing-parent/events");
    assert!(backup_profile_log(&missing, CATALOG, &output).is_err());
    assert!(!missing.parent().unwrap().exists());
    let mut torn = original.clone();
    torn.extend_from_slice(b"{\"unfinished\":");
    fs::write(&source, &torn).unwrap();
    assert!(backup_profile_log(&source, CATALOG, &output).is_err());
    assert_eq!(fs::read(&source).unwrap(), torn);
    assert!(!output.exists());
    // 原常规启动仍可执行既有尾部修复，不受只读新增路径改变。
    drop(authority(&source));
    assert_eq!(fs::read(&source).unwrap(), original);
}

#[tokio::test]
async fn archive_digest_catalog_header_and_replay_tampering_never_publish_restore() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let backup = dir.path().join("backup");
    let receipt = backup_profile_log(&source, CATALOG, &backup).unwrap();
    let original = fs::read(&backup).unwrap();
    let restored = dir.path().join("restored");
    assert!(restore_profile_backup(&backup, CATALOG, &"0".repeat(64), &restored).is_err());
    let other = br#"{"version":"other","items":[],"assets":[]}"#;
    assert!(restore_profile_backup(&backup, other, &receipt.archive_sha256, &restored).is_err());
    let variants = [
        rewrite_header(&original, |header| {
            header["projection_sha256"] = json!("0".repeat(64))
        }),
        rewrite_header(&original, |header| header["subjects"] = json!(999)),
        rewrite_header(&original, |header| header["unexpected"] = json!(true)),
        rewrite_header(&original, |header| {
            header["checkpoint"]["records"] = json!(3)
        }),
        original[..original.len() - 1].to_vec(),
        {
            let mut extended = original.clone();
            extended.push(0);
            extended
        },
    ];
    for bytes in variants {
        let archive = dir.path().join("bad");
        fs::write(&archive, &bytes).unwrap();
        assert!(restore_profile_backup(&archive, CATALOG, &hash(&bytes), &restored).is_err());
        assert!(!restored.exists());
        assert!(!restored.with_file_name("restored.sealed.json").exists());
    }
}

#[tokio::test]
async fn semantically_invalid_event_even_with_recomputed_all_checksums_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let backup = dir.path().join("backup");
    backup_profile_log(&source, CATALOG, &backup).unwrap();
    let bytes = fs::read(&backup).unwrap();
    let size = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let payload = &bytes[12 + size..];
    let mut lines: Vec<Value> = payload
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    lines[1]["envelope"]["sequence"] = json!(99);
    let mut changed_payload = Vec::new();
    for line in lines {
        serde_json::to_writer(&mut changed_payload, &line).unwrap();
        changed_payload.push(b'\n');
    }
    let header_only = rewrite_header(&bytes, |header| {
        header["checkpoint"]["bytes"] = json!(changed_payload.len());
        header["checkpoint"]["sha256"] = json!(hash(&changed_payload));
    });
    let changed_size = u32::from_be_bytes(header_only[8..12].try_into().unwrap()) as usize;
    let mut changed = header_only[..12 + changed_size].to_vec();
    changed.extend_from_slice(&changed_payload);
    let invalid = dir.path().join("invalid");
    fs::write(&invalid, &changed).unwrap();
    let target = dir.path().join("restored");
    assert!(restore_profile_backup(&invalid, CATALOG, &hash(&changed), &target).is_err());
    assert!(!target.exists());
}

#[tokio::test]
async fn backup_after_original_handoff_and_marker_only_restore_are_safe() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let target = dir.path().join("active-target");
    handoff_profile_log(&source, &target, &hash(CATALOG)).unwrap();
    let backup = dir.path().join("sealed.backup");
    let receipt = backup_profile_log(&source, CATALOG, &backup).unwrap();
    let restored = dir.path().join("restore");
    let marker = restored.with_file_name("restore.sealed.json");
    fs::write(&marker, b"pre-existing-marker").unwrap();
    assert!(restore_profile_backup(&backup, CATALOG, &receipt.archive_sha256, &restored).is_err());
    assert_eq!(fs::read(&marker).unwrap(), b"pre-existing-marker");
    assert!(!restored.exists());
    // 只读备份不释放原交接fencing。
    assert!(AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&source)).is_err());
    drop(authority(&target));
}

#[tokio::test]
async fn backup_cannot_occupy_source_or_its_seal_reserved_path() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let bytes = fs::read(&source).unwrap();
    assert!(backup_profile_log(&source, CATALOG, &source).is_err());
    let marker = source.with_file_name("events.sealed.json");
    assert!(backup_profile_log(&source, CATALOG, &marker).is_err());
    #[cfg(windows)]
    assert!(backup_profile_log(&source, CATALOG, &dir.path().join("EVENTS.SEALED.JSON")).is_err());
    assert!(!marker.exists());
    assert!(
        backup_profile_log(
            &source,
            CATALOG,
            &dir.path().join("another-log.sealed.json")
        )
        .is_err()
    );
    assert!(!dir.path().join("another-log.sealed.json").exists());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    drop(authority(&source));
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_alias_reserved_marker_and_dangling_restore_target_are_rejected() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let alias = dir.path().join("alias");
    symlink(&source, &alias).unwrap();
    let alias_marker = dir.path().join("alias.sealed.json");
    assert!(backup_profile_log(&alias, CATALOG, &alias_marker).is_err());
    assert!(!alias_marker.exists());
    let backup = dir.path().join("backup");
    let receipt = backup_profile_log(&source, CATALOG, &backup).unwrap();
    let target = dir.path().join("dangling");
    symlink(dir.path().join("missing"), &target).unwrap();
    assert!(restore_profile_backup(&backup, CATALOG, &receipt.archive_sha256, &target).is_err());
    assert!(!dir.path().join("dangling.sealed.json").exists());
}

#[test]
fn empty_log_and_oversize_archive_remain_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let empty = dir.path().join("empty");
    fs::write(&empty, []).unwrap();
    let backup = dir.path().join("empty.backup");
    let receipt = backup_profile_log(&empty, CATALOG, &backup).unwrap();
    assert_eq!(receipt.subjects, 0);
    assert_eq!(receipt.checkpoint.records, 0);
    verify_profile_backup(&backup, CATALOG, &receipt.archive_sha256, dir.path()).unwrap();
    let oversized = dir.path().join("oversized");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(33 * 1024 * 1024)
        .unwrap();
    assert!(verify_profile_backup(&oversized, CATALOG, &"0".repeat(64), dir.path()).is_err());
    let mut bad_header = b"VSPRBK1\n".to_vec();
    bad_header.extend_from_slice(&u32::MAX.to_be_bytes());
    fs::write(&oversized, &bad_header).unwrap();
    assert!(verify_profile_backup(&oversized, CATALOG, &hash(&bad_header), dir.path()).is_err());
}

#[tokio::test]
#[ignore = "需设置VS_TEST_PROFILE_BACKUP指向已构建的独立备份CLI"]
async fn independent_cli_creates_verifies_restores_and_refuses_overwrite() {
    let binary = std::env::var("VS_TEST_PROFILE_BACKUP").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let catalog = dir.path().join("catalog.json");
    fs::write(&catalog, CATALOG).unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    let archive = dir.path().join("archive");
    let created = std::process::Command::new(&binary)
        .arg("create")
        .arg(&catalog)
        .arg(&source)
        .arg(&archive)
        .output()
        .unwrap();
    assert!(created.status.success());
    let receipt: Value = serde_json::from_slice(&created.stdout).unwrap();
    assert!(receipt.get("subjects_raw").is_none());
    assert_eq!(receipt["subjects"], 2);
    assert_eq!(receipt["checkpoint"]["records"], 4);
    for raw_subject in ["alice", "bob"] {
        assert!(!String::from_utf8_lossy(&created.stdout).contains(raw_subject));
    }
    let digest = receipt["archive_sha256"].as_str().unwrap();
    for (command, target) in [
        ("verify", dir.path().to_path_buf()),
        ("restore", dir.path().join("restored")),
    ] {
        let result = std::process::Command::new(&binary)
            .arg(command)
            .arg(&catalog)
            .arg(&archive)
            .arg(digest)
            .arg(target)
            .output()
            .unwrap();
        assert!(result.status.success());
    }
    let duplicate = std::process::Command::new(&binary)
        .arg("create")
        .arg(&catalog)
        .arg(&source)
        .arg(&archive)
        .output()
        .unwrap();
    assert!(!duplicate.status.success());
    assert!(duplicate.stdout.is_empty());
    let restored = dir.path().join("restored");
    assert_eq!(fs::read(&restored).unwrap(), fs::read(&source).unwrap());
    assert!(AppState::new_with_profile_log(CATALOG, None, TOKEN, 1, 1, Some(&restored)).is_err());
    let failed = std::process::Command::new(&binary)
        .arg("restore")
        .arg(&catalog)
        .arg(&archive)
        .arg("0".repeat(64))
        .arg(dir.path().join("bad"))
        .output()
        .unwrap();
    assert!(!failed.status.success());
    assert!(failed.stdout.is_empty());
    assert!(!dir.path().join("bad").exists());
    println!(
        "{}",
        json!({
            "schema":"profile-backup-cli-contract-v1","passed":true,
            "subjects":2,"records":4,"raw_bytes_equal":true,"restored_writer_enabled":false,
            "overwrite_refused":true,"invalid_digest_refused":true,
            "raw_subjects_in_receipt":false,"physical_cluster_or_power_loss_verified":false
        })
    );
}

#[tokio::test]
async fn restore_verified_copy_still_keeps_hidden_item_across_catalog_change() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    // 目录发生改变时仍用日志内冻结的facts，不能用新标签改写历史。
    let changed = String::from_utf8(CATALOG.to_vec())
        .unwrap()
        .replace("\"rust\"", "\"new-tag\"");
    let backup = dir.path().join("backup");
    let receipt = backup_profile_log(&source, changed.as_bytes(), &backup).unwrap();
    let restored = dir.path().join("restored");
    restore_profile_backup(
        &backup,
        changed.as_bytes(),
        &receipt.archive_sha256,
        &restored,
    )
    .unwrap();
    let again =
        backup_profile_log(&restored, changed.as_bytes(), &dir.path().join("again")).unwrap();
    assert_eq!(again.projection_sha256, receipt.projection_sha256);
    let original = backup_profile_log(&source, CATALOG, &dir.path().join("original")).unwrap();
    assert_eq!(original.projection_sha256, receipt.projection_sha256);
    assert_ne!(original.catalog_sha256, receipt.catalog_sha256);
    // 不因一次备份改变在线原画像的隐藏事实。
    let state = Arc::new(authority(&source));
    let app = router(state, Role::Profile);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/v1/profile/projection")
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("x-catalog-sha256", hash(CATALOG))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"subject":"alice","domains":["video","document"]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let projection: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        projection["profile"]["blocked_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "document")
    );
    assert!(
        projection["profile"]["interests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|interest| interest["tag"] == "rust")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn strict_read_only_backup_does_not_chmod_source() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("events");
    seed(&source).await;
    fs::set_permissions(&source, fs::Permissions::from_mode(0o440)).unwrap();
    backup_profile_log(&source, CATALOG, &dir.path().join("backup")).unwrap();
    assert_eq!(
        fs::metadata(&source).unwrap().permissions().mode() & 0o777,
        0o440
    );
}
