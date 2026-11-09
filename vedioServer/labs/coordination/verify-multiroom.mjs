import { spawn } from "node:child_process";
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const [binaryArg, outputArg, cliArg, ...options] = process.argv.slice(2);
if (options.some(value => !["--registry", "--draining", "--admin-cli"].includes(value))) throw new Error("未知多房间验证选项");
const dynamic = options.includes("--registry");
const draining = options.includes("--draining");
const adminCli = options.includes("--admin-cli");
if (draining && !dynamic) throw new Error("节点排空验证必须同时启用--registry");
if (adminCli && !draining) throw new Error("维护CLI验证必须启用--registry --draining");
const [binaryRoot, output, cli] = [binaryArg, outputArg, cliArg].map(value => path.resolve(value || ""));
if (![binaryRoot, output, cli].every(value => /^[OD]:[\\/]/i.test(value))) {
  throw new Error("程序、证据和浏览器工具必须位于O/D盘");
}
await mkdir(output, { recursive: false });
const cluster = randomUUID();
const serviceToken = randomBytes(32).toString("hex");
const controlToken = randomBytes(32).toString("hex");
const key = generateKeyPairSync("ed25519");
const rooms = [
  { tenant_id: "tenant-a", room_id: "room", tone: 330, variant: 0, marker: [32, 176, 128] },
  { tenant_id: "tenant-b", room_id: "room", tone: 550, variant: 1, marker: [224, 48, 80] },
  { tenant_id: "tenant-a", room_id: "other", tone: 770, variant: 2, marker: [64, 96, 224] },
];
const children = new Map();
const generations = [];
const addresses = new Map();
const events = [];
const sourceSha256 = {};
if (adminCli) for (const file of [
  "vedioServer/crates/vs-coordination/src/media_admin.rs",
  "vedioServer/crates/vs-coordination/src/bin/media-admin.rs",
  "vedioServer/crates/vs-coordination/src/lib.rs",
  "vedioServer/crates/vs-coordination/src/network.rs",
  "vedioServer/crates/vs-coordination/src/media_release.rs",
  "vedioServer/crates/vs-coordination/src/main.rs",
  "vedioServer/crates/vs-coordination/src/storage.rs",
  "vedioServer/crates/vs-coordination/Cargo.toml",
  "vedioServer/crates/vs-coordination/tests/media_admin.rs",
  "vedioServer/labs/coordination/verify-multiroom.mjs",
  "vedioServer/labs/webrtc/verify-multiroom.js",
  "vedioServer/Cargo.lock",
]) sourceSha256[file] = createHash("sha256").update(await readFile(file)).digest("hex");
const session = `multiroom-${Date.now()}`;
let browserOpen = false;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assert = (value, message) => { if (!value) throw new Error(message); };
const save = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const hide = value => value
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<实验凭据已隐藏>")
  .split(serviceToken).join("<协调凭据已隐藏>").split(controlToken).join("<控制凭据已隐藏>");
