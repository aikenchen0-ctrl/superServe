import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { HmmWorkflows } from '../src/hmm/workflow.ts'
import { HMM_LIMITS, type HmmBinding, type HmmCommand, type PlanInput } from '../src/hmm/model.ts'

const actor = { role: 'controller' as const }
let directory: string, store: Store, hmm: HmmWorkflows
const view = () => hmm.view(actor, 't1')
const command = (input: HmmCommand) => hmm.apply(actor, 't1', view().revision, input)
const context = (id: string) => hmm.context(actor, 't1', id)
const resultRef = (id: string) => context(id).resultRef!

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hmm-results-'))
  store = new Store(join(directory, 'state.sqlite'))
  hmm = new HmmWorkflows(store)
  for (const id of ['t1', 't2']) {
    store.tickets.save({ id, title: id, decisionId: 'd1',
      mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' },
        actor: { source: 'test', id: 'owner' }, scope: 'test' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      origin: { triggerId: 'e1', triggerIds: ['e1'] } } satisfies Ticket)
    hmm.create(actor, id, { goal: '从授权上游结果中完成复核', nodes: [
      { id: 'root', title: '主线', mode: 'parallel' },
      { id: 'research', parentId: 'root', title: '研究', mode: 'parallel' },
      { id: 'a', parentId: 'research', title: '甲', instruction: '独立核对甲的条件' },
      { id: 'b', parentId: 'research', title: '乙', instruction: '独立核对乙的条件' },
      { id: 'hidden', parentId: 'root', title: '独立分支', instruction: 'PRIVATE_INSTRUCTION' },
      { id: 'review', parentId: 'root', title: '复核', instruction: '比较研究组的结果', dependsOn: ['research'] },
    ] })
    hmm.apply(actor, id, 1, { action: 'dispatch' })
  }
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
function complete(id: string, summary = `${id}_RESULT`, refs?: string[], ticketId = 't1') {
  const binding = hmm.claim(ticketId, id)
  hmm.report(binding, { action: 'complete', summary,
    evidenceRefs: refs ?? [hmm.context(actor, ticketId, id).inputRef!] })
}
function ready(): HmmBinding {
  complete('a'); complete('b')
  return hmm.claim('t1', 'review')
}

it('超过内联预算的组依赖和黑板只传引用，管理端仍可读正文，读取不推进版本', () => {
  const a = `A_RESULT_${'甲'.repeat(1500)}`, b = `B_RESULT_${'乙'.repeat(1500)}`
  complete('a', a); complete('b', b)
  command({ action: 'publish', nodeId: 'a' })
  const binding = hmm.claim('t1', 'review')
  const inline = context('review'), projection = hmm.executionContext(binding)
  expect(projection.dependencies).toEqual([{ nodeId: 'research', resultRefs: [resultRef('a'), resultRef('b')] }])
  expect(projection.blackboard).toEqual([{ nodeId: 'a', ref: resultRef('a') }])
  const wire = JSON.stringify(projection)
  expect(wire).not.toContain(a)
  expect(wire).not.toContain(b)
  expect(wire).not.toContain('PRIVATE_INSTRUCTION')
  expect(JSON.stringify(inline)).toContain(a)
  expect(Buffer.byteLength(JSON.stringify(inline)) - Buffer.byteLength(wire)).toBeGreaterThan(3000)
  const before = view().revision
  expect(hmm.readResult(binding, { ref: resultRef('a') })).toMatchObject({
    nodeId: 'a', result: { summary: a, evidenceRefs: [context('a').inputRef] },
  })
  expect(view().revision).toBe(before)
})

it('短必需结果只内联一次，累计不超过预算，可选黑板不默认携带正文', () => {
  complete('a', `A_RESULT_${'a'.repeat(1800)}`)
  complete('b', `B_RESULT_${'b'.repeat(1800)}`)
  complete('hidden', 'OPTIONAL_RESULT')
  command({ action: 'publish', nodeId: 'a' })
  command({ action: 'publish', nodeId: 'hidden' })
  const binding = hmm.claim('t1', 'review'), projection = hmm.executionContext(binding)
  const inline = projection.sourceResults.filter(item => item.result)
  expect(inline.length).toBeGreaterThan(0)
  expect(inline.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0))
    .toBeLessThanOrEqual(HMM_LIMITS.resultInlineBytes)
  const wire = JSON.stringify(projection)
  expect(wire.match(/A_RESULT_/g)).toHaveLength(1)
  expect(wire).not.toContain('OPTIONAL_RESULT')
  expect(hmm.readResult(binding, { ref: resultRef('hidden') }).result.summary).toBe('OPTIONAL_RESULT')
})

