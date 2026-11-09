async (page) => {
  const query = new URL(page.url()).searchParams;
  const rate = Number(query.get("rate"));
  const scenario = query.get("scenario");
  const progressive = query.get("progressive") === "1";
  if (![120000, 48000].includes(rate) || !["abandon", "sustain"].includes(scenario)) {
    throw new Error("无屏障轨迹参数无效");
  }
  const session = await page.context().newCDPSession(page);
  const requests = new Map();
  const resourceUsage = async () => {
    const metrics = await session.send("Performance.getMetrics");
    const values = Object.fromEntries(metrics.metrics.map((value) => [value.name, value.value]));
    return Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "JSHeapUsedSize",
      "JSHeapTotalSize"].map((name) => [name, values[name] ?? null]));
  };
  const bodyBytes = () => [...requests.values()].reduce((sum, row) => sum + row.decoded_body_bytes, 0);
  const stopTarget = scenario === "abandon" ? 1.25 : 6;
  try {
    // 屏障在任何播放器读取前释放，本轮不把人工尾部阻塞作为网络。
    const released = await page.request.post(new URL("/lab/cache-origin/release", page.url()).href);
    if (!released.ok()) throw new Error("无屏障实验源站释放失败");
    await session.send("Network.enable");
    await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    await session.send("Performance.enable", { timeDomain: "timeTicks" });
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 60, downloadThroughput: rate, uploadThroughput: 64000,
    });
    session.on("Network.requestWillBeSent", (event) => {
      if (!/\/v1\/playback\/[^/]+\/[a-f0-9]{64}\//.test(event.request.url)) return;
      requests.set(event.requestId, {
        path: new URL(event.request.url).pathname.replace(/\/v1\/playback\/[^/]+/, "/v1/playback/[credential]"),
        decoded_body_bytes: 0, ended: false, failed: false, status: null,
      });
    });
    session.on("Network.responseReceived", (event) => {
      const row = requests.get(event.requestId);
      if (row) row.status = event.response.status;
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
      if (row) { row.ended = true; row.failed = true; row.cancelled = event.canceled ?? false; }
    });
    const usageBefore = await resourceUsage();
    await page.evaluate(({ target }) => {
      const video = document.querySelector("video");
      const state = { done: false, error: null, target_seconds: target, pixels: [], stop_elapsed_ms: null };
      window.naturalPlaybackTrace = state;
      let frameHandle;
      const finish = () => {
        clearTimeout(deadline);
        if (frameHandle !== undefined) video.cancelVideoFrameCallback(frameHandle);
        const report = window.cachePlaybackProbe();
        state.stop_elapsed_ms = report ? performance.now() - report.started_ms : null;
        document.querySelector("#stop").click();
        state.done = true;
      };
      const pixels = () => {
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
        return { hash, min, max, at_seconds: video.currentTime };
      };
      const inspect = () => {
        if (state.done) return;
        if (!state.pixels.length && video.currentTime >= 0.5) state.pixels.push(pixels());
        if (video.currentTime >= target) {
          state.pixels.push(pixels());
          finish();
          return;
        }
        frameHandle = video.requestVideoFrameCallback(inspect);
      };
      const deadline = setTimeout(() => { state.error = "相同观看轨迹超时"; finish(); }, 45000);
      frameHandle = video.requestVideoFrameCallback(inspect);
    }, { target: stopTarget });
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => window.naturalPlaybackTrace.done, null, { timeout: 48000 });
    await page.waitForFunction(() => document.querySelector("#state").textContent === "已停止",
      null, { timeout: 1000 });
    const usageAfter = await resourceUsage();
    // 读取性能指标后解除模拟限速，收尾探测不进入观看测量区间。
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    const result = await page.evaluate(async () => ({
      trace: window.naturalPlaybackTrace,
      report: window.cachePlaybackProbe(),
      origin: await fetch("/lab/cache-origin").then((value) => value.json()),
      service: await fetch("/lab/metrics").then((value) => value.json()),
    }));
    const began = Date.now();
    while ([...requests.values()].some((row) => !row.ended) && Date.now() - began < 4000) {
      await page.waitForTimeout(25);
    }
    const settledBytes = bodyBytes();
    const settledRequests = requests.size;
    await page.waitForTimeout(400);
    const afterStop = await page.evaluate(async () => ({
      report: window.cachePlaybackProbe(),
      origin: await fetch("/lab/cache-origin").then((value) => value.json()),
      service: await fetch("/lab/metrics").then((value) => value.json()),
    }));
    const failures = [];
    if (result.trace.error) failures.push(result.trace.error);
    if (result.report.first_frame_ms === null || result.report.first_frame_ms <= 0) failures.push("缺少有效首帧");
    if (result.report.errors.some((row) => row.fatal)) failures.push("播放器致命错误");
    if (result.report.progressive_applied !== progressive) failures.push("播放器配置未实际生效");
    const position = result.report.stopped_at_seconds;
    if (position < stopTarget || position > stopTarget + 0.15) failures.push("停止位置超出同轨迹容差");
    const played = result.report.played_ranges.reduce((sum, range) => sum + range[1] - range[0], 0);
    if (Math.abs(played - position) > 0.1) failures.push("已播范围与连续观看不一致");
    if (result.trace.pixels.length !== 2 || result.trace.pixels.some((row) => row.max - row.min < 20)
        || result.trace.pixels[0]?.hash === result.trace.pixels[1]?.hash) failures.push("变化像素未验证");
    if (afterStop.origin.origin_active_bodies || afterStop.origin.tail_waiters
        || afterStop.origin.storage_http.active_exchanges || afterStop.origin.cache?.active_fills
        || afterStop.service.delivery.active_bodies || afterStop.service.media_slots_available !== 16) {
      failures.push("停止后源、填充或媒体许可未回收");
    }
    if (!afterStop.origin.tail_released) failures.push("无屏障实验尾部仍锁定");
    if (settledBytes !== bodyBytes() || settledRequests !== requests.size) failures.push("取消结算后仍新增下载");
    if ([...requests.values()].some((row) => !row.ended)) failures.push("媒体请求尚未完成结算");
    if (result.report.appends !== afterStop.report.appends || result.report.frames !== afterStop.report.frames) {
      failures.push("停止后仍追加或呈现");
    }
    const deltas = {};
    for (const name of ["TaskDuration", "ScriptDuration", "LayoutDuration"]) {
      deltas[name] = usageBefore[name] === null || usageAfter[name] === null
        ? null : usageAfter[name] - usageBefore[name];
    }
    return {
      schema: "natural-playback-trace-v1", valid: failures.length === 0, failures,
      rate, latency_ms: 60, scenario, stop_target_seconds: stopTarget, progressive,
      trace: result.trace, report: result.report, after_stop: afterStop,
      requests: [...requests.values()], usage: { before: usageBefore, after: usageAfter, deltas },
      measures: {
        first_frame_ms: result.report.first_frame_ms, stall_count: result.report.stall_count,
        stall_ms: result.report.stall_ms, client_cdp_body_bytes: bodyBytes(),
        media_requests: requests.size, cancelled_requests: [...requests.values()].filter((row) => row.cancelled).length,
        appends: result.report.appends, played_seconds: played,
        source_http_body_bytes: afterStop.origin.origin_body_bytes,
        service_yielded_bytes: afterStop.service.media_bytes_yielded,
      },
      scope: "同机Chrome/CDP模拟网络和固定合成观看；CDP正文不含协议开销；TaskDuration不含完整解码/GPU/工作器CPU；V8堆不是RSS；没有真实用户或原生证据",
    };
  } finally {
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }).catch(() => {});
    await session.detach();
  }
}