for (const name of ["c1", "c2", "c3", "media", ...(dynamic ? ["media-b"] : [])]) {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  addresses.set(name, `127.0.0.1:${socket.address().port}`);
  await new Promise(resolve => socket.close(resolve));
}
const url = name => `http://${addresses.get(name)}`;
const peers = Object.fromEntries([1, 2, 3].map(id => [id, addresses.get(`c${id}`)]));
for (const id of [1, 2, 3]) await save(`c${id}.json`, {
  cluster_id: cluster, node_id: id, bind: peers[id], peers, voters: [1, 2, 3],
  data_dir: path.join(output, `data-${id}`), service_token: serviceToken,
  media_control: dynamic ? { endpoints: {}, dynamic_nodes: true, control_token: controlToken,
    ...(draining ? { node_draining: true } : {}) } :
    { endpoints: { media: addresses.get("media") }, control_token: controlToken },
});
if (adminCli) await save("media-admin-config.json", {
  cluster_id: cluster, endpoints: Object.values(peers), service_token: serviceToken,
});
await save("media-rooms.json", {
  issuer: "https://multiroom-test.invalid", audience: "live", node_id: "media",
  keys: [{ kid: "key", public_key: key.publicKey.export({ format: "jwk" }).x }],
  rooms: rooms.map(({ tenant_id, room_id }) => ({ tenant_id, room_id })),
});
await save("media-control.json", {
  cluster_id: cluster, coordination_endpoints: [url("c1"), url("c2"), url("c3")],
  coordination_token: serviceToken, control_token: controlToken,
});
if (dynamic) {
  await save("media-b-rooms.json", {
    issuer: "https://multiroom-test.invalid", audience: "live", node_id: "media-b",
    keys: [{ kid: "key", public_key: key.publicKey.export({ format: "jwk" }).x }],
    rooms: (draining ? rooms : [rooms[2]]).map(({ tenant_id, room_id }) => ({ tenant_id, room_id })),
  });
}
async function request(name, resource, method = "GET", body, token = serviceToken, type = "application/json") {
  const response = await fetch(`${url(name)}${resource}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
    body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
    redirect: "error", signal: AbortSignal.timeout(7000),
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, body: value };
}
async function wait(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await sleep(75);
  }
  throw new Error(message);
}
async function start(name, media = false) {
  const environment = { ...process.env, RUST_LOG: "warn" };
  for (const property of Object.keys(environment)) if (property.startsWith("VS_")) delete environment[property];
  Object.assign(environment, media ? {
    VS_LIVE_BIND: addresses.get(name), VS_LIVE_RUN_SECONDS: "900",
    VS_LIVE_ROOMS_CONFIG: path.join(output, `${name}-rooms.json`),
    VS_LIVE_ROOM_CONTROL_CONFIG: path.join(output, "media-control.json"),
  } : { VS_COORDINATION_CONFIG: path.join(output, `${name}.json`), VS_COORDINATION_RUN_SECONDS: "900" });
  const child = spawn(path.join(binaryRoot, media ? "vs-live.exe" : "vs-coordination.exe"), [], {
    windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", value => { logs += value; });
  child.stderr.on("data", value => { logs += value; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const owned = { name, child, closed, logs: () => logs, generation: (children.get(name)?.generation || 0) + 1, stopped: false };
  children.set(name, owned);
  generations.push(owned);
  return wait(async () => {
    const reply = await request(name, media ? "/lab/rooms" : "/metrics", "GET", undefined, media ? controlToken : serviceToken);
    return reply.status === 200 ? reply.body : null;
  }, `${name}未就绪`);
}
async function stop(owned) {
  if (owned.stopped) return;
  if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGKILL");
  await Promise.race([owned.closed, sleep(5000).then(() => { throw new Error("进程未退出"); })]);
  await writeFile(path.join(output, `${owned.name}-${owned.generation}.log`), hide(owned.logs()), { flag: "wx" });
  owned.stopped = true;
}
async function command(args, filename) {
  const child = spawn(process.execPath, [cli, `-s=${session}`, ...args], {
    windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await writeFile(path.join(output, filename), hide(stdout + stderr), { flag: "wx" });
  if (code !== 0) throw new Error(`浏览器步骤失败：${filename}；${hide((stdout + stderr).slice(-400))}`);
  const match = stdout.match(/### Result\s*([\s\S]*?)\s*### Ran Playwright code/);
  return match ? JSON.parse(match[1]) : null;
}
async function maintenance(mode, input, name, expectedExit = 0) {
  const inputPath = path.join(output, `admin-${name}-command.json`);
  if (mode !== "preview") await save(`admin-${name}-command.json`, input);
  const child = spawn(path.join(binaryRoot, "media-admin.exe"), [
    path.join(output, "media-admin-config.json"), mode, mode === "preview" ? input : inputPath,
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const timeout = setTimeout(() => child.kill(), 25000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert(code === expectedExit, `维护CLI退出值不符：${name} ${code} ${hide(stderr)}`);
  const result = JSON.parse(stdout);
  assert(!stdout.includes(serviceToken) && !stderr.includes(serviceToken), "维护CLI输出暴露服务凭据");
  await save(`admin-${name}.json`, { code, result });
  return result;
}
function issue(binding, revision, role, sub) {
  const at = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "EdDSA", typ: "vs-live+jwt", kid: "key" })}.${encode({
    iss: "https://multiroom-test.invalid", aud: "live", iat: at, nbf: at, exp: at + 240,
    ...binding, role, sub, assignment_revision: revision,
  })}`;
  return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString("base64url")}`;
}
let receipt;
try {
  for (const name of ["c1", "c2", "c3"]) await start(name);
  assert((await request("c1", "/admin/initialize", "POST")).status === 204, "协调初始化失败");
  const findLeader = () => wait(async () => {
    for (const name of ["c1", "c2", "c3"]) if ((await request(name, "/metrics")).body.current_leader === Number(name.slice(1))) return name;
  }, "协调领导者未出现");
  let leader = await findLeader();
  const node = await start("media", true);
  assert(node.rooms.length === 3 && node.worker.room_slots === 3 && node.media_workers === 1, "房间或工作器数量无效");
  assert(new Set(node.rooms.map(room => room.stats.udp_port)).size === 1, "多个房间没有共享UDP");
  assert(new Set(node.rooms.map(room => room.binding.incarnation)).size === 1, "多个房间没有共享启动身份");
  const originalCoordinatorPids = Object.fromEntries(["c1", "c2", "c3"].map(name => [name, children.get(name).child.pid]));
  const registrations = new Map();
  const register = async (name, descriptor, scope) => {
    const binding = descriptor.rooms[0].binding;
    const command = {
      operation: "register_media", operation_id: `register-${name}`, expected_revision: null,
      registration: {
        target: { node_id: binding.node_id, incarnation: binding.incarnation },
        endpoint: addresses.get(name),
        rooms: scope.map(({ tenant_id, room_id }) => ({ tenant_id, room_id })),
      },
    };
    const registered = await request(leader, "/v1/media-nodes/commands", "POST", command);
    assert(registered.status === 200 && registered.body.outcome === "applied", "媒体节点登记失败");
    registrations.set(name, { command, record: registered.body.record });
    return registered.body.record;
  };
  if (dynamic) {
    const binding = node.rooms[0].binding;
    const unregistered = await request(leader, "/v1/rooms/commands", "POST", {
      operation: "assign", tenant_id: rooms[0].tenant_id, room_id: rooms[0].room_id,
      operation_id: "before-registration", expected_revision: null,
      target: { node_id: binding.node_id, incarnation: binding.incarnation },
    });
    assert(unregistered.status === 409 && unregistered.body.outcome === "unregistered", "未登记节点取得房间");
    await register("media", node, draining ? rooms : rooms.slice(0, 2));
  }
  const fixture = { node_url: url("media"), stamp: Date.now(), rooms: [] };
  const assignRoom = async (name, descriptor, room) => {
    const entry = descriptor.rooms.find(entry => entry.binding.tenant_id === room.tenant_id && entry.binding.room_id === room.room_id);
    const target = { node_id: entry.binding.node_id, incarnation: entry.binding.incarnation };
    const assigned = await request(leader, "/v1/rooms/commands", "POST", {
      operation: "assign", tenant_id: room.tenant_id, room_id: room.room_id,
      operation_id: `assign-${room.tenant_id}-${room.room_id}`, expected_revision: null, target,
    });
    assert(assigned.status === 200, "房间权威分配失败");
    const revision = assigned.body.record.revision;
    const fence = { cluster_id: cluster, tenant_id: room.tenant_id, room_id: room.room_id, target, revision };
    assert((await request(name, "/admin/room/activate", "POST", fence, controlToken)).status === 200, "按房间激活失败");
    fixture.rooms.push({ ...room, path: entry.path, node: name, node_url: url(name), binding: entry.binding, fence,
      url: `${url(name)}${entry.path}/?audio=opus&codec=h264&tone=${room.tone}&variant=${room.variant}`,
      grants: Object.fromEntries([["publisher", "publisher", "alice"], ["viewer-1", "subscriber", "bob"],
        ["viewer-2", "subscriber", "carol"]].map(([name, role, sub]) => [name, issue(entry.binding, revision, role, sub)])),
    });
  };
  for (const room of dynamic ? rooms.slice(0, 2) : rooms) await assignRoom("media", node, room);
  const source = await readFile("vedioServer/labs/webrtc/verify-multiroom.js", "utf8");
  const step = async phase => {
    const input = path.join(output, `${phase}-input.js`);
    await writeFile(input, `async page => (${source.trim()})(page,${JSON.stringify(fixture)},${JSON.stringify(phase)})\n`, { flag: "wx" });
    const result = await command(["run-code", "--filename", input], `${phase}.log`);
    assert(result?.phase === phase, "缺少多房间浏览器回执");
    await save(`${phase}.json`, result);
    events.push({ phase, verified: true });
    console.log(JSON.stringify({ phase, verified: true }));
    return result;
  };
  browserOpen = true;
  await command(["open", fixture.rooms[0].url, "--config", "vedioServer/labs/webrtc/playwright.config.json"], "open.log");
  const beginning = await step("begin");
  if (dynamic) {
    const newNode = await start("media-b", true);
    await register("media-b", newNode, draining ? rooms : [rooms[2]]);
    assert(["c1", "c2", "c3"].every(name => children.get(name).child.pid === originalCoordinatorPids[name]),
      "在线加入媒体节点却重启了协调进程");
    await assignRoom("media-b", newNode, rooms[2]);
    fixture.other_node = newNode;
    const extended = await step("extend");
    const sameSessions = (before, after) => {
      for (const original of before.results) {
        const current = after.results.find(value => value.path === original.path);
        assert(current, "加入或重启后丢失原房间");
        for (const name of ["publisher", "viewer-1", "viewer-2"]) {
          assert(original.next.connections[name].resource === current.next.connections[name].resource,
            "加入或重启重建了原媒体连接");
        }
        for (const name of ["viewer-1", "viewer-2"]) {
          assert(current.next.frame_callbacks[name] > original.next.frame_callbacks[name],
            "加入或重启后原观看者未继续呈现");
        }
      }
    };
    sameSessions(beginning, extended);
    events.push({ phase: "media_node_added_without_coordinator_restart", verified: true });
    const a = registrations.get("media");
    const remove = {
      operation: "remove_media", operation_id: "remove-active", expected_revision: a.record.revision,
      target: a.command.registration.target,
    };
    const removed = await request(leader, "/v1/media-nodes/commands", "POST", remove);
    assert(removed.status === 409 && removed.body.outcome === "in_use", "持有房间的节点被删除");
    if (adminCli) {
      const blocked = await maintenance("apply", remove, "remove-active-cli", 2);
      assert(blocked.outcome === "in_use" && blocked.service_outcome === null && blocked.writes_sent === 0
        && blocked.observation_stage === "preview" && blocked.observed.owned_rooms.length === 2,
      "Rust维护CLI没有保留预检in_use和权威房间预览");
    }
    const changed = await request(leader, "/v1/media-nodes/commands", "POST", {
      ...a.command, operation_id: "change-active", expected_revision: a.record.revision,
      registration: { ...a.command.registration, endpoint: addresses.get("media-b") },
    });
    assert(changed.status === 409 && changed.body.outcome === "in_use", "持有房间的节点被改址");
    assert((await request(leader, "/v1/media-nodes/commands", "POST", a.command)).body.outcome === "duplicate",
      "登记重试没有保持幂等");
    if (!draining) {
      const disabled = await request(leader, "/v1/media-nodes/commands", "POST", {
        operation: "set_media_draining", operation_id: "disabled-drain",
        expected_revision: a.record.revision, target: a.command.registration.target, draining: true,
      });
      assert(disabled.status === 404, "未启用的节点排空接口仍可写入");
      events.push({ phase: "node-draining-disabled", status: disabled.status });
    } else {
      if (adminCli) {
        const preview = await maintenance("preview", "media", "preview-active");
        assert(preview.cluster_id === cluster && preview.record.revision === a.record.revision
          && preview.owned_rooms.length === 2, "维护预览没有同一节点的两间现有房间");
        const blocked = await maintenance("apply", remove, "remove-in-use", 2);
        assert(blocked.outcome === "in_use" && blocked.writes_sent === 0,
          "维护客户端未在预览有房间时阻止删除");
      }
      const change = async (operation, enabled) => {
        const command = { operation: "set_media_draining", operation_id: operation,
          expected_revision: a.record.revision, target: a.command.registration.target, draining: enabled };
        const applied = adminCli ? await maintenance("apply", command, operation) : null;
        const result = adminCli ? { status: 200, body: {
          outcome: applied.outcome === "confirmed" ? "applied" : applied.outcome,
          record: applied.confirmed_record,
        } } : await request(leader, "/v1/media-nodes/commands", "POST", command);
        assert(result.status === 200 && result.body.outcome === "applied"
          && !!result.body.record.draining === enabled, "节点排空状态写入失败");
        a.record = result.body.record;
        return command;
      };
      const firstDrain = await change("drain-before-maintenance", true);
      if (adminCli) {
        const confirmed = await maintenance("confirm", firstDrain, "confirm-drain");
        const repeated = await maintenance("apply", firstDrain, "repeat-drain");
        assert(confirmed.outcome === "confirmed" && !confirmed.writes_sent
          && repeated.outcome === "confirmed" && !repeated.writes_sent, "维护确认或幂等重跑再次写入");
      }
      assert((await request(leader, "/v1/media-nodes/commands", "POST", firstDrain)).body.outcome === "duplicate",
        "排空标记重试不幂等");
      const targetRoom = fixture.rooms[2];
      const blocked = await request(leader, "/v1/rooms/commands", "POST", {
        operation: "assign", tenant_id: targetRoom.tenant_id, room_id: targetRoom.room_id,
        operation_id: "blocked-by-node-drain", expected_revision: targetRoom.fence.revision,
        target: a.command.registration.target,
      });
      await save("node-draining-blocked.json", blocked);
      assert(blocked.status === 409 && blocked.body.outcome === "node_draining", "排空节点仍接收新分配");
      const oldRoom = fixture.rooms[0];
      const duplicate = await request(leader, "/v1/rooms/commands", "POST", {
        operation: "assign", tenant_id: oldRoom.tenant_id, room_id: oldRoom.room_id,
        operation_id: `assign-${oldRoom.tenant_id}-${oldRoom.room_id}`, expected_revision: null,
        target: oldRoom.fence.target,
      });
      assert(duplicate.status === 200 && duplicate.body.outcome === "duplicate"
        && duplicate.body.record.revision === oldRoom.fence.revision, "节点排空破坏已提交分配重试");
      const ownerBefore = await request(leader, `/v1/room-assignments/${oldRoom.tenant_id}/${oldRoom.room_id}`);
      await step("cordoned");
      await change("resume-before-final-drain", false);
      const resumed = await request(leader, "/v1/rooms/commands", "POST", {
        operation: "assign", tenant_id: targetRoom.tenant_id, room_id: targetRoom.room_id,
        operation_id: "resumed-owner-still-conflicts", expected_revision: targetRoom.fence.revision,
        target: a.command.registration.target,
      });
      await save("node-draining-resumed.json", resumed);
      assert(resumed.status === 409 && resumed.body.outcome === "conflict", "恢复接单改变现有归属");
      const staleMark = await request(leader, "/v1/media-nodes/commands", "POST", firstDrain);
      assert(staleMark.status === 409 && staleMark.body.outcome === "conflict", "陈旧排空命令覆盖恢复");
      await change("drain-for-removal", true);
      const ownerAfter = await request(leader, `/v1/room-assignments/${oldRoom.tenant_id}/${oldRoom.room_id}`);
      assert(JSON.stringify(ownerBefore.body) === JSON.stringify(ownerAfter.body), "节点标记改变房间版本");
      assert((await request(leader, "/admin/snapshot", "POST")).status === 202, "排空标记快照未触发");
      events.push({ phase: "node-draining-active-media", new_assignment: blocked.body.outcome,
        duplicate_assignment: duplicate.body.outcome, resume_preserves_owner: true,
        stale_mark_rejected: true, existing_sessions_preserved: true });
    }
    const beforeRestart = await request(leader, "/v1/media-nodes/media");
    if (draining) assert(beforeRestart.body.record.draining === true, "重启前丢失节点排空标记");
    for (const name of ["c1", "c2", "c3"]) await stop(children.get(name));
    for (const name of ["c1", "c2", "c3"]) await start(name);
    leader = await findLeader();
    const restored = await wait(async () => {
      const value = await request(leader, "/v1/media-nodes/media");
      return value.status === 200 ? value : null;
    }, "重启后无法读取节点名册");
    assert(JSON.stringify(restored.body.record) === JSON.stringify(beforeRestart.body.record), "重启改变已登记节点");
    const restoredMedia = await step("restored");
    if (draining) events.push({ phase: "node-draining-full-restart",
      draining: restored.body.record.draining, registration_revision: restored.body.record.revision });
    sameSessions(extended, restoredMedia);
    await save("registry-restart.json", { before: beforeRestart.body, restored: restored.body,
      existing_sessions_preserved_after_hot_add: true, existing_sessions_preserved_after_full_restart: true,
      original_coordinator_pids: originalCoordinatorPids,
      restarted_coordinator_pids: Object.fromEntries(["c1", "c2", "c3"].map(name => [name, children.get(name).child.pid])) });
  }
  const simultaneous = await request("media", "/lab/rooms", "GET", undefined, controlToken);
  const otherSimultaneous = dynamic ? await request("media-b", "/lab/rooms", "GET", undefined, controlToken) : null;
  const simultaneousPeers = simultaneous.body.rooms.reduce((sum, room) => sum + room.stats.connected_peers, 0) +
    (otherSimultaneous?.body.rooms.reduce((sum, room) => sum + room.stats.connected_peers, 0) || 0);
  assert(simultaneousPeers === 9, "未同时保持九条媒体连接");
  await save("simultaneous.json", simultaneous.body);
  if (otherSimultaneous) await save("other-simultaneous.json", otherSimultaneous.body);
  for (const room of fixture.rooms.slice(1)) {
    assert((await request(room.node, `${room.path}/whip`, "POST", "invalid", fixture.rooms[0].grants.publisher, "application/sdp")).status === 401,
      "跨房间凭据未拒绝");
  }
  const first = fixture.rooms[0];
  const released = await request(leader, "/v1/rooms/commands", "POST", {
    operation: "release", tenant_id: first.tenant_id, room_id: first.room_id,
    operation_id: "release-only-first", expected_revision: first.fence.revision, target: first.fence.target,
  });
  assert(released.status === 200 && released.body.outcome === "applied", "协调排空后释放失败");
  assert((await request("media", "/admin/room/activate", "POST", first.fence, controlToken)).status === 409,
    "旧分配重新激活");
  await step("isolated");
  const beforeRevoke = await request("media", `${fixture.rooms[1].path}/lab/metrics`);
  const revoked = await request("media", "/admin/room/revoke-token", "POST", {
    fence: fixture.rooms[1].fence, role: "publisher", token: fixture.rooms[1].grants.publisher,
  }, controlToken);
  assert(revoked.status === 200 && revoked.body.removed_sessions === 3, "单房间发布者撤权未级联回收");
  await step("revoked");
  if (dynamic) {
    const second = fixture.rooms[1];
    if (draining) {
      const blocked = await request(leader, "/v1/rooms/commands", "POST", {
        operation: "assign", tenant_id: first.tenant_id, room_id: first.room_id,
        operation_id: "released-room-cannot-return", expected_revision: released.body.record.revision,
        target: first.fence.target,
      });
      assert(blocked.status === 409 && blocked.body.outcome === "node_draining"
        && blocked.body.record.owner === null, "释放后的空房间又分配给排空节点");
    }
    const releasedSecond = await request(leader, "/v1/rooms/commands", "POST", {
      operation: "release", tenant_id: second.tenant_id, room_id: second.room_id,
      operation_id: "release-second", expected_revision: second.fence.revision, target: second.fence.target,
    });
    assert(releasedSecond.status === 200 && releasedSecond.body.outcome === "applied", "第二房间释放失败");
    const a = registrations.get("media");
    const command = { operation: "remove_media", operation_id: "remove-empty",
      expected_revision: a.record.revision, target: a.command.registration.target };
    const removedByCli = adminCli ? await maintenance("apply", command, "remove-empty") : null;
    const removed = adminCli ? { status: 200, body: {
      outcome: removedByCli.outcome === "confirmed" ? "applied" : removedByCli.outcome,
      record: removedByCli.confirmed_record,
    } } : await request(leader, "/v1/media-nodes/commands", "POST", command);
    assert(removed.status === 200 && removed.body.record.registration === null, "空节点删除没有留下墓碑");
    assert((await request(leader, "/v1/media-nodes/commands", "POST", command)).body.outcome === "duplicate",
      "节点删除重试没有保留原结果");
    const stale = await request(leader, "/v1/media-nodes/commands", "POST", {
      ...a.command, operation_id: "stale-recreate",
    });
    assert(stale.status === 409 && stale.body.outcome === "conflict", "旧登记覆盖删除墓碑");
    await save("registry-removal.json", { removed, stale });
    if (adminCli) {
      const tombstone = await maintenance("confirm", command, "confirm-removal");
      assert(tombstone.outcome === "confirmed" && tombstone.confirmed_record.registration === null,
        "移除命令没有墓碑读回确认");
      events.push({ phase: "rust-media-admin-cli", preview: true, drain_resume_remove: true,
        in_use_reason_and_authoritative_view_preserved: true,
        no_write_on_reconfirm: true, credentials_not_in_output: true });
    }
    if (draining) {
      const lateMark = await request(leader, "/v1/media-nodes/commands", "POST", {
        operation: "set_media_draining", operation_id: "late-after-removal",
        expected_revision: removed.body.record.revision, target: first.fence.target, draining: false,
      });
      assert(lateMark.status === 409 && lateMark.body.outcome === "conflict", "删除后标记恢复了旧节点");
      const binding = fixture.other_node.rooms.find((room) =>
        room.binding.tenant_id === first.tenant_id && room.binding.room_id === first.room_id);
      const target = { node_id: binding.binding.node_id, incarnation: binding.binding.incarnation };
      const moved = await request(leader, "/v1/rooms/commands", "POST", {
        operation: "assign", tenant_id: first.tenant_id, room_id: first.room_id,
        operation_id: "move-drained-room-to-hot-node", expected_revision: released.body.record.revision, target,
      });
      assert(moved.status === 200 && moved.body.outcome === "applied", "房间未能分配给热加入节点");
      const fence = { ...first.fence, target, revision: moved.body.record.revision };
      assert((await request("media-b", "/admin/room/activate", "POST", fence, controlToken)).status === 200,
        "目标节点未接受新房间版本");
      fixture.rooms[0] = { ...first, path: binding.path, node: "media-b", node_url: url("media-b"),
        binding: binding.binding, fence,
        url: `${url("media-b")}${binding.path}/?audio=opus&codec=h264&tone=${first.tone}&variant=${first.variant}`,
        grants: Object.fromEntries([["publisher", "publisher", "alice"], ["viewer-1", "subscriber", "bob"],
          ["viewer-2", "subscriber", "carol"]].map(([name, role, sub]) => [name, issue(binding.binding, fence.revision, role, sub)])) };
      await step("migrated");
      events.push({ phase: "drained-node-room-migrated", target, revision: fence.revision,
        late_mark: lateMark.body.outcome, physical_migration: false });
    }
  }
  const third = await wait(async () => {
    const result = await request(fixture.rooms[2].node, `${fixture.rooms[2].path}/lab/metrics`);
    return result.body.connected_peers === 3 && result.body.audio_packets_forwarded > 0 ? result.body : null;
  }, "第三房间被撤权波及");
  await save("revocation-isolation.json", { before_revoke: beforeRevoke.body, revoked, third });
  const binaries = {};
  for (const name of ["vs-live.exe", "vs-coordination.exe", ...(adminCli ? ["media-admin.exe"] : [])]) binaries[name] = createHash("sha256")
    .update(await readFile(path.join(binaryRoot, name))).digest("hex");
  receipt = { schema: "live-multiroom-real-media-v1", passed: true, events, binaries,
    source_sha256: sourceSha256,
    simultaneous_rooms: 3, simultaneous_peers: 9, media_workers: dynamic ? 2 : 1, udp_sockets: dynamic ? 2 : 1,
    dynamic_registry_verified: dynamic, full_coordinator_restart_verified: dynamic,
    node_draining_verified: draining, room_reallocated_after_drain: draining,
    media_admin_cli_verified: adminCli,
    hot_added_media_nodes: dynamic ? 1 : 0,
    room_limit: node.capacity, cross_tenant_same_name: true, same_machine: true,
    physical_cluster_verified: false, production_capacity_verified: false };
} catch (error) {
  receipt = { schema: "live-multiroom-real-media-v1", passed: false, error: hide(error.message), events };
  process.exitCode = 1;
} finally {
  if (browserOpen) {
    try { await command(["close"], "close.log"); }
    catch (error) { receipt.browser_cleanup_error = hide(error.message); process.exitCode = 1; }
  }
  receipt.cleanup = [];
  for (const owned of generations) {
    const name = owned.name;
    try {
      await stop(owned);
      receipt.cleanup.push({ name, generation: owned.generation, pid: owned.child.pid, address: addresses.get(name), stopped: true });
    } catch (error) { receipt.cleanup.push({ name, stopped: false, error: hide(error.message) }); process.exitCode = 1; }
  }
  receipt.passed = receipt.passed && !receipt.browser_cleanup_error && receipt.cleanup.every(item => item.stopped);
  await save("receipt.json", receipt);
  console.log(JSON.stringify({ passed: receipt.passed, output: path.join(output, "receipt.json") }));
}