it('显式发布才允许读取无依赖兄弟，未发布、跨工单和伪造引用均被拒绝', () => {
  complete('hidden', 'PRIVATE_RESULT')
  complete('a', 'FOREIGN_RESULT', undefined, 't2')
  const binding = ready()
  for (const ref of [resultRef('hidden'), hmm.context(actor, 't2', 'a').resultRef!,
    `result:${'0'.repeat(64)}`]) {
    expect(() => hmm.readResult(binding, { ref })).toThrow('可见范围')
  }
  expect(() => hmm.readResult(binding, { ref: resultRef('a'), nodeId: 'hidden' })).toThrow()
  command({ action: 'publish', nodeId: 'hidden' })
  expect(hmm.executionContext(binding).blackboard).toEqual([{ nodeId: 'hidden', ref: resultRef('hidden') }])
  expect(hmm.readResult(binding, { ref: resultRef('hidden') })).toMatchObject({
    nodeId: 'hidden', result: { summary: 'PRIVATE_RESULT' },
  })
})

it('重核后新实例只能读取当前结果版本，旧会话和旧引用都不能继续使用', () => {
  const old = ready(), previous = resultRef('a')
  command({ action: 'recheck', nodeId: 'a', reason: '重新核对' })
  command({ action: 'dispatch' })
  complete('a', 'REVISED_RESULT')
  const fresh = hmm.claim('t1', 'review')
  expect(() => hmm.readResult(old, { ref: previous })).toThrow('失效')
  expect(() => hmm.readResult(fresh, { ref: previous })).toThrow('已失效')
  expect(hmm.readResult(fresh, { ref: resultRef('a') })).toMatchObject({
    result: { summary: 'REVISED_RESULT' },
  })
})

it('依据被撤回后，曾可见的结果也不能绕过依据链校验继续读取', () => {
  const imported = hmm.importEvidence(actor, 't1', view().revision, {
    id: 'source', title: '资料', origin: '操作者输入', text: '已提供的原始片段', nodeIds: ['a'],
  })
  const a = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...a }, 't1', 'a', { id: 'source', version: imported.document.version })
  hmm.report(a, { action: 'complete', summary: '来自片段的结论', evidenceRefs: [receipt.ref] })
  complete('b')
  const binding = hmm.claim('t1', 'review'), ref = resultRef('a')
  expect(hmm.readResult(binding, { ref }).result.summary).toBe('来自片段的结论')
  hmm.revokeEvidence(actor, 't1', view().revision, 'source')
  expect(hmm.executionContext(binding).sourceResults.find(item => item.ref === ref)?.result).toBeUndefined()
  expect(() => hmm.readResult(binding, { ref })).toThrow()
})

it.each(['withdrawn', 'replaced', 'indirect', 'counterevidence'] as const)(
  '%s 依据失效时拒绝发布且不写状态，其他有效成果仍可发布',
  kind => {
    const input = { id: 'memo', title: '依据', origin: '合成资料', text: 'PRIVATE_SOURCE_TEXT', nodeIds: ['a'] }
    const document = hmm.importEvidence(actor, 't1', view().revision, input).document
    const binding = hmm.claim('t1', 'a')
    const receipt = hmm.readEvidence({ role: 'node', ...binding }, 't1', 'a', { id: document.id, version: document.version })
    const inputRef = context('a').inputRef!
    hmm.report(binding, { action: 'complete', summary: '已完成的研究',
      evidenceRefs: kind === 'counterevidence' ? [inputRef] : [receipt.ref],
      ...(kind === 'counterevidence' ? { claims: [{
        id: 'hypothesis', subject: '方案', predicate: '适用条件', object: '需要进一步核验', kind: 'inferred',
        evidenceRefs: [inputRef], counterEvidenceRefs: [receipt.ref],
      }] } : {}),
    })
    let target = 'a'
    if (kind === 'indirect') {
      complete('b')
      complete('review', '引用研究结果的复核', [resultRef('a')])
      target = 'review'
    }
    if (kind === 'withdrawn' || kind === 'counterevidence') command({ action: 'publish', nodeId: target })
    if (kind === 'replaced') hmm.importEvidence(actor, 't1', view().revision, input)
    else hmm.revokeEvidence(actor, 't1', view().revision, document.id)
    const before = view(), observer = context('hidden')
    expect(before.nodes.find(node => node.id === target)).toMatchObject({ state: 'completed', referenceIntegrity: 'invalid' })
    expect(() => command({ action: 'publish', nodeId: target })).toThrow('失效')
    expect(view()).toEqual(before)
    expect(context('hidden')).toEqual(observer)

    store.close()
    store = new Store(join(directory, 'state.sqlite'))
    hmm = new HmmWorkflows(store)
    expect(view()).toEqual(before)
    expect(() => command({ action: 'publish', nodeId: target })).toThrow('失效')
    complete('hidden', '不依赖失效资料的独立成果')
    command({ action: 'publish', nodeId: 'hidden' })
    expect(view().published).toEqual([...before.published, 'hidden'])
    expect(view().referenceIntegrity).toBe('invalid')
    expect(hmm.context(actor, 't1', target).result?.summary).toBe(kind === 'indirect' ? '引用研究结果的复核' : '已完成的研究')
  },
)

