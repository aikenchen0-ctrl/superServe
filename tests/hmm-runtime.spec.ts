import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { createHash } from 'node:crypto'
import { attachKnowledgeDevice } from '../src/index.ts'
import { key } from '../src/core/index.ts'
import { settingsPolicy } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const plan = {
  goal: '核验用户提出的目标',
  nodes: [
    { id: 'root', title: '主线', mode: 'serial' },
    { id: 'check', parentId: 'root', title: '核验', instruction: '记录依据并给出结果' },
  ],
}

it('宿主中断通知与状态原子提交，重启后送达一次且不会自动重放节点', async () => {
  const controller = { role: 'controller' as const }
  const response = await h.api('POST', 'tasks', {
    requestId: 'recovery-notice', goal: 'PRIVATE_GOAL',
    plan: { maxActive: 3, nodes: [
      { id: 'root', title: 'Work', mode: 'parallel' },
      ...['saved', 'left', 'right'].map(id => ({ id, parentId: 'root', title: id, instruction: 'PRIVATE_INSTRUCTION' })),
    ] },
  })
  expect(response.status).toBe(200)
  const ticketId = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, ticketId)
  const node = (id: string) => view().nodes.find(node => node.id === id)!
  const matches = (item: Record<string, unknown>) =>
    item.kind === 'hmm_attention' && item.reasonCode === 'host_interrupted' && item.ticket_id === ticketId
  const notices = () => h.relays(h.runtime.masterId).filter(matches)
  const queued = () => (h.runtime.store.db.prepare("SELECT value FROM effect WHERE kind = 'relay'").all() as { value: string }[])
    .map(row => JSON.parse(JSON.parse(row.value).text) as Record<string, unknown>).filter(matches)
  await h.runtime.idle()
  const context = await h.runTool(node('saved').sessionId!, 'hmm_node_context', {})
  await h.runTool(node('saved').sessionId!, 'hmm_node_report', {
    action: 'complete', summary: 'PRIVATE_RESULT', evidenceRefs: [context.inputRef],
  })
  await h.runtime.idle()
  const savedRef = node('saved').resultRef
  const oldSession = node('left').sessionId!
  const oldReport = h.tools.get(oldSession)!.get('hmm_node_report')!
  await h.runTool(oldSession, 'hmm_node_report', { action: 'checkpoint', frame: 'PRIVATE_CHECKPOINT' })
  await h.runtime.effects.drain()
  const before = view(), launches = h.nodeFactory.mock.calls.length
  expect(() => h.runtime.store.atomic(() => {
    h.runtime.hmm.recover()
    expect(queued()).toHaveLength(1)
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(view()).toEqual(before)
  expect(queued()).toHaveLength(0)

  h.runtime.hmm.recover()
  const recovered = view()
  expect(recovered.autoRun).toBe(false)
  expect(node('left').state).toBe('suspended')
  expect(node('right').state).toBe('suspended')
  expect(node('saved').resultRef).toBe(savedRef)
  expect(queued()).toHaveLength(1)
  expect(queued()[0]).toMatchObject({ revision: recovered.revision })
  expect(JSON.stringify(queued())).not.toContain('PRIVATE_')
  expect(Buffer.byteLength(JSON.stringify(queued()[0]))).toBeLessThan(512)
  h.runtime.hmm.recover()
  expect(view()).toEqual(recovered)
  expect(queued()).toHaveLength(1)
  await h.restart()
  await h.runtime.idle()
  expect(notices()).toHaveLength(1)
  expect(queued()).toHaveLength(0)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  await h.restart()
  await h.runtime.idle()
  expect(notices()).toHaveLength(1)
  await expect(oldReport.execute({ action: 'checkpoint', frame: 'STALE_FRAME' },
    { signal: new AbortController().signal })).rejects.toThrow()
  for (const nodeId of ['left', 'right'])
    h.runtime.hmm.apply(controller, ticketId, view().revision, { action: 'resume', nodeId })
  h.runtime.hmm.apply(controller, ticketId, view().revision, { action: 'dispatch' })
  await h.runtime.idle()
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches + 2)
  expect(node('left').sessionId).not.toBe(oldSession)
  expect(node('saved').resultRef).toBe(savedRef)
  expect(h.runtime.hmm.context(controller, ticketId, 'left').frame).toBe('PRIVATE_CHECKPOINT')
})

it('已允许派发但尚未启动的任务在重启后通知恢复，不消耗执行次数', async () => {
  await h.runtime.effects.drain()
  const response = await h.api('POST', 'tasks', { requestId: 'queued-recovery', goal: 'Resume queued work', mode: 'single' })
  expect(response.status).toBe(200)
  const ticketId = response.body.ticketId as string
  await h.restart()
  await h.runtime.idle()
  const workflow = h.runtime.hmm.view({ role: 'controller' }, ticketId)
  expect(workflow.autoRun).toBe(false)
  expect(workflow.nodes.filter(node => node.mode === 'task')).toMatchObject([{ state: 'pending', attempt: 0 }])
  expect(h.relays(h.runtime.masterId).filter(item =>
    item.reasonCode === 'host_interrupted' && item.ticket_id === ticketId)).toHaveLength(1)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each(['prepared', 'held', 'awaiting-validation', 'completed', 'stopped'] as const)(
  '%s 任务重启不误报为需要恢复的中断任务',
  async state => {
    const controller = { role: 'controller' as const }
    const response = await h.api('POST', 'tasks', {
      requestId: `no-recovery-${state}`, goal: 'Respect deliberate task boundaries', mode: 'single', dispatch: state !== 'prepared',
    })
    expect(response.status).toBe(200)
    const ticketId = response.body.ticketId as string
    const view = () => h.runtime.hmm.view(controller, ticketId)
    await h.runtime.idle()
    if (state === 'held') h.runtime.hmm.apply(controller, ticketId, view().revision, { action: 'hold' })
    if (state === 'stopped') expect(await h.api('POST', `tickets/${ticketId}/stop`)).toMatchObject({ status: 200 })
    if (state === 'awaiting-validation' || state === 'completed') {
      const node = view().nodes.find(node => node.mode === 'task')!
      const context = await h.runTool(node.sessionId!, 'hmm_node_context', {})
      await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: 'Done', evidenceRefs: [context.inputRef] })
      await h.runtime.idle()
      if (state === 'completed') h.runtime.hmm.apply(controller, ticketId, view().revision, {
        action: 'validate', summary: 'Accepted', evidenceRefs: [view().nodes.find(item => item.id === node.id)!.resultRef!],
      })
    }
    await h.runtime.idle()
    const launches = h.nodeFactory.mock.calls.length
    await h.restart()
    await h.runtime.idle()
    expect(h.relays(h.runtime.masterId).filter(item =>
      item.reasonCode === 'host_interrupted' && item.ticket_id === ticketId)).toHaveLength(0)
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  },
)

it('本地目标直接建立 HMM 工单，贯通三阶段验收到完成且不启动仓库执行器', async () => {
  const request = { requestId: 'local-001', goal: '梳理后端任务主流程' }
  const created = await h.api('POST', 'tasks', request)
  expect(created).toMatchObject({ status: 200, body: { created: true, workflow: { autoRun: true, runnable: ['analyze'] } } })
  const ticketId = created.body.ticketId as string
  const ticket = () => h.runtime.store.tickets.get(ticketId)!
  const view = () => h.runtime.hmm.view({ role: 'controller' }, ticketId)
  const session = (nodeId: string) => view().nodes.find(node => node.id === nodeId)!.sessionId!
  expect(ticket()).toMatchObject({ executionMode: 'hmm', origin: { triggerIds: [expect.any(String)] } })
  expect(ticket().execution).toBeUndefined()
  expect(h.agents.has(`worker-${ticketId}`)).toBe(false)
  await h.runtime.idle()

  expect(await h.api('POST', 'tasks', request)).toMatchObject({ status: 200, body: { created: false, ticketId } })
  expect((await h.api('POST', 'tasks', { ...request, goal: '另一个目标' })).status).toBe(409)

  const analysis = await h.runTool(session('analyze'), 'hmm_node_context', {})
  await h.runTool(session('analyze'), 'hmm_node_report', { action: 'complete', summary: '明确任务输入与交付边界', evidenceRefs: [analysis.inputRef] })
  await h.runtime.idle()
  const analysisRef = view().nodes.find(node => node.id === 'analyze')!.resultRef!
  const execution = await h.runTool(session('execute'), 'hmm_node_context', {})
  expect(execution.dependencies).toMatchObject([{ nodeId: 'analyze' }])
  await h.runTool(session('execute'), 'hmm_node_report', { action: 'complete', summary: '按边界完成主流程', evidenceRefs: [analysisRef] })
  await h.runtime.idle()
  const executionRef = view().nodes.find(node => node.id === 'execute')!.resultRef!
  await h.runTool(session('evaluate'), 'hmm_node_report', {
    action: 'complete', summary: '主流程完整，等待总管确认', evidenceRefs: [analysisRef, executionRef],
  })
  await h.runtime.idle()
  expect(view()).toMatchObject({ awaitingValidation: true, phase: 'active' })
  const resultRef = view().nodes.find(node => node.id === 'evaluate')!.resultRef!
  const accepted = await h.api('POST', `tickets/${ticketId}/hmm/commands`, { revision: view().revision,
    command: { action: 'validate', summary: '目标已完成', evidenceRefs: [resultRef] } })
  expect(accepted).toMatchObject({ status: 200, body: { phase: 'validated', revision: view().revision } })
  expect(view()).toMatchObject({ phase: 'validated', autoRun: false })
  expect(ticket().ended?.outcome).toBe('completed')
  expect(h.agents.has(`worker-${ticketId}`)).toBe(false)
  const page = await h.api('GET', `tickets/${ticketId}`)
  expect(page).toMatchObject({ status: 200, body: { state: 'ended', sessionId: '', environment: [], summary: '目标已完成' } })
  expect((page.body.assignments as { ref?: string }[]).every(item => item.ref === undefined)).toBe(true)
  expect(await h.api('POST', 'tasks', request)).toMatchObject({ status: 200, body: {
    created: false, ticketId, ended: { outcome: 'completed' },
  } })
  expect(h.nodeFactory).toHaveBeenCalledTimes(3)
})

it('本地创建拒绝无效输入和身份注入，并遵守用户暂停状态', async () => {
  const request = { requestId: 'local-input', goal: '目标' }
  for (const input of [{}, { ...request, requestId: '../escape' }, { ...request, requestId: 'x'.repeat(129) },
    { ...request, goal: ' ' }, { ...request, goal: 'x'.repeat(2001) },
    { ...request, title: '' }, { ...request, actor: { id: 'alice' } }, { ...request, executionMode: 'shell' }]) {
    expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 400 })
  }
  expect(h.runtime.store.tickets.list()).toEqual([])
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, paused: true })
  expect(await h.api('POST', 'tasks', request)).toMatchObject({ status: 409, body: { code: 'paused' } })
  h.runtime.store.saveSettings(settings)
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('真实部署检查失败时拒绝本地目标，不写入工单或启动节点', async () => {
  await h.stop()
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { ...settings.sources, github: {
      ...settings.sources.github!, config: { ...settings.sources.github!.config, cli: '' },
    } } })
  })
  expect(h.runtime.configured()).toBe(false)
  expect(h.runtime.setupProblem?.code).toBe('agentCliUnset')
  expect(await h.api('POST', 'tasks', { requestId: 'setup-blocked', goal: '不能跳过宿主初始化' }))
    .toMatchObject({ status: 409, body: { code: 'runtime_unavailable' } })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.triggers.get(key('local-trigger', 'setup-blocked'))).toBeUndefined()
  expect(h.runtime.store.decisions.get(key('local-decision', 'setup-blocked'))).toBeUndefined()
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('创建计划失败回滚工单、决策及效果，同一请求可在修复后提交', async () => {
  const request = { requestId: 'local-rollback', goal: '必须完整创建' }
  const run = vi.spyOn(h.runtime.hmm, 'run').mockImplementationOnce(() => { throw new Error('计划创建失败') })
  expect(await h.api('POST', 'tasks', request)).toMatchObject({ status: 500 })
  run.mockRestore()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.triggers.get(key('local-trigger', request.requestId))).toBeUndefined()
  expect(h.runtime.store.decisions.get(key('local-decision', request.requestId))).toBeUndefined()
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(await h.api('POST', 'tasks', request)).toMatchObject({ status: 200, body: { created: true } })
})

