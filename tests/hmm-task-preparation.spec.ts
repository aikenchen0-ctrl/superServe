import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { LocalTaskInput } from '../src/app/local-tasks.ts'
import { key } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
const custom = { maxActive: 1, nodes: [
  { id: 'checks', title: 'Checks', mode: 'serial' as const },
  { id: 'inspect', parentId: 'checks', title: 'Inspect source', instruction: 'Read the permitted source', evidenceRequired: true },
] }
const variants = [
  ['single', { mode: 'single' as const }],
  ['multi', { mode: 'multi' as const }],
  ['custom', { plan: custom }],
] as const

beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function prepare(extra: Record<string, unknown> = {}) {
  const input = { requestId: 'prepare-sources', goal: 'Inspect the permitted source', dispatch: false, plan: custom, ...extra }
  const response = await h.api('POST', 'tasks', input)
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  return { input, id, view }
}

it.each(variants)('%s 计划可先创建而不派发，授权就绪后沿用现有命令启动', async (_mode, variant) => {
  const response = await h.api('POST', 'tasks',
    { requestId: 'prepare-variant', goal: 'Prepare source access', dispatch: false, ...variant })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  expect(view()).toMatchObject({ phase: 'active', autoRun: false, initialDispatch: false })
  expect(view().nodes.every(node => node.state === 'pending' && node.attempt === 0 && !node.sessionId)).toBe(true)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  const nodeId = view().nodes.find(node => node.mode === 'task')!.id
  const granted = await h.api('POST', `tickets/${id}/hmm/device-grants`,
    { revision: view().revision, grant: { id: 'permitted-files', nodeId, deviceId: 'offline-handset', domain: 'files' } })
  expect(granted.status).toBe(200)
  await h.runtime.idle()
  expect(view().autoRun).toBe(false)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  const dispatched = await h.api('POST', `tickets/${id}/hmm/commands`,
    { revision: view().revision, command: { action: 'dispatch' } })
  expect(dispatched.status).toBe(200)
  await h.runtime.idle()
  expect(view().nodes.find(node => node.id === nodeId)).toMatchObject({ state: 'running', attempt: 1 })
  expect(h.nodeFactory).toHaveBeenCalledOnce()
  expect(await h.api('GET', `tasks/${id}`)).toMatchObject({
    status: 200, body: { workflow: { autoRun: true, progress: { running: 1 } } },
  })
})

it('创建重试按初始派发选择判定，之后启动或结束不被旧请求停止或重新启动', async () => {
  const run = await prepare()
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await h.api('POST', 'tasks', run.input)).toMatchObject({ status: 200, body: { created: false } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  for (const dispatch of [undefined, true]) {
    expect(await h.api('POST', 'tasks', { ...run.input, dispatch }))
      .toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  }
  await h.api('POST', `tickets/${run.id}/hmm/commands`,
    { revision: run.view().revision, command: { action: 'dispatch' } })
  await h.runtime.idle()
  const running = h.runtime.store.get(KV.hmm.workflow(run.id))
  expect(await h.api('POST', 'tasks', run.input)).toMatchObject({ status: 200, body: { created: false } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(running)
  expect(h.nodeFactory).toHaveBeenCalledOnce()
  await h.api('POST', `tickets/${run.id}/stop`)
  await h.runtime.idle()
  expect(await h.api('POST', 'tasks', run.input)).toMatchObject({ status: 200, body: { created: false, ended: { outcome: 'stopped' } } })
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it('重启和计划修订不会把未派发任务变成自动执行，也不重置首次请求语义', async () => {
  const run = await prepare()
  const definition = h.runtime.hmm.definition(controller, run.id)
  expect(await h.api('POST', `tickets/${run.id}/hmm/revisions`, {
    revision: definition.revision, reason: 'Clarify the permitted source',
    plan: { ...definition.plan, nodes: definition.plan.nodes.map(node =>
      node.id === 'inspect' ? { ...node, instruction: 'Inspect the newly specified source' } : node) },
  })).toMatchObject({ status: 200, body: { applied: true } })
  const before = h.runtime.store.get(KV.hmm.workflow(run.id))
  await h.restart()
  await h.runtime.idle()
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(await h.api('POST', 'tasks', run.input)).toMatchObject({ status: 200, body: { created: false } })
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))).toEqual(before)
})

it('历史任务缺少首次派发字段时仍按立即执行解释，不能借重试改成手动', async () => {
  const input: LocalTaskInput = { requestId: 'prepare-legacy', goal: 'Preserve the historical default', mode: 'single' }
  const response = await h.api('POST', 'tasks', input)
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  expect(h.runtime.store.get(KV.hmm.workflow(id))!.initialDispatch).toBeUndefined()
  expect(await h.api('POST', 'tasks', { ...input, dispatch: true })).toMatchObject({ status: 200, body: { created: false } })
  expect(await h.api('POST', 'tasks', { ...input, dispatch: false })).toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it.each([false, true])('未知创建结果按原请求重放；暂停不阻止找回已创建工单，也不会新建第二张（已创建：%s）', async committed => {
  const input = { requestId: 'uncertain-create', title: '核对范围', goal: '只核对授权资料', mode: 'single' as const }
  if (committed) expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 200, body: { created: true } })
  else {
    const run = h.runtime.hmm.run.bind(h.runtime.hmm)
    const fail = vi.spyOn(h.runtime.hmm, 'run').mockImplementationOnce((...args) => {
      run(...args)
      throw new Error('模拟创建事务失败')
    })
    expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 500 })
    fail.mockRestore()
  }
  await h.runtime.idle()
  const id = key('local-task', input.requestId)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  await h.restart()
  const oldTicket = h.runtime.store.tickets.get(id), oldWorkflow = h.runtime.store.get(KV.hmm.workflow(id))
  const launches = h.nodeFactory.mock.calls.length
  const pausedRetry = await h.api('POST', 'tasks', input)
  if (committed) {
    expect(pausedRetry).toMatchObject({ status: 200, body: { created: false, ticketId: id } })
    expect(h.runtime.store.tickets.get(id)).toEqual(oldTicket)
    expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(oldWorkflow)
  } else {
    expect(pausedRetry).toMatchObject({ status: 409, body: { code: 'paused' } })
    expect(h.runtime.store.tickets.get(id)).toBeUndefined()
  }
  expect(h.nodeFactory).toHaveBeenCalledTimes(launches)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
  expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 200, body: { created: !committed, ticketId: id } })
  await h.runtime.idle()
  const current = h.runtime.store.get(KV.hmm.workflow(id))
  expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 200, body: { created: false, ticketId: id } })
  for (const changed of [{ goal: '其他目标' }, { title: '其他标题' }, { mode: 'multi' }])
    expect(await h.api('POST', 'tasks', { ...input, ...changed })).toMatchObject({ status: 409, body: { code: 'request_conflict' } })
  expect(h.runtime.store.get(KV.hmm.workflow(id))).toEqual(current)
  expect((await h.api('GET', 'tasks?state=all')).body.items).toEqual([expect.objectContaining({ ticketId: id })])
})

