async (page) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshots = {
    desktop: `output/playwright/playback-${stamp}-desktop.png`,
    mobile: `output/playwright/playback-${stamp}-mobile.png`,
  };
  const cmcdRequests = [];
  const redactPath = (url) => new URL(url).pathname.replace(
    /\/v1\/playback\/[^/]+/, "/v1/playback/[credential]");
  page.on("request", (request) => {
    const headers = request.headers();
    if (headers["cmcd-session"] || headers["cmcd-request"] || headers["cmcd-session-id"]) {
      cmcdRequests.push({
        path: redactPath(request.url()),
        session: headers["cmcd-session"] || null,
        request: headers["cmcd-request"] || null,
      });
    }
  });
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: false, latency: 60, downloadThroughput: 120000, uploadThroughput: 64000,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction(() => {
    const report = window.playbackObservation();
    return report?.frame_callbacks > 3 && report.requests.some((value) => value.result === "下载中");
  }, null, { timeout: 15000 });
  const linked = await page.evaluate(() => window.playbackObservation());
  if (!linked.decision_id || !linked.recommendation_request_id || !linked.candidate_id ||
      !linked.playback_id) {
    throw new Error(`播放授权缺少推荐关联：${JSON.stringify({
      decision_id: linked.decision_id,
      recommendation_request_id: linked.recommendation_request_id,
      candidate_id: linked.candidate_id,
      playback_id: linked.playback_id,
    })}`);
  }
  const pixel = () => page.evaluate(() => {
    const video = document.querySelector("video");
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, 32, 18);
    const data = context.getImageData(0, 0, 32, 18).data;
    let hash = 0;
    let low = 255;
    let high = 0;
    for (let index = 0; index < data.length; index += 4) {
      hash = (Math.imul(hash, 31) + data[index] + data[index + 1] * 7 + data[index + 2] * 13) >>> 0;
      low = Math.min(low, data[index], data[index + 1], data[index + 2]);
      high = Math.max(high, data[index], data[index + 1], data[index + 2]);
    }
    return { hash, low, high, width: video.videoWidth, height: video.videoHeight };
  });
  const firstPixels = await pixel();
  await page.waitForTimeout(1000);
  const secondPixels = await pixel();
  if (firstPixels.high - firstPixels.low < 20 || firstPixels.hash === secondPixels.hash) {
    throw new Error("视频像素为空白或没有变化");
  }
  await page.screenshot({ path: screenshots.desktop, fullPage: true });
  await page.locator("video").evaluate((element) => element.pause());
  await page.waitForTimeout(500);
  const paused = await page.evaluate(() => window.playbackObservation());
  await page.waitForTimeout(1200);
  const afterPause = await page.evaluate(() => window.playbackObservation());
  if (paused.requests.length !== afterPause.requests.length ||
      paused.received_body_bytes !== afterPause.received_body_bytes) {
    throw new Error("暂停后仍继续接收媒体正文");
  }
  if (!afterPause.aborted_requests) throw new Error("限速实验未观测到请求取消");
  await page.locator("video").evaluate((element) => element.play());
  await page.waitForFunction((minimum) => window.playbackObservation().frame_callbacks > minimum,
    afterPause.frame_callbacks + 3, { timeout: 10000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshots.mobile, fullPage: true });
  const mobileOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth);
  if (mobileOverflow) throw new Error("手机宽度布局横向溢出");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForTimeout(500);
  const stopped = await page.evaluate(() => window.playbackObservation());
  await page.waitForTimeout(1000);
  const afterStop = await page.evaluate(() => window.playbackObservation());
  if (stopped.received_body_bytes !== afterStop.received_body_bytes ||
      stopped.requests.length !== afterStop.requests.length) {
    throw new Error("停止后仍继续下载");
  }
  const consumption = await page.evaluate(() => window.submitPlaybackConsumption());
  if (!consumption || consumption.schema !== "playback-lab-consumption-v1" ||
      consumption.summary.unique_events < 2 || consumption.summary.first_presentable_elapsed_ms === null ||
      consumption.summary.byte_scope !== "web_xhr_body") {
    throw new Error(`消费链路没有完成规范化：${JSON.stringify(consumption)}`);
  }
  const serverAfter = await page.evaluate(() => fetch("/lab/metrics").then((value) => value.json()));
  const result = {
    schema: "browser-playback-acceptance-v1",
    screenshots,
    date: new Date().toISOString(),
    network: { simulated_latency_ms: 60, simulated_download_bytes_per_second: 120000 },
    first_pixels: firstPixels,
    second_pixels: secondPixels,
    pause_received_bytes_stable: true,
    pause_requests_stable: true,
    canceled_requests_observed: afterPause.aborted_requests,
    stop_received_bytes_stable: true,
    mobile_overflow: mobileOverflow,
    observation: afterStop,
    server_after: serverAfter,
    consumption,
    cmcd_requests: cmcdRequests,
    scope: "单机Chrome和合成素材；限速为浏览器模拟；不是公网、真机、CPU/RSS或生产性能结论",
  };
  if (!cmcdRequests.length || !cmcdRequests.some((item) =>
    item.session?.includes(linked.playback_id) &&
    item.request?.includes(linked.recommendation_request_id))) {
    throw new Error(`媒体请求缺少CMCD联合标识：${JSON.stringify(cmcdRequests)}`);
  }
  await session.send("Network.disable");
  return result;
}
