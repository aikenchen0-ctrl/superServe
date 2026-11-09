import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    binary: { type: "string" }, source: { type: "string" }, cli: { type: "string" },
    output: { type: "string" }, repetitions: { type: "string", default: "2" },
    smoke: { type: "boolean", default: false },
    policies: { type: "string", default: "baseline,keep_inflight,small_window" },
    "wasm-dir": { type: "string" },
    "gate-check": { type: "boolean", default: false },
    "lifecycle-check": { type: "boolean", default: false },
  },
});
if (!values.binary || !values.source || !values.cli || !values.output ||
    !["1", "2", "3"].includes(values.repetitions)) {
  throw new Error("请提供--binary、--source、--cli、--output；--repetitions限定1至3");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const output = path.resolve(values.output);
const daemonRoot = process.env.PWTEST_DAEMON_SESSION_DIR;
for (const directory of [output, process.env.TEMP, process.env.CARGO_TARGET_DIR, daemonRoot,
  process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.npm_config_cache]) {
  if (!directory || !path.isAbsolute(directory) || /^[cC]:/.test(directory)) {
    throw new Error("输出、缓存、构建和临时目录必须显式设置在非C盘；请先加载enter.ps1");
  }
}
const binary = await realpath(values.binary);
const source = await realpath(values.source);
const cli = await realpath(values.cli);
const policies = values.policies.split(",");
if (!policies.length || new Set(policies).size !== policies.length ||
    policies.some((value) => !["baseline", "keep_inflight", "small_window", "rust_time"].includes(value))) {
  throw new Error("候选列表必须为不重复的已知策略");
}
const wasmDirectory = values["wasm-dir"] ? await realpath(values["wasm-dir"]) : null;
if ((policies.includes("rust_time") || values["gate-check"] || values["lifecycle-check"]) && !wasmDirectory) {
  throw new Error("Rust候选需要显式--wasm-dir");
}
await mkdir(output);
await mkdir(path.join(output, "published"));
await mkdir(path.join(root, "output/playwright"), { recursive: true });
const sessionName = `policy-${Date.now()}`;
const redact = (text) => text.replace(/\/v1\/playback\/[^/\s"']+/g, "/v1/playback/[credential]");
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
const manifest = {
  schema: "playback-policy-comparison-v1",
  started_utc: new Date().toISOString(),
  workspace: root,
  output,
  source,
  source_sha256: await digest(source),
  binary_sha256: await digest(binary),
  repetitions: Number(values.repetitions),
  smoke: values.smoke,
  selected_policies: policies,
  network_profiles: [
    { latency_ms: 60, download_bytes_per_second: 120000 },
    { latency_ms: 60, download_bytes_per_second: 48000 },
  ],
  traces: {
    resume: { pause_at_media_seconds: 1.25, pause_ms: 800, stop_at_media_seconds: 6 },
    abandon: { stop_at_media_seconds: 1.25 },
  },
  policies: {
    baseline: { window_seconds: [4, 6], max_buffer_bytes: 524288, pause: "abort" },
    keep_inflight: { window_seconds: [4, 6], max_buffer_bytes: 524288, pause: "finish_inflight" },
    small_window: { window_seconds: [2, 4], max_buffer_bytes: 524288, pause: "finish_inflight" },
    rust_time: {
      window_seconds: [4, 6], max_buffer_bytes: 524288, pause: "finish_inflight",
      time_thresholds: "从固定目录策略读取，预期2/4秒，非逐片RPC",
    },
  },
  timing_tolerance_seconds: 0.15,
  max_trial_ms: 60000,
  first_party_runtime_added: false,
  rust_time_controller_bound: !!wasmDirectory,
  rust_player_adapter_bound: false,
  scope: "相同素材与媒体位置轨迹；Chrome模拟网络；不证明线路流量、RSS、原生或推荐效用",
  files: {},
  trials: [],
  gate_checks: [],
  lifecycle_checks: [],
  failures: [],
};
for (const name of [
  "vedioServer/labs/playback/app.js", "vedioServer/labs/playback/index.html",
  "vedioServer/labs/playback/verify-trace.js", "vedioServer/labs/playback/run-comparison.mjs",
  "vedioServer/labs/playback/verify-browser.js", "vedioServer/labs/playback/vendor/hls.min.js",
  "vedioServer/Cargo.lock",
  "vedioServer/crates/vs-core/src/playback.rs",
  "vedioServer/crates/vs-core/src/upstream/media3_load_control.rs",
  "vedioServer/crates/vs-playback-web/src/lib.rs",
  "vedioServer/labs/playback/verify-rust-lifecycle.js",
]) manifest.files[name] = await digest(path.join(root, name));
if (wasmDirectory) {
  manifest.wasm_assets = {};
  for (const name of ["playback.js", "playback_bg.wasm"]) {
    manifest.wasm_assets[name] = { path: path.join(wasmDirectory, name),
      sha256: await digest(path.join(wasmDirectory, name)) };
  }
}
await save("manifest.json", manifest);

function command(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, `-s=${sessionName}`, ...args], {
      cwd: root, windowsHide: true,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timed_out: timedOut, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}
async function invoke(args) {
  const result = await command(args);
  if (result.code !== 0 || result.timed_out) {
    throw new Error(`浏览器命令失败：${JSON.stringify(result)}`);
  }
  return result;
}
function parseResult(text) {
  // CLI兼容普通文本与--raw结果；不从浏览器页面猜测运行结果。
  const start = text.indexOf("### Result");
  if (start >= 0) text = text.slice(start + "### Result".length).split("\n### ")[0].trim();
  return JSON.parse(text);
}
const serverEnv = { ...process.env };
if (wasmDirectory) serverEnv.VS_PLAYBACK_WASM_DIR = wasmDirectory;
else delete serverEnv.VS_PLAYBACK_WASM_DIR;
const server = spawn(binary, [path.join(output, "published"), source, "0"], {
  cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: serverEnv,
});
const serverClosed = once(server, "close");
let serverLog = "";
let serverErrors = "";
server.stdout.on("data", (data) => { serverLog += data.toString(); });
server.stderr.on("data", (data) => { serverErrors += data.toString(); });
manifest.process_id = server.pid;
let url = null;
try {
  url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("播放服务启动超时"));
    }, 15000);
    const poll = setInterval(() => {
      const match = serverLog.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match || server.exitCode !== null || server.signalCode !== null) {
        clearTimeout(timer);
        clearInterval(poll);
        if (match) resolve(match[0]);
        else reject(new Error("播放服务在启动阶段退出"));
      }
    }, 50);
  });
  manifest.url = url;
  await invoke(["open", url]);
  await invoke(["snapshot"]);
  if (values.smoke) {
    const receipt = await invoke(["run-code", "--filename",
      path.join(root, "vedioServer/labs/playback/verify-browser.js")]);
    await writeFile(path.join(output, "smoke.log"), receipt.stdout + receipt.stderr);
    await save("smoke.json", parseResult(receipt.stdout));
  }
  if (values["gate-check"]) {
    await invoke(["goto", `${url}/?policy=rust_time&scenario=sustain&rate=300000`]);
    const raw = await invoke(["run-code", "--filename",
      path.join(root, "vedioServer/labs/playback/verify-trace.js")]);
    await writeFile(path.join(output, "gate-check.log"), raw.stdout + raw.stderr);
    const receipt = parseResult(raw.stdout);
    await save("gate-check.json", receipt);
    manifest.gate_checks.push({
      valid: receipt.valid, receipt: "gate-check.json",
      sha256: await digest(path.join(output, "gate-check.json")),
    });
    if (!receipt.valid) manifest.failures.push({ id: "gate-check", failures: receipt.failures });
    console.log(`Rust阈值触发验证：${receipt.valid ? "通过" : "未通过"}`);
  }
  if (values["lifecycle-check"]) {
    const raw = await invoke(["run-code", "--filename",
      path.join(root, "vedioServer/labs/playback/verify-rust-lifecycle.js")]);
    await writeFile(path.join(output, "lifecycle-check.log"), raw.stdout + raw.stderr);
    const receipt = parseResult(raw.stdout);
    await save("lifecycle-check.json", receipt);
    manifest.lifecycle_checks.push({
      receipt: "lifecycle-check.json",
      sha256: await digest(path.join(output, "lifecycle-check.json")),
    });
    console.log("Rust自然结束、内容切换与错误回收验证：通过");
  }
  const order = policies;
  for (let repetition = 0; repetition < Number(values.repetitions); repetition++) {
    for (const rate of [120000, 48000]) {
      for (const scenario of ["resume", "abandon"]) {
        const executionOrder = repetition % 2 ? [...order].reverse() : order;
        for (const policy of executionOrder) {
          const id = `${repetition + 1}-${rate}-${scenario}-${policy}`;
          try {
            await invoke(["goto", `${url}/?policy=${policy}&scenario=${scenario}&rate=${rate}`]);
            const raw = await invoke(["run-code", "--filename",
              path.join(root, "vedioServer/labs/playback/verify-trace.js")]);
            await writeFile(path.join(output, `${id}.log`), raw.stdout + raw.stderr);
            const receipt = parseResult(raw.stdout);
            receipt.trial_id = id;
            await save(`${id}.json`, receipt);
            manifest.trials.push({
              id, policy, scenario, rate, repetition: repetition + 1,
              valid: receipt.valid, measures: receipt.measures,
              receipt: `${id}.json`, receipt_sha256: await digest(path.join(output, `${id}.json`)),
            });
            if (!receipt.valid) manifest.failures.push({ id, failures: receipt.failures });
            console.log(`${id}：${receipt.valid ? "通过" : "未通过"}，` +
              `${receipt.measures.client_body_bytes}字节，卡顿${Math.round(receipt.measures.stall_ms)}毫秒`);
          } catch (error) {
            const failure = { id, valid: false, error: redact(String(error)) };
            manifest.trials.push(failure);
            manifest.failures.push(failure);
            await save(`${id}.failure.json`, failure);
            console.log(`${id}：执行失败，已保留证据`);
          }
          await save("manifest.json", manifest);
        }
      }
    }
  }
} catch (error) {
  manifest.failures.push({ stage: "startup_or_smoke", error: redact(String(error)) });
} finally {
  const closed = await command(["close"], 10000);
  manifest.browser_closed = closed.code === 0 && !closed.timed_out;
  if (server.exitCode === null && server.signalCode === null) server.kill();
  const [exitCode, signal] = await serverClosed;
  manifest.process_exit = { code: exitCode, signal };
  manifest.finished_utc = new Date().toISOString();
  await writeFile(path.join(output, "server-stdout.log"), redact(serverLog));
  await writeFile(path.join(output, "server-stderr.log"), redact(serverErrors));
  if (url) {
    manifest.listener_remaining = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(2000, () => { socket.destroy(); resolve(null); });
    });
  }
  manifest.all_trials_valid = manifest.failures.length === 0 &&
    manifest.trials.length === Number(values.repetitions) * policies.length * 4;
  await save("manifest.json", manifest);
  console.log(`实验结束：${manifest.trials.length}组，失败${manifest.failures.length}组；` +
    `服务进程${server.pid}已退出。回执：${path.join(output, "manifest.json")}`);
}
if (!manifest.all_trials_valid || !manifest.browser_closed || manifest.listener_remaining !== false) {
  process.exitCode = 1;
}
