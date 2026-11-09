import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { hmmControllerTools } from '../src/app/tools/hmm-controller.ts'
import type { Ticket } from '../src/core/model.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { HmmDispatcher } from '../src/hmm/dispatcher.ts'
import { HmmDevices } from '../src/hmm/devices.ts'
import { HmmNodeStartError, type HmmNodeRuntime, type HmmNodeStart } from '../src/hmm/node-runtime.ts'
import { HmmWorkflows } from '../src/hmm/workflow.ts'
import { HMM_LIMITS, type HmmCommand } from '../src/hmm/model.ts'

let directory: string, store: Store, effects: Effects, hmm: HmmWorkflows, dispatcher: HmmDispatcher
let lifetime: AbortController
let runtime: HmmNodeRuntime
const requests: HmmNodeStart[] = []
const handles = new Map<string, { cancel: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>()
let rejectStart = false
const actor = { role: 'controller' as const }
const ticketId = 'runtime-independent'
const view = () => hmm.view(actor, ticketId)
const command = (command: HmmCommand) => hmm.apply(actor, ticketId, view().revision, command)
const settle = () => effects.idle()
function current(nodeId: string) {
  return requests.findLast(request => request.binding.nodeId === nodeId)!
}
async function call(request: HmmNodeStart, name: string, args: unknown) {
  const tool = request.tools.find(tool => tool.name === name)!
  return await tool.execute(args, request.signal) as Record<string, unknown>
}
function addIndependentTask(id: string) {
  store.tickets.save({ ...store.tickets.get(ticketId)!, id })
  hmm.runPlan(actor, id, { goal: '独立核验', maxActive: 1, nodes: [
    { id: 'root', title: '主线', mode: 'serial' },
    { id: 'step', parentId: 'root', title: '核验', instruction: '完成限定操作' },
  ] })
}

beforeEach(() => {
  requests.length = 0; handles.clear(); rejectStart = false
  directory = mkdtempSync(join(tmpdir(), 'hmm-port-'))
  store = new Store(join(directory, 'state.sqlite'))
  store.tickets.save({ id: ticketId, title: '独立执行端口', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' },
      actor: { source: 'test', id: 'owner' }, scope: 'test' },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
    origin: { triggerId: 'e1', triggerIds: ['e1'] } } satisfies Ticket)
  lifetime = new AbortController()
  effects = new Effects(store, new HealthBoard())
  hmm = new HmmWorkflows(store, undefined, { changed: () => dispatcher?.request() })
  runtime = {
    install: () => () => {},
    start: async request => {
      request.authorize()
      if (rejectStart) throw { code: 'AUTH', message: '不得写入业务状态的原始诊断' }
      requests.push(request)
      const handle = { cancel: vi.fn(), finish: vi.fn(async (_signal: AbortSignal) => {}), dispose: vi.fn(async () => {}) }
      handles.set(request.binding.sessionId, handle)
      request.onDelivered()
      return handle
    },
  }
  dispatcher = new HmmDispatcher({ nodeRuntime: runtime, store, effects, hmm,
    hmmDevices: new HmmDevices(hmm, lifetime.signal), lifetime: lifetime.signal,
    paused: () => store.settings().paused, closing: () => false, workerCount: () => 0 })
  dispatcher.install()
  effects.start()
})
afterEach(async () => {
  lifetime.abort()
  await dispatcher.shutdown()
  await effects.drain()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

async function start() {
  hmm.runPlan(actor, ticketId, { goal: '核对题设后再检查结论', maxActive: 1, nodes: [
    { id: 'root', title: '主线', mode: 'serial' },
    { id: 'source', parentId: 'root', title: '核对', instruction: 'PRIVATE_FIRST_STEP' },
    { id: 'review', parentId: 'root', title: '检查', instruction: 'PRIVATE_SECOND_STEP', dependsOn: ['source'] },
  ] })
  await settle()
}

it('不创建 DSH 上下文也能推进业务节点、隔离投影、回写结果并验收', async () => {
  await start()
  const first = current('source')
  expect(first.prompt).not.toContain('PRIVATE_FIRST_STEP')
  expect(first.prompt).not.toContain('PRIVATE_SECOND_STEP')
  expect(JSON.stringify(first.input)).toContain('PRIVATE_FIRST_STEP')
  expect(JSON.stringify(first.input)).not.toContain('PRIVATE_SECOND_STEP')
  const context = await call(first, 'hmm_node_context', {})
  await call(first, 'hmm_node_report', { action: 'complete', summary: '已核对',
    evidenceRefs: [context.inputRef] })
  await settle()
  expect(handles.get(first.binding.sessionId)?.dispose).toHaveBeenCalledOnce()
  const second = current('review')
  expect(JSON.stringify(second.input).match(/已核对/g)).toHaveLength(1)
  const next = await call(second, 'hmm_node_context', {})
  const upstream = await call(second, 'hmm_result_read', { ref: (next.sourceResults as { ref: string }[])[0]!.ref })
  expect(upstream).toMatchObject({ nodeId: 'source', result: { summary: '已核对' } })
  await call(second, 'hmm_node_report', { action: 'complete', summary: '检查完成',
    evidenceRefs: (next.sourceResults as { ref: string }[]).map(result => result.ref) })
  await settle()
  expect(view().awaitingValidation).toBe(true)
  const result = view().nodes.find(node => node.id === 'review')!.resultRef!
  command({ action: 'validate', summary: '验收完成', evidenceRefs: [result] })
  expect(view().phase).toBe('validated')
  expect(dispatcher.activeCount()).toBe(0)
})

it('总管工具仅凭领域能力即可读取状态，资源范围检查先于宿主读取且保留取消信号', async () => {
  await start()
  const ticket = store.tickets.get(ticketId)!
  store.tickets.save({ ...ticket, executionMode: 'hmm' })
  const before = view()
  const page = { items: [{ ticketId }], nextBefore: null }
  const tasks = { list: vi.fn(() => page), ask: vi.fn() }
  const readResource = vi.fn(async (_resource: string, _offset: number, _limit: number | undefined, _signal: AbortSignal) => page)
  const tools = hmmControllerTools({ hmm, hmmDevices: new HmmDevices(hmm, lifetime.signal),
    store: { tickets: { get: id => store.tickets.get(id) } }, readResource,
    readDevelopment: vi.fn(),
  }, tasks)
  const signal = new AbortController().signal
  const execute = (name: string, args: unknown, abort = signal) => {
    const definition = tools.find(tool => tool.name === name)!
    return definition.execute(definition.schema.parse(args), abort)
  }
  expect(await execute('hmm_read', { ticket_id: ticketId })).toEqual(before)
  expect(await execute('hmm_tasks', {})).toBe(page)
  expect(tasks.list).toHaveBeenCalledExactlyOnceWith({ state: 'open', limit: 8 })
  for (const suffix of ['', '/inputs', '/input/source-1', '/result']) {
    const resource = `ticket/${ticketId}${suffix}`
    expect(await execute('orchestrator_read', { resource, offset: 3, limit: 16 })).toBe(page)
    expect(readResource).toHaveBeenLastCalledWith(resource, 3, 16, signal)
  }
  readResource.mockClear()
  for (const resource of ['settings', 'models', 'ticket/absent', 'ticket/../inputs',
    `ticket/${ticketId}/transcript`, `ticket/${ticketId}/../../settings`]) {
    await expect(execute('orchestrator_read', { resource })).rejects.toMatchObject({ code: 'scope_denied' })
  }
  store.tickets.save(ticket)
  await expect(execute('orchestrator_read', { resource: `ticket/${ticketId}` })).rejects.toMatchObject({ code: 'scope_denied' })
  store.tickets.save({ ...ticket, executionMode: 'hmm' })
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(execute('orchestrator_read', { resource: `ticket/${ticketId}` }, cancelled.signal)).rejects.toThrow()
  await expect(execute('hmm_tasks', {}, cancelled.signal)).rejects.toThrow()
  expect(readResource).not.toHaveBeenCalled()
  expect(tasks.list).toHaveBeenCalledOnce()
  expect(view()).toEqual(before)
  expect(requests).toHaveLength(1)
})

it('实例丢失保留业务检查点，恢复生成新执行，旧回调及工具不能污染新执行', async () => {
  await start()
  const old = current('source')
  await call(old, 'hmm_node_report', { action: 'checkpoint', frame: '保留的业务工作帧' })
  old.onLost()
  await settle()
  expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'suspended', attempt: 1 })
  expect(handles.get(old.binding.sessionId)?.dispose).toHaveBeenCalledOnce()
  command({ action: 'resume', nodeId: 'source' })
  command({ action: 'dispatch' })
  await settle()
  const fresh = current('source')
  expect(fresh.binding.sessionId).not.toBe(old.binding.sessionId)
  expect(JSON.stringify(fresh.input)).toContain('保留的业务工作帧')
  const revision = view().revision
  old.onError({ code: 'AUTH' }); old.onIdle(); old.onLost()
  await settle()
  expect(view().revision).toBe(revision)
  await expect(call(old, 'hmm_node_report', { action: 'checkpoint', frame: '迟到工作帧' }))
    .rejects.toThrow(/失效|aborted|中止/)
  expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'running', attempt: 2 })
})