it('重新核验生成有效结果后可以发布，旧结果引用不复活且原文授权不扩大', () => {
  const input = { id: 'memo', title: '依据', origin: '合成资料', text: 'PRIVATE_SOURCE_TEXT', nodeIds: ['a'] }
  const first = hmm.importEvidence(actor, 't1', view().revision, input).document
  const original = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...original }, 't1', 'a', { id: first.id, version: first.version })
  hmm.report(original, { action: 'complete', summary: '原结果', evidenceRefs: [receipt.ref] })
  const previous = resultRef('a')
  hmm.revokeEvidence(actor, 't1', view().revision, first.id)
  expect(() => command({ action: 'publish', nodeId: 'a' })).toThrow('失效')

  command({ action: 'recheck', nodeId: 'a', reason: '重新核验当前资料' })
  const current = hmm.importEvidence(actor, 't1', view().revision, input).document
  command({ action: 'dispatch' })
  const fresh = hmm.claim('t1', 'a')
  const next = hmm.readEvidence({ role: 'node', ...fresh }, 't1', 'a', { id: current.id, version: current.version })
  hmm.report(fresh, { action: 'complete', summary: '重新核验的结果', evidenceRefs: [next.ref] })
  command({ action: 'publish', nodeId: 'a' })
  const consumer = hmm.claim('t1', 'hidden')
  expect(resultRef('a')).not.toBe(previous)
  expect(hmm.readResult(consumer, { ref: resultRef('a') }).result.summary).toBe('重新核验的结果')
  expect(() => hmm.readResult(consumer, { ref: previous })).toThrow('已失效')
  expect(() => hmm.readEvidence({ role: 'node', ...consumer }, 't1', 'hidden', {
    id: current.id, version: current.version,
  })).toThrow('不在节点范围')
})

