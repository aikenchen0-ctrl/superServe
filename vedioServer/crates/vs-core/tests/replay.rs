use vs_core::{
    catalog::{Candidate, PublicCatalog},
    profile::{ProfileEvent, ProfileEventKind},
    replay::{DataKind, Judgment, ReplayQuery, ReplayTrace, TimedEvent, ranking_metrics},
};

fn catalog() -> PublicCatalog {
    PublicCatalog {
        version: "test-v1".into(),
        assets: vec![],
        items: vec![Candidate {
            id: "item".into(),
            domain: "video".into(),
            tags: vec!["rust".into()],
            prior: 0.5,
            media_sha256: None,
        }],
    }
}

fn fixture() -> ReplayTrace {
    ReplayTrace {
        schema: "recommendation-replay-v1".into(),
        data_kind: DataKind::Synthetic,
        catalog_version: "test-v1".into(),
        catalog_as_of: 10,
        history_cutoff: 20,
        events: vec![TimedEvent {
            at: 15,
            event: ProfileEvent {
                event_id: "like-1".into(),
                subject: "a".into(),
                candidate_id: "item".into(),
                kind: ProfileEventKind::Like,
            },
        }],
        queries: vec![ReplayQuery {
            request_id: "query-1".into(),
            subject: "a".into(),
            at: 25,
            label_window_end: 30,
            domains: vec!["video".into()],
            limit: 3,
            labels: vec![Judgment {
                candidate_id: "item".into(),
                relevance: 3,
                observed_at: 26,
            }],
        }],
    }
}

#[test]
fn metrics_match_hand_computed_graded_ndcg_and_recall_denominator() {
    let labels = vec![
        Judgment {
            candidate_id: "a".into(),
            relevance: 3,
            observed_at: 10,
        },
        Judgment {
            candidate_id: "b".into(),
            relevance: 1,
            observed_at: 10,
        },
    ];
    let metrics = ranking_metrics(&["b", "unjudged", "a"], &labels, 3).unwrap();
    let expected = (1.0 + 7.0 / 2.0) / (7.0 + 1.0 / 3.0_f64.log2());
    assert!((metrics.ndcg_at_k.unwrap() - expected).abs() < 1e-12);
    assert_eq!(metrics.recall_at_k, Some(1.0));
    assert_eq!(metrics.mrr_at_k, Some(1.0));
    assert_eq!(metrics.judged_returned, 2);
    assert_eq!(
        ranking_metrics(&["a"], &labels, 1).unwrap().recall_at_k,
        Some(0.5)
    );
    assert_eq!(
        ranking_metrics(&["unjudged"], &labels, 1)
            .unwrap()
            .recall_at_k,
        Some(0.0)
    );
    assert_eq!(ranking_metrics(&[], &[], 3).unwrap().ndcg_at_k, None);
    assert!(ranking_metrics(&["a", "a"], &labels, 3).is_err());
}

#[test]
fn temporal_leakage_duplicates_and_unknown_candidates_are_rejected_before_replay() {
    let mut trace = fixture();
    trace.events[0].at = trace.history_cutoff;
    assert!(trace.prepare(&catalog()).is_err());
    trace.events[0].at = 15;
    trace.queries[0].labels[0].observed_at = trace.queries[0].at;
    assert!(trace.prepare(&catalog()).is_err());
    trace.queries[0].labels[0].observed_at = 31;
    assert!(trace.prepare(&catalog()).is_err());
    trace.queries[0].labels[0].observed_at = 26;
    trace.queries[0].labels[0].candidate_id = "missing".into();
    assert!(trace.prepare(&catalog()).is_err());
    let mut trace = fixture();
    trace.events.push(TimedEvent {
        at: 16,
        event: trace.events[0].event.clone(),
    });
    assert!(trace.prepare(&catalog()).is_err());
}

#[test]
fn labels_do_not_change_profiles_and_subjects_do_not_share_history() {
    let mut trace = fixture();
    let first = trace.prepare(&catalog()).unwrap();
    trace.queries[0].labels[0].relevance = 0;
    let altered = trace.prepare(&catalog()).unwrap();
    let before = first[0].request.profile.as_ref().unwrap();
    let after = altered[0].request.profile.as_ref().unwrap();
    assert_eq!(before.version, after.version);
    assert_eq!(before.interests[0].weight, after.interests[0].weight);
    trace.queries[0].subject = "other-user".into();
    assert!(
        trace.prepare(&catalog()).unwrap()[0]
            .request
            .profile
            .is_none()
    );
}

#[test]
fn hidden_positive_labels_are_reported_without_penalizing_policy_compliance() {
    let mut trace = fixture();
    trace.events.push(TimedEvent {
        at: 16,
        event: ProfileEvent {
            event_id: "hide-1".into(),
            subject: "a".into(),
            candidate_id: "item".into(),
            kind: ProfileEventKind::Hide,
        },
    });
    let queries = trace.prepare(&catalog()).unwrap();
    assert_eq!(queries[0].excluded_positive_labels, 1);
    assert!(queries[0].eligible_items.is_empty());
    assert!(queries[0].eligible_labels.is_empty());
    assert_eq!(
        ranking_metrics(&[], &queries[0].eligible_labels, 3)
            .unwrap()
            .recall_at_k,
        None
    );
}
