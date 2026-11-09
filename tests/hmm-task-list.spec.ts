import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(requestId: string, mode: 'single' | 'multi' = 'single') {
  const response = await h.api('POST', 'tasks', { requestId, title: `任务 ${requestId}`, goal: '整理已有资料及其约束', mode })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  return response.body.ticketId as string
}
async function list(query = '') {
  const response = await h.api('GET', `tasks${query ? '?' + query : ''}`)
  expect(response.status).toBe(200)
  return response.body as ApiResponse<'GET tasks'>
}

it('目录展示请求贯通HTTP与真实任务读取，保留搜索范围和默认正文边界', async () => {
  const pending = await task('selected-pending'), normal = await task('selected-normal'), other = await task('elsewhere')
  for (const id of [pending, other]) h.runtime.tasks.ask(id, {
    revision: h.runtime.hmm.view(controller, id).revision, question: `question-${id}`,
  })
  const header = { 'x-orchestrator-task-view': 'questions' }
  const plain = await list('q=selected&limit=1')
  expect(plain).not.toHaveProperty('hasQuestions')
  expect(plain.items[0]).not.toHaveProperty('questionPreview')
  const page = await h.api('GET', 'tasks?q=selected&limit=1', undefined, header)
  expect(page).toMatchObject({ status: 200, body: { items: [{ ticketId: normal }], hasQuestions: true } })
  expect((page.body.items as unknown[])).toHaveLength(1)
  const questions = await h.api('GET', 'tasks?state=needs_answer&q=selected', undefined, header)
  expect(questions).toMatchObject({ status: 200, body: { nextBefore: null, hasQuestions: true,
    items: [{ ticketId: pending, questionPreview: { text: `question-${pending}`, truncated: false } }] } })
  expect((questions.body.items as unknown[])).toHaveLength(1)
  expect(await h.api('GET', 'tasks?q=selected-normal', undefined, header))
    .toMatchObject({ status: 200, body: { hasQuestions: false } })
})

async function finish(id: string) {
  let view = h.runtime.hmm.view(controller, id)
  while (view.nodes.some(node => node.state === 'running')) {
    for (const node of view.nodes.filter(node => node.mode === 'task' && node.state === 'running')) {
      const context = h.runtime.hmm.context(controller, id, node.id)
      await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: '整理出可行结论',
        evidenceRefs: context.sourceResults.length ? context.sourceResults.map(result => result.ref) : [context.inputRef] })
    }
    await h.runtime.idle()
    view = h.runtime.hmm.view(controller, id)
  }
  expect(view.awaitingValidation).toBe(true)
  h.runtime.hmm.apply(controller, id, view.revision, { action: 'validate', summary: '已核对目标与结果',
    evidenceRefs: view.nodes.flatMap(node => node.resultRef ? [node.resultRef] : []) })
  await h.runtime.idle()
}

it('空列表有稳定的终止游标，创建后可发现任务并回读原状态', async () => {
  expect(await list()).toEqual({ items: [], nextBefore: null })
  const id = await task('discover', 'multi')
  const ticket = h.runtime.store.tickets.get(id)!
  expect(await list()).toEqual({ items: [{ ticketId: id, title: ticket.title,
    createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, needsAnswer: false, ended: null,
    activity: 'running' }], nextBefore: null })
  expect(await h.api('GET', `tasks/${id}`)).toMatchObject({ status: 200,
    body: { ticketId: id, title: ticket.title, ended: null } })
})

it('问题节选按需投影，默认目录和总管工具不读取正文，且不加载详情或启动节点', async () => {
  const id = h.runtime.tasks.create({ requestId: 'question-preview', title: '选择核对范围',
    goal: 'PRIVATE_GOAL', dispatch: false }).ticketId
  h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision,
    question: '先核对\n原始记录，\t还是先比较两组结论？', choices: ['PRIVATE_CHOICE_A', 'PRIVATE_CHOICE_B'] })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(id), workflow = h.runtime.store.get(KV.hmm.workflow(id))
  const view = vi.spyOn(h.runtime.hmm, 'view'), status = vi.spyOn(h.runtime.tasks, 'status')
  try {
    const plain = await list('state=needs_answer')
    expect(plain.items[0]).not.toHaveProperty('questionPreview')
    expect(await h.runTool(h.runtime.masterId, 'hmm_tasks', { state: 'needs_answer' })).toEqual(plain)
    const detailed = await list('state=needs_answer&preview=question')
    expect(detailed.items[0]).toMatchObject({ ticketId: id, needsAnswer: true,
      questionPreview: { text: '先核对 原始记录， 还是先比较两组结论？', truncated: false } })
    expect(JSON.stringify(detailed)).not.toContain('PRIVATE_')
    expect(JSON.stringify(detailed)).not.toContain('questionText')
    expect(view).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
    expect(h.nodeFactory).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
    expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(workflow)
  } finally { view.mockRestore(); status.mockRestore() }
  expect(await h.api('GET', 'tasks?preview=all')).toMatchObject({ status: 400 })
  await expect(h.runTool(h.runtime.masterId, 'hmm_tasks', { preview: 'question' })).rejects.toThrow()
})

