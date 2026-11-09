import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControllerHealth } from '../src/app/controller-health.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const at = Date.parse('2026-11-04T00:00:00.000Z')
const privateBody = 'PRIVATE_PROVIDER_BODY api-key=DO_NOT_DISCLOSE'
const end = (seq: number, turn: number, kind: string, error?: unknown) =>
  ({ type: 'turn/end', seq, time: at + seq, data: { turn, reason: { kind, error } } })

it('只消费回合结束的宿主错误码，重试启动、取消或普通消息不冒充恢复', () => {
  const health = new ControllerHealth()
  health.observe(end(1, 1, 'error', { code: 'RATE_LIMIT', message: privateBody }))
  const failure = health.get()
  expect(failure).toMatchObject({ modelFailureCode: 'RATE_LIMIT', observedAt: new Date(at + 1).toISOString() })
  for (const [index, kind] of ['aborted', 'blocked', 'max-tokens', 'interrupted'].entries())
    health.observe(end(index + 2, index + 2, kind))
  health.observe({ type: 'llm/retry-started', seq: 6, time: at + 6, data: {} })
  health.observe({ type: 'assistant/message', seq: 7, time: at + 7, data: { text: 'AUTH' } })
  expect(health.get()).toEqual(failure)
  expect(JSON.stringify(health.get())).not.toContain(privateBody)
})

it('正常完成清除故障，重复或迟到日志不能覆盖新回合，返回值不可修改内部状态', () => {
  const health = new ControllerHealth()
  health.observe(end(4, 2, 'error', { code: 'AUTH' }))
  const returned = health.get()!
  returned.reason = 'FORGED'
  expect(health.get()!.reason).not.toBe('FORGED')
  health.observe(end(5, 3, 'completed'))
  expect(health.get()).toBeNull()
  health.observe(end(4, 2, 'error', { code: 'QUOTA' }))
  health.observe(end(6, 1, 'error', { code: 'QUOTA' }))
  expect(health.get()).toBeNull()
})

it('重放日志可重建或清除投影，未知和畸形故障不外传原文', () => {
  const health = new ControllerHealth()
  const error = end(2, 1, 'error', { code: 'provider_private_code', message: privateBody })
  health.restore([error])
  expect(health.get()).toMatchObject({ modelFailureCode: 'UNKNOWN' })
  expect(JSON.stringify(health.get())).not.toContain(privateBody)
  expect(JSON.stringify(health.get())).not.toContain('provider_private_code')
  health.observe({ ...end(3, 2, 'completed'), time: Infinity })
  health.observe({ ...end(3, 2, 'completed'), data: { turn: -1, reason: { kind: 'completed' } } })
  expect(health.get()!.modelFailureCode).toBe('UNKNOWN')
  health.restore([error, end(4, 2, 'completed')])
  expect(health.get()).toBeNull()
  health.restore([])
  expect(health.get()).toBeNull()
})

describe('HMM 总管故障管理投影', () => {
  let h: Host
  const master = () => h.agents.get(h.runtime.masterId)! as unknown as Agent
  const emit = (event: ReturnType<typeof end>, session = master().session) =>
    h.ctx.emit('session/event', session, event as never)
  const state = async () => {
    const result = await h.api('GET', 'state')
    expect(result.status).toBe(200)
    return result.body
  }
  beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
  afterEach(async () => { await h.stop() })

  it('待验收任务能区分总管故障与节点失败，读取诊断不改变成果、授权或通知', async () => {
    const created = await h.api('POST', 'tasks', { requestId: 'controller-check', goal: 'Summarize the supplied input', mode: 'single' })
    await h.runtime.idle()
    const id = created.body.ticketId as string
    const view = h.runtime.hmm.view({ role: 'controller' }, id)
    const session = view.nodes.find(node => node.mode === 'task')!.sessionId!
    const context = await h.runTool(session, 'hmm_node_context', {})
    await h.runTool(session, 'hmm_node_report', { action: 'complete', summary: 'The supplied input was checked.',
      evidenceRefs: [context.inputRef] })
    await h.runtime.idle()
    const before = h.runtime.store.get(KV.hmm.workflow(id)), deliveries = h.deliveries.mock.calls.length
    emit(end(10, 2, 'error', { code: 'RATE_LIMIT', message: privateBody }))
    h.ctx.emit('agent/status', { agent: master(), status: 'idle' } as never)
    expect(await state()).toMatchObject({ controllerFailure: { modelFailureCode: 'RATE_LIMIT' },
      health: { models: { state: 'error' } } })
    expect(await h.api('GET', `tasks/${id}`)).toMatchObject({
      status: 200, body: { result: null, workflow: { awaitingValidation: true, progress: { completed: 1, suspended: 0 } } },
    })
    expect(JSON.stringify(await state())).not.toContain(privateBody)
    expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
    expect(h.deliveries.mock.calls).toHaveLength(deliveries)
    emit(end(11, 3, 'completed'))
    expect(await state()).toMatchObject({ controllerFailure: null, health: { models: { state: 'ready' } } })
    expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  })

  it('宿主重启从原生会话日志重建诊断，不另写 KV 或依赖节点状态', async () => {
    const events = [end(8, 3, 'error', { code: 'AUTH', message: privateBody })]
    vi.spyOn(master().session, 'snapshotEvents').mockReturnValue(events as never)
    await h.restart()
    expect(await state()).toMatchObject({ controllerFailure: { modelFailureCode: 'AUTH' } })
    const snapshot = h.runtime.store.keys(KV.hmm.workflow)
    expect(snapshot).toEqual([])
    emit(end(9, 4, 'aborted'))
    expect(await state()).toMatchObject({ controllerFailure: { modelFailureCode: 'AUTH' } })
    emit(end(10, 5, 'completed'))
    expect(await state()).toMatchObject({ controllerFailure: null })
  })

  it('其他节点、同编号伪会话和仓库模式不能写入 HMM 总管诊断', async () => {
    const event = end(20, 5, 'error', { code: 'QUOTA', message: privateBody })
    emit(event, { ...master().session } as never)
    expect(await state()).toMatchObject({ controllerFailure: null })
    const created = await h.api('POST', 'tasks', { requestId: 'isolated-node', goal: 'Check the supplied constraints', mode: 'single' })
    await h.runtime.idle()
    const view = h.runtime.hmm.view({ role: 'controller' }, created.body.ticketId as string)
    const nodeId = view.nodes.find(node => node.mode === 'task')!.sessionId!
    emit(event, (h.agents.get(nodeId)! as unknown as Agent).session)
    expect(await state()).toMatchObject({ controllerFailure: null })
    await h.controller.create({ sessionId: 'unmanaged-session' })
    const other = h.agents.get('unmanaged-session')! as unknown as Agent
    emit(event, other.session)
    expect(await state()).toMatchObject({ controllerFailure: null })
    await h.stop()
    h = await startRuntime()
    emit(event)
    expect(await state()).toMatchObject({ controllerFailure: null })
  })
})
