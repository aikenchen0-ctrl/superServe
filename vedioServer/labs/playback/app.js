"use strict";

const video = document.getElementById("video");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const exportButton = document.getElementById("export");
const nativeControl = document.getElementById("native");
const sourceControl = document.getElementById("source");
const policyControl = document.getElementById("policy");
const status = document.getElementById("status");
let hls = null;
let frameHandle = null;
let generation = 0;
let report = null;
let startedAt = 0;
let waitingAt = null;
let completed = false;
let consumptionPosted = false;
let consumptionSubmission = null;
let rustTimeGate = null;
let rustTimeTimer = null;
let rustModulePromise = null;

function newObservationTraceId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

// 固定实验候选；保留基线，避免看到结果后逐次调参。
const POLICIES = Object.freeze({
  baseline: Object.freeze({
    id: "baseline", maxBufferLength: 4, maxMaxBufferLength: 6,
    maxBufferSize: 512 * 1024, pause: "abort",
  }),
  keep_inflight: Object.freeze({
    id: "keep_inflight", maxBufferLength: 4, maxMaxBufferLength: 6,
    maxBufferSize: 512 * 1024, pause: "finish_inflight",
  }),
  small_window: Object.freeze({
    id: "small_window", maxBufferLength: 2, maxMaxBufferLength: 4,
    maxBufferSize: 512 * 1024, pause: "finish_inflight",
  }),
  rust_time: Object.freeze({
    id: "rust_time", maxBufferLength: 4, maxMaxBufferLength: 6,
    maxBufferSize: 512 * 1024, pause: "finish_inflight",
  }),
});

function observationPath(path) {
  const parts = path.split("/");
  if (parts[1] === "v1" && parts[2] === "playback" && parts.length === 6) {
    parts[3] = "[credential]";
  }
  return parts.join("/");
}

function newReport(mode, policy) {
  return {
    schema: "browser-playback-observation-v1",
    mode,
    policy: { ...policy },
    trace_id: null,
    policy_applied: mode === "hlsjs",
    loading_actions: [],
    rust_time_control: null,
    peak_forward_buffer_seconds: 0,
    user_agent: navigator.userAgent,
    hls_version: window.Hls?.version ?? null,
    started_utc: new Date().toISOString(),
    first_frame_callback_ms: null,
    frame_callbacks: 0,
    manifest_updates: 0,
    manifest_end_sequences: [],
    last_frame_media_time: null,
    playhead_seconds: 0,
    played_ranges: [],
    stall_count: 0,
    stall_ms: 0,
    received_body_bytes: 0,
    consumption_events: [],
    consumption_persistence: false,
    consumption_acked_events: 0,
    consumption_submissions: [],
    consumption_submission_unknown: false,
    omitted_consumption_events: 0,
    aborted_requests: 0,
    omitted_request_records: 0,
    requests: [],
    active_requests: 0,
    frame_callback_supported: "requestVideoFrameCallback" in video,
    scope: "浏览器回调不等于物理屏幕出光；XHR正文不含协议开销；原生HLS不提供XHR计数；没有推荐质量结论",
  };
}

function recordLoadingAction(action) {
  if (!report || report.loading_actions.length >= 64) return;
  report.loading_actions.push({
    action,
    elapsed_ms: Math.floor(performance.now() - report.started_at_monotonic_ms),
    position_seconds: video.currentTime,
    active_requests: report.active_requests,
  });
}

function forwardBufferSeconds() {
  for (let index = 0; index < video.buffered.length; index++) {
    if (video.buffered.start(index) <= video.currentTime &&
        video.currentTime < video.buffered.end(index)) {
      return video.buffered.end(index) - video.currentTime;
    }
  }
  return 0;
}

