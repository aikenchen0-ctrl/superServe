"use strict";

const video = document.querySelector("video");
const playButton = document.getElementById("play");
const stopButton = document.getElementById("stop");
const state = document.getElementById("state");
const parameters = new URLSearchParams(location.search);
const progressive = parameters.get("progressive") === "1";
const workerMode = parameters.get("worker") ?? "external";
if (!["external", "embedded"].includes(workerMode)) throw new Error("工作器候选仅支持external或embedded");
let player = null;
let frameHandle = null;
let report = null;
let generation = 0;
let waitingAt = null;
let completed = true;

function closeWait() {
  if (waitingAt !== null && report) report.stall_ms += performance.now() - waitingAt;
  waitingAt = null;
}

function stop() {
  generation++;
  if (report && !completed) {
    closeWait();
    report.stopped_at_seconds = video.currentTime;
    report.played_ranges = Array.from({ length: video.played.length }, (_, index) =>
      [video.played.start(index), video.played.end(index)]);
    const quality = video.getVideoPlaybackQuality?.();
    report.video_quality = quality ? {
      total_frames: quality.totalVideoFrames, dropped_frames: quality.droppedVideoFrames,
    } : null;
  }
  completed = true;
  if (frameHandle !== null) video.cancelVideoFrameCallback(frameHandle);
  frameHandle = null;
  if (player) player.destroy();
  player = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
  state.textContent = "已停止";
}

function elapsed() {
  return performance.now() - report.started_ms;
}

function frame(_now, metadata) {
  if (!report || !player) return;
  report.first_frame_ms ??= elapsed();
  report.frames += 1;
  report.last_frame_media_seconds = metadata.mediaTime;
  frameHandle = video.requestVideoFrameCallback(frame);
}

playButton.addEventListener("click", async () => {
  stop();
  const epoch = generation;
  playButton.disabled = true;
  report = {
    schema: "cache-playback-probe-v1", progressive_requested: progressive,
    progressive_applied: null, hls_version: Hls.version,
    worker_mode: workerMode, worker_path: null,
    started_ms: performance.now(), first_frame_ms: null, frames: 0,
    first_append_ms: null, loaded: [], appends: 0, errors: [],
    stall_count: 0, stall_ms: 0, stopped_at_seconds: null, played_ranges: [],
    ended: false, video_quality: null,
    scope: "帧回调是浏览器呈现观测，不是物理屏幕出光或原生设备；没有XHR字节计量",
  };
  completed = false;
  try {
    const issued = await fetch("/lab/playback", { method: "POST" });
    if (epoch !== generation) return;
    if (!issued.ok) throw new Error("实验播放授权失败");
    const grant = await issued.json();
    if (epoch !== generation) return;
    player = new Hls({
      progressive, lowLatencyMode: false, enableWorker: true,
      // 内置候选直接使用固定上游包的Blob工作器及引用计数；不另建工作器池。
      workerPath: workerMode === "external" ? "/vendor/hls.worker.js" : null,
      maxBufferLength: 4, maxMaxBufferLength: 6, maxBufferSize: 512 * 1024,
      backBufferLength: 2,
    });
    report.progressive_applied = player.config.progressive;
    report.worker_path = player.config.workerPath;
    player.on(Hls.Events.BUFFER_APPENDED, () => {
      report.first_append_ms ??= elapsed();
      report.appends++;
    });
    player.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      const stats = data.frag.stats;
      if (report.loaded.length < 64) report.loaded.push({
        type: data.frag.type, sequence: data.frag.sn, elapsed_ms: elapsed(),
        body_loaded: stats.loaded, body_total: stats.total,
      });
    });
    player.on(Hls.Events.ERROR, (_event, data) => {
      if (report.errors.length < 32) report.errors.push({
        detail: data.details, fatal: data.fatal, elapsed_ms: elapsed(),
      });
      if (data.fatal) state.textContent = "播放失败";
    });
    player.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {
      state.textContent = "请点击视频播放按钮";
    }));
    if (!video.requestVideoFrameCallback) throw new Error("浏览器不支持视频帧观测");
    frameHandle = video.requestVideoFrameCallback(frame);
    player.attachMedia(video);
    player.loadSource(grant.media_path);
    state.textContent = "加载中";
  } catch (error) {
    if (epoch !== generation) return;
    report.errors.push({ detail: String(error), fatal: true });
    stop();
    state.textContent = "播放失败";
  } finally {
    playButton.disabled = false;
  }
});
stopButton.addEventListener("click", stop);
video.addEventListener("waiting", () => {
  if (!report || completed || video.paused || video.seeking || report.first_frame_ms === null) return;
  if (waitingAt === null) {
    waitingAt = performance.now();
    report.stall_count++;
  }
});
video.addEventListener("playing", () => { closeWait(); state.textContent = "播放中"; });
video.addEventListener("pause", closeWait);
video.addEventListener("seeking", closeWait);
video.addEventListener("ended", () => {
  if (report && !completed) {
    report.ended = true;
    closeWait();
  }
});
window.addEventListener("pagehide", stop);
window.cachePlaybackProbe = () => report ? structuredClone(report) : null;
