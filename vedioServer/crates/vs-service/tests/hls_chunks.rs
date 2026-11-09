use std::fs;

use sheathe_mp4::{Mp4Demuxer, top_level};
use vs_service::{
    hls::{HlsLayout, publish_hls, publish_hls_with_layout},
    publication::load_catalog_release,
};

const INPUT: &[u8] = include_bytes!("fixtures/mp4/h264-aac-tail.mp4");

#[test]
fn chunks_preserve_every_coded_sample_timestamp_and_flag_without_changing_playlist_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("input.mp4");
    fs::write(&source, INPUT).unwrap();
    let baseline = directory.path().join("single");
    fs::create_dir(&baseline).unwrap();
    let old = publish_hls(&baseline, &source, "single-v1", "clip", 1).unwrap();
    let original = Mp4Demuxer::parse(INPUT).unwrap();
    for target_ms in [100, 250, 500, 1000] {
        let root = directory.path().join(format!("chunk-{target_ms}"));
        fs::create_dir(&root).unwrap();
        let layout = HlsLayout::Chunked { target_ms };
        let publication =
            publish_hls_with_layout(&root, &source, "chunk-v1", "clip", 1, layout).unwrap();
        assert_eq!(publication.layout, layout);
        for (index, (track, old_track)) in publication.tracks.iter().zip(&old.tracks).enumerate() {
            assert_eq!(track.segments.len(), old_track.segments.len());
            assert_eq!(track.init_sha256, old_track.init_sha256);
            assert_eq!(track.coded_samples_sha256, old_track.coded_samples_sha256);
            let mut bytes = fs::read(root.join("media").join(&track.init_sha256)).unwrap();
            let mut next_sequence = 1;
            for (segment, old_segment) in track.segments.iter().zip(&old_track.segments) {
                assert_eq!(segment.start_ticks, old_segment.start_ticks);
                assert_eq!(segment.duration_ticks, old_segment.duration_ticks);
                let body = fs::read(root.join("media").join(&segment.sha256)).unwrap();
                let boxes = top_level(&body).collect::<Result<Vec<_>, _>>().unwrap();
                assert_eq!(
                    boxes.iter().filter(|value| &value.kind == b"styp").count(),
                    1
                );
                assert!(!boxes.iter().any(|value| &value.kind == b"sidx"));
                assert_eq!(
                    boxes.iter().filter(|value| &value.kind == b"moof").count(),
                    segment.chunk_count
                );
                assert_eq!(
                    boxes.iter().filter(|value| &value.kind == b"mdat").count(),
                    segment.chunk_count
                );
                for moof in boxes.iter().filter(|value| &value.kind == b"moof") {
                    let mfhd = moof.child(b"mfhd").unwrap().unwrap();
                    assert_eq!(
                        u32::from_be_bytes(mfhd.body[4..8].try_into().unwrap()),
                        next_sequence
                    );
                    next_sequence += 1;
                }
                bytes.extend_from_slice(&body);
            }
            let decoded = Mp4Demuxer::parse(&bytes).unwrap();
            let restored = decoded.samples(0).unwrap();
            let expected = original.samples(index).unwrap();
            assert_eq!(restored.len(), expected.len());
            for (actual, expected) in restored.iter().zip(&expected) {
                assert_eq!(actual.dts, expected.dts);
                assert_eq!(actual.pts, expected.pts);
                assert_eq!(actual.duration, expected.duration);
                assert_eq!(actual.flags, expected.flags);
                assert_eq!(actual.data, expected.data);
            }
        }
        let retry = publish_hls_with_layout(&root, &source, "chunk-v1", "clip", 1, layout).unwrap();
        assert_eq!(retry.master_sha256, publication.master_sha256);
        assert!(!retry.catalog.release_created);
    }
}

#[test]
fn default_bytes_stay_identical_and_invalid_layout_or_release_rebinding_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("input.mp4");
    fs::write(&source, INPUT).unwrap();
    for invalid in [0, 99, 1001, u16::MAX] {
        let root = directory.path().join(format!("invalid-{invalid}"));
        fs::create_dir(&root).unwrap();
        assert!(
            publish_hls_with_layout(
                &root,
                &source,
                "invalid",
                "clip",
                1,
                HlsLayout::Chunked { target_ms: invalid }
            )
            .is_err()
        );
        assert!(!root.join("media").exists());
        assert!(!root.join("releases").exists());
    }
    let root = directory.path().join("pinned");
    fs::create_dir(&root).unwrap();
    let legacy = publish_hls(&root, &source, "pinned", "clip", 1).unwrap();
    let explicit =
        publish_hls_with_layout(&root, &source, "pinned", "clip", 1, HlsLayout::Single).unwrap();
    assert_eq!(legacy.master_sha256, explicit.master_sha256);
    assert!(
        legacy
            .tracks
            .iter()
            .flat_map(|track| &track.segments)
            .all(|segment| segment.chunk_count == 1)
    );
    let original = load_catalog_release(&root, "pinned").unwrap();
    assert!(
        publish_hls_with_layout(
            &root,
            &source,
            "pinned",
            "clip",
            1,
            HlsLayout::Chunked { target_ms: 250 }
        )
        .is_err()
    );
    assert_eq!(load_catalog_release(&root, "pinned").unwrap(), original);
}
