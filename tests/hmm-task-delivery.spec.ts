import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function completed(requestId: string, withClaims = false) {
  const created = await h.api('POST', 'tasks', { requestId, title: `Review ${requestId}`,
    goal: 'PRIVATE_DELIVERY_GOAL', mode: 'single' })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  await h.runtime.idle()
  const node = view().nodes.find(item => item.mode === 'task')!
  const document = h.runtime.hmm.importEvidence(controller, id, view().revision, {
    id: 'source', title: 'PRIVATE_SOURCE_TITLE', origin: 'Synthetic authorized source',
    text: 'PRIVATE_SOURCE_TEXT', nodeIds: [node.id],
  }).document
  const receipt = await h.runTool(node.sessionId!, 'hmm_evidence_read', { id: document.id, version: document.version })
  await h.runTool(node.sessionId!, 'hmm_node_report', {
    action: 'complete', summary: 'PRIVATE_STEP_RESULT', evidenceRefs: [receipt.ref],
    ...(withClaims ? { claims: [{ id: 'delivery', subject: 'Source', predicate: 'supports', object: 'Comparison',
      kind: 'extracted', evidenceRefs: [receipt.ref] }] } : {}),
  })
  await h.runtime.idle()
  if (withClaims) h.runtime.hmm.apply(controller, id, view().revision, {
    action: 'review_claims', reviews: h.runtime.hmm.claims(controller, id, undefined, {}).nodes.map(item =>
      ({ ref: item.ref, verdict: 'accept' as const, reason: 'Check the authorized source' })),
  })
  const ref = view().nodes.find(item => item.id === node.id)!.resultRef!
  h.runtime.hmm.apply(controller, id, view().revision, {
    action: 'validate', summary: 'PRIVATE_VALIDATED_RESULT', evidenceRefs: [ref],
  })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(id)!.ended?.outcome).toBe('completed')
  return { id, view }
}

async function list(query = 'state=ended') {
  const response = await h.api('GET', `tasks?${query}`)
  expect(response.status).toBe(200)
  return response.body as ApiResponse<'GET tasks'>
}

it('历史完成与当前结果分开呈现：撤回来源后目录与详情一致，不返回成果正文或重启执行', async () => {
  const run = await completed('delivery-revoked')
  expect((await list()).items[0]).not.toHaveProperty('resultAvailability')
  expect(await h.api('POST', `tickets/${run.id}/hmm/evidence/source/revoke`, { revision: run.view().revision }))
    .toMatchObject({ status: 200 })
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ status: 200, body: {
    ended: { outcome: 'completed' }, result: null, resultError: 'evidence_invalid',
  } })
  const ticket = h.runtime.store.tickets.get(run.id), workflow = h.runtime.store.get(KV.hmm.workflow(run.id))
  const launches = h.nodeFactory.mock.calls.length
  const status = vi.spyOn(h.runtime.tasks, 'status'), view = vi.spyOn(h.runtime.hmm, 'view')
  try {
    const page = await list()
    expect(page.items).toMatchObject([{ ticketId: run.id, activity: 'ended', needsAnswer: false,
      ended: { outcome: 'completed' }, resultAvailability: 'unavailable' }])
    expect(await h.runTool(h.runtime.masterId, 'hmm_tasks', { state: 'ended' })).toEqual(page)
    expect(await list('state=open')).toEqual({ items: [], nextBefore: null })
    expect(await list('state=needs_answer')).toEqual({ items: [], nextBefore: null })
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|summary|instruction|sessionId|frame|evidenceRefs|nodeId/)
    expect(status).not.toHaveBeenCalled()
    expect(view).not.toHaveBeenCalled()
    expect(h.runtime.store.tickets.get(run.id)).toEqual(ticket)
    expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(workflow)
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  } finally { status.mockRestore(); view.mockRestore() }
})

