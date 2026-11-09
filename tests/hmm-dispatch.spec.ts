import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { agentEvents, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { HMM_LIMITS, type HmmCommand, type PlanInput } from '../src/hmm/model.ts'
import { HMM_FINISH_TIMEOUT_MS, HMM_PRESET } from '../src/executor/hmm-dsh.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host, ticketId: string, parentId: string
const plan = (maxActive = 2): PlanInput => ({
  goal: '独立比较两条路径再合并',
  maxActive,
  nodes: [
    { id: 'root', mode: 'parallel', title: '主线' },
    { id: 'a', parentId: 'root', title: '甲', instruction: 'A_PRIVATE_INSTRUCTION' },
    { id: 'b', parentId: 'root', title: '乙', instruction: 'B_PRIVATE_INSTRUCTION' },
    { id: 'c', parentId: 'root', title: '汇总', instruction: '只根据两条结果汇总', dependsOn: ['a', 'b'] },
  ],
})
beforeEach(async () => {
  h = await startRuntime()
  const accepted = await h.acceptedTicket(feishu('1', '@bot 逐项核验'))
  ticketId = accepted.ticket.id; parentId = accepted.sessionId
})
afterEach(async () => { vi.useRealTimers(); await h.stop() })
const view = () => h.runtime.hmm.view({ role: 'controller' }, ticketId)
const command = (input: HmmCommand) => h.runtime.hmm.apply({ role: 'controller' }, ticketId, view().revision, input)
const session = (nodeId: string) => view().nodes.find(node => node.id === nodeId)!.sessionId!
const report = async (nodeId: string, summary = `${nodeId}_RESULT`) => {
  const context = await h.runTool(session(nodeId), 'hmm_node_context', {})
  return h.runTool(session(nodeId), 'hmm_node_report', { action: 'complete', summary, evidenceRefs: [context.inputRef] })
}
async function dispatch(input = plan()) {
  h.runtime.hmm.create({ role: 'controller' }, ticketId, input)
  command({ action: 'dispatch' })
  await h.runtime.idle()
}

it('管理端预览不取消执行，正式修订释放旧会话并从新骨架重新派发', async () => {
  await dispatch()
  const a = session('a'), b = session('b'), aHandle = h.owned.get(a)!, bHandle = h.owned.get(b)!
  const oldReport = h.tools.get(a)!.get('hmm_node_report')!
  const oldContext = await h.runTool(a, 'hmm_node_context', {})
  const definition = await h.api('GET', `tickets/${ticketId}/hmm/plan`)
  expect(definition).toMatchObject({ status: 200, body: { planVersion: 1 } })
  const request = definition.body as { revision: number; plan: PlanInput }
  request.plan.nodes[1]!.instruction = 'A_REVISED_INSTRUCTION'
  // 读取定义还含派生元数据；写入只传声明契约允许的字段。
  const body = { revision: request.revision, plan: request.plan, reason: 'Correct assumption' }
  const preview = await h.api('POST', `tickets/${ticketId}/hmm/revisions`, { ...body, preview: true })
  expect(preview).toMatchObject({ status: 200, body: { applied: false, invalidated: ['a', 'b', 'c'] } })
  await h.runtime.idle()
  expect(aHandle.dispose).not.toHaveBeenCalled()
  expect(bHandle.dispose).not.toHaveBeenCalled()
  expect(await h.api('POST', `tickets/${ticketId}/hmm/revisions`, body))
    .toMatchObject({ status: 200, body: { applied: true, planVersion: 2 } })
  await h.runtime.idle()
  expect(aHandle.dispose).toHaveBeenCalledOnce()
  expect(bHandle.dispose).toHaveBeenCalledOnce()
  expect(view().autoRun).toBe(false)
  await expect(oldReport.execute({ action: 'complete', summary: 'Late old result', evidenceRefs: [oldContext.inputRef] },
    { signal: new AbortController().signal })).rejects.toThrow('失效')
  expect(await h.api('POST', `tickets/${ticketId}/hmm/revisions`, body)).toMatchObject({ status: 409 })
  command({ action: 'dispatch' }); await h.runtime.idle()
  expect(session('a')).not.toBe(a)
  expect(await h.runTool(session('a'), 'hmm_node_context', {}))
    .toMatchObject({ planVersion: 2, instruction: 'A_REVISED_INSTRUCTION' })
  const delivered = h.deliveries.mock.calls.map(([entry]) => entry).find(entry => entry.sessionId === session('a'))!
  expect(delivered.text).toContain('A_REVISED_INSTRUCTION')
  expect(delivered.text).not.toContain('A_PRIVATE_INSTRUCTION')
})

it('创建相互独立的节点会话，前缀相同且不复制父会话或兄弟私有输入', async () => {
  await dispatch()
  const a = session('a'), b = session('b')
  expect(a).not.toBe(b)
  expect(h.nodeFactory).toHaveBeenCalledTimes(2)
  for (const [options] of h.nodeFactory.mock.calls) {
    expect(options.meta?.agentPreset).toBe(HMM_PRESET)
    expect(options.seed).toBeUndefined()
    expect(options.meta?.parentSession).toBeUndefined()
    expect(options.agentOptions).toMatchObject({ provider: 'test', model: 'fake', maxTokens: 4096 })
  }
  expect(h.agentPresets.mount.mock.calls.map(([, id]) => id)).toEqual([HMM_PRESET, HMM_PRESET])
  const first = h.deliveries.mock.calls.map(([delivery]) => delivery).find(item => item.sessionId === a)!
  const second = h.deliveries.mock.calls.map(([delivery]) => delivery).find(item => item.sessionId === b)!
  expect(first.text).toContain('A_PRIVATE_INSTRUCTION')
  expect(first.text).not.toContain('B_PRIVATE_INSTRUCTION')
  expect(second.text).not.toContain('A_PRIVATE_INSTRUCTION')
  expect(first.text).not.toContain('@bot')
  expect(h.promptSections.get(a)).toEqual(h.promptSections.get(b))
  expect(JSON.stringify(h.promptSections.get(a))).not.toContain('PRIVATE_INSTRUCTION')
  expect(h.masks.get(a)).toEqual([{ allow: [] }])
  expect([...h.tools.get(a)!.keys()].sort()).toEqual(['hmm_claims', 'hmm_device_query', 'hmm_device_read',
    'hmm_evidence_query', 'hmm_evidence_read', 'hmm_node_context', 'hmm_node_report', 'hmm_result_read'])
  await expect(h.runTool(a, 'bash', { command: 'anything' })).rejects.toThrow('仅能')
  await expect(h.runTool(a, 'hmm_node_context', { node_id: 'b' })).rejects.toThrow()
})

it('自动推进依赖，接收结构化结果，释放会话，最后通知总管验收', async () => {
  await dispatch()
  const a = session('a'), b = session('b')
  const aHandle = h.owned.get(a)!
  await report('a')
  await h.runtime.idle()
  expect(aHandle.dispose).toHaveBeenCalledOnce()
  expect(h.agents.has(a)).toBe(false)
  expect(session('c')).toBeUndefined()
  expect(h.agents.has(b)).toBe(true)
  await report('b'); await h.runtime.idle()
  const c = session('c')
  expect(h.agents.has(c)).toBe(true)
  const input = h.deliveries.mock.calls.map(([item]) => item).find(item => item.sessionId === c)!.text
  expect(input.match(/a_RESULT/g)).toHaveLength(1)
  expect(input.match(/b_RESULT/g)).toHaveLength(1)
  const context = await h.runTool(c, 'hmm_node_context', {}) as ReturnType<typeof h.runtime.hmm.executionContext>
  const summaries = await Promise.all(context.sourceResults.map((item: { ref: string }) =>
    h.runTool(c, 'hmm_result_read', { ref: item.ref })))
  expect(summaries).toMatchObject([{ result: { summary: 'a_RESULT' } }, { result: { summary: 'b_RESULT' } }])
  expect(input).not.toContain('PRIVATE_INSTRUCTION')
  await report('c'); await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(view().awaitingValidation).toBe(true)
  expect(view().phase).toBe('active')
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_review', ticket_id: ticketId }))
})

it('剪枝只取消对应节点，迟到的原始工具回调也不能回写', async () => {
  await dispatch()
  const a = session('a'), b = session('b')
  const aHandle = h.owned.get(a)!, bHandle = h.owned.get(b)!
  const staleReport = h.tools.get(a)!.get('hmm_node_report')!
  const drains = h.subagents.service.drainDescendants.mock.calls.length
  command({ action: 'prune', nodeId: 'a', reason: '路径不可行', reconsiderWhen: '条件改变后' })
  await h.runtime.idle()
  expect(aHandle.dispose).toHaveBeenCalledOnce()
  expect(bHandle.agent.cancel).not.toHaveBeenCalled()
  expect(h.agents.has(b)).toBe(true)
  expect(h.subagents.service.drainDescendants).toHaveBeenCalledTimes(drains)
  await expect(staleReport.execute({ action: 'complete', summary: '迟到结果', evidenceRefs: ['stale'] },
    { signal: new AbortController().signal })).rejects.toThrow('失效')
  expect(view().nodes.find(node => node.id === 'a')?.state).toBe('pruned')
})

it('HMM 和已有工单共享并发预算，释放普通工单槽后才启动节点', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  await dispatch()
  expect(h.nodeFactory).not.toHaveBeenCalled()
  const parent = h.agents.get(parentId)!
  parent.status = 'idle'
  h.ctx.emit('agent/status', { agent: parent, status: 'idle' } as never)
  await vi.waitFor(() => expect(h.runtime.hmmDispatcher.activeCount()).toBe(1))
  await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)
  expect(view().nodes.find(node => node.id === 'b')?.state).toBe('pending')
  await report('a'); await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
  expect(session('b')).toBeTruthy()
})

