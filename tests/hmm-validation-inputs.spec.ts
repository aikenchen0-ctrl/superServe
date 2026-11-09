import { afterEach, beforeEach, expect, it } from 'vitest'
import type { HmmCommand } from '../src/hmm/model.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(requestId: string, mode: 'single' | 'multi' = 'single') {
  const response = await h.api('POST', 'tasks', { requestId, goal: '比较现有资源下的可行路径', mode })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const input = (requestId: string, text: string) => h.api('POST', `tasks/${id}/inputs`, { requestId, text })
  const command = (command: HmmCommand) => h.api('POST', `tickets/${id}/hmm/commands`, { revision: view().revision, command })
  const complete = async () => {
    while (true) {
      const running = view().nodes.filter(node => node.mode === 'task' && node.state === 'running')
      if (!running.length) break
      for (const node of running) {
        const context = h.runtime.hmm.context(controller, id, node.id)
        await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'complete', summary: '列出可行路径与缺失条件',
          evidenceRefs: context.sourceResults.length ? context.sourceResults.map(item => item.ref) : [context.inputRef] })
      }
      await h.runtime.idle()
    }
    expect(view().awaitingValidation).toBe(true)
    return view().nodes.flatMap(node => node.resultRef ? [node.resultRef] : [])
  }
  return { id, view, input, command, complete }
}

it.each(['single', 'multi'] as const)('%s 路径不能把新增条件遗漏在旧验收之外，也不自动丢弃有效节点结果', async mode => {
  const run = await task(`late-${mode}`, mode)
  const refs = await run.complete()
  const before = run.view()
  const text = '补充：比较时说明内存与网络开销'
  const input = await run.input('budget', text)
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(run.id)
  expect(await run.command({ action: 'validate', summary: '按旧条件给出结论', evidenceRefs: refs }))
    .toMatchObject({ status: 409, body: { code: 'input_conflict' } })
  expect(run.view()).toMatchObject({ revision: before.revision, phase: 'active', nodes: before.nodes })
  expect(h.runtime.store.tickets.get(run.id)).toEqual(ticket)
  const read = await h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: run.id }) as ReturnType<typeof run.view>
  const page = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${run.id}/input/${input.body.inputId}` })
  expect(page).toMatchObject({ text: expect.stringContaining(text) })
  await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: run.id, revision: read.revision,
    command: { action: 'validate', inputVersion: read.inputVersion, summary: '核对补充条件后复用既有有效成果', evidenceRefs: refs } })
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ status: 200,
    body: { ended: { outcome: 'completed' }, result: { summary: '核对补充条件后复用既有有效成果' } } })
})

it('读取后再次到达的信息使输入版本过期，即使计划版本未变也不能验收', async () => {
  const run = await task('racing-input')
  const refs = await run.complete()
  await run.input('first', '先比较内存')
  const before = run.view()
  await run.input('second', '还需要比较网络往返')
  expect(run.view().revision).toBe(before.revision)
  expect(run.view().inputVersion).not.toBe(before.inputVersion)
  expect(await run.command({ action: 'validate', inputVersion: before.inputVersion, summary: '基于首次补充的结论', evidenceRefs: refs }))
    .toMatchObject({ status: 409, body: { code: 'input_conflict' } })
  expect(await run.command({ action: 'validate', inputVersion: run.view().inputVersion, summary: '核对两项约束后的结论', evidenceRefs: refs }))
    .toMatchObject({ status: 200 })
  expect(run.view().validation?.inputVersion).toBe(run.view().inputVersion)
})

it('版本从工单输入派生，重试和重启不改变它，其他工单的版本不能代用', async () => {
  const run = await task('persistent-input'), other = await task('isolated-input')
  const refs = await run.complete()
  const input = await run.input('same', '核对成本上限')
  await other.input('same', '核对成本上限')
  const version = run.view().inputVersion
  expect(version).toEqual(expect.any(String))
  expect(other.view().inputVersion).not.toBe(version)
  expect(await run.input('same', '核对成本上限')).toMatchObject({ status: 200, body: { created: false, inputId: input.body.inputId } })
  await h.restart()
  expect(run.view().inputVersion).toBe(version)
  expect(() => h.runtime.hmm.apply(controller, run.id, run.view().revision, {
    action: 'validate', inputVersion: other.view().inputVersion, summary: '错误工单的版本', evidenceRefs: refs,
  })).toThrow(expect.objectContaining({ code: 'input_conflict' }))
  expect(await run.command({ action: 'validate', inputVersion: version, summary: '重启后重新核对条件', evidenceRefs: refs }))
    .toMatchObject({ status: 200 })
})

it('旧持久状态有补充信息却没有验收输入版本时，结果查询拒绝将其作为有效交付', async () => {
  const run = await task('legacy-validation')
  const refs = await run.complete()
  await run.input('condition', '补充交付条件')
  expect(await run.command({ action: 'validate', inputVersion: run.view().inputVersion, summary: '已核对条件', evidenceRefs: refs }))
    .toMatchObject({ status: 200 })
  // 模拟升级前的验收记录，不能把缺失版本解释为已处理全部补充信息。
  const workflow = h.runtime.store.get(KV.hmm.workflow(run.id))!
  delete workflow.validation!.inputVersion
  h.runtime.store.set(KV.hmm.workflow(run.id), workflow)
  expect(() => h.runtime.hmm.assertReady(run.id)).toThrow(expect.objectContaining({ code: 'input_conflict' }))
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ status: 200,
    body: { ended: { outcome: 'completed' }, result: null, resultError: 'input_conflict' } })
})
