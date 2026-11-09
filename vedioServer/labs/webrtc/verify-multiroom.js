async (page, fixture, phase) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = async (target, predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const value = await target.evaluate(() => window.liveObservation());
      if (predicate(value)) return value;
      await target.waitForTimeout(75);
    }
    throw new Error("多房间媒体条件未在期限内成立");
  };
  const playing = state => state.server.connected_peers === 3 &&
    ["viewer-1", "viewer-2"].every(name => state.frame_callbacks[name] > 8 &&
      state.connections[name]?.audio?.rms > 0.01 &&
      state.connections[name]?.stats.some(stat => stat.type === "inbound-rtp" &&
        stat.kind === "video" && stat.framesDecoded > 8));
  if (phase === "cordoned") {
    const results = [];
    for (const room of fixture.rooms) {
      const target = page.context().pages().find((value) => value.url() === room.url);
      assert(target, "节点停止接单后房间页面丢失");
      const first = await target.evaluate(() => window.liveObservation());
      const active = await wait(target, (state) => playing(state)
        && state.frame_callbacks["viewer-1"] > first.frame_callbacks["viewer-1"] + 8
        && state.server.audio_packets_forwarded > first.server.audio_packets_forwarded);
      for (const name of ["publisher", "viewer-1", "viewer-2"]) {
        assert(first.connections[name].resource === active.connections[name].resource,
          "节点排空标记导致既有会话重建");
      }
      results.push({ path: room.path, first, active });
    }
    return { phase, results, all_existing_sessions_keep_original_resources: true };
  }
  if (phase === "begin" || phase === "extend" || phase === "restored" || phase === "migrated") {
    const errors = [];
    const results = [];
    for (let index = 0; index < fixture.rooms.length; index++) {
      const room = fixture.rooms[index];
      if (phase === "migrated" && index === 1) continue;
      if (page.context().pages().some(value => value.url() === room.url)) {
        const existing = page.context().pages().find(value => value.url() === room.url);
        const current = await existing.evaluate(() => window.liveObservation?.());
        if (current?.server.active_peers > 0) continue;
      }
      const target = index === 0 ? page : await page.context().newPage();
      target.on("pageerror", error => errors.push(error.message));
      await target.addInitScript(grants => { window.liveCapabilities = grants; }, room.grants);
      await target.goto(room.url);
      await target.getByRole("button", { name: "开始推流", exact: true }).click();
      await wait(target, state => state.server.connected_peers === 2);
      await target.getByRole("button", { name: "增加订阅", exact: true }).click();
      await wait(target, playing);
    }
    // 全部房间启动后再取样，不能把串行单房间成功当成并发成功。
    for (const [index, room] of fixture.rooms.entries()) {
      if (phase === "migrated" && index === 1) continue;
      const target = page.context().pages().find(value => value.url() === room.url);
      assert(target, "缺少并发房间页面");
      const first = await wait(target, playing);
      const next = await wait(target, state => playing(state) &&
        state.frame_callbacks["viewer-1"] > first.frame_callbacks["viewer-1"] + 8 &&
        state.server.audio_packets_forwarded > first.server.audio_packets_forwarded);
      for (const name of ["viewer-1", "viewer-2"]) {
        assert(Math.abs(next.connections[name].audio.peak_hz - room.tone) < 50, "房间音频频率串流");
        assert(next.connections[name].resource.startsWith(`${room.node_url || fixture.node_url}${room.path}/whep/sessions/`),
          "房间资源地址越界");
      }
      const markers = {};
      for (const name of ["viewer-1", "viewer-2"]) {
        const marker = await target.locator(`#${name}`).evaluate(video => {
          const canvas = document.createElement("canvas");
          canvas.width = 640; canvas.height = 360;
          const context = canvas.getContext("2d");
          context.drawImage(video, 0, 0, 640, 360);
          return [...context.getImageData(608, 32, 1, 1).data];
        });
        assert(room.marker.every((value, index) => Math.abs(value - marker[index]) < 32),
          "房间视频标记串流");
        markers[name] = marker;
      }
      const screenshot = `output/playwright/multiroom-${fixture.stamp}-${phase}-${room.variant}.png`;
      await target.screenshot({ path: screenshot, fullPage: true });
      results.push({ path: room.path, first, next, markers, screenshot });
    }
    assert(errors.length === 0, errors.join("；"));
    return { phase, simultaneous_rooms: results.length, results, page_errors: errors };
  }
  const results = [];
  for (let index = 0; index < fixture.rooms.length; index++) {
    const room = fixture.rooms[index];
    const target = page.context().pages().find(value => value.url() === room.url);
    assert(target, "房间页面已丢失");
    const first = await target.evaluate(() => window.liveObservation());
    if (index === 0 || phase === "revoked" && index === 1) {
      const stopped = await wait(target, state => state.server.active_peers === 0);
      await target.waitForTimeout(700);
      const after = await target.evaluate(() => window.liveObservation());
      assert(after.server.encoded_frames_forwarded === stopped.server.encoded_frames_forwarded &&
        after.server.audio_packets_forwarded === stopped.server.audio_packets_forwarded,
      "排空房间仍在转发媒体");
      results.push({ path: room.path, stopped: after });
      continue;
    }
    const active = await wait(target, state => playing(state) &&
      state.frame_callbacks["viewer-1"] > first.frame_callbacks["viewer-1"] + 8 &&
      state.server.audio_packets_forwarded > first.server.audio_packets_forwarded);
    for (const name of ["publisher", "viewer-1", "viewer-2"]) {
      assert(first.connections[name].resource === active.connections[name].resource,
        "其他房间被重建连接");
    }
    results.push({ path: room.path, first, active });
  }
  return { phase, results, drained_only_target_room: true, other_rooms_keep_original_sessions: true };
}
