use super::*;
use vs_core::{
    catalog::Candidate,
    recommendation::{RankedItem, RecommendationRequest},
};

fn catalog(video: usize) -> PublicCatalog {
    let mut items: Vec<_> = (0..video)
        .map(|i| Candidate {
            id: format!("v{i:03}"),
            domain: "video".into(),
            tags: vec![],
            prior: 0.0,
            media_sha256: None,
        })
        .collect();
    for (id, domain) in [
        ("article", "article"),
        ("negative", "article"),
        ("unknown", "video"),
        ("service", "service"),
    ] {
        items.push(Candidate {
            id: id.into(),
            domain: domain.into(),
            tags: vec![],
            prior: 0.0,
            media_sha256: None,
        });
    }
    PublicCatalog {
        version: "domain-test".into(),
        items,
        assets: vec![],
    }
}
fn request() -> RecommendationRequest {
    RecommendationRequest {
        request_id: "request".into(),
        domains: vec!["video".into(), "article".into(), "service".into()],
        limit: 50,
        profile: None,
    }
}
fn config(domains: &[&str], drop: u16) -> DomainAuditConfig {
    DomainAuditConfig {
        required_domains: domains.iter().map(|domain| (*domain).into()).collect(),
        minimum_positive_labels: 1,
        maximum_positive_coverage_drop_basis_points: drop,
    }
}
fn label(id: &str, positive: bool) -> Judgment {
    Judgment {
        candidate_id: id.into(),
        relevance: u8::from(positive),
        observed_at: 2,
    }
}
fn response(catalog: &PublicCatalog, ids: &[String]) -> RecommendationResponse {
    RecommendationResponse {
        request_id: "request".into(),
        catalog_version: catalog.version.clone(),
        profile_version: None,
        ranker: "test",
        considered: catalog.items.len(),
        items: ids
            .iter()
            .map(|id| {
                let item = catalog.items.iter().find(|item| &item.id == id).unwrap();
                RankedItem {
                    id: id.clone(),
                    domain: item.domain.clone(),
                    affinity: 0.0,
                    rank_score: None,
                    media_path: None,
                }
            })
            .collect(),
    }
}

#[test]
fn micro_improvement_cannot_hide_article_regression_or_drop_zero_hit_domains() {
    let catalog = catalog(100);
    let request = request();
    let context = RequestContext::new(&request, 1).unwrap();
    let labels: Vec<_> = (0..100)
        .map(|i| label(&format!("v{i:03}"), true))
        .chain([label("article", true), label("negative", false)])
        .collect();
    let baseline_ids = (0..80)
        .map(|i| format!("v{i:03}"))
        .chain(["article".into(), "negative".into(), "unknown".into()])
        .collect::<Vec<_>>();
    let model_ids = (0..90)
        .map(|i| format!("v{i:03}"))
        .chain(["unknown".into()])
        .collect::<Vec<_>>();
    let mut audit = DomainAudit::new(&catalog, &config(&["video", "article"], 0)).unwrap();
    audit
        .observe(
            &context,
            &labels,
            &response(&catalog, &baseline_ids),
            &response(&catalog, &model_ids),
        )
        .unwrap();
    let report = audit.finish();
    println!(
        "domain micro-vs-macro regression fixture: {}",
        serde_json::to_string(&report).unwrap()
    );
    assert!(
        report.model_micro_observed_positive_coverage
            > report.baseline_micro_observed_positive_coverage
    );
    assert!(
        report.model_macro_observed_positive_coverage
            < report.baseline_macro_observed_positive_coverage
    );
    assert!(!report.gate_passed);
    let article = report
        .rows
        .iter()
        .find(|row| row.domain == "article")
        .unwrap();
    assert_eq!(article.model_observed_positive_coverage, Some(0.0));
    assert_eq!(article.baseline.explicit_negative_returned, 1);
    assert_eq!(article.reason, "positive_coverage_regressed");
    let service = report
        .rows
        .iter()
        .find(|row| row.domain == "service")
        .unwrap();
    assert_eq!(service.model_observed_positive_coverage, None);
    assert_eq!(service.requests_without_explicit_feedback, 1);
    assert_eq!(report.domains_with_positive_evidence, 2);
    assert_eq!(report.domains_without_positive_evidence, vec!["service"]);
    assert_eq!(
        report
            .rows
            .iter()
            .find(|row| row.domain == "video")
            .unwrap()
            .model
            .unjudged_returned,
        1
    );
    assert!(!report.production_gate_passed && !report.online_policy_changed);
    println!("{}", serde_json::to_string(&report).unwrap());
}

