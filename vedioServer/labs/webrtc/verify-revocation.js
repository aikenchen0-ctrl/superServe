async (page, fixture) => {
  await page.addInitScript(grants => { window.liveCapabilities = grants; }, fixture.grants);
  await page.reload();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const offers = [];
  page.on("request", request => {
    const endpoint = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/whip", "/whep"].includes(endpoint)) {
      offers.push({ endpoint, sdp: request.postData() });
    }
  });
  const read = () => page.evaluate(() => window.liveObservation());
  const until = async predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await read();
      if (predicate(state)) return state;
      await page.waitForTimeout(50);
    }
    throw new Error("撤权媒体状态未在期限内成立");
  };
  const sample = () => page.locator("#viewer-2").evaluate(video => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("撤权隔离画面取样超时")), 3000);
    video.requestVideoFrameCallback(async () => {
      clearTimeout(timer);
      const canvas = document.createElement("canvas");
      canvas.width = 32; canvas.height = 18;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, 32, 18);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", context.getImageData(0, 0, 32, 18).data));
      resolve({ hash: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join(""),
        width: video.videoWidth, height: video.videoHeight });
    });
  }));
  const baseline = await read();
  if (baseline.server.active_peers) throw new Error("撤权实验开始前存在活动会话");
  await page.getByRole("button", { name: "开始推流", exact: true }).click();
  await until(state => state.frame_callbacks["viewer-1"] > 5);
  await page.getByRole("button", { name: "增加订阅", exact: true }).click();
  const playing = await until(state => state.server.connected_peers === 3 && state.frame_callbacks["viewer-2"] > 5);
  const revokeBody = { fence: fixture.fence, role: "subscriber", token: fixture.grants["viewer-1"] };
  const unauthorized = await page.request.post(`${fixture.url}/admin/room/revoke-token`, {
    headers: { Authorization: `Bearer ${fixture.grants.publisher}` }, data: revokeBody,
  });
  const origin = await page.request.post(`${fixture.url}/admin/room/revoke-token`, {
    headers: { Authorization: `Bearer ${fixture.control_token}`, Origin: fixture.url }, data: revokeBody,
  });
  const other = await page.request.post(`${fixture.other_url}/admin/room/revoke-token`, {
    headers: { Authorization: `Bearer ${fixture.control_token}` }, data: revokeBody,
  });
  if (unauthorized.status() !== 401 || origin.status() !== 401 || other.status() !== 409) {
    throw new Error("撤权内部身份或目标绑定失效");
  }
  const started = Date.now();
  const response = await page.request.post(`${fixture.url}/admin/room/revoke-token`, {
    headers: { Authorization: `Bearer ${fixture.control_token}` }, data: revokeBody,
  });
  const controlRtt = Date.now() - started;
  if (response.status() !== 200) throw new Error("观看令牌撤权未确认");
  const receipt = await response.json();
  if (receipt.removed_sessions !== 1) throw new Error("观看令牌撤权影响了错误数量的连接");
  const revoked = await until(state => state.server.active_peers === 2 &&
    state.server.revoked_tokens === baseline.server.revoked_tokens + 1);
  await page.waitForTimeout(800);
  const settled = await read();
  const firstPixels = await sample();
  const continuing = await until(state => state.frame_callbacks["viewer-2"] > settled.frame_callbacks["viewer-2"] + 8);
  const audioPackets = (state, name) => state.connections[name]?.stats.find(
    entry => entry.type === "inbound-rtp" && entry.kind === "audio")?.packetsReceived || 0;
  if (playing.server.active_audio_codec === "opus" &&
      (audioPackets(continuing, "viewer-1") !== audioPackets(settled, "viewer-1") ||
        audioPackets(continuing, "viewer-2") <= audioPackets(settled, "viewer-2"))) {
    throw new Error("观看者撤权没有同时停止音频，或误停其他音频");
  }
  const secondPixels = await sample();
  if (continuing.frame_callbacks["viewer-1"] !== settled.frame_callbacks["viewer-1"] ||
      firstPixels.hash === secondPixels.hash || firstPixels.width !== 640 || firstPixels.height !== 360) {
    throw new Error("被撤观看者仍出帧，或未撤观看者被误停");
  }
  const replay = [];
  const resource = playing.connections["viewer-1"].resource;
  for (const [method, url, data] of [
    ["GET", resource], ["DELETE", resource], ["POST", `${resource}/renew`],
    ["POST", `${fixture.url}/whep`, offers.find(value => value.endpoint === "/whep").sdp],
    ["POST", `${fixture.other_url}/whep`, offers.find(value => value.endpoint === "/whep").sdp],
  ]) {
    const result = await page.request.fetch(url, { method,
      headers: { Authorization: `Bearer ${fixture.grants["viewer-1"]}`, "Content-Type": "application/sdp" }, data });
    replay.push({ method, path: new URL(url).pathname, status: result.status(), other_node: url.startsWith(fixture.other_url) });
    if (result.status() !== 401) throw new Error("已撤令牌仍可请求资源或在其他节点建连");
  }
  const repeated = await page.request.post(`${fixture.url}/admin/room/revoke-token`, {
    headers: { Authorization: `Bearer ${fixture.control_token}` }, data: revokeBody,
  });
  if (repeated.status() !== 200 || (await repeated.json()).removed_sessions !== 0) throw new Error("重复撤权不幂等");
  await page.evaluate(async token => {
    try { await window.liveRemoveSubscriber("viewer-1"); } catch {}
    window.liveCapabilities["viewer-1"] = token;
  }, fixture.replacement);
  await page.getByRole("button", { name: "增加订阅", exact: true }).click();
  const reauthorized = await until(state => state.server.connected_peers === 3 &&
    state.server.accepted_sessions === baseline.server.accepted_sessions + 4 &&
    state.frame_callbacks["viewer-1"] > continuing.frame_callbacks["viewer-1"] + 5);
  if (reauthorized.connections["viewer-1"].resource === resource ||
      reauthorized.connections["viewer-2"].resource !== playing.connections["viewer-2"].resource) {
    throw new Error("独立新授权未新建会话，或其他观看者被重建");
  }
  const screenshot = `output/playwright/revocation-${Date.now()}-reauthorized.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  const publisher = await page.request.post(`${fixture.url}/admin/room/revoke-token`, {
    headers: { Authorization: `Bearer ${fixture.control_token}` },
    data: { fence: fixture.fence, role: "publisher", token: fixture.grants.publisher },
  });
  if (publisher.status() !== 200 || (await publisher.json()).removed_sessions !== 3) {
    throw new Error("发布者撤权没有级联回收房间");
  }
  const empty = await until(state => state.server.active_peers === 0);
  await page.waitForTimeout(800);
  const ended = await read();
  await page.waitForTimeout(500);
  const after = await read();
  if (ended.server.outgoing_udp_payload_bytes !== after.server.outgoing_udp_payload_bytes ||
      ended.server.encoded_frames_forwarded !== after.server.encoded_frames_forwarded ||
      ended.server.audio_packets_forwarded !== after.server.audio_packets_forwarded ||
      ["viewer-1", "viewer-2"].some(name => audioPackets(ended, name) !== audioPackets(after, name)) ||
      ended.frame_callbacks["viewer-1"] !== after.frame_callbacks["viewer-1"] ||
      ended.frame_callbacks["viewer-2"] !== after.frame_callbacks["viewer-2"]) {
    throw new Error("发布撤权后仍有新增媒体发送或呈现");
  }
  const oldPublisher = await page.request.post(`${fixture.url}/whip`, {
    headers: { Authorization: `Bearer ${fixture.grants.publisher}`, "Content-Type": "application/sdp" },
    data: offers.find(value => value.endpoint === "/whip").sdp,
  });
  if (oldPublisher.status() !== 401) throw new Error("发布者可重放已撤令牌");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  const stopped = await until(state => Object.keys(state.connections).length === 0);
  if (errors.length || !stopped.server.worker_alive) throw new Error("撤权实验清理失败");
  return { schema: "live-token-revocation-real-media-v1", baseline, playing, receipt,
    single_control_rtt_ms: controlRtt, revoked, settled, continuing, first_pixels: firstPixels,
    second_pixels: secondPixels, replay, reauthorized, empty, ended, after, stopped, screenshot,
    unauthorized_control_status: unauthorized.status(), control_origin_status: origin.status(),
    other_target_control_status: other.status(), old_publisher_status: oldPublisher.status(),
    page_errors: errors, only_exact_grant_revoked_not_a_subject_ban: true,
    audio_revocation_isolation_checked: playing.server.active_audio_codec === "opus",
    scope: "同机Chrome合成单编码视频、两媒体目标；不是即时屏幕零残留、生产身份发行或物理多机证明" };
}