it.each([159, 160, 161])('问题节选在 %i 个 Unicode 码点边界保持原文，截断有显式标记', async length => {
  const id = h.runtime.tasks.create({ requestId: `preview-boundary-${length}`, goal: '核对输入边界', dispatch: false }).ticketId
  const question = '🧭'.repeat(length)
  h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision, question })
  const row = (await list('preview=question')).items[0]!
  expect(row.questionPreview).toEqual({ text: '🧭'.repeat(Math.min(length, 160)), truncated: length > 160 })
  expect(h.runtime.store.tickets.get(id)!.attention!.question).toBe(question)
})

it('问题替换、回答、终止及跨页读取不会返回过期问题或外部工单正文', async () => {
  const older = await task('preview-older'), newer = await task('preview-newer')
  const ask = (id: string, question: string) => h.runtime.tasks.ask(id,
    { revision: h.runtime.hmm.view(controller, id).revision, question })
  ask(older, '旧任务需要判断的范围')
  ask(newer, '待替换的问题')
  const first = await list('state=needs_answer&preview=question&limit=1')
  expect(first).toMatchObject({ items: [{ ticketId: newer, questionPreview: { text: '待替换的问题' } }], nextBefore: newer })
  const asked = ask(newer, '新的问题范围')
  expect((await list('preview=question')).items[0]!.questionPreview?.text).toBe('新的问题范围')
  expect(await h.api('POST', `tasks/${newer}/inputs`,
    { requestId: 'preview-answer', questionId: asked.question!.id, text: '按新范围' })).toMatchObject({ status: 200 })
  const ticket = h.runtime.store.tickets.get(older)!
  h.runtime.store.tickets.save({ ...ticket, id: 'preview-foreign', mandate: {
    ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' },
  } })
  const tail = await list(`state=needs_answer&preview=question&limit=1&before=${first.nextBefore}`)
  expect(tail).toMatchObject({ items: [{ ticketId: older, questionPreview: { text: '旧任务需要判断的范围' } }], nextBefore: null })
  expect(await h.api('GET', 'tasks?preview=question&before=preview-foreign')).toMatchObject({ status: 403 })
  expect((await list('preview=question')).items.find(row => row.ticketId === newer)).not.toHaveProperty('questionPreview')
  await h.api('POST', `tasks/${older}/stop`)
  const ended = h.runtime.store.tickets.get(older)!
  h.runtime.store.tickets.save({ ...ended, attention: ticket.attention })
  const rows = (await list('state=all&preview=question')).items
  expect(rows).toHaveLength(2)
  expect(rows.every(row => !row.questionPreview)).toBe(true)
})

it('跨页待答提示随原目录读取返回，搜索范围隔离且不启动执行或读取页外工作流', async () => {
  const older = await task('attention-old'), middle = await task('attention-middle'), newest = await task('attention-new')
  h.runtime.tasks.ask(newest, { revision: h.runtime.hmm.view(controller, newest).revision, question: 'PRIVATE_QUESTION' })
  const view = vi.spyOn(h.runtime.hmm, 'view'), activity = vi.spyOn(h.runtime.hmm, 'activity')
  const available = vi.spyOn(h.runtime.store.read, 'localQuestionsAvailable')
  const launches = h.nodeFactory.mock.calls.length
  try {
    const plain = await list(`before=${middle}&limit=1`)
    expect(plain).not.toHaveProperty('hasQuestions')
    expect(available).not.toHaveBeenCalled()
    activity.mockClear()
    const page = await list(`before=${middle}&limit=1&attention=questions`)
    expect(page).toMatchObject({ hasQuestions: true, items: [{ ticketId: older }], nextBefore: null })
    expect(activity.mock.calls.map(([, id]) => id)).toEqual([older])
    expect(view).not.toHaveBeenCalled()
    expect(JSON.stringify(page)).not.toContain('PRIVATE_QUESTION')
    expect(await list('attention=questions&q=attention-old')).toMatchObject({ hasQuestions: false })
    expect(await list('attention=questions&state=ended')).toEqual({ items: [], nextBefore: null, hasQuestions: true })
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  } finally { view.mockRestore(); activity.mockRestore(); available.mockRestore() }
  await expect(h.runTool(h.runtime.masterId, 'hmm_tasks', { attention: 'questions' })).rejects.toThrow()
  expect(await h.api('GET', 'tasks?attention=all')).toMatchObject({ status: 400 })
})

it('待答索引在旧库重开时建立，问题退出及事务回滚保持一致，字面搜索不扩大范围', async () => {
  const id = await task('indexed-attention')
  const ticket = h.runtime.store.tickets.get(id)!
  h.runtime.store.tickets.save({ ...ticket, title: '范围_%\\边界' })
  const asked = h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision, question: 'PRIVATE_INDEXED_QUESTION' })
  await h.runtime.idle()
  h.runtime.store.db.exec('DROP INDEX ticket_local_question; ALTER TABLE ticket DROP COLUMN local_question')
  await h.restart()
  const before = h.runtime.store.tickets.get(id)!
  expect(await list('attention=questions')).toMatchObject({ hasQuestions: true })
  for (const q of ['_%\\', '范围', '边界'])
    expect(await list(`attention=questions&q=${encodeURIComponent(q)}`)).toMatchObject({ hasQuestions: true })
  expect(await list(`attention=questions&q=${encodeURIComponent('%不存在')}`)).toMatchObject({ hasQuestions: false })
  h.runtime.store.tickets.save({ ...before, id: 'foreign-indexed', mandate: {
    ...before.mandate, actor: { ...before.mandate.actor, source: 'github' },
  } })
  expect(() => h.runtime.store.atomic(() => {
    h.runtime.store.tickets.save({ ...before, attention: undefined })
    expect(h.runtime.store.read.localQuestionsAvailable()).toBe(false)
    throw new Error('rollback the fixture')
  })).toThrow('rollback the fixture')
  expect(h.runtime.store.read.localQuestionsAvailable()).toBe(true)
  expect(await h.api('POST', `tasks/${id}/inputs`, { requestId: 'index-answer', questionId: asked.question!.id, text: '按原范围' }))
    .toMatchObject({ status: 200 })
  expect(await list('attention=questions')).toMatchObject({ hasQuestions: false })
  h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision, question: '再次确认范围' })
  expect(h.runtime.store.read.localQuestionsAvailable()).toBe(true)
  await h.api('POST', `tasks/${id}/stop`)
  expect(h.runtime.store.read.localQuestionsAvailable()).toBe(false)
})

