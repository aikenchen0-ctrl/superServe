async (page) => {
  const deletions = [];
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => {
    if (response.request().method() === "DELETE") {
      deletions.push({ path: new URL(response.url()).pathname, status: response.status() });
    }
  });
  const read = () => page.evaluate(() => window.liveObservation());
  const until = async predicate => {
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline) {
      const state = await read();
      if (predicate(state)) return state;
      await page.waitForTimeout(50);
    }
    throw new Error("凭据到期媒体状态未在期限内成立");
  };
  const baseline = await read();
  if (baseline.server.active_peers !== 0) throw new Error("到期实验开始时存在其他会话");
  await page.getByRole("button", { name: "开始推流", exact: true }).click();
  const playing = await until(state => state.server.connected_peers === 2 && state.frame_callbacks["viewer-1"] > 3);
  const expired = await until(state => state.server.active_peers === 1 && state.server.publishers === 1 &&
    state.server.removed_sessions === baseline.server.removed_sessions + 1);
  await page.waitForTimeout(600);
  const settled = await read();
  const publisherContinues = await until(state => state.server.encoded_frames_received > settled.server.encoded_frames_received + 5);
  if (publisherContinues.server.encoded_frames_forwarded !== settled.server.encoded_frames_forwarded ||
      publisherContinues.frame_callbacks["viewer-1"] !== settled.frame_callbacks["viewer-1"]) {
    throw new Error("观看授权过期后仍转发或呈现新帧");
  }
  await page.getByRole("button", { name: "停止", exact: true }).click();
  const stopped = await until(state => state.server.active_peers === 0 && Object.keys(state.connections).length === 0);
  if (!stopped.server.worker_alive || !deletions.some(item => item.path.startsWith("/whep/") && item.status === 401) ||
      !deletions.some(item => item.path.startsWith("/whip/") && item.status === 200) || pageErrors.length) {
    throw new Error("过期观看者的清理错误阻断了其余连接回收");
  }
  return {
    schema: "live-grant-expiry-browser-v1", baseline, playing, expired, settled,
    publisher_continues: publisherContinues, stopped, deletions, page_errors: pageErrors,
    viewer_media_stops_without_stopping_publisher: true,
    expired_delete_does_not_block_publisher_cleanup: true,
    scope: "本机Chrome合成VP8；不是精确撤权时延、真机或生产集群验证",
  };
}
