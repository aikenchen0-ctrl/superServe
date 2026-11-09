import { afterEach, beforeEach, expect, it } from 'vitest'
import type { HmmCommand } from '../src/hmm/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
interface TaskSpec { name: string; steps: number; maxActive?: number; serial?: boolean }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function prepare(capacity: number, specs: TaskSpec[]) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: capacity } })
  const ids = new Map<string, string>()
  const view = (name: string) => h.runtime.hmm.view(controller, ids.get(name)!)
  const command = async (name: string, command: HmmCommand) => {
    h.runtime.hmm.apply(controller, ids.get(name)!, view(name).revision, command)
    await h.runtime.idle()
  }
  const add = (spec: TaskSpec) => {
    const ticket = h.runtime.engine.createLocalTask({ requestId: spec.name, title: spec.name, goal: '完成各自的限定任务' })
    ids.set(spec.name, ticket.id)
    const created = h.runtime.hmm.create(controller, ticket.id, { goal: ticket.mandate.scope, maxActive: spec.maxActive ?? 3,
      nodes: [
        { id: 'root', title: '任务主线', mode: spec.serial ? 'serial' : 'parallel' },
        ...Array.from({ length: spec.steps }, (_, index) => ({ id: `step_${index}`, parentId: 'root', title: `步骤 ${index}`,
          instruction: '完成独立操作，引用实际使用的输入和结果',
          dependsOn: spec.serial && index ? [`step_${index - 1}`] : [] })),
      ] })
    h.runtime.hmm.apply(controller, ticket.id, created.revision, { action: 'dispatch' })
  }
  const launches = () => h.nodeFactory.mock.calls.map(([options]) => {
    for (const name of ids.keys()) {
      const node = view(name).nodes.find(node => node.sessionId === options.sessionId)
      if (node) return `${name}/${node.id}`
    }
    throw new Error('未找到已启动会话对应的任务节点')
  })
  const complete = async (name: string, nodeId: string) => {
    const node = view(name).nodes.find(node => node.id === nodeId)!
    const context = h.runtime.hmm.context(controller, ids.get(name)!, nodeId)
    await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: '本步骤已完成',
      evidenceRefs: context.sourceResults.length ? context.sourceResults.map(item => item.ref) : [context.inputRef] })
    await h.runtime.idle()
  }
  // 同批提交，使初次派发面对全部就绪任务，不依赖测试中的异步调用时机。
  h.runtime.store.atomic(() => { for (const spec of specs) add(spec) })
  await h.runtime.idle()
  return { ids, view, command, launches, complete, add }
}

it('每工单每轮先获一个槽，剩余容量继续利用，并遵守各计划上限', async () => {
  const run = await prepare(5, [
    { name: 'wide', steps: 4, maxActive: 4 },
    { name: 'short', steps: 1, maxActive: 1 },
    { name: 'pair', steps: 2, maxActive: 2 },
  ])
  expect(run.launches()).toEqual(['wide/step_0', 'short/step_0', 'pair/step_0', 'wide/step_1', 'pair/step_1'])
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(5)
  await run.complete('short', 'step_0')
  expect(run.launches().at(-1)).toBe('wide/step_2')
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(5)
})

it('只有一个槽时跨调度回合轮流推进串行依赖，不等第一条链全部完成', async () => {
  const run = await prepare(1, [
    { name: 'first', steps: 3, serial: true },
    { name: 'second', steps: 3, serial: true },
  ])
  for (let index = 0; index < 3; index++) {
    await run.complete('first', `step_${index}`)
    await run.complete('second', `step_${index}`)
  }
  expect(run.launches()).toEqual([
    'first/step_0', 'second/step_0', 'first/step_1', 'second/step_1', 'first/step_2', 'second/step_2',
  ])
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(run.view('first').awaitingValidation).toBe(true)
  expect(run.view('second').awaitingValidation).toBe(true)
})

it('上次获槽工单尚在运行时，释放的槽先给等待者，不抢占已有节点', async () => {
  const run = await prepare(2, [
    { name: 'many', steps: 4, maxActive: 1 },
    { name: 'slow', steps: 1, maxActive: 1 },
    { name: 'waiting', steps: 1, maxActive: 1 },
  ])
  expect(run.launches()).toEqual(['many/step_0', 'slow/step_0'])
  const slow = run.view('slow').nodes.find(node => node.id === 'step_0')!
  await run.complete('many', 'step_0')
  expect(run.launches()).toEqual(['many/step_0', 'slow/step_0', 'waiting/step_0'])
  expect(run.view('slow').nodes.find(node => node.id === 'step_0')).toMatchObject({ state: 'running', sessionId: slow.sessionId })
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(2)
  await run.complete('waiting', 'step_0')
  expect(run.launches().at(-1)).toBe('many/step_1')
})