it('稀疏待答发现使用工作集索引，普通未结束任务增长不需要加载其 JSON 或工作流', async () => {
  const id = await task('indexed-only')
  h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision, question: '等待核对' })
  const ticket = h.runtime.store.tickets.get(id)!
  h.runtime.store.atomic(() => {
    for (let index = 0; index < 2000; index++)
      h.runtime.store.tickets.save({ ...ticket, id: `ordinary-${index}`, attention: undefined, title: `普通任务 ${index}` })
  })
  const plan = h.runtime.store.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM ticket WHERE local_question = 1 LIMIT 1').all()
  expect(plan.some(row => String(row.detail).includes('USING INDEX ticket_local_question'))).toBe(true)
  expect(h.runtime.store.read.localQuestionsAvailable()).toBe(true)
  h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision, question: null })
  expect(h.runtime.store.read.localQuestionsAvailable()).toBe(false)
})

it('任务列表投影待送达补充信息数量，不逐条读取详情且零值保持兼容', async () => {
  const response = await h.api('POST', 'tasks', {
    requestId: 'list-pending-input', title: '待送达任务', goal: '整理已有资料及其约束', mode: 'single', dispatch: false,
  })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string
  await h.runtime.idle()
  const empty = await h.api('POST', 'tasks', {
    requestId: 'list-zero-input', title: '无待送达任务', goal: '整理已有资料及其约束', mode: 'single', dispatch: false,
  })
  expect(empty.status).toBe(200)
  // 投递端口暂不接收；输入仍通过真实 HTTP、领域事务和 SQLite 保存。
  const delivery = vi.spyOn(h.runtime.tasks, 'deliver').mockImplementation(() => {})
  try {
    expect(await h.api('POST', `tasks/${id}/inputs`, { requestId: 'pending-note', text: 'PRIVATE_ADDITIONAL_CONTEXT' }))
      .toMatchObject({ status: 200, body: { created: true } })
    expect(delivery).toHaveBeenCalledOnce()
    const detail = (await h.api('GET', `tasks/${id}`)).body as ApiResponse<'GET tasks/:id'>
    expect(detail.inputs.pendingDelivery).toBe(1)
    const ticket = h.runtime.store.tickets.get(id)!, workflow = h.runtime.store.get(KV.hmm.workflow(id))
    const launches = h.nodeFactory.mock.calls.length
    const status = vi.spyOn(h.runtime.tasks, 'status')
    const page = await list()
    expect(page.items.find(item => item.ticketId === id)).toMatchObject({
      title: '待送达任务', needsAnswer: false, pendingDelivery: detail.inputs.pendingDelivery, activity: detail.activity,
    })
    expect(page.items.find(item => item.ticketId === empty.body.ticketId)).not.toHaveProperty('pendingDelivery')
    expect(await list()).toEqual(page)
    expect(await list('state=needs_answer')).toEqual({ items: [], nextBefore: null })
    expect(status).not.toHaveBeenCalled()
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|undelivered|sessionId|instruction/)
    expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
    expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(workflow)
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
    expect(delivery).toHaveBeenCalledOnce()
    status.mockRestore()
    delivery.mockRestore()
    h.runtime.tasks.deliver(ticket, ticket.assignments.at(-1)!)
    await h.runtime.idle()
    expect((await list()).items.find(item => item.ticketId === id)).not.toHaveProperty('pendingDelivery')
    expect(await h.api('GET', `tasks/${id}`)).toMatchObject({ body: { inputs: { pendingDelivery: 0 } } })
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  } finally { delivery.mockRestore() }
})

it('结束任务即使残留旧待送达编号，列表也不提示继续处理或带入待回答筛选', async () => {
  const id = await task('ended-pending-input')
  await h.api('POST', `tasks/${id}/stop`)
  const ended = h.runtime.store.tickets.get(id)!
  h.runtime.store.tickets.save({ ...ended, undelivered: ['legacy-input'] })
  const before = h.runtime.store.tickets.get(id)
  const status = vi.spyOn(h.runtime.tasks, 'status')
  const row = (await list('state=ended')).items.find(item => item.ticketId === id)!
  expect(row).toMatchObject({ activity: 'ended', needsAnswer: false, ended: { outcome: 'stopped' } })
  expect(row).not.toHaveProperty('pendingDelivery')
  expect(await list('state=needs_answer')).toEqual({ items: [], nextBefore: null })
  expect(h.runtime.store.tickets.get(id)).toEqual(before)
  expect(status).not.toHaveBeenCalled()
})

