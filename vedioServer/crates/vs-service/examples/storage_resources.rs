use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

type Check<T> = Result<T, String>;
const HEADER: &str = "unix_ms\tuptime_seconds\tnode\tpid\tstart_ticks\tcpu_ticks\trss_kib\thwm_kib\tos_threads\topen_fds\tread_bytes\twrite_bytes\trchar\twchar";

#[derive(Clone, Debug)]
struct Row {
    wall: u64,
    uptime: f64,
    node: usize,
    pid: u64,
    birth: u64,
    values: [u64; 9],
}

fn parse(text: &str) -> Check<Vec<Row>> {
    let mut lines = text.lines();
    if lines.next() != Some(HEADER) {
        return Err("resource_header".into());
    }
    let mut rows = Vec::new();
    let mut previous = HashMap::<usize, Row>::new();
    for line in lines {
        let parts: Vec<_> = line.split('\t').collect();
        if parts.len() != 14 {
            return Err("resource_column_count".into());
        }
        let number = |index: usize| {
            parts[index]
                .parse::<u64>()
                .map_err(|_| "resource_number".to_string())
        };
        let mut values = [0; 9];
        for (index, value) in values.iter_mut().enumerate() {
            *value = number(index + 5)?;
        }
        let row = Row {
            wall: number(0)?,
            uptime: parts[1].parse().map_err(|_| "resource_uptime")?,
            node: usize::try_from(number(2)?).map_err(|_| "resource_node")?,
            pid: number(3)?,
            birth: number(4)?,
            values,
        };
        if row.node >= 4 || !row.uptime.is_finite() || row.uptime < 0.0 {
            return Err("resource_node_or_clock".into());
        }
        if let Some(old) = previous.get(&row.node) {
            if old.pid != row.pid || old.birth != row.birth {
                return Err("resource_pid_reused".into());
            }
            if row.wall <= old.wall || row.uptime <= old.uptime {
                return Err("resource_clock_not_increasing".into());
            }
            for index in [0, 2, 5, 6, 7, 8] {
                if row.values[index] < old.values[index] {
                    return Err("resource_counter_decreased".into());
                }
            }
        }
        previous.insert(row.node, row.clone());
        rows.push(row);
    }
    if previous.len() != 4 {
        return Err("resource_missing_node".into());
    }
    Ok(rows)
}

fn describe(mut values: Vec<u64>) -> Value {
    values.sort_unstable();
    json!({
        "min": values.first(), "median": values[values.len() / 2], "max": values.last()
    })
}

fn summarize(rows: &[Row], phases: &[Value], hz: u64) -> Check<Value> {
    if hz == 0 {
        return Err("resource_invalid_clock_rate".into());
    }
    let mut groups = BTreeMap::<u64, Vec<&Row>>::new();
    for row in rows {
        groups.entry(row.wall).or_default().push(row);
    }
    let incomplete = groups.values().filter(|group| group.len() != 4).count();
    let complete: Vec<_> = groups.values().filter(|group| group.len() == 4).collect();
    let mut windows = Vec::new();
    for pair in phases.windows(2) {
        if !matches!(pair[0]["phase"].as_str(), Some("baseline" | "recovery")) {
            continue;
        }
        let start = pair[0]["unix_ms"].as_u64().ok_or("resource_phase_clock")?;
        let end = pair[1]["unix_ms"].as_u64().ok_or("resource_phase_clock")?;
        if end <= start {
            return Err("resource_phase_order".into());
        }
        let selected: Vec<_> = complete
            .iter()
            .filter(|group| group[0].wall >= start && group[0].wall < end)
            .collect();
        if selected.len() < 5 {
            return Err("resource_insufficient_window".into());
        }
        let tail = &selected[selected.len() - 5..];
        let totals: Vec<[u64; 9]> = tail
            .iter()
            .map(|group| {
                let mut total = [0; 9];
                for row in group.iter() {
                    for (index, value) in row.values.iter().enumerate() {
                        total[index] += value;
                    }
                }
                total
            })
            .collect();
        let elapsed = tail[4][0].uptime - tail[0][0].uptime;
        if elapsed <= 0.0 {
            return Err("resource_nonpositive_elapsed".into());
        }
        let mut metrics = serde_json::Map::new();
        for (name, index) in [
            ("rss_kib", 1),
            ("hwm_kib", 2),
            ("os_threads", 3),
            ("open_fds", 4),
        ] {
            metrics.insert(
                name.into(),
                describe(totals.iter().map(|v| v[index]).collect()),
            );
        }
        metrics.insert(
            "cpu_cores".into(),
            json!((totals[4][0] - totals[0][0]) as f64 / hz as f64 / elapsed),
        );
        for (name, index) in [
            ("read_bytes", 5),
            ("write_bytes", 6),
            ("rchar", 7),
            ("wchar", 8),
        ] {
            metrics.insert(
                format!("{name}_delta"),
                json!(totals[4][index] - totals[0][index]),
            );
        }
        windows.push(json!({
            "phase": pair[0]["phase"], "cycle": pair[0]["cycle"],
            "available_samples": selected.len(), "tail_samples": 5,
            "from_unix_ms": tail[0][0].wall, "to_unix_ms": tail[4][0].wall,
            "duration_seconds": elapsed, "aggregate_four_processes": metrics
        }));
    }
    if windows.len() != 4
        || windows[0]["phase"] != "baseline"
        || windows[1..]
            .iter()
            .enumerate()
            .any(|(i, w)| w["phase"] != "recovery" || w["cycle"] != i)
    {
        return Err("resource_missing_required_windows".into());
    }
    Ok(json!({
        "complete_samples": complete.len(), "incomplete_samples": incomplete,
        "windows": windows
    }))
}

