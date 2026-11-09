async (page, expectedCodec, expectedAudio) => {
  const query = new URL(page.url()).searchParams;
  expectedCodec ??= query.get("codec") || "vp8";
  expectedAudio ??= query.get("audio") === "opus";
  const errors = [];
  const exchanges = [];
  const deletions = [];
  const responseChecks = [];
  const legacyOffers = [];
  const candidateUpdates = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    const request = response.request();
    if (path.startsWith("/lab/offer/")) legacyOffers.push(path);
    if (request.method() === "PATCH") candidateUpdates.push({
      status: response.status(), content_type: request.headers()["content-type"],
      has_if_match: !!request.headers()["if-match"],
      has_credentials: (request.postData() || "").includes("a=ice-ufrag:"),
    });
    if (request.method() === "DELETE" && /^\/(whip|whep)\/sessions\//.test(path)) {
      deletions.push({ path, status: response.status() });
    }
    if (request.method() !== "POST" || !["/whip", "/whep"].includes(path)) return;
    responseChecks.push((async () => {
      const body = await response.text();
      const offered = request.postData() || "";
      exchanges.push({
        endpoint: path,
        status: response.status(),
        request_type: request.headers()["content-type"],
        request_bytes: request.postDataBuffer()?.length,
        authorization_present: !!request.headers().authorization,
        authorization_bytes: Buffer.byteLength(request.headers().authorization || ""),
        request_candidate_lines: offered.split(/\r?\n/).filter(line => line.startsWith("a=candidate:")).length,
        request_has_mdns_candidate: offered.split(/\r?\n/).some(line => line.startsWith("a=candidate:") && line.includes(".local ")),
        response_type: response.headers()["content-type"],
        response_bytes: Buffer.byteLength(body),
        answer_codecs: [...new Set([...body.matchAll(/a=rtpmap:\d+ ([^/]+)\/90000/g)].map(match => match[1].toLowerCase()))],
        location: response.headers().location,
        lease_seconds: Number(response.headers()["x-vs-session-lease"]),
        answer_has_end_of_candidates: body.includes("a=end-of-candidates"),
        answer_advertises_trickle: body.includes("a=ice-options:trickle"),
      });
    })());
  });
  const readState = () => page.evaluate(() => window.liveObservation());
  const waitUntil = async (predicate, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await readState();
      if (predicate(state)) return state;
      await page.waitForTimeout(50);
    }
    throw new Error("媒体观测条件未在期限内成立");
  };
  const baseline = await readState();
  if (baseline.server.active_peers !== 0) throw new Error("实验开始时仍有活动会话");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "开始推流", exact: true }).click();
  await page.waitForFunction(() => window.liveObservation &&
    document.querySelector("#viewer-1").readyState >= 2, null, { timeout: 20000 });
  await page.getByRole("button", { name: "增加订阅", exact: true }).click();
  const first = await waitUntil(state =>
    state.frame_callbacks["viewer-1"] > 8 && state.frame_callbacks["viewer-2"] > 8 &&
    state.server.connected_peers === 3 && state.server.worker_alive &&
    (!expectedAudio || ["viewer-1", "viewer-2"].every(name =>
      state.connections[name]?.stats.some(stat => stat.type === "inbound-rtp" && stat.kind === "audio" &&
        stat.totalSamplesReceived > 4800 && stat.packetsReceived > 5) && state.connections[name]?.audio?.rms > 0.01)), 20000);
  const codecEvidence = {};
  const audioEvidence = {};
  for (const [name, connection] of Object.entries(first.connections)) {
    const direction = name === "publisher" ? "outbound-rtp" : "inbound-rtp";
    const rtp = connection.stats.find(entry => entry.type === direction && entry.kind === "video");
    const codec = connection.stats.find(entry => entry.type === "codec" && entry.id === rtp?.codecId);
    const frameCount = name === "publisher" ? rtp?.framesEncoded : rtp?.framesDecoded;
    if (codec?.mimeType?.toLowerCase() !== `video/${expectedCodec}` ||
        codec.clockRate !== 90000 || !(frameCount > 0) || rtp.frameWidth !== 640 || rtp.frameHeight !== 360 ||
        expectedCodec === "h264" && (!codec.sdpFmtpLine.includes("profile-level-id=42e01f") ||
          !codec.sdpFmtpLine.includes("packetization-mode=1"))) {
      throw new Error(`实际媒体编码或解码帧不符：${name}`);
    }
    codecEvidence[name] = { mime_type: codec.mimeType, payload_type: codec.payloadType,
      format: codec.sdpFmtpLine || "", frames: frameCount, width: rtp.frameWidth, height: rtp.frameHeight };
    if (expectedAudio) {
      const audio = connection.stats.find(entry => entry.type === direction && entry.kind === "audio");
      const params = connection.stats.find(entry => entry.type === "codec" && entry.id === audio?.codecId);
      if (params?.mimeType?.toLowerCase() !== "audio/opus" || params.clockRate !== 48000 || params.channels !== 2 ||
          name !== "publisher" && (!(audio.totalSamplesReceived > 4800) || !(audio.packetsReceived > 5) ||
            !(connection.audio?.rms > 0.01) || Math.abs(connection.audio?.peak_hz - 440) > 50)) {
        throw new Error(`Opus实际收发或解码音源不符：${name}`);
      }
      audioEvidence[name] = { mime_type: params.mimeType, payload_type: params.payloadType,
        clock_rate: params.clockRate, channels: params.channels, packets_sent: audio.packetsSent || 0,
        packets_received: audio.packetsReceived || 0,
        samples_received: audio.totalSamplesReceived || 0, energy: audio.totalAudioEnergy || 0,
        decoded_signal: connection.audio || null };
    }
  }
  if (first.server.active_video_codec !== expectedCodec) throw new Error("媒体线程编码状态与实际收发不符");
  if (expectedAudio && (first.server.active_audio_codec !== "opus" || !first.server.audio_packets_forwarded)) {
    throw new Error("媒体线程未转发Opus音频");
  }
  const pixels = async (selector) => page.locator(selector).evaluate(video => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("视频帧取样超时")), 3000);
    video.requestVideoFrameCallback(async (_, metadata) => {
    clearTimeout(timeout);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, 32, 18);
    const bytes = context.getImageData(0, 0, 32, 18).data;
    let low = 255;
    let high = 0;
    for (let index = 0; index < bytes.length; index += 4) {
      low = Math.min(low, bytes[index], bytes[index + 1], bytes[index + 2]);
      high = Math.max(high, bytes[index], bytes[index + 1], bytes[index + 2]);
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
    resolve({ hash, low, high, width: video.videoWidth, height: video.videoHeight, media_time: metadata.mediaTime });
    });
  }));
  const firstPixels = await Promise.all([pixels("#viewer-1"), pixels("#viewer-2")]);
  const sampled = await readState();
  await waitUntil(state => state.frame_callbacks["viewer-1"] > sampled.frame_callbacks["viewer-1"] + 5 &&
    state.frame_callbacks["viewer-2"] > sampled.frame_callbacks["viewer-2"] + 5, 10000);
  const secondPixels = await Promise.all([pixels("#viewer-1"), pixels("#viewer-2")]);
  for (let i = 0; i < 2; i++) {
    if (firstPixels[i].high - firstPixels[i].low < 20 || firstPixels[i].hash === secondPixels[i].hash) {
      throw new Error(`订阅端画面空白或没有变化：${JSON.stringify({ first: firstPixels[i], second: secondPixels[i] })}`);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshots = {
    desktop: `output/playwright/webrtc-${stamp}-desktop.png`,
    mobile: `output/playwright/webrtc-${stamp}-mobile.png`,
  };
  await page.screenshot({ path: screenshots.desktop, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: screenshots.mobile, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw new Error("手机宽度布局溢出");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.liveRemoveSubscriber("viewer-1"));
  const before = await readState();
  const surviving = await waitUntil(state => state.server.worker_alive && state.server.active_peers === 2 &&
    state.frame_callbacks["viewer-2"] > before.frame_callbacks["viewer-2"] + 5 &&
    (!expectedAudio || state.server.audio_packets_forwarded > before.server.audio_packets_forwarded &&
      state.connections["viewer-2"].stats.some(stat => stat.type === "inbound-rtp" && stat.kind === "audio" &&
        stat.totalSamplesReceived > first.connections["viewer-2"].stats.find(
          value => value.type === "inbound-rtp" && value.kind === "audio").totalSamplesReceived)), 10000);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  const stopped = await waitUntil(state => state.server.active_peers === 0);
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.liveObservation());
  if (!after.server.worker_alive || after.server.active_peers !== 0 || stopped.server.encoded_frames_forwarded !== after.server.encoded_frames_forwarded ||
      stopped.server.outgoing_udp_payload_bytes !== after.server.outgoing_udp_payload_bytes ||
      stopped.server.audio_packets_forwarded !== after.server.audio_packets_forwarded) {
    throw new Error("停止后仍发送媒体");
  }
  if (errors.length) throw new Error(errors.join("；"));
  await Promise.all(responseChecks);
  const trickle = new URL(page.url()).searchParams.get("ice") === "trickle";
  if (trickle && (candidateUpdates.length < 3 || candidateUpdates.some(item =>
    item.status !== 204 || item.content_type !== "application/trickle-ice-sdpfrag" ||
    !item.has_if_match || !item.has_credentials) || !Object.values(after.ice || {}).every(item =>
      item.mode === "trickle" && item.patches > 0 && item.failures === 0) ||
    !Object.values(after.ice || {}).some(item => item.post_started_before_gather_complete))) {
    throw new Error("增量ICE更新未通过实际候选、代次或HTTP校验");
  }
  if (!trickle && candidateUpdates.length) throw new Error("完整收集模式意外发送候选PATCH");
  if (legacyOffers.length || exchanges.length !== 3 || deletions.length !== 3 ||
      deletions.some(item => item.status !== 200) ||
    exchanges.some(item => item.status !== 201 || item.request_type !== "application/sdp" ||
        item.response_type !== "application/sdp" || !item.location || item.lease_seconds !== 60 ||
        !item.answer_has_end_of_candidates || !item.answer_advertises_trickle ||
        !item.answer_codecs.includes(expectedCodec))) {
    throw new Error(`SDP HTTP接入或资源回收不符合实验契约：${JSON.stringify({ exchanges, deletions, legacyOffers })}`);
  }
  return {
    schema: "str0m-sdp-http-browser-admission-v1",
    date: new Date().toISOString(),
    baseline, first, first_pixels: firstPixels, second_pixels: secondPixels,
    surviving, stopped: after, screenshots,
    single_subscriber_removal_preserves_other_video: true,
    stop_reclaims_all_peers_and_stops_media: true,
    mobile_horizontal_overflow: false,
    page_errors: errors,
    http: { exchanges, deletions, legacy_offers: legacyOffers, candidate_updates: candidateUpdates },
    codec: expectedCodec, codec_evidence: codecEvidence, audio_evidence: audioEvidence,
    scope: "本机Chrome合成单编码视频、WHIP/WHEP草案05接入子集，一发布两订阅；不证明完整规范、真机、跨网、采集到显示延迟、生产SFU或物理集群",
  };
}
