use std::{
    env,
    hint::black_box,
    io::{self, BufRead, Write},
    time::Instant,
};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use vs_core::{
    catalog::PublicCatalog,
    grouped_recall::{GroupHeadStrategy, GroupedRecall, GroupedSelection},
    recommendation::{
        RecommendationRequest, RecommendationResponse, RequestContext, recommend, recommend_subset,
    },
};

#[path = "support/cost_workload.rs"]
mod workload;

type Check<T> = Result<T, String>;

#[derive(Serialize)]
struct Sample {
    first: &'static str,
    full_ns: u64,
    grouped_total_ns: u64,
    full_considered: usize,
    grouped_considered: usize,
    groups_examined: usize,
    groups_scored: usize,
    candidates_examined: usize,
    head_buffer_bytes: usize,
    output_buffer_bytes: usize,
    exact: bool,
}

fn nanos(start: Instant) -> u64 {
    start.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

fn same_result(a: &RecommendationResponse, b: &RecommendationResponse) -> bool {
    a.request_id == b.request_id
        && a.catalog_version == b.catalog_version
        && a.profile_version == b.profile_version
        && a.ranker == b.ranker
        && a.items.len() == b.items.len()
        && a.items.iter().zip(&b.items).all(|(a, b)| {
            a.id == b.id
                && a.domain == b.domain
                && a.affinity.to_bits() == b.affinity.to_bits()
                && a.media_path == b.media_path
        })
}

fn grouped(
    catalog: &PublicCatalog,
    index: &GroupedRecall,
    request: &RecommendationRequest,
    strategy: GroupHeadStrategy,
) -> Check<(RecommendationResponse, GroupedSelection)> {
    let context = RequestContext::new(request, 50).map_err(|_| "请求校验失败")?;
    let selected = index.select_with_strategy(&context, strategy);
    let response = recommend_subset(catalog, request, 50, &selected.indices)
        .map_err(|_| "分组后的排序失败")?;
    Ok((response, selected))
}

fn measure(
    catalog: &PublicCatalog,
    index: &GroupedRecall,
    request: &RecommendationRequest,
    full_first: bool,
    strategy: GroupHeadStrategy,
) -> Check<Sample> {
    let measure_full = || {
        let start = Instant::now();
        let response =
            recommend(black_box(catalog), black_box(request), 50).map_err(|_| "全量排序失败")?;
        black_box(&response);
        Ok::<_, String>((response, nanos(start)))
    };
    let measure_grouped = || {
        let start = Instant::now();
        let (response, selected) = grouped(
            black_box(catalog),
            black_box(index),
            black_box(request),
            strategy,
        )?;
        black_box(&response);
        Ok::<_, String>((response, selected, nanos(start)))
    };
    let ((full, full_ns), (partial, selected, grouped_total_ns)) = if full_first {
        (measure_full()?, measure_grouped()?)
    } else {
        let grouped = measure_grouped()?;
        (measure_full()?, grouped)
    };
    Ok(Sample {
        first: if full_first { "catalog" } else { "grouped" },
        full_ns,
        grouped_total_ns,
        full_considered: full.considered,
        grouped_considered: partial.considered,
        groups_examined: selected.groups_examined,
        groups_scored: selected.groups_scored,
        candidates_examined: selected.candidates_examined,
        head_buffer_bytes: selected.head_buffer_bytes,
        output_buffer_bytes: selected.output_buffer_bytes,
        exact: same_result(&full, &partial),
    })
}

fn percentiles(values: impl Iterator<Item = u64>) -> Value {
    let mut values: Vec<_> = values.collect();
    values.sort_unstable();
    let at = |p: usize| values[(p * values.len()).div_ceil(100) - 1];
    json!({"samples":values.len(),"p50_ns":at(50),"p95_ns":at(95),"p99_ns":at(99),"max_ns":values.last()})
}

fn controls(name: &str, fallback: usize, min: usize, max: usize) -> Check<usize> {
    let value = match env::var(name) {
        Ok(value) => value.parse().ok(),
        Err(env::VarError::NotPresent) => Some(fallback),
        Err(_) => None,
    };
    value
        .filter(|value| (min..=max).contains(value))
        .ok_or_else(|| format!("{name} 必须为 {min} 至 {max} 的整数"))
}

fn run_matrix(quick: bool, compare: bool) -> Check<(Value, bool)> {
    if !quick && cfg!(debug_assertions) {
        return Err("完整成本矩阵必须以 --release 构建；调试冒烟可使用 --quick。".into());
    }
    let samples = controls("COST_SAMPLES", if quick { 8 } else { 64 }, 8, 512)?;
    if !samples.is_multiple_of(4) {
        return Err("COST_SAMPLES 必须为 4 的倍数，以平衡两条路径的执行顺序。".into());
    }
    let warmup = controls("COST_WARMUP", if quick { 2 } else { 8 }, 1, 64)?;
    let strategy = strategy()?;
    let varied = varied_workload()?;
    let strategies = if compare {
        vec![
            GroupHeadStrategy::All,
            GroupHeadStrategy::Heap,
            GroupHeadStrategy::Buffered,
        ]
    } else {
        vec![strategy]
    };
    let sizes: &[usize] = if quick {
        &[256, 1024]
    } else {
        &[256, 1024, 4096, 10000]
    };
    let ratios: &[usize] = if quick { &[1, 100] } else { &[1, 10, 50, 100] };
    let mut cells = Vec::new();
    let mut catalogs = Vec::new();
    let mut mismatches = 0;
    for &size in sizes {
        for &ratio in ratios {
            let groups = (size * ratio).div_ceil(100);
            eprintln!("测量合成目录：候选 {size}，分组 {groups}，目标组占比 {ratio}%");
            let catalog = workload::catalog_with_variant(size, groups, varied)?;
            let catalog_sha256 = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(catalog.as_ref()).map_err(|_| "目录编码失败")?)
            );
            let start = Instant::now();
            let index = GroupedRecall::new(catalog.clone()).map_err(|_| "分组索引构建失败")?;
            let build_ns = nanos(start);
            if index.group_count() != groups {
                return Err("合成目录实际组数与参数不符".into());
            }
            let layout = index.allocation_layout();
            catalogs.push(json!({
                "size":size,"groups":groups,"target_group_percent":ratio,
                "actual_group_fraction":groups as f64 / size as f64,
                "catalog_sha256":catalog_sha256,"build_ns":build_ns,"index_layout":layout
            }));
            for filtered in [false, true] {
                for limit in [10, 50] {
                    let request = workload::request(size, filtered, limit);
                    for i in 0..warmup {
                        for j in 0..strategies.len() {
                            let candidate = strategies[(i + j) % strategies.len()];
                            if !measure(&catalog, &index, &request, i.is_multiple_of(2), candidate)?
                                .exact
                            {
                                return Err("预热阶段发现排序契约不一致，拒绝生成性能结论。".into());
                            }
                        }
                    }
                    let mut measurements: Vec<Vec<Sample>> = (0..strategies.len())
                        .map(|_| Vec::with_capacity(samples))
                        .collect();
                    for i in 0..samples {
                        // ABBA 顺序只控制两路径相对位置；不把热缓存结果外推为生产请求。
                        for j in 0..strategies.len() {
                            let slot = (i + j) % strategies.len();
                            measurements[slot].push(measure(
                                &catalog,
                                &index,
                                &request,
                                [true, false, false, true][i % 4],
                                strategies[slot],
                            )?);
                        }
                    }
                    for (candidate, rows) in strategies.iter().zip(measurements) {
                        let failures = rows.iter().filter(|row| !row.exact).count();
                        mismatches += failures;
                        let mut savings: Vec<_> = rows
                            .iter()
                            .map(|row| row.full_ns as i64 - row.grouped_total_ns as i64)
                            .collect();
                        savings.sort_unstable();
                        let median_saving = savings[(savings.len() - 1) / 2];
                        let median = |full: bool| {
                            let mut values: Vec<_> = rows
                                .iter()
                                .map(|row| {
                                    if full {
                                        row.full_ns
                                    } else {
                                        row.grouped_total_ns
                                    }
                                })
                                .collect();
                            values.sort_unstable();
                            values[(values.len() - 1) / 2]
                        };
                        cells.push(json!({
                        "size":size,"groups":groups,"filtered":filtered,"k":limit,"head_strategy":candidate,
                        "full_total":percentiles(rows.iter().map(|row|row.full_ns)),
                        "grouped_total":percentiles(rows.iter().map(|row|row.grouped_total_ns)),
                        "grouped_to_full_p50_ratio":median(false) as f64 / median(true).max(1) as f64,
                        "median_paired_saving_ns":median_saving,
                        "grouped_faster_samples":rows.iter().filter(|row|row.grouped_total_ns<row.full_ns).count(),
                        "build_amortization_queries_estimate":if failures==0 && median_saving>0 {
                            Some(build_ns.div_ceil(median_saving as u64))
                        }else{None},
                        "index_retained_payload_bytes":layout.retained_payload_bytes,
                        "fidelity_mismatches":failures,"measurements":rows
                    }));
                    }
                }
            }
        }
    }
    let passed = mismatches == 0;
    Ok((
        json!({
            "schema":if compare {"recall-head-comparison-v1"}else{"recall-cost-matrix-v2"},
            "quick":quick,"head_strategy":strategy,"compared_strategies":strategies,
            "build":if cfg!(debug_assertions){"debug"}else{"release"},
            "data_kind":"synthetic","workload":if varied{"varied-signed-eight-tags-v1"}else{"tie-heavy-eight-tags-v1"},
            "sizes":sizes,"group_percent_targets":ratios,"samples_per_cell":samples,
            "warmup_pairs":warmup,"order":"ABBA; comparison rotates strategy order each sample",
            "catalogs":catalogs,"cells":cells,
            "quality_gate":{"passed":passed,"mismatched_samples":mismatches,
                "rule":"exact response metadata and ordered items, excluding considered count"},
            "timing_scope":"本机进程内完整推荐函数；分组包含上下文、选择与最终排序，不含HTTP、画像RPC和并发排队。",
            "memory_scope":"对象大小与持有缓冲区字节；布局类型见index_layout.storage；不含共享目录、分配器元数据、构建瞬时分配或进程RSS。",
            "amortization_scope":"一次索引构建除以配对耗时节省的描述性估算；不含内存、更新流量和调度成本。",
            "statistics_scope":"原始配对样本和最近秩分位数；不估计统计显著性或生产尾延迟。",
            "production_route_change":false,"online_quality_claim":false
        }),
        passed,
    ))
}