it.each(['suspended', 'dependency_blocked', 'plan_review'] as const)(
  '目录按领域事实说明%s原因，待回答与结束状态优先且查询不调用详情或启动节点', async reason => {
    const created = await h.api('POST', 'tasks', {
      requestId: `attention-${reason}`, title: '核对资料', goal: 'PRIVATE_GOAL', dispatch: false,
      plan: { nodes: [
        { id: 'root', title: '核对主线', mode: 'parallel' },
        { id: 'source', parentId: 'root', title: '检查来源', instruction: 'PRIVATE_SOURCE_INSTRUCTION' },
        { id: 'summary', parentId: 'root', title: '整理结果', instruction: 'PRIVATE_SUMMARY_INSTRUCTION', dependsOn: ['source'] },
      ] },
    })
    expect(created.status).toBe(200)
    const id = created.body.ticketId as string, view = () => h.runtime.hmm.view(controller, id)
    if (reason === 'suspended')
      h.runtime.hmm.apply(controller, id, view().revision, { action: 'suspend', nodeId: 'source', reason: 'PRIVATE_SUSPEND_REASON' })
    else h.runtime.hmm.apply(controller, id, view().revision, { action: 'prune',
      nodeId: reason === 'plan_review' ? 'root' : 'source', reason: 'PRIVATE_PRUNE_REASON', reconsiderWhen: '条件变化后' })
    h.runtime.hmm.apply(controller, id, view().revision, { action: 'dispatch' })
    await h.runtime.idle()
    const detail = (await h.api('GET', `tasks/${id}`)).body as ApiResponse<'GET tasks/:id'>
    expect(detail.activity).toBe('attention')
    if (reason === 'suspended') expect(detail.workflow.progress.suspended).toBe(1)
    else if (reason === 'dependency_blocked') expect(detail.workflow.dependencyBlockers.total).toBe(1)
    else expect(detail.workflow.planReviewRequired).toBe(true)
    const ticket = h.runtime.store.tickets.get(id), workflow = h.runtime.store.get(KV.hmm.workflow(id))
    const statusRead = vi.spyOn(h.runtime.tasks, 'status'), workflowRead = vi.spyOn(h.runtime.hmm, 'view')
    try {
      const page = await list()
      expect(page.items).toMatchObject([{ ticketId: id, activity: detail.activity, needsAnswer: false, attentionReason: reason }])
      expect(await list()).toEqual(page)
      expect(await h.runTool(h.runtime.masterId, 'hmm_tasks', {})).toEqual(page)
      expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|instruction|sessionId|nodeId|evidenceRefs/)
      expect(statusRead).not.toHaveBeenCalled()
      expect(workflowRead).not.toHaveBeenCalled()
      expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
      expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(workflow)
      expect(h.nodeFactory).not.toHaveBeenCalled()
    } finally { statusRead.mockRestore(); workflowRead.mockRestore() }
    h.runtime.tasks.ask(id, { revision: view().revision, question: 'PRIVATE_QUESTION' })
    const asked = (await list()).items.find(row => row.ticketId === id)!
    expect(asked).toMatchObject({ needsAnswer: true })
    expect(asked).not.toHaveProperty('attentionReason')
    await h.api('POST', `tasks/${id}/stop`)
    const ended = (await list('state=ended')).items.find(row => row.ticketId === id)!
    expect(ended).toMatchObject({ activity: 'ended', needsAnswer: false })
    expect(ended).not.toHaveProperty('attentionReason')
  })

