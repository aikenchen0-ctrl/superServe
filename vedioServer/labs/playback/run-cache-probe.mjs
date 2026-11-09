import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  binary: { type: "string" }, source: { type: "string" }, cli: { type: "string" },
  output: { type: "string" }, repetitions: { type: "string", default: "2" },
  packaging: { type: "string", default: "single" },
  entries: { type: "string", default: "65536,262144" },
  trace: { type: "string", default: "gated" },
} });
if (!values.binary || !values.source || !values.cli || !values.output || !["1", "2"].includes(values.repetitions)) {
  throw new Error("请指定--binary、--source、--cli、--output；重复次数仅支持1或2");
}
if (!["gated", "natural", "worker"].includes(values.trace)) throw new Error("轨迹仅支持gated、natural或worker");
const natural = values.trace === "natural";
const workerTrace = values.trace === "worker";
const root = process.cwd();
const output = path.resolve(values.output);
process.env.PLAYWRIGHT_TRANSFORM_CACHE_DIR ??= path.join(process.env.TEMP ?? "", "playwright-transform");
for (const directory of [output, process.env.TEMP, process.env.CARGO_TARGET_DIR,
  process.env.PWTEST_DAEMON_SESSION_DIR, process.env.PLAYWRIGHT_TRANSFORM_CACHE_DIR,
  process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.npm_config_cache]) {
  if (!directory || !path.isAbsolute(directory) || /^[cC]:/.test(directory)) {
    throw new Error("构建、临时、浏览器、输出及缓存目录必须显式设置在非C盘");
  }
}
const binary = await realpath(values.binary);
const source = await realpath(values.source);
const cli = await realpath(values.cli);
const packaging = values.packaging.split(",");
const entries = values.entries.split(",").map(Number);
if (!packaging.length || new Set(packaging).size !== packaging.length ||
    packaging.some((value) => !["single", "250", "500"].includes(value)) ||
    !entries.length || new Set(entries).size !== entries.length ||
    entries.some((value) => ![65536, 262144].includes(value))) {
  throw new Error("封装候选仅single、250、500；条目仅65536、262144，列表不得重复");
}
await mkdir(output);
await mkdir(path.join(root, "output/playwright"), { recursive: true });
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const save = async (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
const sessionName = `cache-probe-${Date.now()}`;
const manifest = {
  schema: workerTrace ? "worker-startup-comparison-v1" : natural ? "natural-playback-comparison-v1" : "cache-playback-comparison-v2",
  started: new Date().toISOString(), trace: values.trace,
  source_sha256: await digest(source), binary_sha256: await digest(binary),
  repetitions: Number(values.repetitions), trials: [], failures: [], files: {},
  source, policies: natural || workerTrace ? ["direct"] : ["direct", "block-64k", "block-64k-stream"],
  entry_bytes: entries, packaging, progressive: workerTrace ? [false] : [false, true],
  worker_modes: workerTrace ? ["external", "embedded"] : ["external"],
  gate: natural || workerTrace ? "播放器读取前释放，不使用人工阻塞" : "首个视频分片仅保留最后一字节，检测到阻塞后固定等待1200毫秒",
  network_profiles: natural || workerTrace ? [120000, 48000] : null,
  scenarios: natural ? ["abandon", "sustain"] : null,
  production_admitted: false,
};
for (const file of [
  "vedioServer/crates/vs-service/examples/playback_lab.rs",
  "vedioServer/crates/vs-service/examples/support/cache_probe.rs",
  "vedioServer/labs/playback/cache-probe.html", "vedioServer/labs/playback/cache-probe.js",
  "vedioServer/labs/playback/verify-cache-probe.js", "vedioServer/labs/playback/run-cache-probe.mjs",
  "vedioServer/labs/playback/verify-cache-lifecycle.js", "vedioServer/labs/playback/app.css",
  "vedioServer/labs/playback/vendor/hls.min.js", "vedioServer/Cargo.lock",
  "vedioServer/crates/vs-service/src/hls.rs",
  "vedioServer/labs/playback/verify-natural-trace.js", "vedioServer/labs/playback/sample-process.ps1",
  "vedioServer/labs/playback/verify-worker-startup.js",
  "vedioServer/labs/playback/verify-worker-main.js", "vedioServer/labs/playback/app.js",
]) manifest.files[file] = await digest(path.join(root, file));
await save("manifest.json", manifest);

async function cliCommand(args) {
  const child = spawn(process.execPath, [cli, `-s=${sessionName}`, ...args], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 60000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  if (code !== 0) throw new Error(`浏览器命令失败：${stdout}${stderr}`);
  return stdout;
}
async function sampleProcess(pid) {
  const child = spawn(process.platform === "win32" ? "pwsh.exe" : "pwsh", [
    "-NoLogo", "-NoProfile", "-File", path.join(root, "vedioServer/labs/playback/sample-process.ps1"),
    "-TaskProcessId", String(pid),
  ], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "", error = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { error += data; });
  const timer = setTimeout(() => child.kill(), 10000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  if (code !== 0) throw new Error(`实验进程观测失败：${error}`);
  return JSON.parse(output);
}
function parseResult(text) {
  const index = text.indexOf("### Result");
  if (index >= 0) text = text.slice(index + 10).split("\n### ")[0].trim();
  return JSON.parse(text);
}
function listening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(2000, () => { socket.destroy(); resolve(null); });
  });
}
const cells = [];
for (const rate of natural || workerTrace ? [120000, 48000] : [null]) {
  for (const scenario of natural ? ["abandon", "sustain"] : [null]) {
    for (const layout of packaging) for (const entry of entries) for (const progressive of manifest.progressive) {
      for (const policy of manifest.policies) for (const worker of manifest.worker_modes) {
        cells.push({ entry, progressive, policy, layout, rate, scenario, worker });
      }
    }
  }
}
try {
  rounds: for (let round = 0; round < Number(values.repetitions); round++) {
    const order = round % 2 ? [...cells].reverse() : cells;
    for (const cell of order) {
      const id = `${round + 1}-${cell.entry}-${cell.progressive ? "progressive" : "whole"}-${cell.policy}-${cell.layout}` +
        (natural ? `-${cell.rate}-${cell.scenario}` : workerTrace ? `-${cell.rate}-${cell.worker}` : "");
      const directory = path.join(output, id);
      await mkdir(path.join(directory, "published"), { recursive: true });
      const serverEnvironment = { ...process.env, VS_LAB_CACHE_PROBE: cell.policy,
        VS_LAB_CACHE_ENTRY_BYTES: String(cell.entry) };
      if (workerTrace) serverEnvironment.VS_LAB_WORKER_MODE = cell.worker;
      if (cell.layout === "single") delete serverEnvironment.VS_LAB_CHUNK_MS;
      else serverEnvironment.VS_LAB_CHUNK_MS = cell.layout;
      const server = spawn(binary, [path.join(directory, "published"), source, "0"], {
        cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: serverEnvironment,
      });
      const closed = once(server, "close");
      let stdout = "", stderr = "", url = null;
      server.stdout.on("data", (data) => { stdout += data; });
      server.stderr.on("data", (data) => { stderr += data; });
      const trial = { id, round: round + 1, ...cell, pid: server.pid, valid: false };
      try {
        url = await new Promise((resolve, reject) => {
          const started = Date.now();
          const poll = setInterval(() => {
            const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (match || Date.now() - started > 15000 || server.exitCode !== null) {
              clearInterval(poll);
              if (match) resolve(match[0]);
              else reject(new Error("起播实验服务未正常启动"));
            }
          }, 30);
        });
        const probeUrl = `${url}/lab/cache-probe?progressive=${Number(cell.progressive)}` +
          (natural ? `&rate=${cell.rate}&scenario=${cell.scenario}` : workerTrace ? `&rate=${cell.rate}&worker=${cell.worker}` : "");
        await cliCommand(["open", probeUrl,
          "--config", path.join(root, "vedioServer/labs/webrtc/playwright.config.json")]);
        await cliCommand(["snapshot"]);
        if (round === 0 && manifest.trials.length === 0) {
          const lifecycleRaw = await cliCommand(["run-code", "--filename",
            path.join(root, "vedioServer/labs/playback/verify-cache-lifecycle.js")]);
          const lifecycle = parseResult(lifecycleRaw);
          if (!lifecycle.valid) throw new Error("停止后迟到授权回收检查失败");
          await save("lifecycle.json", lifecycle);
          manifest.lifecycle_sha256 = await digest(path.join(output, "lifecycle.json"));
          await cliCommand(["goto", probeUrl]);
          await cliCommand(["snapshot"]);
        }
        const processBefore = natural ? await sampleProcess(server.pid) : null;
        const raw = await cliCommand(["run-code", "--filename",
          path.join(root, workerTrace ? "vedioServer/labs/playback/verify-worker-startup.js" : natural ? "vedioServer/labs/playback/verify-natural-trace.js"
            : "vedioServer/labs/playback/verify-cache-probe.js")]);
        await writeFile(path.join(directory, "browser.log"), raw);
        const receipt = parseResult(raw);
        if (natural) {
          const processAfter = await sampleProcess(server.pid);
          if (processBefore.pid !== processAfter.pid || processBefore.start_time_utc !== processAfter.start_time_utc
              || processBefore.process_name !== processAfter.process_name) {
            throw new Error("实验进程身份改变，拒绝计算资源差值");
          }
          receipt.server_process = {
            before: processBefore, after: processAfter,
            cpu_delta_ms: processAfter.cpu_total_ms - processBefore.cpu_total_ms,
          };
        }
        await save(`${id}/receipt.json`, receipt);
        trial.valid = receipt.valid;
        trial.receipt_sha256 = await digest(path.join(directory, "receipt.json"));
        if (workerTrace) {
          trial.first_frame_ms = receipt.plays.map((play) => play.report.first_frame_ms);
          trial.worker_bytes = receipt.plays.map((play) => play.worker_delivery.yielded_body_bytes);
          trial.media_bytes = receipt.plays.map((play) => play.body.media);
          trial.body_total = receipt.body_total;
        } else if (natural) {
          trial.measures = receipt.measures;
          trial.first_frame_ms = receipt.measures.first_frame_ms;
          trial.server_cpu_ms = receipt.server_process.cpu_delta_ms;
          trial.renderer_task_seconds = receipt.usage.deltas.TaskDuration;
        } else {
          trial.before_release_frames = receipt.before_release_presented_frames;
          trial.first_frame_ms = receipt.first_frame_ms;
          trial.before_release_origin = receipt.snapshots[0].origin;
        }
        trial.packaging_sha256 = await digest(path.join(directory, "published/packaging.json"));
        if (workerTrace && round === 0 && cell.rate === 120000 && cell.worker === "embedded") {
          await cliCommand(["goto", url]);
          await cliCommand(["snapshot"]);
          const smokeRaw = await cliCommand(["run-code", "--filename",
            path.join(root, "vedioServer/labs/playback/verify-worker-main.js")]);
          const smoke = parseResult(smokeRaw);
          await save(`${id}/main-smoke.json`, smoke);
          trial.main_smoke_sha256 = await digest(path.join(directory, "main-smoke.json"));
          if (!smoke.valid) throw new Error("已有播放页面内置工作器接入未通过");
        }
        if (!receipt.valid) manifest.failures.push({ id, failures: receipt.failures });
      } catch (error) {
        trial.error = String(error);
        manifest.failures.push({ id, error: String(error) });
      } finally {
        try { await cliCommand(["close"]); trial.browser_closed = true; }
        catch (error) { trial.browser_closed = false; trial.close_error = String(error); }
        if (server.exitCode === null && server.signalCode === null) server.kill();
        const [code, signal] = await closed;
        trial.process_exit = { code, signal };
        trial.listener_remaining = url ? await listening(Number(new URL(url).port)) : null;
        await writeFile(path.join(directory, "server-stdout.log"), stdout);
        await writeFile(path.join(directory, "server-stderr.log"), stderr);
        if (!trial.browser_closed || trial.listener_remaining !== false) {
          trial.valid = false;
          manifest.failures.push({ id, stage: "cleanup" });
        }
        manifest.trials.push(trial);
        await save("manifest.json", manifest);
      }
      console.log(`${id}：${trial.valid ? "通过" : "未通过"}，` +
        (workerTrace ? `首帧${trial.first_frame_ms?.map(Math.round).join("/")}毫秒，工作器${trial.worker_bytes?.join("/")}字节`
          : natural ? `首帧${Math.round(trial.first_frame_ms ?? 0)}毫秒，正文${trial.measures?.client_cdp_body_bytes ?? "未知"}字节`
          : `尾部释放前帧数${trial.before_release_frames ?? "未知"}`));
      if (trial.error) break rounds;
    }
  }
} finally {
  manifest.finished = new Date().toISOString();
  manifest.all_trials_valid = manifest.failures.length === 0 &&
    manifest.trials.length === Number(values.repetitions) * cells.length;
  await save("manifest.json", manifest);
}
if (!manifest.all_trials_valid) process.exitCode = 1;