it('本地任务停止撤销节点凭据，重复请求不复活工单或启动仓库会话', async () => {
  const request = { requestId: 'local-stop', goal: '允许停止' }
  const response = await h.api('POST', 'tasks', request)
  const ticketId = response.body.ticketId as string
  await h.runtime.idle()
  const view = () => h.runtime.hmm.view({ role: 'controller' }, ticketId)
  const sessionId = view().nodes.find(node => node.id === 'analyze')!.sessionId!
  const report = h.tools.get(sessionId)!.get('hmm_node_report')!
  expect(await h.api('POST', `tickets/${ticketId}/stop`)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(view()).toMatchObject({ autoRun: false })
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  await expect(report.execute({ action: 'complete', summary: '迟到报告', evidenceRefs: [] },
    { signal: new AbortController().signal })).rejects.toThrow()
  expect(await h.api('POST', 'tasks', request)).toMatchObject({ status: 200, body: { created: false, ended: { outcome: 'stopped' } } })
  h.runtime.executor.resume()
  await h.runtime.idle()
  expect(h.agents.has(`worker-${ticketId}`)).toBe(false)
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)
})

it('本地授权不能通过来源消息伪造，新增上下文仅通知总管且不启动仓库执行器', async () => {
  const { body } = await h.api('POST', 'tasks', { requestId: 'local-context', goal: '明确边界' })
  const ticketId = body.ticketId as string
  const ticket = h.runtime.store.tickets.get(ticketId)!
  const policy = settingsPolicy(h.runtime.store.settings(), h.runtime.sources)
  expect(policy.revalidate(ticket.mandate)).toBe(true)
  expect(policy.revalidate({ ...ticket.mandate, actor: { source: 'github', id: 'operator' } })).toBe(false)
  const trigger = h.runtime.store.triggers.get(ticket.origin.triggerId)!
  const thread = h.runtime.store.threads.get(`local:local-context`)!
  expect(policy.gate(trigger, thread, [ticket])).toMatchObject({ admissible: false })
  h.runtime.engine.note(ticketId, '补充信息，等待总管决定是否调整')
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_task_inputs', ticket_id: ticketId,
    read: `ticket/${ticketId}/inputs` }))
  expect(h.agents.has(`worker-${ticketId}`)).toBe(false)
  expect(h.runtime.hmm.view({ role: 'controller' }, ticketId).goal).toBe('明确边界')
})