it('未派发不绕过暂停、计划校验或事务失败，也不隐式创建知识权限', async () => {
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  expect(await h.api('POST', 'tasks', { requestId: 'prepare-paused', goal: 'Do not bypass pause', dispatch: false }))
    .toMatchObject({ status: 409, body: { code: 'paused' } })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: false })
  const input = { requestId: 'prepare-invalid', goal: 'Reject invalid preparation', dispatch: false, plan: custom }
  expect(await h.api('POST', 'tasks', { ...input, plan: { ...custom,
    nodes: custom.nodes.map(node => node.id === 'inspect' ? { ...node, dependsOn: ['missing'] } : node) } }))
    .toMatchObject({ status: 404, body: { code: 'node_missing' } })
  for (const dispatch of ['false', null, 0]) {
    expect(await h.api('POST', 'tasks', { ...input, dispatch })).toMatchObject({ status: 400 })
  }
  expect(await h.api('POST', 'tasks', { ...input, deviceGrants: [{ id: 'forged' }] })).toMatchObject({ status: 400 })
  const original = h.runtime.hmm.runPlan.bind(h.runtime.hmm)
  const write = vi.spyOn(h.runtime.hmm, 'runPlan').mockImplementationOnce((...args) => {
    original(...args)
    throw new Error('模拟计划持久化后失败')
  })
  expect(await h.api('POST', 'tasks', input)).toMatchObject({ status: 500 })
  write.mockRestore()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.open()).toEqual([])
  expect(h.runtime.store.keys(KV.hmm.workflow)).toEqual([])
  expect(h.nodeFactory).not.toHaveBeenCalled()
  const valid = await prepare()
  expect(valid.view().deviceGrants).toEqual([])
})

it('准备期间修改授权版本后，旧派发请求被拒绝且不消耗执行次数', async () => {
  const run = await prepare()
  const revision = run.view().revision
  expect(await h.api('POST', `tickets/${run.id}/hmm/device-grants`,
    { revision, grant: { id: 'allowed', nodeId: 'inspect', deviceId: 'handset', domain: 'files' } }))
    .toMatchObject({ status: 200 })
  expect(await h.api('POST', `tickets/${run.id}/hmm/commands`, { revision, command: { action: 'dispatch' } }))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  await h.runtime.idle()
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(run.view().nodes.every(node => node.state === 'pending' && node.attempt === 0)).toBe(true)
})

it('文档中的设备取证计划可通过公开入口创建，但不擅自授权或启动', async () => {
  const input = JSON.parse(readFileSync(new URL('../examples/hmm-prepared-task.json', import.meta.url), 'utf8'))
  expect(await h.api('POST', 'tasks', input)).toMatchObject({
    status: 200, body: { workflow: { autoRun: false, initialDispatch: false, deviceGrants: [] } },
  })
  await h.runtime.idle()
  expect(h.nodeFactory).not.toHaveBeenCalled()
})
