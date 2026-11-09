const source = document.querySelector("#source");
const context = source.getContext("2d");
const peers = new Map();
const audioMonitors = new Map();
let audioContext;
let oscillator;
let stream;
let animation;
let tick = 0;
let generation = 0;
let running = false;
let busy = false;
let adding = false;
let observed = { frame_callbacks: { "viewer-1": 0, "viewer-2": 0 } };
const audioEnabled = () => new URLSearchParams(window.location.search).get("audio") === "opus";
const parameters = new URLSearchParams(window.location.search);
const discoverIce = window.liveIceDiscovery === true;
const rtcInput = window.liveRtcConfiguration || { iceServers: [], iceTransportPolicy: "all" };
if (!["all", "relay"].includes(rtcInput.iceTransportPolicy) || !Array.isArray(rtcInput.iceServers) ||
    rtcInput.iceServers.length > 4 || rtcInput.iceTransportPolicy === "relay" && !rtcInput.iceServers.length && !discoverIce) {
  throw new Error("ICE配置须指定有限服务器及有效的直连或中继策略");
}
const iceServers = rtcInput.iceServers.map(server => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  if (!urls.length || urls.length > 4 || typeof server.username !== "string" ||
      !server.username.length || server.username.length > 64 ||
      typeof server.credential !== "string" || server.credential.length < 32 || server.credential.length > 128) {
    throw new Error("TURN服务器或凭据超出当前接入范围");
  }
  for (const value of urls) {
    if (typeof value !== "string" || !value.startsWith("turn:")) throw new Error("当前TURN实验只接受UDP根地址");
    const url = new URL(`udp://${value.slice(5)}`);
    if (!url.hostname || !url.port || url.username || url.password || url.pathname ||
        url.search !== "?transport=udp" || url.hash) throw new Error("TURN实验地址格式无效");
  }
  return { urls: [...urls], username: server.username, credential: server.credential };
});
const rtcConfiguration = { iceServers, iceTransportPolicy: rtcInput.iceTransportPolicy, bundlePolicy: "max-bundle" };
const signalingRoot = new URL(window.liveSignalingRoot || "./", window.location.href);
if (signalingRoot.username || signalingRoot.password || signalingRoot.search || signalingRoot.hash ||
    signalingRoot.origin !== window.location.origin && signalingRoot.protocol !== "https:") {
  throw new Error("信令根地址须同源或使用明确HTTPS端点");
}
const iceMode = parameters.get("ice") || "complete";
if (!["complete", "trickle"].includes(iceMode)) throw new Error("ICE模式必须为complete或trickle");
const tone = Number(parameters.get("tone") || 440);
const variant = Number(parameters.get("variant") || 0);
if (!Number.isFinite(tone) || tone < 220 || tone > 880 || !Number.isInteger(variant) || variant < 0 || variant > 7) {
  throw new Error("实验音源频率或画面标记无效");
}

function videoCodecs(codec) {
  if (!["vp8", "h264"].includes(codec)) throw new Error("实验编码只支持vp8或h264");
  return RTCRtpReceiver.getCapabilities("video").codecs.filter(capability => {
    if (capability.mimeType.toLowerCase() !== `video/${codec}`) return false;
    if (codec !== "h264") return true;
    const format = new Map((capability.sdpFmtpLine || "").split(";").map(part => part.trim().split("=")));
    return format.get("profile-level-id")?.toLowerCase() === "42e01f" && format.get("packetization-mode") === "1";
  });
}