it('暂停只拦截新启动，不撤销在途报告；执行步数由控制面限制', async () => {
  await start()
  const first = current('source')
  store.saveSettings({ ...store.settings(), paused: true })
  expect(() => first.authorize()).toThrow()
  expect(first.isCurrent()).toBe(true)
  const context = await call(first, 'hmm_node_context', {})
  await call(first, 'hmm_node_report', { action: 'complete', summary: '暂停时保留成果', evidenceRefs: [context.inputRef] })
  await settle()
  expect(requests).toHaveLength(1)
  store.saveSettings({ ...store.settings(), paused: false })
  dispatcher.request()
  await settle()
  const second = current('review')
  for (let step = 0; step < HMM_LIMITS.nodeSteps; step++) expect(second.onStep()).toBe(true)
  expect(second.onStep()).toBe(false)
  await settle()
  expect(view().nodes.find(node => node.id === 'review')?.state).toBe('suspended')
})

it('执行端口启动失败仍由控制面挂起和清理，不保存提供方原始正文', async () => {
  rejectStart = true
  await start()
  expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'suspended', modelFailureCode: 'AUTH' })
  expect(JSON.stringify(view())).not.toContain('不得写入业务状态')
  expect(dispatcher.activeCount()).toBe(0)
  expect(requests).toHaveLength(0)
})