it('单计划上限独立生效，重复调度不会重复投递同一节点', async () => {
  await dispatch(plan(1))
  await h.runtime.pump(); await h.runtime.idle()
  command({ action: 'dispatch' }); await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)
  expect(h.deliveries.mock.calls.filter(([item]) => item.sessionId === session('a'))).toHaveLength(1)
})

it('启动期间被剪枝的节点不得发布会话或向模型投递', async () => {
  const gate = Promise.withResolvers<void>()
  h.hooks.nodeCreate = gate.promise
  h.runtime.hmm.create({ role: 'controller' }, ticketId, plan(1))
  command({ action: 'dispatch' })
  await vi.waitFor(() => expect(h.nodeFactory).toHaveBeenCalledOnce())
  const old = session('a')
  command({ action: 'prune', nodeId: 'a', reason: '撤销当前路径', reconsiderWhen: '新证据出现' })
  gate.resolve()
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.some(([item]) => item.sessionId === old)).toBe(false)
  expect(h.agents.has(old)).toBe(false)
  expect(h.agents.has(session('b'))).toBe(true)
})

it('启动失败后挂起并通知总管，不自动循环创建会话', async () => {
  h.hooks.nodeFailure = true
  await dispatch(plan(1))
  const attempts = h.nodeFactory.mock.calls.length
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.nodeFactory).toHaveBeenCalledTimes(attempts)
  expect(view().nodes.filter(node => ['a', 'b'].includes(node.id)).every(node => node.state === 'suspended')).toBe(true)
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_attention' }))
})