function draw() {
  context.fillStyle = "#18252a";
  context.fillRect(0, 0, 640, 360);
  const colors = ["#d2e5f0", "#ebbd39", "#43ad83", "#bd4c67"];
  for (let i = 0; i < 4; i++) {
    context.fillStyle = colors[i];
    context.fillRect((tick * (i + 1) * 4 + i * 140) % 740 - 100, i * 90, 160, 90);
  }
  context.fillStyle = "#ffffff";
  context.font = "32px monospace";
  context.fillText(String(tick), 18, 44);
  context.fillStyle = ["#20b080", "#e03050", "#4060e0", "#d0b020",
    "#8040a0", "#20b0c0", "#d07040", "#e080b0"][variant];
  context.fillRect(576, 0, 64, 64);
  tick++;
  animation = requestAnimationFrame(draw);
}

async function exchange(role, pc, name, ownGeneration) {
  const token = window.liveCapabilities?.[name];
  const authorization = token ? { Authorization: `Bearer ${token}` } : {};
  const peer = { pc, resource: null, authorization, ice_closed: false };
  peers.set(name, peer);
  const ice = { mode: iceMode, patches: 0, candidates_sent: 0, mdns_skipped: 0, failures: 0, queue_peak: 0 };
  (observed.ice ||= {})[name] = ice;
  const queued = [];
  const seen = new Set();
  let sending = false;
  const flushIce = async () => {
    if (sending || !peer.resource || peer.ice_closed) return;
    sending = true;
    try {
      while (queued.length && ownGeneration === generation && peers.get(name) === peer && !peer.ice_closed) {
        const candidate = queued.shift();
        const text = pc.localDescription.sdp;
        const ufrag = text.match(/^a=ice-ufrag:([^\r\n]+)$/m)?.[1];
        const password = text.match(/^a=ice-pwd:([^\r\n]+)$/m)?.[1];
        const mid = candidate?.sdpMid ?? pc.getTransceivers()[0].mid;
        const section = text.split(/\r?\nm=/).slice(1).find(section =>
          section.split(/\r?\n/).includes(`a=mid:${mid}`));
        if (!ufrag || !password || !section) throw new Error("本地ICE片段缺少凭据或媒体标识");
        const fragment = `a=ice-ufrag:${ufrag}\r\na=ice-pwd:${password}\r\nm=${section.split(/\r?\n/)[0]}\r\na=mid:${mid}\r\n${candidate ? `a=${candidate.candidate}` : "a=end-of-candidates"}\r\n`;
        const response = await fetch(peer.resource, {
          method: "PATCH",
          headers: { "Content-Type": "application/trickle-ice-sdpfrag", "If-Match": peer.etag, ...peer.authorization },
          body: fragment, redirect: "error",
          signal: AbortSignal.any([peer.iceAbort.signal, AbortSignal.timeout(5000)]),
        });
        if (response.status !== 204) throw new Error(`ICE候选更新失败：${response.status}`);
        ice.patches++;
        ice.candidates_sent += Number(!!candidate);
      }
    } catch (error) {
      if (!peer.ice_closed) { ice.failures++; throw error; }
    } finally { sending = false; }
  };
  if (iceMode === "trickle") {
    peer.iceAbort = new AbortController();
    peer.iceListener = event => {
      if (ownGeneration !== generation || peers.get(name) !== peer || peer.ice_closed) return;
      const candidate = event.candidate?.candidate ? event.candidate : null;
      // 当前服务不解析mDNS；完整ICE仍可向回环候选发起检查并发现对端反射地址。
      if (candidate?.candidate.includes(".local ")) { ice.mdns_skipped++; return; }
      const key = candidate ? `${candidate.sdpMid}:${candidate.candidate}` : "end";
      if (seen.has(key)) return;
      if (seen.size >= 64) { ice.failures++; showError(new Error("ICE候选队列超过预算")); return; }
      seen.add(key);
      queued.push(candidate);
      ice.queue_peak = Math.max(ice.queue_peak, queued.length);
      flushIce().catch(showError);
    };
    pc.addEventListener("icecandidate", peer.iceListener);
  }
  const requestedCodec = new URLSearchParams(window.location.search).get("codec") || "vp8";
  const codecs = videoCodecs(requestedCodec);
  if (!codecs.length) throw new Error(`浏览器不支持${requestedCodec}`);
  pc.getTransceivers()[0].setCodecPreferences(codecs);
  if (audioEnabled()) {
    const opus = RTCRtpReceiver.getCapabilities("audio").codecs.filter(codec =>
      codec.mimeType.toLowerCase() === "audio/opus" && codec.clockRate === 48000 && codec.channels === 2);
    if (!opus.length) throw new Error("浏览器没有Opus基础能力");
    pc.getTransceivers()[1].setCodecPreferences(opus);
  }
  if (discoverIce) {
    if (!token || signalingRoot.protocol !== "https:" || iceServers.length) {
      throw new Error("ICE发现须使用明确HTTPS授权入口，不混用注入凭据");
    }
    const started = performance.now();
    const response = await fetch(new URL(role === "publisher" ? "whip" : "whep", signalingRoot), {
      method: "OPTIONS", headers: authorization, redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200 || response.headers.get("Cache-Control") !== "no-store") {
      throw new Error(`ICE发现失败：${response.status}`);
    }
    const discovered = window.liveParseIceLinks(response.headers.get("Link"), response.headers.get("X-VS-ICE-Expires"));
    if (ownGeneration !== generation || peers.get(name) !== peer) throw new Error("发现期间媒体代次已切换");
    pc.setConfiguration({ ...rtcConfiguration, iceServers: discovered.servers });
    (observed.ice_discovery ||= {})[name] = {
      source: "authenticated-options", status: response.status, server_count: discovered.servers.length,
      expires_unix_seconds: discovered.expires, elapsed_ms: performance.now() - started,
      configured_before_local_description: pc.localDescription === null,
    };
  }
  await pc.setLocalDescription(await pc.createOffer());
  if (iceMode === "complete" && pc.iceGatheringState !== "complete") {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pc.removeEventListener("icegatheringstatechange", onChange); reject(new Error("候选收集超时")); }, 5000);
      function onChange() {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timeout);
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      }
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }
  ice.post_started_before_gather_complete = pc.iceGatheringState !== "complete";
  ice.post_started_ms = performance.now();
  const response = await fetch(new URL(role === "publisher" ? "whip" : "whep", signalingRoot), {
    method: "POST", headers: { "Content-Type": "application/sdp", ...authorization }, body: pc.localDescription.sdp,
    redirect: "error",
  });
  if (response.status !== 201) throw new Error(await response.text());
  const location = response.headers.get("Location");
  if (!location || response.headers.get("Content-Type") !== "application/sdp") {
    throw new Error("协商响应缺少会话地址或SDP类型");
  }
  const resource = new URL(location, response.url);
  if (resource.origin !== signalingRoot.origin || resource.username || resource.password || resource.hash) {
    throw new Error("协商响应中的会话地址越界");
  }
  if (ownGeneration !== generation || peers.get(name)?.pc !== pc) {
    await fetch(resource.href, { method: "DELETE", headers: authorization, redirect: "error" });
    throw new Error("媒体代次已切换");
  }
  peer.resource = resource.href;
  peer.etag = response.headers.get("ETag");
  if (iceMode === "trickle" && (!peer.etag || !/^"[A-Za-z0-9_-]{22}"$/.test(peer.etag))) {
    throw new Error("协商响应缺少有效ICE代次");
  }
  await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
  if (iceMode === "trickle") await flushIce();
  return resource.href;
}

