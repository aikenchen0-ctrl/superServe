import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LOCAL_TASK_INPUT_LIMITS } from '../src/app/local-tasks.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(requestId = 'question') {
  const response = await h.api('POST', 'tasks', { requestId, goal: '比较已授权资料，说明缺失条件', dispatch: false })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const ticket = () => h.runtime.store.tickets.get(id)!
  const ask = (question: string | null, revision = view().revision, choices?: string[]) =>
    h.runTool(h.runtime.masterId, 'hmm_question', { ticket_id: id, revision, question,
      ...(choices !== undefined ? { choices } : {}) }) as Promise<{
      ticketId: string; revision: number; question: { id: string; text: string; choices?: string[] } | null
    }>
  const answer = (questionId: string, text = '只比较成本。', requestId = 'answer') =>
    h.api('POST', `tasks/${id}/inputs`, { questionId, text, requestId })
  return { id, view, ticket, ask, answer }
}

it.each([false, true])('待回答问题与暂停、目标和修订事实可同时读取，保存回答仍不恢复派发；暂停%s', async paused => {
  const run = await task('question-priority')
  const definition = h.runtime.hmm.definition(controller, run.id)
  definition.plan.goal = '比较指定来源，保留完整范围与未知条件'
  expect(await h.api('POST', `tickets/${run.id}/hmm/revisions`, {
    revision: definition.revision, plan: definition.plan, reason: '补齐需求范围后重新核对',
  })).toMatchObject({ status: 200 })
  const asked = await run.ask('本轮只采用哪份授权资料？')
  if (paused) expect(await h.api('POST', 'executor/pause', { paused: true })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  const workflow = run.view(), ticket = run.ticket(), planVersion = workflow.planVersion
  const read = await h.api('GET', `tasks/${run.id}`)
  expect(read).toMatchObject({ status: 200, body: { paused, goalAvailable: true, question: asked.question,
    activity: paused ? 'paused' : 'attention',
    workflow: { planChangeAvailable: true, requiresOrchestrator: true, autoRun: false } } })
  const listed = await h.api('GET', 'tasks?state=needs_answer')
  expect(listed.body.items).toContainEqual(expect.objectContaining({
    ticketId: run.id, needsAnswer: true, activity: paused ? 'paused' : 'attention',
  }))
  expect(await h.api('GET', `tasks/${run.id}/goal?planVersion=${planVersion}`))
    .toMatchObject({ status: 200, body: { text: definition.plan.goal } })
  expect(await h.api('GET', `tasks/${run.id}/plan-change?planVersion=${planVersion}`))
    .toMatchObject({ status: 200, body: { reason: '补齐需求范围后重新核对' } })
  expect(run.view()).toEqual(workflow)
  expect(run.ticket()).toEqual(ticket)
  expect(await run.answer(asked.question!.id, '本轮只采用资料 A')).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ body: {
    paused, question: null, activity: paused ? 'paused' : 'held', workflow: { autoRun: false },
    lastAnswer: { answer: { text: '本轮只采用资料 A' } },
  } })
  expect((await h.api('GET', 'tasks?state=needs_answer')).body.items).toEqual([])
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('总管提问、任务页回答、原始输入回读形成闭环，保存答案不派发或扩大授权', async () => {
  const run = await task(), peer = await task('peer')
  h.runtime.hmm.apply(controller, run.id, run.view().revision, { action: 'dispatch' })
  await h.runtime.idle()
  const active = run.view().nodes.find(node => node.mode === 'task' && node.state === 'running')!
  const staleReport = h.tools.get(active.sessionId!)!.get('hmm_node_report')!
  const handle = h.owned.get(active.sessionId!)!
  expect(h.tools.get(active.sessionId!)?.has('hmm_question')).toBe(false)
  const grant = run.view().deviceGrants, mandate = run.ticket().mandate, peerBefore = peer.view()
  const asked = await run.ask('优先比较哪项：成本还是延迟？')
  await h.runtime.idle()
  expect(asked.question?.text).toBe('优先比较哪项：成本还是延迟？')
  expect(handle.dispose).toHaveBeenCalledOnce()
  expect(run.view()).toMatchObject({ autoRun: false, question: asked.question })
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ status: 200, body: {
    activity: 'attention', question: asked.question, workflow: { autoRun: false, progress: { running: 0 } },
  } })
  await expect(staleReport.execute({ action: 'checkpoint', frame: '迟到工作帧' },
    { signal: new AbortController().signal })).rejects.toThrow()
  for (const command of [{ action: 'dispatch' }, { action: 'resume', nodeId: active.id },
    { action: 'start', nodeId: 'execute' }, { action: 'validate', summary: '核验结果',
      evidenceRefs: [h.runtime.hmm.context(controller, run.id, active.id).inputRef] }])
    expect(() => h.runtime.hmm.apply(controller, run.id, run.view().revision, command))
      .toThrow('当前问题尚未回答')
  const launches = h.nodeFactory.mock.calls.length
  const response = await run.answer(asked.question!.id)
  expect(response).toMatchObject({ status: 200, body: { created: true } })
  await h.runtime.idle()
  expect(run.ticket().attention).toBeUndefined()
  const input = run.ticket().inputs.find(input => input.id === response.body.inputId)!
  expect(input).toMatchObject({ kind: 'note', text: '只比较成本。', answerTo: {
    id: asked.question!.id, question: asked.question!.text,
  } })
  const body = await h.runTool(h.runtime.masterId, 'orchestrator_read', {
    resource: `ticket/${run.id}/input/${response.body.inputId}`,
  })
  expect(JSON.parse(String(body.text))).toMatchObject({ kind: 'human_answer', text: '只比较成本。',
    answerTo: { id: asked.question!.id, question: asked.question!.text } })
  expect(h.relays(h.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'hmm_task_inputs', ticket_id: run.id }))
  expect(run.view()).toMatchObject({ autoRun: false, question: null })
  expect(run.view().deviceGrants).toEqual(grant)
  expect(run.ticket().mandate).toEqual(mandate)
  expect(peer.view()).toEqual(peerBefore)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
})