it('目标入口自动贯通分析、执行和评价，等待总管验收后才能交付', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 分析任务并给出方案'))
  const controller = { role: 'controller' as const }
  const view = () => h.runtime.hmm.view(controller, ticket.id)
  const session = (nodeId: string) => view().nodes.find(node => node.id === nodeId)!.sessionId!
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/run`, { goal: '比较方案并说明取舍' }))
    .toMatchObject({ status: 200, body: { goal: '比较方案并说明取舍', maxActive: 1, autoRun: true, runnable: ['analyze'] } })
  await h.runtime.idle()
  expect(view().nodes.filter(node => node.state === 'running').map(node => node.id)).toEqual(['root', 'analyze'])
  const analysis = await h.runTool(session('analyze'), 'hmm_node_context', {})
  expect(analysis.dependencies).toEqual([])
  await h.runTool(session('analyze'), 'hmm_node_report', {
    action: 'complete', summary: '先列出候选，再以成本和缺失信息比较', evidenceRefs: [analysis.inputRef],
  })
  await h.runtime.idle()
  const execution = await h.runTool(session('execute'), 'hmm_node_context', {})
  const analysisRef = view().nodes.find(node => node.id === 'analyze')!.resultRef!
  expect(execution.dependencies).toEqual([{ nodeId: 'analyze', resultRefs: [analysisRef] }])
  expect(await h.runTool(session('execute'), 'hmm_result_read', { ref: analysisRef }))
    .toMatchObject({ result: { summary: '先列出候选，再以成本和缺失信息比较' } })
  await h.runTool(session('execute'), 'hmm_node_report', {
    action: 'complete', summary: '候选方案甲与乙的成本取舍', evidenceRefs: [analysisRef],
  })
  await h.runtime.idle()
  const evaluation = await h.runTool(session('evaluate'), 'hmm_node_context', {})
  expect(evaluation.dependencies).toMatchObject([{ nodeId: 'analyze' }, { nodeId: 'execute' }])
  const executionRef = view().nodes.find(node => node.id === 'execute')!.resultRef!
  await h.runTool(session('evaluate'), 'hmm_node_report', {
    action: 'complete', summary: '已覆盖比较要求，事实仍按假设表述', evidenceRefs: [analysisRef, executionRef],
  })
  await h.runtime.idle()
  expect(view()).toMatchObject({ phase: 'active', awaitingValidation: true, referenceIntegrity: 'valid' })
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(h.nodeFactory).toHaveBeenCalledTimes(3)
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_review', ticket_id: ticket.id }))
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '交付方案' })).rejects.toThrow('尚未验收')
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/commands`, { revision: view().revision,
    command: { action: 'validate', summary: '按目标核对三阶段成果',
      evidenceRefs: [view().nodes.find(node => node.id === 'evaluate')!.resultRef!] } }))
    .toMatchObject({ status: 200, body: { phase: 'validated' } })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '交付已验收方案' })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('总管可从目标启动，执行缺资料时挂起并恢复，重核时复用未受影响的分析', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 求解目标'))
  const controller = { role: 'controller' as const }
  const view = () => h.runtime.hmm.view(controller, ticket.id)
  const session = (nodeId: string) => view().nodes.find(node => node.id === nodeId)!.sessionId!
  const command = (command: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'hmm_apply', {
    ticket_id: ticket.id, revision: view().revision, command,
  })
  expect(await h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, goal: '明确可执行方案' }))
    .toMatchObject({ autoRun: true, runnable: ['analyze'] })
  await h.runtime.idle()
  const analysisSession = session('analyze')
  const analysis = await h.runTool(analysisSession, 'hmm_node_context', {})
  await h.runTool(analysisSession, 'hmm_node_report', { action: 'complete', summary: '按授权资料求解',
    evidenceRefs: [analysis.inputRef] })
  await h.runtime.idle()
  const oldExecution = session('execute')
  await h.runTool(oldExecution, 'hmm_node_report', { action: 'suspend', reason: '缺少必要资料' })
  await h.runtime.idle()
  expect(view().nodes.find(node => node.id === 'evaluate')!.state).toBe('pending')
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_attention', node_id: 'execute' }))
  await command({ action: 'resume', nodeId: 'execute' })
  await h.runtime.idle()
  expect(session('execute')).not.toBe(oldExecution)
  const analysisRef = view().nodes.find(node => node.id === 'analyze')!.resultRef!
  await h.runTool(session('execute'), 'hmm_node_report', { action: 'complete', summary: '给出有条件方案',
    evidenceRefs: [analysisRef] })
  await h.runtime.idle()
  const oldEvaluation = session('evaluate')
  const stale = h.tools.get(oldEvaluation)!.get('hmm_node_report')!
  expect(await command({ action: 'recheck', nodeId: 'execute', reason: '方案需重新核对' }))
    .toMatchObject({ rechecked: ['execute', 'evaluate'] })
  await h.runtime.idle()
  expect(view()).toMatchObject({ autoRun: false, awaitingValidation: false, runnable: ['execute'] })
  expect(view().nodes.find(node => node.id === 'analyze')).toMatchObject({
    state: 'completed', sessionId: analysisSession, resultRef: analysisRef, attempt: 1,
  })
  await command({ action: 'dispatch' })
  await h.runtime.idle()
  expect(await h.runTool(session('execute'), 'hmm_node_context', {}))
    .toMatchObject({ dependencies: [{ nodeId: 'analyze', resultRefs: [analysisRef] }] })
  expect(await h.runTool(session('execute'), 'hmm_result_read', { ref: analysisRef }))
    .toMatchObject({ result: { summary: '按授权资料求解' } })
  await expect(stale.execute({ action: 'complete', summary: '迟到评价', evidenceRefs: [analysisRef] },
    { signal: new AbortController().signal })).rejects.toThrow('失效')
})

