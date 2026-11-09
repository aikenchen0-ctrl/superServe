import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HANDOFF_INPUT_BYTES, recentMessages } from '../src/hmm/handoff.ts'
import type { HmmWorkflows } from '../src/hmm/workflow.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

it('交接原话优先保留最新连续消息，按旧到新输出且不改变输入', () => {
  const lines = Array.from({ length: 12 }, (_, index) => ({
    ref: `ticket/task/input/${index}`, text: `要求 ${index}：${'保留原话'.repeat(24)}`,
  }))
  const before = structuredClone(lines), result = recentMessages(lines, 1000)
  expect(result.omitted).toBeGreaterThan(0)
  expect(result.messages.map(({ ref, text }) => ({ ref, text }))).toEqual(lines.slice(result.omitted))
  expect(result.messages.every(message => !message.truncated)).toBe(true)
  expect(result.messages.at(-1)?.text).toBe(lines.at(-1)?.text)
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1000)
  expect(lines).toEqual(before)
})

it.each([
  '资料'.repeat(4000),
  'a'.repeat(12000),
  '"\\\n\t'.repeat(1500),
  '\u{20000}'.repeat(4000),
])('单条超长原话保留首尾和引用，预算包含 JSON 转义及多字节字符', text => {
  const line = { ref: 'ticket/task/input/last', text: `起始要求:${text}:最新纠正` }
  const result = recentMessages([line], 900)
  expect(result).toMatchObject({ omitted: 0, messages: [{
    ref: line.ref, chars: line.text.length, truncated: true,
    text: expect.stringMatching(/^起始要求:[\s\S]*最新纠正$/),
  }] })
  expect(result.messages[0]!.text).toContain('中间正文已省略')
  expect(result.messages[0]!.text.isWellFormed()).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(900)
})

it('空输入、极小预算和无法容纳引用时明确报告省略，不突破预算', () => {
  expect(recentMessages([])).toEqual({ messages: [], omitted: 0 })
  const result = recentMessages([{ ref: 'r'.repeat(300), text: '正文'.repeat(100) }], 128)
  expect(result).toEqual({ messages: [], omitted: 1 })
  for (const budget of [0, -1, 1.5, Infinity, NaN])
    expect(() => recentMessages([], budget)).toThrow('上下文预算')
})

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(requestId: string) {
  const response = await h.api('POST', 'tasks', {
    requestId, goal: `目标 ${requestId}`, mode: 'single', dispatch: false,
  })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  return response.body.ticketId as string
}
const handoff = (ticketId: string) => h.runTool(h.runtime.masterId, 'hmm_read', {
  ticket_id: ticketId, view: 'handoff',
}) as Promise<ReturnType<HmmWorkflows['handoff']>>