it('回答回执从持久原话派生，重启、普通补充和旧回答重试不改变最近一次问答', async () => {
  const run = await task(), peer = await task('receipt-peer')
  const read = async () => (await h.api('GET', `tasks/${run.id}`)).body
  expect(await read()).not.toHaveProperty('lastAnswer')
  const first = await run.ask('本轮优先比较哪项？', undefined, ['成本', '延迟'])
  const answered = await run.answer(first.question!.id, '优先延迟', 'receipt-first')
  await h.runtime.idle()
  const input = run.ticket().inputs.find(item => item.id === answered.body.inputId)!
  const expected = {
    inputId: input.id, at: input.at, question: { text: first.question!.text, truncated: false },
    answer: { text: '优先延迟', truncated: false },
  }
  expect((await read()).lastAnswer).toEqual(expected)
  expect((await h.api('GET', `tasks/${peer.id}`)).body).not.toHaveProperty('lastAnswer')
  await h.restart()
  expect((await read()).lastAnswer).toEqual(expected)
  expect(await h.api('POST', `tasks/${run.id}/inputs`, { requestId: 'ordinary-note', text: '其他补充不是回答' }))
    .toMatchObject({ status: 200 })
  const second = await run.ask('使用哪份资料？')
  expect(await read()).toMatchObject({ lastAnswer: expected, question: second.question })
  const next = await run.answer(second.question!.id, '资料 B', 'receipt-second')
  await h.runtime.idle()
  const stored = run.ticket(), workflow = run.view(), launches = h.nodeFactory.mock.calls.length
  const latest = (await read()).lastAnswer
  expect(latest).toMatchObject({ inputId: next.body.inputId, answer: { text: '资料 B', truncated: false } })
  expect(await run.answer(first.question!.id, '优先延迟', 'receipt-first'))
    .toMatchObject({ status: 200, body: { created: false } })
  expect((await read()).lastAnswer).toEqual(latest)
  expect((await read()).lastAnswer).toEqual(latest)
  expect(run.ticket()).toEqual(stored)
  expect(run.view()).toEqual(workflow)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  await h.api('POST', `tasks/${run.id}/stop`)
  expect((await read()).lastAnswer).toEqual(latest)
})

