import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { HMM_LIMITS, type HmmActor, type HmmCommand, type PlanInput } from '../src/hmm/model.ts'
import { HmmWorkflows } from '../src/hmm/workflow.ts'
import { KV } from '../src/kv.ts'

const controller: HmmActor = { role: 'controller' }
const worker: HmmActor = { role: 'worker', ticketId: 't1' }
const initial = (): PlanInput => ({ goal: 'Compare alternatives', nodes: [
  { id: 'root', title: 'Root', mode: 'parallel' },
  { id: 'a', parentId: 'root', title: 'A', instruction: 'Check initial assumption' },
  { id: 'b', parentId: 'root', title: 'B', instruction: 'Independent work' },
  { id: 'c', parentId: 'root', title: 'C', instruction: 'Evaluate A', dependsOn: ['a'] },
] })
let directory: string, store: Store, hmm: HmmWorkflows
const changed = vi.fn()
const read = () => hmm.view(controller, 't1')
const snapshot = () => store.get(KV.hmm.workflow('t1'))!
const context = (id: string) => hmm.context(controller, 't1', id)
const definition = (): PlanInput => hmm.definition(controller, 't1').plan
const apply = (command: HmmCommand) => hmm.apply(controller, 't1', read().revision, command)
const revise = (plan: PlanInput, extra = {}) =>
  hmm.revise(controller, 't1', { revision: read().revision, plan, reason: 'Correct the task definition', ...extra })
