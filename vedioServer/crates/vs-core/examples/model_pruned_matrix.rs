use std::{
    hint::black_box,
    io::{self, BufRead, Write},
    sync::Arc,
    time::Instant,
};

use serde::Serialize;
use serde_json::{Value, json};
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    grouped_recall::GroupedRecall,
    learning::{LearnedRanker, LinearRankModel, TrainingDataKind},
    model_top_k::recommend_model_top_k,
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RecommendationResponse,
        recommend_with_model,
    },
};

const BACKENDS: [&str; 4] = ["full", "topk", "pruned", "blockmax"];

#[derive(Serialize)]
struct Sample {
    order: [usize; 4],
    full_ns: u64,
    topk_ns: u64,
    pruned_ns: u64,
    blockmax_ns: u64,
    exact: bool,
}

fn fixture(
    size: usize,
    groups: usize,
    case: usize,
    hidden: bool,
    reverse: bool,
    k: usize,
) -> (Arc<PublicCatalog>, LearnedRanker, RecommendationRequest) {
    let mut catalog = PublicCatalog {
        version: "pruned-matrix-v1".into(),
        assets: vec![],
        items: (0..size)
            .map(|i| {
                let group = i % groups;
                let mut tags = vec![format!("group-{group:05}")];
                if group.is_multiple_of(2) {
                    tags.push(if group == 0 {
                        "liked".into()
                    } else {
                        "disliked".into()
                    });
                    tags.extend((0..30).map(|n| format!("padding-{n}")));
                }
                Candidate {
                    id: format!("item-{i:05}"),
                    domain: ["article", "service", "video"][group % 3].into(),
                    tags,
                    prior: (i % 251) as f32 / 250.0,
                    media_sha256: None,
                }
            })
            .collect(),
    };
    if reverse {
        catalog.items.reverse();
    }
    let domains: Vec<_> = catalog
        .items
        .iter()
        .map(|item| item.domain.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut weights = vec![0.0; (domains.len() + 1) * 6];
    match case {
        0 => weights[1] = -5.0,
        1 => {
            weights[2] = 8.0;
            weights[3] = 2.0;
        }
        2 => {}
        _ => {
            weights[..6].copy_from_slice(&[0.5, 2.0, -4.0, 3.0, 0.1, -0.2]);
            for (i, _) in domains.iter().enumerate() {
                weights[7 + i * 6] = if i.is_multiple_of(2) { -4.0 } else { 3.0 };
            }
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
            domains,
            weights,
        },
        &catalog,
    )
    .unwrap();
    let request = RecommendationRequest {
        request_id: "pruned-matrix".into(),
        domains: vec!["article".into(), "service".into(), "video".into()],
        limit: k,
        profile: Some(ProfileProjection {
            subject: "synthetic".into(),
            version: "p1".into(),
            expires_at: 100,
            scopes: vec!["article".into(), "service".into(), "video".into()],
            interests: vec![
                Interest {
                    tag: "liked".into(),
                    weight: 1.0,
                },
                Interest {
                    tag: "disliked".into(),
                    weight: -0.8,
                },
                Interest {
                    tag: "group-00000".into(),
                    weight: 1.0,
                },
            ],
            blocked_ids: if hidden {
                (0..size.min(64)).map(|i| format!("item-{i:05}")).collect()
            } else {
                vec![]
            },
            denied_tags: if hidden {
                vec!["group-00002".into()]
            } else {
                vec![]
            },
        }),
    };
    (Arc::new(catalog), model, request)
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

fn percentiles(values: impl Iterator<Item = u64>) -> Value {
    let mut values: Vec<_> = values.collect();
    values.sort_unstable();
    let at = |p: usize| values[(p * values.len()).div_ceil(100) - 1];
    json!({"p50_ns":at(50), "p95_ns":at(95), "p99_ns":at(99), "max_ns":values.last()})
}

fn recommend(
    backend: usize,
    catalog: &PublicCatalog,
    model: &LearnedRanker,
    request: &RecommendationRequest,
    index: Option<&GroupedRecall>,
) -> RecommendationResponse {
    match backend {
        0 => recommend_with_model(catalog, request, 50, Some(model)).unwrap(),
        1 => {
            recommend_model_top_k(catalog, request, 50, model)
                .unwrap()
                .response
        }
        2 => {
            index
                .expect("分组索引已构建")
                .recommend_with_model(request, 50, model)
                .unwrap()
                .response
        }
        _ => {
            index
                .expect("分组索引已构建")
                .recommend_with_model_blockmax(request, 50, model)
                .unwrap()
                .response
        }
    }
}

fn matrix() -> Value {
    let mut cells = Vec::new();
    let mut exact_all = true;
    let mut orders = Vec::new();
    for a in 0..4 {
        for b in 0..4 {
            for c in 0..4 {
                for d in 0..4 {
                    if a != b && a != c && a != d && b != c && b != d && c != d {
                        orders.push([a, b, c, d]);
                    }
                }
            }
        }
    }
    let warmup = 24;
    let samples = 24;
    for size in [64, 1024, 10_000] {
        for groups in [1, 12, size] {
            for case in 0..4 {
                for hidden in [false, true] {
                    for reverse in [false, true] {
                        for k in [1, 10, 50] {
                            let (catalog, model, request) =
                                fixture(size, groups, case, hidden, reverse, k);
                            let start = Instant::now();
                            let index = GroupedRecall::new(catalog.clone()).unwrap();
                            let index_build_ns = start.elapsed().as_nanos() as u64;
                            let probe = index.recommend_with_model(&request, 50, &model).unwrap();
                            let blocks = index
                                .recommend_with_model_blockmax(&request, 50, &model)
                                .unwrap();
                            let mut measurements = Vec::new();
                            for iteration in 0..(warmup + samples) {
                                let order = orders[iteration % orders.len()];
                                let mut responses = [None, None, None, None];
                                let mut timings = [0; 4];
                                for backend in order {
                                    let start = Instant::now();
                                    let result = recommend(
                                        backend,
                                        black_box(&catalog),
                                        black_box(&model),
                                        black_box(&request),
                                        Some(black_box(&index)),
                                    );
                                    black_box(&result);
                                    timings[backend] = start.elapsed().as_nanos() as u64;
                                    responses[backend] = Some(result);
                                }
                                let full = responses[0].as_ref().unwrap();
                                let exact = same(full, responses[1].as_ref().unwrap())
                                    && same(full, responses[2].as_ref().unwrap())
                                    && same(full, responses[3].as_ref().unwrap());
                                exact_all &= exact;
                                if iteration >= warmup {
                                    measurements.push(Sample {
                                        order,
                                        full_ns: timings[0],
                                        topk_ns: timings[1],
                                        pruned_ns: timings[2],
                                        blockmax_ns: timings[3],
                                        exact,
                                    });
                                }
                            }
                            cells.push(json!({
                                "size":size, "requested_groups":groups, "model_case":case,
                                "hidden":hidden, "reverse":reverse, "k":k,
                                "index_build_ns":index_build_ns, "index":index.allocation_layout(),
                                "work":probe.work,
                                "blockmax_work":blocks.work,
                                "full":percentiles(measurements.iter().map(|s| s.full_ns)),
                                "topk":percentiles(measurements.iter().map(|s| s.topk_ns)),
                                "pruned":percentiles(measurements.iter().map(|s| s.pruned_ns)),
                                "blockmax":percentiles(measurements.iter().map(|s| s.blockmax_ns)),
                                "measurements":measurements,
                            }));
                        }
                    }
                }
            }
        }
    }
    json!({
        "schema":"model-blockmax-matrix-v1", "build":"release", "data_kind":"synthetic",
        "samples_per_cell":samples, "warmup_quadruples_per_cell":warmup,
        "backends":BACKENDS, "cells":cells,
        "quality_gate":{"passed":exact_all, "comparison":"all-response-fields-and-float-bits"},
        "scope":{"index_build_in_request_timing":false, "index_build_separately_recorded":true,
            "rss_measured_by_this_matrix":false, "real_user_quality_measured":false,
            "automatic_backend_threshold":false}
    })
}

fn phase(name: &str, details: Value) -> Result<(), String> {
    println!(
        "{}",
        json!({"schema":"model-pruned-memory-v1",
        "phase":name, "pid":std::process::id(), "details":details})
    );
    io::stdout().flush().map_err(|_| "无法刷新内存阶段")?;
    let mut input = String::new();
    if io::stdin()
        .lock()
        .read_line(&mut input)
        .map_err(|_| "无法读取阶段确认")?
        == 0
    {
        return Err("内存阶段确认提前结束".into());
    }
    Ok(())
}

fn run() -> Result<Value, String> {
    if cfg!(debug_assertions) {
        return Err("矩阵和内存探针必须使用release构建".into());
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return Ok(matrix());
    }
    if args.len() != 4 || args[0] != "--memory-probe" {
        return Err(
            "参数应为空，或 --memory-probe <候选数> <组数> <full|topk|pruned|blockmax>".into(),
        );
    }
    let size: usize = args[1].parse().map_err(|_| "候选数无效")?;
    let groups: usize = args[2].parse().map_err(|_| "组数无效")?;
    let backend = BACKENDS
        .iter()
        .position(|value| *value == args[3])
        .ok_or("后端无效")?;
    if !(3..=10_000).contains(&size) || !(1..=size).contains(&groups) {
        return Err("候选数或组数超限".into());
    }
    phase("ready", json!({}))?;
    let (catalog, model, request) = fixture(size, groups, 1, false, false, 10);
    phase(
        "loaded",
        json!({"items":catalog.items.len(), "backend":BACKENDS[backend]}),
    )?;
    let mut index = if backend >= 2 {
        Some(GroupedRecall::new(catalog.clone()).map_err(|_| "索引构建失败")?)
    } else {
        None
    };
    phase(
        "indexed",
        json!({"index":index.as_ref().map(GroupedRecall::allocation_layout)}),
    )?;
    let mut response = None;
    for _ in 0..64 {
        response = Some(recommend(
            backend,
            &catalog,
            &model,
            &request,
            index.as_ref(),
        ));
        black_box(&response);
    }
    phase(
        "queried",
        json!({"returned":response.as_ref().unwrap().items.len()}),
    )?;
    drop(index.take());
    phase("index_dropped", json!({}))?;
    Ok(json!({"schema":"model-pruned-memory-end-v1", "passed":true}))
}

fn main() {
    match run() {
        Ok(report) => {
            let passed = report
                .get("quality_gate")
                .is_none_or(|gate| gate["passed"] == true);
            if serde_json::to_writer(io::stdout().lock(), &report).is_err() {
                eprintln!("无法写出实验结果");
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