it('启动入口校验输入且拒绝覆盖已有计划', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 保留计划'))
  const path = `tickets/${ticket.id}/hmm/run`
  for (const input of [{}, { goal: '  ' }, { goal: 'x'.repeat(2001) }, { goal: '目标', extra: true }]) {
    expect(await h.api('POST', path, input)).toMatchObject({ status: 400 })
    expect(h.runtime.store.get(KV.hmm.workflow(ticket.id))).toBeUndefined()
  }
  for (const input of [{}, { goal: '目标', plan }]) {
    await expect(h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, ...input }))
      .rejects.toThrow('必须且只能')
  }
  await h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, plan })
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(ticket.id))
  expect(await h.api('POST', path, { goal: '新目标' })).toMatchObject({ status: 409, body: { code: 'workflow_exists' } })
  await expect(h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, goal: '新目标' })).rejects.toThrow('已有计划')
  await h.runtime.idle()
  expect(h.runtime.store.get(KV.hmm.workflow(ticket.id))).toEqual(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('设备取证、断言提交、总管逐条复核及撤权经过同一个运行宿主', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 查设备排期'))
  const controller = { role: 'controller' as const }
  const view = () => h.runtime.hmm.view(controller, ticket.id)
  const text = 'Delivery: November 8.'
  const contentHash = createHash('sha256').update(text).digest('hex')
  attachKnowledgeDevice(h.ctx, { id: 'phone', label: 'Test phone', domains: ['files'], route: 'direct' }, {
    query: async () => ({ hits: [{ sourceId: 'file:1', version: '1', contentHash, title: 'Schedule',
      domain: 'files', observedAt: '2026-11-02T00:00:00.000Z', totalChars: text.length, sensitivity: 'personal' }], truncated: false }),
    read: async request => ({ version: '1', contentHash, offset: request.offset, totalChars: text.length,
      text: text.slice(request.offset, request.offset + request.length) }),
  })
  expect(await h.api('GET', 'hmm/devices')).toMatchObject({ status: 200, body: { devices: [{ id: 'phone', connected: true }] } })
  h.runtime.hmm.create(controller, ticket.id, {
    ...plan, nodes: plan.nodes.map(node => node.id === 'check' ? { ...node, evidenceRequired: true, claimsRequired: true } : node),
  })
  const grant = { id: 'phone-files', nodeId: 'check', deviceId: 'phone', domain: 'files' }
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/device-grants`, { revision: view().revision, grant }))
    .toMatchObject({ status: 200, body: { grant: { includeRestricted: false } } })
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/device-grants`, { revision: 1, grant }))
    .toMatchObject({ status: 409 })
  h.runtime.hmm.apply(controller, ticket.id, view().revision, { action: 'dispatch' })
  await h.runtime.idle()
  const nodeSession = view().nodes.find(node => node.id === 'check')!.sessionId!
  const context = await h.runTool(nodeSession, 'hmm_node_context', {})
  expect(context.deviceGrants).toEqual([expect.objectContaining({ id: 'phone-files' })])
  expect(context.claimsRequired).toBe(true)
  expect(await h.runTool(nodeSession, 'hmm_claims', {})).toMatchObject({ total: 0, nodes: [] })
  await expect(h.runTool(nodeSession, 'hmm_node_report', { action: 'review_claims', reviews: [] })).rejects.toThrow()
  const result = await h.runTool(nodeSession, 'hmm_device_query', { grantId: 'phone-files' })
  const handle = (result.hits as { handle: string }[])[0]!.handle
  const evidence = await h.runTool(nodeSession, 'hmm_device_read', { handle })
  expect(evidence).toMatchObject({ kind: 'device_snapshot', text })
  await expect(h.runTool(nodeSession, 'hmm_device_read', { handle, nodeId: 'other' })).rejects.toThrow()
  await h.runTool(nodeSession, 'hmm_node_report', { action: 'complete', summary: '设备片段记载 11 月 8 日交付',
    evidenceRefs: [evidence.ref], claims: [{ id: 'delivery', subject: 'Delivery', predicate: 'scheduled_date',
      object: 'November 8', kind: 'extracted', evidenceRefs: [evidence.ref] }] })
  await h.runtime.idle()
  const catalog = await h.runTool(h.runtime.masterId, 'hmm_evidence', {
    ticket_id: ticket.id, node_id: 'check', request: { action: 'query' },
  })
  const doc = (catalog.hits as { id: string; version: string; kind: string }[])[0]!
  expect(doc.kind).toBe('device_snapshot')
  const review = await h.runTool(h.runtime.masterId, 'hmm_evidence', {
    ticket_id: ticket.id, node_id: 'check', request: { action: 'read', id: doc.id, version: doc.version },
  })
  expect(review.text).toBe(text)
  const graph = await h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: ticket.id, view: 'claims' })
  const claim = (graph.nodes as { ref: string }[])[0]!
  expect(graph).toMatchObject({ total: 1, nodes: [{ kind: 'extracted', referenceIntegrity: 'valid', review: null }] })
  expect(await h.api('GET', `tickets/${ticket.id}/hmm/claims?limit=1`)).toMatchObject({ status: 200, body: graph })
  const validation = { action: 'validate', summary: '检查读取片段及其引用',
    evidenceRefs: [h.runtime.hmm.context(controller, ticket.id, 'check').resultRef!] }
  await expect(h.runTool(h.runtime.masterId, 'hmm_apply', {
    ticket_id: ticket.id, revision: view().revision, command: validation,
  })).rejects.toThrow('未复核')
  const command = { action: 'review_claims', reviews: [{ ref: claim.ref, verdict: 'accept', reason: '已核对授权原文片段' }] }
  await expect(h.runTool(sessionId, 'hmm_apply', { revision: view().revision, command })).rejects.toThrow()
  await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: ticket.id, revision: view().revision, command })
  await h.runTool(h.runtime.masterId, 'hmm_apply', {
    ticket_id: ticket.id, revision: view().revision, command: validation,
  })
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/device-grants/phone-files/revoke`, { revision: view().revision }))
    .toMatchObject({ status: 200 })
  expect(await h.api('GET', `tickets/${ticket.id}/hmm/claims`)).toMatchObject({ status: 200,
    body: { nodes: [{ referenceIntegrity: 'invalid', review: { verdict: 'accept' } }] } })
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '完成' })).rejects.toThrow('撤回')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
})

it('总管与工单工具可按授权查设备，但没有授权写入或设备注册工具', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 等待设备'))
  h.runtime.hmm.create({ role: 'controller' }, ticket.id, plan)
  await h.api('POST', `tickets/${ticket.id}/hmm/device-grants`, { revision: 1,
    grant: { id: 'local', nodeId: 'check', deviceId: 'phone', domain: 'files' } })
  await expect(h.runTool(sessionId, 'hmm_evidence', {
    node_id: 'check', request: { action: 'device_query', grantId: 'local' },
  })).rejects.toThrow('未连接')
  for (const id of [sessionId, h.runtime.masterId]) {
    expect([...h.tools.get(id)!.keys()]).not.toContain('hmm_device_attach')
    await expect(h.runTool(id, 'hmm_evidence', {
      ticket_id: ticket.id, node_id: 'check', request: { action: 'device_grant', deviceId: 'root' },
    })).rejects.toThrow()
  }
})

it('DSH 工具、管理 HTTP、SQLite 和完成检查形成同一闭环', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 核验目标'))
  expect(h.tools.get(sessionId)?.has('hmm_plan_create')).toBe(false)
  const created = await h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, plan })
  expect(created).toMatchObject({ revision: 1, runnable: ['check'] })
  expect(await h.api('GET', `tickets/${ticket.id}/hmm`)).toMatchObject({ status: 200, body: { revision: 1 } })
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '完成' })).rejects.toThrow('尚未验收')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  const started = await h.runTool(sessionId, 'hmm_apply', { revision: 1, command: { action: 'start', nodeId: 'check' } })
  expect(started.lease).toEqual(expect.any(String))
  const context = await h.runTool(sessionId, 'hmm_read', { node_id: 'check' })
  await h.runTool(sessionId, 'hmm_apply', {
    revision: started.revision,
    command: { action: 'complete', nodeId: 'check', lease: started.lease, summary: '核验通过', evidenceRefs: [context.inputRef] },
  })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_review', ticket_id: ticket.id }))
  await expect(h.runTool(sessionId, 'hmm_apply', { revision: 3,
    command: { action: 'validate', summary: '自行验收', evidenceRefs: ['x'] } })).rejects.toThrow()
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/commands`, { revision: 3,
    command: { action: 'validate', summary: '依据符合要求',
      evidenceRefs: [h.runtime.hmm.context({ role: 'controller' }, ticket.id, 'check').resultRef] } }))
    .toMatchObject({ status: 200, body: { phase: 'validated' } })
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs).toContainEqual(expect.objectContaining({ kind: 'note',
    text: expect.stringContaining('已验收') }))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '完成核验' })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('已绑定执行器不能指定其他工单，HTTP 冲突响应不更改已有状态', async () => {
  const a = await h.acceptedTicket(feishu('1', '@bot 第一项'))
  const b = await h.acceptedTicket(feishu('2', '@bot 第二项'))
  await h.api('POST', `tickets/${a.ticket.id}/hmm`, plan)
  await h.api('POST', `tickets/${b.ticket.id}/hmm`, plan)
  await expect(h.runTool(a.sessionId, 'hmm_read', { ticket_id: b.ticket.id })).rejects.toThrow('其他工单')
  await expect(h.runTool(a.sessionId, 'hmm_apply', { ticket_id: b.ticket.id, revision: 1,
    command: { action: 'start', nodeId: 'check' } })).rejects.toThrow('其他工单')
  await h.api('POST', `tickets/${a.ticket.id}/hmm/commands`, { revision: 1, command: { action: 'start', nodeId: 'check' } })
  const before = h.runtime.store.get(KV.hmm.workflow(a.ticket.id))
  expect(await h.api('POST', `tickets/${a.ticket.id}/hmm/commands`, { revision: 1,
    command: { action: 'suspend', nodeId: 'check', reason: '过期修改' } })).toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(h.runtime.store.get(KV.hmm.workflow(a.ticket.id))).toEqual(before)
  expect(await h.api('GET', `tickets/${a.ticket.id}/hmm/nodes/check`)).toMatchObject({ status: 200, body: { nodeId: 'check' } })
  expect(await h.api('POST', `tickets/${a.ticket.id}/hmm/commands`, { revision: 2,
    command: { action: 'checkpoint', nodeId: 'check', lease: 'forged', frame: 'invalid' } }))
    .toMatchObject({ status: 409, body: { code: 'lease_stale' } })
  await h.api('POST', `tickets/${a.ticket.id}/stop`)
  expect(h.runtime.hmm.context({ role: 'controller' }, a.ticket.id, 'check').state).toBe('suspended')
  expect(await h.api('POST', `tickets/${a.ticket.id}/hmm/commands`, { revision: 2,
    command: { action: 'suspend', nodeId: 'check', reason: '停止后修改' } })).toMatchObject({ status: 409, body: { code: 'ticket_inactive' } })
})

