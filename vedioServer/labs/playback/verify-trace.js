async (page) => {
  const settings = await page.evaluate(() => {
    const query = new URLSearchParams(location.search);
    return {
      policy: query.get("policy"),
      scenario: query.get("scenario"),
      rate: Number(query.get("rate")),
    };
  });
  if (!["baseline", "keep_inflight", "small_window", "rust_time"].includes(settings.policy) ||
      !["resume", "abandon", "sustain"].includes(settings.scenario) ||
      ![120000, 48000, 300000].includes(settings.rate)) {
    throw new Error("对照实验参数无效");
  }
  const session = await page.context().newCDPSession(page);
  const cmcdRequests = [];
  const controlRequests = [];
  const collect = (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/control/") || pathname === "/lab/policy") controlRequests.push(pathname);
    const headers = request.headers();
    if (!headers["cmcd-session"]) return;
    cmcdRequests.push({
      path: new URL(request.url()).pathname.replace(
        /\/v1\/playback\/[^/]+/, "/v1/playback/[credential]"),
      session: headers["cmcd-session"],
      request: headers["cmcd-request"] || null,
    });
  };
  page.on("request", collect);
  try {
    await session.send("Network.enable");
    await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    await session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 60, downloadThroughput: settings.rate, uploadThroughput: 64000,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    // 观看动作在浏览器内按媒体位置触发，避免CLI调度延迟改变各候选的消费长度。
    await page.evaluate(({ scenario }) => {
      const video = document.querySelector("video");
      const state = {
        scenario, done: false, error: null, actions: [], pixels: [], paused: false,
      };
      window.playbackTrace = state;
      const snapshot = (action) => {
        const report = window.playbackObservation();
        const value = {
          action, position_seconds: video.currentTime,
          elapsed_ms: performance.now() - report.started_at_monotonic_ms,
          received_body_bytes: report.received_body_bytes,
          request_count: report.requests.length,
          active_requests: report.active_requests,
        };
        state.actions.push(value);
        return value;
      };
      const pixels = () => {
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
          hash = (Math.imul(hash, 31) + data[index] + data[index + 1] * 7 +
            data[index + 2] * 13) >>> 0;
          low = Math.min(low, data[index], data[index + 1], data[index + 2]);
          high = Math.max(high, data[index], data[index + 1], data[index + 2]);
        }
        return { hash, low, high, media_time: video.currentTime };
      };
      let resumeTimer;
      let frame;
      const deadline = setTimeout(() => {
        state.error = "观看轨迹超时";
        finish();
      }, 45000);
      const finish = () => {
        clearTimeout(deadline);
        clearTimeout(resumeTimer);
        video.cancelVideoFrameCallback(frame);
        if (window.playbackObservation()) snapshot("stop");
        document.querySelector("#stop").click();
        state.done = true;
      };
      const inspect = () => {
        if (state.done) return;
        try {
          const position = video.currentTime;
          if (!state.pixels.length && position >= 0.5) state.pixels.push(pixels());
          if (scenario === "resume" && !state.paused && position >= 1.25) {
            state.paused = true;
            video.pause();
            snapshot("pause");
            resumeTimer = setTimeout(() => {
              snapshot("resume");
              video.play().catch(() => {
                state.error = "暂停后恢复失败";
                finish();
              });
            }, 800);
          }
          const stopAt = scenario === "resume" ? 6 : scenario === "sustain" ? 12 : 1.25;
          if (position >= stopAt) {
            state.pixels.push(pixels());
            finish();
            return;
          }
        } catch {
          state.error = "观看轨迹采样失败";
          finish();
          return;
        }
        frame = video.requestVideoFrameCallback(inspect);
      };
      frame = video.requestVideoFrameCallback(inspect);
    }, settings);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => window.playbackTrace.done, null, { timeout: 48000 });
    await page.waitForFunction(() => window.playbackObservation()?.active_requests === 0,
      null, { timeout: 4000 });
    const stopped = await page.evaluate(() => window.playbackObservation());
    await page.waitForTimeout(600);
    const result = await page.evaluate(async () => ({
      trace: window.playbackTrace,
      observation: window.playbackObservation(),
      server_after: await fetch("/lab/metrics").then((value) => value.json()),
      consumption: await window.submitPlaybackConsumption(),
      control_resources: performance.getEntriesByType("resource")
        .filter((entry) => {
          const path = new URL(entry.name).pathname;
          return path.startsWith("/control/") || path === "/lab/policy";
        }).map((entry) => ({
          path: new URL(entry.name).pathname, decoded_body_bytes: entry.decodedBodySize,
        })),
    }));
    const observation = result.observation;
    const failures = [];
    if (result.trace.error) failures.push(result.trace.error);
    if (observation.error) failures.push("播放器报告错误");
    if (observation.policy.id !== settings.policy) failures.push("策略没有实际挂载");
    if (stopped.received_body_bytes !== observation.received_body_bytes ||
        stopped.requests.length !== observation.requests.length) failures.push("停止后仍下载");
    const target = settings.scenario === "resume" ? 6 : settings.scenario === "sustain" ? 12 : 1.25;
    const actual = observation.stopped_at_seconds;
    if (actual < target || actual > target + 0.15) failures.push("消费位置超出公平对照容差");
    const played = observation.played_ranges.reduce((sum, range) => sum + range[1] - range[0], 0);
    if (Math.abs(played - actual) > 0.1) failures.push("已播放区间与连续观看不一致");
    if (result.trace.pixels.length !== 2 ||
        result.trace.pixels.some((value) => value.high - value.low < 20) ||
        result.trace.pixels[0]?.hash === result.trace.pixels[1]?.hash) {
      failures.push("未观测到非空变化画面");
    }
    if (!result.consumption || result.consumption.summary.byte_scope !== "web_xhr_body" ||
        result.consumption.summary.last_known_transferred_bytes !== observation.received_body_bytes) {
      failures.push("消费规范化字节不一致");
    }
    if (!cmcdRequests.length || cmcdRequests.some((request) =>
      !request.session.includes(observation.playback_id) ||
      !request.request?.includes(observation.recommendation_request_id))) {
      failures.push("媒体请求关联不一致");
    }
    const before = observation.server_before;
    if (result.server_after.delivery.active_bodies !== 0 ||
        result.server_after.media_slots_available !== before.media_slots_available) {
      failures.push("服务端正文或读取许可未回收");
    }
    if (observation.omitted_request_records || observation.omitted_consumption_events) {
      failures.push("有观测记录被省略");
    }
    if (settings.policy === "rust_time") {
      const control = observation.rust_time_control;
      if (!control?.decisions || control.policy_fetches !== 1 || control.decision_rpcs !== 0 ||
          controlRequests.filter((value) => value === "/lab/policy").length !== 1 ||
          controlRequests.filter((value) => value === "/control/playback_bg.wasm").length !== 1) {
        failures.push("Rust本地执行或一次策略获取未成立");
      }
      if (stopped.rust_time_control?.decisions !== control?.decisions) {
        failures.push("停止后Rust定时控制仍在执行");
      }
      if (settings.scenario === "sustain" &&
          (!observation.loading_actions.some((value) => value.action === "rust_pause_buffering") ||
           !observation.loading_actions.some((value) => value.action === "rust_resume_buffering"))) {
        failures.push("持续观看未触发Rust高低阈值控制");
      }
    } else if (controlRequests.length) failures.push("对照策略意外加载Rust控制资源");
    const byPath = new Map();
    for (const request of observation.requests.filter((value) => value.path.endsWith(".mp4"))) {
      const entries = byPath.get(request.path) || [];
      entries.push(request);
      byPath.set(request.path, entries);
    }
    const repeats = [...byPath.values()].filter((entries) => entries.length > 1);
    const pause = result.trace.actions.find((value) => value.action === "pause");
    const resume = result.trace.actions.find((value) => value.action === "resume");
    let wasmContract = null;
    if (settings.policy === "rust_time" && settings.scenario === "sustain") {
      wasmContract = await page.evaluate(async () => {
        const module = await import("/control/playback.js");
        await module.default();
        const first = new module.BufferTimeGate(2000, 4000);
        const second = new module.BufferTimeGate(2000, 4000);
        const checks = {};
        try {
          checks.hysteresis = [
            [0, true], [3000, true], [4000, false], [3000, false], [1999, true],
          ].every(([buffered, expected]) => first.should_load(buffered, 1000) === expected);
          checks.object_isolation = second.should_load(3000, 1000) === false;
          first.reset();
          checks.reset = first.should_load(3000, 1000) === false;
          checks.invalid_numbers_rejected = [NaN, Infinity, -1, 1.5, 4294967296]
            .every((invalid) => {
              try { first.should_load(invalid, 1000); return false; } catch { return true; }
            });
          checks.rate_rejected = (() => {
            try { first.should_load(0, 0); return false; } catch { return true; }
          })();
          checks.invalid_policy_rejected = (() => {
            try {
              const invalid = new module.BufferTimeGate(4000, 2000);
              invalid.free();
              return false;
            } catch { return true; }
          })();
          checks.rate_scaling = first.should_load(3000, 2000) === true;
          checks.high_watermark = first.should_load(4000, 2000) === false;
          return checks;
        } finally {
          first.free();
          second.free();
        }
      });
      if (Object.values(wasmContract).some((value) => value !== true)) {
        failures.push("浏览器Wasm边界契约未通过");
      }
    }
    return {
      schema: "playback-policy-trial-v1",
      date: new Date().toISOString(),
      settings,
      valid: failures.length === 0,
      failures,
      measures: {
        played_seconds: played,
        first_frame_ms: observation.first_frame_callback_ms,
        stall_count: observation.stall_count,
        stall_ms: observation.stall_ms,
        client_body_bytes: observation.received_body_bytes,
        controller_decoded_body_bytes: result.control_resources.reduce(
          (sum, entry) => sum + entry.decoded_body_bytes, 0),
        media_plus_controller_body_bytes: observation.received_body_bytes +
          result.control_resources.reduce((sum, entry) => sum + entry.decoded_body_bytes, 0),
        server_yielded_bytes: result.server_after.delivery.yielded_bytes - before.delivery.yielded_bytes,
        server_requests: result.server_after.delivery.requests - before.delivery.requests,
        aborted_requests: observation.aborted_requests,
        repeated_fragment_paths: repeats.length,
        repeated_fragment_received_bytes: repeats.reduce((sum, entries) =>
          sum + entries.slice(0, -1).reduce((total, value) => total + value.received_body_bytes, 0), 0),
        pause_bytes: resume ? resume.received_body_bytes - pause.received_body_bytes : null,
        pause_new_requests: resume ? resume.request_count - pause.request_count : null,
        pause_at_active_request: pause ? pause.active_requests > 0 : null,
        peak_forward_buffer_seconds: observation.peak_forward_buffer_seconds,
      },
      stop_stable: stopped.received_body_bytes === observation.received_body_bytes,
      result,
      cmcd_requests: cmcdRequests,
      control_requests: controlRequests,
      wasm_contract: wasmContract,
      scope: "同机Chrome模拟网络；计量XHR正文与服务端产出差值，不是线路字节、RSS、可信观看或原生真机",
    };
  } finally {
    page.off("request", collect);
    await session.send("Network.disable").catch(() => {});
    await session.detach();
  }
}