async function initializeRustControl(config, currentReport, epoch) {
  if (!config.rust_time_control) throw new Error("服务尚未启用Rust时间控制资源");
  const began = performance.now();
  const response = await fetch("/lab/policy", { cache: "no-store" });
  if (!response.ok) throw new Error("播放时间策略读取失败");
  const value = await response.json();
  const fields = ["min_buffer_ms", "max_buffer_ms", "start_buffer_ms", "rebuffer_ms", "max_buffer_bytes"];
  if (value.schema !== "playback-policy-v1" || value.controller !== "media3-buffer-v1" ||
      value.catalog_sha256 !== currentReport.catalog_sha256 ||
      Object.keys(value.policy || {}).length !== fields.length ||
      fields.some((key) => !Number.isSafeInteger(value.policy[key]) || value.policy[key] <= 0)) {
    throw new Error("播放时间策略与目录或字段契约不一致");
  }
  const normalized = Object.fromEntries(fields.map((key) => [key, value.policy[key]]));
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalized)));
  const fingerprint = Array.from(new Uint8Array(hash), (item) => item.toString(16).padStart(2, "0")).join("");
  if (fingerprint !== value.policy_sha256) throw new Error("播放时间策略指纹不匹配");
  // 同页并发切换只初始化一次Wasm内存，避免晚到初始化替换已有对象的内存。
  rustModulePromise ??= import("/control/playback.js").then(async (module) => ({
    module, exports: await module.default(),
  }));
  const { module, exports } = await rustModulePromise;
  if (epoch !== generation) return;
  rustTimeGate = new module.BufferTimeGate(value.policy.min_buffer_ms, value.policy.max_buffer_ms);
  currentReport.rust_time_control = {
    engine: "vs-core-time-buffer-v1",
    policy_sha256: fingerprint,
    min_buffer_ms: value.policy.min_buffer_ms,
    max_buffer_ms: value.policy.max_buffer_ms,
    wasm_sha256: config.rust_time_control.wasm_sha256,
    artifact_bytes: config.rust_time_control,
    initialized_ms: performance.now() - began,
    wasm_linear_memory_bytes_at_start: exports.memory.buffer.byteLength,
    policy_fetches: 1,
    decision_rpcs: 0,
    decisions: 0,
    sampled_decisions: [],
    omitted_samples: 0,
    released: false,
    byte_budget_owner: "hlsjs",
    startup_owner: "hlsjs",
  };
}

function releaseRustControl() {
  if (rustTimeTimer !== null) {
    clearInterval(rustTimeTimer);
    rustTimeTimer = null;
  }
  if (rustTimeGate) {
    rustTimeGate.free();
    rustTimeGate = null;
  }
  if (report?.rust_time_control) report.rust_time_control.released = true;
}

function updateRustControl() {
  if (!rustTimeGate || !hls || !report || completed || video.paused || video.seeking) return;
  try {
    // HTMLMediaElement.buffered提供可播放时间范围；不把累计下载字节当成缓冲字节。
    const bufferedMs = Math.floor(forwardBufferSeconds() * 1000);
    const rateMilli = Math.round(video.playbackRate * 1000);
    const load = rustTimeGate.should_load(bufferedMs, rateMilli);
    const control = report.rust_time_control;
    control.decisions++;
    if (control.sampled_decisions.length < 128) {
      control.sampled_decisions.push({
        buffered_ms: bufferedMs, playback_rate_milli: rateMilli,
        load, position_ms: Math.floor(video.currentTime * 1000),
      });
    } else control.omitted_samples++;
    if (load && !hls.bufferingEnabled) {
      hls.resumeBuffering();
      recordLoadingAction("rust_resume_buffering");
    } else if (!load && hls.bufferingEnabled) {
      hls.pauseBuffering();
      recordLoadingAction("rust_pause_buffering");
    }
  } catch {
    report.error = "Rust时间控制反馈或执行失败";
    status.textContent = report.error;
    destroy();
    completed = true;
    startButton.disabled = false;
  }
}

function render() {
  if (!report) return;
  document.getElementById("first-frame").textContent =
    report.first_frame_callback_ms === null ? "—" : `${report.first_frame_callback_ms.toFixed(1)} 毫秒`;
  document.getElementById("position").textContent = `${video.currentTime.toFixed(2)} 秒`;
  document.getElementById("frames").textContent = String(report.frame_callbacks);
  const activeWait = waitingAt === null ? 0 : performance.now() - waitingAt;
  document.getElementById("stalls").textContent =
    `${report.stall_count} / ${Math.round(report.stall_ms + activeWait)} 毫秒`;
  document.getElementById("received").textContent =
    report.mode === "native" ? "原生未测" : `${report.received_body_bytes.toLocaleString()} 字节`;
  document.getElementById("aborted").textContent = String(report.aborted_requests);
  const rows = report.requests.slice(-10).map((request) => {
    const row = document.createElement("tr");
    for (const value of [request.path.slice(-22), request.result, request.received_body_bytes]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.appendChild(cell);
    }
    return row;
  });
  document.getElementById("requests").replaceChildren(...rows);
}

