import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function fixture() {
  const operations = [];
  const pending = [];
  const timers = new Map();
  let timerId = 0;
  const element = {
    value: "baseline", checked: false, disabled: false,
    addEventListener() {}, querySelector() { return {}; },
  };
  const context = vm.createContext({
    document: { getElementById: () => element },
    window: { addEventListener() {} },
    navigator: { userAgent: "protocol-test" },
    performance: { now: () => 2000 },
    location: { search: "" },
    URLSearchParams, structuredClone, AbortController,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      if (url === "/lab/config") {
        return Promise.resolve({ json: async () => ({}) });
      }
      operations.push({ url, options });
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        options.signal.addEventListener("abort", () => reject(new Error("请求已超时")));
      });
    },
  });
  vm.runInContext(source, context);
  const current = {
    consumption_persistence: true, consumption_submission_unknown: false,
    consumption_acked_events: 0, consumption_submissions: [],
  };
  const batch = { events: [{ sequence: 1 }, { sequence: 2 }] };
  context.current = current;
  context.batch = batch;
  return {
    context, current, operations, pending, timers,
    submit: () => vm.runInContext("submitConsumptionBatch(current, batch, false)", context),
    confirm(index = 0, body = {
      schema: "playback-lab-consumption-v1", persisted: true,
      commit: { durability: "persisted", base_offset: 0 },
    }) {
      pending[index].resolve({ ok: true, json: async () => body });
    },
  };
}

test("并发调用共用一次提交，载荷在提交时冻结，确认后才推进游标", async () => {
  const f = fixture();
  const first = f.submit();
  const second = f.submit();
  assert.equal(f.operations.length, 1);
  assert.equal(f.current.consumption_acked_events, 0);
  f.context.batch.events.push({ sequence: 3 });
  assert.equal(JSON.parse(f.operations[0].options.body).events.length, 2);
  f.confirm();
  await Promise.all([first, second]);
  assert.equal(f.current.consumption_acked_events, 2);
  assert.equal(f.current.consumption_submissions.length, 1);
  assert.equal(f.current.consumption_submissions[0].last_sequence, 2);
  assert.equal(f.timers.size, 0);
});

test("请求超时后结果未知，不能自动再发且不推进游标", async () => {
  const f = fixture();
  const first = f.submit();
  const rejection = assert.rejects(first, /超时/);
  for (const expire of [...f.timers.values()]) expire();
  await rejection;
  assert.equal(f.current.consumption_submission_unknown, true);
  assert.equal(f.current.consumption_acked_events, 0);
  await assert.rejects(f.submit(), /不自动重试/);
  assert.equal(f.operations.length, 1);
  assert.equal(f.timers.size, 0);
});

test("无持久确认或不安全偏移不能伪装成功，旧规范化模式仍兼容", async () => {
  for (const body of [
    { schema: "playback-lab-consumption-v1", persisted: false },
    { schema: "playback-lab-consumption-v1", persisted: true,
      commit: { durability: "replicated", base_offset: 0 } },
    { schema: "playback-lab-consumption-v1", persisted: true,
      commit: { durability: "persisted", base_offset: 9007199254740992 } },
  ]) {
    const f = fixture();
    const request = f.submit();
    f.confirm(0, body);
    await assert.rejects(request, /结果未知/);
    assert.equal(f.current.consumption_acked_events, 0);
    assert.equal(f.current.consumption_submissions.length, 0);
  }
  const f = fixture();
  f.current.consumption_persistence = false;
  const request = f.submit();
  f.confirm(0, { schema: "playback-lab-consumption-v1", persisted: false });
  await request;
  assert.equal(f.current.consumption_acked_events, 2);
});
