import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { LOCAL_TASK_INPUT_LIMITS } from '../src/app/local-tasks.ts'
import type { ApiResponse } from '../src/app/api.ts'
import type { HmmCommand } from '../src/hmm/model.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(requestId = 'context') {
  const response = await h.api('POST', 'tasks', { requestId, goal: '比较候选路径，说明各自约束' })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const node = (name: string) => view().nodes.find(item => item.id === name)!
  const ticket = () => h.runtime.store.tickets.get(id)!
  const snapshot = () => h.runtime.store.get(KV.hmm.workflow(id))
  const input = (requestId: string, text: string) => h.api('POST', `tasks/${id}/inputs`, { requestId, text })
  const read = async () => {
    const response = await h.api('GET', `tasks/${id}`)
    expect(response.status).toBe(200)
    return response.body as ApiResponse<'GET tasks/:id'>
  }
  const command = async (command: HmmCommand) => {
    const result = await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: id, revision: view().revision, command })
    await h.runtime.idle()
    return result
  }
  const complete = async (name: string, summary: string) => {
    const context = h.runtime.hmm.context(controller, id, name)
    await h.runTool(node(name).sessionId!, 'hmm_node_report', { action: 'complete', summary,
      evidenceRefs: context.sourceResults.length ? context.sourceResults.map(item => item.ref) : [context.inputRef] })
    await h.runtime.idle()
    return node(name).resultRef!
  }
  return { id, view, node, ticket, snapshot, input, read, command, complete }
}

it.each(['context', 'answer'] as const)('输入%s可按需返回同次保存状态，原文重试返回当前状态且不追加', async kind => {
  const run = await task(`projected-${kind}`)
  h.runtime.hmm.apply(controller, run.id, run.view().revision, { action: 'hold' })
  await h.runtime.idle()
  const question = kind === 'answer' ? h.runtime.tasks.ask(run.id, {
    revision: run.view().revision, question: 'Which source should be used?',
  }).question : undefined
  const payload = { requestId: 'projected-input', text: 'Use the approved source',
    ...(question ? { questionId: question.id } : {}) }
  const headers = { 'x-orchestrator-task-view': 'state' }
  const before = run.ticket().inputs.length, mandate = run.ticket().mandate, grants = run.view().deviceGrants
  const launches = h.nodeFactory.mock.calls.length
  const first = await h.api('POST', `tasks/${run.id}/inputs`, payload, headers)
  expect(first).toMatchObject({ status: 200, body: { ticketId: run.id, created: true, task: {
    ticketId: run.id, question: null, inputs: { total: before + 1 }, workflow: { autoRun: false },
    ...(kind === 'answer' ? { lastAnswer: { inputId: first.body.inputId, answer: { text: payload.text } } }
      : { lastContext: { inputId: first.body.inputId, text: payload.text } }),
  } } })
  await h.runtime.idle()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  const later = await run.input('later-context', 'A later input must stay current')
  expect(later.body).not.toHaveProperty('task')
  await h.runtime.idle()
  const effects = h.runtime.store.db.prepare('SELECT * FROM effect ORDER BY kind, key').all(), inputs = run.ticket().inputs
  const repeated = await h.api('POST', `tasks/${run.id}/inputs`, payload, headers)
  expect(repeated).toMatchObject({ status: 200, body: { inputId: first.body.inputId, created: false, task: {
    paused: true, inputs: { total: before + 2 }, lastContext: { inputId: later.body.inputId },
  } } })
  expect(run.ticket().inputs).toEqual(inputs)
  expect(h.runtime.store.db.prepare('SELECT * FROM effect ORDER BY kind, key').all()).toEqual(effects)
  expect(run.ticket().mandate).toEqual(mandate)
  expect(run.view().deviceGrants).toEqual(grants)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
})

