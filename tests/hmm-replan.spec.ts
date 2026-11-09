import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { KV } from '../src/kv.ts'
import type { HmmCommand, PlanInput } from '../src/hmm/model.ts'
import type { HmmWorkflows } from '../src/hmm/workflow.ts'
import { hmmTools } from '../src/app/tools/hmm.ts'
import { hmmControllerTools, HMM_CONTROLLER_PROMPT } from '../src/app/tools/hmm-controller.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function prepare(plan?: PlanInput) {
  const response = await h.api('POST', 'tasks', { requestId: 'replan', goal: plan?.goal ?? '比较可行路径及各自限制' })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const node = (name: string) => view().nodes.find(item => item.id === name)!
  const snapshot = () => h.runtime.store.get(KV.hmm.workflow(id))
  const command = async (command: HmmCommand) => {
    const result = await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: id, revision: view().revision, command })
    await h.runtime.idle()
    return result
  }
  const definition = () => h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: id, view: 'plan' }) as Promise<ReturnType<HmmWorkflows['definition']>>
  const complete = async (name: string) => {
    const context = h.runtime.hmm.context(controller, id, name)
    await h.runTool(node(name).sessionId!, 'hmm_node_report', { action: 'complete', summary: `完成 ${name} 的限定任务`,
      evidenceRefs: context.sourceResults.length ? context.sourceResults.map(item => item.ref) : [context.inputRef] })
    await h.runtime.idle()
    return node(name).resultRef!
  }
  await h.runtime.idle()
  if (plan) {
    await command({ action: 'hold' })
    expect(await h.api('POST', `tickets/${id}/hmm/revisions`, { revision: view().revision, plan, reason: '操作者提供初始结构' }))
      .toMatchObject({ status: 200 })
    await h.runtime.idle()
    await command({ action: 'dispatch' })
  }
  return { id, view, node, snapshot, command, definition, complete }
}

it.each([['serial', 'research'], ['parallel', 'schedule']] as const)('%s 计划可展开嵌套分支，保留独立成果并重新验收', async (mode, prefix) => {
  const root = `${prefix}-root`, first = `${prefix}-input`, stable = `${prefix}-baseline`, work = `${prefix}-work`, final = `${prefix}-review`
  const run = await prepare({ goal: `核验 ${prefix} 的方案`, maxActive: 2, nodes: [
    { id: root, title: '主线', mode },
    { id: first, parentId: root, title: '输入', instruction: '梳理目标要求' },
    { id: stable, parentId: root, title: '独立分析', instruction: '说明已知边界' },
    { id: work, parentId: root, title: '执行', instruction: '完成比较', dependsOn: [first] },
    { id: final, parentId: root, title: '评价', instruction: '评估成果', dependsOn: [work, stable] },
  ] })
  const sourceRef = await run.complete(first)
  const stableRef = await run.complete(stable)
  const staleReport = h.tools.get(run.node(work).sessionId!)!.get('hmm_node_report')!
  const current = await run.definition()
  const group = `${prefix}-options`, left = `${prefix}-cost`, right = `${prefix}-limit`
  const nodes = current.plan.nodes.flatMap<PlanInput['nodes'][number]>(node => {
    if (node.id === work) return [
      { id: group, parentId: root, title: '两条独立路径', mode: 'parallel', dependsOn: [first] },
      { id: left, parentId: group, title: '路径甲', instruction: '按目标比较成本' },
      { id: right, parentId: group, title: '路径乙', instruction: '按目标比较限制' },
    ]
    return [{ ...node, ...(node.id === final ? { dependsOn: [group, stable] } : {}) }]
  })
  const request = { ticket_id: run.id, revision: current.revision, nodes, reason: '原执行步骤包含两项独立问题' }
  const before = run.snapshot(), launches = h.nodeFactory.mock.calls.length
  expect(await h.runTool(h.runtime.masterId, 'hmm_plan_revise', request)).toMatchObject({
    applied: false, revision: current.revision, added: [group, left, right], removed: [work],
  })
  expect(run.snapshot()).toEqual(before)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  expect(await h.runTool(h.runtime.masterId, 'hmm_plan_revise', { ...request, preview: false })).toMatchObject({ applied: true })
  await h.runtime.idle()
  expect(run.view()).toMatchObject({ autoRun: false, goal: current.plan.goal, maxActive: current.plan.maxActive })
  expect(run.node(first).resultRef).toBe(sourceRef)
  expect(run.node(stable).resultRef).toBe(stableRef)
  await expect(staleReport.execute({ action: 'complete', summary: '迟到结果', evidenceRefs: [sourceRef] },
    { signal: new AbortController().signal })).rejects.toThrow()
  if (mode === 'parallel') {
    await h.restart()
    expect((await run.definition()).plan.nodes.map(node => node.id)).toEqual(nodes.map(node => node.id))
  }
  await run.command({ action: 'dispatch' })
  const child = h.runtime.hmm.context(controller, run.id, left)
  expect(child.dependencies.map(item => item.nodeId)).toEqual([first])
  expect(child.sourceResults.some(item => item.ref === stableRef)).toBe(false)
  await run.complete(left)
  await run.complete(right)
  const result = await run.complete(final)
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_review', ticket_id: run.id }))
  await run.command({ action: 'validate', summary: '按原目标完成比较', evidenceRefs: [result] })
  expect(h.runtime.store.tickets.get(run.id)?.ended?.outcome).toBe('completed')
})