function closeWait() {
  if (waitingAt !== null) {
    report.stall_ms += performance.now() - waitingAt;
    waitingAt = null;
  }
}

function consumptionEvent(observation, current = report) {
  if (!current?.decision_id || current.mode !== "hlsjs") return;
  if (current.consumption_events.length >= 63 && observation.kind !== "progress") {
    current.omitted_consumption_events++;
    return;
  }
  if (current.consumption_events.length >= 64) {
    current.omitted_consumption_events++;
    return;
  }
  const sequence = current.consumption_events.length + 1;
  current.consumption_events.push({
    event_id: `${current.playback_id}-${sequence}`,
    sequence,
    elapsed_ms: Math.floor(performance.now() - current.started_at_monotonic_ms),
    observed_at: Math.floor(Date.now() / 1000),
    observation,
  });
}

function consumptionProgress() {
  if (!report || completed) return;
  consumptionEvent({
    kind: "progress", position_ms: Math.floor(video.currentTime * 1000),
    active_ms: null, rebuffer_ms: Math.floor(report.stall_ms),
    transferred_bytes: report.received_body_bytes, byte_scope: "web_xhr_body",
  });
}

function trackFrames(epoch) {
  if (!("requestVideoFrameCallback" in video)) return;
  frameHandle = video.requestVideoFrameCallback((now, metadata) => {
    if (epoch !== generation || !report || completed) return;
    if (report.first_frame_callback_ms === null) {
      report.first_frame_callback_ms = now - startedAt;
      consumptionEvent({ kind: "first_presentable", signal: "web_video_frame_callback" });
    }
    report.frame_callbacks += 1;
    report.peak_forward_buffer_seconds = Math.max(
      report.peak_forward_buffer_seconds, forwardBufferSeconds());
    report.last_frame_media_time = metadata.mediaTime;
    render();
    trackFrames(epoch);
  });
}

function trackRequest(xhr, url, currentReport) {
  const path = new URL(url, location.href).pathname;
  if (!path.startsWith("/v1/media/") && !path.startsWith("/v1/playback/") && !path.startsWith("/live/lab/")) return;
  if (currentReport.trace_id) xhr.setRequestHeader("x-vs-trace-id", currentReport.trace_id);
  const clockOrigin = currentReport.started_at_monotonic_ms;
  currentReport.active_requests++;
  const request = {
    path: observationPath(path), received_body_bytes: 0, result: "下载中", status: 0,
    playback_id: currentReport.playback_id || null,
    recommendation_request_id: currentReport.recommendation_request_id || null,
    candidate_id: currentReport.candidate_id || null,
    started_ms: performance.now() - clockOrigin, ended_ms: null,
  };
  if (currentReport.requests.length < 256) currentReport.requests.push(request);
  else currentReport.omitted_request_records += 1;
  xhr.addEventListener("progress", (event) => {
    const delta = Math.max(0, event.loaded - request.received_body_bytes);
    request.received_body_bytes += delta;
    currentReport.received_body_bytes += delta;
  });
  let aborted = false;
  xhr.addEventListener("abort", () => { aborted = true; });
  xhr.addEventListener("loadend", () => {
    currentReport.active_requests--;
    request.status = xhr.status;
    let bytes = request.received_body_bytes;
    if (!aborted && xhr.status >= 200 && xhr.status < 300) {
      const body = xhr.response;
      bytes = Math.max(bytes, typeof body === "string"
        ? new TextEncoder().encode(body).byteLength : body?.byteLength ?? 0);
    }
    currentReport.received_body_bytes += bytes - request.received_body_bytes;
    request.received_body_bytes = bytes;
    request.result = aborted ? "已取消" : xhr.status >= 200 && xhr.status < 300 ? "完成" : "失败";
    request.ended_ms = performance.now() - clockOrigin;
    if (aborted) currentReport.aborted_requests += 1;
    render();
  });
}

function destroy() {
  generation += 1;
  releaseRustControl();
  if (frameHandle !== null && video.cancelVideoFrameCallback) {
    video.cancelVideoFrameCallback(frameHandle);
    frameHandle = null;
  }
  if (report) closeWait();
  if (report && !completed) consumptionProgress();
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.pause();
  video.removeAttribute("src");
  video.load();
}

