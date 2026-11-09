import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { KV } from '../src/kv.ts'
import type { HmmCommand } from '../src/hmm/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
const privateError = 'PRIVATE_PROVIDER_BODY api-key=DO_NOT_DISCLOSE'
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(requestId = 'failure-diagnostics') {
  const response = await h.api('POST', 'tasks', { requestId, mode: 'single', goal: 'Summarize only the supplied input' })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const node = () => view().nodes.find(node => node.mode === 'task')!
  const read = async () => (await h.api('GET', `tasks/${id}`)).body
  const command = async (command: HmmCommand) => {
    const response = await h.api('POST', `tickets/${id}/hmm/commands`, { revision: view().revision, command })
    expect(response.status).toBe(200)
    await h.runtime.idle()
  }
  const error = async (failure: unknown) => {
    const agent = h.agents.get(node().sessionId!)!
    h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: failure } as never)
    await h.runtime.idle()
  }
  return { id, view, node, read, command, error }
}

it.each(['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'QUOTA', 'ACCOUNT_QUOTA',
  'RATE_LIMIT', 'CONTEXT_WINDOW_EXCEEDED', 'NO_ADAPTER'])('模型故障 %s 通过状态和通知呈现，不复制提供方正文或自动重试', async code => {
  const run = await task()
  const created = h.nodeFactory.mock.calls.length
  const failedAgent = h.agents.get(run.node().sessionId!)!
  await run.error(new LlmError(privateError, code))
  expect(run.node()).toMatchObject({ state: 'suspended', modelFailureCode: code })
  const status = await run.read()
  expect(status).toMatchObject({ result: null, ended: null, workflow: { progress: { suspended: 1, completed: 0 },
    blockers: { total: 1, items: [{ nodeId: run.node().id, modelFailureCode: code }] } } })
  const notices = h.relays(h.runtime.masterId).filter(item => item.kind === 'hmm_attention')
  expect(notices).toContainEqual(expect.objectContaining({ ticket_id: run.id, node_id: run.node().id, modelFailureCode: code }))
  const context = h.runtime.hmm.context(controller, run.id, run.node().id)
  expect(context).toMatchObject({ modelFailureCode: code })
  expect(JSON.stringify([status, context, notices, h.runtime.store.get(KV.hmm.workflow(run.id))])).not.toContain(privateError)
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  h.ctx.emit('agent/error', { agent: failedAgent, turn: 1, step: 1, error: new LlmError(privateError, 'QUOTA') } as never)
  await h.runtime.pump()
  await h.runtime.idle()
  expect(h.nodeFactory.mock.calls).toHaveLength(created)
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'hmm_attention')).toHaveLength(1)
})

it.each([
  new Error('AUTH group_deleted ' + privateError),
  { code: 'provider_custom_error', message: privateError },
  { code: 'AUTH\n' + privateError, status: 403 },
  null,
])('未知故障 %j 不从文案或状态码猜测原因，不外传自定义错误码', async failure => {
  const run = await task()
  await run.error(failure)
  const status = await run.read()
  expect(run.node()).toMatchObject({ state: 'suspended', modelFailureCode: 'UNKNOWN' })
  expect(JSON.stringify([status, h.runtime.store.get(KV.hmm.workflow(run.id))])).not.toContain(privateError)
  expect(run.view().phase).toBe('active')
})

it('模型配置解析失败也保留稳定错误码，尚未创建的会话不被当作运行成功', async () => {
  vi.spyOn(h.ctx.llm, 'resolveCallConfig').mockRejectedValueOnce(new LlmError(privateError, 'MISSING_CREDENTIAL'))
  const run = await task()
  expect(run.node()).toMatchObject({ state: 'suspended', modelFailureCode: 'MISSING_CREDENTIAL' })
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(JSON.stringify(await run.read())).not.toContain(privateError)
})