it('无结构化结果的空闲节点只挂起，不伪造完成', async () => {
  await dispatch(plan(1))
  const agent = h.agents.get(session('a'))!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: 'suspended', reason: expect.stringContaining('未提交') })
  expect(view().phase).toBe('active')
})

it('超时取消在途节点，后续必须显式恢复', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await dispatch()
  await vi.advanceTimersByTimeAsync(HMM_LIMITS.nodeTimeoutMs + 1)
  await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(view().nodes.filter(node => ['a', 'b'].includes(node.id)).every(node => node.state === 'suspended')).toBe(true)
  expect(view().nodes.find(node => node.id === 'a')?.reason).toContain('超时')
})

it('hold、恢复和再次派发使用新会话，只继承自己的检查点', async () => {
  await dispatch(plan(1))
  const old = session('a')
  await h.runTool(old, 'hmm_node_report', { action: 'checkpoint', frame: 'OWN_CHECKPOINT' })
  command({ action: 'hold' }); await h.runtime.idle()
  expect(view().autoRun).toBe(false)
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  command({ action: 'resume', nodeId: 'a' })
  command({ action: 'dispatch' }); await h.runtime.idle()
  const fresh = session('a')
  expect(fresh).not.toBe(old)
  expect(h.deliveries.mock.calls.find(([item]) => item.sessionId === fresh)?.[0].text).toContain('OWN_CHECKPOINT')
  const reopened = h.nodeFactory.mock.calls.find(([options]) => options.sessionId === fresh)![0]
  expect(reopened.seed).toBeUndefined()
})

it('DSH 实例丢失不丢失节点状态，恢复后使用新会话，旧回调不能回写', async () => {
  const input = plan(1)
  await dispatch({ ...input, nodes: input.nodes.slice(0, 2) })
  const oldId = session('a')
  const old = h.owned.get(oldId)!
  const staleReport = h.tools.get(oldId)!.get('hmm_node_report')!
  await h.runTool(oldId, 'hmm_node_report', { action: 'checkpoint', frame: 'DURABLE_NODE_FRAME' })
  await old.dispose()
  await h.runtime.idle()
  expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: 'suspended', attempt: 1 })
  command({ action: 'resume', nodeId: 'a' })
  command({ action: 'dispatch' })
  await h.runtime.idle()
  const freshId = session('a')
  expect(freshId).not.toBe(oldId)
  expect(h.deliveries.mock.calls.find(([item]) => item.sessionId === freshId)?.[0].text).toContain('DURABLE_NODE_FRAME')
  await expect(staleReport.execute({ action: 'checkpoint', frame: 'STALE_FRAME' },
    { signal: new AbortController().signal })).rejects.toThrow('失效')
})

it('Session 已创建后投递准备失败会释放句柄，不遗留失效执行或自动重放', async () => {
  const before = h.controller.rename.mock.calls.length
  h.controller.rename.mockRejectedValueOnce(new Error('模拟投递准备失败'))
  const input = plan(1)
  await dispatch({ ...input, nodes: input.nodes.slice(0, 2) })
  const node = view().nodes.find(node => node.id === 'a')!
  expect(node).toMatchObject({ state: 'suspended', attempt: 1 })
  expect(h.controller.rename).toHaveBeenCalledTimes(before + 1)
  expect(h.agents.has(node.sessionId!)).toBe(false)
  expect(h.owned.has(node.sessionId!)).toBe(false)
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it.each(['prepare', 'delivery'] as const)('%s 失败后的清理失败仍保留句柄与额度，退避回收不重放模型输入', async phase => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  const original = h.nodeFactory.getMockImplementation()!
  const failure = { code: 'AUTH', message: 'PRIVATE_START_DIAGNOSTIC' }
  let handle: AgentHandle | undefined, disposals = 0
  h.nodeFactory.mockImplementationOnce(async options => {
    handle = await original(options)
    const dispose = handle.dispose.bind(handle)
    handle.dispose = vi.fn(async () => {
      if (++disposals === 1) throw new Error('PRIVATE_CLEANUP_DIAGNOSTIC')
      await dispose()
    })
    if (phase === 'delivery') vi.spyOn(handle.agent, 'followup').mockImplementationOnce(() => { throw failure })
    return handle
  })
  if (phase === 'prepare') h.controller.rename.mockRejectedValueOnce(failure)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await dispatch(plan(1))
    const failedId = session('a')
    expect([...h.agents.keys()].filter(id => id.startsWith('hmm-'))).toHaveLength(h.runtime.hmmDispatcher.activeCount())
    expect(view().nodes.find(node => node.id === 'a')).toMatchObject({
      state: 'suspended', attempt: 1, modelFailureCode: 'AUTH',
    })
    expect(JSON.stringify(view())).not.toContain('PRIVATE_')
    expect(h.nodeFactory).toHaveBeenCalledOnce()
    expect(view().nodes.find(node => node.id === 'b')).toMatchObject({ state: 'pending', attempt: 0 })
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    expect(h.agents.has(failedId)).toBe(true)
    expect(h.owned.has(failedId)).toBe(true)
    await expect(h.runTool(failedId, 'hmm_node_context', {})).rejects.toThrow('失效')
    const queued = h.runtime.store.db.prepare(
      "SELECT attempts, due FROM effect WHERE kind = 'hmmDispatch' AND key = ?",
    ).get(`retire:${failedId}`)!
    expect(queued.attempts).toBe(1)
    await h.runtime.pump(); await h.runtime.idle()
    expect(disposals).toBe(1)
    expect(h.nodeFactory).toHaveBeenCalledOnce()

    vi.setSystemTime(Number(queued.due))
    await h.runtime.pump(); await h.runtime.idle()
    expect(disposals).toBe(2)
    expect(h.agents.has(failedId)).toBe(false)
    expect(h.owned.has(failedId)).toBe(false)
    expect(h.nodeFactory).toHaveBeenCalledTimes(2)
    expect(session('b')).not.toBe(failedId)
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: 'suspended', attempt: 1 })
    expect(h.deliveries.mock.calls.some(([item]) => item.sessionId === failedId)).toBe(false)
  } finally {
    vi.useRealTimers()
    if (handle && h.agents.has(handle.agent.id)) await handle.dispose()
  }
})

