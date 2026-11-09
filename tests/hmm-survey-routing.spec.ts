import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlanSchema, type PlanInput } from '../src/hmm/model.ts'
import { planHash } from '../src/hmm/workflow.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host, ticketId: string
const actor = { role: 'controller' as const }
const ordinary = { provider: 'reasoning-provider', model: 'reasoning-model' }
const survey = { provider: 'survey-provider', model: 'survey-model', reasoningEffort: 'low' }
const plan = (): PlanInput => ({ goal: 'Compare evidence and decide', maxActive: 2, nodes: [
  { id: 'root', title: 'Work', mode: 'parallel' },
  { id: 'gather', parentId: 'root', title: 'Read sources', instruction: 'Extract claims with conditions', purpose: 'survey' },
  { id: 'decide', parentId: 'root', title: 'Decide', instruction: 'Resolve the conflicting constraints' },
] })
beforeEach(async () => {
  h = await startRuntime()
  ticketId = (await h.acceptedTicket(feishu('1', '@bot compare sources'))).ticket.id
})
afterEach(async () => { await h.stop() })
const view = () => h.runtime.hmm.view(actor, ticketId)
async function dispatch(spec = plan()) {
  h.runtime.hmm.create(actor, ticketId, spec)
  h.runtime.hmm.apply(actor, ticketId, view().revision, { action: 'dispatch' })
  await h.runtime.idle()
}
const route = (id: string) => h.nodeFactory.mock.calls.find(([options]) =>
  options.sessionId === view().nodes.find(node => node.id === id)?.sessionId)?.[0].agentOptions

it('按显式用途路由并行节点，不依赖标题或变更普通执行与总管模型', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: ordinary, surveyModel: survey } })
  const spec = plan()
  spec.nodes[1]!.title = 'Evaluate complex constraints'
  spec.nodes[2]!.title = 'Survey resources'
  await dispatch(spec)
  expect(route('gather')).toMatchObject(survey)
  expect(route('decide')).toMatchObject(ordinary)
  expect(h.runtime.store.settings().eval).toEqual(settings.eval)
  expect(h.runtime.store.settings().executor.model).toEqual(ordinary)
  expect(h.controller.selectModel).not.toHaveBeenCalled()
})

it.each([ordinary, null])('调查模型留空时沿用原执行器或宿主默认路由：%j', async model => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model } })
  await dispatch()
  expect(route('gather')).toMatchObject(model ?? { provider: 'test', model: 'fake' })
  expect(route('decide')).toMatchObject(model ?? { provider: 'test', model: 'fake' })
})

it('调查模型不可用时挂起调查节点，不静默替换模型或阻塞独立推理', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: ordinary, surveyModel: survey } })
  vi.mocked(h.ctx.llm.resolveCallConfig).mockImplementation(async input => {
    if (input.model === survey.model) throw new Error('survey route unavailable')
    return input as Awaited<ReturnType<typeof h.ctx.llm.resolveCallConfig>>
  })
  await dispatch()
  expect(view().nodes.find(node => node.id === 'gather')?.state).toBe('suspended')
  expect(route('gather')).toBeUndefined()
  expect(route('decide')).toMatchObject(ordinary)
})

it('旧计划与显式推理用途保持同一身份，调查用途不能附着到分组', async () => {
  const legacy = plan()
  delete legacy.nodes[1]!.purpose
  const explicit = structuredClone(legacy)
  explicit.nodes[1]!.purpose = 'reasoning'
  expect(planHash(PlanSchema.parse(legacy))).toBe(planHash(PlanSchema.parse(explicit)))
  expect(planHash(PlanSchema.parse(legacy))).not.toBe(planHash(PlanSchema.parse(plan())))
  const grouped = plan()
  grouped.nodes[0]!.purpose = 'survey'
  expect(() => h.runtime.hmm.create(actor, ticketId, grouped)).toThrow('用途')
})

it('管理接口核验新调查路由，失败不保存，旧版本写入不覆盖新配置', async () => {
  const revision = h.runtime.store.blockRevision('executor')
  const value = { ...h.runtime.store.settings().executor, surveyModel: survey }
  const resolve = vi.mocked(h.ctx.llm.resolveCallConfig)
  resolve.mockRejectedValueOnce(new Error('route unavailable'))
  expect(await h.api('PUT', 'settings/executor', { value, revision })).toMatchObject({
    status: 400, body: { code: 'modelUnavailable' },
  })
  expect(h.runtime.store.blockRevision('executor')).toBe(revision)
  expect(await h.api('PUT', 'settings/executor', { value, revision })).toMatchObject({ status: 200 })
  expect(h.runtime.store.settings().executor.surveyModel).toEqual(survey)
  expect(await h.api('PUT', 'settings/executor', { value: { ...value, surveyModel: null }, revision }))
    .toMatchObject({ status: 409 })
  expect(h.runtime.store.settings().executor.surveyModel).toEqual(survey)
})

it('在途节点保留启动模型，排队调查读取新配置且遵守原并发上限', async () => {
  const settings = h.runtime.store.settings()
  // 原工单执行器占用一席，余下一席供调查节点使用。
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, model: ordinary, surveyModel: survey, maxWorkers: 2 } })
  const spec = plan()
  spec.nodes[2]!.purpose = 'survey'
  await dispatch(spec)
  const first = view().nodes.find(node => node.id === 'gather')!.sessionId!
  const updated = h.runtime.store.settings()
  const next = { provider: 'other-survey-provider', model: 'other-survey-model' }
  h.runtime.store.saveSettings({ ...updated, executor: { ...updated.executor, surveyModel: next } })
  await h.runtime.idle()
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)
  expect(route('gather')).toMatchObject(survey)
  const context = await h.runTool(first, 'hmm_node_context', {})
  await h.runTool(first, 'hmm_node_report', { action: 'complete', summary: 'Collected source conditions',
    evidenceRefs: [context.inputRef] })
  await h.runtime.idle()
  expect(route('decide')).toMatchObject(next)
  expect(h.controller.selectModel).not.toHaveBeenCalled()
})
