use std::{collections::BTreeMap, env, io, path::Path, time::Instant};

use serde_json::json;
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::{Candidate, PublicCatalog},
    learning::{
        LearnedRanker, LinearRankModel, PreferenceFeedback, RankTrainingSet, TrainingDataKind,
        TrainingSample, train_rank_model,
    },
    recommendation::{
        Interest, ProfileProjection, RecommendationRequest, RequestContext,
        recommend_subset_with_model,
    },
    replay::{Judgment, ranking_metrics},
};
use vs_service::rank_model::train_and_publish_rank_model;

const DOMAINS: [&str; 3] = ["video", "article", "service"];
const NOW: u64 = 100_100;
const CUTOFF: u64 = 100_000;

fn preferences(person: usize, heldout: bool) -> Vec<Interest> {
    let namespace = if heldout { "test" } else { "train" };
    let mut weights = [
        0.2 + (person % 9) as f32 * 0.1,
        -0.2 - (person % 7) as f32 * 0.1,
        0.3,
        -0.9,
    ];
    weights.rotate_left(person % 4);
    weights
        .into_iter()
        .enumerate()
        .map(|(index, weight)| Interest {
            tag: format!("{namespace}-{index}"),
            weight,
        })
        .collect()
}

fn request(person: usize, domain: &str, heldout: bool) -> RecommendationRequest {
    RecommendationRequest {
        request_id: format!(
            "{}-{domain}-{person}",
            if heldout { "holdout" } else { "train" }
        ),
        domains: vec![domain.into()],
        limit: 5,
        profile: Some(ProfileProjection {
            subject: format!("{}-{person}", if heldout { "holdout" } else { "train" }),
            version: "frozen-v1".into(),
            scopes: vec![domain.into()],
            expires_at: NOW + 60,
            interests: preferences(person, heldout),
            blocked_ids: vec![],
            denied_tags: vec![],
        }),
    }
}

fn catalog() -> PublicCatalog {
    let mut items = Vec::new();
    for domain in DOMAINS {
        for heldout in [false, true] {
            for index in 0..32 {
                let namespace = if heldout { "test" } else { "train" };
                let tags: &[usize] = match index % 8 {
                    0 => &[0],
                    1 => &[1],
                    2 => &[0, 1],
                    3 => &[0, 2],
                    4 => &[2],
                    5 => &[0, 3],
                    6 => &[],
                    _ => &[1, 2, 3],
                };
                items.push(Candidate {
                    id: format!("{namespace}-{domain}-{index}"),
                    domain: domain.into(),
                    tags: tags
                        .iter()
                        .map(|tag| format!("{namespace}-{tag}"))
                        .collect(),
                    prior: if heldout {
                        0.05 + ((index * 11 + 3) % 19) as f32 / 20.0
                    } else {
                        0.1 + (index / 8) as f32 * 0.25
                    },
                    media_sha256: None,
                });
            }
        }
    }
    PublicCatalog {
        version: "rank-learning-replay-v1".into(),
        items,
        assets: vec![],
    }
}

// 预先固定的合成偏好机制；没有从训练后的排名反推标签或调整参数。
fn relevant(context: &RequestContext<'_>, candidate: &Candidate) -> bool {
    let mut positive = 0.0_f64;
    let mut negative = 0.0_f64;
    for tag in &candidate.tags {
        let weight = f64::from(
            context
                .interests()
                .get(tag.as_str())
                .copied()
                .unwrap_or(0.0),
        );
        positive += weight.max(0.0);
        negative += weight.min(0.0);
    }
    let count = candidate.tags.len().max(1) as f64;
    let (pos, neg, prior) = match candidate.domain.as_str() {
        "video" => (2.0, 6.0, 0.1),
        "article" => (3.0, 4.0, 0.4),
        _ => (0.75, 2.0, 1.5),
    };
    pos * positive / count + neg * negative / count + prior * (f64::from(candidate.prior) - 0.5)
        > 0.3
}

fn training(catalog: &PublicCatalog, catalog_sha256: String) -> RankTrainingSet {
    let mut samples = Vec::new();
    for person in 0..96 {
        for domain in DOMAINS {
            let request = request(person, domain, false);
            let context = RequestContext::new(&request, 2).unwrap();
            for item in catalog
                .items
                .iter()
                .filter(|item| item.id.starts_with("train-") && item.domain == domain)
            {
                let index = samples.len();
                samples.push(TrainingSample {
                    exposure_id: format!("exposure-{index}"),
                    evidence_ref: format!("synthetic-feedback-{index}"),
                    profile_as_of: 1,
                    exposed_at: 2 + index as u64 * 2,
                    feedback_at: 3 + index as u64 * 2,
                    chronology: None,
                    request: request.clone(),
                    candidate_id: item.id.clone(),
                    feedback: if relevant(&context, item) {
                        PreferenceFeedback::Like
                    } else {
                        PreferenceFeedback::Dislike
                    },
                });
            }
        }
    }
    RankTrainingSet {
        schema: "rank-training-v1".into(),
        data_kind: TrainingDataKind::Synthetic,
        catalog_sha256,
        catalog_as_of: 1,
        train_before: CUTOFF,
        samples,
    }
}