it.each(['complete', 'suspend'] as const)('真实工具运行时保留 %s 回执，回合结束前不取消执行或释放槽位', async action => {
  const input = plan(1)
  await dispatch({ ...input, nodes: input.nodes.slice(0, 2) })
  const id = session('a'), handle = h.owned.get(id)!, agent = h.agents.get(id)!
  const context = await h.runTool(id, 'hmm_node_context', {})
  const signal = new AbortController()
  const idle = () => {
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent: handle.agent, status: 'idle' } as never)
  }
  agent.cancel.mockImplementation(() => { signal.abort(); idle() })
  const native = new Context()
  try {
    await native.plugin(SystemPrompt)
    await native.plugin(ToolRuntime)
    native.tools.register(h.tools.get(id)!.get('hmm_node_report')! as ToolDefinition)
    const execute = (args: unknown) => native.tools.execute({
      name: 'hmm_node_report', callId: `report-${action}` as ToolCallId,
      arguments: args, signal: signal.signal,
    })
    expect(await execute({ action: 'checkpoint', frame: '保留当前进展' }))
      .toMatchObject({ isError: false })
    const rejected = await execute({ action: 'complete', summary: '无效依据', evidenceRefs: ['unknown'] })
    expect(rejected).toMatchObject({ isError: true })
    expect(rejected).not.toHaveProperty('concludesTurn')
    expect(view().nodes.find(node => node.id === 'a')?.state).toBe('running')
    const result = await execute(action === 'complete'
      ? { action, summary: '已完成核验', evidenceRefs: [context.inputRef] }
      : { action, reason: '缺少进一步资料' })
    expect(result).toMatchObject({ isError: false, concludesTurn: true })
    expect(signal.signal.aborted).toBe(false)
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(handle.dispose).not.toHaveBeenCalled()
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    idle()
    await h.runtime.idle()
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
    expect(view().nodes.find(node => node.id === 'a')?.state).toBe(action === 'complete' ? 'completed' : 'suspended')
  } finally { idle(); await native.fiber.dispose() }
})

it('必需依据在投递后失效，真实工具拒绝完成但仍允许保存进度和挂起', async () => {
  const actor = { role: 'controller' as const }, input = plan()
  input.nodes.push({ id: 'independent', parentId: 'root', title: '独立工作', instruction: '不使用研究结果' })
  h.runtime.hmm.create(actor, ticketId, input)
  const document = h.runtime.hmm.importEvidence(actor, ticketId, view().revision, {
    id: 'source', title: '资料', origin: '操作者输入', text: '原始资料', nodeIds: ['a'],
  }).document
  const first = command({ action: 'start', nodeId: 'a' })
  const receipt = h.runtime.hmm.readEvidence(actor, ticketId, 'a', { id: document.id, version: document.version })
  command({ action: 'complete', nodeId: 'a', lease: first.lease!, summary: '上游成果', evidenceRefs: [receipt.ref] })
  const second = command({ action: 'start', nodeId: 'b' })
  command({ action: 'complete', nodeId: 'b', lease: second.lease!, summary: '独立比较',
    evidenceRefs: [h.runtime.hmm.context(actor, ticketId, 'b').inputRef!] })
  command({ action: 'dispatch' })
  await h.runtime.idle()
  const id = session('c'), handle = h.owned.get(id)!, agent = h.agents.get(id)!
  const context = await h.runTool(id, 'hmm_node_context', {})
  const idle = () => {
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent: handle.agent, status: 'idle' } as never)
  }
  const native = new Context()
  try {
    await native.plugin(SystemPrompt)
    await native.plugin(ToolRuntime)
    native.tools.register(h.tools.get(id)!.get('hmm_node_report')! as ToolDefinition)
    const execute = (args: unknown) => native.tools.execute({
      name: 'hmm_node_report', callId: 'invalid-dependency-report' as ToolCallId,
      arguments: args, signal: new AbortController().signal,
    })
    h.runtime.hmm.revokeEvidence(actor, ticketId, view().revision, document.id)
    const revision = view().revision
    const rejected = await execute({ action: 'complete', summary: '缺少有效上游仍提交', evidenceRefs: [context.inputRef] })
    expect(rejected).toMatchObject({ isError: true })
    expect(rejected).not.toHaveProperty('concludesTurn')
    expect(view().revision).toBe(revision)
    expect(view().nodes.find(node => node.id === 'c')).toMatchObject({ state: 'running', attempt: 1 })
    expect(handle.agent.cancel).not.toHaveBeenCalled()
    expect(handle.dispose).not.toHaveBeenCalled()
    expect(await execute({ action: 'checkpoint', frame: '等待重新取得上游依据' })).toMatchObject({ isError: false })
    await report('independent')
    await h.runtime.idle()
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    expect(await execute({ action: 'suspend', reason: '必需资料已失效' }))
      .toMatchObject({ isError: false, concludesTurn: true })
    expect(handle.dispose).not.toHaveBeenCalled()
    idle()
    await h.runtime.idle()
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
    expect(view().nodes.find(node => node.id === 'c')).toMatchObject({ state: 'suspended', attempt: 1 })
    expect(view().nodes.find(node => node.id === 'independent')?.state).toBe('completed')
  } finally { idle(); await native.fiber.dispose() }
})