it('暂停及停止的工单不参与轮转，全局暂停和重复唤醒不绕过派发边界', async () => {
  const run = await prepare(1, [
    { name: 'active', steps: 2 }, { name: 'held', steps: 1 }, { name: 'stopped', steps: 1 },
  ])
  await run.command('held', { action: 'hold' })
  await h.api('POST', `tickets/${run.ids.get('stopped')}/stop`)
  await h.api('POST', 'executor/pause', { paused: true })
  await run.complete('active', 'step_0')
  expect(run.launches()).toEqual(['active/step_0'])
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  await h.api('POST', 'executor/pause', { paused: false })
  await h.runtime.idle()
  expect(run.launches()).toEqual(['active/step_0', 'active/step_1'])
  await run.complete('active', 'step_1')
  await run.command('held', { action: 'dispatch' })
  h.runtime.hmmDispatcher.request()
  h.runtime.hmmDispatcher.request()
  await h.runtime.idle()
  expect(run.launches().at(-1)).toBe('held/step_0')
  expect(run.launches()).toHaveLength(3)
})

it('后来进入队列的任务在下一次释放槽时获得机会，已有会话继续执行', async () => {
  const run = await prepare(1, [{ name: 'existing', steps: 3 }])
  h.runtime.store.atomic(() => run.add({ name: 'arrival', steps: 1 }))
  await h.runtime.idle()
  expect(run.launches()).toEqual(['existing/step_0'])
  await run.complete('existing', 'step_0')
  expect(run.launches()).toEqual(['existing/step_0', 'arrival/step_0'])
  await run.complete('arrival', 'step_0')
  expect(run.launches().at(-1)).toBe('existing/step_1')
})

it('失效上游不创建下游会话；重核验后才继续派发，并保留已完成的独立成果', async () => {
  const ticket = h.runtime.engine.createLocalTask({ requestId: 'source-readiness', title: '产物有效性', goal: '依据授权资料核验结果' })
  const hmm = h.runtime.hmm
  const view = () => hmm.view(controller, ticket.id)
  const command = (input: HmmCommand) => hmm.apply(controller, ticket.id, view().revision, input)
  const node = (id: string) => view().nodes.find(node => node.id === id)!
  hmm.create(controller, ticket.id, { goal: ticket.mandate.scope, nodes: [
    { id: 'checks', mode: 'parallel', title: '核验' },
    { id: 'extract', parentId: 'checks', title: '来源', instruction: '读取资料', evidenceRequired: true },
    { id: 'compare', parentId: 'checks', title: '比对', instruction: '核对来源结果', dependsOn: ['extract'] },
    { id: 'budget', parentId: 'checks', title: '独立约束', instruction: '核对预算' },
  ] })
  const input = { id: 'memo', title: '资料', origin: '操作者输入', text: '来源第一版', nodeIds: ['extract'] }
  const first = hmm.importEvidence(controller, ticket.id, view().revision, input).document
  const { lease } = command({ action: 'start', nodeId: 'extract' })
  const receipt = hmm.readEvidence(controller, ticket.id, 'extract', { id: first.id, version: first.version })
  command({ action: 'complete', nodeId: 'extract', lease: lease!, summary: 'OLD_RESULT', evidenceRefs: [receipt.ref] })
  hmm.revokeEvidence(controller, ticket.id, view().revision, first.id)
  command({ action: 'dispatch' })
  await h.runtime.idle()
  expect(node('compare')).toMatchObject({ state: 'pending', attempt: 0, blockedBy: ['extract'] })
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)
  const budgetSession = node('budget').sessionId!
  const budgetContext = await h.runTool(budgetSession, 'hmm_node_context', {})
  await h.runTool(budgetSession, 'hmm_node_report', {
    action: 'complete', summary: '独立成果', evidenceRefs: [budgetContext.inputRef],
  })
  await h.runtime.idle()
  const budgetRef = node('budget').resultRef
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)

  command({ action: 'recheck', nodeId: 'extract', reason: '按更新的来源重核验' })
  const fresh = hmm.importEvidence(controller, ticket.id, view().revision, { ...input, text: '来源第二版' }).document
  command({ action: 'dispatch' })
  await h.runtime.idle()
  expect(h.nodeFactory).toHaveBeenCalledTimes(2)
  const extractSession = node('extract').sessionId!
  const current = await h.runTool(extractSession, 'hmm_evidence_read', { id: fresh.id, version: fresh.version })
  await h.runTool(extractSession, 'hmm_node_report', {
    action: 'complete', summary: 'NEW_RESULT', evidenceRefs: [current.ref],
  })
  await h.runtime.idle()
  expect(h.nodeFactory).toHaveBeenCalledTimes(3)
  expect(node('compare')).toMatchObject({ state: 'running', attempt: 1 })
  expect(node('budget')).toMatchObject({ state: 'completed', resultRef: budgetRef, sessionId: budgetSession })
  const projected = await h.runTool(node('compare').sessionId!, 'hmm_node_context', {})
  expect(JSON.stringify(projected)).toContain('NEW_RESULT')
  expect(JSON.stringify(projected)).not.toContain('OLD_RESULT')
})
