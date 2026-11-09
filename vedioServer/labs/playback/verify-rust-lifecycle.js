async (page) => {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/?policy=rust_time`);
  const session = await page.context().newCDPSession(page);
  let stage = "启动";
  try {
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => window.playbackObservation()?.frame_callbacks > 3 &&
      window.playbackObservation().rust_time_control?.decisions > 0);
    stage = "先触发高阈值暂停";
    await page.waitForFunction(() => window.playbackObservation().loading_actions
      .some((value) => value.action === "rust_pause_buffering"));
    stage = "跨缓冲跳到片尾后自然结束";
    await page.locator("video").evaluate((video) => {
      if (!Number.isFinite(video.duration) || video.duration < 1) throw new Error("素材尾部不可用");
      video.currentTime = video.duration - 0.35;
    });
    await page.waitForFunction(() => window.playbackObservation()?.ended === true);
    const naturalEnd = await page.evaluate(() => window.playbackObservation());
    await page.waitForTimeout(350);
    const afterEnd = await page.evaluate(() => window.playbackObservation());
    if (!naturalEnd.rust_time_control.released ||
        naturalEnd.rust_time_control.decisions !== afterEnd.rust_time_control.decisions) {
      throw new Error("自然结束未释放Rust控制器或定时器");
    }
    if (!naturalEnd.loading_actions.some((value) => value.action === "rust_seek_resume_buffering")) {
      throw new Error("跨缓冲跳转没有显式解除加载暂停");
    }
    stage = "切换到非Rust策略";
    await page.locator("#policy").selectOption("keep_inflight");
    await page.getByRole("button", { name: "重新播放", exact: true }).click();
    await page.waitForFunction(() => window.playbackObservation()?.frame_callbacks > 3);
    const switched = await page.evaluate(() => window.playbackObservation());
    if (switched.rust_time_control !== null || switched.generation <= afterEnd.generation) {
      throw new Error("切换后残留旧Rust控制器");
    }
    await page.getByRole("button", { name: "停止", exact: true }).click();
    stage = "重建Rust对象";
    await page.locator("#policy").selectOption("rust_time");
    await page.getByRole("button", { name: "重新播放", exact: true }).click();
    await page.waitForFunction(() => window.playbackObservation()?.frame_callbacks > 3 &&
      window.playbackObservation().rust_time_control?.decisions > 0);
    const recreated = await page.evaluate(() => window.playbackObservation());
    if (recreated.rust_time_control.released || recreated.generation <= switched.generation) {
      throw new Error("Rust对象未按新代次重建");
    }
    // 仅注入播放器公开错误事件验证回收，不冒充真实解码或网络故障。
    stage = "注入致命错误后回收";
    await page.evaluate(() => hls.trigger(Hls.Events.ERROR, {
      fatal: true, details: "实验注入致命错误",
    }));
    await page.waitForFunction(() => window.playbackObservation()?.rust_time_control?.released);
    const fatal = await page.evaluate(() => window.playbackObservation());
    await page.waitForTimeout(350);
    const afterFatal = await page.evaluate(() => window.playbackObservation());
    if (fatal.rust_time_control.decisions !== afterFatal.rust_time_control.decisions) {
      throw new Error("致命错误后仍执行Rust控制");
    }
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.waitForFunction(() => window.playbackObservation()?.active_requests === 0);
    const metrics = await page.evaluate(() => fetch("/lab/metrics").then((value) => value.json()));
    if (metrics.delivery.active_bodies !== 0 || metrics.media_slots_available !== 16) {
      throw new Error("生命周期验证后媒体资源未回收");
    }
    return {
      schema: "rust-time-lifecycle-v1",
      natural_end_released: true,
      seek_outside_buffer_resumed: true,
      natural_end_decisions_stable: true,
      switch_cleared_previous_control: true,
      recreated_with_new_generation: true,
      injected_fatal_released: true,
      injected_fatal_decisions_stable: true,
      observations: { natural_end: naturalEnd, switched, recreated, injected_fatal: fatal },
      metrics,
      scope: "同机浏览器自然结束/切换，以及公开错误事件注入；不代表真机或真实解码故障",
    };
  } catch (error) {
    const observation = await page.evaluate(() => window.playbackObservation()).catch(() => null);
    throw new Error(`生命周期阶段“${stage}”失败：${error.message}；观测：${JSON.stringify(observation)}`);
  } finally {
    await session.detach();
  }
}
