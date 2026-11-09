import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { HMM_LIMITS, type HmmCommand, type PlanInput } from '../src/hmm/model.ts'
import type { ApiResponse } from '../src/app/api.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task() {
  const response = await h.api('POST', 'tasks', { requestId: 'status', goal: '比较现有方案及其限制' })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const ticket = () => h.runtime.store.tickets.get(id)!
  const read = async () => {
    const response = await h.api('GET', `tasks/${id}`)
    expect(response.status).toBe(200)
    const directory = await h.api('GET', 'tasks?state=all')
    expect(directory.status).toBe(200)
    const page = directory.body as ApiResponse<'GET tasks'>
    expect(page.items.find(item => item.ticketId === id)?.activity).toBe(response.body.activity)
    return response.body as ApiResponse<'GET tasks/:id'>
  }
  const command = async (command: HmmCommand) => {
    await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: id, revision: view().revision, command })
    await h.runtime.idle()
  }
  const complete = async (name: string) => {
    const node = view().nodes.find(item => item.id === name)!
    const context = h.runtime.hmm.context(controller, id, name)
    await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: `完成 ${name} 的限定任务`,
      evidenceRefs: context.sourceResults.length ? context.sourceResults.map(item => item.ref) : [context.inputRef] })
    await h.runtime.idle()
    return view().nodes.find(item => item.id === name)!.resultRef!
  }
  return { id, view, ticket, read, command, complete }
}

it('查询聚合真实任务节点并保持只读，输入送达数量不充当已采纳凭据', async () => {
  const run = await task()
  await run.complete('analyze')
  await h.api('POST', `tasks/${run.id}/inputs`, { requestId: 'additional', text: '尚待总管判断是否采纳的条件' })
  await h.runtime.idle()
  const ticket = run.ticket(), before = h.runtime.store.get(KV.hmm.workflow(run.id))
  const status = await run.read()
  expect(status).toMatchObject({ ticketId: run.id, title: ticket.title, paused: false, ended: null, result: null, activity: 'running',
    inputs: { total: ticket.inputs.length, pendingDelivery: ticket.undelivered.length },
    workflow: { revision: run.view().revision, planVersion: run.view().planVersion, phase: 'active', autoRun: true,
      awaitingValidation: false, progress: { total: 3, pending: 1, running: 1, completed: 1, suspended: 0, pruned: 0 } } })
  expect(status.workflow.runningSteps).toEqual({ total: 1, omitted: 0, items: [{ nodeId: 'execute', title: '执行' }] })
  expect(status.workflow).not.toHaveProperty('dispatchBlocker')
  expect(await run.read()).toEqual(status)
  expect(run.ticket()).toEqual(ticket)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
})