async function start() {
  startButton.disabled = true;
  destroy();
  completed = false;
  const epoch = generation;
  const mode = nativeControl.checked ? "native" : "hlsjs";
  const policy = sourceControl.value === "live"
    ? POLICIES.baseline : POLICIES[policyControl.value] ?? POLICIES.baseline;
  report = newReport(mode, policy);
  consumptionPosted = false;
  consumptionSubmission = null;
  const currentReport = report;
  const requestedTraceId = newObservationTraceId();
  currentReport.trace_id_requested = requestedTraceId;
  startedAt = performance.now();
  currentReport.started_at_monotonic_ms = startedAt;
  currentReport.generation = epoch;
  currentReport.delivery_mode = sourceControl.value;
  status.textContent = "加载中";
  stopButton.disabled = false;
  exportButton.disabled = false;
  try {
    const response = await fetch("/lab/config", { cache: "no-store" });
    if (!response.ok) throw new Error("配置读取失败");
    const config = await response.json();
    if (epoch !== generation) return;
    currentReport.worker_mode = config.worker_mode;
    currentReport.consumption_persistence = config.consumption_persistence === true;
    sourceControl.querySelector('[value="live"]').disabled = !config.live_media_path;
    let mediaPath = config.live_media_path;
    if (currentReport.delivery_mode !== "live") {
      const issued = await fetch("/lab/playback", {
        method: "POST",
        headers: { "x-vs-trace-id": requestedTraceId },
      });
      if (!issued.ok) throw new Error("播放授权申请失败");
      const grant = await issued.json();
      if (epoch !== generation) return;
      currentReport.trace_id = issued.headers.get("x-vs-trace-id");
      mediaPath = grant.media_path;
      currentReport.playback_id = grant.playback_id;
      currentReport.candidate_id = grant.candidate_id;
      currentReport.catalog_sha256 = grant.catalog_sha256;
      currentReport.decision_id = grant.decision_id || null;
      currentReport.recommendation_request_id = grant.recommendation_request_id || null;
      currentReport.grant_expires_at = grant.expires_at;
      currentReport.consumption_generation = grant.consumption_generation ?? epoch;
      if (currentReport.consumption_persistence) consumptionProgress();
    }
    if (!mediaPath) throw new Error("直播实验尚未启用");
    currentReport.media_path = observationPath(mediaPath);
    currentReport.server_before = await fetch("/lab/metrics").then((value) => value.json());
    if (epoch !== generation) return;
    if (policy.id === "rust_time" && mode === "hlsjs") {
      await initializeRustControl(config, currentReport, epoch);
      if (epoch !== generation) return;
    }
    trackFrames(epoch);
    if (mode === "native") {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) {
        throw new Error("当前浏览器不支持原生 HLS");
      }
      video.src = mediaPath;
      await video.play();
    } else {
      if (!Hls.isSupported()) throw new Error("当前浏览器不支持媒体源扩展");
      hls = new Hls({
        workerPath: config.worker_mode === "embedded" ? null : "/vendor/hls.worker.js",
        maxBufferLength: policy.maxBufferLength,
        maxMaxBufferLength: policy.maxMaxBufferLength,
        maxBufferSize: policy.maxBufferSize,
        backBufferLength: 2,
        lowLatencyMode: false,
        cmcd: currentReport.playback_id ? {
          sessionId: currentReport.playback_id,
          contentId: currentReport.candidate_id,
          useHeaders: true,
          version: 1,
          // 排除nor/nrr等URL提示，签名路径只留在实际媒体请求，不进入遥测。
          includeKeys: ["sid", "cid", "bl", "br", "d", "ot", "su", "bs", "v", "vs-rid"],
          reporterCallback: (reporter) => {
            reporter.updateCustomData({ "vs-rid": currentReport.recommendation_request_id });
          },
        } : undefined,
        xhrSetup: (xhr, url) => trackRequest(xhr, url, currentReport),
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && epoch === generation) {
          status.textContent = `播放失败：${data.details}`;
          currentReport.error = data.details;
          completed = true;
          releaseRustControl();
          closeWait();
          hls.stopLoad();
          video.pause();
          startButton.disabled = false;
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (epoch !== generation) return;
        video.play().catch(() => {
          status.textContent = "请点击视频播放按钮";
        });
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (epoch !== generation) return;
        currentReport.manifest_updates += 1;
        if (currentReport.manifest_end_sequences.length < 64) {
          currentReport.manifest_end_sequences.push(data.details.endSN);
        }
        currentReport.playlist_is_live = data.details.live;
      });
      if (rustTimeGate) {
        hls.on(Hls.Events.FRAG_BUFFERED, updateRustControl);
        rustTimeTimer = setInterval(updateRustControl, 100);
      }
      hls.loadSource(mediaPath);
      hls.attachMedia(video);
    }
    startButton.textContent = "重新播放";
    startButton.disabled = false;
  } catch (error) {
    if (epoch !== generation) return;
    status.textContent = error.message;
    currentReport.error = error.message;
    destroy();
    completed = true;
    startButton.disabled = false;
    stopButton.disabled = true;
  }
  render();
}

