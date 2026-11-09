async (page) => {
  const query = new URL(page.url()).searchParams;
  const mode = query.get("worker");
  const rate = Number(query.get("rate"));
  if (!["external", "embedded"].includes(mode) || ![120000, 48000].includes(rate)) {
    throw new Error("工作器对照参数无效");
  }
  const session = await page.context().newCDPSession(page);
  const requests = new Map();
  let phase = "bootstrap";
  await page.addInitScript(() => {
    // 仅观测原生工作器；不改变消息、引用计数、终止时机或源脚本。
    const OriginalWorker = window.Worker;
    const state = { created: [], initialized: [], terminated: [], errors: [] };
    window.workerLifecycleProbe = state;
    window.Worker = class extends OriginalWorker {
      constructor(url, options) {
        super(url, options);
        this.probeId = state.created.length;
        state.created.push({ id: this.probeId, blob: String(url).startsWith("blob:"),
          path: String(url).startsWith("blob:") ? "blob:" : new URL(url, location.href).pathname });
        this.addEventListener("message", (event) => {
          if (event.data?.event === "init") state.initialized.push({
            id: this.probeId, instance: event.data.instanceNo,
          });
        });
        this.addEventListener("error", () => { state.errors.push(this.probeId); });
      }
      terminate() {
        state.terminated.push(this.probeId);
        super.terminate();
      }
    };
  });
  const redact = (url) => new URL(url).pathname.replace(/\/v1\/playback\/[^/]+/, "/v1/playback/[credential]");
  const category = (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/vendor/hls.worker.js") return "worker";
    if (/\/v1\/playback\//.test(pathname)) return "media";
    if (["/vendor/hls.min.js", "/lab/cache-probe.js", "/app.css", "/lab/cache-probe"].includes(pathname)) return "bootstrap";
    return "control";
  };
  const totals = (filterPhase) => {
    const result = { bootstrap: 0, worker: 0, media: 0, control: 0 };
    for (const row of requests.values()) {
      if (filterPhase === undefined || row.phase === filterPhase) {
        if (row.category === "worker") result.worker = null;
        else result[row.category] += row.decoded_body_bytes;
      }
    }
    return result;
  };
  try {
    await session.send("Network.enable");
    await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    session.on("Network.requestWillBeSent", (event) => {
      if (!event.request.url.startsWith(new URL(page.url()).origin)) return;
      requests.set(event.requestId, { phase, category: category(event.request.url),
        path: redact(event.request.url), decoded_body_bytes: 0, ended: false, failed: false });
    });
    session.on("Network.dataReceived", (event) => {
      const row = requests.get(event.requestId);
      if (row) row.decoded_body_bytes += event.dataLength;
    });
    session.on("Network.loadingFinished", (event) => {
      const row = requests.get(event.requestId);
      if (row) row.ended = true;
    });
    session.on("Network.loadingFailed", (event) => {
      const row = requests.get(event.requestId);
      if (row) { row.ended = true; row.failed = true; }
    });
    await page.reload();
    await page.waitForFunction(() => typeof window.cachePlaybackProbe === "function");
    const released = await page.request.post(new URL("/lab/cache-origin/release", page.url()).href);
    if (!released.ok()) throw new Error("工作器实验源释放失败");
    const bootstrap = totals();
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 60, downloadThroughput: rate, uploadThroughput: 64000,
    });
    const plays = [];
    for (let index = 0; index < 2; index++) {
      const serviceBefore = await page.request.get(new URL("/lab/metrics", page.url()).href).then((response) => response.json());
      phase = `play-${index + 1}`;
      await page.evaluate(() => {
        const video = document.querySelector("video");
        const trace = { done: false, error: null, pixels: [], actual_seconds: null };
        window.workerPlayTrace = trace;
        let handle;
        const stop = () => {
          clearTimeout(deadline);
          if (handle !== undefined) video.cancelVideoFrameCallback(handle);
          trace.actual_seconds = video.currentTime;
          document.querySelector("#stop").click();
          trace.done = true;
        };
        const pixel = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 32; canvas.height = 18;
          const context = canvas.getContext("2d");
          context.drawImage(video, 0, 0, 32, 18);
          const data = context.getImageData(0, 0, 32, 18).data;
          let hash = 0, min = 255, max = 0;
          for (let i = 0; i < data.length; i += 4) {
            hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
            min = Math.min(min, data[i], data[i + 1], data[i + 2]);
            max = Math.max(max, data[i], data[i + 1], data[i + 2]);
          }
          return { hash, min, max };
        };
        const inspect = () => {
          if (trace.done) return;
          if (!trace.pixels.length && video.currentTime >= 0.5) trace.pixels.push(pixel());
          if (video.currentTime >= 1.25) {
            trace.pixels.push(pixel());
            stop();
            return;
          }
          handle = video.requestVideoFrameCallback(inspect);
        };
        const deadline = setTimeout(() => { trace.error = "工作器播放轨迹超时"; stop(); }, 30000);
        handle = video.requestVideoFrameCallback(inspect);
      });
      await page.getByRole("button", { name: "播放", exact: true }).click();
      await page.waitForFunction(() => window.workerPlayTrace.done, null, { timeout: 33000 });
      // 保持播放间相同网络，收尾读取只用于边界检查，不计为媒体正文。
      await page.waitForTimeout(300);
      const played = await page.evaluate(async () => ({
        report: window.cachePlaybackProbe(), trace: window.workerPlayTrace,
        lifecycle: structuredClone(window.workerLifecycleProbe),
        origin: await fetch("/lab/cache-origin").then((value) => value.json()),
        service: await fetch("/lab/metrics").then((value) => value.json()),
      }));
      const start = Date.now();
      while ([...requests.values()].some((row) => row.phase === phase && row.category === "media" && !row.ended)
          && Date.now() - start < 4000) {
        await page.waitForTimeout(25);
      }
      played.body = totals(phase);
      played.worker_requests = [...requests.values()].filter((row) => row.phase === phase && row.category === "worker");
      played.worker_delivery = {
        responses: played.service.worker_script.responses - serviceBefore.worker_script.responses,
        yielded_body_bytes: played.service.worker_script.yielded_body_bytes - serviceBefore.worker_script.yielded_body_bytes,
        scope: "Rust静态响应正文产出；浏览器初始化另验，不将父页面CDP缺失正文补零",
      };
      plays.push(played);
    }
    const failures = [];
    for (const [index, play] of plays.entries()) {
      const { report, trace, lifecycle, origin, service } = play;
      if (trace.error || report.first_frame_ms === null || report.errors.length || report.worker_mode !== mode
          || report.worker_path !== (mode === "external" ? "/vendor/hls.worker.js" : null)) {
        failures.push(`第${index + 1}次播放配置、初始化或错误不符`);
      }
      if (trace.actual_seconds < 1.25 || trace.actual_seconds > 1.4 || trace.pixels.length !== 2
          || trace.pixels[0].hash === trace.pixels[1].hash
          || trace.pixels.some((value) => value.max - value.min < 20)) failures.push("观看轨迹或变化像素失败");
      const count = index + 1;
      if (lifecycle.created.length !== count || lifecycle.errors.length
          || new Set(lifecycle.terminated).size !== count
          || new Set(lifecycle.initialized.map((row) => row.id)).size !== count
          || lifecycle.created.some((row) => row.blob !== (mode === "embedded"))) {
        failures.push("工作器未实际初始化或销毁，不能排除主线程回退");
      }
      if (mode === "embedded" && (play.worker_requests.length || play.worker_delivery.responses
          || play.worker_delivery.yielded_body_bytes)) failures.push("内置候选仍下载外部工作器");
      if (mode === "external" && (play.worker_requests.length !== 1 || play.worker_delivery.responses !== 1
          || play.worker_delivery.yielded_body_bytes !== 118366)) {
        failures.push("外部工作器下载观测不完整");
      }
      if (!origin.tail_released || origin.origin_active_bodies || origin.storage_http.active_exchanges
          || service.delivery.active_bodies || service.media_slots_available !== 16) failures.push("停止后媒体资源未回收");
    }
    const media = [...requests.values()].filter((row) => row.category === "media");
    if (media.some((row) => !row.ended)) failures.push("媒体或工作器请求尚未结算");
    return {
      schema: "worker-startup-trial-v1", valid: failures.length === 0, failures,
      mode, rate, bootstrap, plays, requests: [...requests.values()].map((row) => row.category === "worker"
        ? { ...row, decoded_body_bytes: null, ended: null, failed: null, parent_cdp_observation_incomplete: true } : row),
      body_total: totals(),
      scope: "主库页面先不限速加载并计正文，点击后限速；工作器服务产出与浏览器初始化分别核对，父页面CDP工作器正文未知，非线路/原生/完整CPU/RSS证据",
    };
  } finally {
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }).catch(() => {});
    await session.detach();
  }
}