it('最终报告的回合结束等待有上限，超时释放会话且不重跑已提交结果', async () => {
  const input = plan(1)
  await dispatch({ ...input, nodes: input.nodes.slice(0, 2) })
  const id = session('a'), handle = h.owned.get(id)!
  const context = await h.runTool(id, 'hmm_node_context', {})
  const idle = vi.spyOn(handle.agent, 'whenIdle')
  vi.useFakeTimers()
  await h.tools.get(id)!.get('hmm_node_report')!.execute({
    action: 'complete', summary: '已提交', evidenceRefs: [context.inputRef],
  }, { signal: new AbortController().signal, concludeTurn: vi.fn() })
  await vi.waitFor(() => expect(idle).toHaveBeenCalled())
  expect(handle.dispose).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(HMM_FINISH_TIMEOUT_MS)
  await h.runtime.idle()
  expect(handle.dispose).toHaveBeenCalledOnce()
  expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: 'completed', attempt: 1 })
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it('操作者停单立即打断最终报告的结束等待，不必等到宽限超时', async () => {
  const input = plan(1)
  await dispatch({ ...input, nodes: input.nodes.slice(0, 2) })
  const id = session('a'), handle = h.owned.get(id)!
  const context = await h.runTool(id, 'hmm_node_context', {})
  const idle = vi.spyOn(handle.agent, 'whenIdle')
  await h.tools.get(id)!.get('hmm_node_report')!.execute({
    action: 'complete', summary: '已提交', evidenceRefs: [context.inputRef],
  }, { signal: new AbortController().signal, concludeTurn: vi.fn() })
  await vi.waitFor(() => expect(idle).toHaveBeenCalled())
  expect(handle.agent.cancel).not.toHaveBeenCalled()
  await h.api('POST', `tickets/${ticketId}/stop`)
  await h.runtime.idle()
  expect(handle.agent.cancel).toHaveBeenCalled()
  expect(handle.dispose).toHaveBeenCalledOnce()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(h.runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('stopped')
})

it('恢复会关闭自动执行，不重放未完成或尚未启动的节点', async () => {
  await dispatch(plan(1))
  const old = session('a'), created = h.nodeFactory.mock.calls.length
  h.runtime.hmm.recover()
  await h.runtime.idle()
  expect(view().autoRun).toBe(false)
  expect(h.agents.has(old)).toBe(false)
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.nodeFactory).toHaveBeenCalledTimes(created)
  expect(view().nodes.find(node => node.id === 'a')?.state).toBe('suspended')
  expect(view().nodes.find(node => node.id === 'b')?.state).toBe('pending')
})

it('工单停止会释放所有节点；无权通过节点工具操作其他工单', async () => {
  await dispatch()
  const a = session('a')
  await expect(h.runTool(a, 'hmm_node_report', { action: 'complete', ticket_id: 'other', nodeId: 'b',
    summary: '越界', evidenceRefs: ['x'] })).rejects.toThrow()
  await h.api('POST', `tickets/${ticketId}/stop`)
  await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(view().autoRun).toBe(false)
  expect(h.owned.size).toBe(0)
})

it.each(['started', 'failed'] as const)('普通工单启动准备尚未结束时仍占共享槽；准备%s后重新核算容量', async outcome => {
  const gate = Promise.withResolvers<void>()
  h.hooks.prepare = gate.promise
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'reservation-gate' } })
  const accepting = h.acceptedTicket(feishu('reserved-worker', '@bot 准备期间也应占用容量'))
  try {
    await vi.waitFor(() => expect(h.subprocess.spawn.mock.calls.some(([spec]) =>
      spec.argv.includes('reservation-gate'))).toBe(true), { timeout: 5000 })
    expect(h.runtime.executor.activeCount()).toBe(1)
    h.runtime.hmm.create({ role: 'controller' }, ticketId, plan(2))
    command({ action: 'dispatch' })
    await vi.waitFor(() => expect(h.nodeFactory.mock.calls.length).toBeGreaterThan(0))
    // 一个运行工单、一个启动预留，只剩一个 HMM 槽；不能把未取得 Agent 的预留当作空闲。
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    expect(h.runtime.executor.slotUsage()).toEqual({ running: 1, occupied: 2 })
    expect(await h.api('GET', 'state')).toMatchObject({ status: 200, body: {
      load: { running: 1, occupied: 3, maxWorkers: 3 },
    } })
    if (outcome === 'failed') gate.reject(new Error('Synthetic prepare failure'))
    else gate.resolve()
    await accepting
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(outcome === 'failed' ? 2 : 1)
    expect(h.runtime.executor.activeCount() + h.runtime.hmmDispatcher.activeCount()).toBeLessThanOrEqual(3)
  } finally {
    gate.resolve()
    await accepting
    h.hooks.prepare = undefined
  }
})

it.each(['started', 'failed'] as const)('唤醒预留也占共享槽；唤醒%s后按实际占用重排，失败释放后不等其他事件', async outcome => {
  await h.acceptedTicket(feishu('other-running', '@bot 保留一个运行工单'))
  const parent = h.agents.get(parentId)!
  parent.status = 'idle'
  h.ctx.emit('agent/status', { agent: parent, status: 'idle' } as never)
  await h.runtime.idle()
  const gate = Promise.withResolvers<void>()
  let held = false
  h.controller.resolveAgent.mockImplementation(async id => {
    if (id === parentId && !held) { held = true; await gate.promise }
    return h.resolveDefault(id)
  })
  try {
    h.runtime.engine.note(ticketId, 'Review a new bounded input')
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 5000 })
    expect(h.runtime.executor.slotUsage()).toEqual({ running: 1, occupied: 2 })
    h.runtime.hmm.create({ role: 'controller' }, ticketId, plan(2))
    command({ action: 'dispatch' })
    await vi.waitFor(() => expect(h.nodeFactory.mock.calls.length).toBeGreaterThan(0))
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    if (outcome === 'failed') gate.reject(new Error('Synthetic wake failure'))
    else gate.resolve()
    await h.runtime.idle()
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(outcome === 'failed' ? 2 : 1)
    expect(h.runtime.executor.slotUsage().occupied + h.runtime.hmmDispatcher.activeCount()).toBe(3)
  } finally {
    gate.resolve()
    await h.runtime.idle()
    h.controller.resolveAgent.mockImplementation(h.resolveDefault)
  }
})