it.each(['revoke', 'replace'] as const)('依据 %s 后，分组依赖的新执行被阻止，独立分支和历史结果保留', action => {
  const input = { id: 'source', title: '资料', origin: '操作者输入', text: '原始片段', nodeIds: ['a'] }
  const document = hmm.importEvidence(actor, 't1', view().revision, input).document
  const source = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...source }, 't1', 'a', { id: document.id, version: document.version })
  hmm.report(source, { action: 'complete', summary: '已有结论', evidenceRefs: [receipt.ref] })
  command({ action: 'publish', nodeId: 'a' })
  complete('b', '基于共享结果的推断', [resultRef('a')])
  const oldRef = resultRef('a')
  expect(view().runnable).toContain('review')
  const before = view().revision
  expect(() => store.atomic(() => {
    hmm.revokeEvidence(actor, 't1', view().revision, document.id)
    expect(view().runnable).not.toContain('review')
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(view().runnable).toContain('review')
  expect(view().revision).toBe(before)
  if (action === 'revoke') hmm.revokeEvidence(actor, 't1', view().revision, document.id)
  else hmm.importEvidence(actor, 't1', view().revision, input)
  const revision = view().revision
  expect(view().runnable).toEqual(['hidden'])
  expect(view().nodes.find(node => node.id === 'review')).toMatchObject({
    state: 'pending', attempt: 0, blockedBy: ['research'],
  })
  for (const id of ['a', 'b'])
    expect(view().nodes.find(node => node.id === id)).toMatchObject({ state: 'completed', referenceIntegrity: 'invalid' })
  expect(hmm.dispatchable().find(item => item.ticketId === 't1')!.nodes).toEqual(['hidden'])
  expect(() => hmm.claim('t1', 'review')).toThrow('未就绪')
  expect(view().revision).toBe(revision)
  expect(resultRef('a')).toBe(oldRef)
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  hmm = new HmmWorkflows(store)
  expect(view().runnable).toEqual(['hidden'])
  expect(view().revision).toBe(revision)
})

it('祖先分组的显式依赖参与阻止，但串行先后和可选黑板不变成必需数据依赖', () => {
  const definition = hmm.definition(actor, 't1')
  const nodes = definition.plan.nodes.map(node => node.id === 'root' ? { ...node, mode: 'serial' as const }
    : node.id === 'review' ? { ...node, id: 'review_group', mode: 'parallel' as const, instruction: undefined } : node)
  hmm.revise(actor, 't1', { revision: view().revision, reason: '分组核验', plan: { ...definition.plan, nodes: [
    ...nodes, { id: 'inspect', parentId: 'review_group', title: '核验子步骤', instruction: '使用必需研究产物' },
  ] } })
  command({ action: 'dispatch' })
  const document = hmm.importEvidence(actor, 't1', view().revision, {
    id: 'source', title: '资料', origin: '操作者输入', text: '原始片段', nodeIds: ['a'],
  }).document
  const source = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...source }, 't1', 'a', { id: document.id, version: document.version })
  hmm.report(source, { action: 'complete', summary: '共享结论', evidenceRefs: [receipt.ref] })
  complete('b')
  command({ action: 'publish', nodeId: 'a' })
  hmm.revokeEvidence(actor, 't1', view().revision, document.id)
  expect(view().runnable).toEqual(['hidden'])
  complete('hidden')
  expect(view().nodes.find(node => node.id === 'inspect')).toMatchObject({
    state: 'pending', attempt: 0, blockedBy: ['research'],
  })
  expect(view().runnable).toEqual([])
  expect(() => hmm.claim('t1', 'inspect')).toThrow('未就绪')
})

it.each([
  { shape: 'direct', change: 'revoke', manual: true },
  { shape: 'group', change: 'replace', manual: false },
  { shape: 'ancestor', change: 'revoke', manual: false },
] as const)('$shape 必需依据在执行中 $change，不能只引用任务输入提交完成', ({ shape, change, manual }) => {
  if (shape !== 'group') {
    const { plan } = hmm.definition(actor, 't1')
    const nodes: PlanInput['nodes'] = plan.nodes.map(node => node.id !== 'review' ? node
      : { ...node, parentId: shape === 'ancestor' ? 'review_group' : 'research',
        dependsOn: shape === 'direct' ? ['a'] : [] })
    if (shape === 'ancestor') nodes.push({
      id: 'review_group', parentId: 'root', title: '复核组', mode: 'parallel', dependsOn: ['research'],
    })
    hmm.revise(actor, 't1', { revision: view().revision, reason: '验证不同依赖位置', plan: { ...plan, nodes } })
    command({ action: 'dispatch' })
  }
  const input = { id: 'source', title: '资料', origin: '操作者输入', text: '原始片段', nodeIds: ['a'] }
  const document = hmm.importEvidence(actor, 't1', view().revision, input).document
  const source = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...source }, 't1', 'a', { id: document.id, version: document.version })
  hmm.report(source, { action: 'complete', summary: '必需上游结果', evidenceRefs: [receipt.ref] })
  complete('b')
  if (manual) command({ action: 'hold' })
  const binding = manual ? undefined : hmm.claim('t1', 'review')
  const lease = binding?.lease ?? command({ action: 'start', nodeId: 'review' }).lease!
  const report = (summary: string) => {
    const input = { action: 'complete' as const, summary, evidenceRefs: [context('review').inputRef!] }
    return binding ? hmm.report(binding, input) : command({ ...input, nodeId: 'review', lease })
  }
  command({ action: 'checkpoint', nodeId: 'review', lease, frame: '保留当前进度' })
  if (change === 'revoke') hmm.revokeEvidence(actor, 't1', view().revision, document.id)
  else hmm.importEvidence(actor, 't1', view().revision, input)
  const before = view(), frame = context('review')
  expect(() => report('依据失效后仍声称完成')).toThrow(expect.objectContaining({ code: 'evidence_invalid', status: 409 }))
  expect(view()).toEqual(before)
  expect(context('review')).toEqual(frame)
  command({ action: 'checkpoint', nodeId: 'review', lease, frame: '等待重新核验，不丢弃工作帧' })
  command({ action: 'suspend', nodeId: 'review', reason: '必需依据待重新核验' })
  command({ action: 'recheck', nodeId: 'a', reason: '重新取得资料并核验依赖' })
  command({ action: 'dispatch' })
  const fresh = hmm.importEvidence(actor, 't1', view().revision, input).document
  const next = hmm.claim('t1', 'a')
  const updated = hmm.readEvidence({ role: 'node', ...next }, 't1', 'a', { id: fresh.id, version: fresh.version })
  hmm.report(next, { action: 'complete', summary: '已重新核验', evidenceRefs: [updated.ref] })
  complete('review')
  expect(context('review').state).toBe('completed')
  expect(context('review').result?.evidenceRefs).toEqual([context('review').inputRef])
})