it.each(['\u{20000}', '\u0001', '"\\\n'])('长回执有界且 Unicode 完整，截断不改变可回读原话（%j）', async sample => {
  const run = await task()
  const question = `问题开头${sample.repeat(100)}问题结尾`
  const answer = `回答开头${sample.repeat(900)}回答结尾`
  const asked = await run.ask(question)
  const response = await run.answer(asked.question!.id, answer)
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const before = run.ticket(), workflow = run.view()
  const status = await h.api('GET', `tasks/${run.id}`)
  const receipt = status.body.lastAnswer as {
    inputId: string; at: string; question: { text: string; truncated: boolean }; answer: { text: string; truncated: boolean }
  }
  expect(Object.keys(receipt).sort()).toEqual(['answer', 'at', 'inputId', 'question'])
  expect(receipt.question.truncated).toBe(true)
  expect(receipt.answer.truncated).toBe(true)
  expect(Array.from(receipt.question.text)).toHaveLength(80)
  expect(Array.from(receipt.answer.text)).toHaveLength(160)
  expect(receipt.question.text.isWellFormed()).toBe(true)
  expect(receipt.answer.text.isWellFormed()).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(receipt), 'utf8')).toBeLessThan(2048)
  expect(status.body).not.toHaveProperty('instruction')
  expect(JSON.stringify(receipt)).not.toContain('deviceGrants')
  const original = await h.runTool(h.runtime.masterId, 'orchestrator_read', {
    resource: `ticket/${run.id}/input/${response.body.inputId}`, limit: 8000,
  })
  expect(JSON.parse(String(original.text))).toMatchObject({ text: answer,
    answerTo: { id: asked.question!.id, question } })
  expect(run.ticket()).toEqual(before)
  expect(run.view()).toEqual(workflow)
})

it('新问题替换旧问题后拒绝迟到回答，不能清除新问题或写入原话', async () => {
  const run = await task()
  const first = await run.ask('先比较成本还是时间？')
  const next = await run.ask('资料范围是 A 还是 B？')
  const before = run.ticket()
  expect(next.question!.id).not.toBe(first.question!.id)
  expect(await run.answer(first.question!.id)).toMatchObject({ status: 409, body: { code: 'question_conflict' } })
  expect(run.ticket()).toEqual(before)
  await run.ask(null)
  expect(run.ticket().attention).toBeUndefined()
  expect(run.view().autoRun).toBe(false)
  expect(await run.answer(next.question!.id)).toMatchObject({ status: 409, body: { code: 'question_conflict' } })
  const again = await run.ask(next.question!.text)
  expect(again.question!.id).not.toBe(next.question!.id)
})

it('可选答案跨重启保留，回答的原问题快照包含选项且不自动执行', async () => {
  const run = await task()
  const asked = await run.ask('本轮优先比较哪项？', undefined, ['更低成本', '更低延迟'])
  expect(asked.question).toMatchObject({ choices: ['更低成本', '更低延迟'] })
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ body: { question: asked.question } })
  await h.restart()
  expect(await h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: run.id, view: 'handoff' }))
    .toMatchObject({ question: asked.question })
  const response = await run.answer(asked.question!.id, '更低延迟')
  expect(response).toMatchObject({ status: 200, body: { created: true } })
  const original = await h.runTool(h.runtime.masterId, 'orchestrator_read', {
    resource: `ticket/${run.id}/input/${response.body.inputId}`,
  })
  expect(JSON.parse(String(original.text))).toMatchObject({ text: '更低延迟', answerTo: {
    id: asked.question!.id, choices: ['更低成本', '更低延迟'],
  } })
  expect(run.view().autoRun).toBe(false)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it.each([undefined, ['先比较来源', '先检查条件']])('相同待答问题重复提交不推进修订、写入工单或报告（选项%j）', async choices => {
  const run = await task('repeat-stable')
  const asked = await run.ask('下一步先核对哪部分？', undefined, choices)
  await h.runtime.idle()
  const ticket = run.ticket(), workflow = run.view(), notices = h.relays(h.runtime.masterId).length
  const report = vi.spyOn(h.runtime.engine, 'report'), apply = vi.spyOn(h.runtime.hmm, 'apply')
  for (let attempt = 0; attempt < 5; attempt++)
    expect(await run.ask(' 下一步先核对哪部分？ ', asked.revision, choices)).toEqual(asked)
  expect(report).not.toHaveBeenCalled()
  expect(apply).not.toHaveBeenCalled()
  expect(run.ticket()).toEqual(ticket)
  expect(run.view()).toEqual(workflow)
  expect(h.relays(h.runtime.masterId)).toHaveLength(notices)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  await expect(run.ask('下一步先核对哪部分？', asked.revision - 1, choices)).rejects.toThrow()
  expect(run.ticket()).toEqual(ticket)
  report.mockRestore(); apply.mockRestore()
  await h.restart()
  expect(await run.ask('下一步先核对哪部分？', asked.revision, choices)).toEqual(asked)
  expect(run.ticket()).toEqual(ticket)
})