it('来源撤回同时造成依据失效与依赖受阻时，目录显示依据失效而不掩盖领域事实', async () => {
  const response = await h.api('POST', 'tasks', {
    requestId: 'attention-invalid', goal: '核对来源及总结', dispatch: false,
    plan: { nodes: [
      { id: 'root', title: '主线', mode: 'parallel' },
      { id: 'source', parentId: 'root', title: '来源', instruction: '核对已授权资料' },
      { id: 'summary', parentId: 'root', title: '总结', instruction: '依据来源总结', dependsOn: ['source'] },
    ] },
  })
  expect(response.status).toBe(200)
  const id = response.body.ticketId as string, view = () => h.runtime.hmm.view(controller, id)
  const document = h.runtime.hmm.importEvidence(controller, id, view().revision, {
    id: 'source-document', title: '依据', origin: '合成来源', text: 'PRIVATE_SOURCE_TEXT', nodeIds: ['source'],
  }).document
  const { lease } = h.runtime.hmm.apply(controller, id, view().revision, { action: 'start', nodeId: 'source' })
  const receipt = h.runtime.hmm.readEvidence(controller, id, 'source', { id: document.id, version: document.version })
  h.runtime.hmm.apply(controller, id, view().revision, {
    action: 'complete', nodeId: 'source', lease: lease!, summary: '核对完来源', evidenceRefs: [receipt.ref],
  })
  h.runtime.hmm.revokeEvidence(controller, id, view().revision, document.id)
  const detail = (await h.api('GET', `tasks/${id}`)).body as ApiResponse<'GET tasks/:id'>
  expect(detail).toMatchObject({ activity: 'attention', workflow: {
    referenceIntegrity: 'invalid', dependencyBlockers: { total: 1 },
  } })
  const before = h.runtime.store.get(KV.hmm.workflow(id))
  expect((await list()).items).toMatchObject([{ ticketId: id, activity: 'attention', attentionReason: 'reference_invalid' }])
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('游标按创建顺序跨页，新增、停止及重启不会使剩余历史重复或跳页', async () => {
  const ids: string[] = []
  for (const name of ['a', 'b', 'c', 'd']) ids.push(await task(name))
  const first = await list('limit=2')
  expect(first.items.map(item => item.ticketId)).toEqual([ids[3], ids[2]])
  expect(first.nextBefore).toBe(ids[2])
  const arrival = await task('arrival')
  expect(await h.api('POST', `tickets/${ids[2]}/stop`)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  await h.restart()
  const next = await list(`limit=2&before=${first.nextBefore}`)
  expect(next.items.map(item => item.ticketId)).toEqual([ids[1], ids[0]])
  expect(next.nextBefore).toBeNull()
  expect((await list('limit=1')).items[0]!.ticketId).toBe(arrival)
})

it('默认只列未结束任务，已结束与全部筛选保留完成和停止的真实区别', async () => {
  const completed = await task('completed')
  await finish(completed)
  const stopped = await task('stopped', 'multi')
  await h.api('POST', `tickets/${stopped}/stop`)
  await h.runtime.idle()
  const open = await task('open')
  expect((await list()).items.map(item => item.ticketId)).toEqual([open])
  expect((await list('state=ended')).items).toMatchObject([
    { ticketId: stopped, ended: { by: 'human', outcome: 'stopped' } },
    { ticketId: completed, ended: { outcome: 'completed' } },
  ])
  expect((await list('state=all')).items.map(item => item.ticketId)).toEqual([open, stopped, completed])
})

it('待回答筛选跨页寻找旧任务，回答和重启后仍按创建游标定位且不复制问题正文', async () => {
  const older = await task('older-question'), normal = await task('normal'), newer = await task('newer-question')
  const ask = (id: string) => h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision,
    question: 'PRIVATE_QUESTION_BODY', choices: ['PRIVATE_CHOICE_A', 'PRIVATE_CHOICE_B'] })
  ask(older)
  const asked = ask(newer)
  await h.runtime.idle()
  const before = [older, normal, newer].map(id => h.runtime.store.tickets.get(id))
  const workflows = [older, normal, newer].map(id => h.runtime.store.get(KV.hmm.workflow(id)))
  const launches = h.nodeFactory.mock.calls.length
  const open = await list()
  expect(open.items.map(item => [item.ticketId, item.needsAnswer])).toEqual([
    [newer, true], [normal, false], [older, true],
  ])
  const first = await list('state=needs_answer&limit=1')
  expect(first).toMatchObject({ items: [{ ticketId: newer, needsAnswer: true }], nextBefore: newer })
  expect(JSON.stringify(first)).not.toContain('PRIVATE_')
  expect(await list('state=needs_answer&limit=1')).toEqual(first)
  expect(await h.runTool(h.runtime.masterId, 'hmm_tasks', { state: 'needs_answer' }))
    .toEqual(await list('state=needs_answer&limit=8'))
  expect([older, normal, newer].map(id => h.runtime.store.tickets.get(id))).toEqual(before)
  expect([older, normal, newer].map(id => h.runtime.store.get(KV.hmm.workflow(id)))).toEqual(workflows)
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)

  expect(await h.api('POST', `tasks/${newer}/inputs`, {
    requestId: 'answered', questionId: asked.question!.id, text: '采用其他方案',
  })).toMatchObject({ status: 200 })
  await h.runtime.idle()
  await h.restart()
  const next = await list(`state=needs_answer&limit=1&before=${first.nextBefore}`)
  expect(next).toMatchObject({ items: [{ ticketId: older, needsAnswer: true }], nextBefore: null })
  expect((await list()).items.find(item => item.ticketId === newer)?.needsAnswer).toBe(false)
  const attention = h.runtime.store.tickets.get(older)!.attention
  await h.api('POST', `tasks/${older}/stop`)
  const ended = h.runtime.store.tickets.get(older)!
  // 兼容旧记录仍残留问题的情况，终态不能出现在待回答列表。
  h.runtime.store.tickets.save({ ...ended, attention })
  expect(await list('state=needs_answer')).toEqual({ items: [], nextBefore: null })
  expect((await list('state=all')).items.find(item => item.ticketId === older))
    .toMatchObject({ needsAnswer: false, ended: { outcome: 'stopped' } })
})

it('全局暂停仍列出待回答任务，撤回问题后移除，其他来源的待回答工单仍不可见', async () => {
  const id = await task('paused-question')
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  const asked = h.runtime.tasks.ask(id, { revision: h.runtime.hmm.view(controller, id).revision, question: 'PRIVATE_QUESTION' })
  const ticket = h.runtime.store.tickets.get(id)!
  h.runtime.store.tickets.save({ ...ticket, id: 'foreign-question', mandate: {
    ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' },
  } })
  expect((await list('state=needs_answer')).items.map(item => item.ticketId)).toEqual([id])
  expect(await h.api('GET', 'tasks?state=needs_answer&before=foreign-question'))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  h.runtime.tasks.ask(id, { revision: asked.revision, question: null })
  expect(await list('state=needs_answer')).toEqual({ items: [], nextBefore: null })
  expect(h.runtime.store.settings().paused).toBe(true)
})