it('原工单执行器也会扣除 HMM 槽，不能从另一方向超额派发', async () => {
  await dispatch()
  const other = await h.acceptedTicket(feishu('2', '@bot 另一项普通任务'))
  expect(h.agents.has(other.sessionId)).toBe(false)
  expect(h.runtime.executor.activeCount() + h.runtime.hmmDispatcher.activeCount()).toBe(3)
  await report('a'); await h.runtime.idle()
  expect(h.agents.has(other.sessionId)).toBe(true)
  expect(h.runtime.executor.activeCount() + h.runtime.hmmDispatcher.activeCount()).toBeLessThanOrEqual(3)
})

it('模型步数达到预算后拒绝继续调用模型并挂起节点', async () => {
  await dispatch(plan(1))
  const agent = h.owned.get(session('a'))!.agent
  const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
  for (let step = 1; step <= HMM_LIMITS.nodeSteps + 1; step++) {
    await agentEvents(agent.ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step, signal: new AbortController().signal,
    }, next)
  }
  expect(next).toHaveBeenCalledTimes(HMM_LIMITS.nodeSteps)
  expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: 'suspended', reason: expect.stringContaining('步数') })
})

it('预设装配期间取消，发布前校验仍会阻止模型启动', async () => {
  const gate = Promise.withResolvers<void>()
  h.agentPresets.mount.mockImplementationOnce(async () => gate.promise)
  h.runtime.hmm.create({ role: 'controller' }, ticketId, plan(1))
  command({ action: 'dispatch' })
  await vi.waitFor(() => expect(h.agentPresets.mount).toHaveBeenCalledOnce())
  const old = session('a')
  command({ action: 'prune', nodeId: 'a', reason: '装配期间撤销', reconsiderWhen: '重新核验后' })
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.some(([item]) => item.sessionId === old)).toBe(false)
  expect(h.agents.has(old)).toBe(false)
  gate.resolve()
  await h.runtime.idle()
  expect(h.agents.has(old)).toBe(false)
})

it.each((['rename', 'history', 'flush'] as const).flatMap(stage =>
  (['prune', 'hold', 'shutdown'] as const).map(action => ({ stage, action }))))(
  '$stage 启动等待未结束时 $action 仍能回收，迟到完成不重放旧执行', async ({ stage, action }) => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let pending: Promise<unknown> | undefined
  let shutdown: Promise<void> | undefined
  const wait = () => {
    entered.resolve()
    return gate.promise
  }
  if (stage === 'rename') h.controller.rename.mockImplementationOnce(() => pending = wait())
  else if (stage === 'history') {
    const open = vi.mocked(h.ctx.sessionPersistence.open).getMockImplementation()!
    let delayed = false
    vi.spyOn(h.ctx.sessionPersistence, 'open').mockImplementation((...args) => {
      if (delayed || !String(args[0]).startsWith('hmm-')) return open(...args)
      delayed = true
      const opening = (async () => { await wait(); return open(...args) })()
      pending = opening
      return opening
    })
  } else {
    const create = h.nodeFactory.getMockImplementation()!
    h.nodeFactory.mockImplementationOnce(async options => {
      const handle = await create(options), followup = handle.agent.followup.bind(handle.agent)
      vi.spyOn(handle.agent, 'followup').mockImplementationOnce(message => {
        followup(message)
        vi.spyOn(h.ctx.sessionPersistence, 'flush').mockImplementationOnce(() => pending = wait())
      })
      return handle
    })
  }
  try {
    h.runtime.hmm.create({ role: 'controller' }, ticketId, plan(1))
    command({ action: 'dispatch' })
    await entered.promise
    const old = session('a'), handle = h.owned.get(old)!
    const staleReport = h.tools.get(old)!.get('hmm_node_report')!
    expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: 'running', attempt: 1 })
    expect(h.deliveries.mock.calls.filter(([item]) => item.sessionId === old)).toHaveLength(stage === 'flush' ? 1 : 0)
    expect(handle.dispose).not.toHaveBeenCalled()
    if (action === 'prune') command({ action: 'prune', nodeId: 'a', reason: '撤销当前路径', reconsiderWhen: '条件改变后' })
    else if (action === 'hold') command({ action: 'hold' })
    else shutdown = h.runtime.hmmDispatcher.shutdown()
    await vi.waitFor(() => expect(handle.dispose).toHaveBeenCalledOnce())
    await shutdown
    await h.runtime.idle()
    expect(h.owned.has(old)).toBe(false)
    expect(h.agents.has(old)).toBe(false)
    expect(handle.agent.cancel).toHaveBeenCalled()
    expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: action === 'prune' ? 'pruned' : 'suspended', attempt: 1 })
    expect(view().nodes.find(node => node.id === 'b')).toMatchObject({
      state: action === 'prune' ? 'running' : 'pending', attempt: action === 'prune' ? 1 : 0,
    })
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(action === 'prune' ? 1 : 0)
    if (action !== 'prune') expect(view().autoRun).toBe(false)
    if (action === 'hold') {
      command({ action: 'resume', nodeId: 'a' })
      command({ action: 'dispatch' })
      await h.runtime.idle()
      expect(session('a')).not.toBe(old)
      expect(view().nodes.find(node => node.id === 'a')).toMatchObject({ state: 'running', attempt: 2 })
    }
    const before = view(), created = h.nodeFactory.mock.calls.length
    // 迟到成功与失败都不能重放旧输入，或改变已经提交的业务状态。
    if (action === 'prune') gate.reject(new Error('LATE_DSH_FAILURE'))
    else gate.resolve()
    await pending?.catch(() => {})
    await h.runtime.idle()
    expect(view()).toEqual(before)
    expect(h.nodeFactory).toHaveBeenCalledTimes(created)
    expect(h.deliveries.mock.calls.filter(([item]) => item.sessionId === old)).toHaveLength(stage === 'flush' ? 1 : 0)
    await expect(staleReport.execute({ action: 'checkpoint', frame: 'STALE_FRAME' },
      { signal: new AbortController().signal })).rejects.toThrow('失效')
  } finally {
    gate.resolve()
    await pending?.catch(() => {})
    await shutdown
    await h.runtime.idle()
  }
})

