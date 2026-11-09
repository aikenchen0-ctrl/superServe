async (page, fixture, phase) => {
  const read = () => page.evaluate(() => window.liveObservation());
  const until = async (predicate, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await read();
      if (predicate(state)) return state;
      await page.waitForTimeout(75);
    }
    throw new Error(`撤权回收条件未在期限内成立：${phase}`);
  };
  const revoke = token => page.request.post(`${fixture.url}/admin/room/revoke-token`, {
    headers: { Authorization: `Bearer ${fixture.control_token}` },
    data: { fence: fixture.fence, role: "subscriber", token },
  });
  if (phase === "fill") {
    let offer;
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/whep") offer = request.postData();
    });
    await page.addInitScript(grants => { window.liveCapabilities = grants; }, fixture.grants);
    await page.reload();
    const baseline = await read();
    if (baseline.server.active_peers || baseline.server.revoked_tokens) throw new Error("容量实验开始前状态不为空");
    await page.getByRole("button", { name: "开始推流", exact: true }).click();
    const playing = await until(state => state.server.connected_peers === 2 && state.frame_callbacks["viewer-1"] > 5, 15000);
    const replies = [];
    for (const token of fixture.revocations) {
      const response = await revoke(token);
      if (response.status() !== 200) throw new Error(`64条未过期记录未全部接收：${response.status()}`);
      const reply = await response.json();
      if (reply.removed_sessions !== 0) throw new Error("未被使用的令牌误删了媒体连接");
      replies.push(reply.revoked_tokens);
    }
    const full = await until(state => state.server.revoked_tokens === 64 && state.server.active_peers === 2);
    const overflow = await revoke(fixture.extra);
    if (overflow.status() !== 503) throw new Error("未过期容量已满仍接受新撤权");
    const repeated = await revoke(fixture.revocations[0]);
    if (repeated.status() !== 200 || (await repeated.json()).revoked_tokens !== 64) throw new Error("满额时重复撤权不幂等");
    const replay = await page.request.post(`${fixture.url}/whep`, {
      headers: { Authorization: `Bearer ${fixture.revocations[0]}`, "Content-Type": "application/sdp" }, data: offer,
    });
    const oldManagement = await page.request.get(`${playing.connections["viewer-1"].resource}`, {
      headers: { Authorization: `Bearer ${fixture.revocations[0]}` },
    });
    if (oldManagement.status() !== 401 || replay.status() !== 401) throw new Error("容量压力丢弃了旧撤权");
    await page.evaluate(state => { window.reclamationTrial = state; }, { baseline, playing, full, offer });
    return { phase, baseline, playing, full, accepted_records: replies.length, record_counts: replies,
      overflow_status: overflow.status(), repeated_status: repeated.status(),
      old_management_status: oldManagement.status(), old_offer_status: replay.status() };
  }
  if (phase === "reclaim") {
    const trial = await page.evaluate(() => window.reclamationTrial);
    const reclaimed = await until(state => state.server.revoked_tokens === 0 &&
      state.server.reclaimed_revocations >= trial.baseline.server.reclaimed_revocations + 64 &&
      state.server.active_peers === 2 && state.frame_callbacks["viewer-1"] > trial.full.frame_callbacks["viewer-1"] + 8);
    const response = await revoke(fixture.extra);
    if (response.status() !== 200) throw new Error("到期回收后仍不能接收新撤权");
    const reply = await response.json();
    if (reply.revoked_tokens !== 1 || reply.removed_sessions !== 0) throw new Error("回收后的容量或媒体隔离不符");
    const duplicateOld = await revoke(fixture.old);
    const oldResource = await page.request.get(`${trial.playing.connections["viewer-1"].resource}`, {
      headers: { Authorization: `Bearer ${fixture.old}` },
    });
    const oldOffer = await page.request.post(`${fixture.url}/whep`, {
      headers: { Authorization: `Bearer ${fixture.old}`, "Content-Type": "application/sdp" }, data: trial.offer,
    });
    if (duplicateOld.status() !== 401 || oldResource.status() !== 401 || oldOffer.status() !== 401) throw new Error("回收后的旧授权重新有效");
    const continuing = await until(state => state.server.revoked_tokens === 1 &&
      state.frame_callbacks["viewer-1"] > reclaimed.frame_callbacks["viewer-1"] + 6);
    if (continuing.connections.publisher.resource !== trial.playing.connections.publisher.resource ||
        continuing.connections["viewer-1"].resource !== trial.playing.connections["viewer-1"].resource ||
        continuing.server.accepted_sessions !== trial.playing.server.accepted_sessions) {
      throw new Error("容量回收导致房间或媒体会话重建");
    }
    const sample = () => page.locator("#viewer-1").evaluate(video => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("容量回收画面取样超时")), 3000);
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
    const first = await sample();
    await until(state => state.frame_callbacks["viewer-1"] > continuing.frame_callbacks["viewer-1"] + 6);
    const second = await sample();
    if (first.hash === second.hash || first.width !== 640 || first.height !== 360) throw new Error("回收后画面未变化");
    const screenshot = `output/playwright/reclamation-${Date.now()}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.getByRole("button", { name: "停止", exact: true }).click();
    const stopped = await until(state => state.server.active_peers === 0 && Object.keys(state.connections).length === 0);
    return { phase, reclaimed, continuing, after_new_revocation: reply, stopped, first_pixels: first, second_pixels: second,
      old_control_status: duplicateOld.status(), old_resource_status: oldResource.status(), old_offer_status: oldOffer.status(), screenshot,
      original_sessions_preserved: true, no_room_drain_for_expiry_cleanup: true,
      scope: "同机Chrome；实际时钟回拨仅在Rust注入时序验证，未修改操作系统时钟" };
  }
  throw new Error("未知撤权回收阶段");
}