it.each(['dispatch', 'hold'] as const)('%s控制回执附带同一提交版本的本地状态，不携带目标正文、工作帧或整棵计划', async action => {
  const created = await h.api('POST', 'tasks', { requestId: 'control-receipt', title: 'Review authorized sources',
    goal: 'PRIVATE_GOAL_BODY', dispatch: false, plan: { nodes: [
      { id: 'root', title: 'Sources', mode: 'parallel' },
      { id: 'first', parentId: 'root', title: 'Read source', instruction: 'PRIVATE_FIRST_INSTRUCTION' },
      { id: 'other', parentId: 'root', title: 'Check another source', instruction: 'PRIVATE_OTHER_INSTRUCTION' },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string, hmm = h.runtime.hmm, view = () => hmm.view(controller, id)
  const started = hmm.apply(controller, id, view().revision, { action: 'start', nodeId: 'first' })
  hmm.apply(controller, id, view().revision, { action: 'complete', nodeId: 'first', lease: started.lease!,
    summary: 'PRIVATE_FIRST_RESULT', evidenceRefs: [hmm.context(controller, id, 'first').inputRef!] })
  if (action === 'hold') {
    hmm.apply(controller, id, view().revision, { action: 'dispatch' })
    await h.runtime.idle()
    expect(view().nodes.find(node => node.id === 'other')!.state).toBe('running')
  }
  const before = h.runtime.store.get(KV.hmm.workflow(id))!, revision = view().revision
  const status = vi.spyOn(h.runtime.tasks, 'status')
  try {
    const response = await h.api('POST', `tickets/${id}/hmm/commands`, { revision, command: { action } })
    expect(response.status).toBe(200)
    const receipt = response.body as ApiResponse<'POST tickets/:id/hmm/commands'>
    expect(receipt).toMatchObject({ ticketId: id, revision: revision + 1, phase: 'active',
      task: { ticketId: id, ended: null, workflow: {
        revision: revision + 1, planVersion: before.planVersion, phase: 'active', autoRun: action === 'dispatch',
        progress: { completed: 1, running: 0 },
      } } })
    expect(status).toHaveBeenCalledExactlyOnceWith(id)
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_|"nodes"|"frame"|"sessionId"|"deviceGrants"/)
    expect(h.runtime.store.get(KV.hmm.workflow(id))!.nodes.find(node => node.id === 'first')!.result)
      .toEqual(before.nodes.find(node => node.id === 'first')!.result)
    if (action === 'hold') {
      expect(receipt.task!.workflow.progress.suspended).toBe(1)
      expect(receipt.task!.workflow.blockers.items.map(item => item.nodeId)).toEqual(['other'])
    } else expect(receipt.task!.workflow.progress.pending).toBe(1)
  } finally { status.mockRestore() }
})

it('暂停回执的可选显示投影失败仍提交暂停，原版本重试被拒绝且节点不再继续执行', async () => {
  const run = await task(), before = run.view()
  expect(before.nodes.some(node => node.state === 'running')).toBe(true)
  const status = vi.spyOn(h.runtime.tasks, 'status').mockImplementation(() => { throw new Error('Projection unavailable') })
  try {
    const response = await h.api('POST', `tickets/${run.id}/hmm/commands`, {
      revision: before.revision, command: { action: 'hold' },
    })
    expect(response).toMatchObject({ status: 200, body: { ticketId: run.id, revision: before.revision + 1 } })
    expect(response.body).not.toHaveProperty('task')
    await h.runtime.idle()
    expect(run.view().autoRun).toBe(false)
    expect(run.view().nodes.some(node => node.state === 'running')).toBe(false)
    expect(await h.api('POST', `tickets/${run.id}/hmm/commands`, {
      revision: before.revision, command: { action: 'hold' },
    })).toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
    expect(status).toHaveBeenCalledOnce()
  } finally { status.mockRestore() }
  expect((await run.read()).workflow.autoRun).toBe(false)
})

it.each(['foreign', 'other_command'] as const)('%s不附带本地任务状态，原命令接口仍返回领域短回执', async scope => {
  const created = await h.api('POST', 'tasks', { requestId: 'control-scope', goal: 'Review permitted sources', dispatch: false })
  const id = created.body.ticketId as string, ticket = h.runtime.store.tickets.get(id)!
  if (scope === 'foreign') h.runtime.store.tickets.save({ ...ticket,
    mandate: { ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' } } })
  const status = vi.spyOn(h.runtime.tasks, 'status')
  try {
    const view = h.runtime.hmm.view(controller, id)
    const response = await h.api('POST', `tickets/${id}/hmm/commands`, { revision: view.revision,
      command: scope === 'foreign' ? { action: 'hold' } : { action: 'suspend', nodeId: 'analyze', reason: 'Review scope' } })
    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('task')
    expect(status).not.toHaveBeenCalled()
  } finally { status.mockRestore() }
})

it.each(['complete', 'suspend', 'prune'] as const)('手动步骤%s前只读说明派发阻断，结束后重新判定且不自动派发', async action => {
  const response = await h.api('POST', 'tasks', { requestId: 'manual-dispatch', goal: '分别核对两份授权资料', dispatch: false,
    plan: { nodes: [
      { id: 'root', title: '核对资料', mode: 'parallel' },
      { id: 'manual', parentId: 'root', title: '先行核对', instruction: 'PRIVATE_MANUAL_INSTRUCTION' },
      { id: 'next', parentId: 'root', title: '后续核对', instruction: 'PRIVATE_NEXT_INSTRUCTION' },
    ] } })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string, view = () => h.runtime.hmm.view(controller, id)
  const command = (command: HmmCommand) => h.runtime.hmm.apply(controller, id, view().revision, command)
  const { lease } = command({ action: 'start', nodeId: 'manual' })
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(id)), ticket = h.runtime.store.tickets.get(id)
  const deliveries = h.deliveries.mock.calls.length
  const status = await h.api('GET', `tasks/${id}`)
  expect(status).toMatchObject({ status: 200, body: { activity: 'running',
    workflow: { autoRun: false, dispatchBlocker: 'manual_running', requiresOrchestrator: true,
      progress: { running: 1, pending: 1, suspended: 0 }, blockers: { total: 0 } } } })
  expect(JSON.stringify(status.body)).not.toMatch(/PRIVATE_|sessionId|lease|frame|history/)
  expect(await h.api('GET', `tasks/${id}`)).toEqual(status)
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
  expect(h.deliveries).toHaveBeenCalledTimes(deliveries)
  expect(await h.api('POST', `tickets/${id}/hmm/commands`, { revision: view().revision, command: { action: 'dispatch' } }))
    .toMatchObject({ status: 409, body: { code: 'manual_running' } })
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  if (action === 'complete') command({ action, nodeId: 'manual', lease: lease!, summary: '先行核对已结束',
    evidenceRefs: [h.runtime.hmm.context(controller, id, 'manual').inputRef!] })
  else if (action === 'suspend') command({ action, nodeId: 'manual', reason: '等待进一步核对' })
  else command({ action, nodeId: 'manual', reason: '当前无需重复核对', reconsiderWhen: '来源范围发生变化' })
  await h.runtime.idle()
  const cleared = (await h.api('GET', `tasks/${id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(cleared.workflow).not.toHaveProperty('dispatchBlocker')
  expect(cleared.workflow).toMatchObject({ requiresOrchestrator: false, autoRun: false, progress: { running: 0 } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(await h.api('POST', `tickets/${id}/hmm/commands`, { revision: view().revision, command: { action: 'dispatch' } }))
    .toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(view().nodes.find(node => node.id === 'next')).toMatchObject({ state: 'running', attempt: 1 })
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it.each([
  { same: true, custom: true, goal: '核对授权资料' },
  { same: false, custom: false, goal: '核对授权资料\n保留完整范围与限制：' + '\u{20000}'.repeat(980) },
  { same: false, custom: true, goal: '范围：' + '\u0000'.repeat(1995) },
])('目标与标题不同才提供展开标识，正文按需原样返回且常规响应不复制；相同=$same', async ({ same, custom, goal }) => {
  const response = await h.api('POST', 'tasks', {
    requestId: 'goal-read', ...(custom ? { title: same ? goal : '核对资料' } : {}), goal, mode: 'single', dispatch: false,
  })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const status = (await h.api('GET', `tasks/${id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(status.goalAvailable).toBe(!same)
  if (!same) {
    expect(JSON.stringify(status)).not.toContain(goal)
    expect(JSON.stringify((await h.api('GET', 'tasks')).body)).not.toContain(goal)
  }
  const workflow = h.runtime.store.get(KV.hmm.workflow(id)), ticket = h.runtime.store.tickets.get(id)
  const deliveries = h.deliveries.mock.calls.length, launches = h.nodeFactory.mock.calls.length
  const read = () => h.api('GET', `tasks/${id}/goal?planVersion=${status.workflow.planVersion}`)
  expect(await read()).toEqual({ status: 200, body: { ticketId: id, planVersion: status.workflow.planVersion, text: goal } })
  expect(Buffer.byteLength(JSON.stringify((await read()).body), 'utf8')).toBeLessThan(16 * 1024)
  expect(await read()).toEqual(await read())
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(workflow)
  expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
  expect(h.deliveries.mock.calls).toHaveLength(deliveries)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
})

it('执行进度、补充、暂停、停止和重启不把当前目标改为新输入，也不使原计划版本失效', async () => {
  const response = await h.api('POST', 'tasks', {
    requestId: 'goal-lifecycle', title: '资料范围', goal: '只核对来源 A，不执行外部操作', mode: 'single', dispatch: false,
  })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string, view = () => h.runtime.hmm.view(controller, id)
  const planVersion = view().planVersion, nodeId = view().nodes.find(node => node.mode === 'task')!.id
  const read = () => h.api('GET', `tasks/${id}/goal?planVersion=${planVersion}`)
  const initial = await read()
  expect(initial).toMatchObject({ status: 200, body: { text: '只核对来源 A，不执行外部操作' } })
  h.runtime.hmm.apply(controller, id, view().revision, { action: 'start', nodeId })
  expect(await read()).toEqual(initial)
  h.runtime.hmm.apply(controller, id, view().revision, { action: 'suspend', nodeId, reason: '等待核对条件' })
  expect(await h.api('POST', `tasks/${id}/inputs`, {
    requestId: 'not-adopted-goal', text: '改为来源 B，此补充仍须总管判断。',
  })).toMatchObject({ status: 200 })
  await h.api('POST', 'executor/pause', { paused: true })
  expect(await read()).toEqual(initial)
  await h.api('POST', `tasks/${id}/stop`)
  expect(await read()).toEqual(initial)
  await h.restart()
  expect(await read()).toEqual(initial)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each(['goal', 'instruction'] as const)('计划%s修订使旧目标访问失效，新版本返回当前定义而不改任务标题', async change => {
  const response = await h.api('POST', 'tasks', {
    requestId: 'goal-revision', title: '原标题', goal: '核对来源 A', mode: 'single', dispatch: false,
  })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string
  const definition = h.runtime.hmm.definition(controller, id)
  const plan = structuredClone(definition.plan)
  if (change === 'goal') plan.goal = '原标题'
  else plan.nodes.find(node => node.mode === 'task')!.instruction = '核对 A 的最新有效记录'
  expect(await h.api('POST', `tickets/${id}/hmm/revisions`, {
    revision: definition.revision, plan, reason: '核对当前定义边界',
  })).toMatchObject({ status: 200 })
  expect(await h.api('GET', `tasks/${id}/goal?planVersion=${definition.planVersion}`))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  const status = (await h.api('GET', `tasks/${id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(status).toMatchObject({ title: '原标题', goalAvailable: change !== 'goal' })
  expect(await h.api('GET', `tasks/${id}/goal?planVersion=${status.workflow.planVersion}`))
    .toEqual({ status: 200, body: { ticketId: id, planVersion: status.workflow.planVersion, text: plan.goal } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('计划调整摘要按当前计划版本返回原因和有界计数，不泄漏节点详情、指令或执行状态', async () => {
  const response = await h.api('POST', 'tasks', { requestId: 'plan-change-summary', title: '核对任务',
    goal: '核对来源 A', mode: 'single', dispatch: false })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string, before = h.runtime.hmm.definition(controller, id)
  const plan = structuredClone(before.plan)
  plan.nodes[1]!.title = '核对来源 B'
  plan.nodes.push({ id: 'review', parentId: plan.nodes[0]!.id, title: '复核结果', mode: 'task',
    instruction: 'PRIVATE_INSTRUCTION', evidenceRequired: false, claimsRequired: false, dependsOn: [] })
  expect(await h.api('POST', `tickets/${id}/hmm/revisions`, {
    revision: before.revision, plan, reason: '根据新来源重新组织核对步骤',
  })).toMatchObject({ status: 200 })
  const status = (await h.api('GET', `tasks/${id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(status.workflow.planChangeAvailable).toBe(true)
  const page = await h.api('GET', `tasks/${id}/plan-change?planVersion=${status.workflow.planVersion}`)
  expect(page).toMatchObject({ status: 200, body: { ticketId: id, planVersion: status.workflow.planVersion,
    reason: '根据新来源重新组织核对步骤', added: 1, removed: 0, changed: 2, affected: 2,
    affectedSteps: { items: ['核对来源 B', '复核结果'], omitted: 0 } } })
  expect(JSON.stringify(page.body)).not.toMatch(/PRIVATE_|instruction|sessionId|nodeId|revision/)
  expect(await h.api('GET', `tasks/${id}/plan-change?planVersion=${before.planVersion}`))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  const stored = h.runtime.store.get(KV.hmm.workflow(id)), ticket = h.runtime.store.tickets.get(id)
  expect(await h.api('GET', `tasks/${id}/plan-change?planVersion=${status.workflow.planVersion}`)).toEqual(page)
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(stored)
  expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
  const latest = h.runtime.hmm.definition(controller, id)
  const revised = structuredClone(latest.plan)
  revised.nodes = revised.nodes.filter(node => node.id !== before.plan.nodes[1]!.id)
  expect(await h.api('POST', `tickets/${id}/hmm/revisions`, {
    revision: latest.revision, plan: revised, reason: '移除不再适用的来源步骤',
  })).toMatchObject({ status: 200 })
  const current = h.runtime.hmm.view(controller, id)
  expect(await h.api('GET', `tasks/${id}/plan-change?planVersion=${latest.planVersion}`))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(await h.api('GET', `tasks/${id}/plan-change?planVersion=${current.planVersion}`))
    .toMatchObject({ status: 200, body: { planVersion: current.planVersion,
      reason: '移除不再适用的来源步骤', added: 0, removed: 1, changed: 1, affected: 1,
      affectedSteps: { items: ['复核结果'], omitted: 0 } } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('无计划修订或未知来源不提供调整摘要，修订摘要读取不启动执行', async () => {
  const response = await h.api('POST', 'tasks', { requestId: 'plan-change-empty', goal: '核对当前来源',
    dispatch: false })
  const id = response.body.ticketId as string, planVersion = h.runtime.hmm.view(controller, id).planVersion
  expect(await h.api('GET', `tasks/${id}/plan-change?planVersion=${planVersion}`))
    .toMatchObject({ status: 409, body: { code: 'plan_change_unavailable' } })
  expect(await h.api('GET', `tasks/absent/plan-change?planVersion=1`)).toMatchObject({ status: 404 })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

async function revisedTask(reason = '根据新增条件修订步骤') {
  const response = await h.api('POST', 'tasks', {
    requestId: 'revision-reading', goal: '核对限定资料', mode: 'single', dispatch: false,
  })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string, definition = h.runtime.hmm.definition(controller, id)
  definition.plan.nodes[1]!.instruction = 'PRIVATE_CHANGED_INSTRUCTION'
  expect(await h.api('POST', `tickets/${id}/hmm/revisions`, {
    revision: definition.revision, plan: definition.plan, reason,
  })).toMatchObject({ status: 200 })
  const view = () => h.runtime.hmm.view(controller, id)
  const planVersion = view().planVersion
  return { id, view, nodeId: definition.plan.nodes[1]!.id, title: definition.plan.nodes[1]!.title,
    read: () => h.api('GET', `tasks/${id}/plan-change?planVersion=${planVersion}`) }
}

it.each(['\u{20000}'.repeat(250), '\u0000'.repeat(500)])('修订原因保持完整且 JSON 响应有界，读取不写入或复制计划正文（%#）', async reason => {
  const run = await revisedTask(reason)
  await h.runtime.idle()
  const stored = h.runtime.store.get(KV.hmm.workflow(run.id)), ticket = h.runtime.store.tickets.get(run.id)
  const settings = h.runtime.store.settings(), deliveries = h.deliveries.mock.calls.length
  const page = await run.read()
  expect(page).toEqual({ status: 200, body: { ticketId: run.id, planVersion: run.view().planVersion,
    at: expect.any(String), reason, added: 0, removed: 0, changed: 1, affected: 1,
    affectedSteps: { items: [run.title], omitted: 0 } } })
  expect(Buffer.byteLength(JSON.stringify(page.body), 'utf8')).toBeLessThan(4096)
  expect(JSON.stringify(page.body)).not.toMatch(/PRIVATE_|beforeHash|afterHash|frame|sessionId|deviceGrants/)
  const status = (await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(status.workflow).toMatchObject({ planChangeAvailable: true })
  expect(status.workflow).not.toHaveProperty('lastPlanRevision')
  expect(status.workflow).not.toHaveProperty('reason')
  expect(await run.read()).toEqual(page)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stored)
  expect(h.runtime.store.tickets.get(run.id)).toEqual(ticket)
  expect(h.runtime.store.settings()).toEqual(settings)
  expect(h.deliveries.mock.calls).toHaveLength(deliveries)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each([
  { name: 'normal', count: HMM_LIMITS.nodes - 1, title: '限定来源核对', reason: '按新的限定范围核对' },
  { name: 'unicode', count: HMM_LIMITS.nodes - 1, title: '\u{20000}'.repeat(70), reason: '\u{20000}'.repeat(250) },
  // 修订原因会复制到受影响节点；极端组合仍须满足既有计划存储预算。
  { name: 'escaped', count: 9, title: '\u0000'.repeat(48), reason: '\u0000'.repeat(500) },
])('大量受影响步骤只列有界名称，完整原因及总数保持原样且不突破原预算；$name', async ({ name, count, title, reason }) => {
  const titles = Array.from({ length: count }, (_, index) => `T${index}: ${title}`.slice(0, 160))
  const response = await h.api('POST', 'tasks', { requestId: `impact-${name}`, goal: '核对原范围', dispatch: false,
    plan: { nodes: [
      { id: 'root', title: 'PRIVATE_GROUP', mode: 'parallel' },
      ...titles.map((title, index) => ({ id: `private_source_${index}`, parentId: 'root', title,
        instruction: 'PRIVATE_INSTRUCTION' })),
    ] } })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string, definition = h.runtime.hmm.definition(controller, id)
  definition.plan.goal = '核对修订后的限定范围'
  const revised = await h.api('POST', `tickets/${id}/hmm/revisions`, {
    revision: definition.revision, plan: definition.plan, reason,
  })
  expect(revised.status, JSON.stringify(revised.body)).toBe(200)
  await h.runtime.idle()
  const version = h.runtime.hmm.view(controller, id).planVersion
  const stored = h.runtime.store.get(KV.hmm.workflow(id)), ticket = h.runtime.store.tickets.get(id)
  const deliveries = h.deliveries.mock.calls.length
  const result = await h.api('GET', `tasks/${id}/plan-change?planVersion=${version}`)
  expect(result.status).toBe(200)
  const page = result.body as ApiResponse<'GET tasks/:id/plan-change'>
  expect(page.reason).toBe(reason)
  expect(page.affected).toBe(titles.length)
  expect(page.affectedSteps.items.length).toBeGreaterThan(0)
  expect(page.affectedSteps.items.length).toBeLessThanOrEqual(4)
  expect(page.affectedSteps.items.every((value, index) =>
    value.startsWith(`T${index}: `) && Array.from(value).length <= 48)).toBe(true)
  expect(page.affectedSteps.items.length + page.affectedSteps.omitted).toBe(titles.length)
  if (name === 'normal') expect(page.affectedSteps.items).toEqual(titles.slice(0, 4))
  if (name === 'unicode') expect(page.affectedSteps.items.every(value =>
    Array.from(value).at(-2) === '\u{20000}' && value.endsWith('…'))).toBe(true)
  if (name === 'escaped') expect(page.affectedSteps.items.length).toBeLessThan(4)
  const text = JSON.stringify(page)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(4096)
  expect(text).not.toMatch(/PRIVATE_|private_source_|sessionId|deviceGrants|instruction|beforeHash|afterHash/)
  expect(await h.api('GET', `tasks/${id}/plan-change?planVersion=${version}`)).toEqual(result)
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(stored)
  expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
  expect(h.deliveries.mock.calls).toHaveLength(deliveries)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('修订只列真实受影响任务的名称，排除分组及独立分支，不按当前状态推断历史影响', async () => {
  const response = await h.api('POST', 'tasks', { requestId: 'impact-dependencies', goal: '核对独立来源并汇总', dispatch: false,
    plan: { nodes: [
      { id: 'root', title: 'PRIVATE_GROUP', mode: 'parallel' },
      { id: 'source_a', parentId: 'root', title: '核对 A', instruction: '仅核对 A' },
      { id: 'source_b', parentId: 'root', title: 'PRIVATE_UNAFFECTED', instruction: '仅核对 B' },
      { id: 'review', parentId: 'root', title: '复核 A', instruction: '复核 A 的结果', dependsOn: ['source_a'] },
    ] } })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string, definition = h.runtime.hmm.definition(controller, id)
  definition.plan.nodes[1]!.instruction = '重新核对 A 的当前有效来源'
  expect(await h.api('POST', `tickets/${id}/hmm/revisions`, {
    revision: definition.revision, plan: definition.plan, reason: 'A 的来源范围需要更新',
  })).toMatchObject({ status: 200 })
  const version = h.runtime.hmm.view(controller, id).planVersion
  const read = () => h.api('GET', `tasks/${id}/plan-change?planVersion=${version}`)
  const first = await read()
  expect(first).toMatchObject({ status: 200, body: {
    affected: 2, affectedSteps: { items: ['核对 A', '复核 A'], omitted: 0 },
  } })
  const view = () => h.runtime.hmm.view(controller, id)
  const started = h.runtime.hmm.apply(controller, id, view().revision, { action: 'start', nodeId: 'source_a' })
  h.runtime.hmm.apply(controller, id, view().revision, {
    action: 'complete', nodeId: 'source_a', lease: started.lease!, summary: 'A 的核对已完成',
    evidenceRefs: [h.runtime.hmm.context(controller, id, 'source_a').inputRef!],
  })
  expect(view().nodes.find(node => node.id === 'source_a')!.state).toBe('completed')
  expect(await read()).toEqual(first)
  expect(JSON.stringify((await read()).body)).not.toContain('PRIVATE_')
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('没有受影响任务的修订仍可显示原因，名称列表和遗漏计数为空', async () => {
  const response = await h.api('POST', 'tasks', { requestId: 'impact-empty', goal: '核对当前资料', mode: 'single', dispatch: false })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string, definition = h.runtime.hmm.definition(controller, id)
  definition.plan.maxActive = definition.plan.maxActive === 1 ? 2 : 1
  expect(await h.api('POST', `tickets/${id}/hmm/revisions`, {
    revision: definition.revision, plan: definition.plan, reason: '仅调整并发额度，保留原步骤定义',
  })).toMatchObject({ status: 200 })
  const version = h.runtime.hmm.view(controller, id).planVersion
  expect(await h.api('GET', `tasks/${id}/plan-change?planVersion=${version}`)).toMatchObject({ status: 200, body: {
    reason: '仅调整并发额度，保留原步骤定义', added: 0, removed: 0, changed: 0, affected: 0,
    affectedSteps: { items: [], omitted: 0 },
  } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each(['progress', 'stopped', 'completed'] as const)('%s及重启保留既有修订记录，读取不恢复、重跑或扩大授权', async state => {
  const run = await revisedTask(), first = await run.read(), revision = run.view().revision
  const started = h.runtime.hmm.apply(controller, run.id, revision, { action: 'start', nodeId: run.nodeId })
  expect(await run.read()).toEqual(first)
  if (state === 'completed') {
    const inputRef = h.runtime.hmm.context(controller, run.id, run.nodeId).inputRef!
    h.runtime.hmm.apply(controller, run.id, run.view().revision, {
      action: 'complete', nodeId: run.nodeId, lease: started.lease!, summary: '限定核对完成', evidenceRefs: [inputRef],
    })
    const resultRef = run.view().nodes.find(node => node.id === run.nodeId)!.resultRef!
    h.runtime.hmm.apply(controller, run.id, run.view().revision, {
      action: 'validate', summary: '完成本轮核对', evidenceRefs: [resultRef],
    })
  } else {
    h.runtime.hmm.apply(controller, run.id, run.view().revision, {
      action: 'suspend', nodeId: run.nodeId, reason: '等待条件',
    })
    expect(await h.api('POST', `tasks/${run.id}/inputs`, { requestId: 'revision-extra', text: '待总管核对的新增条件' }))
      .toMatchObject({ status: 200 })
    if (state === 'stopped') await h.api('POST', `tasks/${run.id}/stop`)
  }
  await h.api('POST', 'executor/pause', { paused: true })
  await h.runtime.idle()
  expect(run.view().revision).toBeGreaterThan(revision)
  expect(await run.read()).toEqual(first)
  await h.restart()
  expect(await run.read()).toEqual(first)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each(['', 'planVersion=0', 'planVersion=-1', 'planVersion=1.5', 'planVersion=bad',
  'planVersion=1&revision=1', 'planVersion=1&nodeId=other'])('修订摘要拒绝无效及扩权读取参数：%s', async query => {
  expect(await h.api('GET', `tasks/absent/plan-change?${query}`)).toMatchObject({ status: 400 })
})

it('修订摘要拒绝仓库工单，不把管理入口作为跨来源读取通道', async () => {
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('plan-change-scope', '@bot 检查仓库'))
  expect(await h.api('GET', `tasks/${ticket.id}/plan-change?planVersion=1`))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
})

it('完成任务仍能按原计划版本核对目标，不重新派发或复制验收正文', async () => {
  const run = await task(), planVersion = run.view().planVersion
  await run.complete('analyze')
  await run.complete('execute')
  const result = await run.complete('evaluate')
  await run.command({ action: 'validate', summary: 'PRIVATE_VALIDATION_BODY', evidenceRefs: [result] })
  const before = h.runtime.store.get(KV.hmm.workflow(run.id)), launches = h.nodeFactory.mock.calls.length
  const read = await h.api('GET', `tasks/${run.id}/goal?planVersion=${planVersion}`)
  expect(read).toEqual({ status: 200, body: {
    ticketId: run.id, planVersion, text: '比较现有方案及其限制',
  } })
  expect(JSON.stringify(read.body)).not.toMatch(/PRIVATE_|instruction|sessionId|deviceGrants|evidenceRefs/)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
})

it.each(['', 'planVersion=0', 'planVersion=-1', 'planVersion=1.5', 'planVersion=bad',
  'planVersion=1&revision=1', 'planVersion=1&text=changed'])('目标读取拒绝无效和扩权参数：%s', async query => {
  expect(await h.api('GET', `tasks/absent/goal?${query}`)).toMatchObject({ status: 400 })
})

it('目标读取保持本地工单来源边界，未知任务与仓库任务分别拒绝', async () => {
  expect(await h.api('GET', 'tasks/absent/goal?planVersion=1')).toMatchObject({ status: 404 })
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('goal-source-scope', '@bot 检查仓库'))
  expect(await h.api('GET', `tasks/${ticket.id}/goal?planVersion=1`)).toMatchObject({
    status: 403, body: { code: 'scope_denied' },
  })
})

it('嵌套并行任务只展示有界的运行步骤，同快照计数且读取不启动、暂停或传递执行正文', async () => {
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: {
    ...h.runtime.store.settings().executor, maxWorkers: 8,
  } })
  const longTitle = '资'.repeat(46) + '\u{20000}' + '范围仍需核对'
  const titles = [longTitle, '核对\t授权资料\n的交付时间', 'Review permitted delivery dates',
    '<b>source</b>', 'Compare regional records', 'Verify the final source']
  const response = await h.api('POST', 'tasks', { requestId: 'running-summary', goal: '核对六份独立来源',
    plan: { maxActive: 8, nodes: [
      { id: 'root', title: 'PRIVATE_ROOT', mode: 'parallel' },
      { id: 'sources', parentId: 'root', title: 'PRIVATE_GROUP', mode: 'parallel' },
      ...titles.map((title, index) => ({ id: `source_${index}`, parentId: 'sources', title,
        instruction: `PRIVATE_INSTRUCTION_${index}` })),
      { id: 'waiting', parentId: 'sources', title: 'PRIVATE_PENDING', instruction: 'PRIVATE_WAITING',
        dependsOn: ['source_0'] },
    ] } })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const read = async () => {
    const response = await h.api('GET', `tasks/${id}`)
    expect(response.status).toBe(200)
    return response.body as ApiResponse<'GET tasks/:id'>
  }
  const before = h.runtime.store.get(KV.hmm.workflow(id)), ticket = h.runtime.store.tickets.get(id)
  const launches = h.nodeFactory.mock.calls.length, deliveries = h.deliveries.mock.calls.length
  const first = await read()
  expect(first.workflow.progress).toEqual({ total: 7, pending: 1, running: 6, completed: 0, suspended: 0, pruned: 0 })
  expect(first.workflow.runningSteps).toEqual({ total: 6, omitted: 2, items: [
    { nodeId: 'source_0', title: '资'.repeat(46) + '\u{20000}…' },
    { nodeId: 'source_1', title: '核对 授权资料 的交付时间' },
    { nodeId: 'source_2', title: titles[2] },
    { nodeId: 'source_3', title: titles[3] },
  ] })
  expect(first.workflow.runningSteps.total).toBe(first.workflow.progress.running)
  expect(Buffer.byteLength(JSON.stringify(first.workflow.runningSteps), 'utf8')).toBeLessThan(2048)
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE_|instruction|sessionId|deviceGrants|frame|history/)
  expect(await read()).toEqual(first)
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  expect(h.deliveries).toHaveBeenCalledTimes(deliveries)

  await h.api('POST', 'executor/pause', { paused: true })
  expect(await read()).toMatchObject({ activity: 'running', paused: true,
    workflow: { runningSteps: first.workflow.runningSteps } })
  const sessionId = h.runtime.hmm.view(controller, id).nodes.find(node => node.id === 'source_0')!.sessionId!
  await h.runTool(sessionId, 'hmm_node_report', { action: 'suspend', reason: '等待资料补全' })
  await h.runtime.idle()
  const next = await read()
  expect(next.workflow.runningSteps).toEqual({ total: 5, omitted: 1, items: [
    { nodeId: 'source_1', title: '核对 授权资料 的交付时间' },
    ...[2, 3, 4].map(index => ({ nodeId: `source_${index}`, title: titles[index] })),
  ] })
  expect(next.workflow.progress).toMatchObject({ running: 5, suspended: 1, pending: 1 })
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  await h.api('POST', `tasks/${id}/stop`)
  await h.runtime.idle()
  expect(await read()).toMatchObject({ ended: { outcome: 'stopped' },
    workflow: { runningSteps: { total: 0, omitted: 0, items: [] } } })
})

it('挂起原因全部可直接恢复时不要求打开总管，未知或受阻原因才要求总管', async () => {
  const run = await task()
  const node = run.view().nodes.find(item => item.id === 'analyze')!
  await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'suspend', reason: '等待人工确认资料' })
  await h.runtime.idle()
  expect((await run.read()).workflow.blockers).toMatchObject({ total: 1, requiresOrchestrator: false,
    items: [{ nodeId: 'analyze', resume: 'available' }] })
  const blocked = await h.api('POST', 'tasks', { requestId: 'orchestrator-blocker', goal: '检查分组阻断', dispatch: false,
    plan: { nodes: [
      { id: 'root', title: '主线', mode: 'parallel' },
      { id: 'group', parentId: 'root', title: '挂起分组', mode: 'parallel' },
      { id: 'step', parentId: 'group', title: '受阻步骤', instruction: '检查分组' },
    ] } })
  const blockedId = blocked.body.ticketId as string
  const blockedView = () => h.runtime.hmm.view(controller, blockedId)
  h.runtime.hmm.apply(controller, blockedId, blockedView().revision, { action: 'suspend', nodeId: 'group', reason: '分组待判断' })
  await h.runtime.idle()
  const blockedStatus = await h.api('GET', `tasks/${blockedId}`)
  expect(blockedStatus.status).toBe(200)
  expect((blockedStatus.body as ApiResponse<'GET tasks/:id'>).workflow.blockers)
    .toMatchObject({ requiresOrchestrator: true, items: [{ resume: 'parent_suspended' }] })
})

it('节点全部结束只表示待验收，总管验收并交付后才暴露最终结果', async () => {
  const run = await task()
  await run.complete('analyze')
  await run.complete('execute')
  const result = await run.complete('evaluate')
  expect(await run.read()).toMatchObject({ ended: null, result: null, activity: 'review',
    workflow: { phase: 'active', requiresOrchestrator: true, awaitingValidation: true,
      runningSteps: { total: 0, omitted: 0, items: [] }, progress: { total: 3, completed: 3, running: 0 } } })
  const summary = '按约束完成比较，明确已知条件与仍需验证的部分'
  await run.command({ action: 'validate', summary, evidenceRefs: [result] })
  expect(await run.read()).toMatchObject({ ended: { outcome: 'completed' }, activity: 'ended',
    workflow: { phase: 'validated', requiresOrchestrator: false, awaitingValidation: false },
    result: { summary, evidenceRefs: [result] }, resultError: null })
})

async function adoptedResults(external = false) {
  const ids = Array.from({ length: 9 }, (_, index) => `source_${index}_${'s'.repeat(55)}`)
  const response = await h.api('POST', 'tasks', { requestId: 'result-sources', goal: '比较来源并保留可回查的步骤成果',
    dispatch: false, plan: { nodes: [
      { id: 'root', title: '主线', mode: 'parallel' },
      ...ids.map(id => ({ id, parentId: 'root', title: '\u{20000}'.repeat(70), instruction: 'PRIVATE_INSTRUCTION' })),
    ] } })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string, view = () => h.runtime.hmm.view(controller, id)
  const document = external ? h.runtime.hmm.importEvidence(controller, id, view().revision, {
    id: 'original', title: 'PRIVATE_DOCUMENT', origin: 'Synthetic source', text: 'PRIVATE_RAW_SOURCE',
    nodeIds: ids,
  }).document : undefined
  for (const nodeId of ids) {
    const { lease } = h.runtime.hmm.apply(controller, id, view().revision, { action: 'start', nodeId })
    const ref = document
      ? h.runtime.hmm.readEvidence(controller, id, nodeId, { id: document.id, version: document.version }).ref
      : h.runtime.hmm.context(controller, id, nodeId).inputRef!
    h.runtime.hmm.apply(controller, id, view().revision, { action: 'complete', nodeId, lease: lease!,
      summary: '\u{20000}'.repeat(220), evidenceRefs: [ref] })
  }
  const selected = [ids[8]!, ...ids.slice(0, 8)]
  const refs = selected.map(nodeId => view().nodes.find(node => node.id === nodeId)!.resultRef!)
  h.runtime.hmm.apply(controller, id, view().revision, { action: 'validate', summary: '综合已完成步骤得到限定结论',
    evidenceRefs: [...refs, refs[0]!] })
  await h.runtime.idle()
  const page = (offset: number, revision = view().revision) =>
    h.api('GET', `tasks/${id}/result-sources?revision=${revision}&offset=${offset}`)
  return { id, view, selected, page }
}

it('验收采用的步骤按需分页且去重，节选有界、只读、重启可查，不输出原文或整棵计划', async () => {
  const run = await adoptedResults(), stored = h.runtime.store.get(KV.hmm.workflow(run.id))
  const ticket = h.runtime.store.tickets.get(run.id), launches = h.nodeFactory.mock.calls.length
  const status = (await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(status.result).toMatchObject({ sourceCount: 9 })
  expect(status.result).not.toHaveProperty('items')
  const collected: string[] = []
  for (const offset of [0, 4, 8]) {
    const response = await run.page(offset)
    expect(response.status).toBe(200)
    const page = response.body as ApiResponse<'GET tasks/:id/result-sources'>
    expect(page).toMatchObject({ ticketId: run.id, revision: run.view().revision, offset, total: 9,
      nextOffset: offset === 8 ? null : offset + 4 })
    expect(page.items.map(item => item.nodeId)).toEqual(run.selected.slice(offset, offset + 4))
    expect(page.items.every(item => item.title === '\u{20000}'.repeat(47) + '…'
      && item.summary.text === '\u{20000}'.repeat(159) + '…' && item.summary.truncated)).toBe(true)
    const json = JSON.stringify(page)
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(4096)
    expect(json).not.toMatch(/PRIVATE_|instruction|sessionId|deviceGrants|frame|evidenceRefs|claimReviews/)
    collected.push(...page.items.map(item => item.nodeId))
    expect(await run.page(offset)).toEqual(response)
  }
  expect(collected).toEqual(run.selected)
  expect(await run.page(9)).toMatchObject({ status: 200, body: { total: 9, items: [], nextOffset: null } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stored)
  expect(h.runtime.store.tickets.get(run.id)).toEqual(ticket)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  const first = await run.page(0)
  await h.api('POST', 'executor/pause', { paused: true })
  expect(await run.page(0)).toEqual(first)
  await h.restart()
  expect(await run.page(0)).toEqual(first)
})

it('依据撤回后旧版本与当前版本均不能取得验收步骤节选，历史完成不充当有效性许可', async () => {
  const run = await adoptedResults(true), revision = run.view().revision
  expect(await run.page(0)).toMatchObject({ status: 200 })
  h.runtime.hmm.revokeEvidence(controller, run.id, revision, 'original')
  const stored = h.runtime.store.get(KV.hmm.workflow(run.id)), ticket = h.runtime.store.tickets.get(run.id)
  expect(await run.page(0, revision)).toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(await run.page(0)).toMatchObject({ status: 409, body: { code: 'evidence_invalid' } })
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ body: {
    ended: { outcome: 'completed' }, result: null, resultError: 'evidence_invalid',
  } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stored)
  expect(h.runtime.store.tickets.get(run.id)).toEqual(ticket)
})

it.each(['active', 'stopped'] as const)('%s任务不暴露未经交付的验收依据', async state => {
  const run = await task()
  if (state === 'stopped') await h.api('POST', `tasks/${run.id}/stop`)
  expect(await h.api('GET', `tasks/${run.id}/result-sources?revision=${run.view().revision}&offset=0`))
    .toMatchObject({ status: 409, body: { code: 'result_unavailable' } })
})

it.each(['', 'revision=1', 'offset=0', 'revision=0&offset=0', 'revision=1&offset=-1',
  'revision=1&offset=1.5', 'revision=1&offset=65', 'revision=1&offset=0&ref=other',
  'revision=1&offset=0&snapshot=old'])('验收依据入口拒绝不完整、越界及额外参数：%s', async query => {
  expect(await h.api('GET', `tasks/absent/result-sources?${query}`)).toMatchObject({ status: 400 })
})

it('验收依据入口维持本地任务来源边界，不允许读取未知或仓库工单', async () => {
  expect(await h.api('GET', 'tasks/absent/result-sources?revision=1&offset=0')).toMatchObject({ status: 404 })
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('result-source-scope', '@bot 检查仓库'))
  expect(await h.api('GET', `tasks/${ticket.id}/result-sources?revision=1&offset=0`))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
})

it('交付后撤回来源时保留历史完成状态，但不继续返回失效结果', async () => {
  const run = await task()
  const node = run.view().nodes.find(item => item.id === 'analyze')!
  expect(await h.api('POST', `tickets/${run.id}/hmm/evidence`, { revision: run.view().revision,
    document: { id: 'schedule', title: '排期', origin: '操作者提供的片段', text: '候选方案排期为两天。', nodeIds: ['analyze'] },
  })).toMatchObject({ status: 200 })
  const query = await h.runTool(node.sessionId!, 'hmm_evidence_query', { text: '排期' })
  const hit = (query.hits as { id: string; version: string }[])[0]!
  const receipt = await h.runTool(node.sessionId!, 'hmm_evidence_read', { id: hit.id, version: hit.version })
  await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: '根据所给排期片段比较',
    evidenceRefs: [receipt.ref] })
  await h.runtime.idle()
  await run.complete('execute')
  const result = await run.complete('evaluate')
  await run.command({ action: 'validate', summary: '依所给资料完成比较', evidenceRefs: [result] })
  expect((await run.read()).result).not.toBeNull()
  expect(await h.api('POST', `tickets/${run.id}/hmm/evidence/schedule/revoke`, { revision: run.view().revision }))
    .toMatchObject({ status: 200 })
  const ticket = run.ticket(), before = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await run.read()).toMatchObject({ ended: { outcome: 'completed' }, activity: 'ended', workflow: {
    phase: 'validated', referenceIntegrity: 'invalid', dependencyBlockers: { total: 0, omitted: 0, items: [] },
  },
    result: null, resultError: 'evidence_invalid' })
  expect(run.ticket()).toEqual(ticket)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
})

it('暂停与挂起分别反映现有状态，重启后仍可查询而不恢复节点', async () => {
  const run = await task()
  const node = run.view().nodes.find(item => item.id === 'analyze')!
  const reasonPreview = '缺'.repeat(159) + '\u{20000}'
  const reason = reasonPreview + '\n需要说明约束\t  并补充来源。'.repeat(15)
  await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'suspend', reason })
  await h.runtime.idle()
  await h.api('POST', 'executor/pause', { paused: true })
  expect(await run.read()).toMatchObject({ paused: true, ended: null, result: null, activity: 'paused',
    workflow: { awaitingValidation: false, progress: { suspended: 1, running: 0, pending: 2 },
      blockers: { total: 1, omitted: 0, items: [{ nodeId: 'analyze', reason: reasonPreview }] } } })
  expect(JSON.stringify(await run.read())).not.toContain(reason)
  await h.restart()
  const launches = h.nodeFactory.mock.calls.length
  expect(await run.read()).toMatchObject({ paused: true, ended: null, result: null, activity: 'paused',
    workflow: { progress: { suspended: 1, running: 0 }, blockers: { total: 1, omitted: 0,
      items: [{ nodeId: 'analyze', reason: reasonPreview }] } } })
  await h.runtime.idle()
  expect(h.nodeFactory.mock.calls).toHaveLength(launches)
  await h.api('POST', 'executor/pause', { paused: false })
  await run.command({ action: 'resume', nodeId: 'analyze' })
  expect((await run.read()).workflow.blockers).toEqual({ snapshot: expect.stringMatching(/^[a-f0-9]{64}$/),
    total: 0, omitted: 0, requiresOrchestrator: false, items: [] })
})

it('停止入口结束在途执行并保留已有成果，迟到回写、重复请求和重启不能重开任务', async () => {
  const run = await task()
  await run.complete('analyze')
  const active = run.view().nodes.find(node => node.id === 'execute')!
  const context = h.runtime.hmm.context(controller, run.id, active.id)
  const evidenceRefs = context.sourceResults.map(result => result.ref)
  expect(evidenceRefs).not.toHaveLength(0)
  await h.runTool(active.sessionId!, 'hmm_node_report', { action: 'checkpoint', frame: '已完成一部分核对，外部动作待确认' })
  const report = h.tools.get(active.sessionId!)!.get('hmm_node_report')!
  const handle = h.owned.get(active.sessionId!)!
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))!
  const peer = await h.api('POST', 'tasks', { requestId: 'stop-peer', goal: '独立任务继续执行', mode: 'single' })
  await h.runtime.idle()
  const peerId = peer.body.ticketId as string, peerBefore = h.runtime.store.get(KV.hmm.workflow(peerId))
  const launches = h.nodeFactory.mock.calls.length
  const response = await h.api('POST', `tasks/${run.id}/stop`)
  expect(response).toMatchObject({ status: 200, body: {
    ticketId: run.id, ended: { outcome: 'stopped', by: 'human' }, result: null, activity: 'ended',
    workflow: { autoRun: false, progress: { running: 0, completed: 1 } },
  } })
  await h.runtime.idle()
  expect(handle.dispose).toHaveBeenCalledOnce()
  expect(h.owned.has(active.sessionId!)).toBe(false)
  const stored = h.runtime.store.get(KV.hmm.workflow(run.id))!
  expect(stored.nodes.find(node => node.id === 'analyze')).toEqual(before.nodes.find(node => node.id === 'analyze'))
  expect(stored.nodes.find(node => node.id === 'execute')).toMatchObject({ state: 'suspended', frame: '已完成一部分核对，外部动作待确认' })
  expect(stored.evidence).toEqual(before.evidence)
  expect(stored.deviceGrants).toEqual(before.deviceGrants)
  expect(h.runtime.store.get(KV.hmm.workflow(peerId))).toEqual(peerBefore)
  await expect(report.execute({ action: 'complete', summary: '迟到结果', evidenceRefs },
    { signal: new AbortController().signal })).rejects.toThrow()
  const ticket = run.ticket(), status = await run.read()
  expect((await h.api('POST', `tasks/${run.id}/stop`)).body).toEqual(status)
  expect(run.ticket()).toEqual(ticket)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stored)
  expect(await h.api('POST', `tasks/${run.id}/resume`, { revision: run.view().revision, nodeId: 'execute' }))
    .toMatchObject({ status: 409, body: { code: 'ticket_inactive' } })
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  await h.restart()
  await h.runtime.idle()
  expect((await h.api('POST', `tasks/${run.id}/stop`)).body).toEqual(status)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stored)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
})

it.each(['prepared', 'paused'] as const)('%s 状态仍可停止整个任务，不修改全局暂停', async state => {
  const response = await h.api('POST', 'tasks', { requestId: 'stop-state', goal: '核对当前来源', dispatch: state !== 'prepared' })
  await h.runtime.idle()
  const id = response.body.ticketId as string
  if (state === 'paused') h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  const settings = h.runtime.store.settings(), launches = h.nodeFactory.mock.calls.length
  const handles = [...h.owned.values()]
  expect(await h.api('POST', `tasks/${id}/stop`)).toMatchObject({ status: 200, body: {
    ended: { outcome: 'stopped' }, activity: 'ended', workflow: { autoRun: false, progress: { running: 0 } },
  } })
  await h.runtime.idle()
  expect(h.runtime.store.settings()).toEqual(settings)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  expect(h.owned.size).toBe(0)
  for (const handle of handles) expect(handle.dispose).toHaveBeenCalledOnce()
})

it('任务已完成后收到停止请求时保留原终态和交付结果', async () => {
  const run = await task()
  await run.complete('analyze')
  await run.complete('execute')
  const result = await run.complete('evaluate')
  await run.command({ action: 'validate', summary: '完成限定目标', evidenceRefs: [result] })
  const status = await run.read(), ticket = run.ticket(), stored = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(status.ended?.outcome).toBe('completed')
  expect(status.result).not.toBeNull()
  expect((await h.api('POST', `tasks/${run.id}/stop`)).body).toEqual(status)
  expect(run.ticket()).toEqual(ticket)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stored)
})

it('停止提交失败时一起回滚工单、节点及取消通知，不提前释放运行资源', async () => {
  const run = await task(), ticket = run.ticket(), stored = h.runtime.store.get(KV.hmm.workflow(run.id))
  const sessionId = run.view().nodes.find(node => node.state === 'running' && node.mode === 'task')!.sessionId!
  const handle = h.owned.get(sessionId)!
  const stop = h.runtime.engine.stopTicket.bind(h.runtime.engine)
  const injected = vi.spyOn(h.runtime.engine, 'stopTicket').mockImplementationOnce((...args) => {
    stop(...args)
    throw new Error('模拟停止提交失败')
  })
  try { expect(await h.api('POST', `tasks/${run.id}/stop`)).toMatchObject({ status: 500 }) }
  finally { injected.mockRestore() }
  await h.runtime.idle()
  expect(run.ticket()).toEqual(ticket)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stored)
  expect(handle.dispose).not.toHaveBeenCalled()
  expect(h.owned.get(sessionId)).toBe(handle)
  expect(await h.api('POST', `tasks/${run.id}/stop`)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(handle.dispose).toHaveBeenCalledOnce()
})

it('执行额度不足时显示等待，读取状态不创建执行或改变自动派发', async () => {
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: {
    ...h.runtime.store.settings().executor, maxWorkers: 1,
  } })
  const busy = await task()
  const response = await h.api('POST', 'tasks', { requestId: 'waiting', goal: '等待现有执行额度释放', mode: 'single' })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const before = h.runtime.store.get(KV.hmm.workflow(id)), calls = h.nodeFactory.mock.calls.length
  const read = () => h.api('GET', `tasks/${id}`)
  expect(await read()).toMatchObject({ status: 200, body: {
    activity: 'waiting', workflow: { autoRun: true, progress: { running: 0, pending: 1 },
      waitingFor: 'capacity',
      runningSteps: { total: 0, omitted: 0, items: [] } },
  } })
  expect(await read()).toMatchObject({ status: 200, body: { activity: 'waiting' } })
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(h.nodeFactory).toHaveBeenCalledTimes(calls)
  expect((await busy.read()).workflow).not.toHaveProperty('waitingFor')
  // 上下文送达不等于计划已采纳；也不能凭输入记录推断出新的执行阻断。
  h.runtime.tasks.input(id, { requestId: 'updated-scope', text: 'Review a changed input scope' })
  expect(await read()).toMatchObject({ status: 200, body: { workflow: { waitingFor: 'capacity' } } })
  await busy.command({ action: 'hold' })
  expect(await read()).toMatchObject({ status: 200, body: { activity: 'running' } })
  expect((await read()).body.workflow).not.toHaveProperty('waitingFor')
})

it.each(['held', 'paused', 'question', 'dependency'] as const)(
  '%s不是健康的自动容量等待，不能用等待提示掩盖当前条件', async condition => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    await task()
    const created = await h.api('POST', 'tasks', { requestId: 'waiting-conditions', goal: 'Review independent source scope',
      plan: { maxActive: 1, nodes: [
        { id: 'root', title: 'Sources', mode: 'parallel' },
        { id: 'source', parentId: 'root', title: 'Read source', instruction: 'PRIVATE_SOURCE_INSTRUCTION' },
        { id: 'review', parentId: 'root', title: 'Review source', instruction: 'PRIVATE_REVIEW_INSTRUCTION', dependsOn: ['source'] },
      ] } })
    const id = created.body.ticketId as string, view = () => h.runtime.hmm.view(controller, id)
    await h.runtime.idle()
    expect(h.runtime.tasks.status(id).workflow.waitingFor).toBe('capacity')
    if (condition === 'held') h.runtime.hmm.apply(controller, id, view().revision, { action: 'hold' })
    if (condition === 'paused') h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
    if (condition === 'question') h.runtime.tasks.ask(id, { revision: view().revision, question: 'Choose the authorized scope' })
    if (condition === 'dependency') h.runtime.hmm.apply(controller, id, view().revision,
      { action: 'prune', nodeId: 'source', reason: 'Source is unavailable', reconsiderWhen: 'Access is restored' })
    const before = h.runtime.store.get(KV.hmm.workflow(id)), calls = h.nodeFactory.mock.calls.length
    const status = h.runtime.tasks.status(id)
    expect(status.workflow).not.toHaveProperty('waitingFor')
    expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
    expect(h.nodeFactory).toHaveBeenCalledTimes(calls)
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE_|"frame"|"sessionId"/)
  })

it('全局仍有槽但前一回合尚未退出占满计划容量时如实等待，退出后自动推进且保留已交成果', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  const created = await h.api('POST', 'tasks', { requestId: 'waiting-finish', goal: 'Read sources in sequence',
    plan: { maxActive: 1, nodes: [
      { id: 'root', title: 'Sources', mode: 'serial' },
      { id: 'first', parentId: 'root', title: 'Read first source', instruction: 'Read the permitted source' },
      { id: 'second', parentId: 'root', title: 'Read next source', instruction: 'Review the permitted source' },
    ] } })
  const id = created.body.ticketId as string, view = () => h.runtime.hmm.view(controller, id)
  await h.runtime.idle()
  const first = view().nodes.find(node => node.id === 'first')!, handle = h.owned.get(first.sessionId!)!
  const gate = Promise.withResolvers<void>(), idle = vi.spyOn(handle.agent, 'whenIdle').mockImplementation(() => gate.promise)
  try {
    const context = await h.runTool(first.sessionId!, 'hmm_node_context', {})
    await h.runTool(first.sessionId!, 'hmm_node_report', { action: 'complete',
      summary: 'First source checked', evidenceRefs: [context.inputRef] })
    await vi.waitFor(() => expect(idle).toHaveBeenCalled())
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    const response = await h.api('GET', `tasks/${id}`)
    expect(response).toMatchObject({ status: 200, body: { activity: 'waiting', workflow: {
      waitingFor: 'capacity', progress: { running: 0, completed: 1, pending: 1 },
    } } })
    expect((await h.api('GET', 'state')).body.load).toMatchObject({ occupied: 1, maxWorkers: 2 })
    const result = view().nodes.find(node => node.id === 'first')!.resultRef
    gate.resolve()
    await h.runtime.idle()
    const next = (await h.api('GET', `tasks/${id}`)).body
    expect(next).toMatchObject({ activity: 'running', workflow: { progress: { completed: 1, running: 1 } } })
    expect(next.workflow).not.toHaveProperty('waitingFor')
    expect(view().nodes.find(node => node.id === 'first')!.resultRef).toBe(result)
    expect(h.nodeFactory).toHaveBeenCalledTimes(2)
  } finally { gate.resolve(); await h.runtime.idle(); idle.mockRestore() }
})

it('全局暂停不把仍在运行的节点说成已停，实际挂起后显示暂停，恢复后才显示运行', async () => {
  const run = await task()
  await h.api('POST', 'executor/pause', { paused: true })
  expect(await run.read()).toMatchObject({ activity: 'running', paused: true, workflow: { progress: { running: 1 } } })
  await run.command({ action: 'hold' })
  expect(await run.read()).toMatchObject({ activity: 'paused', paused: true, workflow: { progress: { running: 0 } } })
  const stopped = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await h.api('POST', `tickets/${run.id}/hmm/commands`, { revision: run.view().revision, command: { action: 'dispatch' } }))
    .toMatchObject({ status: 409 })
  expect(await h.api('POST', `tasks/${run.id}/resume`, { revision: run.view().revision, nodeId: 'analyze' }))
    .toMatchObject({ status: 409 })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stopped)
  await h.api('POST', 'executor/pause', { paused: false })
  expect(await run.read()).toMatchObject({ activity: 'held', paused: false })
  expect(await h.api('POST', `tasks/${run.id}/resume`, { revision: run.view().revision, nodeId: 'analyze' }))
    .toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(await run.read()).toMatchObject({ activity: 'running', workflow: { autoRun: true, progress: { running: 1 } } })
})

it('允许暂停下停止派发不扩大到结束任务或节点自行控制派发', async () => {
  const run = await task()
  const sessionId = run.view().nodes.find(node => node.id === 'analyze')!.sessionId!
  await h.api('POST', 'executor/pause', { paused: true })
  const bound = h.runtime.store.get(KV.hmm.workflow(run.id))!.nodes.find(node => node.id === 'analyze')!
  expect(() => h.runtime.hmm.apply({ role: 'node', ticketId: run.id, nodeId: bound.id, sessionId,
    lease: bound.lease! }, run.id, run.view().revision, { action: 'hold' }))
    .toThrow(expect.objectContaining({ code: 'controller_required' }))
  await expect(h.runTool(sessionId, 'hmm_apply', { command: { action: 'hold' }, revision: run.view().revision }))
    .rejects.toThrow()
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await h.api('POST', `tickets/${run.id}/hmm/commands`, { revision: run.view().revision, command: { action: 'hold' } }))
    .toMatchObject({ status: 409, body: { code: 'ticket_inactive' } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
})

it('自动执行中的全部挂起或全部剪枝需要处理，不显示执行中或等待验收', async () => {
  const run = await task()
  const sessionId = run.view().nodes.find(node => node.id === 'analyze')!.sessionId!
  await h.runTool(sessionId, 'hmm_node_report', { action: 'suspend', reason: '等待必要资料' })
  await h.runtime.idle()
  expect(await run.read()).toMatchObject({ activity: 'attention', workflow: { autoRun: true, planReviewRequired: false,
    progress: { running: 0 } } })
  await run.command({ action: 'prune', nodeId: 'root', reason: '当前路径不成立', reconsiderWhen: '目标或证据变化' })
  expect(await run.read()).toMatchObject({ activity: 'attention', workflow: {
    autoRun: true, requiresOrchestrator: true, planReviewRequired: true, awaitingValidation: false,
    progress: { completed: 0, pruned: 3, running: 0 },
  } })
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  expect((await run.read()).workflow.planReviewRequired).toBe(false)
})

it('并行任务部分挂起时仍显示实际运行，剩余节点结束后才转为需要处理', async () => {
  const response = await h.api('POST', 'tasks', { requestId: 'mixed', goal: '并行核对两个独立来源',
    plan: { maxActive: 2, nodes: [
      { id: 'root', title: '并行核对', mode: 'parallel' },
      { id: 'left', parentId: 'root', title: '核对左侧', instruction: '核对已授权资料' },
      { id: 'right', parentId: 'root', title: '核对右侧', instruction: '独立核对已有输入' },
    ] } })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const left = view().nodes.find(node => node.id === 'left')!, right = view().nodes.find(node => node.id === 'right')!
  await h.runTool(left.sessionId!, 'hmm_node_report', { action: 'suspend', reason: '等待补充左侧资料' })
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(id))
  expect(await h.api('GET', `tasks/${id}`)).toMatchObject({ status: 200, body: {
    activity: 'running', workflow: { progress: { running: 1, suspended: 1 }, blockers: { total: 1 } },
  } })
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  const context = await h.runTool(right.sessionId!, 'hmm_node_context', {})
  await h.runTool(right.sessionId!, 'hmm_node_report', { action: 'complete', summary: '已完成右侧核对', evidenceRefs: [context.inputRef] })
  await h.runtime.idle()
  expect(await h.api('GET', `tasks/${id}`)).toMatchObject({ status: 200, body: {
    activity: 'attention', workflow: { progress: { running: 0, suspended: 1, completed: 1 } },
  } })
})

it('待验收成果的依据撤回后显示需要处理，不能继续呈现健康的待验收状态', async () => {
  const run = await task()
  const node = run.view().nodes.find(item => item.id === 'analyze')!
  const document = h.runtime.hmm.importEvidence(controller, run.id, run.view().revision, {
    id: 'activity-source', title: '依据', origin: '合成来源', text: '用于当前核查的原始片段', nodeIds: ['analyze'],
  }).document
  const receipt = await h.runTool(node.sessionId!, 'hmm_evidence_read', { id: document.id, version: document.version })
  await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: '依据资料核查',
    evidenceRefs: [receipt.ref] })
  await h.runtime.idle()
  await run.complete('execute')
  await run.complete('evaluate')
  expect(await run.read()).toMatchObject({ activity: 'review' })
  h.runtime.hmm.revokeEvidence(controller, run.id, run.view().revision, document.id)
  const before = h.runtime.store.get(KV.hmm.workflow(run.id)), count = h.nodeFactory.mock.calls.length
  expect(await run.read()).toMatchObject({ activity: 'attention', ended: null, workflow: {
    awaitingValidation: true, referenceIntegrity: 'invalid', progress: { completed: 3, running: 0 },
  } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  expect(h.nodeFactory).toHaveBeenCalledTimes(count)
})

it('查询仅适用于本地 HMM 工单，未知任务与仓库工单分别拒绝', async () => {
  expect(await h.api('GET', 'tasks/missing')).toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  expect(await h.api('POST', 'tasks/missing/stop')).toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('repo-status', '@bot 检查仓库问题'))
  expect(await h.api('GET', `tasks/${ticket.id}`)).toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  const before = h.runtime.store.tickets.get(ticket.id)
  expect(await h.api('POST', `tasks/${ticket.id}/stop`)).toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  expect(h.runtime.store.tickets.get(ticket.id)).toEqual(before)
})

it('大计划和长输入不膨胀状态响应，也不泄漏指令、历史正文或会话', async () => {
  const run = await task()
  await run.command({ action: 'hold' })
  const current = h.runtime.hmm.definition(controller, run.id)
  const root = current.plan.nodes.find(node => !node.parentId)!
  const instruction = 'PRIVATE_NODE_INSTRUCTION_'.repeat(8), text = 'PRIVATE_CONTEXT_BODY_'.repeat(180)
  const nodes: PlanInput['nodes'] = current.plan.nodes.map(node => node.mode === 'task'
    ? { ...node, title: '任务'.repeat(80), instruction } : node)
  for (let index = nodes.length; index < HMM_LIMITS.nodes; index++)
    nodes.push({ id: `branch_${index}`, parentId: root.id, title: '任务'.repeat(80), instruction })
  expect(await h.api('POST', `tickets/${run.id}/hmm/revisions`, {
    revision: current.revision, plan: { ...current.plan, nodes }, reason: '验证大计划下的查询边界',
  })).toMatchObject({ status: 200 })
  for (let index = 0; index < 20; index++)
    expect(await h.api('POST', `tasks/${run.id}/inputs`, { requestId: `body-${index}`, text })).toMatchObject({ status: 200 })
  expect(Buffer.byteLength(JSON.stringify(await run.read()), 'utf8')).toBeLessThan(2048)
  const blockerReason = '约束仍需确认并补充支持资料。'.repeat(20)
  for (let index = 4; index < 12; index++)
    await run.command({ action: 'suspend', nodeId: `branch_${index}`, reason: blockerReason })
  const status = await run.read(), json = JSON.stringify(status)
  expect(status.workflow.progress.total).toBe(HMM_LIMITS.nodes - 1)
  expect(status.workflow.blockers).toMatchObject({ total: 8, omitted: 4, items: [
    { nodeId: 'branch_4', reason: blockerReason.slice(0, 160) },
    { nodeId: 'branch_5', reason: blockerReason.slice(0, 160) },
    { nodeId: 'branch_6', reason: blockerReason.slice(0, 160) },
    { nodeId: 'branch_7', reason: blockerReason.slice(0, 160) },
  ] })
  expect(status.workflow.blockers.items).toHaveLength(4)
  expect(status.inputs.total).toBeGreaterThanOrEqual(20)
  expect(status.result).toBeNull()
  expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(4096)
  expect(json).not.toContain(instruction)
  expect(json).not.toContain(text)
  expect(json).not.toContain(blockerReason)
  expect(json).not.toContain('sessionId')
  expect(status.workflow).not.toHaveProperty('nodes')
  expect(status.workflow).not.toHaveProperty('deviceGrants')
})

async function dependencyTask(options: { wide?: boolean; pending?: boolean; titles?: string[] } = {}) {
  const count = options.wide ? 6 : 1
  const sources = Array.from({ length: count }, (_, index) => `source_${index}_${'s'.repeat(54)}`)
  const dependents = Array.from({ length: count }, (_, index) => `check_${index}_${'c'.repeat(55)}`)
  const titles = dependents.map((_, index) => options.titles?.[index] ?? `核验步骤 ${index + 1}`)
  const instruction = 'PRIVATE_NODE_INSTRUCTION', text = 'PRIVATE_SOURCE_BODY_'.repeat(160)
  const response = await h.api('POST', 'tasks', {
    requestId: 'dependency-status', title: 'Dependency status', goal: 'Check the authorized source', dispatch: false,
    plan: { nodes: [
      { id: 'root', title: 'Root', mode: 'parallel' },
      ...sources.map(id => ({ id, parentId: 'root', title: 'PRIVATE_SOURCE_TITLE', instruction, evidenceRequired: true })),
      { id: 'checks', parentId: 'root', title: 'Checks', mode: 'parallel', dependsOn: sources },
      ...dependents.map((id, index) => ({ id, parentId: 'checks', title: titles[index]!, instruction })),
      { id: 'independent', parentId: 'root', title: 'Independent', instruction },
    ] },
  })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const input = { id: 'memo', title: 'PRIVATE_DOCUMENT_TITLE', origin: 'Operator', text, nodeIds: sources }
  const document = h.runtime.hmm.importEvidence(controller, id, view().revision, input).document
  for (const nodeId of options.pending ? [] : sources) {
    const { lease } = h.runtime.hmm.apply(controller, id, view().revision, { action: 'start', nodeId })
    const receipt = h.runtime.hmm.readEvidence(controller, id, nodeId, { id: document.id, version: document.version })
    h.runtime.hmm.apply(controller, id, view().revision, {
      action: 'complete', nodeId, lease: lease!, summary: 'PRIVATE_RESULT_BODY', evidenceRefs: [receipt.ref],
    })
  }
  await h.runtime.idle()
  const read = async () => {
    const response = await h.api('GET', `tasks/${id}`)
    expect(response.status).toBe(200)
    return response.body as ApiResponse<'GET tasks/:id'>
  }
  return { id, sources, dependents, titles, input, view, read }
}

it.each(['revoke', 'replace'] as const)('来源 %s 后状态接口呈现依赖问题，保持只读且不冒充挂起或完成', async action => {
  const run = await dependencyTask()
  expect((await run.read()).workflow).toMatchObject({
    referenceIntegrity: 'valid', dependencyBlockers: { total: 0, omitted: 0, items: [] },
  })
  if (action === 'revoke')
    h.runtime.hmm.revokeEvidence(controller, run.id, run.view().revision, run.input.id)
  else h.runtime.hmm.importEvidence(controller, run.id, run.view().revision, run.input)
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  const ticket = h.runtime.store.tickets.get(run.id)
  const deliveries = h.deliveries.mock.calls.length
  const expected = {
    referenceIntegrity: 'invalid', progress: { pending: 2, completed: 1, suspended: 0 },
    blockers: { total: 0, omitted: 0, items: [] },
    dependencyBlockers: { total: 1, omitted: 0, items: [
      { nodeId: run.dependents[0], title: run.titles[0], blockedBy: run.sources, omittedDependencies: 0 },
    ] },
  }
  const status = await run.read()
  expect(status.workflow).toMatchObject(expected)
  expect(status.result).toBeNull()
  expect(status.resultError).toBeNull()
  expect(JSON.stringify(status)).not.toContain('PRIVATE_')
  expect(await run.read()).toEqual(status)
  await h.runtime.idle()
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  expect(h.runtime.store.tickets.get(run.id)).toEqual(ticket)
  expect(h.deliveries.mock.calls).toHaveLength(deliveries)
  expect(h.nodeFactory).not.toHaveBeenCalled()

  await h.restart()
  expect((await run.read()).workflow).toMatchObject(expected)
  h.runtime.hmm.apply(controller, run.id, run.view().revision, {
    action: 'recheck', nodeId: run.sources[0]!, reason: 'Read the updated source',
  })
  // 清除旧结果后没有失效引用，并不代表待执行任务已完成或可立即交付。
  expect(await run.read()).toMatchObject({ result: null, workflow: {
    referenceIntegrity: 'valid', progress: { pending: 3, completed: 0 },
    dependencyBlockers: { total: 0, omitted: 0, items: [] },
  } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each([
  { title: ' \tRecheck\n  delivery\r\n dates ', expected: 'Recheck delivery dates' },
  { title: '\u{20000}'.repeat(48), expected: '\u{20000}'.repeat(48) },
])('依赖标题归一空白且保留未超限的 Unicode 标题：$expected', async ({ title, expected }) => {
  const run = await dependencyTask({ titles: [title] })
  h.runtime.hmm.revokeEvidence(controller, run.id, run.view().revision, run.input.id)
  const before = run.view()
  const status = await run.read()
  expect(status.workflow.dependencyBlockers.items).toEqual([{
    nodeId: run.dependents[0], title: expected, blockedBy: run.sources, omittedDependencies: 0,
  }])
  expect(run.view()).toEqual(before)
  expect(JSON.stringify(status)).not.toContain('PRIVATE_')
})

it('依赖摘要同时限制节点数和每节点依赖数，不复制整棵计划或原文', async () => {
  const run = await dependencyTask({ wide: true, titles: Array(6).fill(' \n' + '\u{20000}'.repeat(64) + 'PRIVATE_TITLE_TAIL') })
  h.runtime.hmm.revokeEvidence(controller, run.id, run.view().revision, run.input.id)
  const status = await run.read(), json = JSON.stringify(status)
  expect(status.workflow.dependencyBlockers).toEqual({
    total: run.dependents.length, omitted: 2,
    items: run.dependents.slice(0, 4).map(nodeId => ({
      nodeId, title: '\u{20000}'.repeat(47) + '…', blockedBy: run.sources.slice(0, 4), omittedDependencies: 2,
    })),
  })
  expect(status.workflow.blockers.total).toBe(0)
  expect(status.workflow.progress).toMatchObject({ pending: run.dependents.length + 1, completed: run.sources.length })
  expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(4096)
  expect(json).not.toContain('PRIVATE_')
  expect(json).not.toContain('sessionId')
  expect(status.workflow).not.toHaveProperty('nodes')
  expect(status.workflow).not.toHaveProperty('deviceGrants')
})

it.each([false, true])('剪枝来源的依赖摘要保持有界、只读且跨重启可查，宽计划=%s', async wide => {
  const run = await dependencyTask({ wide, pending: true })
  for (const nodeId of run.sources)
    h.runtime.hmm.apply(controller, run.id, run.view().revision, {
      action: 'prune', nodeId, reason: 'PRIVATE_PRUNE_REASON', reconsiderWhen: 'New input',
    })
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  const status = await run.read(), json = JSON.stringify(status)
  expect(status.workflow).toMatchObject({
    referenceIntegrity: 'valid', awaitingValidation: false,
    progress: { pending: run.dependents.length + 1, pruned: run.sources.length, completed: 0, suspended: 0 },
    blockers: { total: 0, omitted: 0, items: [] },
    dependencyBlockers: {
      total: run.dependents.length, omitted: Math.max(0, run.dependents.length - 4),
      items: run.dependents.slice(0, 4).map((nodeId, index) => ({
        nodeId, title: run.titles[index], blockedBy: run.sources.slice(0, 4), omittedDependencies: Math.max(0, run.sources.length - 4),
      })),
    },
  })
  expect(status.result).toBeNull()
  expect(json).not.toContain('PRIVATE_')
  expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(4096)
  expect(await run.read()).toEqual(status)
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  await h.restart()
  expect(await run.read()).toEqual(status)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

async function manyBlockers(peer = false) {
  const ids = Array.from({ length: 9 }, (_, index) => `blocked_${index}`)
  const response = await h.api('POST', 'tasks', { requestId: 'many-blockers', goal: '分别核对多个已有来源', dispatch: false,
    plan: { maxActive: 1, nodes: [
      { id: 'root', title: '主线', mode: 'parallel' },
      { id: 'held', parentId: 'root', title: '待核对分组', mode: 'parallel' },
      ...ids.map((id, index) => ({ id, parentId: index < 4 ? 'held' : 'root', title: `核查步骤 ${index}`,
        instruction: 'PRIVATE_NODE_INSTRUCTION_'.repeat(8) })),
      ...(peer ? [{ id: 'peer', parentId: 'root', title: '独立分析', instruction: '核对独立问题' }] : []),
    ] } })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  for (const nodeId of ['held', ...ids.slice(4)])
    h.runtime.hmm.apply(controller, id, view().revision, { action: 'suspend', nodeId,
      reason: '当前约束需要核对。'.repeat(30) })
  await h.runtime.idle()
  const page = (offset: number, revision = view().revision) =>
    h.api('GET', `tasks/${id}/blockers?revision=${revision}&offset=${offset}`)
  return { id, ids, view, page }
}

it('无关分支执行与完成不改变挂起快照，但旧执行版本仍不能恢复节点', async () => {
  const run = await manyBlockers(true)
  const status = (await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>
  const snapshot = status.workflow.blockers.snapshot, revision = status.workflow.revision
  expect(snapshot).toMatch(/^[a-f0-9]{64}$/)
  const page = () => h.api('GET', `tasks/${run.id}/blockers?revision=${revision}&offset=4&snapshot=${snapshot}`)
  const initial = await page()
  expect(initial.status).toBe(200)
  h.runtime.hmm.apply(controller, run.id, run.view().revision, { action: 'dispatch' })
  await h.runtime.idle()
  const peer = run.view().nodes.find(node => node.id === 'peer')!
  expect(peer).toMatchObject({ state: 'running', sessionId: expect.any(String) })
  expect((await page()).body).toMatchObject({ snapshot, items: initial.body.items })
  const context = h.runtime.hmm.context(controller, run.id, 'peer')
  await h.runTool(peer.sessionId!, 'hmm_node_report', {
    action: 'complete', summary: '独立分析已完成', evidenceRefs: [context.inputRef],
  })
  await h.runtime.idle()
  const current = (await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(current.workflow.revision).toBeGreaterThan(revision)
  expect(current.workflow.blockers).toEqual(status.workflow.blockers)
  expect(await page()).toMatchObject({ status: 200, body: {
    snapshot, revision: current.workflow.revision, items: initial.body.items,
  } })
  expect(await run.page(4, revision)).toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(await h.api('POST', `tasks/${run.id}/resume`, { revision, nodeId: run.ids[8] }))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(run.view().nodes.find(node => node.id === run.ids[8])?.state).toBe('suspended')
  await h.restart()
  expect((await page()).body).toMatchObject({ snapshot, items: initial.body.items })
})

it.each(['tail_reason', 'manual_running', 'plan', 'input', 'remove'] as const)(
  '%s变化使旧挂起快照失效，当前任务版本不能掩盖旧列表', async change => {
    const run = await manyBlockers(true)
    const read = async () => (await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>
    const before = await read(), snapshot = before.workflow.blockers.snapshot
    if (change === 'tail_reason')
      h.runtime.hmm.apply(controller, run.id, run.view().revision, { action: 'suspend', nodeId: run.ids[8]!, reason: '后页来源已变化' })
    else if (change === 'manual_running')
      h.runtime.hmm.apply(controller, run.id, run.view().revision, { action: 'start', nodeId: 'peer' })
    else if (change === 'plan') {
      const plan = h.runtime.hmm.definition(controller, run.id).plan
      plan.nodes.find(node => node.id === 'peer')!.instruction = '重新界定独立分析的约束'
      h.runtime.hmm.revise(controller, run.id, { revision: run.view().revision, plan, reason: '重新核对任务定义' })
    } else if (change === 'input')
      await h.api('POST', `tasks/${run.id}/inputs`, { requestId: 'snapshot-input', text: '新增约束，需重新判断' })
    else h.runtime.hmm.apply(controller, run.id, run.view().revision, { action: 'resume', nodeId: run.ids[8]! })
    await h.runtime.idle()
    const current = await read()
    expect(current.workflow.blockers.snapshot).not.toBe(snapshot)
    if (['tail_reason', 'plan', 'input'].includes(change))
      expect(current.workflow.blockers.items).toEqual(before.workflow.blockers.items)
    if (change === 'manual_running')
      expect((await run.page(4)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ resume: 'manual_running' })]))
    const persisted = h.runtime.store.get(KV.hmm.workflow(run.id))
    expect(await h.api('GET', `tasks/${run.id}/blockers?revision=${current.workflow.revision}&offset=4&snapshot=${snapshot}`))
      .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
    expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(persisted)
    expect(await h.api('GET', `tasks/${run.id}/blockers?revision=${current.workflow.revision}&offset=4&snapshot=${current.workflow.blockers.snapshot}`))
      .toMatchObject({ status: 200, body: { snapshot: current.workflow.blockers.snapshot } })
  })

it('暂停与结束不阻止快照只读查询，但不提供恢复权限', async () => {
  const run = await manyBlockers()
  const status = (await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>
  const { snapshot } = status.workflow.blockers
  const page = () => h.api('GET', `tasks/${run.id}/blockers?revision=${status.workflow.revision}&offset=4&snapshot=${snapshot}`)
  await h.api('POST', 'executor/pause', { paused: true })
  expect(await page()).toMatchObject({ status: 200, body: { snapshot } })
  expect(await h.api('POST', `tasks/${run.id}/resume`, { revision: run.view().revision, nodeId: run.ids[8] }))
    .toMatchObject({ status: 409, body: { code: 'paused' } })
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  expect(await page()).toMatchObject({ status: 200, body: { snapshot } })
  expect(await h.api('POST', `tasks/${run.id}/resume`, { revision: run.view().revision, nodeId: run.ids[8] }))
    .toMatchObject({ status: 409, body: { code: 'ticket_inactive' } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('超过四项的挂起步骤按需分页，首屏受阻不会使后续可恢复步骤永久不可见', async () => {
  const run = await manyBlockers()
  const before = h.runtime.store.get(KV.hmm.workflow(run.id)), deliveries = h.deliveries.mock.calls.length
  const detail = (await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(detail.workflow.blockers).toMatchObject({ total: 9, omitted: 5, items: [
    { nodeId: run.ids[0], resume: 'parent_suspended' }, { nodeId: run.ids[1], resume: 'parent_suspended' },
    { nodeId: run.ids[2], resume: 'parent_suspended' }, { nodeId: run.ids[3], resume: 'parent_suspended' },
  ] })
  const collected: string[] = []
  for (const [offset, count, nextOffset] of [[0, 4, 4], [4, 4, 8], [8, 1, null]] as const) {
    const response = await run.page(offset)
    expect(response.status).toBe(200)
    const page = response.body as ApiResponse<'GET tasks/:id/blockers'>
    expect(page).toMatchObject({ revision: run.view().revision, total: 9, nextOffset })
    expect(page.items).toHaveLength(count)
    expect(page.items.map(item => item.nodeId)).toEqual(run.ids.slice(offset, offset + count))
    if (offset === 0) expect(page.items).toEqual(detail.workflow.blockers.items)
    else expect(page.items.every(item => item.resume === 'available')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(4096)
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|instruction|sessionId|deviceGrants|frame|history/)
    collected.push(...page.items.map(item => item.nodeId))
    expect(await run.page(offset)).toEqual(response)
  }
  expect(collected).toEqual(run.ids)
  expect(await run.page(9)).toMatchObject({ status: 200, body: { total: 9, items: [], nextOffset: null } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  expect(h.deliveries.mock.calls).toHaveLength(deliveries)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(await h.api('POST', `tasks/${run.id}/resume`, { revision: detail.workflow.revision, nodeId: run.ids[8] }))
    .toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(run.view().nodes.find(node => node.id === run.ids[8])).toMatchObject({ state: 'running', attempt: 1 })
  expect(run.view().nodes.find(node => node.id === run.ids[0])).toMatchObject({ state: 'suspended', attempt: 0 })
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it('计划版本变化后拒绝旧页码，重启不自动恢复；结束任务仍可按当前版本只读查看', async () => {
  const run = await manyBlockers(), revision = run.view().revision
  const first = await run.page(4)
  await h.restart()
  expect(await run.page(4)).toEqual(first)
  h.runtime.hmm.apply(controller, run.id, run.view().revision, { action: 'resume', nodeId: run.ids[8]! })
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await run.page(4, revision)).toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  expect(await run.page(4)).toMatchObject({ status: 200, body: { total: 8, nextOffset: null } })
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  const stopped = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await run.page(4)).toMatchObject({ status: 200 })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(stopped)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each(['', 'revision=1', 'offset=4', 'revision=0&offset=4', 'revision=1.5&offset=4',
  'revision=1&offset=-1', 'revision=1&offset=1.5', 'revision=1&offset=65', 'revision=bad&offset=4',
  'revision=1&offset=4&dispatch=true', 'revision=1&offset=4&snapshot=bad',
  `revision=1&offset=4&snapshot=${'a'.repeat(65)}`, 'revision=1&offset=4&snapshot='])('挂起分页拒绝越界或扩权参数：%s', async query => {
  expect(await h.api('GET', `tasks/absent/blockers?${query}`)).toMatchObject({ status: 400 })
})

it('挂起分页继续限制本地任务来源，未知任务与仓库工单分别拒绝', async () => {
  expect(await h.api('GET', 'tasks/absent/blockers?revision=1&offset=0'))
    .toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('blocker-page-scope', '@bot 检查仓库问题'))
  expect(await h.api('GET', `tasks/${ticket.id}/blockers?revision=1&offset=0`))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
})
