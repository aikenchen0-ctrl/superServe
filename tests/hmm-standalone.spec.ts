import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Config, machineOf } from '../src/deployment.ts'
import { KV } from '../src/kv.ts'
import { HMM_CONTROLLER_PRESET } from '../src/app/sessions.ts'
import type { HmmCommand } from '../src/hmm/model.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime(store => {
    store.saveSettings({ ...store.settings(), sources: {} })
  }, { mode: 'hmm' })
})
afterEach(async () => { await h.stop() })

async function task(requestId = 'standalone', goal = '整理现有资料，说明结论及缺失依据') {
  const response = await h.api('POST', 'tasks', { requestId, goal })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view({ role: 'controller' }, id)
  const node = (name: string) => view().nodes.find(item => item.id === name)!
  const command = async (command: HmmCommand) => {
    const result = await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: id, revision: view().revision, command })
    await h.runtime.idle()
    return result
  }
  const complete = async (name: string, summary: string) => {
    const context = h.runtime.hmm.context({ role: 'controller' }, id, name)
    const refs = context.sourceResults.map(result => result.ref)
    await h.runTool(node(name).sessionId!, 'hmm_node_report', {
      action: 'complete', summary, evidenceRefs: refs.length ? refs : [context.inputRef],
    })
    await h.runtime.idle()
    return node(name).resultRef!
  }
  return { id, view, node, command, complete }
}