fn checkpoint(phase: &str, details: Value, input: &mut impl BufRead) -> Check<()> {
    println!(
        "{}",
        json!({"schema":"recall-memory-probe-v1","pid":std::process::id(),"phase":phase,"details":details})
    );
    io::stdout().flush().map_err(|_| "探针输出失败")?;
    let mut line = String::new();
    input.read_line(&mut line).map_err(|_| "探针控制输入失败")?;
    if line.trim() != "continue" {
        return Err("探针期望 continue 控制消息".into());
    }
    Ok(())
}

fn memory_probe(size: usize, groups: usize) -> Check<()> {
    if !(1..=10000).contains(&size) || !(1..=size).contains(&groups) {
        return Err("内存探针目录参数超出范围".into());
    }
    let strategy = strategy()?;
    let mut input = io::stdin().lock();
    checkpoint("ready", json!({"head_strategy":strategy}), &mut input)?;
    let catalog = workload::catalog_with_variant(size, groups, varied_workload()?)?;
    checkpoint("catalog", json!({"size":size,"groups":groups}), &mut input)?;
    let index = GroupedRecall::new(catalog.clone()).map_err(|_| "内存探针索引构建失败")?;
    checkpoint(
        "indexed",
        json!({"layout":index.allocation_layout()}),
        &mut input,
    )?;
    let request = workload::request(size, false, 50);
    let (response, selected) = grouped(&catalog, &index, &request, strategy)?;
    checkpoint(
        "queried",
        json!({
            "head_buffer_bytes":selected.head_buffer_bytes,
            "output_buffer_bytes":selected.output_buffer_bytes,
            "groups_scored":selected.groups_scored,"candidates_examined":selected.candidates_examined,
            "note":"仅分组路径；临时堆已释放，进程峰值包含加载和构建阶段；排序保真另由成本矩阵核验。"
        }),
        &mut input,
    )?;
    drop((request, response, selected));
    drop(index);
    checkpoint(
        "index_dropped",
        json!({"catalog_still_resident":true}),
        &mut input,
    )?;
    Ok(())
}