it('预览后执行状态改变时拒绝陈旧应用，不把旧预览当作授权', async () => {
  const run = await prepare()
  const current = await run.definition()
  const nodes = current.plan.nodes.map(node => node.id === 'execute' ? { ...node, instruction: '分别检查收益和代价' } : node)
  const request = { ticket_id: run.id, revision: current.revision, nodes, reason: '明确执行步骤' }
  await h.runTool(h.runtime.masterId, 'hmm_plan_revise', request)
  await h.runTool(run.node('analyze').sessionId!, 'hmm_node_report', { action: 'checkpoint', frame: '新增分析进度' })
  const before = run.snapshot()
  await expect(h.runTool(h.runtime.masterId, 'hmm_plan_revise', { ...request, preview: false }))
    .rejects.toMatchObject({ code: 'revision_conflict' })
  expect(run.snapshot()).toEqual(before)
})

it('修订输入不能扩大目标、并发、身份或设备授权', async () => {
  const run = await prepare(), current = await run.definition(), before = run.snapshot()
  const base = { ticket_id: run.id, revision: current.revision, nodes: current.plan.nodes, reason: '调整步骤', preview: false }
  for (const extra of [{ goal: '另一个目标' }, { maxActive: 8 }, { actor: 'admin' }, { grants: ['all'] }]) {
    await expect(h.runTool(h.runtime.masterId, 'hmm_plan_revise', { ...base, ...extra })).rejects.toThrow()
    expect(run.snapshot()).toEqual(before)
  }
  const cyclic = current.plan.nodes.map(node => node.id === 'analyze' ? { ...node, dependsOn: ['evaluate'] } : node)
  await expect(h.runTool(h.runtime.masterId, 'hmm_plan_revise', { ...base, nodes: cyclic })).rejects.toMatchObject({ code: 'dependency_cycle' })
  expect(run.snapshot()).toEqual(before)
  expect(h.tools.get(h.runtime.masterId)?.has('hmm_plan_create')).toBe(false)
  expect(h.tools.get(run.node('analyze').sessionId!)?.has('hmm_plan_revise')).toBe(false)
})

it.each(['evidenceRequired', 'claimsRequired'] as const)('模型不能通过省略或删除节点降低 %s', async requirement => {
  const run = await prepare({ goal: '必须核验的任务', nodes: [
    { id: 'project', title: '流程', mode: 'serial' },
    { id: 'required', parentId: 'project', title: '核验', instruction: '核验外部事实', [requirement]: true },
    { id: 'summary', parentId: 'project', title: '总结', instruction: '总结已核验结论', dependsOn: ['required'] },
  ] })
  const current = await run.definition(), before = run.snapshot()
  const base = { ticket_id: run.id, revision: current.revision, reason: '尝试省略核验', preview: false }
  const weakened = current.plan.nodes.map(node => ({ ...node, [requirement]: false }))
  const removed = current.plan.nodes.filter(node => node.id !== 'required').map(node => ({ ...node, dependsOn: [] }))
  for (const nodes of [weakened, removed]) {
    await expect(h.runTool(h.runtime.masterId, 'hmm_plan_revise', { ...base, nodes })).rejects.toMatchObject({ code: 'verification_required' })
    expect(run.snapshot()).toEqual(before)
  }
})

it('变化节点撤销已有设备授权，不能自动把旧授权转给新任务', async () => {
  const run = await prepare()
  await run.command({ action: 'hold' })
  const grant = { id: 'phone-files', nodeId: 'execute', deviceId: 'phone', domain: 'files' }
  expect(await h.api('POST', `tickets/${run.id}/hmm/device-grants`, { revision: run.view().revision, grant })).toMatchObject({ status: 200 })
  const current = await run.definition()
  const nodes = current.plan.nodes.map(node => node.id === 'execute' ? { ...node, instruction: '改为核查另一类依据' } : node)
  await h.runTool(h.runtime.masterId, 'hmm_plan_revise', {
    ticket_id: run.id, revision: current.revision, nodes, reason: '步骤内容改变', preview: false,
  })
  expect(run.view().deviceGrants).toContainEqual(expect.objectContaining({ id: grant.id, revoked: true }))
  expect(h.runtime.hmm.context(controller, run.id, 'execute').deviceGrants).toEqual([])
  expect(run.view().autoRun).toBe(false)
})

it('执行器仍不能获取全计划指令；总管定义查询拒绝无效过滤', async () => {
  const run = await prepare()
  const read = hmmTools(h.runtime, run.id).find(tool => tool.name === 'hmm_read')!
  await expect(read.execute({ view: 'plan' }, new AbortController().signal)).rejects.toThrow()
  for (const extra of [{ node_id: 'analyze' }, { offset: 0 }, { revision: run.view().revision }]) {
    await expect(h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: run.id, view: 'plan', ...extra }))
      .rejects.toMatchObject({ code: 'query_invalid' })
  }
})

it('不叠加第二份完整计划工具定义，并维持有界模型输入', () => {
  const definitions = hmmControllerTools({ hmm: h.runtime.hmm, hmmDevices: h.runtime.hmmDevices, store: h.runtime.store,
    readResource: async () => { throw new Error('工具定义检查不应读取资源') },
    readDevelopment: () => { throw new Error('工具定义检查不应读取开发声明') },
  }, h.runtime.tasks)
    .map(tool => ({ name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.schema) }))
  expect(definitions.filter(tool => tool.name.startsWith('hmm_plan_')).map(tool => tool.name)).toEqual(['hmm_plan_revise'])
  expect(JSON.stringify(definitions).length + HMM_CONTROLLER_PROMPT.length).toBeLessThanOrEqual(24_000)
})
