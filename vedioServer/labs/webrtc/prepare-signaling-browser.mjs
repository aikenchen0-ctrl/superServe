import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [directory] = process.argv.slice(2);
if (!directory || !/^O:[\\/]/i.test(directory)) throw new Error("浏览器实验目录须为O盘绝对路径");
const root = path.resolve(directory);
const fixture = JSON.parse(await readFile(path.join(root, "browser-fixture.json"), "utf8"));
const origin = new URL(fixture.signaling_root);
if (fixture.schema !== "https-signal-browser-fixture-v1" || origin.protocol !== "https:" ||
    origin.hostname !== fixture.server_name || !/^[A-Za-z0-9+/]{43}=$/.test(fixture.spki_sha256_base64) ||
    !/^[0-9a-fA-F:.]+$/.test(fixture.server_ip)) {
  throw new Error("HTTPS浏览器实验夹具格式无效");
}
const config = {
  browser: {
    browserName: "chromium",
    launchOptions: {
      channel: "chrome", headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--no-proxy-server",
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        `--host-resolver-rules=MAP ${fixture.server_name} ${fixture.server_ip}`,
        `--ignore-certificate-errors-spki-list=${fixture.spki_sha256_base64}`,
      ],
    },
    contextOptions: { viewport: { width: 1440, height: 960 } },
  },
};
const prepare = async (page, fixture) => {
  if (new URL(page.url()).origin !== fixture.url) throw new Error("当前页面与实验节点不符");
  await page.addInitScript(data => {
    window.liveCapabilities = data.grants;
    window.liveSignalingRoot = data.signaling_root;
    window.liveRtcConfiguration = data.rtc_configuration;
    window.liveIceDiscovery = data.ice_discovery === true;
  }, fixture);
  await page.goto(`${fixture.url}/?codec=h264&audio=opus&ice=trickle`);
  return { schema: "https-signal-browser-prepare-v1", signal_origin: new URL(fixture.signaling_root).origin };
};
const source = await readFile(path.join(import.meta.dirname, "verify-browser.js"), "utf8");
const code = `async (page) => {
  const verify = (${source.trim()});
  const result = await verify(page, "h264", true);
  const expected = ${JSON.stringify(origin.origin)};
  if (result.http.exchanges.some(exchange => new URL(exchange.location).origin !== expected ||
      !exchange.authorization_present)) throw new Error("实际协商没有使用受保护HTTPS端点");
  const candidateEvidence = {};
  if (${fixture.ice_discovery === true} &&
      (Object.keys(result.first.ice_discovery || {}).length !== 3 ||
       Object.values(result.first.ice_discovery).some(value => value.source !== "authenticated-options" ||
         value.server_count !== 1 || !value.configured_before_local_description))) {
    throw new Error("三条连接没有在首次ICE收集前完成受保护发现");
  }
  for (const [name, connection] of Object.entries(result.first.connections)) {
    const pair = connection.stats.find(entry => entry.type === "candidate-pair" &&
      entry.state === "succeeded" && entry.nominated);
    const remote = connection.stats.find(entry => entry.id === pair?.remoteCandidateId);
    const local = connection.stats.find(entry => entry.id === pair?.localCandidateId);
    if (!remote || (remote.address || remote.ip) !== ${JSON.stringify(fixture.server_ip)} ||
        remote.port !== ${Number(new URL(`udp://${fixture.media_endpoint}`).port)}) {
      throw new Error("实际ICE选路没有使用指定私网媒体端点：" + name);
    }
    if (${fixture.rtc_configuration?.iceTransportPolicy === "relay"} &&
        (local?.candidateType !== "relay" || !${JSON.stringify(fixture.turn_relay_ports || [])}.includes(local.port))) {
      throw new Error("强制中继模式未选择实际TURN分配端口：" + name);
    }
    candidateEvidence[name] = { remote_address: remote.address || remote.ip,
      remote_port: remote.port, candidate_type: remote.candidateType, protocol: remote.protocol,
      local_candidate_type: local?.candidateType, local_port: local?.port };
  }
  return { schema: "https-signal-browser-v1", signal_origin: expected,
    actual_decoding_verified: true, candidate_evidence: candidateEvidence,
    forced_relay_verified: ${fixture.rtc_configuration?.iceTransportPolicy === "relay"},
    certificate_exception: "仅此实验浏览器的临时服务公钥SPKI，无全局证书忽略或系统信任修改",
    physical_hosts: 1, native_android_ios_verified: false, result };
}\n`;
for (const [filename, value] of [
  ["playwright.config.json", JSON.stringify(config, null, 2)],
  ["prepare.js", `async (page) => (${prepare.toString()})(page, ${JSON.stringify(fixture)})\n`],
  ["verify.js", code],
]) {
  await writeFile(path.join(root, filename), value, { flag: "wx" });
}
console.log(JSON.stringify({ schema: "https-signal-browser-files-v1", directory: root,
  config: path.join(root, "playwright.config.json"), token_count: Object.keys(fixture.grants).length }));