it.each(['open', 'needs_answer'] as const)('重读 %s 后续页反映成员变化，原游标仍可用且读取不唤醒执行', async state => {
  const older = await task(`tail-${state}`), anchor = await task(`anchor-${state}`), newest = await task(`head-${state}`)
  if (state === 'needs_answer') {
    for (const id of [older, anchor, newest]) h.runtime.tasks.ask(id, {
      revision: h.runtime.hmm.view(controller, id).revision, question: '确认此次范围',
    })
    await h.runtime.idle()
  }
  const first = await list(`state=${state}&limit=2`)
  expect(first.nextBefore).toBe(anchor)
  const query = `state=${state}&limit=2&before=${first.nextBefore}`
  expect((await list(query)).items.map(item => item.ticketId)).toEqual([older])
  if (state === 'open') {
    expect(await h.api('POST', `tasks/${older}/stop`)).toMatchObject({ status: 200 })
  } else {
    const question = h.runtime.store.tickets.get(older)!.attention!
    expect(await h.api('POST', `tasks/${older}/inputs`, {
      requestId: 'tail-answer', questionId: question.id, text: '已确认范围',
    })).toMatchObject({ status: 200 })
  }
  await h.runtime.idle()
  const launches = h.nodeFactory.mock.calls.length
  const workflow = h.runtime.store.get(KV.hmm.workflow(older))
  expect(await list(query)).toEqual({ items: [], nextBefore: null })
  expect((await list(`state=${state}&limit=2`)).items.map(item => item.ticketId)).toEqual([newest, anchor])
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  expect(h.runtime.store.get(KV.hmm.workflow(older))).toEqual(workflow)
})

it('仓库工单不能进入本地任务列表，也不能作为其翻页游标', async () => {
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('foreign-list', '@bot 检查仓库问题'))
  const local = await task('local-in-repository')
  expect((await list('state=all')).items.map(item => item.ticketId)).toEqual([local])
  expect(await h.api('GET', `tasks?before=${ticket.id}`)).toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  expect(await h.api('GET', 'tasks?before=missing')).toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
})

it('列表有默认页限且不携带历史正文、目标、节点指令、会话或知识授权', async () => {
  const secret = 'PRIVATE_TASK_CONTENT_'.repeat(90)
  const ids = h.runtime.store.atomic(() => Array.from({ length: 23 }, (_, index) => h.runtime.tasks.create({
    requestId: `bounded-${index}`, title: `有界任务 ${index}`, goal: secret, mode: 'single',
  }).ticketId))
  await h.runtime.idle()
  await h.api('POST', `tasks/${ids[0]}/inputs`, { requestId: 'detail', text: secret })
  await h.runtime.idle()
  const before = h.runtime.store.get(KV.hmm.workflow(ids[0]!))
  const page = await list()
  expect(page.items).toHaveLength(20)
  expect(page.nextBefore).toBe(page.items.at(-1)!.ticketId)
  const all = await list('state=all&limit=50')
  expect(all.items).toHaveLength(23)
  expect(all.nextBefore).toBeNull()
  const text = JSON.stringify(all)
  expect(text).not.toMatch(/PRIVATE_TASK_CONTENT_|instruction|sessionId|deviceGrants|evidenceRefs/)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(8192)
  expect(h.runtime.store.get(KV.hmm.workflow(ids[0]!))).toEqual(before)
})

it.each(['limit=0', 'limit=51', 'limit=-1', 'limit=1.5', 'limit=bad', 'state=working', 'before=', 'offset=1'])(
  '无效分页参数拒绝而不静默改写：%s', async query => {
    expect(await h.api('GET', `tasks?${query}`)).toMatchObject({ status: 400 })
  },
)