it.each(['running', 'pruned', 'completed'] as const)('启动错误迟到时保留 %s 业务状态边界，关停等待同一次释放', async state => {
  const opening = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>()
  const original = runtime.start.bind(runtime)
  vi.spyOn(runtime, 'start').mockImplementationOnce(async request => {
    const handle = await original(request)
    await opening.promise
    throw new HmmNodeStartError({ code: 'RATE_LIMIT', message: 'PRIVATE_START_CAUSE' }, handle)
  })
  let closing: Promise<void> | undefined
  try {
    hmm.runPlan(actor, ticketId, { goal: '失败实例也须保持回收归属', maxActive: 1, nodes: [
      { id: 'root', title: '主线', mode: 'serial' },
      { id: 'source', parentId: 'root', title: '核验', instruction: '只核验给定条件' },
    ] })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const request = current('source'), handle = handles.get(request.binding.sessionId)!
    handle.dispose.mockImplementation(async () => cleanup.promise)
    if (state === 'pruned')
      command({ action: 'prune', nodeId: 'source', reason: '操作者撤回路径', reconsiderWhen: '条件改变' })
    if (state === 'completed') {
      const context = await call(request, 'hmm_node_context', {})
      await call(request, 'hmm_node_report', { action: 'complete', summary: '已提交成果', evidenceRefs: [context.inputRef] })
    }
    opening.resolve()
    await vi.waitFor(() => expect(handle.dispose).toHaveBeenCalledOnce())
    expect(view().nodes.find(node => node.id === 'source')).toMatchObject(state === 'running'
      ? { state: 'suspended', modelFailureCode: 'RATE_LIMIT' }
      : state === 'pruned' ? { state: 'pruned', reason: '操作者撤回路径' }
        : { state: 'completed', resultRef: expect.any(String) })
    expect(JSON.stringify(view())).not.toContain('PRIVATE_START_CAUSE')
    expect(request.isCurrent()).toBe(false)
    if (state !== 'completed') expect(handle.cancel).toHaveBeenCalled()
    expect(handle.finish).toHaveBeenCalledTimes(state === 'completed' ? 1 : 0)
    expect(dispatcher.activeCount()).toBe(1)

    closing = dispatcher.shutdown()
    expect(dispatcher.activeCount()).toBe(1)
    expect(handle.dispose).toHaveBeenCalledOnce()
    cleanup.resolve()
    await closing
    expect(dispatcher.activeCount()).toBe(0)
    expect(requests).toHaveLength(1)
  } finally {
    opening.resolve(); cleanup.resolve()
    await closing
    await settle()
  }
})