fn run() -> Check<bool> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.len() == 3 && args[0] == "--memory-probe" {
        memory_probe(
            args[1].parse().map_err(|_| "目录数量无效")?,
            args[2].parse().map_err(|_| "分组数量无效")?,
        )?;
        return Ok(true);
    }
    if !args.is_empty() && args != ["--quick"] && args != ["--compare-heads"] {
        return Err(
            "用法：recall_cost_matrix [--quick|--compare-heads]；或 --memory-probe <候选数> <组数>。".into(),
        );
    }
    let (report, passed) = run_matrix(args == ["--quick"], args == ["--compare-heads"])?;
    serde_json::to_writer_pretty(io::stdout().lock(), &report).map_err(|_| "报告输出失败")?;
    println!();
    Ok(passed)
}

fn strategy() -> Check<GroupHeadStrategy> {
    match env::var("COST_HEAD_STRATEGY").as_deref() {
        Ok("all") => Ok(GroupHeadStrategy::All),
        Ok("heap") => Ok(GroupHeadStrategy::Heap),
        Ok("buffered") | Err(env::VarError::NotPresent) => Ok(GroupHeadStrategy::Buffered),
        _ => Err("COST_HEAD_STRATEGY 必须为 all、heap 或 buffered".into()),
    }
}

fn varied_workload() -> Check<bool> {
    match env::var("COST_WORKLOAD").as_deref() {
        Ok("ties") | Err(env::VarError::NotPresent) => Ok(false),
        Ok("varied") => Ok(true),
        _ => Err("COST_WORKLOAD 必须为 ties 或 varied".into()),
    }
}

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("排序保真门禁失败，性能样本不得用于收益结论。");
            std::process::exit(2)
        }
        Err(error) => {
            eprintln!("成本测量失败：{error}");
            std::process::exit(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_controls_group_count_and_both_paths_preserve_filtered_results() {
        for (n, g) in [(1, 1), (65, 1), (65, 65), (257, 26)] {
            let catalog = workload::catalog(n, g).unwrap();
            let index = GroupedRecall::new(catalog.clone()).unwrap();
            assert_eq!(index.group_count(), g);
            for filtered in [false, true] {
                let sample = measure(
                    &catalog,
                    &index,
                    &workload::request(n, filtered, 50),
                    true,
                    GroupHeadStrategy::Buffered,
                )
                .unwrap();
                assert!(sample.exact);
                assert!(sample.grouped_considered <= 128);
                assert!(sample.candidates_examined <= n);
            }
            let varied = workload::catalog_with_variant(n, g, true).unwrap();
            let varied_index = GroupedRecall::new(varied.clone()).unwrap();
            for strategy in [
                GroupHeadStrategy::All,
                GroupHeadStrategy::Heap,
                GroupHeadStrategy::Buffered,
            ] {
                assert!(
                    measure(
                        &varied,
                        &varied_index,
                        &workload::request(n, true, 50),
                        false,
                        strategy
                    )
                    .unwrap()
                    .exact
                );
            }
        }
        assert!(workload::catalog(10001, 1).is_err());
        assert!(workload::catalog(10, 11).is_err());
    }

    #[test]
    fn timing_summary_keeps_tail_samples_instead_of_adding_stage_medians() {
        let report = percentiles(1..=20);
        assert_eq!(report["p50_ns"], 10);
        assert_eq!(report["p95_ns"], 19);
        assert_eq!(report["p99_ns"], 20);
    }

    #[test]
    fn fidelity_gate_rejects_changed_order_scores_and_metadata() {
        let catalog = workload::catalog(65, 5).unwrap();
        let request = workload::request(65, false, 10);
        let full = recommend(&catalog, &request, 50).unwrap();
        let mut other = recommend(&catalog, &request, 50).unwrap();
        other.considered = 1;
        assert!(same_result(&full, &other));
        other.items.swap(0, 1);
        assert!(!same_result(&full, &other));
        other.items.swap(0, 1);
        other.items[0].affinity += 0.01;
        assert!(!same_result(&full, &other));
        other.items[0].affinity = full.items[0].affinity;
        other.profile_version = None;
        assert!(!same_result(&full, &other));
    }

    #[test]
    fn varied_workload_contains_positive_zero_and_negative_affinity() {
        let catalog = workload::catalog_with_variant(1000, 1000, true).unwrap();
        let request = workload::request(1000, false, 50);
        let context = RequestContext::new(&request, 50).unwrap();
        let scores: Vec<_> = catalog
            .items
            .iter()
            .map(|item| context.affinity(item))
            .collect();
        assert!(scores.iter().any(|score| *score > 0.0));
        assert!(scores.iter().any(|score| *score == 0.0));
        assert!(scores.iter().any(|score| *score < 0.0));
    }
}
