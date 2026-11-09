import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlanSchema, type PlanInput } from '../src/hmm/model.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { vi.restoreAllMocks(); await h.stop() })

function request(requestId = 'custom-plan') {
  return { requestId, goal: '按明确依赖核对两个独立来源，再合并结论',
    plan: { maxActive: 2, nodes: [
      { id: 'scope', title: '总体', mode: 'parallel' as const },
      { id: 'sequence', parentId: 'scope', title: '顺序核对', mode: 'serial' as const },
      { id: 'first', parentId: 'sequence', title: '核对第一部分', instruction: '核对题设第一部分' },
      { id: 'second', parentId: 'sequence', title: '复核第一部分', instruction: '检查已完成核对的缺口', dependsOn: ['first'] },
      { id: 'independent', parentId: 'scope', title: '核对第二部分', instruction: '独立核对题设第二部分' },
      { id: 'combine', parentId: 'scope', title: '合并', instruction: '只合并已完成且有依据的结果',
        dependsOn: ['sequence', 'independent'] },
    ] } }
}
async function create(input = request()) {
  const response = await h.api('POST', 'tasks', input)
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  return { id, view: () => h.runtime.hmm.view(controller, id) }
}
async function complete(ticketId: string, nodeId: string) {
  const view = h.runtime.hmm.view(controller, ticketId)
  const node = view.nodes.find(item => item.id === nodeId)!
  const context = h.runtime.hmm.context(controller, ticketId, nodeId)
  await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: `核对完成：${nodeId}`,
    evidenceRefs: context.sourceResults.length ? context.sourceResults.map(result => result.ref) : [context.inputRef] })
  await h.runtime.idle()
}

it('首次提交直接运行嵌套计划，串行顺序、并行槽、上下文隔离及最终验收复用既有规则', async () => {
  const input = request()
  const run = await create(input)
  expect(run.view()).toMatchObject({ initialMode: 'custom', autoRun: true, planVersion: 1 })
  expect(run.view().nodes.map(node => node.id)).toEqual(input.plan.nodes.map(node => node.id))
  expect(run.view().nodes.filter(node => node.mode === 'task' && node.state === 'running').map(node => node.id)).toEqual(['first', 'independent'])
  expect(h.runtime.hmm.context(controller, run.id, 'independent').dependencies).toEqual([])
  await complete(run.id, 'first')
  expect(run.view().nodes.find(node => node.id === 'second')?.state).toBe('running')
  expect(run.view().nodes.find(node => node.id === 'combine')?.state).toBe('pending')
  await complete(run.id, 'second')
  expect(run.view().nodes.find(node => node.id === 'combine')?.state).toBe('pending')
  await complete(run.id, 'independent')
  const context = h.runtime.hmm.context(controller, run.id, 'combine')
  expect(context.sourceResults.map(result => result.nodeId).sort()).toEqual(['first', 'independent', 'second'])
  await complete(run.id, 'combine')
  expect(run.view().awaitingValidation).toBe(true)
  expect(h.runtime.store.tickets.get(run.id)?.ended).toBeUndefined()
  const ref = run.view().nodes.find(node => node.id === 'combine')!.resultRef!
  await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: run.id, revision: run.view().revision,
    command: { action: 'validate', summary: '已核对所有依赖结果', evidenceRefs: [ref] } })
  expect(h.runtime.store.tickets.get(run.id)?.ended?.outcome).toBe('completed')
  expect(h.controller.create.mock.calls.filter(([options]) => options.sessionId.startsWith('hmm-'))).toHaveLength(4)
})

it('语义规范化后的同一计划可重试，不生成额外节点或派发，改变计划则冲突', async () => {
  const input = request('custom-retry')
  input.plan.maxActive = 8
  const run = await create(input)
  const { goal: _, ...normalized } = PlanSchema.parse({ goal: input.goal, ...input.plan })
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  const sessions = h.controller.create.mock.calls.length
  expect(await h.api('POST', 'tasks', { ...input, plan: normalized }))
    .toMatchObject({ status: 200, body: { created: false, ticketId: run.id } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  expect(h.controller.create.mock.calls).toHaveLength(sessions)
  for (const plan of [
    { ...input.plan, maxActive: 1 },
    { ...input.plan, nodes: input.plan.nodes.map(node => node.id === 'independent' ? { ...node, instruction: '另一项核对' } : node) },
    { ...input.plan, nodes: [...input.plan.nodes].reverse() },
  ]) expect(await h.api('POST', 'tasks', { ...input, plan }))
    .toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  expect(await h.api('POST', 'tasks', { requestId: input.requestId, goal: input.goal, mode: 'multi' }))
    .toMatchObject({ status: 409, body: { code: 'request_conflict' } })
})

it('修订和重启后仍按首次计划识别重试，不覆盖现有状态或把修订后的计划当成原请求', async () => {
  const input = request('custom-revised')
  const run = await create(input)
  const definition = h.runtime.hmm.definition(controller, run.id)
  const plan: PlanInput = { ...definition.plan, nodes: definition.plan.nodes.map(node =>
    node.id === 'independent' ? { ...node, instruction: '按补充条件重新核对' } : node) }
  h.runtime.hmm.revise(controller, run.id, { revision: definition.revision, plan, reason: '补充条件改变核对内容' })
  await h.runtime.idle()
  await h.restart()
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 200, body: { created: false } })
  const { goal: _, ...changed } = plan
  expect(await h.api('POST', 'tasks', { ...input, plan: changed }))
    .toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
})