it('执行期间可选黑板失效，不阻止没有该数据依赖的串行后继完成', () => {
  const { plan } = hmm.definition(actor, 't1')
  hmm.revise(actor, 't1', { revision: view().revision, reason: '区分顺序与数据依赖',
    plan: { ...plan, nodes: plan.nodes.map(node => node.id === 'root' ? { ...node, mode: 'serial' as const } : node) } })
  command({ action: 'dispatch' })
  const document = hmm.importEvidence(actor, 't1', view().revision, {
    id: 'source', title: '资料', origin: '操作者输入', text: '可选资料', nodeIds: ['a'],
  }).document
  const source = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...source }, 't1', 'a', { id: document.id, version: document.version })
  hmm.report(source, { action: 'complete', summary: '共享产物', evidenceRefs: [receipt.ref] })
  complete('b')
  command({ action: 'publish', nodeId: 'a' })
  const binding = hmm.claim('t1', 'hidden')
  hmm.revokeEvidence(actor, 't1', view().revision, document.id)
  hmm.report(binding, { action: 'complete', summary: '不使用可选资料的独立结果', evidenceRefs: [context('hidden').inputRef!] })
  expect(context('hidden').state).toBe('completed')
  expect(view().nodes.find(node => node.id === 'review')?.blockedBy).toEqual(['research'])
  expect(view().nodes.find(node => node.id === 'hidden')?.referenceIntegrity).toBeUndefined()
  command({ action: 'publish', nodeId: 'hidden' })
})

it('有效必需依赖不自动成为原文证据，仍须明确引用已提供的上游成果', () => {
  const { plan } = hmm.definition(actor, 't1')
  hmm.revise(actor, 't1', { revision: view().revision, reason: '区分执行依赖与证据支持',
    plan: { ...plan, nodes: plan.nodes.map(node => node.id === 'review' ? { ...node, evidenceRequired: true } : node) } })
  command({ action: 'dispatch' })
  const document = hmm.importEvidence(actor, 't1', view().revision, {
    id: 'source', title: '资料', origin: '合成输入', text: '需要实际引用的资料', nodeIds: ['a'],
  }).document
  const source = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...source }, 't1', 'a', { id: document.id, version: document.version })
  hmm.report(source, { action: 'complete', summary: '有原文的结论', evidenceRefs: [receipt.ref] })
  complete('b')
  const review = hmm.claim('t1', 'review'), before = view()
  expect(() => hmm.report(review, { action: 'complete', summary: '未引用上游', evidenceRefs: [context('review').inputRef!] }))
    .toThrow('任务输入引用不能替代取证')
  expect(view()).toEqual(before)
  hmm.report(review, { action: 'complete', summary: '明确引用上游', evidenceRefs: [resultRef('a')] })
  expect(context('review').state).toBe('completed')
  expect(view().referenceIntegrity).toBe('valid')
})

