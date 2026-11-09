import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { run: { type: "string" }, output: { type: "string" } } });
if (!values.run || !values.output) throw new Error("请指定--run和--output");
const run = path.resolve(values.run), output = path.resolve(values.output);
if (/^[cC]:/.test(output)) throw new Error("工作器汇总不能写入C盘");
const manifest = JSON.parse(await readFile(path.join(run, "manifest.json"), "utf8"));
if (manifest.schema !== "worker-startup-comparison-v1") throw new Error("不是工作器对照清单");
const failures = [...manifest.failures];
const rows = [];
for (const trial of manifest.trials) {
  const bytes = await readFile(path.join(run, trial.id, "receipt.json"));
  if (createHash("sha256").update(bytes).digest("hex") !== trial.receipt_sha256) {
    throw new Error("工作器收据指纹与清单不一致");
  }
  const receipt = JSON.parse(bytes);
  if (!trial.valid || !receipt.valid || receipt.failures.length || !trial.browser_closed
      || trial.listener_remaining !== false || !trial.process_exit) failures.push({ id: trial.id, reason: "组合未通过" });
  for (const [index, play] of receipt.plays.entries()) rows.push({
    id: trial.id, round: trial.round, rate: trial.rate, mode: trial.worker, play: index + 1,
    first_frame_ms: play.report.first_frame_ms,
    worker_server_bytes: play.worker_delivery.yielded_body_bytes,
    worker_server_responses: play.worker_delivery.responses,
    worker_client_cdp_bytes: play.body.worker,
    media_client_cdp_bytes: play.body.media,
    bootstrap_client_cdp_bytes: receipt.bootstrap.bootstrap,
    control_client_cdp_bytes: play.body.control,
    initialized_workers: new Set(play.lifecycle.initialized.map((row) => row.id)).size,
    terminated_workers: new Set(play.lifecycle.terminated).size,
  });
}
const describe = (numbers) => {
  const valid = numbers.filter((number) => typeof number === "number" && Number.isFinite(number));
  return { n: valid.length, missing: numbers.length - valid.length,
    mean: valid.length ? valid.reduce((sum, number) => sum + number, 0) / valid.length : null,
    min: valid.length ? Math.min(...valid) : null, max: valid.length ? Math.max(...valid) : null };
};
const cells = [];
for (const rate of manifest.network_profiles) for (const play of [1, 2]) {
  const baseline = rows.filter((row) => row.rate === rate && row.play === play && row.mode === "external");
  const candidate = rows.filter((row) => row.rate === rate && row.play === play && row.mode === "embedded");
  if (baseline.length !== manifest.repetitions || candidate.length !== manifest.repetitions) {
    failures.push({ rate, play, reason: "轮次不完整" });
  }
  const pairs = candidate.map((row) => {
    const base = baseline.find((value) => value.round === row.round);
    if (!base || base.bootstrap_client_cdp_bytes !== row.bootstrap_client_cdp_bytes) {
      throw new Error("缺少同轮基线或主库/页面不同");
    }
    return { round: row.round, first_frame_delta_ms: row.first_frame_ms - base.first_frame_ms,
      worker_server_delta_bytes: row.worker_server_bytes - base.worker_server_bytes,
      media_client_delta_bytes: row.media_client_cdp_bytes - base.media_client_cdp_bytes };
  });
  cells.push({
    rate, play, external_first_frame_ms: describe(baseline.map((row) => row.first_frame_ms)),
    embedded_first_frame_ms: describe(candidate.map((row) => row.first_frame_ms)),
    first_frame_paired_delta_ms: describe(pairs.map((row) => row.first_frame_delta_ms)),
    worker_server_paired_delta_bytes: describe(pairs.map((row) => row.worker_server_delta_bytes)),
    media_client_paired_delta_bytes: describe(pairs.map((row) => row.media_client_delta_bytes)),
    pairs,
  });
}
const report = {
  schema: "worker-startup-summary-v1", source_sha256: manifest.source_sha256,
  trials: manifest.trials.length, plays: rows.length, repetitions: manifest.repetitions,
  all_trials_valid: manifest.all_trials_valid && failures.length === 0, cells, rows, failures,
  boundary: "两次播放均销毁工作器且禁缓存；只配对相同素材/轮次/速率/第几次播放；每格2次，无显著性或生产尾延迟声明",
  byte_boundary: "主库与媒体为父页面CDP正文；工作器为Rust服务响应产出，父页面缺失值保留null，不加总为客户端线路流量",
  bootstrap_boundary: "CLI初次打开后重新加载并开始计量；bootstrap只覆盖被观测重载，不含更早打开的同一主库下载",
  production_selected: false,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({
  素材: manifest.source_sha256, 组合: report.trials, 播放: report.plays, 错误: failures,
  配对: cells.map((cell) => ({
    速率: cell.rate, 第几次播放: cell.play,
    外部首帧毫秒: cell.external_first_frame_ms.mean,
    内置首帧毫秒: cell.embedded_first_frame_ms.mean,
    首帧差毫秒: cell.first_frame_paired_delta_ms.mean,
    工作器服务正文差字节: cell.worker_server_paired_delta_bytes.mean,
    媒体实收正文差字节: cell.media_client_paired_delta_bytes.mean,
  })),
}, null, 2));
if (!report.all_trials_valid) process.exitCode = 1;