function connection(name, ownGeneration) {
  const pc = new RTCPeerConnection(rtcConfiguration);
  pc.addEventListener("connectionstatechange", () => {
    if (ownGeneration === generation) {
      document.querySelector(`#${name}-state`).textContent = ({
        new: "尚未连接", connecting: "连接中", connected: "已连接",
        disconnected: "连接中断", failed: "连接失败", closed: "已关闭",
      })[pc.connectionState] || "状态未知";
    }
  });
  return pc;
}

async function addSubscriber() {
  const name = ["viewer-1", "viewer-2"].find(value => !peers.has(value));
  if (!name || !running || adding) return;
  adding = true;
  document.querySelector("#add").disabled = true;
  const ownGeneration = generation;
  const pc = connection(name, ownGeneration);
  pc.addTransceiver("video", { direction: "recvonly" });
  if (audioEnabled()) pc.addTransceiver("audio", { direction: "recvonly" });
  pc.addEventListener("track", event => {
    const video = document.querySelector(`#${name}`);
    if (!(video.srcObject instanceof MediaStream)) video.srcObject = new MediaStream();
    video.srcObject.addTrack(event.track);
    video.play().catch(() => {});
    if (event.track.kind === "audio") {
      const input = audioContext.createMediaStreamSource(new MediaStream([event.track]));
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      const silent = audioContext.createGain();
      silent.gain.value = 0;
      input.connect(analyser).connect(silent).connect(audioContext.destination);
      audioMonitors.set(name, { input, analyser, silent });
      return;
    }
    const frame = () => {
      if (ownGeneration !== generation || peers.get(name)?.pc !== pc) return;
      observed.frame_callbacks[name]++;
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  });
  try { await exchange("subscriber", pc, name, ownGeneration); }
  catch (error) {
    pc.close();
    if (peers.get(name)?.pc === pc) await removePeer(name);
    throw error;
  } finally {
    adding = false;
    document.querySelector("#add").disabled = !running || (peers.has("viewer-1") && peers.has("viewer-2"));
  }
}

async function removePeer(name) {
  const peer = peers.get(name);
  if (!peer) return;
  peer.ice_closed = true;
  peer.iceAbort?.abort();
  if (peer.iceListener) peer.pc.removeEventListener("icecandidate", peer.iceListener);
  try {
    if (peer.resource !== null) {
      const response = await fetch(peer.resource, { method: "DELETE", headers: peer.authorization, redirect: "error" });
      if (!response.ok && response.status !== 404) throw new Error(await response.text());
    }
  } finally {
    peer.pc.close();
    if (peers.get(name) === peer) {
      peers.delete(name);
      if (name.startsWith("viewer-")) document.querySelector(`#${name}`).srcObject = null;
      const monitor = audioMonitors.get(name);
      if (monitor) {
        monitor.input.disconnect();
        monitor.analyser.disconnect();
        monitor.silent.disconnect();
        audioMonitors.delete(name);
      }
    }
    document.querySelector("#add").disabled = !running;
  }
}

async function start() {
  if (running || busy) return;
  busy = true;
  document.querySelector("#start").disabled = true;
  const ownGeneration = ++generation;
  observed = { frame_callbacks: { "viewer-1": 0, "viewer-2": 0 }, generation, started_at: performance.now() };
  draw();
  stream = source.captureStream(24);
  const pc = connection("publisher", generation);
  pc.addTransceiver(stream.getVideoTracks()[0], { direction: "sendonly", streams: [stream] });
  try {
    if (audioEnabled()) {
      audioContext = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      await audioContext.resume();
      const output = audioContext.createMediaStreamDestination();
      output.channelCount = 1;
      oscillator = audioContext.createOscillator();
      oscillator.frequency.value = tone;
      const volume = audioContext.createGain();
      volume.gain.value = 0.1;
      oscillator.connect(volume).connect(output);
      oscillator.start();
      const track = output.stream.getAudioTracks()[0];
      stream.addTrack(track);
      pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    }
    await exchange("publisher", pc, "publisher", ownGeneration);
    running = true;
    document.querySelector("#stop").disabled = false;
    document.querySelector("#add").disabled = false;
    await addSubscriber();
    document.querySelector("#status").textContent = "运行中";
  } catch (error) {
    pc.close();
    if (ownGeneration === generation) await stop();
    throw error;
  } finally { busy = false; }
}

async function stop() {
  generation++;
  running = false;
  cancelAnimationFrame(animation);
  stream?.getTracks().forEach(track => track.stop());
  const names = [...peers.keys()].sort((a, b) => Number(a === "publisher") - Number(b === "publisher"));
  let failures = 0;
  for (const name of names) {
    try { await removePeer(name); }
    catch { failures++; }
  }
  observed.cleanup_failures = failures;
  oscillator?.stop();
  oscillator = undefined;
  if (audioContext) {
    await audioContext.close();
    audioContext = undefined;
  }
  document.querySelector("#start").disabled = false;
  document.querySelector("#stop").disabled = true;
  document.querySelector("#add").disabled = true;
  document.querySelector("#status").textContent = failures ? "本机已停止，部分远端回收未确认" : "已停止";
}

function showError(error) { document.querySelector("#status").textContent = error.message; }
document.querySelector("#start").addEventListener("click", () => start().catch(showError));
document.querySelector("#add").addEventListener("click", () => addSubscriber().catch(showError));
document.querySelector("#stop").addEventListener("click", () => stop().catch(showError));

window.liveObservation = async () => {
  const connections = {};
  for (const [name, { pc, resource }] of peers) {
    const stats = [...(await pc.getStats()).values()].filter(entry => [
      "inbound-rtp", "outbound-rtp", "candidate-pair", "local-candidate", "remote-candidate", "transport",
      "codec",
    ].includes(entry.type));
    let audio;
    const monitor = audioMonitors.get(name);
    if (monitor && audioContext?.state === "running") {
      const wave = new Float32Array(monitor.analyser.fftSize);
      monitor.analyser.getFloatTimeDomainData(wave);
      const bins = new Uint8Array(monitor.analyser.frequencyBinCount);
      monitor.analyser.getByteFrequencyData(bins);
      let peak = 0;
      for (let index = 1; index < bins.length; index++) if (bins[index] > bins[peak]) peak = index;
      audio = { rms: Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length),
        peak_hz: peak * audioContext.sampleRate / monitor.analyser.fftSize };
    }
    connections[name] = { resource, connection_state: pc.connectionState, stats, audio };
  }
  return { ...observed, connections, ice_transport_policy: rtcConfiguration.iceTransportPolicy,
    ice_server_count: iceServers.length, server: await fetch("lab/metrics").then(response => response.json()) };
};
window.liveRemoveSubscriber = removePeer;
window.liveRenewSession = async (name, token) => {
  const peer = peers.get(name);
  if (!peer?.resource || typeof token !== "string" || !token) throw new Error("缺少待续权会话或新凭据");
  const started = performance.now();
  const response = await fetch(`${peer.resource}/renew`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`续权失败：${response.status}`);
  const reply = await response.json();
  if (!Number.isSafeInteger(reply.lease_milliseconds) || reply.lease_milliseconds < 0 ||
      reply.lease_milliseconds > 60000 || !Number.isSafeInteger(reply.expires_unix_seconds)) {
    throw new Error("续权回执格式无效");
  }
  if (peers.get(name) !== peer) throw new Error("续权期间媒体代次已切换");
  // 并发响应可能乱序；旧回执不能覆盖较新凭据，也不据HTTP成功重建连接。
  if (reply.expires_unix_seconds >= (peer.grant_expiry || 0)) {
    peer.authorization = { Authorization: `Bearer ${token}` };
    peer.grant_expiry = reply.expires_unix_seconds;
    peer.lease_deadline = started + reply.lease_milliseconds;
  }
  return reply;
};
setInterval(async () => {
  try {
    const stats = await fetch("lab/metrics").then(response => response.json());
    document.querySelector("#metrics").textContent = `连接 ${stats.active_peers} · 收帧 ${stats.encoded_frames_received} · 转发 ${stats.encoded_frames_forwarded} · 丢弃 ${stats.dropped_frames}`;
  } catch {}
}, 1000);