it.each([
  { shape: 'direct', change: 'revoke' },
  { shape: 'group', change: 'replace' },
  { shape: 'ancestor', change: 'revoke' },
] as const)('$shape 已完成结果也随必需依据 $change 失效，不能省略引用后继续传播', ({ shape, change }) => {
  const { plan } = hmm.definition(actor, 't1')
  const parentId = shape === 'direct' ? 'research' : shape === 'ancestor' ? 'review_group' : 'root'
  const nodes: PlanInput['nodes'] = plan.nodes.map(node => node.id !== 'review' ? node
    : { ...node, parentId, dependsOn: shape === 'direct' ? ['a'] : shape === 'ancestor' ? [] : ['research'] })
  if (shape === 'ancestor') nodes.push({
    id: 'review_group', parentId: 'root', title: '复核组', mode: 'parallel', dependsOn: ['research'],
  })
  nodes.push(
    { id: 'followup', parentId, title: '后续结论', instruction: '依据复核完成后续结论', dependsOn: ['review'] },
    { id: 'waiting', parentId, title: '待执行', instruction: '消费后续结论', dependsOn: ['followup'] },
    { id: 'independent', parentId: 'root', title: '独立任务', instruction: '不使用研究资料' },
  )
  hmm.revise(actor, 't1', { revision: view().revision, reason: '检验已完成结果的依赖链', plan: { ...plan, nodes } })
  command({ action: 'dispatch' })
  const input = { id: 'source', title: '资料', origin: '合成输入', text: 'PRIVATE_SOURCE_TEXT', nodeIds: ['a'] }
  const document = hmm.importEvidence(actor, 't1', view().revision, input).document
  const binding = hmm.claim('t1', 'a')
  const receipt = hmm.readEvidence({ role: 'node', ...binding }, 't1', 'a', { id: document.id, version: document.version })
  hmm.report(binding, { action: 'complete', summary: '来源结论', evidenceRefs: [receipt.ref] })
  if (shape === 'group') command({ action: 'prune', nodeId: 'b', reason: '此分支不参与结论', reconsiderWhen: '出现新的独立证据' })
  else complete('b')
  const review = hmm.claim('t1', 'review'), inputRef = context('review').inputRef!
  hmm.report(review, { action: 'complete', summary: '复核结果', evidenceRefs: [inputRef], claims: [{
    id: 'assessment', subject: '方案', predicate: '可行性', object: '待实测', kind: 'inferred',
    evidenceRefs: [inputRef], counterEvidenceRefs: [],
  }] })
  complete('followup')
  complete('independent')
  command({ action: 'publish', nodeId: 'review' })
  command({ action: 'publish', nodeId: 'followup' })
  const observer = hmm.claim('t1', 'hidden'), refs = [resultRef('review'), resultRef('followup')]
  const graph = () => hmm.claims(actor, 't1', undefined, {})
  expect(graph().nodes[0]?.referenceIntegrity).toBe('valid')
  for (const ref of refs) expect(hmm.readResult(observer, { ref }).ref).toBe(ref)

  if (change === 'revoke') hmm.revokeEvidence(actor, 't1', view().revision, document.id)
  else hmm.importEvidence(actor, 't1', view().revision, input)
  const before = view()
  expect(before.nodes.filter(node => node.referenceIntegrity === 'invalid').map(node => node.id).sort())
    .toEqual(['a', 'followup', 'review'])
  expect(before.nodes.find(node => node.id === 'waiting')).toMatchObject({
    state: 'pending', attempt: 0, blockedBy: shape === 'ancestor' ? ['followup', 'research'] : ['followup'],
  })
  expect(graph().nodes[0]?.referenceIntegrity).toBe('invalid')
  for (const nodeId of ['review', 'followup']) expect(() => command({ action: 'publish', nodeId })).toThrow('失效')
  for (const ref of refs) expect(() => hmm.readResult(observer, { ref })).toThrow()
  expect(() => hmm.claim('t1', 'waiting')).toThrow('未就绪')
  expect(view()).toEqual(before)
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  hmm = new HmmWorkflows(store)
  expect(view()).toEqual(before)
  for (const ref of refs) expect(() => hmm.readResult(observer, { ref })).toThrow()
  command({ action: 'publish', nodeId: 'independent' })
  expect(hmm.readResult(observer, { ref: resultRef('independent') }).result.summary).toBe('independent_RESULT')
})

it('恢复只依赖持久业务结果，重建执行后可按原引用读取，不依赖旧会话', () => {
  const old = ready(), ref = resultRef('a')
  hmm.report(old, { action: 'checkpoint', frame: '尚未完成的复核' })
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  hmm = new HmmWorkflows(store)
  hmm.recover()
  expect(() => hmm.readResult(old, { ref })).toThrow('失效')
  command({ action: 'resume', nodeId: 'review' })
  command({ action: 'dispatch' })
  const fresh = hmm.claim('t1', 'review')
  expect(fresh.sessionId).not.toBe(old.sessionId)
  expect(hmm.executionContext(fresh).frame).toBe('尚未完成的复核')
  expect(hmm.readResult(fresh, { ref })).toMatchObject({
    ref, result: { summary: 'a_RESULT' },
  })
})