it.each([
  { stage: 'model', change: 'withdraw', grouped: false },
  { stage: 'preset', change: 'replace', grouped: true },
  { stage: 'delivery', change: 'withdraw', grouped: true },
] as const)('$stage 等待期间必需依据 $change，不投递旧快照且不阻塞独立分支', async ({ stage, change, grouped }) => {
  const actor = { role: 'controller' as const }, input = plan()
  if (grouped) {
    input.nodes[1]!.parentId = 'research'; input.nodes[2]!.parentId = 'research'
    input.nodes[3]!.dependsOn = ['research']
    input.nodes.push({ id: 'research', parentId: 'root', mode: 'parallel', title: '研究组' })
  }
  input.nodes.push({ id: 'independent', parentId: 'root', title: '独立任务', instruction: '独立核验条件' })
  h.runtime.hmm.create(actor, ticketId, input)
  const source = { id: 'memo', title: '依据', origin: '合成资料', text: 'SOURCE_BODY', nodeIds: ['a'] }
  const document = h.runtime.hmm.importEvidence(actor, ticketId, view().revision, source).document
  const first = command({ action: 'start', nodeId: 'a' })
  const receipt = h.runtime.hmm.readEvidence(actor, ticketId, 'a', { id: document.id, version: document.version })
  command({ action: 'complete', nodeId: 'a', lease: first.lease!,
    summary: stage === 'preset' ? `OLD_SOURCE_DERIVED_SUMMARY${'甲'.repeat(1900)}` : 'OLD_SOURCE_DERIVED_SUMMARY',
    evidenceRefs: [receipt.ref] })
  const second = command({ action: 'start', nodeId: 'b' })
  command({ action: 'complete', nodeId: 'b', lease: second.lease!, summary: '独立比较结果',
    evidenceRefs: [h.runtime.hmm.context(actor, ticketId, 'b').inputRef!] })

  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const wait = async () => { entered.resolve(); await gate.promise }
  if (stage === 'model') {
    const resolve = h.ctx.llm.resolveCallConfig.bind(h.ctx.llm)
    vi.spyOn(h.ctx.llm, 'resolveCallConfig').mockImplementationOnce(async (...args) => { await wait(); return resolve(...args) })
  } else if (stage === 'preset') h.agentPresets.mount.mockImplementationOnce(wait)
  else h.controller.rename.mockImplementationOnce(wait)
  try {
    command({ action: 'dispatch' })
    await entered.promise
    const old = session('c')
    if (change === 'withdraw') h.runtime.hmm.revokeEvidence(actor, ticketId, view().revision, document.id)
    else h.runtime.hmm.importEvidence(actor, ticketId, view().revision, source)
    gate.resolve()
    await h.runtime.idle()
    expect(h.deliveries.mock.calls.some(([item]) => item.sessionId === old)).toBe(false)
    expect(h.agents.has(old)).toBe(false)
    expect(h.owned.has(old)).toBe(false)
    expect(view().nodes.find(node => node.id === 'c')).toMatchObject({
      state: 'suspended', attempt: 1, reason: expect.stringContaining('必需成果'),
    })
    expect(view().nodes.find(node => node.id === 'c')?.modelFailureCode).toBeUndefined()
    expect(view().nodes.find(node => node.id === 'independent')?.state).toBe('running')
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
    if (stage === 'model') expect(h.nodeFactory.mock.calls.some(([options]) => options.sessionId === old)).toBe(false)

    if (stage === 'delivery') {
      command({ action: 'recheck', nodeId: 'a', reason: '重新获取有效依据' })
      const fresh = h.runtime.hmm.importEvidence(actor, ticketId, view().revision, source).document
      const next = command({ action: 'start', nodeId: 'a' })
      const current = h.runtime.hmm.readEvidence(actor, ticketId, 'a', { id: fresh.id, version: fresh.version })
      command({ action: 'complete', nodeId: 'a', lease: next.lease!, summary: 'FRESH_SOURCE_DERIVED_SUMMARY', evidenceRefs: [current.ref] })
      command({ action: 'dispatch' })
      await h.runtime.idle()
      expect(session('c')).not.toBe(old)
      expect(view().nodes.find(node => node.id === 'c')?.attempt).toBe(2)
      const delivered = h.deliveries.mock.calls.find(([item]) => item.sessionId === session('c'))![0]
      expect(delivered.text).toContain('FRESH_SOURCE_DERIVED_SUMMARY')
      expect(delivered.text).not.toContain('OLD_SOURCE_DERIVED_SUMMARY')
    }
  } finally { gate.resolve() }
})

