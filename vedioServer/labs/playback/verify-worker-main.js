async (page) => {
  const before = await page.request.get(new URL("/lab/metrics", page.url()).href).then((response) => response.json());
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction(() => window.playbackObservation()?.frame_callbacks >= 4,
    null, { timeout: 12000 });
  const stamp = Date.now();
  const screenshots = {
    desktop: `output/playwright/embedded-main-${stamp}-desktop.png`,
    mobile: `output/playwright/embedded-main-${stamp}-mobile.png`,
  };
  const pixels = () => page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext("2d");
    context.drawImage(document.querySelector("video"), 0, 0, 32, 18);
    const data = context.getImageData(0, 0, 32, 18).data;
    let hash = 0, min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) {
      hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
      min = Math.min(min, data[i], data[i + 1], data[i + 2]);
      max = Math.max(max, data[i], data[i + 1], data[i + 2]);
    }
    return { hash, min, max };
  });
  const first = await pixels();
  await page.screenshot({ path: screenshots.desktop, fullPage: true });
  await page.waitForTimeout(250);
  const second = await pixels();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshots.mobile, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForFunction(() => window.playbackObservation()?.active_requests === 0);
  const after = await page.evaluate(async () => ({
    report: window.playbackObservation(),
    lifecycle: structuredClone(window.workerLifecycleProbe),
    service: await fetch("/lab/metrics").then((value) => value.json()),
  }));
  const valid = after.report.worker_mode === "embedded" && !after.report.error && !overflow
    && first.hash !== second.hash && first.max - first.min > 20
    && after.lifecycle.created.length === 1 && after.lifecycle.created[0].blob
    && new Set(after.lifecycle.initialized.map((value) => value.id)).size === 1
    && after.lifecycle.terminated.length === 1 && !after.lifecycle.errors.length
    && after.service.worker_script.responses === before.worker_script.responses
    && after.service.delivery.active_bodies === 0 && after.service.media_slots_available === 16;
  return {
    schema: "embedded-worker-main-smoke-v1", valid, pixels: [first, second], screenshots,
    worker_mode: after.report.worker_mode, frames: after.report.frame_callbacks,
    lifecycle: after.lifecycle, external_worker_responses_delta: after.service.worker_script.responses - before.worker_script.responses,
    scope: "已有播放页面显式模式接入与像素/回收验证，不是性能样本或原生设备",
  };
}
