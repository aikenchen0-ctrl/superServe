async (page, fixture, phase) => {
  const read = () => page.evaluate(() => window.liveObservation());
  const until = async (predicate, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await read();
      if (predicate(state)) return state;
      await page.waitForTimeout(100);
    }
    throw new Error(`续权实验未达到观测条件：${phase}`);
  };
  const pixels = () => page.locator("#viewer-1").evaluate(video => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("续权画面取样超时")), 3000);
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
  if (phase === "begin") {
    await page.addInitScript(grants => { window.liveCapabilities = grants; }, fixture.grants);
    await page.reload();
    const baseline = await read();
    if (baseline.server.active_peers) throw new Error("续权实验开始前仍有会话");
    await page.evaluate(() => { window.renewalTrial = { started_at: performance.now() }; });
    await page.getByRole("button", { name: "开始推流", exact: true }).click();
    await until(state => state.frame_callbacks["viewer-1"] > 5, 15000);
    await page.getByRole("button", { name: "增加订阅", exact: true }).click();
    const playing = await until(state => state.server.connected_peers === 3 && state.frame_callbacks["viewer-2"] > 5, 15000);
    const firstPixels = await pixels();
    await page.evaluate(state => { window.renewalTrial.playing = state; }, playing);
    return { phase, baseline, playing, first_pixels: firstPixels };
  }
  if (phase === "renew") {
    const replies = await page.evaluate(async grants => {
      const replies = {};
      for (const name of ["publisher", "viewer-1"]) replies[name] = await window.liveRenewSession(name, grants[name]);
      window.renewalTrial.renewed = replies;
      return replies;
    }, fixture.grants);
    return { phase, replies, after: await read(), request_body_bytes: 0,
      authorization_value_bytes: Object.fromEntries(["publisher", "viewer-1"].map(
        name => [name, Buffer.byteLength(`Bearer ${fixture.grants[name]}`)],
      )) };
  }
  if (phase === "boundary") {
    const trial = await page.evaluate(() => window.renewalTrial);
    const elapsed = await page.evaluate(() => performance.now() - window.renewalTrial.started_at);
    if (elapsed < 63000) await page.waitForTimeout(63000 - elapsed);
    const crossed = await until(state => state.server.active_peers === 2 && state.server.connected_peers === 2 &&
      state.server.removed_sessions === trial.playing.server.removed_sessions + 1 &&
      state.frame_callbacks["viewer-1"] > trial.playing.frame_callbacks["viewer-1"] + 20, 5000);
    if (crossed.server.active_audio_codec === "opus" &&
        (!crossed.connections["viewer-1"].audio || crossed.connections["viewer-1"].audio.rms <= 0.01 ||
          crossed.server.audio_packets_forwarded <= trial.playing.server.audio_packets_forwarded)) {
      throw new Error("续权跨期限后音频没有继续解码");
    }
    const first = await pixels();
    await until(state => state.frame_callbacks["viewer-1"] > crossed.frame_callbacks["viewer-1"] + 6, 5000);
    const second = await pixels();
    if (first.hash === second.hash || first.width !== 640 || first.height !== 360 ||
        crossed.server.accepted_sessions !== trial.playing.server.accepted_sessions ||
        crossed.connections.publisher.resource !== trial.playing.connections.publisher.resource ||
        crossed.connections["viewer-1"].resource !== trial.playing.connections["viewer-1"].resource) {
      throw new Error("续权跨越旧期限后没有维持原会话的变化画面");
    }
    const resource = crossed.connections["viewer-1"].resource;
    const stale = await page.request.post(`${resource}/renew`, {
      headers: { Authorization: `Bearer ${fixture.original["viewer-1"]}` },
    });
    if (stale.status() !== 409) throw new Error(`旧凭据未被拒绝：${stale.status()}`);
    const retry = await page.evaluate(token => window.liveRenewSession("viewer-1", token), fixture.grants["viewer-1"]);
    const expiry = trial.renewed["viewer-1"].expires_unix_seconds;
    if (retry.expires_unix_seconds !== expiry || retry.lease_milliseconds > (expiry * 1000 - Date.now()) + 100) {
      throw new Error("重复续权滑动了绝对期限");
    }
    const screenshot = `output/playwright/renewal-${Date.now()}-after-60s.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    return { phase, elapsed_milliseconds: await page.evaluate(() => performance.now() - window.renewalTrial.started_at),
      crossed, first_pixels: first, second_pixels: second, retry,
      stale_status: stale.status(), screenshot, same_sessions_past_sixty_seconds: true };
  }
  if (phase === "expire") {
    const trial = await page.evaluate(() => window.renewalTrial);
    const expired = await until(state => state.server.active_peers === 0 &&
      state.server.removed_sessions === trial.playing.server.removed_sessions + 3, 25000);
    await page.waitForTimeout(800);
    const settled = await read();
    await page.waitForTimeout(500);
    const after = await read();
    if (settled.server.outgoing_udp_payload_bytes !== after.server.outgoing_udp_payload_bytes ||
        settled.server.encoded_frames_forwarded !== after.server.encoded_frames_forwarded ||
        settled.server.audio_packets_forwarded !== after.server.audio_packets_forwarded ||
        settled.frame_callbacks["viewer-1"] !== after.frame_callbacks["viewer-1"] ||
        settled.frame_callbacks["viewer-2"] !== after.frame_callbacks["viewer-2"]) {
      throw new Error("停止续权后仍有新媒体发送或呈现");
    }
    const missing = await page.request.post(`${trial.playing.connections["viewer-1"].resource}/renew`, {
      headers: { Authorization: `Bearer ${fixture.grants["viewer-1"]}` },
    });
    if (missing.status() !== 404) throw new Error("新凭据复活了到期会话");
    await page.getByRole("button", { name: "停止", exact: true }).click();
    const stopped = await until(state => Object.keys(state.connections).length === 0, 5000);
    if (Object.keys(stopped.connections).length || !stopped.server.worker_alive) throw new Error("续权实验没有释放本机连接");
    return { phase, expired, settled, after, stopped, renewed_grant_cannot_revive_expired_session_status: missing.status(),
      scope: "同机Chrome合成单编码视频；不是原生、切网、即时撤权或线路成本证明" };
  }
  throw new Error("未知续权验证阶段");
}
