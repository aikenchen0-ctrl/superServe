import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { run: { type: "string" }, output: { type: "string" } } });
if (!values.run || !values.output) throw new Error("请指定--run和--output");
const run = path.resolve(values.run), output = path.resolve(values.output);
if (/^[cC]:/.test(output)) throw new Error("汇总报告不能写入C盘");
const manifest = JSON.parse(await readFile(path.join(run, "manifest.json"), "utf8"));
if (manifest.schema !== "natural-playback-comparison-v1") throw new Error("不是无屏障播放报告");
const failures = [...manifest.failures];
const rows = [];
for (const trial of manifest.trials) {
  const bytes = await readFile(path.join(run, trial.id, "receipt.json"));
  if (createHash("sha256").update(bytes).digest("hex") !== trial.receipt_sha256) {
    throw new Error("浏览器收据指纹与运行清单不一致");
  }
  const receipt = JSON.parse(bytes);
  if (!trial.valid || !receipt.valid || receipt.failures.length) failures.push({ id: trial.id, reason: "轨迹未通过" });
  if (!trial.browser_closed || trial.listener_remaining !== false || !trial.process_exit) {
    failures.push({ id: trial.id, reason: "资源或进程未回收" });
  }
  rows.push({
    id: trial.id, round: trial.round, rate: trial.rate, scenario: trial.scenario,
    layout: trial.layout, progressive: trial.progressive, ...receipt.measures,
    server_cpu_ms: receipt.server_process.cpu_delta_ms,
    server_working_set_before: receipt.server_process.before.working_set_bytes,
    server_working_set_after: receipt.server_process.after.working_set_bytes,
    server_private_after: receipt.server_process.after.private_memory_bytes,
    renderer_task_seconds: receipt.usage.deltas.TaskDuration,
    renderer_script_seconds: receipt.usage.deltas.ScriptDuration,
    renderer_heap_after: receipt.usage.after.JSHeapUsedSize,
  });
}
const summarize = (numbers) => {
  const valid = numbers.filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    available: valid.length, total: numbers.length,
    mean: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null,
    min: valid.length ? Math.min(...valid) : null,
    max: valid.length ? Math.max(...valid) : null,
  };
};
const measures = [
  "first_frame_ms", "stall_count", "stall_ms", "client_cdp_body_bytes", "media_requests",
  "cancelled_requests", "appends", "played_seconds", "source_http_body_bytes", "service_yielded_bytes",
  "server_cpu_ms", "server_working_set_before", "server_working_set_after", "server_private_after",
  "renderer_task_seconds", "renderer_script_seconds", "renderer_heap_after",
];
const groups = new Map();
for (const row of rows) {
  const key = `${row.rate}/${row.scenario}/${row.layout}/${row.progressive}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const cells = [];
for (const group of groups.values()) {
  const first = group[0];
  if (group.length !== manifest.repetitions ||
      new Set(group.map((row) => row.round)).size !== manifest.repetitions) {
    failures.push({ key: first.id, reason: "重复次数或配对不完整" });
  }
  const baseline = rows.filter((row) => row.rate === first.rate && row.scenario === first.scenario &&
    row.layout === "single" && row.progressive === false);
  const paired = group.map((row) => {
    const base = baseline.find((value) => value.round === row.round);
    if (!base) throw new Error("同一轮次缺少基线");
    const deltas = Object.fromEntries(measures.map((name) => [
      name, row[name] === null || base[name] === null ? null : row[name] - base[name],
    ]));
    return { round: row.round, deltas };
  });
  cells.push({
    rate: first.rate, scenario: first.scenario, layout: first.layout, progressive: first.progressive,
    repeats: group.length,
    summary: Object.fromEntries(measures.map((name) => [name, summarize(group.map((row) => row[name]))])),
    paired_differences_vs_single_whole: Object.fromEntries(measures.map((name) =>
      [name, summarize(paired.map((row) => row.deltas[name]))])),
    pairs: paired,
  });
}
const report = {
  schema: "natural-playback-summary-v1", source_sha256: manifest.source_sha256,
  all_trials_valid: manifest.all_trials_valid && failures.length === 0,
  trials: rows.length, repetitions: manifest.repetitions, cells, rows, failures,
  weighting: "每素材、速率、动作及候选分别汇总，不跨素材或速率合成总冠军；按轮次配对",
  sample_warning: "每组合最多2次，仅描述范围与均值，无统计显著性或生产P95声明",
  metrics_warning: "CDP正文非线路；主渲染器TaskDuration非完整CPU；V8堆非RSS；服务CPU量化且源与服务合并",
  production_selected: false,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({
  素材指纹: manifest.source_sha256, 轨迹: rows.length, 组合: cells.length, 错误: failures,
  联合候选: cells.filter((cell) => cell.layout === "500" && cell.progressive).map((cell) => ({
    速率: cell.rate, 动作: cell.scenario,
    首帧均值毫秒: cell.summary.first_frame_ms.mean, 卡顿均值毫秒: cell.summary.stall_ms.mean,
    正文均值字节: cell.summary.client_cdp_body_bytes.mean,
    比基线首帧差毫秒: cell.paired_differences_vs_single_whole.first_frame_ms.mean,
    比基线卡顿差毫秒: cell.paired_differences_vs_single_whole.stall_ms.mean,
    比基线正文差字节: cell.paired_differences_vs_single_whole.client_cdp_body_bytes.mean,
  })),
}, null, 2));
if (!report.all_trials_valid) process.exitCode = 1;