fn read(directory: &Path, name: &str) -> Check<Vec<u8>> {
    fs::read(directory.join(name)).map_err(|_| format!("resource_read_{name}"))
}

fn run(directory: &Path) -> Check<Value> {
    let mut fingerprints = BTreeMap::new();
    let mut input = |name: &str| -> Check<Vec<u8>> {
        let bytes = read(directory, name)?;
        fingerprints.insert(name.to_string(), format!("{:x}", Sha256::digest(&bytes)));
        Ok(bytes)
    };
    let receipt: Value =
        serde_json::from_slice(&input("cancel-soak.json")?).map_err(|_| "resource_receipt_json")?;
    let sampler: Value =
        serde_json::from_slice(&input("sampler.json")?).map_err(|_| "resource_sampler_json")?;
    let inputs: Value =
        serde_json::from_slice(&input("inputs.json")?).map_err(|_| "resource_inputs_json")?;
    if receipt["schema"] != "storage-cancel-soak-v1" || sampler["complete"] != true {
        return Err("resource_incomplete_experiment".into());
    }
    let bytes = input("resources.tsv")?;
    let rows = parse(std::str::from_utf8(&bytes).map_err(|_| "resource_utf8")?)?;
    let stats = summarize(
        &rows,
        receipt["phases"].as_array().ok_or("resource_phases")?,
        sampler["clock_ticks_per_second"]
            .as_u64()
            .ok_or("resource_clock_rate")?,
    )?;
    Ok(json!({
        "schema": "storage-cancel-soak-resources-v1",
        "run_directory": directory.to_string_lossy(), "inputs_sha256": fingerprints,
        "runtime_inputs": inputs,
        "functional_passed": receipt["passed"], "resource_observation_complete": true,
        "statistics": stats, "resource_convergence_proven": false,
        "remote_task_count_measured": false, "remote_lease_count_measured": false,
        "production_performance_claim": false
    }))
}

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 2 {
        eprintln!("需要一个实验目录参数。");
        std::process::exit(2);
    }
    match run(Path::new(&args[1])) {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap()),
        Err(error) => {
            eprintln!("资源收据校验失败：{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(wall: u64, node: usize, pid: u64, cpu: u64) -> String {
        format!(
            "{wall}\t{}.0\t{node}\t{pid}\t1234\t{cpu}\t100\t200\t4\t8\t0\t0\t0\t0",
            wall
        )
    }

    #[test]
    fn detects_pid_reuse_counter_reset_and_duplicate_sample() {
        let base = (0..4)
            .map(|n| sample(1, n, 10 + n as u64, 2))
            .collect::<Vec<_>>()
            .join("\n");
        for (extra, expected) in [
            (sample(2, 0, 99, 3), "resource_pid_reused"),
            (sample(2, 0, 10, 1), "resource_counter_decreased"),
            (sample(1, 0, 10, 2), "resource_clock_not_increasing"),
        ] {
            assert_eq!(
                parse(&format!("{HEADER}\n{base}\n{extra}")).unwrap_err(),
                expected
            );
        }
    }

    #[test]
    fn missing_node_and_malformed_row_fail_closed() {
        assert!(parse(&format!("{HEADER}\n{}", sample(1, 0, 10, 2))).is_err());
        assert!(parse(&format!("{HEADER}\n1\t2")).is_err());
    }

    #[test]
    fn reports_four_tail_windows_without_claiming_convergence() {
        let mut text = format!("{HEADER}\n");
        for wall in 1..=30 {
            for node in 0..4 {
                text.push_str(&sample(wall, node, 10 + node as u64, wall));
                text.push('\n');
            }
        }
        let rows = parse(&text).unwrap();
        let phases = vec![
            json!({"phase":"baseline","unix_ms":1}),
            json!({"phase":"load","unix_ms":7}),
            json!({"phase":"recovery","cycle":0,"unix_ms":8}),
            json!({"phase":"load","unix_ms":14}),
            json!({"phase":"recovery","cycle":1,"unix_ms":15}),
            json!({"phase":"load","unix_ms":21}),
            json!({"phase":"recovery","cycle":2,"unix_ms":22}),
            json!({"phase":"verify","unix_ms":30}),
        ];
        let stats = summarize(&rows, &phases, 100).unwrap();
        assert_eq!(
            stats["windows"][0]["aggregate_four_processes"]["rss_kib"]["median"],
            400
        );
        assert_eq!(
            stats["windows"][0]["aggregate_four_processes"]["cpu_cores"],
            0.04
        );
        assert!(summarize(&rows, &phases[..4], 100).is_err());
        assert!(summarize(&rows, &phases, 0).is_err());
    }
}