it('输入已保存而状态投影失败时明确返回空投影，重试不追加；保存失败则仍回滚', async () => {
  const run = await task('projection-failure')
  const headers = { 'x-orchestrator-task-view': 'state' }, payload = { requestId: 'projection-failure', text: 'Preserve this input' }
  const read = vi.spyOn(h.runtime.tasks, 'status').mockImplementation(() => { throw new Error('PRIVATE_PROJECTION_ERROR') })
  const first = await h.api('POST', `tasks/${run.id}/inputs`, payload, headers)
  expect(first).toMatchObject({ status: 200, body: { created: true, task: null } })
  expect(JSON.stringify(first)).not.toContain('PRIVATE_PROJECTION_ERROR')
  expect(run.ticket().inputs.find(input => input.id === first.body.inputId)).toMatchObject({ text: payload.text })
  expect(await h.api('POST', `tasks/${run.id}/inputs`, payload, headers))
    .toMatchObject({ status: 200, body: { inputId: first.body.inputId, created: false, task: null } })
  read.mockRestore()
  expect(await h.api('POST', `tasks/${run.id}/inputs`, payload, headers))
    .toMatchObject({ status: 200, body: { created: false, task: { lastContext: { inputId: first.body.inputId } } } })
  await h.runtime.idle()
  const originalNote = h.runtime.engine.note.bind(h.runtime.engine), ticket = run.ticket()
  const effects = h.runtime.store.db.prepare('SELECT * FROM effect ORDER BY kind, key').all()
  vi.spyOn(h.runtime.engine, 'note').mockImplementation((...args) => {
    originalNote(...args)
    throw new Error('save failure')
  })
  expect(await h.api('POST', `tasks/${run.id}/inputs`, { requestId: 'failed-save', text: 'Not committed' }, headers))
    .toMatchObject({ status: 500 })
  expect(run.ticket()).toEqual(ticket)
  expect(h.runtime.store.db.prepare('SELECT * FROM effect ORDER BY kind, key').all()).toEqual(effects)
})

it('补充回执只表示最近保存事实，问答与内部批注不替代它；重放、重启和结束仍可只读核对', async () => {
  const run = await task(), peer = await task('context-receipt-peer')
  expect(await run.read()).not.toHaveProperty('lastContext')
  const first = await run.input('receipt-first', '先核对资料 A')
  await h.runtime.idle()
  const original = run.ticket().inputs.find(item => item.id === first.body.inputId)!
  expect((await run.read()).lastContext).toEqual({
    inputId: original.id, at: original.at, text: '先核对资料 A', truncated: false,
  })
  const second = await run.input('receipt-second', '再核对资料 B')
  const latest = run.ticket().inputs.find(item => item.id === second.body.inputId)!
  const expected = { inputId: latest.id, at: latest.at, text: '再核对资料 B', truncated: false }
  h.runtime.engine.note(run.id, '总管内部批注', 'internal-note')
  const asked = h.runtime.tasks.ask(run.id, { revision: run.view().revision, question: '优先比较哪项？' })
  expect(await h.api('POST', `tasks/${run.id}/inputs`, {
    requestId: 'receipt-answer', questionId: asked.question!.id, text: '优先延迟',
  })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(await run.read()).toMatchObject({ lastContext: expected,
    lastAnswer: { answer: { text: '优先延迟', truncated: false } } })
  expect(await peer.read()).not.toHaveProperty('lastContext')
  await h.api('POST', 'executor/pause', { paused: true })
  await h.restart()
  await h.runtime.idle()
  expect(await run.input('receipt-first', '先核对资料 A')).toMatchObject({ status: 200, body: { created: false } })
  const before = run.ticket(), workflow = run.snapshot()
  const launches = h.nodeFactory.mock.calls.length, deliveries = h.deliveries.mock.calls.length
  expect((await run.read()).lastContext).toEqual(expected)
  expect((await run.read()).lastContext).toEqual(expected)
  expect(run.ticket()).toEqual(before)
  expect(run.snapshot()).toEqual(workflow)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  expect(h.deliveries).toHaveBeenCalledTimes(deliveries)
  await h.api('POST', `tasks/${run.id}/stop`)
  await h.runtime.idle()
  expect(await run.read()).toMatchObject({ ended: { outcome: 'stopped' }, lastContext: expected })
})

it.each(['\u{20000}', '\u0001', '"\\\n'])('长补充回执有界且保留完整码点，原文仍可回读：%j', async sample => {
  const run = await task()
  const text = `补充开头${sample.repeat(900)}补充结尾`
  const response = await run.input('receipt-long', text)
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const before = run.ticket(), workflow = run.snapshot()
  const status = await run.read(), receipt = status.lastContext!
  expect(Object.keys(receipt).sort()).toEqual(['at', 'inputId', 'text', 'truncated'])
  expect(receipt.inputId).toBe(response.body.inputId)
  expect(receipt.truncated).toBe(true)
  expect(Array.from(receipt.text)).toHaveLength(160)
  expect(receipt.text.isWellFormed()).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(receipt), 'utf8')).toBeLessThan(2048)
  expect(JSON.stringify(receipt)).not.toMatch(/deviceGrants|instruction|sessionId|answerTo/)
  expect(receipt.text).not.toContain('补充结尾')
  const original = await h.runTool(h.runtime.masterId, 'orchestrator_read', {
    resource: `ticket/${run.id}/input/${response.body.inputId}`,
  })
  expect(String(original.text).endsWith(text)).toBe(true)
  expect(run.ticket()).toEqual(before)
  expect(run.snapshot()).toEqual(workflow)
})

