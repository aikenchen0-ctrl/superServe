async (page) => {
  const session = await page.context().newCDPSession(page);
  const pageErrors = [];
  const mediaRequests = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/v1/media/") &&
        !pathname.startsWith("/v1/playback/") &&
        !pathname.startsWith("/live/lab/")) return;
    const headers = request.headers();
    mediaRequests.push({
      path: pathname.replace(/\/v1\/playback\/[^/]+/, "/v1/playback/[credential]"),
      request_id: headers["x-vs-request-id"] || null,
      trace_id: headers["x-vs-trace-id"] || null,
    });
  });
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Network.emulateNetworkConditions", {
    offline: false, latency: 40, downloadThroughput: 160000, uploadThroughput: 128000,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction(() => {
    const report = window.playbackObservation();
    return report?.frame_callbacks > 3 && report.consumption_persistence;
  }, null, { timeout: 20000 });
  const pixels = () => page.evaluate(() => {
    const video = document.querySelector("video");
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, 32, 18);
    const data = context.getImageData(0, 0, 32, 18).data;
    let hash = 0, low = 255, high = 0;
    for (let index = 0; index < data.length; index += 4) {
      hash = (Math.imul(hash, 31) + data[index] + data[index + 1] * 7 + data[index + 2] * 13) >>> 0;
      low = Math.min(low, data[index], data[index + 1], data[index + 2]);
      high = Math.max(high, data[index], data[index + 1], data[index + 2]);
    }
    return { hash, low, high, width: video.videoWidth, height: video.videoHeight };
  });
  const firstPixels = await pixels();
  const checkpoint = await page.evaluate(() => window.submitPlaybackCheckpoint());
  if (!checkpoint?.persisted || checkpoint.commit?.durability !== "persisted") {
    throw new Error("真实观测检查点没有持久确认");
  }
  await page.waitForTimeout(800);
  const secondPixels = await pixels();
  if (firstPixels.high - firstPixels.low < 20 || firstPixels.hash === secondPixels.hash) {
    throw new Error("真实媒体像素空白或未变化");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshots = {
    desktop: `output/playwright/consumption-${stamp}-desktop.png`,
    mobile: `output/playwright/consumption-${stamp}-mobile.png`,
  };
  await page.screenshot({ path: screenshots.desktop, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshots.mobile, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForFunction(() => window.playbackObservation().active_requests === 0);
  const final = await page.evaluate(() => window.submitPlaybackConsumption());
  if (!final?.persisted || final.commit?.base_offset <= checkpoint.commit.base_offset) {
    throw new Error("尾批没有独立顺序确认");
  }
  // 显式测试重传同一已封存载荷，不将其称为客户端自动重试。
  const duplicate = await page.evaluate(async () => {
    const response = await fetch("/lab/consumption", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(window.playbackConsumption()),
    });
    return { status: response.status, body: await response.json() };
  });
  if (duplicate.status !== 202 || duplicate.body.persisted !== true) {
    throw new Error("显式重复批次没有得到可核查确认");
  }
  const forged = await page.evaluate(async () => {
    const batch = window.playbackConsumption();
    batch.interaction_id = "unissued-playback";
    const response = await fetch("/lab/consumption", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch),
    });
    return response.status;
  });
  if (forged !== 403) throw new Error("未签发实例没有拒绝");
  const observation = await page.evaluate(() => window.playbackObservation());
  if (observation.omitted_consumption_events || observation.consumption_submission_unknown ||
      observation.consumption_submissions.length !== 2 || observation.received_body_bytes <= 0) {
    throw new Error("真实消费批次缺失、重复确认或结果未知");
  }
  const correlatedMediaRequests = mediaRequests.filter(
    request => request.request_id === observation.recommendation_request_id
  );
  if (!observation.recommendation_request_id || !correlatedMediaRequests.length) {
    throw new Error(`真实媒体请求缺少推荐请求关联：${JSON.stringify({
      recommendation_request_id: observation.recommendation_request_id,
      media_requests: mediaRequests,
    })}`);
  }
  if (overflow || pageErrors.length) throw new Error("布局溢出或浏览器执行异常");
  await session.send("Network.disable");
  return {
    schema: "playback-consumption-browser-v1",
    real_browser_decoding_verified: true, first_pixels: firstPixels, second_pixels: secondPixels,
    received_body_bytes: observation.received_body_bytes,
    unique_events: observation.consumption_events.length,
    submissions: observation.consumption_submissions,
    duplicate_offset: duplicate.body.commit.base_offset,
    unissued_instance_status: forged,
    final_generation: observation.consumption_generation,
    actual_frame_callback_ms: observation.first_frame_callback_ms,
    media_request_correlation: {
      total: mediaRequests.length,
      matched: correlatedMediaRequests.length,
      request_id: observation.recommendation_request_id,
    },
    screenshots, mobile_overflow: overflow, page_errors: pageErrors,
    broker_persistence_proven_by_browser: false,
    native_devices_verified: false,
    scope: "真实Chrome解码和XHR观测、合成素材；后端身份与恢复由外层独立验收，非真实用户、原生真机或三低基准",
  };
}
