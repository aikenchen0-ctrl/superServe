async (page) => {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/lab/cache-probe?progressive=1`);
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  let unblock;
  const released = new Promise((resolve) => { unblock = resolve; });
  const blocker = async (route) => {
    reached();
    await released;
    await route.continue();
  };
  await page.route("**/lab/playback", blocker);
  try {
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await started;
    await page.getByRole("button", { name: "停止", exact: true }).click();
    unblock();
    await page.waitForFunction(() => !document.querySelector("#play").disabled,
      null, { timeout: 6000 });
    await page.waitForTimeout(150);
    const stopped = await page.evaluate(async () => ({
      report: window.cachePlaybackProbe(),
      origin: await fetch("/lab/cache-origin").then((value) => value.json()),
      source: document.querySelector("video").getAttribute("src"),
      state: document.querySelector("#state").textContent,
    }));
    if (stopped.source || stopped.report.frames || stopped.origin.origin_gets
        || stopped.state !== "已停止") {
      throw new Error("停止后迟到授权仍启动了读取或播放器");
    }
    return { schema: "cache-playback-lifecycle-v1", valid: true,
      delayed_grant_after_stop_did_not_start_media: true, stopped };
  } finally {
    unblock();
    await page.unroute("**/lab/playback", blocker);
  }
}