it('显式选择 HMM 模式，不探测仓库账户，不授予全权限，管理端报告实际模式', async () => {
  expect(machineOf(Config({ stateDir: '/srv/hmm' })).mode).toBe('repository')
  expect(machineOf(Config({ stateDir: '/srv/hmm', mode: 'hmm' })).mode).toBe('hmm')
  expect(() => Config({ stateDir: '/srv/hmm', mode: 'auto' } as never)).toThrow()
  expect(h.runtime.configured()).toBe(false)
  expect(h.runtime.setupProblem).toBeUndefined()
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
  expect(h.permissions.set).not.toHaveBeenCalled()
  expect((h.agents.get(h.runtime.masterId) as unknown as Agent).session.header.agentPreset).toBe(HMM_CONTROLLER_PRESET)
  expect(h.masks.get(h.runtime.masterId)).toContainEqual({ allow: [] })
  expect(await h.api('GET', 'state')).toMatchObject({ status: 200, body: {
    setup: { machine: { mode: 'hmm' }, accounts: null },
  } })
  expect(() => h.runtime.receive(feishu('1', '不允许外部来源注入'))).toThrow('HMM 模式')
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('受限总管完成三阶段验收，并保留显式依赖及不同工单的隔离', async () => {
  const first = await task()
  const second = await task('other', '比较两个给定方案的约束')
  const master = h.runtime.masterId
  expect(await h.runTool(master, 'hmm_read', { ticket_id: first.id })).toMatchObject({ goal: '整理现有资料，说明结论及缺失依据' })
  expect(await h.runTool(master, 'orchestrator_read', { resource: `ticket/${first.id}` })).toBeDefined()
  const analyze = await first.complete('analyze', '任务仅分析已提供资料')
  await first.complete('execute', '归纳依据并保留不确定项')
  const evaluated = await first.complete('evaluate', '检查目标覆盖和依据范围')
  expect(h.relays(master)).toContainEqual(expect.objectContaining({ kind: 'hmm_review', ticket_id: first.id }))
  expect(first.view().awaitingValidation).toBe(true)
  await first.command({ action: 'validate', summary: '已按输入范围完成整理', evidenceRefs: [evaluated] })
  expect(h.runtime.store.tickets.get(first.id)?.ended?.outcome).toBe('completed')
  expect(first.node('analyze').resultRef).toBe(analyze)
  expect(second.view()).toMatchObject({ phase: 'active', awaitingValidation: false })
  expect(h.agents.has(`worker-${first.id}`)).toBe(false)
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
})

it('总管重核失效步骤，复用未受影响成果而不是整条链重跑', async () => {
  const run = await task('recheck')
  const analysis = await run.complete('analyze', '明确验收边界')
  await run.complete('execute', '第一版结果')
  await run.complete('evaluate', '第一版评价')
  await run.command({ action: 'recheck', nodeId: 'execute', reason: '执行结论遗漏已知约束' })
  expect(run.node('analyze')).toMatchObject({ resultRef: analysis, state: 'completed', attempt: 1 })
  await run.command({ action: 'dispatch' })
  await run.complete('execute', '修正遗漏')
  const result = await run.complete('evaluate', '重新检查约束')
  await run.command({ action: 'validate', summary: '修正后满足目标', evidenceRefs: [result] })
  expect(run.node('execute').attempt).toBe(2)
  expect(h.runtime.store.tickets.get(run.id)?.ended?.outcome).toBe('completed')
})

it('总管禁止外部动作、设置修改、未授权资源路径和模型传入的身份', async () => {
  const run = await task('permissions')
  for (const name of ['bash', 'pwsh', 'read', 'write', 'subagent', 'orchestrator_route', 'orchestrator_settings', 'plugin_install']) {
    expect(h.tools.get(h.runtime.masterId)?.has(name)).toBe(false)
    await expect(h.runTool(h.runtime.masterId, name, {})).rejects.toThrow('本地总管')
  }
  for (const resource of ['settings', 'prompts', 'ticket/../inputs', `ticket/${run.id}/../../settings`, 'ticket/absent']) {
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_read', { resource })).rejects.toThrow('本地 HMM')
  }
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${run.id}`, actor: 'admin' })).rejects.toThrow()
  await expect(h.runtime.sessions.ensure(`worker-${run.id}`, h.directory, 'worker', 'worker')).rejects.toThrow('不启动')
  await h.controller.create({ sessionId: `worker-${run.id}` })
  const worker = h.agents.get(`worker-${run.id}`)! as unknown as Agent
  await h.ctx.serial('agent/created', { agent: worker } as never)
  await expect(h.runTool(worker.id, 'bash', {})).rejects.toThrow('HMM 模式')
  const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
  expect(await agentEvents(worker.ctx, worker).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, next)).toEqual({ kind: 'reject' })
  expect(next).not.toHaveBeenCalled()
  await h.controller.create({ sessionId: 'manual-child' })
  const child = h.agents.get('manual-child')! as unknown as Agent
  Object.assign(child.session.header, { parentSession: h.runtime.masterId })
  await h.ctx.serial('agent/created', { agent: child } as never)
  await expect(h.runTool(child.id, 'subagent', {})).rejects.toThrow('HMM 模式')
})

it('暂停阻止新任务和新节点，挂起通知仍送达，恢复后由总管继续', async () => {
  const run = await task('pause')
  expect(await h.api('POST', 'executor/pause', { paused: true })).toMatchObject({ status: 200 })
  expect(await h.api('POST', 'tasks', { requestId: 'blocked', goal: '暂停期间不启动' })).toMatchObject({ status: 409 })
  await run.complete('analyze', '记录已完成的分析')
  expect(run.node('execute').state).toBe('pending')
  await h.api('POST', 'executor/pause', { paused: false })
  await h.runtime.idle()
  await h.runTool(run.node('execute').sessionId!, 'hmm_node_report', { action: 'suspend', reason: '缺少用户资料' })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_attention', ticket_id: run.id }))
  await run.command({ action: 'hold' })
  await run.command({ action: 'resume', nodeId: 'execute' })
  expect(run.node('execute').state).toBe('pending')
  await run.command({ action: 'dispatch' })
  expect(run.node('execute').state).toBe('running')
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(run.id)?.ended?.outcome).toBe('stopped')
})

it('HMM 总管短暂不可用时保留通知，定时循环能够重试', async () => {
  vi.useFakeTimers()
  try {
    await h.restart()
    const run = await task('retry')
    await run.complete('analyze', '分析')
    await run.complete('execute', '执行')
    h.controller.resolveAgent.mockImplementation(async id => id === h.runtime.masterId
      ? { error: { code: 'temporarily-unavailable' } } : h.resolveDefault(id))
    await run.complete('evaluate', '评价')
    expect(h.runtime.effects.pending('relay')).toBe(true)
    h.controller.resolveAgent.mockImplementation(h.resolveDefault)
    await vi.advanceTimersByTimeAsync(6000)
    await h.runtime.idle()
    expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_review', ticket_id: run.id }))
    expect(h.runtime.effects.pending('relay')).toBe(false)
  } finally { await h.runtime.stop(); vi.useRealTimers() }
})

it('重启恢复持久任务并更换失效执行凭据，总管仍能验收', async () => {
  const run = await task('restart')
  const before = run.node('analyze').sessionId!
  await h.restart()
  await h.runtime.idle()
  expect(run.node('analyze').state).toBe('suspended')
  await run.command({ action: 'resume', nodeId: 'analyze' })
  await run.command({ action: 'dispatch' })
  expect(run.node('analyze').sessionId).not.toBe(before)
  await run.complete('analyze', '恢复后的分析')
  await run.complete('execute', '恢复后的执行')
  const result = await run.complete('evaluate', '恢复后的评价')
  await run.command({ action: 'validate', summary: '恢复后完成', evidenceRefs: [result] })
  expect(h.runtime.store.tickets.get(run.id)?.ended?.outcome).toBe('completed')
  expect(h.runtime.store.get(KV.runtime.mode)).toBe('hmm')
  expect(h.permissions.set).not.toHaveBeenCalled()
})

it('状态目录禁止跨部署模式复用，拒绝后仍能以原模式打开', async () => {
  const run = await task('mode')
  await expect(h.restart('repository')).rejects.toThrow('状态目录不匹配')
  await h.restart('hmm')
  expect(h.runtime.store.tickets.get(run.id)?.mandate.scope).toBe('整理现有资料，说明结论及缺失依据')
})

it('已有来源配置也不能在 HMM 模式激活仓库，普通并发设置无需重启', async () => {
  await h.stop()
  h = await startRuntime(undefined, { mode: 'hmm' })
  expect(h.runtime.store.settings().sources.github?.enabled).toBe(true)
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
  expect(h.runtime.settings.syncable()).toEqual([])
  const value = { ...h.runtime.store.settings().executor, maxWorkers: 2 }
  const result = await h.runtime.settings.save('executor', value, h.runtime.store.blockRevision('executor'), 'panel')
  expect(result).toMatchObject({ saved: true, restarting: false })
  const run = await task('settings')
  expect(run.node('analyze').state).toBe('running')
  expect(h.subprocess.spawn).not.toHaveBeenCalled()
})

it('旧版未标记模式的目录按仓库目录保护，不能用于独立 HMM', async () => {
  await h.stop()
  h = await startRuntime()
  h.runtime.store.delete(KV.runtime.mode)
  await expect(h.restart('hmm')).rejects.toThrow('状态目录不匹配')
  await h.restart('repository')
  expect(h.runtime.store.get(KV.runtime.mode)).toBe('repository')
  expect(h.runtime.configured()).toBe(true)
})
