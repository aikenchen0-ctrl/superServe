import { afterEach, beforeEach, expect, it } from 'vitest'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(requestId: string) {
  const response = await h.api('POST', 'tasks', {
    requestId, title: 'Review the comparison', goal: 'PRIVATE_RECOVERY_GOAL', mode: 'single', dispatch: false,
  })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  return response.body.ticketId as string
}

it.each(['missing', 'future'] as const)('计划%s不能读取时仍可讨论原任务，只注入身份且原样重试不重复', async situation => {
  const id = await task(`read-${situation}`), other = await task('other-task')
  if (situation === 'missing') h.runtime.store.delete(KV.hmm.workflow(id))
  else h.runtime.store.db.prepare("UPDATE kv SET value=json_set(value,'$.schemaVersion',99) WHERE key=?")
    .run(KV.hmm.workflow(id))
  try {
    const ticket = h.runtime.store.tickets.get(id)
    const workflows = [id, other].map(id => h.runtime.store.get(KV.hmm.workflow(id)))
    const agent = h.agents.get(h.runtime.masterId)!, injected = agent.inject.mock.calls.length
    const deliveries = h.deliveries.mock.calls.length
    expect(await h.api('GET', `tasks/${id}`)).toMatchObject({
      status: situation === 'missing' ? 404 : 409,
      body: { code: situation === 'missing' ? 'workflow_missing' : 'schema_unsupported' },
    })
    expect(agent.inject.mock.calls).toHaveLength(injected)
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await h.api('POST', `tasks/${id}/discuss`, { requestId: 'read-recovery' }))
        .toMatchObject({ status: 200, body: { ticketId: id, sessionId: h.runtime.masterId } })
    expect(agent.inject.mock.calls).toHaveLength(injected + 1)
    const message = agent.inject.mock.calls.at(-1)![0]
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(JSON.parse(text)).toMatchObject({ kind: 'hmm_task_context', ticket_id: id })
    expect(text).not.toMatch(/PRIVATE_|summary|resultRef|sessionId/)
    expect(text).not.toContain(other)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1024)
    expect(h.runtime.store.tickets.get(id)).toEqual(ticket)
    expect([id, other].map(id => h.runtime.store.get(KV.hmm.workflow(id)))).toEqual(workflows)
    expect(agent.status).toBe('idle')
    expect(h.deliveries.mock.calls).toHaveLength(deliveries)
    expect(h.nodeFactory).not.toHaveBeenCalled()
  } finally {
    if (situation === 'future') h.runtime.store.delete(KV.hmm.workflow(id))
  }
})

it('没有计划不能绕过本地任务身份检查，来源越界或任务缺失不写讨论背景', async () => {
  const id = await task('foreign-task'), ticket = h.runtime.store.tickets.get(id)!
  h.runtime.store.tickets.save({ ...ticket, mandate: {
    ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' },
  } })
  h.runtime.store.delete(KV.hmm.workflow(id))
  const agent = h.agents.get(h.runtime.masterId)!, injected = agent.inject.mock.calls.length
  expect(await h.api('POST', `tasks/${id}/discuss`, { requestId: 'foreign-read' }))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
  expect(await h.api('POST', 'tasks/absent/discuss', { requestId: 'missing-read' }))
    .toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  expect(agent.inject.mock.calls).toHaveLength(injected)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})
