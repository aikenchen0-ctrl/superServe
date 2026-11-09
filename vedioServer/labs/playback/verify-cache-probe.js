async (page) => {
  const progressive = new URL(page.url()).searchParams.get("progressive") === "1";
  const snapshots = [];
  const mediaRequests = new Map();
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  session.on("Network.requestWillBeSent", (event) => {
    if (/\/v1\/playback\/[^/]+\/[a-f0-9]{64}\//.test(event.request.url)) {
      mediaRequests.set(event.requestId, {
        path: new URL(event.request.url).pathname.replace(/\/v1\/playback\/[^/]+/, "/v1/playback/[credential]"),
        decoded_body_bytes: 0, ended: false, failed: false,
      });
    }
  });
  session.on("Network.dataReceived", (event) => {
    const row = mediaRequests.get(event.requestId);
    if (row) row.decoded_body_bytes += event.dataLength;
  });
  session.on("Network.loadingFinished", (event) => {
    const row = mediaRequests.get(event.requestId);
    if (row) row.ended = true;
  });
  session.on("Network.loadingFailed", (event) => {
    const row = mediaRequests.get(event.requestId);
    if (row) { row.ended = true; row.failed = true; }
  });
  const snapshot = async (stage) => {
    const state = await page.evaluate(async () => ({
      probe: window.cachePlaybackProbe(),
      origin: await fetch("/lab/cache-origin").then((value) => value.json()),
      video: {
        width: document.querySelector("video").videoWidth,
        height: document.querySelector("video").videoHeight,
        ready_state: document.querySelector("video").readyState,
        time: document.querySelector("video").currentTime,
      },
    }));
    state.stage = stage;
    state.media_requests = structuredClone([...mediaRequests.values()]);
    snapshots.push(state);
    return state;
  };
  const pixels = () => page.evaluate(() => {
    const video = document.querySelector("video");
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
    return { hash, min, max, width: video.videoWidth, height: video.videoHeight };
  });
  try {
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(async () => {
      const origin = await fetch("/lab/cache-origin").then((value) => value.json());
      return origin.tail_waiters === 1 && !origin.tail_released;
    }, null, { timeout: 12000 });
    await page.waitForTimeout(1200);
    const before = await snapshot("tail-blocked");
    const earlyPixels = before.probe.frames ? await pixels() : null;
    const gate = await page.request.post(new URL("/lab/cache-origin/release", page.url()).href);
    if (!gate.ok()) throw new Error("起播实验尾部释放失败");
    await page.waitForFunction(() => window.cachePlaybackProbe()?.frames >= 4,
      null, { timeout: 12000 });
    const firstPixels = await pixels();
    await page.waitForTimeout(250);
    const secondPixels = await pixels();
    const after = await snapshot("tail-released");
    const stamp = Date.now();
    const screenshots = {
      desktop: `output/playwright/cache-probe-${stamp}-desktop.png`,
      mobile: `output/playwright/cache-probe-${stamp}-mobile.png`,
    };
    await page.screenshot({ path: screenshots.desktop, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: screenshots.mobile, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.waitForFunction(async () => {
      const origin = await fetch("/lab/cache-origin").then((value) => value.json());
      return origin.origin_active_bodies === 0 && origin.tail_waiters === 0
        && (!origin.cache || origin.cache.active_fills === 0)
        && origin.storage_http.active_exchanges === 0;
    }, null, { timeout: 6000 });
    await snapshot("stopped");
    const failures = [];
    if (before.origin.tail_released || before.origin.tail_waiters !== 1) failures.push("屏障提前释放");
    if (before.probe.progressive_applied !== progressive) failures.push("播放器候选未实际应用");
    if (before.probe.errors.some((row) => row.fatal) || after.probe.errors.some((row) => row.fatal)) {
      failures.push("播放出现致命错误");
    }
    if (firstPixels.max - firstPixels.min < 20 || firstPixels.hash === secondPixels.hash) {
      failures.push("解码画面为空白或不变化");
    }
    if (overflow) failures.push("手机宽度布局溢出");
    return {
      schema: "cache-playback-gated-trial-v1", valid: failures.length === 0, failures,
      progressive, snapshots, early_pixels: earlyPixels,
      decoded_pixels: [firstPixels, secondPixels], screenshots,
      before_release_presented_frames: before.probe.frames,
      before_release_first_append_ms: before.probe.first_append_ms,
      first_frame_ms: after.probe.first_frame_ms,
      scope: "固定尾部屏障、同机Chrome与合成素材；CDP解码正文不含线路开销；不是生产延迟分布或原生验证",
    };
  } finally {
    await page.request.post(new URL("/lab/cache-origin/release", page.url()).href).catch(() => {});
    await session.detach();
  }
}