it('诊断跨重启保留，显式恢复生成新执行并清除旧诊断，迟到错误不能污染新结果', async () => {
  const run = await task()
  const oldAgent = h.agents.get(run.node().sessionId!)!
  const oldReport = h.tools.get(oldAgent.id)!.get('hmm_node_report')!
  await h.runTool(oldAgent.id, 'hmm_node_report', { action: 'checkpoint', frame: 'REUSABLE_LOCAL_FRAME' })
  await run.error(new LlmError(privateError, 'AUTH'))
  const attempts = run.node().attempt, launches = h.nodeFactory.mock.calls.length
  await h.restart()
  await h.runtime.idle()
  expect(run.node()).toMatchObject({ state: 'suspended', modelFailureCode: 'AUTH', attempt: attempts })
  expect(h.nodeFactory.mock.calls).toHaveLength(launches)
  await run.command({ action: 'resume', nodeId: run.node().id })
  expect(run.node()).not.toHaveProperty('modelFailureCode')
  await run.command({ action: 'dispatch' })
  expect(run.node().attempt).toBe(attempts + 1)
  const fresh = run.node().sessionId!
  expect(fresh).not.toBe(oldAgent.id)
  const context = await h.runTool(fresh, 'hmm_node_context', {})
  expect(context.frame).toBe('REUSABLE_LOCAL_FRAME')
  expect(context).not.toHaveProperty('modelFailureCode')
  h.ctx.emit('agent/error', { agent: oldAgent, turn: 1, step: 1, error: new LlmError(privateError, 'QUOTA') } as never)
  await h.runtime.idle()
  expect(run.node().state).toBe('running')
  await expect(oldReport.execute({ action: 'complete', summary: 'Stale output', evidenceRefs: [context.inputRef] },
    { signal: new AbortController().signal })).rejects.toThrow()
  await h.runTool(fresh, 'hmm_node_report', { action: 'complete', summary: 'Completed from the supplied input',
    evidenceRefs: [context.inputRef] })
  await h.runtime.idle()
  await run.command({ action: 'validate', summary: 'Validated result', evidenceRefs: [run.node().resultRef!] })
  expect(await run.read()).toMatchObject({ ended: { outcome: 'completed' }, result: { summary: 'Validated result' } })
  expect(run.node()).not.toHaveProperty('modelFailureCode')
})

it('重核与计划修订清除受影响的旧诊断，不沿用为新尝试的故障', async () => {
  const run = await task()
  await run.error(new LlmError(privateError, 'AUTH'))
  await run.command({ action: 'recheck', nodeId: run.node().id, reason: 'Recheck the supplied input' })
  expect(run.node()).not.toHaveProperty('modelFailureCode')
  await run.command({ action: 'dispatch' })
  await run.error(new LlmError(privateError, 'CONTEXT_WINDOW_EXCEEDED'))
  const notices = h.relays(h.runtime.masterId).filter(item => item.kind === 'hmm_attention' && item.ticket_id === run.id)
  expect(notices.map(item => item.modelFailureCode)).toEqual(['AUTH', 'CONTEXT_WINDOW_EXCEEDED'])
  expect(notices[1]!.revision).toBe(run.view().revision)
  const definition = h.runtime.hmm.definition(controller, run.id)
  h.runtime.hmm.revise(controller, run.id, {
    revision: definition.revision, reason: 'Narrow the next attempt input',
    plan: { ...definition.plan, nodes: definition.plan.nodes.map(node => node.mode === 'task'
      ? { ...node, instruction: 'Summarize the bounded input only' } : node) },
  })
  expect(run.node()).toMatchObject({ state: 'pending' })
  expect(run.node()).not.toHaveProperty('modelFailureCode')
  expect(h.runtime.hmm.context(controller, run.id, run.node().id)).not.toHaveProperty('modelFailureCode')
})

it('模型不能伪造宿主诊断，普通挂起不靠原因文字推断错误码', async () => {
  const run = await task()
  await expect(h.runTool(run.node().sessionId!, 'hmm_node_report',
    { action: 'suspend', reason: 'AUTH', modelFailureCode: 'AUTH' })).rejects.toThrow()
  expect(await h.api('POST', `tickets/${run.id}/hmm/commands`, { revision: run.view().revision,
    command: { action: 'suspend', nodeId: run.node().id, reason: 'AUTH', modelFailureCode: 'AUTH' } }))
    .toMatchObject({ status: 400 })
  await h.runTool(run.node().sessionId!, 'hmm_node_report', { action: 'suspend', reason: 'AUTH is only reference text' })
  await h.runtime.idle()
  expect(run.node()).not.toHaveProperty('modelFailureCode')
  expect(h.runtime.store.get(KV.hmm.workflow(run.id))!.nodes.find(node => node.id === run.node().id))
    .not.toHaveProperty('modelFailureCode')
  await run.command({ action: 'resume', nodeId: run.node().id })
  await run.command({ action: 'dispatch' })
  await h.runTool(run.node().sessionId!, 'hmm_node_report', { action: 'suspend', reason: 'Still missing input' })
  await h.runtime.idle()
  const notices = h.relays(h.runtime.masterId).filter(item => item.kind === 'hmm_attention' && item.ticket_id === run.id)
  expect(notices.map(item => item.reason)).toEqual(['AUTH is only reference text', 'Still missing input'])
  expect(notices.every(item => item.modelFailureCode === undefined)).toBe(true)
})

it('一个节点的模型错误不挂起其他任务，总管错误也不能冒充节点故障', async () => {
  const first = await task(), second = await task('independent-model-task')
  const independent = second.node().sessionId!
  await first.error(new LlmError(privateError, 'AUTH'))
  expect(second.node()).toMatchObject({ state: 'running', sessionId: independent })
  h.ctx.emit('agent/error', { agent: h.agents.get(h.runtime.masterId), turn: 1, step: 1,
    error: new LlmError(privateError, 'QUOTA') } as never)
  await h.runtime.idle()
  expect(second.node().state).toBe('running')
  expect(second.node()).not.toHaveProperty('modelFailureCode')
})
