async (page) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshots = {
    desktop: `output/playwright/live-${stamp}-desktop.png`,
    mobile: `output/playwright/live-${stamp}-mobile.png`,
  };
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#source [value="live"]').disabled);
  await page.getByLabel("来源").selectOption("live");
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction(() => window.playbackObservation()?.frame_callbacks > 8,
    null, { timeout: 25000 });
  const first = await page.evaluate(() => window.playbackObservation());
  if (!first.playlist_is_live || first.delivery_mode !== "live") {
    throw new Error("未进入直播播放路径");
  }
  const pixel = () => page.locator("video").evaluate((video) => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, 32, 18);
    const pixels = context.getImageData(0, 0, 32, 18).data;
    let hash = 0;
    let low = 255;
    let high = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      hash = (Math.imul(hash, 31) + pixels[index] + 7 * pixels[index + 1] + 13 * pixels[index + 2]) >>> 0;
      low = Math.min(low, pixels[index], pixels[index + 1], pixels[index + 2]);
      high = Math.max(high, pixels[index], pixels[index + 1], pixels[index + 2]);
    }
    return { hash, low, high, width: video.videoWidth, height: video.videoHeight };
  });
  const firstPixels = await pixel();
  await page.waitForFunction((end) => {
    const report = window.playbackObservation();
    return report.manifest_end_sequences.some((sequence) => sequence > end);
  }, Math.max(...first.manifest_end_sequences), { timeout: 20000 });
  const secondPixels = await pixel();
  if (firstPixels.high - firstPixels.low < 20 || firstPixels.hash === secondPixels.hash) {
    throw new Error("直播画面为空白或没有变化");
  }
  const live = await page.evaluate(() => window.playbackObservation());
  await page.screenshot({ path: screenshots.desktop, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshots.mobile, fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
    throw new Error("直播页面在手机宽度溢出");
  }
  await page.getByLabel("来源").selectOption("vod");
  await page.waitForFunction((generation) => {
    const report = window.playbackObservation();
    return report.generation > generation && report.delivery_mode === "vod" && report.frame_callbacks > 3;
  }, live.generation, { timeout: 12000 });
  const switched = await page.evaluate(() => window.playbackObservation());
  if (switched.requests.some((request) => request.path.startsWith("/live/"))) {
    throw new Error("旧直播请求污染了点播代次");
  }
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForTimeout(500);
  const stopped = await page.evaluate(() => window.playbackObservation());
  await page.waitForTimeout(1000);
  const afterStop = await page.evaluate(() => window.playbackObservation());
  if (afterStop.requests.length !== stopped.requests.length ||
      afterStop.received_body_bytes !== stopped.received_body_bytes) {
    throw new Error("停止后仍继续下载");
  }
  const metrics = await page.evaluate(() => fetch("/lab/metrics").then((response) => response.json()));
  if (metrics.live_proxy.available_permits !== metrics.live_proxy.capacity) {
    throw new Error("直播读取许可没有完整回收");
  }
  return {
    schema: "xiu-live-browser-acceptance-v1",
    screenshots,
    date: new Date().toISOString(),
    source_tag: "v0.13.0",
    first_pixels: firstPixels,
    second_pixels: secondPixels,
    live_observation: live,
    switched_to_vod: switched,
    stop_body_and_requests_stable: true,
    mobile_horizontal_overflow: false,
    server_after: metrics,
    scope: "本机合成推流及普通MPEG-TS HLS；没有测量采集到显示的端到端延迟、WebRTC、LL-HLS或物理集群",
  };
}
