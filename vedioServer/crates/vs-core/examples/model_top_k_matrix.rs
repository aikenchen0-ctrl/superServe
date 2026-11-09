use std::{
    hint::black_box,
    io::{self, Write},
    time::Instant,
};

use serde::Serialize;
use serde_json::{Value, json};
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    model_top_k::recommend_model_top_k,
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RecommendationResponse,
        recommend_with_model,
    },
};

#[derive(Serialize)]
struct Sample {
    first: &'static str,
    full_ns: u64,
    topk_ns: u64,
    exact: bool,
}

fn fixture(
    size: usize,
    reverse: bool,
    case: usize,
    filter: usize,
    k: usize,
) -> (PublicCatalog, LearnedRanker, RecommendationRequest) {
    let mut catalog = PublicCatalog {
        version: "model-matrix-v1".into(),
        assets: vec![],
        items: (0..size)
            .map(|i| Candidate {
                id: format!("candidate-{i:05}"),
                domain: ["article", "service", "video"][i % 3].into(),
                tags: match i % 5 {
                    0 => vec![],
                    1 => vec!["positive".into()],
                    2 => vec!["negative".into()],
                    3 => vec!["denied".into()],
                    _ => (0..32).map(|t| format!("tag-{t}")).collect(),
                },
                prior: if case == 2 {
                    0.5
                } else {
                    (i % 251) as f32 / 250.0
                },
                media_sha256: None,
            })
            .collect(),
    };
    if reverse {
        catalog.items.reverse();
    }
    let mut weights = vec![0.0; 24];
    match case {
        0 => weights[1] = -5.0,
        1 => {
            weights[..6].copy_from_slice(&[0.1, 1.0, 2.0, -3.0, 0.5, -0.5]);
            weights[7] = -4.0;
            weights[13] = 3.0;
            weights[19] = -2.0;
        }
        2 => {}
        _ => {
            weights[0] = 100.0;
            weights[1] = f64::EPSILON;
        }
    }
    let model = LearnedRanker::new(
        &LinearRankModel {
            schema: "ftrl-ranker-v1".into(),
            feature_schema: "profile-candidate-6-v1".into(),
            objective: "explicit-preference-v1".into(),
            catalog_version: catalog.version.clone(),
            catalog_sha256: "a".repeat(64),
            trained_before: 1,
            training_samples: 2,
            positive_samples: 1,
            data_kind: TrainingDataKind::Synthetic,
            domains: vec!["article".into(), "service".into(), "video".into()],
            weights,
        },
        &catalog,
    )
    .unwrap();
    let request = RecommendationRequest {
        request_id: "matrix".into(),
        domains: if filter == 2 {
            vec!["absent".into()]
        } else {
            vec!["article".into(), "service".into(), "video".into()]
        },
        limit: k,
        profile: if filter != 1 {
            None
        } else {
            Some(ProfileProjection {
                subject: "synthetic".into(),
                version: "p1".into(),
                expires_at: 100,
                scopes: vec!["article".into(), "service".into(), "video".into()],
                interests: vec![
                    Interest {
                        tag: "positive".into(),
                        weight: 0.8,
                    },
                    Interest {
                        tag: "negative".into(),
                        weight: -0.6,
                    },
                ],
                blocked_ids: (0..8).map(|i| format!("candidate-{i:05}")).collect(),
                denied_tags: vec!["denied".into()],
            })
        },
    };
    (catalog, model, request)
}

fn same(a: &RecommendationResponse, b: &RecommendationResponse) -> bool {
    a.request_id == b.request_id
        && a.catalog_version == b.catalog_version
        && a.profile_version == b.profile_version
        && a.ranker == b.ranker
        && a.considered == b.considered
        && a.items.len() == b.items.len()
        && a.items.iter().zip(&b.items).all(|(a, b)| {
            a.id == b.id
                && a.domain == b.domain
                && a.media_path == b.media_path
                && a.affinity.to_bits() == b.affinity.to_bits()
                && a.rank_score.map(f64::to_bits) == b.rank_score.map(f64::to_bits)
        })
}

