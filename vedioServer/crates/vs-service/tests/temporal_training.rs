#[path = "../../vs-core/tests/support/temporal_fixture.rs"]
mod temporal_fixture;

use sha2::{Digest, Sha256};
use vs_core::{
    learning::{LinearRankModel, PreferenceFeedback},
    training_split::temporal_split,
};
use vs_service::rank_model::{train_and_publish_rank_model, train_and_publish_temporal_rank_model};

fn inputs() -> (
    Vec<u8>,
    vs_core::learning::RankTrainingSet,
    vs_core::training_split::TemporalSplitConfig,
) {
    let (catalog, mut source, config) = temporal_fixture::fixture();
    let bytes = serde_json::to_vec(&catalog).unwrap();
    source.catalog_sha256 = format!("{:x}", Sha256::digest(&bytes));
    (bytes, source, config)
}

#[test]
fn published_model_only_uses_training_window_and_old_entry_keeps_its_wire_shape() {
    let (catalog, mut source, config) = inputs();
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("temporal-model.json");
    let input = serde_json::to_vec(&source).unwrap();
    let receipt =
        train_and_publish_temporal_rank_model(&catalog, &input, &config, &target).unwrap();
    assert_eq!(receipt.training_samples, 6);
    assert_eq!(receipt.trained_before, 100);
    let audit = receipt.temporal_split.unwrap();
    assert_eq!(
        (
            audit.retained.training,
            audit.retained.validation,
            audit.retained.test
        ),
        (6, 6, 6)
    );
    let model: LinearRankModel = serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
    assert_eq!(model.training_samples, 6);
    assert_eq!(model.positive_samples, 3);
    assert_eq!(model.domains, ["article", "service", "video"]);
    let fixed: vs_core::catalog::PublicCatalog = serde_json::from_slice(&catalog).unwrap();
    let split = temporal_split(&fixed, &source, &config).unwrap();
    let reference = vs_core::learning::train_rank_model(&fixed, &split.training).unwrap();
    assert_eq!(reference.weights, model.weights);
    for sample in &mut source.samples[6..] {
        sample.feedback = match sample.feedback {
            PreferenceFeedback::Like => PreferenceFeedback::Dislike,
            PreferenceFeedback::Dislike => PreferenceFeedback::Like,
        };
    }
    let changed = train_and_publish_temporal_rank_model(
        &catalog,
        &serde_json::to_vec(&source).unwrap(),
        &config,
        &directory.path().join("changed.json"),
    )
    .unwrap();
    assert_eq!(changed.sha256, receipt.sha256);
    let legacy =
        train_and_publish_rank_model(&catalog, &input, &directory.path().join("legacy.json"))
            .unwrap();
    assert_eq!(legacy.training_samples, 18);
    assert_eq!(legacy.trained_before, 300);
    assert!(
        serde_json::to_value(legacy)
            .unwrap()
            .get("temporal_split")
            .is_none()
    );
    if let Some(export) = std::env::var_os("VS_TEMPORAL_FIXTURE_EXPORT") {
        let path = std::path::PathBuf::from(export);
        assert!(
            path.is_absolute() && path.starts_with("O:/"),
            "实验夹具只写O盘明确目录"
        );
        std::fs::create_dir(&path).unwrap();
        for (name, bytes) in [
            ("catalog.json", catalog),
            ("training.json", input),
            ("split.json", serde_json::to_vec(&config).unwrap()),
        ] {
            std::fs::write(path.join(name), bytes).unwrap();
        }
    }
}

#[test]
fn invalid_sources_and_configs_never_publish_and_existing_models_are_not_overwritten() {
    let (catalog, mut source, mut config) = inputs();
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("model.json");
    let input = serde_json::to_vec(&source).unwrap();
    train_and_publish_temporal_rank_model(&catalog, &input, &config, &target).unwrap();
    let original = std::fs::read(&target).unwrap();
    assert!(train_and_publish_temporal_rank_model(&catalog, &input, &config, &target).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), original);
    source.samples[12].evidence_ref = source.samples[0].evidence_ref.clone();
    let rejected = directory.path().join("rejected.json");
    assert!(
        train_and_publish_temporal_rank_model(
            &catalog,
            &serde_json::to_vec(&source).unwrap(),
            &config,
            &rejected
        )
        .is_err()
    );
    assert!(!rejected.exists());
    config.validation_before = config.train_before;
    assert!(train_and_publish_temporal_rank_model(&catalog, &input, &config, &rejected).is_err());
    assert!(!rejected.exists());
    let mut wrong = catalog.clone();
    wrong.push(b' ');
    assert!(train_and_publish_temporal_rank_model(&wrong, &input, &config, &rejected).is_err());
    assert!(!rejected.exists());
}
