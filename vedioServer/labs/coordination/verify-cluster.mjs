import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const [binaryArg, directoryArg] = process.argv.slice(2);
const binary = path.resolve(binaryArg || "");
const directory = path.resolve(directoryArg || "");
if (!/^[OD]:[\\/]/i.test(binary) || !/^[OD]:[\\/]/i.test(directory)) throw new Error("实验程序和数据须位于O或D盘");
await mkdir(directory, { recursive: false });
const token = randomBytes(32).toString("hex");
const clusterId = randomUUID();
const nodes = new Map();
const configurations = new Map();
const events = [];
const ports = [];
let phase = "prepare";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const target = node => ({ node_id: node, incarnation: "aaaaaaaaaaaaaaaaaaaaaa" });
const assignment = (operation, room, expected = null, owner = "media-a") => ({
  operation: "assign", tenant_id: "tenant", room_id: room, operation_id: operation,
  expected_revision: expected, target: target(owner),
});

for (let id = 1; id <= 4; id++) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  ports.push({ id, server, port: server.address().port });
}
const peers = Object.fromEntries(ports.map(({ id, port }) => [id, `127.0.0.1:${port}`]));
for (const { server } of ports) await new Promise(resolve => server.close(resolve));
for (let id = 1; id <= 4; id++) {
  const config = { cluster_id: clusterId, node_id: id, bind: peers[id], data_dir: path.join(directory, `node-${id}`), peers, voters: [1, 2, 3], service_token: token };
  const filename = path.join(directory, `node-${id}.json`);
  await writeFile(filename, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  configurations.set(id, filename);
}
const checkpoint = value => {
  events.push({ phase, ...value });
  console.log(JSON.stringify({ phase, ...value }));
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function call(id, resource, method = "GET", body, credential = token) {
  const response = await fetch(`http://${peers[id]}${resource}`, {
    method, redirect: "error", signal: AbortSignal.timeout(4500),
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, body: value };
}
async function start(id) {
  const child = spawn(binary, [], {
    windowsHide: true, env: { ...process.env, VS_COORDINATION_CONFIG: configurations.get(id), VS_COORDINATION_RUN_SECONDS: "900", RUST_LOG: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const generation = (nodes.get(id)?.generation || 0) + 1;
  nodes.set(id, { child, closed, generation, logs: () => ({ stdout, stderr }) });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`协调节点${id}提前退出：${stderr.slice(-600)}`);
    try { if ((await call(id, "/metrics")).status === 200) return; } catch {}
    await sleep(75);
  }
  throw new Error(`协调节点${id}启动超时：${stderr.slice(-600)}`);
}
async function stop(id) {
  const node = nodes.get(id);
  if (!node) return;
  if (node.child.exitCode === null && node.child.signalCode === null) node.child.kill("SIGKILL");
  await Promise.race([node.closed, sleep(5000).then(() => { throw new Error(`协调节点${id}未退出`); })]);
  const { stdout, stderr } = node.logs();
  await writeFile(path.join(directory, `node-${id}-${node.generation}.stdout.log`), stdout);
  await writeFile(path.join(directory, `node-${id}-${node.generation}.stderr.log`), stderr);
}
async function waitFor(task, message, milliseconds = 18000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { const result = await task(); if (result) return result; } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error(`${message}：${last || "状态条件未满足"}`);
}
async function leader(ids = [1, 2, 3]) {
  return waitFor(async () => {
    for (const id of ids) {
      const result = await call(id, "/metrics");
      if (result.status === 200 && result.body.current_leader === id) {
        const read = await call(id, "/v1/rooms/tenant/shared");
        if (read.status === 200) return id;
      }
    }
    return null;
  }, "没有可线性读取的协调领导者");
}
let outcome;
try {
  phase = "initialization";
  for (const id of [1, 2, 3]) await start(id);
  assert((await call(1, "/admin/initialize", "POST")).status === 204, "集群初始化失败");
  let current = await leader();
  assert((await call(current, "/metrics", "GET", undefined, "wrong-token")).status === 401, "匿名协调请求未拒绝");
  const malformed = await call(current, "/v1/rooms/commands", "POST", { operation: "unknown" });
  assert([400, 422].includes(malformed.status) && typeof malformed.body === "string" && malformed.body.includes("协调请求格式"), "协调请求格式错误没有规范响应");
  checkpoint({ leader: current, node_count: 3 });

  phase = "concurrent_assignment";
  const contenders = [assignment("claim-a", "shared"), assignment("claim-b", "shared", null, "media-b")];
  const replies = await Promise.all(contenders.map(command => call(current, "/v1/rooms/commands", "POST", command)));
  assert(replies.filter(value => value.status === 200).length === 1 && replies.filter(value => value.status === 409).length === 1, "并发房间分配没有唯一胜者");
  const winner = replies.findIndex(value => value.status === 200);
  let record = replies[winner].body.record;
  const retry = await call(current, "/v1/rooms/commands", "POST", contenders[winner]);
  assert(retry.status === 200 && retry.body.outcome === "duplicate" && retry.body.record.revision === record.revision, "相同请求没有保持原修订");
  checkpoint({ statuses: replies.map(value => value.status), winner: record.owner.node_id, revision: record.revision });

  phase = "release_and_aba";
  const release = { operation: "release", tenant_id: "tenant", room_id: "shared", operation_id: "release-1", expected_revision: record.revision, target: record.owner };
  const released = await call(current, "/v1/rooms/commands", "POST", release);
  assert(released.status === 200 && released.body.record.owner === null, "带版本释放失败");
  assert((await call(current, "/v1/rooms/commands", "POST", assignment("stale-null", "shared"))).status === 409, "墓碑丢失导致ABA");
  const assigned = await call(current, "/v1/rooms/commands", "POST", assignment("reassign", "shared", released.body.record.revision, "media-c"));
  assert(assigned.status === 200, "按释放版本重新分配失败");
  record = assigned.body.record;
  assert((await call(current, "/v1/rooms/commands", "POST", release)).status === 409, "旧释放请求影响了新所有者");
  assert((await call(current, "/admin/snapshot", "POST")).status === 202, "触发快照失败");
  await waitFor(async () => ((await call(current, "/metrics")).body.purged?.index >= record.revision), "快照和日志压缩未完成");
  checkpoint({ acknowledged_record: record, snapshot_and_purge: true });

  phase = "leader_failure";
  await stop(current);
  let alive = [1, 2, 3].filter(id => id !== current);
  current = await leader(alive);
  const recovered = await call(current, "/v1/rooms/tenant/shared");
  assert(JSON.stringify(recovered.body) === JSON.stringify(record), "领导者失效后已确认分配改变");
  checkpoint({ new_leader: current, preserved_revision: record.revision });

  phase = "minority";
  const other = alive.find(id => id !== current);
  await stop(other);
  await sleep(3500);
  const isolatedRead = await call(current, "/v1/rooms/tenant/shared");
  assert([503, 504].includes(isolatedRead.status), "失去多数派仍返回权威读取");
  const uncertain = await call(current, "/v1/rooms/commands", "POST", assignment("unknown-write", "uncertain"));
  assert([503, 504].includes(uncertain.status), "失去多数派仍确认了分配");
  const saturation = await Promise.all([1, 2, 3, 4].map(index =>
    call(current, "/v1/rooms/commands", "POST", assignment(`bounded-${index}`, `bounded-${index}`))));
  assert(saturation.every(value => [503, 504].includes(value.status)), "少数派预算探针错误确认写入");
  const exhausted = await call(current, "/v1/rooms/commands", "POST", assignment("after-budget", "after-budget"));
  assert(exhausted.status === 503 && typeof exhausted.body === "string" && exhausted.body.includes("提案预算已满"), "超时提案未继续持有写预算");
  checkpoint({ read_status: isolatedRead.status, write_status: uncertain.status,
    write_result: "unknown_no_automatic_retry", outstanding_proposal_limit: 4,
    saturation_statuses: saturation.map(value => value.status), excess_proposal_status: exhausted.status });

  phase = "restore_quorum";
  for (const id of [1, 2, 3]) {
    if (nodes.get(id).child.exitCode !== null || nodes.get(id).child.signalCode !== null) await start(id);
  }
  current = await leader();
  assert(JSON.stringify((await call(current, "/v1/rooms/tenant/shared")).body) === JSON.stringify(record), "恢复多数派改变了已确认分配");
  const unknownAfterRestore = await call(current, "/v1/rooms/tenant/uncertain");
  checkpoint({ leader: current, known_revision: record.revision, unknown_write_observation: unknownAfterRestore.body });

  phase = "all_nodes_restart";
  for (const id of [1, 2, 3]) {
    await waitFor(async () => (await call(id, "/metrics")).body.last_applied?.index >= record.revision, "节点未应用已确认状态");
    await call(id, "/admin/snapshot", "POST");
  }
  for (const id of [1, 2, 3]) await stop(id);
  for (const id of [1, 2, 3]) await start(id);
  current = await leader();
  const afterRestart = await call(current, "/v1/rooms/tenant/shared");
  assert(JSON.stringify(afterRestart.body) === JSON.stringify(record), "全部重启后分配或修订丢失");
  assert((await call(current, "/admin/initialize", "POST")).status === 409, "已有集群错误地重新初始化");
  checkpoint({ leader: current, recovered_revision: record.revision, reinitialization_rejected: true });

  phase = "membership_expansion";
  await start(4);
  assert((await call(current, "/admin/learners/4", "POST")).status === 204, "新增学习节点失败");
  assert((await call(current, "/admin/membership", "POST", { nodes: [1, 2, 3, 4] })).status === 204, "学习节点晋升失败");
  const removed = [1, 2, 3].find(id => id !== current);
  const stableVoters = [1, 2, 3, 4].filter(id => id !== removed);
  assert((await call(current, "/admin/membership", "POST", { nodes: stableVoters })).status === 204, "成员迁移失败");
  current = await leader(stableVoters);
  const scaleWrite = await call(current, "/v1/rooms/commands", "POST", assignment("after-scale", "scale-room"));
  assert(scaleWrite.status === 200, "扩容后写入失败");
  assert(JSON.stringify((await call(current, "/v1/rooms/tenant/shared")).body) === JSON.stringify(record), "扩容改变原房间分配");
  checkpoint({ leader: current, voters: stableVoters, new_revision: scaleWrite.body.record.revision });
  const databaseSizes = {};
  for (const id of [1, 2, 3, 4]) databaseSizes[id] = (await stat(path.join(directory, `node-${id}`, "authority.redb"))).size;
  outcome = { schema: "room-authority-process-admission-v1", passed: true, events, database_logical_bytes: databaseSizes, same_machine: true, physical_cluster_verified: false, media_fencing_integrated: false };
} catch (error) {
  outcome = { schema: "room-authority-process-admission-v1", passed: false, phase, error: error.message, events };
  process.exitCode = 1;
} finally {
  const cleanup = [];
  for (const id of nodes.keys()) {
    try { await stop(id); cleanup.push({ id, stopped: true }); }
    catch (error) { cleanup.push({ id, stopped: false, error: error.message }); process.exitCode = 1; }
  }
  outcome.cleanup = cleanup;
  outcome.passed = outcome.passed && cleanup.every(value => value.stopped);
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(outcome, null, 2) + "\n");
  console.log(JSON.stringify({ passed: outcome.passed, phase, receipt: path.join(directory, "receipt.json"), cleanup }));
}