fn percentiles(samples: &[Sample], value: impl Fn(&Sample) -> u64) -> Value {
    let mut values: Vec<_> = samples.iter().map(value).collect();
    values.sort_unstable();
    let at = |p: usize| values[(p * values.len()).div_ceil(100) - 1];
    json!({"p50_ns":at(50), "p95_ns":at(95), "p99_ns":at(99), "max_ns":values.last()})
}

fn run() -> Result<Value, String> {
    if cfg!(debug_assertions) {
        return Err("成本矩阵必须使用 release 构建".into());
    }
    let samples = 32;
    let warmup = 4;
    let mut cells = Vec::new();
    let mut exact_all = true;
    for size in [32, 512, 10_000] {
        for reverse in [false, true] {
            for case in 0..4 {
                for filter in 0..3 {
                    for k in [1, 10, 50] {
                        let (catalog, model, request) = fixture(size, reverse, case, filter, k);
                        let probe = recommend_model_top_k(&catalog, &request, 50, &model)
                            .map_err(|_| "精确选择失败")?;
                        let mut measurements = Vec::new();
                        for index in 0..(warmup + samples) {
                            let full_first = matches!(index % 4, 0 | 3);
                            let full = || {
                                let start = Instant::now();
                                let result = recommend_with_model(
                                    black_box(&catalog),
                                    black_box(&request),
                                    50,
                                    Some(black_box(&model)),
                                )
                                .unwrap();
                                black_box(&result);
                                (result, start.elapsed().as_nanos() as u64)
                            };
                            let topk = || {
                                let start = Instant::now();
                                let result = recommend_model_top_k(
                                    black_box(&catalog),
                                    black_box(&request),
                                    50,
                                    black_box(&model),
                                )
                                .unwrap();
                                black_box(&result);
                                (result.response, start.elapsed().as_nanos() as u64)
                            };
                            let ((a, full_ns), (b, topk_ns)) = if full_first {
                                (full(), topk())
                            } else {
                                let b = topk();
                                (full(), b)
                            };
                            let exact = same(&a, &b);
                            exact_all &= exact;
                            if index >= warmup {
                                measurements.push(Sample {
                                    first: if full_first { "full" } else { "topk" },
                                    full_ns,
                                    topk_ns,
                                    exact,
                                });
                            }
                        }
                        cells.push(json!({
                            "size":size, "reverse":reverse, "model_case":case,
                            "filter":(["none","mixed","all"][filter]), "k":k,
                            "full":percentiles(&measurements, |s| s.full_ns),
                            "topk":percentiles(&measurements, |s| s.topk_ns),
                            "work":probe.work,
                            // 这是全排序候选槽的最低需求，不是实测分配容量或进程内存。
                            "full_scored_entries_min_bytes":probe.response.considered
                                * std::mem::size_of::<(&Candidate, f32, f64)>(),
                            "measurements":measurements,
                        }));
                    }
                }
            }
        }
    }
    Ok(json!({
        "schema":"model-topk-matrix-v1", "build":"release", "data_kind":"synthetic",
        "samples_per_cell":samples, "warmup_pairs":warmup, "cells":cells,
        "quality_gate":{"passed":exact_all, "comparison":"all-response-fields-and-float-bits"},
        "scope":{"full_candidate_scoring":true, "rss_measured":false,
            "real_user_quality_measured":false, "automatic_backend_threshold":false}
    }))
}

fn main() {
    match run() {
        Ok(report) => {
            let passed = report["quality_gate"]["passed"] == true;
            if serde_json::to_writer(io::stdout().lock(), &report).is_err() {
                eprintln!("无法写出成本矩阵");
                std::process::exit(1);
            }
            let _ = io::stdout().flush();
            if !passed {
                std::process::exit(2);
            }
        }
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}