it('重建总管后可按需发现任务并读取上下文，不依赖旧会话或启动节点', async () => {
  const masterId = h.runtime.masterId
  expect(await h.runTool(masterId, 'hmm_tasks', {})).toEqual({ items: [], nextBefore: null })
  const ids = Array.from({ length: 10 }, (_, index) => h.runtime.tasks.create({
    requestId: `controller-discovery-${index}`, title: '任务'.repeat(80),
    goal: 'PRIVATE_GOAL_AND_INPUT', mode: 'single', dispatch: false,
  }).ticketId)
  await h.runtime.idle()
  const before = ids.map(id => h.runtime.store.get(KV.hmm.workflow(id)))
  const oldAgent = h.agents.get(masterId)!
  h.agents.delete(masterId)
  h.ctx.emit('agent/disposed', { agent: oldAgent } as never)
  await h.runtime.sessions.ensure(masterId, h.directory, 'Restored controller', 'orchestrator')
  expect(h.agents.get(masterId)).not.toBe(oldAgent)
  const page = await h.runTool(masterId, 'hmm_tasks', {}) as unknown as ApiResponse<'GET tasks'>
  expect(page.items.map(item => item.ticketId)).toEqual(ids.slice(2).reverse())
  expect(page.nextBefore).toBe(ids[2])
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(8192)
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|instruction|sessionId|deviceGrants|evidenceRefs/)
  const next = await h.runTool(masterId, 'hmm_tasks', { before: page.nextBefore }) as unknown as ApiResponse<'GET tasks'>
  expect(next.items.map(item => item.ticketId)).toEqual(ids.slice(0, 2).reverse())
  expect(next.nextBefore).toBeNull()
  expect(await h.runTool(masterId, 'hmm_read', { ticket_id: page.items[0]!.ticketId }))
    .toMatchObject({ goal: 'PRIVATE_GOAL_AND_INPUT', autoRun: false })
  expect(ids.map(id => h.runtime.store.get(KV.hmm.workflow(id)))).toEqual(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('总管目录跨重启翻页，新增任务及已结束状态不改变历史游标含义', async () => {
  const first = await task('controller-first')
  await finish(first)
  const second = await task('controller-second')
  await h.api('POST', `tickets/${second}/stop`)
  await h.runtime.idle()
  const third = await task('controller-third')
  const page = await h.runTool(h.runtime.masterId, 'hmm_tasks', { state: 'all', limit: 1 }) as unknown as ApiResponse<'GET tasks'>
  expect(page.items.map(item => item.ticketId)).toEqual([third])
  expect(page.nextBefore).toBe(third)
  const arrived = await task('controller-arrival')
  await h.restart()
  await h.runtime.idle()
  const next = await h.runTool(h.runtime.masterId, 'hmm_tasks',
    { state: 'all', limit: 2, before: page.nextBefore }) as unknown as ApiResponse<'GET tasks'>
  expect(next.items).toMatchObject([
    { ticketId: second, ended: { outcome: 'stopped' } },
    { ticketId: first, ended: { outcome: 'completed' } },
  ])
  expect(next.nextBefore).toBeNull()
  const open = await h.runTool(h.runtime.masterId, 'hmm_tasks', {}) as unknown as ApiResponse<'GET tasks'>
  expect(open.items.map(item => item.ticketId)).toEqual([arrived, third])
  expect(await h.runTool(h.runtime.masterId, 'hmm_tasks', { state: 'ended' }))
    .toEqual(await list('state=ended&limit=8'))
})

it('总管目录拒绝越界参数和非本地游标，节点不能枚举其他任务', async () => {
  const id = await task('controller-scope')
  const ticket = h.runtime.store.tickets.get(id)!
  const foreign = { ...ticket, id: 'foreign-task', mandate: {
    ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' },
  } }
  h.runtime.store.tickets.save(foreign)
  const master = h.runtime.masterId
  expect(await h.runTool(master, 'hmm_tasks', {})).toMatchObject({ items: [{ ticketId: id }], nextBefore: null })
  await expect(h.runTool(master, 'hmm_tasks', { before: foreign.id })).rejects.toMatchObject({ code: 'scope_denied' })
  await expect(h.runTool(master, 'hmm_tasks', { before: 'absent' })).rejects.toMatchObject({ code: 'ticket_missing' })
  for (const input of [{ limit: 0 }, { limit: 9 }, { limit: 1.5 }, { limit: '2' }, { state: 'running' },
    { before: '' }, { offset: 1 }, { actor: 'admin' }, { state: 'all', dispatch: true }])
    await expect(h.runTool(master, 'hmm_tasks', input)).rejects.toThrow()
  const sessionId = h.runtime.hmm.view(controller, id).nodes.find(node => node.mode === 'task')!.sessionId!
  expect(h.tools.get(sessionId)?.has('hmm_tasks')).toBe(false)
  await expect(h.runTool(sessionId, 'hmm_tasks', {})).rejects.toThrow()
  const definition = h.tools.get(master)!.get('hmm_tasks')!
  const abort = new AbortController()
  abort.abort()
  await expect(definition.execute({}, { signal: abort.signal })).rejects.toThrow()
})

it('目录只读取当前页的状态，不组装完整详情、不改变状态或唤醒执行', async () => {
  const ids = Array.from({ length: 5 }, (_, index) => h.runtime.tasks.create({
    requestId: `activity-page-${index}`, goal: 'PRIVATE_ACTIVITY_GOAL', title: `状态 ${index}`, dispatch: false,
  }).ticketId)
  const view = vi.spyOn(h.runtime.hmm, 'view')
  const status = vi.spyOn(h.runtime.tasks, 'status')
  const activity = vi.spyOn(h.runtime.hmm, 'activity')
  const before = ids.map(id => h.runtime.store.get(KV.hmm.workflow(id)))
  const launches = h.nodeFactory.mock.calls.length
  try {
    const page = await list('limit=2')
    expect(page.items.map(item => [item.ticketId, item.activity])).toEqual([
      [ids[4], 'held'], [ids[3], 'held'],
    ])
    expect(activity.mock.calls.map(([, id]) => id)).toEqual([ids[4], ids[3]])
    expect(view).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|sessionId|instruction|deviceGrants|history/)
    expect(ids.map(id => h.runtime.store.get(KV.hmm.workflow(id)))).toEqual(before)
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  } finally { view.mockRestore(); status.mockRestore(); activity.mockRestore() }
})

it.each(['资料', '%', '_', '\\', "' OR 1=1 --"])('名称搜索按字面匹配%s，不搜索正文，也不扩展到其他来源', async query => {
  const matching = h.runtime.tasks.create({ requestId: 'search-match', title: `前缀 ${query} 后缀`,
    goal: 'PRIVATE_MATCHING_GOAL', dispatch: false }).ticketId
  h.runtime.tasks.create({ requestId: 'search-body', title: 'Unrelated title',
    goal: `PRIVATE_GOAL_ONLY ${query}`, dispatch: false })
  const original = h.runtime.store.tickets.get(matching)!
  h.runtime.store.tickets.save({ ...original, id: 'foreign-search-match', mandate: {
    ...original.mandate, actor: { ...original.mandate.actor, source: 'github' },
  } })
  const workflow = h.runtime.store.get(KV.hmm.workflow(matching))
  const page = await list(`q=${encodeURIComponent(`  ${query}  `)}&limit=1`)
  expect(page.items.map(item => item.ticketId)).toEqual([matching])
  expect(page.nextBefore).toBeNull()
  expect(await h.runTool(h.runtime.masterId, 'hmm_tasks', { q: query, limit: 1 })).toEqual(page)
  expect(await h.api('GET', `tasks?q=${encodeURIComponent(query)}&before=foreign-search-match`))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|instruction|sessionId|deviceGrants/)
  expect(h.runtime.store.get(KV.hmm.workflow(matching))).toEqual(workflow)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('名称搜索与状态、创建游标共同生效，跨重启翻页仍找到旧任务且不混入新到达项', async () => {
  const make = (requestId: string, title: string) => h.runtime.tasks.create({
    requestId, title, goal: 'PRIVATE_SEARCH_GOAL', dispatch: false,
  }).ticketId
  const older = make('search-older', '交付旧任务')
  make('search-unmatched', '其他任务')
  const ended = make('search-ended', '交付已结束任务')
  const newer = make('search-newer', '交付新任务')
  await h.api('POST', `tickets/${ended}/stop`)
  h.runtime.tasks.ask(older, { revision: h.runtime.hmm.view(controller, older).revision, question: 'PRIVATE_SEARCH_QUESTION' })
  const first = await list(`q=${encodeURIComponent('交付')}&limit=1`)
  expect(first).toMatchObject({ items: [{ ticketId: newer }], nextBefore: newer })
  const arrival = make('search-arrival', '交付后来任务')
  await h.restart()
  const second = await list(`q=${encodeURIComponent('交付')}&before=${first.nextBefore}&limit=1`)
  expect(second).toMatchObject({ items: [{ ticketId: older, needsAnswer: true }], nextBefore: null })
  expect(second.items.some(item => item.ticketId === arrival)).toBe(false)
  expect((await list(`state=needs_answer&q=${encodeURIComponent('交付')}`)).items.map(item => item.ticketId)).toEqual([older])
  expect((await list(`state=ended&q=${encodeURIComponent('交付')}`)).items.map(item => item.ticketId)).toEqual([ended])
  expect((await list(`q=${encodeURIComponent('无匹配名称')}`))).toEqual({ items: [], nextBefore: null })
  expect(JSON.stringify(second)).not.toMatch(/PRIVATE_/)
})

it('名称搜索在分页限额前筛选，只读取命中页状态，不遍历完整任务详情', async () => {
  const matching = h.runtime.tasks.create({ requestId: 'search-early', title: 'Needle task',
    goal: 'PRIVATE_EARLY_GOAL', dispatch: false }).ticketId
  for (let index = 0; index < 20; index++) h.runtime.tasks.create({
    requestId: `search-decoy-${index}`, title: `Other task ${index}`, goal: 'PRIVATE_DECOY_GOAL', dispatch: false,
  })
  const activity = vi.spyOn(h.runtime.hmm, 'activity'), view = vi.spyOn(h.runtime.hmm, 'view')
  const status = vi.spyOn(h.runtime.tasks, 'status')
  try {
    expect((await list('q=Needle&limit=1')).items.map(item => item.ticketId)).toEqual([matching])
    expect(activity.mock.calls.map(([, id]) => id)).toEqual([matching])
    expect(view).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
    expect(h.nodeFactory).not.toHaveBeenCalled()
  } finally { activity.mockRestore(); view.mockRestore(); status.mockRestore() }
})

it('空关键词保持原目录行为，超长和非文本关键词被现有参数校验拒绝', async () => {
  const id = h.runtime.tasks.create({ requestId: 'search-validation', title: 'Stable task',
    goal: 'Keep current scope', dispatch: false }).ticketId
  expect(await list('q=%20%20')).toEqual(await list())
  const before = h.runtime.store.get(KV.hmm.workflow(id))
  expect(await h.api('GET', `tasks?q=${'x'.repeat(101)}`)).toMatchObject({ status: 400 })
  for (const q of ['x'.repeat(101), 123, ['Stable']])
    await expect(h.runTool(h.runtime.masterId, 'hmm_tasks', { q })).rejects.toThrow()
  expect(await h.api('GET', 'tasks?q=Stable&before=absent')).toMatchObject({ status: 404 })
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('缺计划或未知版本不隐藏任务，未知明确显示；存储异常仍报告失败', async () => {
  const absent = await task('missing-plan'), future = await task('future-plan')
  h.runtime.store.delete(KV.hmm.workflow(absent))
  h.runtime.store.db.prepare("UPDATE kv SET value=json_set(value,'$.schemaVersion',99) WHERE key=?")
    .run(KV.hmm.workflow(future))
  expect((await list()).items.map(row => [row.ticketId, row.activity])).toEqual([
    [future, 'unknown'], [absent, 'unknown'],
  ])
  const failure = vi.spyOn(h.runtime.hmm, 'activity').mockImplementation(() => { throw new Error('state read unavailable') })
  try { expect(() => h.runtime.tasks.list()).toThrow('state read unavailable') }
  finally { failure.mockRestore() }
  // 异常历史状态保留在本次断言中；关闭夹具前只删除本测试伪造的未来格式。
  h.runtime.store.delete(KV.hmm.workflow(future))
})

it('历史结束状态不需要重新读取计划，也不能被残留待回答标记覆盖', async () => {
  const id = await task('ended-activity')
  await h.api('POST', `tasks/${id}/stop`)
  await h.runtime.idle()
  h.runtime.store.delete(KV.hmm.workflow(id))
  expect((await list('state=all')).items).toMatchObject([
    { ticketId: id, activity: 'ended', needsAnswer: false, ended: { outcome: 'stopped' } },
  ])
})