#[derive(Default)]
struct Aggregate {
    ndcg: f64,
    recall: f64,
    queries: usize,
    nonregressed: usize,
    timing: Vec<u128>,
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() > 1 {
        return Err(io::Error::other("用法：rank_learning_replay [已存在的实验输出目录]").into());
    }
    let catalog = catalog();
    let catalog_bytes = serde_json::to_vec(&catalog)?;
    let catalog_hash = format!("{:x}", Sha256::digest(&catalog_bytes));
    let training = training(&catalog, catalog_hash.clone());
    let training_bytes = serde_json::to_vec(&training)?;
    let started = Instant::now();
    let document = train_rank_model(&catalog, &training)?;
    let training_us = started.elapsed().as_micros();
    let model_bytes = serde_json::to_vec(&document)?;
    let model = LearnedRanker::new(&document, &catalog)?;
    let mut global: LinearRankModel = document.clone();
    global.weights[6..].fill(0.0);
    let global = LearnedRanker::new(&global, &catalog)?;
    let mut report: BTreeMap<String, Aggregate> = BTreeMap::new();
    for person in 0..48 {
        for domain in DOMAINS {
            let request = request(person + 101, domain, true);
            let context = RequestContext::new(&request, NOW)?;
            let indices: Vec<_> = catalog
                .items
                .iter()
                .enumerate()
                .filter(|(_, item)| item.id.starts_with("test-") && item.domain == domain)
                .map(|(index, _)| index)
                .collect();
            let labels: Vec<_> = indices
                .iter()
                .map(|index| Judgment {
                    candidate_id: catalog.items[*index].id.clone(),
                    relevance: u8::from(relevant(&context, &catalog.items[*index])),
                    observed_at: NOW + 1,
                })
                .collect();
            let baseline = recommend_subset_with_model(&catalog, &request, NOW, &indices, None)?;
            let baseline_ids: Vec<_> = baseline.items.iter().map(|item| item.id.as_str()).collect();
            let baseline_metrics = ranking_metrics(&baseline_ids, &labels, request.limit)?;
            for variant in [
                "tag-affinity",
                "ftrl",
                "ftrl-global-only",
                "ftrl-shuffled-profile",
            ] {
                let mut query = request.clone();
                if variant == "ftrl-shuffled-profile" {
                    query.profile.as_mut().unwrap().interests =
                        preferences(101 + (person + 17) % 48, true);
                }
                let ranker = match variant {
                    "tag-affinity" => None,
                    "ftrl-global-only" => Some(&global),
                    _ => Some(&model),
                };
                let mut elapsed = Vec::new();
                // 同候选、同过滤、同返回量；保存重复样本而非只测一次整批耗时。
                let mut result = None;
                for _ in 0..20 {
                    let started = Instant::now();
                    result = Some(recommend_subset_with_model(
                        &catalog, &query, NOW, &indices, ranker,
                    )?);
                    elapsed.push(started.elapsed().as_nanos());
                }
                let result = result.unwrap();
                let ids: Vec<_> = result.items.iter().map(|item| item.id.as_str()).collect();
                let metrics = ranking_metrics(&ids, &labels, request.limit)?;
                let entry = report.entry(format!("{domain}/{variant}")).or_default();
                if let (Some(ndcg), Some(recall), Some(baseline_ndcg)) = (
                    metrics.ndcg_at_k,
                    metrics.recall_at_k,
                    baseline_metrics.ndcg_at_k,
                ) {
                    entry.queries += 1;
                    entry.ndcg += ndcg;
                    entry.recall += recall;
                    entry.nonregressed += usize::from(ndcg + 1e-12 >= baseline_ndcg);
                }
                entry.timing.extend(elapsed);
            }
        }
    }
    let cells: Vec<_> = report
        .into_iter()
        .map(|(variant, mut value)| {
            value.timing.sort_unstable();
            let percentile =
                |percent: usize| value.timing[(percent * value.timing.len()).div_ceil(100) - 1];
            json!({
                "variant":variant,"queries_with_positive_labels":value.queries,
                "mean_ndcg_at_5":value.ndcg/value.queries as f64,
                "mean_recall_at_5":value.recall/value.queries as f64,
                "nonregressed_queries":value.nonregressed,
                "timing_samples":value.timing.len(),"p50_ns":percentile(50),
                "p95_ns":percentile(95),"p99_ns":percentile(99)
            })
        })
        .collect();
    let output = json!({
        "schema":"rank-learning-evaluation-v2","data_kind":"synthetic",
        "build":if cfg!(debug_assertions) {"debug"} else {"release"},
        "profile_control":"deterministic subject permutation changes both topic binding and magnitude",
        "catalog_sha256":catalog_hash,
        "training_sha256":format!("{:x}",Sha256::digest(&training_bytes)),
        "model_sha256":format!("{:x}",Sha256::digest(&model_bytes)),
        "training_samples":training.samples.len(),"training_us":training_us,
        "model_bytes":model_bytes.len(),"weight_bytes":document.weights.len()*8,
        "feature_count_per_item":6,"maximum_coordinate_count":390,
        "inference_rpc":0,
        "candidate_pool":"32 held-out candidates per domain, identical across variants",
        "boundary":"synthetic mechanism check; no production quality, probability calibration or QoE claim",
        "cells":cells
    });
    if let Some(directory) = args.first() {
        let directory = Path::new(directory);
        // 实验文件同样不可覆盖，防止把重复运行的新结果冒充旧收据。
        for (name, bytes) in [
            ("catalog.json", &catalog_bytes),
            ("training.json", &training_bytes),
        ] {
            use std::io::Write;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join(name))?
                .write_all(bytes)?;
        }
        let receipt = train_and_publish_rank_model(
            &catalog_bytes,
            &training_bytes,
            &directory.join("model.json"),
        )?;
        if receipt.sha256 != output["model_sha256"].as_str().unwrap() {
            return Err(io::Error::other("独立发布产物与内存训练结果不一致").into());
        }
    }
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("学习排序回放失败：{error}");
        std::process::exit(1);
    }
}