it('没有 HMM 计划的上游工单保持原完成行为', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 普通任务'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '普通任务完成' })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})

it('管理端导入片段，独立 DSH 节点实际取证，总管核对后交付', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 核验交付日期'))
  const controller = { role: 'controller' as const }
  const view = () => h.runtime.hmm.view(controller, ticket.id)
  const input = { ...plan, nodes: plan.nodes.map(node => node.id === 'check' ? { ...node, evidenceRequired: true } : node) }
  await h.runTool(h.runtime.masterId, 'hmm_plan_create', { ticket_id: ticket.id, plan: input })
  const imported = await h.api('POST', `tickets/${ticket.id}/hmm/evidence`, { revision: view().revision,
    document: { id: 'schedule', title: '排期', origin: '人工导入的消息片段', text: '项目交付时间为 11 月 8 日。', nodeIds: ['check'] } })
  expect(imported.status).toBe(200)
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/evidence`, { revision: 1,
    document: { id: 'schedule', title: '冲突', origin: '人工导入', text: '不应覆盖', nodeIds: ['check'] } }))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: ticket.id, revision: view().revision, command: { action: 'dispatch' } })
  await h.runtime.idle()
  const nodeSession = view().nodes.find(node => node.id === 'check')!.sessionId!
  const revision = view().revision
  const empty = await h.runTool(nodeSession, 'hmm_evidence_query', { text: '项目 日期 交付' })
  expect(empty).toMatchObject({ hits: [], hint: expect.any(String) })
  expect(await h.runTool(h.runtime.masterId, 'hmm_evidence', { ticket_id: ticket.id, node_id: 'check',
    request: { action: 'query', text: '项目 日期 交付' } })).toEqual(empty)
  const metadata = await h.runTool(nodeSession, 'hmm_evidence_query', {})
  expect(metadata.hits).toHaveLength(1)
  expect(view().revision).toBe(revision)
  const hit = (metadata.hits as { id: string; version: string }[])[0]!
  await expect(h.runTool(nodeSession, 'hmm_evidence_read', { ...hit, node_id: 'another' })).rejects.toThrow()
  const evidence = await h.runTool(nodeSession, 'hmm_evidence_read', { id: hit.id, version: hit.version })
  expect(evidence.text).toBe('项目交付时间为 11 月 8 日。')
  expect(h.tools.get(nodeSession)?.has('hmm_plan_create')).toBe(false)
  await h.runTool(nodeSession, 'hmm_node_report', { action: 'complete', summary: '导入片段将交付时间记为 11 月 8 日。',
    evidenceRefs: [evidence.ref] })
  await h.runtime.idle()
  expect(view()).toMatchObject({ awaitingValidation: true, referenceIntegrity: 'valid' })
  const review = await h.runTool(h.runtime.masterId, 'hmm_evidence', { ticket_id: ticket.id, node_id: 'check',
    request: { action: 'read', id: hit.id, version: hit.version } })
  expect(review.text).toBe(evidence.text)
  const resultRef = h.runtime.hmm.context(controller, ticket.id, 'check').resultRef!
  await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: ticket.id, revision: view().revision,
    command: { action: 'validate', summary: '结论准确表达所提供片段，未核验片段外部真实性', evidenceRefs: [resultRef] } })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '已核验所提供排期片段' })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  expect(await h.api('POST', `tickets/${ticket.id}/hmm/evidence/schedule/revoke`, { revision: view().revision })).toMatchObject({ status: 200 })
  expect(() => h.runtime.hmm.assertReady(ticket.id)).toThrow('撤回')
})