it.each([159, 160, 161])('补充回执按码点处理 %s 字的边界，截断不改变原始输入', async count => {
  const run = await task(), text = '\u{20000}'.repeat(count)
  expect(await run.input('receipt-boundary', text)).toMatchObject({ status: 200 })
  expect((await run.read()).lastContext).toMatchObject({
    text: count > 160 ? '\u{20000}'.repeat(159) + '…' : text, truncated: count > 160,
  })
  expect(run.ticket().inputs.at(-1)).toMatchObject({ kind: 'note', text })
})

it('补充信息按需送达总管，经显式修订继续执行并验收，不直接改写节点输入', async () => {
  const run = await task()
  const context = h.runtime.hmm.context(controller, run.id, 'analyze')
  const before = run.snapshot(), mandate = run.ticket().mandate
  const text = '补充条件：分别比较延迟和运行成本，不能只按单个指标排序。'.repeat(8)
  const response = await run.input('latency-cost', text)
  expect(response).toMatchObject({ status: 200, body: { ticketId: run.id, created: true } })
  await h.runtime.idle()
  expect(run.snapshot()).toEqual(before)
  expect(run.ticket().mandate).toEqual(mandate)
  expect(h.runtime.hmm.context(controller, run.id, 'analyze')).toEqual(context)
  const notifications = h.relays(h.runtime.masterId).filter(item => item.kind === 'hmm_task_inputs')
  expect(notifications).toContainEqual(expect.objectContaining({ ticket_id: run.id, input_ids: [response.body.inputId] }))
  expect(JSON.stringify(notifications)).not.toContain(text)
  const page = await h.runTool(h.runtime.masterId, 'orchestrator_read', {
    resource: `ticket/${run.id}/input/${response.body.inputId}`,
  })
  expect(page).toMatchObject({ text: expect.stringContaining(text) })
  await run.command({ action: 'hold' })
  const definition = h.runtime.hmm.definition(controller, run.id)
  const request = { ticket_id: run.id, revision: definition.revision, reason: '补齐双指标比较要求',
    nodes: definition.plan.nodes.map(node => node.id === 'analyze' ? { ...node, instruction: text } : node) }
  expect(await h.runTool(h.runtime.masterId, 'hmm_plan_revise', request)).toMatchObject({ applied: false })
  await h.runTool(h.runtime.masterId, 'hmm_plan_revise', { ...request, preview: false })
  await run.command({ action: 'dispatch' })
  expect(h.runtime.hmm.context(controller, run.id, 'analyze').instruction).toBe(text)
  await run.complete('analyze', '确认延迟与运行成本及缺失信息')
  await run.complete('execute', '分别比较两项指标及约束')
  const result = await run.complete('evaluate', '检查比较范围与依据')
  await run.command({ action: 'validate', inputVersion: run.view().inputVersion, summary: '已按补充条件完成比较', evidenceRefs: [result] })
  expect(run.ticket().ended?.outcome).toBe('completed')
})

it('并发重试和重启复用同一输入，不同工单的请求编号相互独立', async () => {
  const run = await task(), other = await task('other-context')
  const text = '只比较现有资源范围内的方案'
  const responses = await Promise.all([run.input('same', text), run.input('same', text)])
  expect(responses.map(result => result.status)).toEqual([200, 200])
  expect(responses.filter(result => result.body.created)).toHaveLength(1)
  expect(responses[0]!.body.inputId).toBe(responses[1]!.body.inputId)
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'hmm_task_inputs' && item.ticket_id === run.id)).toHaveLength(1)
  await h.restart()
  const snapshot = run.snapshot(), ticket = run.ticket()
  expect(await run.input('same', text)).toMatchObject({ status: 200, body: { created: false } })
  expect(await run.input('same', '改变已提交的补充内容')).toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  expect(run.ticket()).toEqual(ticket)
  expect(run.snapshot()).toEqual(snapshot)
  const isolated = await other.input('same', text)
  expect(isolated).toMatchObject({ status: 200, body: { created: true } })
  expect(isolated.body.inputId).not.toBe(responses[0]!.body.inputId)
})

