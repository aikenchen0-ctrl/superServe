import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const [mode, directory, ...args] = process.argv.slice(2);
if (!directory || !/^[OD]:[\\/]/i.test(path.resolve(directory))) {
  throw new Error("实验签发资料必须位于O或D盘");
}
const root = path.resolve(directory);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const load = async filename => JSON.parse(await readFile(filename, "utf8"));
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const config = node => ({
  issuer: "https://live-lab.invalid", audience: "video-live",
  tenant_id: "tenant-lab", room_id: "room-lab", node_id: node,
});

if (mode === "prepare") {
  await mkdir(root, { recursive: true });
  const privateFile = path.join(root, "private.pem");
  try {
    await access(privateFile);
    throw new Error("实验密钥已经存在，拒绝覆盖");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "jwk" }).x;
  await writeFile(privateFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx" });
  for (const node of ["node-a", "node-b"]) {
    await save(path.join(root, `${node}.json`), {
      ...config(node), keys: [{ kid: "lab-key", public_key: publicKey }],
    });
  }
  console.log(JSON.stringify({ schema: "live-lab-issuer-v1", directory: root, public_key: publicKey }));
} else {
  const privateKey = createPrivateKey(await readFile(path.join(root, "private.pem")));
  const token = (launch, subject, role, ttl = 120, overrides = {}) => {
    const at = Math.floor(Date.now() / 1000);
    const claims = {
      iss: config(launch.binding.node_id).issuer, aud: "video-live", sub: subject,
      iat: at, nbf: at, exp: at + ttl, ...launch.binding, role, ...overrides,
    };
    const input = `${encode({ alg: "EdDSA", typ: "vs-live+jwt", kid: "lab-key" })}.${encode(claims)}`;
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
  };
  if (mode === "mint") {
    const [launchFile, output, subscriberLifetime, assignmentRevision] = args;
    const launch = await load(launchFile);
    if (!launch.access_required || !launch.binding) throw new Error("节点没有启用直播授权");
    const viewerTtl = subscriberLifetime === undefined ? 120 : Number(subscriberLifetime);
    if (!Number.isInteger(viewerTtl) || viewerTtl < 1 || viewerTtl > 120) throw new Error("实验观看凭据期限须为1至120秒");
    const revisionClaims = assignmentRevision === undefined ? {} : { assignment_revision: Number(assignmentRevision) };
    if (assignmentRevision !== undefined && (!Number.isSafeInteger(revisionClaims.assignment_revision) || revisionClaims.assignment_revision < 1)) {
      throw new Error("分配版本必须是正整数");
    }
    const grants = {
      publisher: token(launch, "alice", "publisher", 120, revisionClaims),
      "viewer-1": token(launch, "bob", "subscriber", viewerTtl, revisionClaims),
      "viewer-2": token(launch, "carol", "subscriber", 120, revisionClaims),
    };
    await save(output, { schema: "live-lab-capabilities-v1", url: launch.url, binding: launch.binding, grants });
    console.log(JSON.stringify({
      schema: "live-lab-mint-v1", output, token_bytes: Object.fromEntries(
        Object.entries(grants).map(([name, value]) => [name, Buffer.byteLength(value)]),
      ),
    }));
  } else if (mode === "browser") {
    const [capabilitiesFile, output] = args;
    const fixture = await load(capabilitiesFile);
    const prepare = async (page, fixture) => {
      if (fixture.schema !== "live-lab-capabilities-v1" || new URL(page.url()).origin !== fixture.url) {
        throw new Error("实验凭据与当前节点不匹配");
      }
      await page.addInitScript(grants => { window.liveCapabilities = grants; }, fixture.grants);
      await page.reload();
      return { schema: "live-lab-browser-access-v1", binding: fixture.binding, credential_count: Object.keys(fixture.grants).length };
    };
    await writeFile(output, `async (page) => (${prepare.toString()})(page, ${JSON.stringify(fixture)})\n`, { flag: "wx" });
    console.log(JSON.stringify({ schema: "live-lab-browser-fixture-v1", output }));
  } else if (mode === "probe") {
    const [currentFile, otherFile, output, previousFile] = args;
    const current = await load(currentFile);
    const other = await load(otherFile);
    const results = [];
    const get = async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
      if (!response.ok) throw new Error("节点观测接口不可用");
      return response.json();
    };
    const baseline = [await get(`${current.url}/lab/metrics`), await get(`${other.url}/lab/metrics`)];
    const check = async (name, launch, method, resource, credential, expected) => {
      const response = await fetch(`${launch.url}${resource}`, {
        method, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), "Content-Type": "application/sdp" },
        body: method === "POST" ? "invalid" : undefined,
        signal: AbortSignal.timeout(3000), redirect: "error",
      });
      await response.arrayBuffer();
      results.push({ name, status: response.status, expected });
      if (response.status !== expected) throw new Error(`直播凭据隔离失败：${name}`);
    };
    const own = token(current, "alice", "publisher");
    await check("anonymous_denied", current, "POST", "/whip", null, 401);
    await check("own_binding_authenticated", current, "GET", "/whip/sessions/missing", own, 404);
    await check("cross_node_denied", other, "GET", "/whip/sessions/missing", own, 401);
    await check("cross_role_denied", current, "POST", "/whep", own, 401);
    await check("cross_tenant_denied", current, "POST", "/whip", token(current,"alice","publisher",120,{tenant_id:"other"}),401);
    await check("cross_room_denied", current, "POST", "/whip", token(current,"alice","publisher",120,{room_id:"other"}),401);
    await check("legacy_write_disabled", current, "POST", "/lab/offer/publisher", own, 404);
    if (previousFile) {
      const previous = await load(previousFile);
      if (previous.binding.incarnation === current.binding.incarnation) throw new Error("节点启动代次没有变化");
      await check("previous_process_denied", current, "POST", "/whip", token(previous,"alice","publisher"),401);
    }
    const after = [await get(`${current.url}/lab/metrics`), await get(`${other.url}/lab/metrics`)];
    if (after.some((value,index) => value.accepted_sessions !== baseline[index].accepted_sessions)) {
      throw new Error("被拒绝的凭据请求占用了媒体会话");
    }
    await save(output, { schema: "live-binding-process-probe-v1", results, baseline, after, same_machine: true, physical_cluster_verified: false });
    console.log(JSON.stringify({ output, checks: results.length, failed: 0, unexpected_sessions: 0 }));
  } else {
    throw new Error("未知实验模式，仅支持prepare、mint、browser或probe");
  }
}
