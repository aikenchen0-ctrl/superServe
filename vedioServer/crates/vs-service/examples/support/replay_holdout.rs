use vs_core::{
    catalog::{Candidate, PublicCatalog},
    profile::{ProfileEvent, ProfileEventKind},
    replay::{DataKind, Judgment, ReplayQuery, ReplayTrace, TimedEvent},
};

fn item(id: String, domain: &str, tags: &[&str], prior: f32) -> Candidate {
    Candidate {
        id,
        domain: domain.into(),
        tags: tags.iter().map(|tag| (*tag).into()).collect(),
        prior,
        media_sha256: None,
    }
}

// 机制校验集与旧诊断集分开构造；它不是来自真实流量的统计留出集。
pub fn fixture() -> (Vec<u8>, ReplayTrace) {
    let mut items = Vec::new();
    for index in 0..256 {
        items.push(item(
            format!("nature-mix-{index:03}"),
            "article",
            &["nature", "promotion"],
            0.9 - index as f32 / 10_000.0,
        ));
        items.push(item(
            format!("sales-{index:03}"),
            "service",
            &["sales"],
            0.9 - index as f32 / 10_000.0,
        ));
        items.push(item(
            format!("craft-tie-{index:03}"),
            "product",
            &["craft"],
            0.1,
        ));
    }
    for index in 0..80 {
        items.push(item(
            format!("product-prior-{index:03}"),
            "product",
            &["general"],
            0.9,
        ));
    }
    for index in 0..10 {
        items.push(item(
            format!("z-craft-target-{index:02}"),
            "product",
            &["craft"],
            0.5 + index as f32 / 100.0,
        ));
    }
    items.extend([
        item(
            "nature-target".into(),
            "article",
            &["nature", "learning", "quiet"],
            0.01,
        ),
        item("neutral-service".into(), "service", &["research"], 0.01),
        item("nature-history".into(), "history", &["nature"], 0.0),
        item("promo-history".into(), "history", &["promotion"], 0.0),
        item("sales-history".into(), "history", &["sales"], 0.0),
        item("craft-history".into(), "history", &["craft"], 0.0),
    ]);
    let catalog = PublicCatalog {
        version: "replay-holdout-v1".into(),
        items,
        assets: vec![],
    };
    let mut events = vec![TimedEvent {
        at: 101,
        event: ProfileEvent {
            event_id: "nature-like".into(),
            subject: "nature-reader".into(),
            candidate_id: "nature-history".into(),
            kind: ProfileEventKind::Like,
        },
    }];
    for index in 0..5 {
        events.push(TimedEvent {
            at: 102 + index,
            event: ProfileEvent {
                event_id: format!("promotion-skip-{index}"),
                subject: "nature-reader".into(),
                candidate_id: "promo-history".into(),
                kind: ProfileEventKind::Skip,
            },
        });
    }
    for (at, subject, candidate_id, kind) in [
        (
            110,
            "negative-only",
            "sales-history",
            ProfileEventKind::Skip,
        ),
        (111, "craft-buyer", "craft-history", ProfileEventKind::Like),
    ] {
        events.push(TimedEvent {
            at,
            event: ProfileEvent {
                event_id: format!("history-{subject}"),
                subject: subject.into(),
                candidate_id: candidate_id.into(),
                kind,
            },
        });
    }
    let query = |id: &str, subject: &str, domain: &str, targets: Vec<String>| ReplayQuery {
        request_id: id.into(),
        subject: subject.into(),
        at: 200,
        label_window_end: 220,
        domains: vec![domain.into()],
        limit: 10,
        labels: targets
            .into_iter()
            .map(|candidate_id| Judgment {
                candidate_id,
                relevance: 3,
                observed_at: 210,
            })
            .collect(),
    };
    let trace = ReplayTrace {
        schema: "recommendation-replay-v1".into(),
        data_kind: DataKind::Synthetic,
        catalog_version: catalog.version.clone(),
        catalog_as_of: 100,
        history_cutoff: 150,
        events,
        queries: vec![
            query(
                "holdout-mixed",
                "nature-reader",
                "article",
                vec!["nature-target".into()],
            ),
            query(
                "holdout-negative-only",
                "negative-only",
                "service",
                vec!["neutral-service".into()],
            ),
            query(
                "holdout-score-ties",
                "craft-buyer",
                "product",
                (0..10)
                    .map(|index| format!("z-craft-target-{index:02}"))
                    .collect(),
            ),
        ],
    };
    (serde_json::to_vec_pretty(&catalog).unwrap(), trace)
}
