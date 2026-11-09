import { afterEach, beforeEach, expect, it } from 'vitest'
import type { HmmCommand, PlanInput } from '../src/hmm/model.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function start(mode: 'single' | 'multi') {
  const response = await h.api('POST', 'tasks', { requestId: `mode-${mode}`, goal: '按现有资料给出可核验的结果', mode })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const command = async (command: HmmCommand) => {
    await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: id, revision: view().revision, command })
    await h.runtime.idle()
  }
  const complete = async (nodeId: string) => {
    const node = view().nodes.find(item => item.id === nodeId)!
    const context = h.runtime.hmm.context(controller, id, nodeId)
    await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: `完成 ${nodeId}`,
      evidenceRefs: context.sourceResults.length ? context.sourceResults.map(item => item.ref) : [context.inputRef] })
    await h.runtime.idle()
    return view().nodes.find(item => item.id === nodeId)!.resultRef!
  }
  return { id, view, command, complete }
}

it.each([
  ['single', ['root', 'solve']],
  ['multi', ['root', 'analyze', 'execute', 'evaluate']],
] as const)('显式 %s 模式只改变默认计划形状，不改变验收边界', async (mode, expectedIds) => {
  const run = await start(mode)
  expect(run.view().nodes.map(node => node.id)).toEqual(expectedIds)
  const taskIds = run.view().nodes.filter(node => node.mode === 'task').map(node => node.id)
  let result = ''
  for (const nodeId of taskIds) result = await run.complete(nodeId)
  expect(h.nodeFactory).toHaveBeenCalledTimes(taskIds.length)
  expect(h.runtime.store.tickets.get(run.id)?.ended).toBeUndefined()
  expect(run.view().initialMode).toBe(mode)
  await run.command({ action: 'validate', summary: '结果满足任务目标', evidenceRefs: [result] })
  expect(h.runtime.store.tickets.get(run.id)?.ended?.outcome).toBe('completed')
})

it('默认仍使用多步模式，单步任务不会被隐藏的关键词规则误判', async () => {
  const response = await h.api('POST', 'tasks', { requestId: 'mode-default', goal: '直接给出一个答案' })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  expect(h.runtime.hmm.view(controller, id).nodes.map(node => node.id))
    .toEqual(['root', 'analyze', 'execute', 'evaluate'])
})

it('计划工具支持显式单步模式，但不能把 mode 混入自定义 plan', async () => {
  await h.stop()
  h = await startRuntime()
  const ticket = h.runtime.engine.createLocalTask({ requestId: 'mode-tool', title: '模式工具边界', goal: '建立一个待处理工单' })
  const plan: PlanInput = { goal: '目标', maxActive: 1, nodes: [
    { id: 'root', title: '主线', mode: 'serial' },
    { id: 'check', parentId: 'root', title: '处理', instruction: '依据既有输入完成处理并给出依据' },
  ] }
  await expect(h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, plan, mode: 'single' }))
    .rejects.toThrow('plan 不能同时提供 mode')
  expect(h.runtime.store.get(KV.hmm.workflow(ticket.id))).toBeUndefined()
  await h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, plan })
  expect(h.runtime.hmm.view(controller, ticket.id).nodes.map(node => node.id)).toEqual(['root', 'check'])
  const goalTicket = h.runtime.engine.createLocalTask({ requestId: 'mode-tool-goal', title: '单步工具入口', goal: '直接处理目标' })
  await h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: goalTicket.id, goal: '直接处理目标', mode: 'single' })
  await h.runtime.idle()
  expect(h.runtime.hmm.view(controller, goalTicket.id)).toMatchObject({ initialMode: 'single', autoRun: true })
  expect(h.runtime.hmm.view(controller, goalTicket.id).nodes.filter(node => node.mode === 'task')).toHaveLength(1)
})

it('单步可扩展为多步，保留有效结果，重启重试仍按首次路径判定', async () => {
  const run = await start('single'), result = await run.complete('solve')
  const current = h.runtime.hmm.definition(controller, run.id)
  const request = { ticket_id: run.id, revision: current.revision, reason: '需要增加独立约束核查',
    nodes: [...current.plan.nodes, { id: 'verify', parentId: 'root', title: '约束核查', mode: 'task' as const,
      instruction: '核查已有结果是否满足输入中的约束，说明未验证之处', dependsOn: ['solve'] }] }
  await h.runTool(h.runtime.masterId, 'hmm_plan_revise', request)
  await h.runTool(h.runtime.masterId, 'hmm_plan_revise', { ...request, preview: false })
  expect(run.view().nodes.find(node => node.id === 'solve')).toMatchObject({ resultRef: result, state: 'completed', attempt: 1 })
  expect(run.view().initialMode).toBe('single')
  await h.restart()
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  const base = { requestId: 'mode-single', goal: '按现有资料给出可核验的结果' }
  expect(await h.api('POST', 'tasks', { ...base, mode: 'single' })).toMatchObject({ status: 200, body: { created: false } })
  expect(await h.api('POST', 'tasks', { ...base, mode: 'multi' })).toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  await run.command({ action: 'dispatch' })
  const verified = await run.complete('verify')
  await run.command({ action: 'validate', summary: '扩展后通过核查', evidenceRefs: [verified] })
  expect(h.runtime.store.tickets.get(run.id)?.ended?.outcome).toBe('completed')
})

it('省略模式与显式多步可重试，旧快照按历史默认解释，非法模式不写入任务', async () => {
  const base = { requestId: 'mode-legacy', goal: '保留默认多步语义' }
  const created = await h.api('POST', 'tasks', base)
  expect(created.status).toBe(200)
  await h.runtime.idle()
  const id = created.body.ticketId as string
  expect(await h.api('POST', 'tasks', { ...base, mode: 'multi' })).toMatchObject({ status: 200, body: { created: false } })
  const workflow = h.runtime.store.get(KV.hmm.workflow(id))!
  delete workflow.initialMode
  h.runtime.store.set(KV.hmm.workflow(id), workflow)
  expect(await h.api('POST', 'tasks', base)).toMatchObject({ status: 200, body: { created: false } })
  expect(await h.api('POST', 'tasks', { ...base, mode: 'single' })).toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  for (const mode of ['auto', '', null, 1]) {
    expect(await h.api('POST', 'tasks', { requestId: 'mode-invalid', goal: '无效模式不得建任务', mode }))
      .toMatchObject({ status: 400 })
  }
  expect(h.runtime.store.tickets.open()).toHaveLength(1)
})