it('已结束的自定义任务可重试读取，但不会重新启动或改变首次路径', async () => {
  const input = request('custom-stopped')
  const run = await create(input)
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  expect(await h.api('POST', 'tasks', input))
    .toMatchObject({ status: 200, body: { created: false, ended: { outcome: 'stopped' } } })
  const status = await h.api('GET', `tasks/${run.id}`)
  expect(status.body.workflow).toMatchObject({ initialMode: 'custom', autoRun: false })
})

it.each([
  ['显式依赖环', (plan: ReturnType<typeof request>['plan']) => ({
    ...plan, nodes: plan.nodes.map(node => node.id === 'first' ? { ...node, dependsOn: ['second'] } : node),
  })],
  ['未授予的知识权限', (plan: ReturnType<typeof request>['plan']) => ({
    ...plan, deviceGrants: [{ id: 'forged', nodeId: 'first' }],
  })],
  ['未知节点字段', (plan: ReturnType<typeof request>['plan']) => ({
    ...plan, nodes: plan.nodes.map(node => node.id === 'first' ? { ...node, tools: ['shell'] } : node),
  })],
] as const)('%s在任何节点启动前被拒绝，工单、计划和队列共同回滚', async (_name, change) => {
  const input = request('invalid-custom')
  expect(await h.api('POST', 'tasks', { ...input, plan: change(input.plan) })).toMatchObject({ status: 400 })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.open()).toHaveLength(0)
  expect(h.runtime.store.keys(KV.hmm.workflow)).toHaveLength(0)
  expect(h.controller.create.mock.calls.filter(([options]) => options.sessionId.startsWith('hmm-'))).toHaveLength(0)
})

it('自定义计划不能混用默认模式，越过全局暂停或吞掉派发失败', async () => {
  const input = request('custom-atomic')
  expect(await h.api('POST', 'tasks', { ...input, mode: 'single' })).toMatchObject({ status: 400 })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 409, body: { code: 'paused' } })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
  const dispatch = vi.spyOn(h.runtime.hmm, 'apply').mockImplementationOnce(() => { throw new Error('派发模拟失败') })
  expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 500 })
  dispatch.mockRestore()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.open()).toHaveLength(0)
  expect(h.runtime.store.keys(KV.hmm.workflow)).toHaveLength(0)
})

it('计划声明的并发不能突破宿主共享执行槽，状态超预算时整笔创建回滚', async () => {
  const nodes = [
    { id: 'branch', title: '并行核对', mode: 'parallel' as const },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `part_${index}`, parentId: 'branch', title: `独立项${index}`, instruction: '只核对本项已提供的数据',
    })),
  ]
  const created = await h.api('POST', 'tasks', { requestId: 'custom-budget', goal: '分别核对独立数据',
    plan: { maxActive: 8, nodes } })
  expect(created.status).toBe(200)
  await h.runtime.idle()
  const workflow = h.runtime.hmm.view(controller, created.body.ticketId as string)
  expect(workflow.nodes.filter(node => node.mode === 'task' && node.state === 'running'))
    .toHaveLength(h.runtime.store.settings().executor.maxWorkers)
  const oversizedInput = { requestId: 'custom-oversized', goal: '预算过大的计划不得占用资源',
    plan: { nodes: [nodes[0], ...Array.from({ length: 63 }, (_, index) => ({
      id: `large_${index}`, parentId: 'branch', title: '有界检查', instruction: '约'.repeat(4000),
    }))] } }
  expect(await h.api('POST', 'tasks', oversizedInput))
    .toMatchObject({ status: 400, body: { error: expect.stringContaining('Request exceeds') } })
  expect(() => h.runtime.tasks.create(oversizedInput)).toThrow(expect.objectContaining({ code: 'state_too_large' }))
  expect(h.runtime.store.tickets.open()).toHaveLength(1)
})