#[test]
fn zero_feedback_and_zero_returned_are_missing_evidence_not_negative_or_perfect() {
    let catalog = catalog(1);
    let request = request();
    let context = RequestContext::new(&request, 1).unwrap();
    let mut audit = DomainAudit::new(&catalog, &config(&["service"], 0)).unwrap();
    audit
        .observe(
            &context,
            &[],
            &response(&catalog, &[]),
            &response(&catalog, &["service".into()]),
        )
        .unwrap();
    let report = audit.finish();
    assert!(!report.gate_passed);
    assert_eq!(report.model_macro_observed_positive_coverage, None);
    assert_eq!(report.model_micro_observed_positive_coverage, None);
    let row = report
        .rows
        .iter()
        .find(|row| row.domain == "service")
        .unwrap();
    assert_eq!(row.reason, "insufficient_positive_evidence");
    assert_eq!(row.model.unjudged_returned, 1);
    assert_eq!(row.model.explicit_negative_returned, 0);
}

#[test]
fn coverage_drop_threshold_uses_exact_integer_boundary() {
    let catalog = catalog(3);
    let request = request();
    let context = RequestContext::new(&request, 1).unwrap();
    let labels = [
        label("v000", true),
        label("v001", true),
        label("v002", true),
    ];
    let baseline = response(&catalog, &["v000".into(), "v001".into()]);
    let model = response(&catalog, &["v000".into()]);
    for (drop, expected) in [(3333, false), (3334, true)] {
        let mut audit = DomainAudit::new(&catalog, &config(&["video"], drop)).unwrap();
        audit.observe(&context, &labels, &baseline, &model).unwrap();
        assert_eq!(audit.finish().gate_passed, expected);
    }
}

#[test]
fn minimum_evidence_and_never_requested_domain_cannot_pass() {
    let catalog = catalog(1);
    let mut request = request();
    request.domains = vec!["video".into()];
    let context = RequestContext::new(&request, 1).unwrap();
    let response = response(&catalog, &["v000".into()]);
    let mut required = config(&["video", "article"], 0);
    required.minimum_positive_labels = 2;
    let mut audit = DomainAudit::new(&catalog, &required).unwrap();
    audit
        .observe(&context, &[label("v000", true)], &response, &response)
        .unwrap();
    let report = audit.finish();
    assert!(!report.gate_passed);
    let video = report
        .rows
        .iter()
        .find(|row| row.domain == "video")
        .unwrap();
    assert_eq!(video.model_observed_positive_coverage, Some(1.0));
    assert_eq!(video.reason, "insufficient_positive_evidence");
    let article = report
        .rows
        .iter()
        .find(|row| row.domain == "article")
        .unwrap();
    assert_eq!(article.requests_in_scope, 0);
    assert_eq!(article.positive_coverage_gate_passed, Some(false));
}

#[test]
fn invalid_config_cannot_fabricate_missing_domains() {
    let catalog = catalog(1);
    for mut value in [
        config(&[], 0),
        config(&["video", "video"], 0),
        config(&["missing"], 0),
        config(&["video"], 10001),
    ] {
        assert!(DomainAudit::new(&catalog, &value).is_err());
        value.minimum_positive_labels = 0;
        assert!(value.validate().is_err());
    }
    let mut value = config(&["video"], 0);
    value.minimum_positive_labels = MAX_TRAINING_SAMPLES + 1;
    assert!(value.validate().is_err());
    let mut wire = serde_json::to_value(config(&["video"], 0)).unwrap();
    wire["extra"] = serde_json::json!(true);
    assert!(serde_json::from_value::<DomainAuditConfig>(wire).is_err());
}

#[test]
fn duplicate_unknown_or_out_of_domain_labels_and_returns_fail_closed() {
    let catalog = catalog(1);
    let mut request = request();
    request.domains = vec!["video".into()];
    let context = RequestContext::new(&request, 1).unwrap();
    for labels in [
        vec![label("v000", true), label("v000", false)],
        vec![label("missing", true)],
        vec![label("article", true)],
    ] {
        let mut audit = DomainAudit::new(&catalog, &config(&["video"], 0)).unwrap();
        assert!(
            audit
                .observe(
                    &context,
                    &labels,
                    &response(&catalog, &[]),
                    &response(&catalog, &[])
                )
                .is_err()
        );
    }
    let mut audit = DomainAudit::new(&catalog, &config(&["video"], 0)).unwrap();
    assert!(
        audit
            .observe(
                &context,
                &[],
                &response(&catalog, &[]),
                &response(&catalog, &["v000".into(), "v000".into()])
            )
            .is_err()
    );
}