it('报告事务失败不进入正常结束路径，停止仍会立即取消并释放', async () => {
  await start()
  const first = current('source'), handle = handles.get(first.binding.sessionId)!
  await expect(call(first, 'hmm_node_report', { action: 'complete', summary: '无效报告', evidenceRefs: ['unknown'] }))
    .rejects.toThrow()
  expect(first.isCurrent()).toBe(true)
  command({ action: 'hold' })
  await settle()
  expect(handle.finish).not.toHaveBeenCalled()
  expect(handle.cancel).toHaveBeenCalled()
  expect(handle.dispose).toHaveBeenCalledOnce()
})

it('关停立即中断正常结束等待，已提交的业务结果仍保留', async () => {
  await start()
  const first = current('source'), handle = handles.get(first.binding.sessionId)!
  handle.finish.mockImplementation(async (signal: AbortSignal) => {
    if (signal.aborted) return
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const context = await call(first, 'hmm_node_context', {})
  await call(first, 'hmm_node_report', { action: 'complete', summary: '保留的成果', evidenceRefs: [context.inputRef] })
  await vi.waitFor(() => expect(handle.finish).toHaveBeenCalledOnce())
  expect(handle.dispose).not.toHaveBeenCalled()
  expect(handle.cancel).not.toHaveBeenCalled()
  expect(first.isCurrent()).toBe(false)
  await dispatcher.shutdown()
  expect(handle.cancel).toHaveBeenCalled()
  expect(handle.dispose).toHaveBeenCalledOnce()
  expect(view().nodes.find(node => node.id === 'source')?.state).toBe('completed')
  expect(dispatcher.activeCount()).toBe(0)
})

it.each(['start', 'finish', 'dispose'] as const)('%s 等待只占所属执行额度，不阻塞其他任务利用及再次利用空闲槽', async phase => {
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  const gate = Promise.withResolvers<void>()
  const original = runtime.start.bind(runtime)
  if (phase === 'start') vi.spyOn(runtime, 'start').mockImplementationOnce(async request => {
    const handle = await original(request)
    await gate.promise
    return handle
  })
  try {
    hmm.runPlan(actor, ticketId, { goal: '保留同计划额度', maxActive: 1, nodes: [
      { id: 'root', title: '主线', mode: 'serial' },
      { id: 'source', parentId: 'root', title: '核对', instruction: '核验条件' },
      { id: 'review', parentId: 'root', title: '检查', instruction: '检查结论', dependsOn: ['source'] },
    ] })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const first = requests[0]!, handle = handles.get(first.binding.sessionId)!
    if (phase !== 'start') {
      handle[phase].mockImplementationOnce(async () => gate.promise)
      const context = await call(first, 'hmm_node_context', {})
      await call(first, 'hmm_node_report', { action: 'complete', summary: '已核验', evidenceRefs: [context.inputRef] })
      await vi.waitFor(() => expect(handle[phase]).toHaveBeenCalledOnce())
    }
    addIndependentTask('other-task')
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.binding.ticketId).toBe('other-task')
    expect(dispatcher.activeCount()).toBe(2)
    expect(view().nodes.find(node => node.id === 'review')).toMatchObject({ state: 'pending', attempt: 0 })
    if (phase !== 'dispose') expect(handle.dispose).not.toHaveBeenCalled()

    addIndependentTask('waiting-task')
    dispatcher.request(); dispatcher.request()
    await vi.waitFor(() => expect(effects.pending('hmmDispatch', 'ready')).toBe(false))
    expect(requests).toHaveLength(2)
    const second = requests[1]!, context = await call(second, 'hmm_node_context', {})
    await call(second, 'hmm_node_report', { action: 'complete', summary: '独立完成', evidenceRefs: [context.inputRef] })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]!.binding.ticketId).toBe('waiting-task')
    expect(dispatcher.activeCount()).toBe(2)
    expect(view().nodes.find(node => node.id === 'review')).toMatchObject({ state: 'pending', attempt: 0 })
    if (phase !== 'start') expect(handle[phase]).toHaveBeenCalledOnce()
  } finally {
    gate.resolve()
    await settle()
  }
})