video.addEventListener("waiting", () => {
  if (!report || completed || video.paused || video.seeking || report.first_frame_callback_ms === null) return;
  if (waitingAt === null) {
    report.stall_count += 1;
    waitingAt = performance.now();
  }
});
video.addEventListener("seeking", () => {
  closeWait();
  if (rustTimeGate && hls) {
    rustTimeGate.reset();
    // 新位置可能没有任何缓冲，必须先恢复取片，不能等待依赖新数据的seeked事件。
    hls.resumeBuffering();
    recordLoadingAction("rust_seek_resume_buffering");
  }
});
video.addEventListener("seeked", () => {
  if (rustTimeGate && hls && video.paused) {
    hls.pauseBuffering();
    recordLoadingAction("rust_seek_pause_buffering");
  } else updateRustControl();
});
video.addEventListener("ratechange", updateRustControl);
video.addEventListener("playing", () => {
  if (!report || completed) return;
  closeWait();
  status.textContent = "播放中";
});
video.addEventListener("play", () => {
  if (!report || completed || !hls) return;
  if (report.policy.pause === "finish_inflight" && hls.loadingEnabled) {
    hls.resumeBuffering();
    recordLoadingAction("resume_buffering");
    updateRustControl();
  } else {
    hls.startLoad(video.currentTime);
    recordLoadingAction("start_load");
  }
});
video.addEventListener("pause", () => {
  if (!report || completed) return;
  closeWait();
  if (hls) {
    // 临时暂停允许在途片段完成；停止和切换仍由destroy立即取消全部读取。
    if (report.policy.pause === "finish_inflight") {
      hls.pauseBuffering();
      recordLoadingAction("pause_buffering");
    } else {
      hls.stopLoad();
      recordLoadingAction("stop_load");
    }
  }
  consumptionProgress();
  status.textContent = "已暂停";
});
video.addEventListener("timeupdate", () => {
  if (!report || completed) return;
  report.playhead_seconds = video.currentTime;
  report.played_ranges = Array.from({ length: video.played.length }, (_, index) =>
    [video.played.start(index), video.played.end(index)]);
  render();
});
video.addEventListener("ended", () => {
  if (!report || completed) return;
  closeWait();
  consumptionProgress();
  completed = true;
  releaseRustControl();
  if (hls) hls.stopLoad();
  report.ended = true;
  status.textContent = "播放结束";
  render();
});
startButton.addEventListener("click", start);
sourceControl.addEventListener("change", () => {
  if (report && !completed) start();
});
policyControl.addEventListener("change", () => {
  if (report && !completed) start();
});
stopButton.addEventListener("click", () => {
  if (report) {
    report.stopped_at_seconds = video.currentTime;
    report.playhead_seconds = video.currentTime;
    report.played_ranges = Array.from({ length: video.played.length }, (_, index) =>
      [video.played.start(index), video.played.end(index)]);
  }
  destroy();
  completed = true;
  status.textContent = "已停止";
  stopButton.disabled = true;
  startButton.disabled = false;
  render();
});
exportButton.addEventListener("click", async () => {
  const currentReport = report;
  currentReport.server_after = await fetch("/lab/metrics").then((value) => value.json());
  const blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "playback-observation.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("pagehide", destroy);

// 仅公开观测快照供浏览器验收；不包含内部凭证，也不写入用户画像。
window.playbackObservation = () => report ? structuredClone(report) : null;
window.playbackConsumption = () => {
  if (!report?.decision_id || report.mode !== "hlsjs" || !completed || report.active_requests !== 0) return null;
  if (report.sealed_consumption) return structuredClone(report.sealed_consumption);
  consumptionEvent({
    kind: "progress", position_ms: Math.floor((report.stopped_at_seconds ?? report.playhead_seconds) * 1000),
    active_ms: null, rebuffer_ms: Math.floor(report.stall_ms),
    transferred_bytes: report.received_body_bytes, byte_scope: "web_xhr_body",
  });
  report.sealed_consumption = {
    schema: "client-consumption-v1", source_id: "playback-lab", data_kind: "synthetic",
    platform: "web", subject: "local-lab-viewer", decision_id: report.decision_id,
    candidate_id: report.candidate_id, interaction_id: report.playback_id,
    generation: report.consumption_generation ?? report.generation,
    events: structuredClone(report.consumption_events),
  };
  return structuredClone(report.sealed_consumption);
};

function consumptionBatch(current, events) {
  return {
    schema: "client-consumption-v1", source_id: "playback-lab", data_kind: "synthetic",
    platform: "web", subject: "local-lab-viewer", decision_id: current.decision_id,
    candidate_id: current.candidate_id, interaction_id: current.playback_id,
    generation: current.consumption_generation ?? current.generation,
    events: structuredClone(events),
  };
}

async function submitConsumptionBatch(current, batch, sealed) {
  if (current.consumption_submission_unknown) throw new Error("上次消费提交结果未知，不自动重试");
  if (consumptionSubmission) return consumptionSubmission;
  batch = structuredClone(batch);
  const end = current.consumption_acked_events + batch.events.length;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const pending = (async () => {
    try {
      const response = await fetch("/lab/consumption", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`消费提交失败，结果未知：${response.status}`);
      const result = await response.json();
      if (result.schema !== "playback-lab-consumption-v1" ||
          (current.consumption_persistence &&
           (result.persisted !== true || result.commit?.durability !== "persisted" ||
            !Number.isSafeInteger(result.commit.base_offset) || result.commit.base_offset < 0))) {
        throw new Error("消费确认无效，结果未知");
      }
      current.consumption_acked_events = end;
      current.consumption_submissions.push({
        first_sequence: batch.events[0].sequence,
        last_sequence: batch.events.at(-1).sequence,
        base_offset: result.commit?.base_offset ?? null,
        persisted: result.persisted,
      });
      if (sealed && current === report) consumptionPosted = true;
      return result;
    } catch (error) {
      current.consumption_submission_unknown = true;
      throw error;
    } finally { clearTimeout(timeout); }
  })();
  consumptionSubmission = pending;
  try { return await pending; }
  finally { if (consumptionSubmission === pending) consumptionSubmission = null; }
}

window.submitPlaybackCheckpoint = async () => {
  const current = report;
  if (!current?.consumption_persistence || !current.decision_id ||
      current.mode !== "hlsjs" || completed || current.sealed_consumption) return null;
  if (consumptionSubmission) return consumptionSubmission;
  consumptionProgress();
  const events = current.consumption_events.slice(current.consumption_acked_events);
  if (!events.length) return null;
  return submitConsumptionBatch(current, consumptionBatch(current, events), false);
};

window.submitPlaybackConsumption = async () => {
  if (consumptionSubmission) throw new Error("消费检查点仍在提交，请等待其结束");
  const batch = window.playbackConsumption();
  if (!batch || consumptionPosted) return null;
  const events = batch.events.slice(report.consumption_acked_events);
  if (!events.length) return null;
  return submitConsumptionBatch(report, consumptionBatch(report, events), true);
};
status.textContent = "待播放";
startButton.disabled = false;
const requestedPolicy = new URLSearchParams(location.search).get("policy");
if (Object.hasOwn(POLICIES, requestedPolicy)) policyControl.value = requestedPolicy;
fetch("/lab/config").then((response) => response.json()).then((config) => {
  sourceControl.querySelector('[value="live"]').disabled = !config.live_media_path;
  policyControl.querySelector('[value="rust_time"]').disabled = !config.rust_time_control;
}).catch(() => { status.textContent = "配置读取失败"; });
