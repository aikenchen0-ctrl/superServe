import { spawn } from "node:child_process";
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const [binaryRootArg, outputArg, cliArg, ...extra] = process.argv.slice(2);
if (extra.some(value => !["--renewal", "--revocation", "--reclamation", "--h264", "--opus"].includes(value))) throw new Error("未知交接验证扩展");
const binaryRoot = path.resolve(binaryRootArg || "");
const output = path.resolve(outputArg || "");
const cli = path.resolve(cliArg || "");
if (![binaryRoot, output, cli].every(value => /^[OD]:[\\/]/i.test(value))) throw new Error("程序、证据和浏览器工具必须位于O/D盘");
await mkdir(output, { recursive: false });
const coordinatorToken = randomBytes(32).toString("hex");
const controlToken = randomBytes(32).toString("hex");
const cluster = randomUUID();
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "jwk" }).x;
const children = new Map();
const sessions = new Set();
const events = [];
const addresses = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const checkpoint = value => { events.push(value); console.log(JSON.stringify(value)); };
const hide = text => text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<实验凭据已隐藏>")
  .split(coordinatorToken).join("<协调凭据已隐藏>").split(controlToken).join("<控制凭据已隐藏>");

async function reserve(name) {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  addresses.set(name, `127.0.0.1:${listener.address().port}`);
  return listener;
}
const reservations = [];
for (const name of ["c1", "c2", "c3", "node-a", "node-b"]) reservations.push(await reserve(name));
for (const listener of reservations) await new Promise(resolve => listener.close(resolve));
const url = name => `http://${addresses.get(name)}`;
const pageUrl = name => {
  const params = new URLSearchParams();
  if (extra.includes("--h264")) params.set("codec", "h264");
  if (extra.includes("--opus")) params.set("audio", "opus");
  return `${url(name)}${params.size ? `?${params}` : ""}`;
};
const peers = Object.fromEntries([1, 2, 3].map(id => [id, addresses.get(`c${id}`)]));
for (const node of ["node-a", "node-b"]) {
  await save(`${node}-access.json`, {
    issuer: "https://handoff-test.invalid", audience: "live", tenant_id: "tenant",
    room_id: "room", node_id: node, keys: [{ kid: "test-key", public_key: publicKey }],
  });
  await save(`${node}-control.json`, {
    cluster_id: cluster, coordination_endpoints: [url("c1"), url("c2"), url("c3")],
    coordination_token: coordinatorToken, control_token: controlToken,
  });
}
for (const id of [1, 2, 3]) {
  await save(`c${id}.json`, {
    cluster_id: cluster, node_id: id, bind: peers[id], peers, voters: [1, 2, 3],
    data_dir: path.join(output, `data-${id}`), service_token: coordinatorToken,
    media_control: {
      endpoints: { "node-a": addresses.get("node-a"), "node-b": addresses.get("node-b") },
      control_token: controlToken,
    },
  });
}
async function request(name, resource, method = "GET", body, token = coordinatorToken) {
  const response = await fetch(`${url(name)}${resource}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  return { status: response.status, body: result };
}
async function waitFor(predicate, reason, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await sleep(75);
  }
  throw new Error(reason);
}
async function start(name, media = false) {
  const environment = { ...process.env, RUST_LOG: "warn" };
  for (const key of Object.keys(environment)) if (key.startsWith("VS_")) delete environment[key];
  const executable = path.join(binaryRoot, media ? "vs-live.exe" : "vs-coordination.exe");
  if (media) Object.assign(environment, {
    VS_LIVE_BIND: addresses.get(name), VS_LIVE_RUN_SECONDS: "900",
    VS_LIVE_ACCESS_CONFIG: path.join(output, `${name}-access.json`),
    VS_LIVE_ROOM_CONTROL_CONFIG: path.join(output, `${name}-control.json`),
  });
  else Object.assign(environment, { VS_COORDINATION_CONFIG: path.join(output, `${name}.json`), VS_COORDINATION_RUN_SECONDS: "900" });
  const child = spawn(executable, [], { windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
  const closed = new Promise(resolve => child.once("close", resolve));
  children.set(name, { child, closed, logs: () => ({ stdout, stderr }) });
  return waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(hide(stderr.slice(-300)));
    const reply = await request(name, media ? "/lab/node" : "/metrics");
    return reply.status === 200 ? reply.body : null;
  }, `${name}未就绪`);
}
async function stop(name) {
  const owned = children.get(name);
  if (!owned) return;
  if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGKILL");
  await Promise.race([owned.closed, sleep(5000).then(() => { throw new Error(`${name}未退出`); })]);
  const logs = owned.logs();
  await writeFile(path.join(output, `${name}.stdout.log`), hide(logs.stdout));
  await writeFile(path.join(output, `${name}.stderr.log`), hide(logs.stderr));
}
async function command(args, filename) {
  const child = spawn(process.execPath, [cli, ...args], { windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const clean = hide(stdout + stderr);
  await writeFile(path.join(output, filename), clean);
  if (code !== 0) throw new Error(`浏览器步骤失败：${filename}；${clean.slice(-300)}`);
  const match = stdout.match(/### Result\s*([\s\S]*?)\s*### Ran Playwright code/);
  return match ? JSON.parse(match[1]) : null;
}
function issue(binding, revision, sub, role, lifetime) {
  const at = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://handoff-test.invalid", aud: "live", sub, iat: at, nbf: at, exp: at + lifetime,
    ...binding, role, assignment_revision: revision };
  const input = `${encode({ alg: "EdDSA", typ: "vs-live+jwt", kid: "test-key" })}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
function tokens(binding, revision, lifetime = 120) {
  return Object.fromEntries([["publisher", "alice", "publisher"], ["viewer-1", "bob", "subscriber"], ["viewer-2", "carol", "subscriber"]].map(([name, sub, role]) => {
    return [name, issue(binding, revision, sub, role, lifetime)];
  }));
}
const fence = (binding, revision) => ({ cluster_id: cluster, tenant_id: binding.tenant_id, room_id: binding.room_id,
  target: { node_id: binding.node_id, incarnation: binding.incarnation }, revision });
const assign = (binding, expected, operation) => ({ operation: "assign", tenant_id: "tenant", room_id: "room",
  operation_id: operation, expected_revision: expected, target: { node_id: binding.node_id, incarnation: binding.incarnation } });
let receipt;
try {
  for (const name of ["c1", "c2", "c3"]) await start(name);
  assert((await request("c1", "/admin/initialize", "POST")).status === 204, "协调集群初始化失败");
  const leader = await waitFor(async () => {
    for (const name of ["c1", "c2", "c3"]) if ((await request(name, "/metrics")).body.current_leader === Number(name.slice(1))) return name;
    return null;
  }, "没有协调领导者");
  assert((await request(leader, "/raft/vote", "POST", {})).status === 409, "缺少排空策略身份的Raft请求未拒绝");
  const a = (await start("node-a", true)).binding;
  const b = (await start("node-b", true)).binding;
  assert((await request("node-a", "/lab/metrics")).body.assignment_revision === null, "媒体启动没有关闭接入");
  const first = await request(leader, "/v1/rooms/commands", "POST", assign(a, null, "first"));
  assert(first.status === 200, "初始分配失败");
  const revisionA = first.body.record.revision;
  const activation = await request("node-a", "/admin/room/activate", "POST", fence(a, revisionA), controlToken);
  assert(activation.status === 200, "媒体A没有接受已提交分配");
  checkpoint({ phase: "assigned_a", revision: revisionA, target: a.node_id });

  if (extra.includes("--reclamation")) {
    const session = `reclamation-${Date.now()}`;
    sessions.add(session);
    await command([`-s=${session}`, "open", pageUrl("node-a"), "--config", "vedioServer/labs/webrtc/playwright.config.json"], "reclamation-open.log");
    const source = await readFile("vedioServer/labs/webrtc/verify-reclamation.js", "utf8");
    const grants = tokens(a, revisionA);
    const revocations = Array.from({ length: 64 }, (_, index) => issue(a, revisionA, `gc-${index}`, "subscriber", 20));
    const overflow = issue(a, revisionA, "gc-extra", "subscriber", 120);
    const fixture = { url: url("node-a"), fence: fence(a, revisionA), control_token: controlToken };
    for (const phase of ["fill", "reclaim"]) {
      const value = phase === "fill" ? { ...fixture, grants, revocations, extra: overflow } :
        { ...fixture, old: revocations[0], extra: overflow };
      const filename = path.join(output, `reclamation-${phase}-input.js`);
      await writeFile(filename, `async (page) => (${source.trim()})(page,${JSON.stringify(value)},${JSON.stringify(phase)})\n`, { flag: "wx" });
      const result = await command([`-s=${session}`, "run-code", "--filename", filename], `reclamation-${phase}.log`);
      assert(result?.phase === phase, "撤权回收浏览器回执缺失");
      await save(`reclamation-${phase}.json`, result);
      checkpoint({ phase: `reclamation_${phase}_verified` });
    }
    await command([`-s=${session}`, "close"], "reclamation-close.log");
    sessions.delete(session);
  }

  if (extra.includes("--renewal")) {
    const session = `renewal-${Date.now()}`;
    sessions.add(session);
    await command([`-s=${session}`, "open", pageUrl("node-a"), "--config", "vedioServer/labs/webrtc/playwright.config.json"], "renewal-open.log");
    const source = await readFile("vedioServer/labs/webrtc/verify-renewal.js", "utf8");
    const original = tokens(a, revisionA, 70);
    const step = async (phase, fixture) => {
      const filename = path.join(output, `renewal-${phase}-input.js`);
      await writeFile(filename, `async (page) => (${source.trim()})(page,${JSON.stringify(fixture)},${JSON.stringify(phase)})\n`, { flag: "wx" });
      const result = await command([`-s=${session}`, "run-code", "--filename", filename], `renewal-${phase}.log`);
      assert(result?.phase === phase, "续权浏览器回执缺失");
      await save(`renewal-${phase}.json`, result);
      checkpoint({ phase: `renewal_${phase}_verified` });
    };
    await step("begin", { grants: original });
    await sleep(25000);
    const renewed = tokens(a, revisionA, 50);
    await step("renew", { grants: renewed });
    await step("boundary", { original, grants: renewed });
    await step("expire", { grants: tokens(a, revisionA) });
    await command([`-s=${session}`, "close"], "renewal-close.log");
    sessions.delete(session);
  }

  if (extra.includes("--revocation")) {
    const session = `revocation-${Date.now()}`;
    sessions.add(session);
    await command([`-s=${session}`, "open", pageUrl("node-a"), "--config", "vedioServer/labs/webrtc/playwright.config.json"], "revocation-open.log");
    const source = await readFile("vedioServer/labs/webrtc/verify-revocation.js", "utf8");
    const fixture = { url: url("node-a"), other_url: url("node-b"), fence: fence(a, revisionA),
      control_token: controlToken, grants: tokens(a, revisionA), replacement: tokens(a, revisionA, 180)["viewer-1"] };
    const filename = path.join(output, "revocation-input.js");
    await writeFile(filename, `async (page) => (${source.trim()})(page,${JSON.stringify(fixture)})\n`, { flag: "wx" });
    const result = await command([`-s=${session}`, "run-code", "--filename", filename], "revocation.log");
    assert(result?.schema === "live-token-revocation-real-media-v1", "撤权浏览器回执缺失");
    await save("revocation.json", result);
    await command([`-s=${session}`, "close"], "revocation-close.log");
    sessions.delete(session);
    checkpoint({ phase: "exact_token_revocation_media_and_replay_verified" });
  }

  const sessionA = `handoff-a-${Date.now()}`;
  sessions.add(sessionA);
  await command([`-s=${sessionA}`, "open", pageUrl("node-a"), "--config", "vedioServer/labs/webrtc/playwright.config.json"], "browser-a-open.log");
  const verifier = await readFile("vedioServer/labs/webrtc/verify-drain.js", "utf8");
  const fixture = {
    url: url("node-a"), other_url: url("node-b"), coordination_url: url(leader), coordination_token: coordinatorToken,
    control_token: controlToken, grants: tokens(a, revisionA), fence: fence(a, revisionA), other_fence: fence(b, revisionA),
    release_command: { operation: "release", tenant_id: "tenant", room_id: "room", operation_id: "drain-a",
      expected_revision: revisionA, target: first.body.record.owner },
  };
  const bootstrapA = path.join(output, "browser-a-input.js");
  await writeFile(bootstrapA, `async (page) => (${verifier.trim()})(page,${JSON.stringify(fixture)})\n`, { flag: "wx" });
  const drain = await command([`-s=${sessionA}`, "run-code", "--filename", bootstrapA], "browser-drain.log");
  await save("browser-drain.json", drain);
  await command([`-s=${sessionA}`, "close"], "browser-a-close.log");
  sessions.delete(sessionA);
  checkpoint({ phase: "a_drained_and_released", revision: drain.release.record.revision, old_offer_status: drain.old_offer_status });
  const duplicateRelease=await request(leader,"/v1/rooms/commands","POST",fixture.release_command);
  assert(duplicateRelease.status===200 && duplicateRelease.body.outcome==="duplicate","重复释放没有保持原结果");

  const second = await request(leader, "/v1/rooms/commands", "POST", assign(b, drain.release.record.revision, "second"));
  assert(second.status === 200, "排空后分配到B失败");
  const revisionB = second.body.record.revision;
  assert((await request("node-b", "/admin/room/activate", "POST", fence(b, revisionB), controlToken)).status === 200, "媒体B未接受新分配");
  assert((await request("node-b", "/admin/room/drain", "POST", fence(b, revisionA), controlToken)).status === 409, "旧排空命令影响新版本");
  assert((await request("node-a", "/admin/room/activate", "POST", fence(a, revisionA), controlToken)).status === 409, "A重新接受旧分配");
  assert((await request(leader,"/v1/rooms/commands","POST",fixture.release_command)).status===409,"旧释放影响新所有者");
  const sessionB = `handoff-b-${Date.now()}`;
  sessions.add(sessionB);
  await command([`-s=${sessionB}`, "open", pageUrl("node-b"), "--config", "vedioServer/labs/webrtc/playwright.config.json"], "browser-b-open.log");
  const verifyB = await readFile("vedioServer/labs/webrtc/verify-browser.js", "utf8");
  const bootstrapB = path.join(output, "browser-b-input.js");
  await writeFile(bootstrapB, `async (page) => { await page.addInitScript(grants => { window.liveCapabilities = grants; },${JSON.stringify(tokens(b, revisionB))}); await page.reload(); return (${verifyB.trim()})(page,${JSON.stringify(extra.includes("--h264") ? "h264" : "vp8")},${extra.includes("--opus")}); }\n`, { flag: "wx" });
  const playingB = await command([`-s=${sessionB}`, "run-code", "--filename", bootstrapB], "browser-b-run.log");
  await save("browser-b.json", playingB);
  await command([`-s=${sessionB}`, "close"], "browser-b-close.log");
  sessions.delete(sessionB);
  checkpoint({ phase: "reassigned_b_video_verified", revision: revisionB, connected_peers: playingB.first.server.connected_peers });

  await stop("node-b");
  const releaseB = { operation: "release", tenant_id: "tenant", room_id: "room", operation_id: "missing-b",
    expected_revision: revisionB, target: second.body.record.owner };
  const blockedRelease = await request(leader, "/v1/rooms/commands", "POST", releaseB);
  assert([503, 504].includes(blockedRelease.status), "媒体B失联却被直接释放");
  const blockedAssign = await request(leader, "/v1/rooms/commands", "POST", assign(a, revisionB, "unsafe-takeover"));
  const final = await request(leader, "/v1/rooms/tenant/room");
  assert(blockedAssign.status === 409 && final.body.revision === revisionB && final.body.owner.node_id === "node-b", "失联节点被自动抢占");
  checkpoint({ phase: "unreachable_b_blocks_release", release_status: blockedRelease.status, assign_status: blockedAssign.status });
  const binaries = {};
  for (const name of ["vs-live.exe", "vs-coordination.exe"]) binaries[name] = createHash("sha256").update(await readFile(path.join(binaryRoot, name))).digest("hex");
  receipt = { schema: "room-handoff-real-media-v1", passed: true, events, binaries, drain_receipt: "browser-drain.json",
    new_target_receipt: "browser-b.json", opus_verified: extra.includes("--opus"), h264_verified: extra.includes("--h264"), renewal_verified: extra.includes("--renewal"), revocation_verified: extra.includes("--revocation"),
    reclamation_verified: extra.includes("--reclamation"),
    same_machine: true, physical_cluster_verified: false, automatic_failover: false };
} catch (error) {
  receipt = { schema: "room-handoff-real-media-v1", passed: false, error: hide(error.message), events };
  process.exitCode = 1;
} finally {
  for (const session of sessions) {
    try { await command([`-s=${session}`, "close"], `${session}-cleanup.log`); } catch { process.exitCode = 1; }
  }
  receipt.cleanup = [];
  for (const name of children.keys()) {
    try { await stop(name); receipt.cleanup.push({ name, stopped: true }); }
    catch (error) { receipt.cleanup.push({ name, stopped: false, error: error.message }); process.exitCode = 1; }
  }
  receipt.passed = receipt.passed && receipt.cleanup.every(value => value.stopped);
  await save("receipt.json", receipt);
  console.log(JSON.stringify({ passed: receipt.passed, output: path.join(output, "receipt.json"), cleanup: receipt.cleanup }));
}
