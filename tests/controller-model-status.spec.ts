import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { controllerModelStatus, MODEL_STATUS_TIMEOUT_MS } from '../src/app/controller-model-status.ts'
import { startRuntime } from './fixtures/host.ts'

afterEach(() => { vi.useRealTimers() })
const last = { provider: 'provider-a', model: 'model-a' }
const next = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'low' }
const configured = { provider: 'provider-c', model: 'model-c' }
const projection = (lastUsed: unknown = last, selected: unknown = next, asOfSeq = 17) => ({
  kind: 'sequenced', asOfSeq, values: { modelSelection: { lastUsed, next: selected }, privateHistory: 'PRIVATE' },
})
function fixture(value: unknown = projection()) {
  const projections = vi.fn(async () => value)
  const resolveAgent = vi.fn(), selectModel = vi.fn(), create = vi.fn()
  const context = { sessionController: { projections, resolveAgent, selectModel, create } } as unknown as Context
  const store = { settings: () => ({ eval: { model: configured } }), blockRevision: () => 9 }
  const read = (signal = new AbortController().signal) => controllerModelStatus(context, store, 'master-one', signal)
  return { projections, resolveAgent, selectModel, create, read, context, store }
}

it('区分保存配置、最近请求和后续选择，只返回模型投影而不激活会话', async () => {
  const f = fixture()
  const result = await f.read()
  expect(result).toMatchObject({ sessionId: 'master-one', configured: { model: configured, revision: 9 },
    observation: { state: 'observed', asOfSeq: 17, lastUsed: last, next } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
  expect(f.resolveAgent).not.toHaveBeenCalled()
  expect(f.selectModel).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.projections).toHaveBeenCalledWith({ sessionId: 'master-one' }, expect.any(AbortSignal))
})

it.each([
  [null, 'session_missing'],
  [{ kind: 'migration-required', values: { modelSelection: { lastUsed: last, next } } }, 'migration_required'],
  [{ kind: 'sequenced', asOfSeq: 0, values: {} }, 'projection_missing'],
  [projection(last, { model: 'incomplete' }), 'invalid_projection'],
  [projection(last, next, -1), 'invalid_projection'],
])('缺失、旧提示和无效数据保持未知，不用保存值补成已使用：%j', async (value, reason) => {
  const result = await fixture(value).read()
  expect(result.observation).toEqual({ state: 'unknown', reason })
  expect(result.observation).not.toHaveProperty('lastUsed')
})

it('零水位与未请求的有效投影不被误判，空选择不推断成宿主默认', async () => {
  expect((await fixture(projection(null, null, 0)).read()).observation)
    .toEqual({ state: 'observed', asOfSeq: 0, lastUsed: null, next: null })
  expect((await fixture(projection(null, next)).read()).observation)
    .toMatchObject({ lastUsed: null, next })
})

it('观察不按配置规则规范化模型身份，新增无关字段不泄露也不使有效记录失效', async () => {
  const recorded = { provider: ' provider/alias ', model: 'Model:版本-2 ', reasoningEffort: ' exact ' }
  const result = await fixture(projection({ ...recorded, diagnostic: 'PRIVATE_DIAGNOSTIC' }, recorded)).read()
  expect(result.observation).toMatchObject({ state: 'observed', lastUsed: recorded, next: recorded })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_DIAGNOSTIC')
})

it('读取能力缺失或读取失败不回退到激活会话，也不泄露原始错误', async () => {
  const f = fixture()
  delete (f.context.sessionController as unknown as Record<string, unknown>).projections
  expect((await f.read()).observation).toEqual({ state: 'unknown', reason: 'capability_missing' })
  const failing = fixture()
  failing.projections.mockRejectedValueOnce(new Error('PRIVATE_CREDENTIAL'))
  const result = await failing.read()
  expect(result.observation).toEqual({ state: 'unknown', reason: 'read_failed' })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_CREDENTIAL')
  expect(failing.resolveAgent).not.toHaveBeenCalled()
})

it('有界等待传递取消，迟到结果不能改变已返回的未知状态', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let finish!: (value: unknown) => void
  f.projections.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.read()
  await vi.advanceTimersByTimeAsync(MODEL_STATUS_TIMEOUT_MS)
  const result = await pending
  expect(result.observation).toEqual({ state: 'unknown', reason: 'timed_out' })
  const passed = (f.projections.mock.calls[0] as unknown as [unknown, AbortSignal])[1]
  expect(passed.aborted).toBe(true)
  finish(projection())
  await Promise.resolve()
  expect(result.observation).toEqual({ state: 'unknown', reason: 'timed_out' })
})

it('已取消的读取不开始宿主操作', async () => {
  const f = fixture()
  expect((await f.read(AbortSignal.abort())).observation).toEqual({ state: 'unknown', reason: 'cancelled' })
  expect(f.projections).not.toHaveBeenCalled()
})

it('管理接口固定读取自己的总管，不接受路径参数来探查其他会话', async () => {
  const h = await startRuntime()
  try {
    const projections = vi.fn(async () => projection())
    Object.assign(h.controller, { projections })
    const created = h.controller.create.mock.calls.length
    const resolved = h.controller.resolveAgent.mock.calls.length
    const revision = h.runtime.store.blockRevision('eval')
    const result = await h.api('GET', 'models/controller')
    expect(result).toMatchObject({ status: 200, body: { sessionId: h.runtime.masterId,
      configured: { revision }, observation: { state: 'observed', lastUsed: last, next } } })
    expect(projections.mock.calls[0]).toEqual([{ sessionId: h.runtime.masterId }, expect.any(AbortSignal)])
    expect(h.controller.create).toHaveBeenCalledTimes(created)
    expect(h.controller.resolveAgent).toHaveBeenCalledTimes(resolved)
    expect(h.controller.selectModel).not.toHaveBeenCalled()
    expect(h.runtime.store.blockRevision('eval')).toBe(revision)
    expect(await h.api('GET', 'models/controller?sessionId=another-session')).toMatchObject({
      status: 200, body: { sessionId: h.runtime.masterId },
    })
    expect(projections.mock.calls.at(-1)).toEqual([{ sessionId: h.runtime.masterId }, expect.any(AbortSignal)])
    expect(await h.api('GET', 'models/controller/another-session')).toMatchObject({ status: 404 })
  } finally { await h.stop() }
})