it.each((['missing', 'ended'] as const).flatMap(state => [false, true].map(repeated => ({ state, repeated }))))(
  '提问复用与原报告路径遵守相同执行归属检查：$state，重复$repeated', async ({ state, repeated }) => {
  const run = await task(`repeat-assignment-${state}-${repeated}`)
  const asked = await run.ask('请确认本轮资料范围')
  await h.runtime.idle()
  const ticket = run.ticket()
  h.runtime.store.tickets.save({ ...ticket, assignments: state === 'missing' ? []
    : ticket.assignments.map(assignment => ({ ...assignment, state: 'ended' as const })) })
  const before = run.ticket(), workflow = run.view()
  await expect(run.ask(repeated ? '请确认本轮资料范围' : '请确认新的资料范围', asked.revision))
    .rejects.toThrow(state === 'missing' ? 'Unknown assignment' : 'Assignment has ended')
  expect(run.ticket()).toEqual(before)
  expect(run.view()).toEqual(workflow)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('相同文字在已回答后建立新问题，待回答期间改字或选项仍有真实版本变化', async () => {
  const run = await task('repeat-after-answer')
  const first = await run.ask('选择资料范围')
  expect(await run.answer(first.question!.id, '只使用已授权资料')).toMatchObject({ status: 200 })
  const next = await run.ask('选择资料范围')
  expect(next.question!.id).not.toBe(first.question!.id)
  expect(next.revision).toBeGreaterThan(first.revision)
  const changed = await run.ask('选择本轮资料范围')
  expect(changed.question!.id).not.toBe(next.question!.id)
  expect(await run.answer(next.question!.id)).toMatchObject({ status: 409 })
})

it('只改选项也更新问题身份，重排和改为自由回答均拒绝旧页面答案', async () => {
  const run = await task()
  const first = await run.ask('选哪个？', undefined, ['A', 'B'])
  const repeated = await run.ask('选哪个？', undefined, ['A', 'B'])
  expect(repeated.question!.id).toBe(first.question!.id)
  const changed = await run.ask('选哪个？', undefined, ['B', 'A'])
  expect(changed.question!.id).not.toBe(first.question!.id)
  const ticket = run.ticket()
  expect(await run.answer(first.question!.id, 'A')).toMatchObject({ status: 409, body: { code: 'question_conflict' } })
  expect(run.ticket()).toEqual(ticket)
  const free = await run.ask('选哪个？')
  expect(free.question!.id).not.toBe(changed.question!.id)
  expect(free.question).not.toHaveProperty('choices')
  expect(run.view().question).not.toHaveProperty('choices')
  expect(await run.answer(changed.question!.id, 'B')).toMatchObject({ status: 409 })
  expect(await run.answer(free.question!.id, '两者之外的方案', 'custom')).toMatchObject({ status: 200 })
})

it.each([[], ['A'], ['A', 'B', 'C', 'D', 'E'], ['A', ' A '], ['A', ''],
  ['A', 'x'.repeat(121)]].map(choices => ({ choices })))('拒绝无效选项，不暂停或写入问题：$choices', async ({ choices }) => {
  const run = await task(), before = run.view(), ticket = run.ticket()
  await expect(run.ask('选哪个？', undefined, choices)).rejects.toThrow()
  expect(run.view()).toEqual(before)
  expect(run.ticket()).toEqual(ticket)
})

it('撤回不能携带新选项，达到四个选项上限仍可使用自由答案', async () => {
  const run = await task()
  const asked = await run.ask('采用哪个范围？', undefined, ['A', 'B', 'C', 'D'])
  const before = run.view()
  await expect(run.ask(null, undefined, ['A', 'B'])).rejects.toMatchObject({ code: 'question_invalid' })
  expect(run.view()).toEqual(before)
  expect(await run.answer(asked.question!.id, '暂不采用任何范围')).toMatchObject({ status: 200 })
})

it('并发回答只接受一个，成功重试跨重启幂等，不清除后来重新提出的同文问题', async () => {
  const run = await task(), first = await run.ask('比较哪份资料？')
  const responses = await Promise.all([
    run.answer(first.question!.id, '资料 A', 'first'), run.answer(first.question!.id, '资料 B', 'second'),
  ])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  const accepted = responses[0]!.status === 200 ? { text: '资料 A', requestId: 'first' } : { text: '资料 B', requestId: 'second' }
  const next = await run.ask('比较哪份资料？')
  expect(next.question!.id).not.toBe(first.question!.id)
  const ticket = run.ticket()
  expect(await run.answer(first.question!.id, accepted.text, accepted.requestId))
    .toMatchObject({ status: 200, body: { created: false } })
  expect(run.ticket()).toEqual(ticket)
  expect(await run.answer(next.question!.id, accepted.text, accepted.requestId))
    .toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  await h.restart()
  expect(run.view().question).toEqual(next.question)
  expect(await run.answer(first.question!.id, accepted.text, accepted.requestId))
    .toMatchObject({ status: 200, body: { created: false } })
  expect(run.ticket()).toEqual(ticket)
})

it('原回答已提交但响应未知时，原样重试仍成功，改答明确拒绝且保留原记录和新问题', async () => {
  const run = await task(), asked = await run.ask('本轮优先哪项？', undefined, ['成本', '延迟'])
  const first = await run.answer(asked.question!.id, '成本', 'original')
  expect(first).toMatchObject({ status: 200, body: { created: true } })
  await h.runtime.idle()
  await h.restart()
  for (const replaceQuestion of [false, true]) {
    if (replaceQuestion) await run.ask('当前资料范围？', undefined, ['A', 'B'])
    const ticket = run.ticket(), workflow = run.view(), launches = h.nodeFactory.mock.calls.length
    expect(await run.answer(asked.question!.id, '成本', 'original'))
      .toMatchObject({ status: 200, body: { created: false, inputId: first.body.inputId } })
    expect(await run.answer(asked.question!.id, '延迟', 'edited'))
      .toMatchObject({ status: 409, body: { code: 'question_conflict', error: expect.stringContaining('本次修改未保存') } })
    expect(run.ticket()).toEqual(ticket)
    expect(run.view()).toEqual(workflow)
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
    expect(ticket.inputs.filter(input => input.kind === 'note' && input.answerTo?.id === asked.question!.id))
      .toEqual([expect.objectContaining({ id: first.body.inputId, text: '成本' })])
  }
})

it('提问或保存答案失败时回滚问题、节点和通知，原回答可重试', async () => {
  const run = await task()
  const initial = run.view(), ticket = run.ticket()
  const report = h.runtime.engine.report.bind(h.runtime.engine)
  const failedAsk = vi.spyOn(h.runtime.engine, 'report').mockImplementationOnce((...args) => {
    report(...args)
    throw new Error('模拟问题保存失败')
  })
  await expect(run.ask('优先核对哪项？')).rejects.toThrow('模拟问题保存失败')
  failedAsk.mockRestore()
  expect(run.view()).toEqual(initial)
  expect(run.ticket()).toEqual(ticket)
  const asked = await run.ask('优先核对哪项？')
  const before = run.ticket(), workflow = run.view(), noticeCount = h.relays(h.runtime.masterId).length
  const note = h.runtime.engine.note.bind(h.runtime.engine)
  const failedAnswer = vi.spyOn(h.runtime.engine, 'note').mockImplementationOnce((...args) => {
    note(...args)
    throw new Error('模拟答案保存失败')
  })
  expect(await run.answer(asked.question!.id)).toMatchObject({ status: 500 })
  failedAnswer.mockRestore()
  await h.runtime.idle()
  expect(run.ticket()).toEqual(before)
  expect(run.view()).toEqual(workflow)
  expect(h.relays(h.runtime.masterId)).toHaveLength(noticeCount)
  expect(await run.answer(asked.question!.id)).toMatchObject({ status: 200, body: { created: true } })
})

it('全局暂停仍能提问和保存回答，重启能读回待回答问题但不会自动执行', async () => {
  const run = await task()
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  const asked = await run.ask('先核对资料 A 吗？')
  await h.restart()
  expect(await h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: run.id, view: 'handoff' }))
    .toMatchObject({ paused: true, question: asked.question, autoRun: false })
  expect(await run.answer(asked.question!.id)).toMatchObject({ status: 200 })
  expect(h.runtime.store.settings().paused).toBe(true)
  expect(run.view().autoRun).toBe(false)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('普通补充不会冒充回答，旧版本提问、结束工单和跨工单问题编号被拒绝', async () => {
  const run = await task(), other = await task('other')
  const revision = run.view().revision, asked = await run.ask('缺失资料由谁提供？')
  await expect(run.ask('改问其他问题', revision)).rejects.toMatchObject({ code: 'revision_conflict' })
  expect(await h.api('POST', `tasks/${run.id}/inputs`, { requestId: 'note', text: '附加背景' })).toMatchObject({ status: 200 })
  expect(run.view().question).toEqual(asked.question)
  expect(await other.answer(asked.question!.id)).toMatchObject({ status: 409, body: { code: 'question_conflict' } })
  await h.api('POST', `tasks/${run.id}/stop`)
  await expect(run.ask('再询问')).rejects.toMatchObject({ code: 'ticket_inactive' })
  expect(await run.answer(asked.question!.id)).toMatchObject({ status: 409, body: { code: 'ticket_inactive' } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('提问仅限本地总管，拒绝超长问题、扩权字段和仓库工单', async () => {
  const run = await task(), master = h.runtime.masterId
  for (const question of ['', 'x'.repeat(1001)])
    await expect(run.ask(question)).rejects.toThrow()
  await expect(h.runTool(master, 'hmm_question', {
    ticket_id: run.id, revision: run.view().revision, question: '问题', grants: ['all'],
  })).rejects.toThrow()
  expect(run.ticket().attention).toBeUndefined()
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('question-scope', '@bot 检查仓库'))
  expect(() => h.runtime.tasks.ask(ticket.id, { revision: 1, question: '问题' }))
    .toThrow('此入口仅适用于本地')
})

it('问题快照计入原输入预算，拒绝超额答案时仍保留问题和旧输入', async () => {
  const run = await task(), asked = await run.ask('先比较哪种指标？')
  const answer = '资'.repeat(4000)
  const remaining = LOCAL_TASK_INPUT_LIMITS.bytes - Buffer.byteLength(answer, 'utf8') - 20 * 12000
  const notes = [...Array<string>(20).fill('资'.repeat(4000))]
  for (let used = 0; used < remaining; used += 4000) notes.push('a'.repeat(Math.min(4000, remaining - used)))
  for (const [index, text] of notes.entries())
    expect(await h.api('POST', `tasks/${run.id}/inputs`, { requestId: `budget-${index}`, text })).toMatchObject({ status: 200 })
  const ticket = run.ticket()
  expect(await run.answer(asked.question!.id, answer)).toMatchObject({ status: 409, body: { code: 'input_budget_exceeded' } })
  expect(run.ticket()).toEqual(ticket)
  expect(run.view().question).toEqual(asked.question)
  expect(await h.api('POST', `tasks/${run.id}/inputs`, { requestId: 'text-only', text: answer })).toMatchObject({ status: 200 })
  expect(run.view().question).toEqual(asked.question)
})
