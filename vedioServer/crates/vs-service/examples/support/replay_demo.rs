use vs_core::{
    catalog::{Candidate, PublicCatalog},
    profile::{ProfileEvent, ProfileEventKind},
    replay::{DataKind, Judgment, ReplayQuery, ReplayTrace, TimedEvent},
};

fn candidate(id: String, domain: &str, tags: &[&str], prior: f32) -> Candidate {
    Candidate {
        id,
        domain: domain.into(),
        tags: tags.iter().map(|tag| (*tag).into()).collect(),
        prior,
        media_sha256: None,
    }
}

pub fn fixture() -> (Vec<u8>, ReplayTrace) {
    let mut items: Vec<_> = (0..200)
        .map(|index| {
            candidate(
                format!("mix-{index:03}"),
                "video",
                &["rust", "noise"],
                0.9 - index as f32 / 1000.0,
            )
        })
        .collect();
    items.extend(
        (0..20).map(|index| candidate(format!("article-{index:03}"), "article", &["general"], 0.5)),
    );
    items.extend(
        (0..10)
            .map(|index| candidate(format!("service-{index:03}"), "service", &["language"], 0.3)),
    );
    items.extend([
        candidate(
            "tail-video".into(),
            "video",
            &["rust", "other", "deep", "focus"],
            0.01,
        ),
        candidate("tail-article".into(), "article", &["rust"], 0.01),
        candidate("history-rust".into(), "video", &["rust"], 0.0),
        candidate("history-noise".into(), "video", &["noise"], 0.0),
    ]);
    let catalog = PublicCatalog {
        version: "replay-demo-v1".into(),
        items,
        assets: vec![],
    };
    let mut events = vec![TimedEvent {
        at: 101,
        event: ProfileEvent {
            event_id: "like-rust".into(),
            subject: "mixed".into(),
            candidate_id: "history-rust".into(),
            kind: ProfileEventKind::Like,
        },
    }];
    for index in 0..5 {
        events.push(TimedEvent {
            at: 102 + index,
            event: ProfileEvent {
                event_id: format!("skip-noise-{index}"),
                subject: "mixed".into(),
                candidate_id: "history-noise".into(),
                kind: ProfileEventKind::Skip,
            },
        });
    }
    for (subject, at) in [("positive", 110), ("hidden", 111)] {
        events.push(TimedEvent {
            at,
            event: ProfileEvent {
                event_id: format!("like-{subject}"),
                subject: subject.into(),
                candidate_id: "history-rust".into(),
                kind: ProfileEventKind::Like,
            },
        });
    }
    events.push(TimedEvent {
        at: 112,
        event: ProfileEvent {
            event_id: "hide-tail".into(),
            subject: "hidden".into(),
            candidate_id: "tail-video".into(),
            kind: ProfileEventKind::Hide,
        },
    });
    let query = |id: &str, subject: &str, domains: &[&str], labels: Vec<Judgment>| ReplayQuery {
        request_id: id.into(),
        subject: subject.into(),
        at: 200,
        label_window_end: 220,
        domains: domains.iter().map(|domain| (*domain).into()).collect(),
        limit: 10,
        labels,
    };
    let label = |id: &str, relevance| Judgment {
        candidate_id: id.into(),
        relevance,
        observed_at: 210,
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
                "mixed-video",
                "mixed",
                &["video"],
                vec![label("tail-video", 3), label("mix-199", 0)],
            ),
            query(
                "mixed-cross-domain",
                "mixed",
                &["video", "article"],
                vec![label("tail-video", 2), label("tail-article", 3)],
            ),
            query(
                "positive-video",
                "positive",
                &["video"],
                vec![label("mix-000", 1)],
            ),
            query(
                "cold-all",
                "cold",
                &["video", "article", "service"],
                vec![label("service-000", 1), label("article-000", 1)],
            ),
            query(
                "hidden-positive",
                "hidden",
                &["video"],
                vec![label("tail-video", 3), label("mix-000", 1)],
            ),
            query("no-labels", "cold", &["service"], vec![]),
            query("empty-domain", "cold", &["unknown"], vec![]),
        ],
    };
    (serde_json::to_vec_pretty(&catalog).unwrap(), trace)
}