const complete = (nodeId: string, evidenceRefs?: string[], withClaim = false) => {
  const { lease } = apply({ action: 'start', nodeId })
  const refs = evidenceRefs ?? [context(nodeId).inputRef!]
  return apply({ action: 'complete', nodeId, lease: lease!, summary: `${nodeId} result`, evidenceRefs: refs,
    ...(withClaim ? { claims: [{ id: 'assumption', subject: nodeId, predicate: 'assumes', object: 'Task assumption',
      kind: 'inferred' as const, evidenceRefs: refs, counterEvidenceRefs: [] }] } : {}) })
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hmm-revision-'))
  store = new Store(join(directory, 'state.sqlite'))
  const ticket: Ticket = { id: 't1', title: 'Task', decisionId: 'd1', createdAt: '', updatedAt: '',
    mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' }, actor: { source: 'test', id: 'owner' }, scope: 'test' },
    channels: [], assignments: [], inputs: [], undelivered: [], origin: { triggerId: 'e1', triggerIds: ['e1'] } }
  store.tickets.save(ticket)
  changed.mockClear()
  hmm = new HmmWorkflows(store, undefined, { changed })
  hmm.create(controller, 't1', initial())
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('修改用途重开受影响步骤及依赖者，保留独立成果并拒绝旧回执', () => {
  complete('b')
  const { lease } = apply({ action: 'start', nodeId: 'a' })
  apply({ action: 'complete', nodeId: 'a', lease: lease!, summary: 'Original result', evidenceRefs: [context('a').inputRef!] })
  complete('c', [context('a').resultRef!])
  const before = snapshot(), oldInput = context('a').inputRef!
  const plan = initial()
  plan.nodes.find(node => node.id === 'a')!.purpose = 'survey'
  const preview = revise(plan, { preview: true })
  expect(preview).toMatchObject({ changed: ['a'], invalidated: ['a', 'c'] })
  expect(snapshot()).toEqual(before)
  revise(plan)
  expect(context('a')).toMatchObject({ state: 'pending', purpose: 'survey' })
  expect(context('a').inputRef).not.toBe(oldInput)
  expect(context('b').result).toEqual(before.nodes.find(node => node.id === 'b')!.result)
  expect(() => apply({ action: 'complete', nodeId: 'a', lease: lease!, summary: 'Late', evidenceRefs: [oldInput] }))
    .toThrow('凭据')
})

it('预览列出失效范围但不写库或中断，应用只清理受影响成果', () => {
  complete('b')
  const { lease } = apply({ action: 'start', nodeId: 'a' })
  apply({ action: 'checkpoint', nodeId: 'a', lease: lease!, frame: 'Old frame' })
  const plan = definition(), before = snapshot(), calls = changed.mock.calls.length, oldInput = context('a').inputRef
  plan.nodes[1]!.instruction = 'Check corrected assumption'
  const preview = revise(plan, { preview: true })
  expect(preview).toMatchObject({ applied: false, revision: before.revision, planVersion: 1,
    candidatePlanVersion: 2, changed: ['a'], invalidated: ['a', 'c'] })
  expect(snapshot()).toEqual(before)
  expect(changed).toHaveBeenCalledTimes(calls)
  const applied = revise(plan)
  expect(applied).toMatchObject({ applied: true, revision: before.revision + 1, planVersion: 2 })
  expect(context('a')).toMatchObject({ state: 'pending', frame: '', instruction: 'Check corrected assumption' })
  expect(context('a').inputRef).not.toBe(oldInput)
  expect(context('b').result).toEqual(before.nodes.find(node => node.id === 'b')!.result)
  expect(snapshot().nodes.find(node => node.id === 'a')!.attempt).toBe(1)
  expect(snapshot().lastPlanRevision).toMatchObject({ reason: 'Correct the task definition', invalidated: ['a', 'c'] })
  expect(snapshot().lastPlanRevision!.beforeHash).not.toBe(snapshot().lastPlanRevision!.afterHash)
  expect(() => apply({ action: 'complete', nodeId: 'a', lease: lease!, summary: 'Late', evidenceRefs: [oldInput!] })).toThrow('凭据')
})

it('修订重新打开验收，只保留未受影响断言的复核记录', () => {
  complete('a', undefined, true); complete('b', undefined, true)
  complete('c', [context('a').resultRef!], true)
  const claims = hmm.claims(controller, 't1', undefined, {}).nodes
  apply({ action: 'review_claims', reviews: claims.map(node => ({ ref: node.ref, verdict: 'accept', reason: 'Reviewed' })) })
  apply({ action: 'validate', summary: 'Checked', evidenceRefs: [context('c').resultRef!] })
  const stable = context('b').resultRef
  const plan = definition(); plan.nodes[1]!.instruction = 'Reframe the assumption'
  revise(plan)
  expect(read()).toMatchObject({ phase: 'active', autoRun: false, claimReviews: { total: 1, accepted: 1 } })
  expect(snapshot().validation).toBeUndefined()
  expect(context('b').resultRef).toBe(stable)
  expect(hmm.claims(controller, 't1', undefined, {}).nodes.map(node => node.nodeId)).toEqual(['b'])
  expect(() => hmm.assertReady('t1')).toThrow('尚未验收')
})

it('新增分组并移动步骤，校验新旧依赖并保留独立分支', () => {
  complete('a'); complete('b'); complete('c', [context('a').resultRef!])
  const plan = definition()
  plan.nodes.splice(1, 0, { id: 'research', parentId: 'root', mode: 'parallel', title: 'Research' })
  plan.nodes.find(node => node.id === 'a')!.parentId = 'research'
  plan.nodes.find(node => node.id === 'c')!.dependsOn = ['research']
  expect(revise(plan)).toMatchObject({ added: ['research'], invalidated: ['a', 'c'] })
  expect(context('b').state).toBe('completed')
  expect(read().runnable).toEqual(['a'])
  complete('a')
  expect(read().runnable).toEqual(['c'])
})

it('串行步骤插入后只重置顺序受影响的后继，重排仍查环', () => {
  const serial = definition(); serial.nodes[0]!.mode = 'serial'; revise(serial)
  complete('a'); complete('b'); complete('c')
  const plan = definition()
  plan.nodes.splice(3, 0, { id: 'extra', parentId: 'root', title: 'Extra', instruction: 'Check missing condition' })
  expect(revise(plan)).toMatchObject({ invalidated: ['extra', 'c'] })
  expect(context('a').state).toBe('completed')
  expect(context('b').state).toBe('completed')
  const cyclic = definition()
  cyclic.nodes.find(node => node.id === 'a')!.dependsOn = ['c']
  const before = snapshot()
  expect(() => revise(cyclic)).toThrow('循环')
  expect(snapshot()).toEqual(before)
})

it('修改目标使全部任务失效，改变并发上限也取消旧骨架上的运行会话', () => {
  complete('a'); complete('b')
  const active = apply({ action: 'start', nodeId: 'c' })
  const plan = definition(); plan.maxActive = 1
  expect(revise(plan).invalidated).toEqual(['c'])
  expect(context('a').state).toBe('completed')
  expect(() => apply({ action: 'checkpoint', nodeId: 'c', lease: active.lease!, frame: 'Late' })).toThrow('凭据')
  plan.goal = 'Changed acceptance goal'
  expect(revise(plan).invalidated).toEqual(['a', 'b', 'c'])
})

it('改写已发布节点时保守重开所有消费者，撤销黑板引用', () => {
  complete('a'); apply({ action: 'publish', nodeId: 'a' }); complete('b'); complete('c')
  const plan = definition(); plan.nodes[1]!.instruction = 'New shared assumption'
  expect(revise(plan).invalidated).toEqual(['a', 'b', 'c'])
  expect(read().published).toEqual([])
})

it('实际反证引用的消费者随来源修订失效', () => {
  // 发布后取到来源，再移除依赖并不应留下已保存引用；闭包仍追踪支持和反证。
  const source = hmm.importEvidence(controller, 't1', read().revision, {
    id: 'source', title: 'Source', origin: 'Operator note', text: 'Actual source', nodeIds: ['a'],
  })
  const active = apply({ action: 'start', nodeId: 'a' })
  const receipt = hmm.readEvidence(controller, 't1', 'a', { id: 'source', version: source.document.version })
  apply({ action: 'complete', nodeId: 'a', lease: active.lease!, summary: 'A source', evidenceRefs: [receipt.ref] })
  const b = apply({ action: 'start', nodeId: 'b' })
  apply({ action: 'publish', nodeId: 'a' })
  apply({ action: 'complete', nodeId: 'b', lease: b.lease!, summary: 'B assumption', evidenceRefs: [context('b').inputRef!],
    claims: [{ id: 'hypothesis', subject: 'B', predicate: 'assumes', object: 'Condition', kind: 'inferred',
      evidenceRefs: [context('b').inputRef!], counterEvidenceRefs: [context('a').resultRef!] }] })
  const saved = snapshot()
  saved.published = []; store.set(KV.hmm.workflow('t1'), saved)
  const plan = definition(); plan.nodes[1]!.instruction = 'Correct the source question'
  expect(revise(plan).invalidated).toEqual(['a', 'b', 'c'])
})

it('修订撤回受影响节点取证范围，不影响共享片段的其他授权节点', () => {
  const imported = hmm.importEvidence(controller, 't1', read().revision, {
    id: 'shared', title: 'Shared', origin: 'Operator', text: 'Source', nodeIds: ['a', 'b'],
  })
  const a = hmm.readEvidence(controller, 't1', 'a', { id: 'shared', version: imported.document.version })
  const b = hmm.readEvidence(controller, 't1', 'b', { id: 'shared', version: imported.document.version })
  hmm.grantDevice(controller, 't1', read().revision, { id: 'phone', nodeId: 'a', deviceId: 'phone', domain: 'files' })
  const plan = definition(); plan.nodes[1]!.instruction = 'A new purpose'
  revise(plan)
  expect(snapshot().evidence!.receipts.map(item => item.ref)).toEqual([b.ref])
  expect(snapshot().evidence!.receipts.some(item => item.ref === a.ref)).toBe(false)
  expect(snapshot().evidence!.documents[0]).toMatchObject({ nodeIds: ['b'], text: 'Source' })
  expect(context('a').deviceGrants).toEqual([])
  expect(read().deviceGrants[0]!.revoked).toBe(true)
  expect(() => hmm.readEvidence(controller, 't1', 'a', { id: 'shared', version: imported.document.version })).toThrow()
})

it('删除节点留下持久编号墓碑，不能删除重建绕过重试次数', () => {
  const plan = definition(); plan.nodes = plan.nodes.filter(node => node.id !== 'a')
  plan.nodes.find(node => node.id === 'c')!.dependsOn = []
  expect(revise(plan)).toMatchObject({ removed: ['a'], invalidated: ['c'] })
  expect(hmm.definition(controller, 't1').retiredNodeIds).toEqual(['a'])
  store.close(); store = new Store(join(directory, 'state.sqlite')); hmm = new HmmWorkflows(store)
  expect(read().planVersion).toBe(2)
  expect(() => revise(initial())).toThrow('编号不能复用')
})

it('剪枝节点不能被修订复活，必须移除并以新编号表达新探索', () => {
  apply({ action: 'prune', nodeId: 'a', reason: 'Not viable', reconsiderWhen: 'New evidence' })
  expect(hmm.definition(controller, 't1').prunedNodeIds).toContain('a')
  expect(() => revise(initial())).toThrow('已剪枝')
  const plan = initial(); plan.nodes = plan.nodes.filter(node => node.id !== 'a')
  plan.nodes.find(node => node.id === 'c')!.dependsOn = []
  plan.nodes.push({ id: 'new-a', parentId: 'root', title: 'New A', instruction: 'New independent exploration' })
  expect(revise(plan)).toMatchObject({ added: ['new-a'], removed: ['a'] })
})

it.each([
  ['悬空依赖', (plan: PlanInput) => { plan.nodes[3]!.dependsOn = ['missing'] }],
  ['依赖循环', (plan: PlanInput) => { plan.nodes[1]!.dependsOn = ['c'] }],
  ['父节点丢失', (plan: PlanInput) => { plan.nodes[1]!.parentId = 'missing' }],
  ['重复编号', (plan: PlanInput) => { plan.nodes.push({ ...plan.nodes[1]! }) }],
  ['跨层依赖', (plan: PlanInput) => { plan.nodes[3]!.dependsOn = ['root'] }],
  ['类型偷换', (plan: PlanInput) => { plan.nodes[1]!.mode = 'parallel' }],
] as const)('拒绝%s且保持原快照', (_label, change) => {
  const plan = definition(), before = snapshot(), calls = changed.mock.calls.length
  change(plan)
  expect(() => revise(plan)).toThrow()
  expect(snapshot()).toEqual(before)
  expect(changed).toHaveBeenCalledTimes(calls)
})

it('角色、工单存活、版本和无效字段均在写入前检查', () => {
  const plan = definition(); plan.nodes[1]!.instruction = 'Changed'
  expect(() => hmm.revise(worker, 't1', { revision: read().revision, plan, reason: 'Change' })).toThrow('总管')
  expect(() => hmm.definition(worker, 't1')).toThrow('总管')
  const revision = read().revision
  apply({ action: 'start', nodeId: 'b' })
  expect(() => revise(plan, { revision })).toThrow('更新')
  expect(() => revise(plan, { state: 'completed' })).toThrow()
  expect(() => revise(definition())).toThrow('没有变化')
  const record = store.tickets.get('t1')!
  store.tickets.save({ ...record, ended: { outcome: 'stopped', reason: 'Stopped', at: new Date().toISOString() } } as Ticket)
  expect(() => revise(plan, { preview: true })).toThrow('已结束')
})

it('轻量计划核对仍只授予总管，拒绝节点与调度角色且不改变状态', () => {
  const before = snapshot()
  for (const actor of [worker, { role: 'scheduler' }, { role: 'node', ticketId: 't1', nodeId: 'a', lease: 'forged', sessionId: 'forged' }] as HmmActor[])
    expect(() => hmm.planIdentity(actor, 't1')).toThrow('总管')
  expect(() => hmm.planIdentity(controller, 'missing')).toThrow()
  const identity = hmm.planIdentity(controller, 't1')
  expect(identity).toMatchObject({ ticketId: 't1', revision: before.revision, planVersion: 1 })
  expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(snapshot()).toEqual(before)
})

it('旧快照兼容首版定义，保留执行次数而不允许修订重置', () => {
  const legacy = snapshot(); delete legacy.planVersion; delete legacy.retiredNodeIds
  store.set(KV.hmm.workflow('t1'), legacy)
  expect(hmm.definition(controller, 't1').planVersion).toBe(1)
  complete('a')
  const exhausted = snapshot(); exhausted.nodes.find(node => node.id === 'a')!.attempt = HMM_LIMITS.attempts
  store.set(KV.hmm.workflow('t1'), exhausted)
  const plan = definition(); plan.nodes[1]!.instruction = 'A new attempt'
  expect(() => revise(plan)).toThrow('重试预算')
  expect(snapshot()).toEqual(exhausted)
})

it('计划版本和累计编号都有上限', () => {
  const plan = definition()
  const extras = Array.from({ length: 60 }, (_, index) => ({ id: `extra-${index}`, parentId: 'root', title: 'Extra', instruction: 'Explore' }))
  plan.nodes.push(...extras); revise(plan)
  plan.nodes = plan.nodes.filter(node => !node.id.startsWith('extra-')); revise(plan)
  plan.nodes.push({ id: 'over-limit', parentId: 'root', title: 'Extra', instruction: 'Explore' })
  expect(() => revise(plan)).toThrow('生命周期')
  plan.nodes.pop()
  while (read().planVersion < HMM_LIMITS.planVersions) {
    plan.maxActive = read().maxActive === 1 ? 2 : 1
    revise(plan)
  }
  plan.maxActive = 3
  expect(() => revise(plan)).toThrow('修订次数')
})

it('候选快照超限时预览和应用都原子拒绝', () => {
  const plan = definition(), before = snapshot()
  plan.nodes.push(...Array.from({ length: 60 }, (_, index) => ({
    id: `large-${index}`, parentId: 'root', title: 'Large', instruction: '测'.repeat(4000),
  })))
  expect(() => revise(plan, { preview: true })).toThrow('存储预算')
  expect(() => revise(plan)).toThrow('存储预算')
  expect(snapshot()).toEqual(before)
})

it('更严格的事实门槛不能沿用旧完成状态', () => {
  complete('a'); complete('b'); complete('c')
  const plan = definition()
  plan.nodes[1]!.evidenceRequired = true; plan.nodes[1]!.claimsRequired = true
  expect(revise(plan).invalidated).toEqual(['a', 'c'])
  expect(context('a')).toMatchObject({ state: 'pending', evidenceRequired: true, claimsRequired: true })
  expect(context('a').result).toBeUndefined()
  expect(context('b').state).toBe('completed')
})

it('文档示例可预览事实计划的新复核步骤，而不修改原定义', () => {
  const original = JSON.parse(readFileSync('examples/hmm-claims-plan.json', 'utf8'))
  const request = JSON.parse(readFileSync('examples/hmm-revision.json', 'utf8'))
  store.tickets.save({ ...store.tickets.get('t1')!, id: 'example' })
  hmm.create(controller, 'example', original)
  expect(hmm.revise(controller, 'example', request)).toMatchObject({ applied: false,
    added: ['challenge'], invalidated: ['challenge', 'evaluate'] })
  expect(hmm.definition(controller, 'example').planVersion).toBe(1)
})