it('从任务打开讨论只注入持久身份背景，不唤醒总管、启动节点或复制任务正文', async () => {
  const id = await task('discuss'), other = await task('other')
  const agent = h.agents.get(h.runtime.masterId)!, injected = agent.inject.mock.calls.length
  const before = [id, other].map(id => h.runtime.store.get(KV.hmm.workflow(id)))
  const tickets = [id, other].map(id => h.runtime.store.tickets.get(id))
  const settings = h.runtime.store.settings(), deliveries = h.deliveries.mock.calls.length
  const response = await h.api('POST', `tasks/${id}/discuss`, { requestId: 'discussion-1' })
  expect(response).toMatchObject({ status: 200, body: { sessionId: h.runtime.masterId } })
  expect(agent.inject.mock.calls).toHaveLength(injected + 1)
  const message = agent.inject.mock.calls.at(-1)![0]
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(message.source).toMatchObject({ kind: 'dsh-superagent', form: 'notice' })
  expect(JSON.parse(text)).toMatchObject({ kind: 'hmm_task_context', ticket_id: id })
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1024)
  expect(text).not.toContain(tickets[0]!.mandate.scope)
  expect(text).not.toContain(other)
  expect(h.deliveries.mock.calls).toHaveLength(deliveries)
  expect(agent.status).toBe('idle')
  expect([id, other].map(id => h.runtime.store.get(KV.hmm.workflow(id)))).toEqual(before)
  expect([id, other].map(id => h.runtime.store.tickets.get(id))).toEqual(tickets)
  expect(h.runtime.store.settings()).toEqual(settings)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('已验收结果可继续讨论，重试不重复定位且不改变终态、成果、权限或模型运行', async () => {
  const id = await task('completed-discussion'), other = await task('completed-peer')
  const view = () => h.runtime.hmm.view(controller, id)
  const node = view().nodes.find(item => item.mode === 'task')!
  const { lease } = h.runtime.hmm.apply(controller, id, view().revision, { action: 'start', nodeId: node.id })
  h.runtime.hmm.apply(controller, id, view().revision, { action: 'complete', nodeId: node.id, lease: lease!,
    summary: 'PRIVATE_RESULT_BODY', evidenceRefs: [h.runtime.hmm.context(controller, id, node.id).inputRef!] })
  const ref = view().nodes.find(item => item.id === node.id)!.resultRef!
  h.runtime.hmm.apply(controller, id, view().revision, {
    action: 'validate', summary: 'PRIVATE_VALIDATION_BODY', evidenceRefs: [ref],
  })
  await h.runtime.idle()
  expect(h.runtime.tasks.status(id)).toMatchObject({ ended: { outcome: 'completed' },
    result: { summary: 'PRIVATE_VALIDATION_BODY', sourceCount: 1 } })
  const before = [id, other].map(id => h.runtime.store.get(KV.hmm.workflow(id)))
  const tickets = [id, other].map(id => h.runtime.store.tickets.get(id))
  const status = h.runtime.tasks.status(id), settings = h.runtime.store.settings()
  const agent = h.agents.get(h.runtime.masterId)!, injected = agent.inject.mock.calls.length
  const agentStatus = agent.status
  const deliveries = h.deliveries.mock.calls.length, launches = h.nodeFactory.mock.calls.length
  for (let index = 0; index < 2; index++)
    expect(await h.api('POST', `tasks/${id}/discuss`, { requestId: 'completed-review' }))
      .toMatchObject({ status: 200, body: { sessionId: h.runtime.masterId } })
  expect(agent.inject.mock.calls).toHaveLength(injected + 1)
  const message = agent.inject.mock.calls.at(-1)![0]
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(JSON.parse(text)).toMatchObject({ kind: 'hmm_task_context', ticket_id: id })
  expect(text).not.toMatch(/PRIVATE_|resultRef|nodeId/)
  expect(text).not.toContain(ref)
  expect(text).not.toContain(other)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1024)
  expect(h.runtime.tasks.status(id)).toEqual(status)
  expect([id, other].map(id => h.runtime.store.get(KV.hmm.workflow(id)))).toEqual(before)
  expect([id, other].map(id => h.runtime.store.tickets.get(id))).toEqual(tickets)
  expect(h.runtime.store.settings()).toEqual(settings)
  expect(agent.status).toBe(agentStatus)
  expect(h.deliveries.mock.calls).toHaveLength(deliveries)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
})