it('释放失败保留槽位及退避，重复唤醒不重试，独立任务仍可执行', async () => {
  const settings = store.settings()
  store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await start()
    const first = current('source'), handle = handles.get(first.binding.sessionId)!
    handle.dispose.mockRejectedValueOnce(new Error('Release failed'))
    const context = await call(first, 'hmm_node_context', {})
    await call(first, 'hmm_node_report', { action: 'complete', summary: '保留已提交成果', evidenceRefs: [context.inputRef] })
    await settle()
    const failed = () => store.db.prepare("SELECT key, attempts, due FROM effect WHERE kind = 'hmmDispatch' AND attempts > 0").all()
    const before = failed()
    expect(before).toHaveLength(1)
    expect(before[0]!.attempts).toBe(1)
    expect(dispatcher.activeCount()).toBe(1)

    addIndependentTask('during-backoff')
    dispatcher.request(); dispatcher.request()
    await settle()
    expect(requests).toHaveLength(2)
    expect(requests[1]!.binding.ticketId).toBe('during-backoff')
    expect(failed()).toEqual(before)
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(dispatcher.activeCount()).toBe(2)
    expect(view().nodes.find(node => node.id === 'review')).toMatchObject({ state: 'pending', attempt: 0 })

    vi.setSystemTime(Number(before[0]!.due))
    await settle()
    expect(failed()).toEqual([])
    expect(handle.dispose).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(3)
    expect(current('review').binding.ticketId).toBe(ticketId)
    expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'completed', attempt: 1 })
    expect(dispatcher.activeCount()).toBe(2)
  } finally {
    vi.useRealTimers()
  }
})

it('启动入队失败回滚节点占用，不消耗尝试次数；队列重试后只创建一个执行', async () => {
  hmm.create(actor, ticketId, { goal: '原子启动', maxActive: 1, nodes: [
    { id: 'root', title: '主线', mode: 'serial' },
    { id: 'source', parentId: 'root', title: '核对', instruction: '核验条件' },
  ] })
  await settle()
  const enqueue = effects.enqueue.bind(effects)
  const failure = vi.spyOn(effects, 'enqueue').mockImplementation((kind, key, payload) => {
    if (kind === 'hmmDispatch' && 'operation' in payload && payload.operation === 'launch')
      throw new Error('Enqueue failed')
    enqueue(kind, key, payload)
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    command({ action: 'dispatch' })
    const before = view()
    await settle()
    expect(view()).toEqual(before)
    expect(dispatcher.activeCount()).toBe(0)
    expect(requests).toHaveLength(0)
    const queued = store.db.prepare("SELECT attempts, due FROM effect WHERE kind = 'hmmDispatch' AND key = 'ready'").get()!
    expect(queued.attempts).toBe(1)

    failure.mockRestore()
    vi.setSystemTime(Number(queued.due))
    await settle()
    expect(requests).toHaveLength(1)
    expect(dispatcher.activeCount()).toBe(1)
    expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'running', attempt: 1 })
  } finally {
    failure.mockRestore()
    vi.useRealTimers()
  }
})