it.each([false, true])('补充原请求结果未知时，改文只追加新资料且保留已提交内容（原内容已保存：%s）', async committed => {
  const run = await task(), before = run.snapshot(), mandate = run.ticket().mandate
  const launches = h.nodeFactory.mock.calls.length
  if (committed) expect(await run.input('original', '先核对资料 A')).toMatchObject({ status: 200 })
  else {
    const note = h.runtime.engine.note.bind(h.runtime.engine)
    const failOnce = vi.spyOn(h.runtime.engine, 'note').mockImplementationOnce((...args) => {
      note(...args)
      throw new Error('模拟提交失败')
    })
    expect(await run.input('original', '先核对资料 A')).toMatchObject({ status: 500 })
    failOnce.mockRestore()
  }
  const changed = await run.input('edited', '改为核对资料 B')
  expect(changed).toMatchObject({ status: 200, body: { created: true } })
  await h.runtime.idle()
  expect(run.ticket().inputs.flatMap(input => input.kind === 'note' ? [input.text] : []))
    .toEqual(committed ? ['先核对资料 A', '改为核对资料 B'] : ['改为核对资料 B'])
  const stored = run.ticket()
  expect(await run.input('edited', '改为核对资料 B')).toMatchObject({ status: 200, body: { created: false } })
  expect(await run.input('edited', '不能使用同一编号替换原文'))
    .toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  expect(run.ticket()).toEqual(stored)
  expect(await run.input('intentional-repeat', '改为核对资料 B')).toMatchObject({ status: 200, body: { created: true } })
  expect(run.snapshot()).toEqual(before)
  expect(run.ticket().mandate).toEqual(mandate)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
})

it('暂停仍可接收上下文，结束后可重放原请求但不能追加或重启任务', async () => {
  const run = await task()
  await h.api('POST', 'executor/pause', { paused: true })
  const before = run.snapshot(), launches = h.nodeFactory.mock.calls.length
  const response = await run.input('paused', '恢复前先检查缺失资料')
  expect(response).toMatchObject({ status: 200, body: { created: true } })
  await h.runtime.idle()
  expect(run.snapshot()).toEqual(before)
  expect(h.nodeFactory.mock.calls).toHaveLength(launches)
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  const ended = run.ticket(), stopped = run.snapshot()
  expect(await run.input('paused', '恢复前先检查缺失资料')).toMatchObject({ status: 200, body: { created: false } })
  expect(await run.input('later', '另一个条件')).toMatchObject({ status: 409, body: { code: 'ticket_inactive' } })
  expect(run.ticket()).toEqual(ended)
  expect(run.snapshot()).toEqual(stopped)
})

it('通知入队失败时输入一起回滚，同一请求可安全重试', async () => {
  const run = await task(), before = run.ticket()
  const enqueue = vi.spyOn(h.runtime.effects, 'enqueue').mockImplementationOnce(() => { throw new Error('模拟入队失败') })
  expect(await run.input('atomic', '需要补充依据')).toMatchObject({ status: 500 })
  enqueue.mockRestore()
  expect(run.ticket()).toEqual(before)
  expect(await run.read()).not.toHaveProperty('lastContext')
  expect(await run.input('atomic', '需要补充依据')).toMatchObject({ status: 200, body: { created: true } })
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'hmm_task_inputs')).toHaveLength(1)
  expect((await run.read()).lastContext).toMatchObject({ text: '需要补充依据', truncated: false })
})

it('严格校验正文及任务范围，不能借补充信息声明新目标、身份或授权', async () => {
  const run = await task(), before = run.ticket(), snapshot = run.snapshot()
  for (const body of [
    {}, { requestId: '../invalid', text: '资料' }, { requestId: 'empty', text: '  ' },
    { requestId: 'long', text: 'x'.repeat(LOCAL_TASK_INPUT_LIMITS.chars + 1) },
    ...[{ goal: '新目标' }, { grants: ['all'] }, { actor: 'admin' }].map(extra => ({ requestId: 'extra', text: '资料', ...extra })),
  ]) expect(await h.api('POST', `tasks/${run.id}/inputs`, body)).toMatchObject({ status: 400 })
  expect(await h.api('POST', 'tasks/missing/inputs', { requestId: 'missing', text: '资料' }))
    .toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  expect(run.ticket()).toEqual(before)
  expect(run.snapshot()).toEqual(snapshot)
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('repo-context', '@bot 检查仓库问题'))
  expect(await h.api('POST', `tasks/${ticket.id}/inputs`, { requestId: 'scope', text: '资料' }))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
})

it.each(['messages', 'utf8'] as const)('达到 %s 预算后拒绝新增，重复请求仍复用已有输入', async kind => {
  const run = await task()
  const text = kind === 'messages' ? '一条补充信息' : '资'.repeat(LOCAL_TASK_INPUT_LIMITS.chars)
  const count = kind === 'messages' ? LOCAL_TASK_INPUT_LIMITS.messages
    : Math.floor(LOCAL_TASK_INPUT_LIMITS.bytes / Buffer.byteLength(text, 'utf8'))
  for (let index = 0; index < count; index++)
    expect(await run.input(`bounded-${index}`, text)).toMatchObject({ status: 200, body: { created: true } })
  const before = run.ticket()
  expect(await run.input('overflow', text)).toMatchObject({ status: 409, body: { code: 'input_budget_exceeded' } })
  expect(await run.input('bounded-0', text)).toMatchObject({ status: 200, body: { created: false } })
  expect(run.ticket()).toEqual(before)
})