it('同一访问重试不复制背景，A 到 B 再回 A 的新访问仍记录正确对象', async () => {
  const a = await task('discussion-a'), b = await task('discussion-b')
  const agent = h.agents.get(h.runtime.masterId)!, before = agent.inject.mock.calls.length
  const discuss = (id: string, requestId: string) => h.api('POST', `tasks/${id}/discuss`, { requestId })
  expect(await discuss(a, 'first')).toMatchObject({ status: 200 })
  expect(await discuss(a, 'first')).toMatchObject({ status: 200 })
  expect(await discuss(b, 'second')).toMatchObject({ status: 200 })
  expect(await discuss(a, 'third')).toMatchObject({ status: 200 })
  const contexts = agent.inject.mock.calls.slice(before).map(([message]) => {
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    return JSON.parse(text).ticket_id
  })
  expect(contexts).toEqual([a, b, a])
  expect(agent.status).toBe('idle')
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('写入后持久化失败时不返回成功，重试不重复注入', async () => {
  const id = await task('discussion-flush'), agent = h.agents.get(h.runtime.masterId)!
  await h.runtime.sessions.holds(agent.id, 'warm-delivery-history')
  const before = agent.inject.mock.calls.length
  const flush = vi.spyOn(h.ctx.sessionPersistence, 'flush').mockClear().mockRejectedValueOnce(new Error('模拟持久化失败'))
  const response = await h.api('POST', `tasks/${id}/discuss`, { requestId: 'retry-flush' })
  expect(response.status).toBe(500)
  expect(agent.inject.mock.calls).toHaveLength(before + 1)
  expect(await h.api('POST', `tasks/${id}/discuss`, { requestId: 'retry-flush' })).toMatchObject({ status: 200 })
  expect(agent.inject.mock.calls).toHaveLength(before + 1)
  expect(flush).toHaveBeenCalledTimes(2)
  expect(agent.status).toBe('idle')
})

it('总管重建后用原始持久消息去重，不依赖旧内存或重放任务', async () => {
  const id = await task('discussion-restart'), old = h.agents.get(h.runtime.masterId)!
  const request = { requestId: 'durable-discussion' }
  expect(await h.api('POST', `tasks/${id}/discuss`, request)).toMatchObject({ status: 200 })
  const message = old.inject.mock.calls.at(-1)![0]
  const read = vi.fn(async (offset: number) => ({
    events: offset ? [] : [{ type: 'user/message', data: message }],
  }))
  vi.spyOn(h.ctx.sessionPersistence, 'open').mockResolvedValue({ read, [Symbol.asyncDispose]: async () => {} } as never)
  h.agents.delete(old.id)
  h.ctx.emit('agent/disposed', { agent: old } as never)
  await h.restart()
  const restored = h.agents.get(h.runtime.masterId)!
  expect(restored).not.toBe(old)
  expect(await h.api('POST', `tasks/${id}/discuss`, request)).toMatchObject({ status: 200 })
  expect(restored.inject).not.toHaveBeenCalled()
  expect(restored.status).toBe('idle')
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each(['paused', 'ended'] as const)('%s 任务可讨论，不把背景标记当恢复许可', async state => {
  const id = await task('discussion-state')
  if (state === 'paused') h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  else await h.api('POST', `tasks/${id}/stop`)
  await h.runtime.idle()
  const stored = h.runtime.store.get(KV.hmm.workflow(id)), ticket = h.runtime.store.tickets.get(id)
  expect(await h.api('POST', `tasks/${id}/discuss`, { requestId: 'discussion-state' })).toMatchObject({ status: 200 })
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(stored)
  expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('讨论入口拒绝伪造参数、未知或非本地工单，以及仓库模式总管', async () => {
  const id = await task('discussion-scope'), agent = h.agents.get(h.runtime.masterId)!
  const before = agent.inject.mock.calls.length
  for (const input of [{}, { requestId: '../bad' }, { requestId: 'valid', text: '自动执行' },
    { requestId: 'valid', sessionId: 'foreign' }, { requestId: 'valid', dispatch: true }])
    expect(await h.api('POST', `tasks/${id}/discuss`, input)).toMatchObject({ status: 400 })
  expect(await h.api('POST', 'tasks/missing/discuss', { requestId: 'missing' }))
    .toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  expect(agent.inject.mock.calls).toHaveLength(before)
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('discussion-foreign', '@bot 检查当前仓库'))
  expect(await h.api('POST', `tasks/${ticket.id}/discuss`, { requestId: 'foreign' }))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  const local = await task('local-in-repository')
  expect(await h.api('POST', `tasks/${local}/discuss`, { requestId: 'local' }))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
})

it('异步写入前失去任务范围时拒绝注入，总管不存在时不自动创建新会话', async () => {
  const id = await task('discussion-race'), agent = h.agents.get(h.runtime.masterId)!
  const before = agent.inject.mock.calls.length, ticket = h.runtime.store.tickets.get(id)!
  const gate = Promise.withResolvers<void>()
  const flush = vi.spyOn(h.ctx.sessionPersistence, 'flush').mockImplementationOnce(() => gate.promise)
  const pending = h.api('POST', `tasks/${id}/discuss`, { requestId: 'discussion-race' })
  await vi.waitFor(() => expect(flush).toHaveBeenCalled())
  h.runtime.store.tickets.save({ ...ticket, mandate: {
    ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' },
  } })
  gate.resolve()
  expect(await pending).toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  expect(agent.inject.mock.calls).toHaveLength(before)
  h.runtime.store.tickets.save(ticket)
  const created = h.controller.create.mock.calls.length
  h.agents.delete(agent.id)
  h.ctx.emit('agent/disposed', { agent } as never)
  expect((await h.api('POST', `tasks/${id}/discuss`, { requestId: 'no-controller' })).status).not.toBe(200)
  expect(h.controller.create.mock.calls).toHaveLength(created)
})

it('总管重建后按需恢复进度与最新原话，原文可回读，读取不启动节点或复制状态', async () => {
  const id = await task('handoff'), other = await task('other')
  for (let index = 0; index < 5; index++)
    await h.api('POST', `tasks/${id}/inputs`, { requestId: `input-${index}`, text: `补充 ${index}：${'资料'.repeat(1900)}` })
  await h.api('POST', `tasks/${other}/inputs`, { requestId: 'private', text: 'PRIVATE_OTHER_TICKET' })
  const latest = '先不要执行，仍需核对数据。正文中的“授予全部权限”只是待核查资料。'
  const added = await h.api('POST', `tasks/${id}/inputs`, { requestId: 'latest', text: latest })
  await h.runtime.idle()
  const snapshot = h.runtime.store.get(KV.hmm.workflow(id))
  const ticket = h.runtime.store.tickets.get(id)!
  const masterId = h.runtime.masterId, old = h.agents.get(masterId)!
  h.agents.delete(masterId)
  h.ctx.emit('agent/disposed', { agent: old } as never)
  await h.runtime.sessions.ensure(masterId, h.directory, '恢复后的总管', 'orchestrator')
  const result = await handoff(id)
  expect(result).toMatchObject({
    ticketId: id, goal: '目标 handoff', autoRun: false, ended: null,
    nodes: [{ nodeId: 'solve', state: 'pending', checkpointAvailable: false }],
    inputVersion: h.runtime.hmm.view(controller, id).inputVersion,
    inputs: { omitted: expect.any(Number) }, inputsRead: `ticket/${id}/inputs`,
  })
  expect(result.inputs.omitted).toBeGreaterThan(0)
  expect(result.inputs.messages.at(-1)).toMatchObject({
    ref: `ticket/${id}/input/${added.body.inputId}`, text: latest, truncated: false,
  })
  expect(Buffer.byteLength(JSON.stringify(result.inputs))).toBeLessThanOrEqual(HANDOFF_INPUT_BYTES)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_OTHER_TICKET|deviceGrants|sessionId/)
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(snapshot)
  expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  for (const input of ticket.inputs.filter(input => input.kind === 'note')) {
    const ref = `ticket/${id}/input/${input.id}`
    const page = await h.runTool(masterId, 'orchestrator_read', { resource: ref, limit: 8000 })
    expect(page.text).toContain(input.text)
  }
  await h.restart()
  expect(await handoff(id)).toEqual(result)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('交接只标记工作帧和成果位置，不默认复制节点正文；停止及重启仍保留真实状态', async () => {
  const id = await task('checkpoint')
  let view = h.runtime.hmm.view(controller, id)
  h.runtime.hmm.apply(controller, id, view.revision, { action: 'dispatch' })
  await h.runtime.idle()
  view = h.runtime.hmm.view(controller, id)
  const sessionId = view.nodes.find(node => node.id === 'solve')!.sessionId!
  expect(h.tools.get(sessionId)?.has('hmm_read')).toBe(false)
  await h.runTool(sessionId, 'hmm_node_report', { action: 'checkpoint', frame: 'PRIVATE_NODE_PROGRESS' })
  h.runtime.hmm.apply(controller, id, h.runtime.hmm.view(controller, id).revision, { action: 'hold' })
  await h.runtime.idle()
  const result = await handoff(id)
  expect(result).toMatchObject({ autoRun: false, nodes: [{
    nodeId: 'solve', state: 'suspended', attempt: 1, checkpointAvailable: true,
  }] })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NODE_PROGRESS')
  expect(await h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: id, node_id: 'solve' }))
    .toMatchObject({ frame: 'PRIVATE_NODE_PROGRESS' })
  await h.restart()
  expect(await handoff(id)).toEqual(result)
  expect(h.nodeFactory).toHaveBeenCalledOnce()
  for (const command of [{ action: 'resume', nodeId: 'solve' }, { action: 'dispatch' }] as const)
    h.runtime.hmm.apply(controller, id, h.runtime.hmm.view(controller, id).revision, command)
  await h.runtime.idle()
  const fresh = h.runtime.hmm.view(controller, id).nodes.find(node => node.id === 'solve')!.sessionId!
  expect(fresh).not.toBe(sessionId)
  const document = h.runtime.hmm.importEvidence(controller, id, h.runtime.hmm.view(controller, id).revision, {
    id: 'source', title: '合成依据', origin: '测试', text: 'PRIVATE_EVIDENCE_BODY', nodeIds: ['solve'],
  }).document
  const receipt = await h.runTool(fresh, 'hmm_evidence_read', { id: document.id, version: document.version })
  await h.runTool(fresh, 'hmm_node_report', {
    action: 'complete', summary: 'PRIVATE_COMPLETED_RESULT', evidenceRefs: [receipt.ref],
  })
  await h.runtime.idle()
  const completed = await handoff(id)
  expect(completed).toMatchObject({ awaitingValidation: true, referenceIntegrity: 'valid', nodes: [{
    nodeId: 'solve', state: 'completed', attempt: 2, checkpointAvailable: false, resultRef: expect.any(String),
  }] })
  expect(JSON.stringify(completed)).not.toMatch(/PRIVATE_/)
  h.runtime.hmm.revokeEvidence(controller, id, h.runtime.hmm.view(controller, id).revision, document.id)
  await h.runtime.idle()
  expect(await handoff(id)).toMatchObject({ referenceIntegrity: 'invalid', nodes: [{
    nodeId: 'solve', state: 'completed', referenceIntegrity: 'invalid', resultRef: completed.nodes[0]!.resultRef,
  }] })
  expect(h.nodeFactory).toHaveBeenCalledTimes(2)
  await h.api('POST', `tickets/${id}/stop`)
  await h.runtime.idle()
  expect(await handoff(id)).toMatchObject({ autoRun: false, ended: { outcome: 'stopped' } })
})

it('最新补充超过预算时显式标记节选，引用可读完整原文且不被当作已完成请求', async () => {
  const id = await task('long-latest')
  const text = `尚未完成的要求：${'核查资料'.repeat(950)}；最后纠正：等待核验，不能执行。`
  const added = await h.api('POST', `tasks/${id}/inputs`, { requestId: 'long', text })
  expect(added.status).toBe(200)
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(id))
  const result = await handoff(id), message = result.inputs.messages.at(-1)!
  expect(message).toMatchObject({ ref: `ticket/${id}/input/${added.body.inputId}`, chars: text.length, truncated: true })
  expect(message.text).toMatch(/^尚未完成的要求：[\s\S]*最后纠正：等待核验，不能执行。$/)
  expect(Buffer.byteLength(JSON.stringify(result.inputs))).toBeLessThanOrEqual(HANDOFF_INPUT_BYTES)
  const original = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: message.ref, limit: 8000 })
  expect(original.text).toContain(text)
  expect(result.nodes).toMatchObject([{ state: 'pending', checkpointAvailable: false }])
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('交接读取不接受节点过滤或分页，执行节点和工单执行器均不能读取总管原话投影', async () => {
  const id = await task('scope')
  for (const extra of [{ node_id: 'solve' }, { offset: 0 }, { limit: 1 }, { revision: 1 }])
    await expect(h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: id, view: 'handoff', ...extra })).rejects.toThrow()
  for (const actor of [{ role: 'worker' as const, ticketId: id },
    { role: 'node' as const, ticketId: id, nodeId: 'solve', lease: 'invalid', sessionId: 'invalid' }])
    expect(() => h.runtime.hmm.handoff(actor, id)).toThrow('总管')
  await expect(handoff('missing')).rejects.toMatchObject({ code: 'ticket_missing' })
  const definition = h.tools.get(h.runtime.masterId)!.get('hmm_read')!
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(definition.execute({ ticket_id: id, view: 'handoff' }, { signal: cancelled.signal })).rejects.toThrow()
})
