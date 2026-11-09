async (page, fixture) => {
  await page.addInitScript(grants => { window.liveCapabilities = grants; }, fixture.grants);
  await page.reload();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let offer;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/whip" && request.method() === "POST") offer = request.postData();
  });
  const read = () => page.evaluate(() => window.liveObservation());
  const until = async predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await read();
      if (predicate(state)) return state;
      await page.waitForTimeout(50);
    }
    throw new Error("媒体排空观测未在期限内成立");
  };
  const baseline = await read();
  if (baseline.server.active_peers !== 0) throw new Error("排空实验开始前已有会话");
  await page.getByRole("button", { name: "开始推流", exact: true }).click();
  await until(state => state.frame_callbacks["viewer-1"] > 4);
  await page.getByRole("button", { name: "增加订阅", exact: true }).click();
  const playing = await until(state => state.server.connected_peers === 3 &&
    state.frame_callbacks["viewer-1"] > 8 && state.frame_callbacks["viewer-2"] > 4);
  const sample = selector => page.locator(selector).evaluate(video => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("帧取样超时")), 3000);
    video.requestVideoFrameCallback(async () => {
      clearTimeout(timer);
      const canvas = document.createElement("canvas");
      canvas.width = 32; canvas.height = 18;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, 32, 18);
      const bytes = context.getImageData(0, 0, 32, 18).data;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      resolve({ width: video.videoWidth, height: video.videoHeight,
        hash: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("") });
    });
  }));
  const firstPixels = await Promise.all([sample("#viewer-1"), sample("#viewer-2")]);
  await until(state => state.frame_callbacks["viewer-1"] > playing.frame_callbacks["viewer-1"] + 6 &&
    state.frame_callbacks["viewer-2"] > playing.frame_callbacks["viewer-2"] + 6);
  const secondPixels = await Promise.all([sample("#viewer-1"), sample("#viewer-2")]);
  if (firstPixels.some((value, index) => value.hash === secondPixels[index].hash || value.width !== 640 || value.height !== 360)) {
    throw new Error("排空前没有两路真实变化画面");
  }
  const wrong = await page.request.post(`${fixture.other_url}/admin/room/activate`, {
    headers: { Authorization: `Bearer ${fixture.control_token}` }, data: fixture.other_fence,
  });
  if (wrong.status() !== 409) throw new Error("未获分配的媒体节点接受了激活");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshot = `output/playwright/handoff-${stamp}-before-drain.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  const released = await page.request.post(`${fixture.coordination_url}/v1/rooms/commands`, {
    headers: { Authorization: `Bearer ${fixture.coordination_token}` },
    data: fixture.release_command,
  });
  if (released.status() !== 200) throw new Error(`控制面未完成先排空再释放：${released.status()}`);
  const releaseReply = await released.json();
  if (releaseReply.record.owner !== null) throw new Error("排空完成后房间记录仍有所有者");
  const drained = await until(state => state.server.active_peers === 0 && state.server.assignment_revision === null &&
    state.server.drained_revision === fixture.fence.revision);
  await page.waitForTimeout(700);
  const settled = await read();
  await page.waitForTimeout(500);
  const after = await read();
  const audioPackets = (state, name) => state.connections[name]?.stats.find(
    entry => entry.type === "inbound-rtp" && entry.kind === "audio")?.packetsReceived || 0;
  if (settled.server.outgoing_udp_payload_bytes !== after.server.outgoing_udp_payload_bytes ||
      settled.server.encoded_frames_forwarded !== after.server.encoded_frames_forwarded ||
      settled.server.audio_packets_forwarded !== after.server.audio_packets_forwarded ||
      ["viewer-1", "viewer-2"].some(name => audioPackets(settled, name) !== audioPackets(after, name)) ||
      settled.frame_callbacks["viewer-1"] !== after.frame_callbacks["viewer-1"] ||
      settled.frame_callbacks["viewer-2"] !== after.frame_callbacks["viewer-2"]) {
    throw new Error("排空确认后仍有新增媒体发送或呈现");
  }
  const oldActivate = await page.request.post(`${fixture.url}/admin/room/activate`, {
    headers: { Authorization: `Bearer ${fixture.control_token}` }, data: fixture.fence,
  });
  const oldOffer = await page.request.post(`${fixture.url}/whip`, {
    headers: { Authorization: `Bearer ${fixture.grants.publisher}`, "Content-Type": "application/sdp" }, data: offer,
  });
  const oldRenew = await page.request.post(`${playing.connections["viewer-1"].resource}/renew`, {
    headers: { Authorization: `Bearer ${fixture.grants["viewer-1"]}` },
  });
  if (oldActivate.status() !== 409 || oldOffer.status() !== 409 || oldRenew.status() !== 409) {
    throw new Error("排空后旧分配仍可激活、创建或续权会话");
  }
  await page.getByRole("button", { name: "停止", exact: true }).click();
  const stopped = await until(state => Object.keys(state.connections).length === 0);
  if (pageErrors.length) throw new Error(pageErrors.join("；"));
  return {
    schema: "room-drain-real-media-v1", baseline, playing, first_pixels: firstPixels,
    second_pixels: secondPixels, release: releaseReply, drained, settled, after, stopped,
    wrong_target_activation_status: wrong.status(), old_activation_status: oldActivate.status(),
    old_offer_status: oldOffer.status(), page_errors: pageErrors, screenshot,
    old_renewal_status: oldRenew.status(),
    audio_packets_stable_after_drain: true,
    media_counters_and_presented_frames_stable_after_drain: true,
    scope: "同机Chrome合成单编码视频、受控排空；不是网络分区自动接管或硬实时屏幕停帧",
  };
}