it.each(['missing', 'future'] as const)('完成记录的计划%s时只标为待核实，保留分页和历史状态；停止记录不查计划', async situation => {
  const run = await completed('delivery-unknown')
  const stopped = await h.api('POST', 'tasks', { requestId: 'delivery-stopped', goal: 'Keep a bounded scope', dispatch: false })
  const stoppedId = stopped.body.ticketId as string
  await h.api('POST', `tasks/${stoppedId}/stop`)
  h.runtime.store.delete(KV.hmm.workflow(stoppedId))
  if (situation === 'missing') h.runtime.store.delete(KV.hmm.workflow(run.id))
  else h.runtime.store.db.prepare("UPDATE kv SET value=json_set(value,'$.schemaVersion',99) WHERE key=?")
    .run(KV.hmm.workflow(run.id))
  const check = vi.spyOn(h.runtime.hmm, 'assertResultAvailable')
  try {
    const first = await list('state=ended&limit=1')
    expect(first).toMatchObject({ items: [{ ticketId: stoppedId, activity: 'ended', ended: { outcome: 'stopped' } }],
      nextBefore: stoppedId })
    expect(check).not.toHaveBeenCalled()
    const second = await list(`state=ended&limit=1&before=${first.nextBefore}`)
    expect(second).toMatchObject({ items: [{ ticketId: run.id, activity: 'ended', needsAnswer: false,
      ended: { outcome: 'completed' }, resultAvailability: 'unknown' }], nextBefore: null })
    expect(check).toHaveBeenCalledExactlyOnceWith(controller, run.id)
    expect(second.items[0]).not.toHaveProperty('attentionReason')
  } finally {
    check.mockRestore()
    if (situation === 'future') h.runtime.store.delete(KV.hmm.workflow(run.id))
  }
})

it('只核对当前页已完成任务，搜索、来源范围与创建游标先筛选，不读取下一页成果', async () => {
  const older = await completed('older'), newer = await completed('newer')
  const ticket = h.runtime.store.tickets.get(newer.id)!
  h.runtime.store.tickets.save({ ...ticket, id: 'foreign-delivery', mandate: {
    ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' },
  } })
  const check = vi.spyOn(h.runtime.hmm, 'assertResultAvailable')
  try {
    const first = await list('state=all&limit=1')
    expect(first).toMatchObject({ items: [{ ticketId: newer.id }], nextBefore: newer.id })
    expect(check.mock.calls.map(([, id]) => id)).toEqual([newer.id])
    check.mockClear()
    expect((await list(`state=all&limit=1&before=${first.nextBefore}`)).items.map(item => item.ticketId)).toEqual([older.id])
    expect(check.mock.calls.map(([, id]) => id)).toEqual([older.id])
    check.mockClear()
    expect((await list('state=ended&q=older')).items.map(item => item.ticketId)).toEqual([older.id])
    expect(check.mock.calls.map(([, id]) => id)).toEqual([older.id])
    expect(await h.api('GET', 'tasks?state=all&before=foreign-delivery'))
      .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  } finally { check.mockRestore() }
})

it('存储故障仍报告读取失败，不伪装成结果不可用或健康完成', async () => {
  const run = await completed('delivery-storage')
  const check = vi.spyOn(h.runtime.hmm, 'assertResultAvailable').mockImplementation(() => { throw new Error('Synthetic storage read failed') })
  try {
    expect(await h.api('GET', 'tasks?state=ended')).toMatchObject({ status: 500 })
    expect(() => h.runtime.tasks.list({ state: 'ended' })).toThrow('Synthetic storage read failed')
    expect(h.runtime.store.tickets.get(run.id)!.ended?.outcome).toBe('completed')
  } finally { check.mockRestore() }
})

it.each(['missing_validation', 'unverified_phase', 'input_conflict', 'claims_unreviewed'] as const)(
  '旧完成记录的%s在目录和详情均拒绝交付，并保留具体原因与原历史', async situation => {
    const run = await completed(`legacy-${situation}`, situation === 'claims_unreviewed')
    const workflow = h.runtime.store.get(KV.hmm.workflow(run.id))!
    // 模拟旧存储缺失或过期的验收条件，不通过执行动作制造不合法状态。
    if (situation === 'missing_validation') delete workflow.validation
    else if (situation === 'unverified_phase') workflow.phase = 'active'
    else if (situation === 'input_conflict') workflow.validation!.inputVersion = 'legacy-input-version'
    else delete workflow.claimReviews
    h.runtime.store.set(KV.hmm.workflow(run.id), workflow)
    const ticket = h.runtime.store.tickets.get(run.id), launches = h.nodeFactory.mock.calls.length
    const code = situation === 'missing_validation' || situation === 'unverified_phase' ? 'workflow_unverified' : situation
    const response = await h.api('GET', `tasks/${run.id}`)
    expect(response).toMatchObject({ status: 200, body: {
      ended: { outcome: 'completed' }, activity: 'ended', result: null, resultError: code,
      workflow: { requiresOrchestrator: true },
    } })
    expect((await list()).items).toMatchObject([{ ticketId: run.id, resultAvailability: 'unavailable',
      ended: { outcome: 'completed' } }])
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|sessionId|frame|evidenceRefs/)
    expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(workflow)
    expect(h.runtime.store.tickets.get(run.id)).toEqual(ticket)
    expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  },
)