it.each(['optional', 'rollback'] as const)('启动等待期间 %s 变化不误伤有效的必需输入', async kind => {
  const actor = { role: 'controller' as const }, input = plan()
  input.nodes[3]!.dependsOn = ['a']
  h.runtime.hmm.create(actor, ticketId, input)
  for (const nodeId of ['a', 'b']) {
    const document = h.runtime.hmm.importEvidence(actor, ticketId, view().revision, {
      id: nodeId, title: '依据', origin: '合成资料', text: `${nodeId}_SOURCE`, nodeIds: [nodeId],
    }).document
    const started = command({ action: 'start', nodeId })
    const receipt = h.runtime.hmm.readEvidence(actor, ticketId, nodeId, { id: document.id, version: document.version })
    command({ action: 'complete', nodeId, lease: started.lease!, summary: `${nodeId}_RESULT`, evidenceRefs: [receipt.ref] })
  }
  command({ action: 'publish', nodeId: 'b' })
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  h.agentPresets.mount.mockImplementationOnce(async () => { entered.resolve(); await gate.promise })
  try {
    command({ action: 'dispatch' })
    await entered.promise
    const before = view()
    if (kind === 'optional') {
      h.runtime.hmm.revokeEvidence(actor, ticketId, before.revision, 'b')
      expect(view().revision).toBeGreaterThan(before.revision)
    } else {
      expect(() => h.runtime.store.atomic(() => {
        h.runtime.hmm.revokeEvidence(actor, ticketId, before.revision, 'a')
        throw new Error('rollback')
      })).toThrow('rollback')
      expect(view()).toEqual(before)
    }
    gate.resolve()
    await h.runtime.idle()
    const id = session('c'), delivered = h.deliveries.mock.calls.filter(([item]) => item.sessionId === id)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]![0].text).toContain('a_RESULT')
    expect(delivered[0]![0].text).not.toContain('b_RESULT')
    expect(view().nodes.find(node => node.id === 'c')?.state).toBe('running')
    expect(h.runtime.hmmDispatcher.activeCount()).toBe(1)
  } finally { gate.resolve() }
})

it('模型配置解析停滞时超时仍能挂起，迟到解析不会创建会话', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const gate = Promise.withResolvers<never>()
  const resolve = vi.spyOn(h.ctx.llm, 'resolveCallConfig')
  resolve.mockImplementation(() => gate.promise)
  h.runtime.hmm.create({ role: 'controller' }, ticketId, plan())
  command({ action: 'dispatch' })
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  await vi.advanceTimersByTimeAsync(HMM_LIMITS.nodeTimeoutMs + 1)
  await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(view().nodes.filter(node => ['a', 'b'].includes(node.id)).every(node => node.state === 'suspended')).toBe(true)
  gate.reject(new Error('迟到的解析失败'))
  await h.runtime.idle()
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('全局暂停只阻止新派发，在途结果可回写且恢复后才能继续', async () => {
  await dispatch(plan(1))
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await report('a'); await h.runtime.idle()
  expect(view().nodes.find(node => node.id === 'a')?.state).toBe('completed')
  expect(view().nodes.find(node => node.id === 'b')?.state).toBe('pending')
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
  await h.runtime.pump(); await h.runtime.idle()
  expect(view().nodes.find(node => node.id === 'b')?.state).toBe('running')
})

it('节点采用执行器配置的模型，不修改宿主默认模型', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: { provider: 'custom', model: 'reasoner' } } })
  await dispatch(plan(1))
  expect(h.nodeFactory.mock.calls[0]![0].agentOptions).toMatchObject({ provider: 'custom', model: 'reasoner' })
  expect(h.controller.selectModel).not.toHaveBeenCalled()
})

it('外层事务回滚剪枝时不取消正在运行的会话', async () => {
  await dispatch(plan(1))
  const handle = h.owned.get(session('a'))!
  expect(() => h.runtime.store.atomic(() => {
    command({ action: 'prune', nodeId: 'a', reason: '随后回滚', reconsiderWhen: '保留' })
    throw new Error('rollback')
  })).toThrow('rollback')
  await h.runtime.idle()
  expect(handle.agent.cancel).not.toHaveBeenCalled()
  expect(view().nodes.find(node => node.id === 'a')?.state).toBe('running')
})

it('旧会话从日志重新打开时不能恢复工具权限或继续模型步骤', async () => {
  await dispatch(plan(1))
  const old = session('a')
  command({ action: 'hold' }); await h.runtime.idle()
  await h.controller.create({ sessionId: old })
  const reopened = h.agents.get(old)!
  await h.ctx.serial('agent/created', { agent: reopened } as never)
  expect(h.guards.get(old)![0]!({ name: 'hmm_node_report', arguments: {} })).toContain('已结束')
  expect(h.masks.get(old)).toContainEqual({ allow: [] })
})

it('重新核验定向取消旧执行和依赖，保留无关兄弟，旧取证入口也失效', async () => {
  await dispatch()
  const a = session('a'), b = session('b')
  const oldRead = h.tools.get(a)!.get('hmm_evidence_query')!
  const sibling = h.agents.get(b)!
  command({ action: 'recheck', nodeId: 'a', reason: '输入条件改变，需要重做' })
  await h.runtime.idle()
  expect(h.agents.has(a)).toBe(false)
  expect(sibling.cancel).not.toHaveBeenCalled()
  expect(view()).toMatchObject({ autoRun: false, runnable: ['a'] })
  await expect(oldRead.execute({}, { signal: new AbortController().signal })).rejects.toThrow('失效')
  command({ action: 'dispatch' }); await h.runtime.idle()
  expect(session('a')).not.toBe(a)
  expect(session('b')).toBe(b)
})
