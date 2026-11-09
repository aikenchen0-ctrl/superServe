import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { HmmWorkflows } from '../src/hmm/workflow.ts'
import { CLAIM_LIMITS, type HmmClaim } from '../src/hmm/claims.ts'
import type { HmmActor, HmmCommand } from '../src/hmm/model.ts'
import type { Ticket } from '../src/core/model.ts'
import { KV } from '../src/kv.ts'

const controller: HmmActor = { role: 'controller' }
let directory: string, store: Store, hmm: HmmWorkflows
const ticket = (id: string): Ticket => ({
  id, title: id, decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' },
    actor: { source: 'test', id: 'owner' }, scope: 'test' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'e1', triggerIds: ['e1'] },
})
const view = () => hmm.view(controller, 't1')
const command = (input: HmmCommand) => hmm.apply(controller, 't1', view().revision, input)
const context = (nodeId = 'a') => hmm.context(controller, 't1', nodeId)
const graph = (nodeId?: string, page = {}) => hmm.claims(controller, 't1', nodeId, page)
const claim = (evidenceRef: string, extra: Partial<HmmClaim> = {}): HmmClaim => ({
  id: 'delivery', subject: 'Project', predicate: 'delivery_date', object: 'November 8',
  kind: 'extracted', evidenceRefs: [evidenceRef], counterEvidenceRefs: [], ...extra,
})
const evidence = (id = 'schedule', nodeIds = ['a']) => {
  const imported = hmm.importEvidence(controller, 't1', view().revision, {
    id, title: 'Schedule', origin: 'Operator-provided note', text: 'PRIVATE_RAW: planned delivery November 8', nodeIds,
  })
  return hmm.readEvidence(controller, 't1', nodeIds[0]!, { id, version: imported.document.version })
}
const start = (nodeId = 'a') => command({ action: 'start', nodeId }).lease!
const finish = (lease: string, refs: string[], claims?: HmmClaim[], nodeId = 'a') =>
  command({ action: 'complete', nodeId, lease, summary: 'Scoped conclusion', evidenceRefs: refs, ...(claims ? { claims } : {}) })
const terminal = () => {
  for (const nodeId of ['b', 'c']) command({ action: 'prune', nodeId, reason: 'Not needed', reconsiderWhen: 'Scope changes' })
}
const validate = () => command({ action: 'validate', summary: 'Reviewed', evidenceRefs: [context().resultRef!] })
const review = (verdict: 'accept' | 'reject' | 'needs_evidence' = 'accept') => command({
  action: 'review_claims', reviews: graph().nodes.map(node => ({ ref: node.ref, verdict, reason: 'Reviewed source and counterevidence' })),
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hmm-claims-'))
  store = new Store(join(directory, 'state.sqlite')); hmm = new HmmWorkflows(store)
  for (const id of ['t1', 't2']) {
    store.tickets.save(ticket(id))
    hmm.create(controller, id, { goal: 'Verify individual claims', nodes: [
      { id: 'root', title: 'Root', mode: 'parallel' },
      { id: 'a', parentId: 'root', title: 'Extract', instruction: 'Read schedule', evidenceRequired: true, claimsRequired: true },
      { id: 'b', parentId: 'root', title: 'Other', instruction: 'Independent reasoning' },
      { id: 'c', parentId: 'root', title: 'Derive', instruction: 'Use upstream claims', dependsOn: ['a'], evidenceRequired: true, claimsRequired: true },
    ] })
  }
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('要求逐条断言时不能仅用总结或输入引用完成', () => {
  const lease = start(), doc = evidence(), before = view().revision
  expect(() => finish(lease, [doc.ref])).toThrow('逐条断言')
  expect(view().revision).toBe(before)
  expect(context().state).toBe('running')
  expect(() => finish(lease, [doc.ref], [claim(context().inputRef!)])).toThrow('原文回执')
})

it('每条断言单独核验，不能用一条有效证据掩盖另一条伪造引用', () => {
  const lease = start(), doc = evidence()
  expect(() => finish(lease, [doc.ref], [claim(doc.ref), claim('evidence:invented', { id: 'another' })])).toThrow('未由宿主')
  expect(context().result).toBeUndefined()
  finish(lease, [doc.ref], [claim(doc.ref)])
  expect(graph().nodes[0]).toMatchObject({ subject: 'Project', predicate: 'delivery_date', kind: 'extracted',
    referenceIntegrity: 'valid', review: null })
  expect(graph().edges).toEqual([{ from: doc.ref, to: graph().nodes[0]!.ref, kind: 'supports' }])
  expect(JSON.stringify(graph())).not.toContain('PRIVATE_RAW')
})

it('反证单列保留，但反证不能代替支持证据或隐去不合法引用', () => {
  const lease = start(), doc = evidence(), counter = evidence('other')
  expect(() => finish(lease, [doc.ref], [claim(context().inputRef!, { kind: 'inferred', counterEvidenceRefs: [counter.ref] })]))
    .toThrow('缺少原文支持')
  expect(() => finish(lease, [doc.ref], [claim(doc.ref, { counterEvidenceRefs: ['evidence:invented'] })])).toThrow('未由宿主')
  expect(() => finish(lease, [doc.ref], [claim(doc.ref, { counterEvidenceRefs: [context().inputRef!] })])).toThrow('反证必须')
  finish(lease, [doc.ref], [claim(doc.ref, { counterEvidenceRefs: [counter.ref] })])
  expect(graph().edges).toContainEqual({ from: counter.ref, to: graph().nodes[0]!.ref, kind: 'contradicts' })
  expect(view().claimReviews).toEqual({ total: 1, accepted: 0, pending: 1, blocked: 0 })
})

it('重复编号、重复引用和支持反证混用全部拒绝', () => {
  const lease = start(), doc = evidence()
  expect(() => finish(lease, [doc.ref], [claim(doc.ref), claim(doc.ref)])).toThrow('编号重复')
  expect(() => finish(lease, [doc.ref], [claim(doc.ref, { evidenceRefs: [doc.ref, doc.ref] })])).toThrow('不能重复')
  expect(() => finish(lease, [doc.ref], [claim(doc.ref, { counterEvidenceRefs: [doc.ref] })])).toThrow('相互混用')
})

it('节点不能自封事实或携带复核字段，领域 schema 拒绝额外参数', () => {
  const lease = start(), doc = evidence()
  for (const extra of [{ kind: 'confirmed' }, { review: { verdict: 'accept' } }, { confidence: 1 }]) {
    expect(() => hmm.apply(controller, 't1', view().revision, {
      action: 'complete', nodeId: 'a', lease, summary: 'Unsafe', evidenceRefs: [doc.ref], claims: [{ ...claim(doc.ref), ...extra }],
    })).toThrow()
  }
})

it('每条断言经总管复核后才能验收，否决和补证阻止交付', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref)]); terminal()
  expect(() => validate()).toThrow('未复核')
  review('needs_evidence')
  expect(() => validate()).toThrow('需补证')
  review('reject')
  expect(view().claimReviews.blocked).toBe(1)
  expect(() => validate()).toThrow('被否决')
  review()
  expect(graph().nodes[0]).toMatchObject({ kind: 'extracted', review: { verdict: 'accept', actor: 'controller' } })
  validate()
  expect(() => hmm.assertReady('t1')).not.toThrow()
})

it('验收后改变复核意见会重开验收，已有认可不覆盖新的否决', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref)]); terminal(); review(); validate()
  review('reject')
  expect(view()).toMatchObject({ phase: 'active', autoRun: false, validation: undefined })
  expect(() => hmm.assertReady('t1')).toThrow('尚未验收')
})

it('复核采用版本检查并原子提交，过期或不存在的断言不能批量混入', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref)])
  const ref = graph().nodes[0]!.ref, revision = view().revision
  expect(() => command({ action: 'review_claims', reviews: [
    { ref, verdict: 'accept', reason: 'Checked' }, { ref: 'claim:missing', verdict: 'accept', reason: 'Invented' },
  ] })).toThrow('断言不存在')
  expect(view().revision).toBe(revision)
  expect(graph().nodes[0]!.review).toBeNull()
  review()
  expect(() => hmm.apply(controller, 't1', revision, { action: 'review_claims', reviews: [
    { ref, verdict: 'reject', reason: 'Stale' },
  ] })).toThrow('更新')
})

it('独立自动节点看不到兄弟断言，也不能为自己或别人写复核', () => {
  command({ action: 'dispatch' })
  const a = hmm.claim('t1', 'a'), b = hmm.claim('t1', 'b'), doc = evidence()
  hmm.report(a, { action: 'complete', summary: 'Read', evidenceRefs: [doc.ref], claims: [claim(doc.ref)] })
  const actor: HmmActor = { role: 'node', ...b }
  expect(hmm.claims(actor, 't1', 'b', {}).nodes).toEqual([])
  expect(() => hmm.claims(actor, 't1', 'a', {})).toThrow('兄弟')
  expect(() => hmm.apply(actor, 't1', view().revision, { action: 'review_claims', reviews: [
    { ref: graph().nodes[0]!.ref, verdict: 'accept', reason: 'Self approval' },
  ] })).toThrow('总管')
  command({ action: 'publish', nodeId: 'a' })
  expect(hmm.claims(actor, 't1', 'b', {}).nodes).toHaveLength(1)
  expect(() => hmm.readEvidence(actor, 't1', 'b', { id: doc.documentId, version: doc.version })).toThrow('不在节点范围')
})

it('上游断言可作为推断来源，但不能改标为本节点资料摘取', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref)])
  const upstream = graph('c').nodes[0]!.ref, next = start('c')
  expect(context('c').dependencies[0]!.result).not.toHaveProperty('claims')
  expect(context('c').dependencies[0]!.result).toHaveProperty('claimCount', 1)
  expect(() => finish(next, [upstream], [claim(upstream)], 'c')).toThrow('上游推断不能')
  finish(next, [upstream], [claim(upstream, { kind: 'inferred', object: 'Resources required before November 8' })], 'c')
  expect(graph().nodes.map(node => node.kind)).toEqual(['extracted', 'inferred'])
  review()
  expect(graph().nodes[1]!.kind).toBe('inferred')
})

it('未获共享权限的断言及跨工单引用不能作为来源', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref)])
  const ref = graph().nodes[0]!.ref
  const otherLease = start('b')
  expect(() => finish(otherLease, [ref], [claim(ref, { kind: 'inferred' })], 'b')).toThrow('未由宿主')
  const second = hmm.apply(controller, 't2', 1, { action: 'start', nodeId: 'a' })
  expect(() => hmm.apply(controller, 't2', second.revision, {
    action: 'complete', nodeId: 'a', lease: second.lease!, summary: 'Copied', evidenceRefs: [ref], claims: [claim(ref, { kind: 'inferred' })],
  })).toThrow('未由宿主')
  expect(() => hmm.claims({ role: 'worker', ticketId: 't2' }, 't1', undefined, {})).toThrow('其他工单')
})

it('反证撤回也使断言及派生链失效，既有总管认可不能覆盖失效', () => {
  const lease = start(), doc = evidence(), counter = evidence('other')
  finish(lease, [doc.ref], [claim(doc.ref, { counterEvidenceRefs: [counter.ref] })])
  const ref = graph().nodes[0]!.ref, next = start('c')
  finish(next, [ref], [claim(ref, { kind: 'inferred' })], 'c')
  command({ action: 'prune', nodeId: 'b', reason: 'Not needed', reconsiderWhen: 'Scope changes' })
  review(); validate()
  hmm.revokeEvidence(controller, 't1', view().revision, 'other')
  expect(view().referenceIntegrity).toBe('invalid')
  expect(graph().nodes.every(node => node.referenceIntegrity === 'invalid')).toBe(true)
  expect(() => hmm.assertReady('t1')).toThrow('撤回')
})

it('重查清理断言、复核和派生结果，新执行不能复用旧引用', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref)])
  const ref = graph().nodes[0]!.ref, next = start('c')
  finish(next, [ref], [claim(ref, { kind: 'inferred' })], 'c'); review()
  command({ action: 'recheck', nodeId: 'a', reason: 'Source changed' })
  expect(graph().nodes).toEqual([])
  expect(view().claimReviews.total).toBe(0)
  expect(context('c').state).toBe('pending')
  expect(store.get(KV.hmm.workflow('t1'))!.claimReviews).toEqual([])
  const lease2 = start(), doc2 = evidence()
  expect(() => finish(lease2, [ref], [claim(ref, { kind: 'inferred' })])).toThrow('未由宿主')
  finish(lease2, [doc2.ref], [claim(doc2.ref)])
  expect(graph().nodes[0]!.ref).not.toBe(ref)
})

it('断言图分页有上限和版本条件，不返回正文或无关分支', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref), claim(doc.ref, { id: 'budget', predicate: 'budget', object: 'Unknown' })])
  const first = graph(undefined, { limit: 1 })
  expect(first).toMatchObject({ total: 2, nextOffset: 1 })
  expect(() => graph(undefined, { offset: 1, limit: 1 })).toThrow('相同计划版本')
  expect(graph(undefined, { offset: 1, limit: 1, revision: first.revision }).nodes[0]!.id).toBe('budget')
  review()
  expect(() => graph(undefined, { offset: 1, revision: first.revision })).toThrow('重新读取')
  expect(() => graph(undefined, { limit: 9 })).toThrow()
})

it('断言、支持反证边和复核结果随 SQLite 重开保持一致', () => {
  const lease = start(), doc = evidence()
  finish(lease, [doc.ref], [claim(doc.ref)]); review()
  const before = graph()
  store.close(); store = new Store(join(directory, 'state.sqlite')); hmm = new HmmWorkflows(store)
  expect(graph()).toEqual(before)
})

it('非事实节点可明确保留假设推断，不会被自动标为外部事实', () => {
  const lease = start('b'), input = context('b').inputRef!
  finish(lease, [input], [claim(input, { kind: 'inferred', object: 'Assumption under task constraints' })], 'b')
  expect(graph().nodes[0]).toMatchObject({ kind: 'inferred', referenceIntegrity: 'valid', review: null })
})

it('多层共享断言可收敛核验，单次校验缓存不掩盖后续撤回', () => {
  store.tickets.save(ticket('shared'))
  hmm.create(controller, 'shared', { goal: 'Verify shared evidence chains', nodes: [
    { id: 'root', title: 'Root', mode: 'serial' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, parentId: 'root', title: 'Derive',
      instruction: 'Keep both supported conclusions', dependsOn: i === 0 ? [] : [`n${i - 1}`],
      evidenceRequired: true, claimsRequired: true })),
  ] })
  const state = () => hmm.view(controller, 'shared')
  const update = (command: HmmCommand) => hmm.apply(controller, 'shared', state().revision, command)
  let refs: string[] = []
  const reviews: { ref: string; verdict: 'accept'; reason: string }[] = []
  for (let i = 0; i < 8; i++) {
    const nodeId = `n${i}`, active = update({ action: 'start', nodeId })
    if (i === 0) {
      const imported = hmm.importEvidence(controller, 'shared', state().revision, {
        id: 'source', title: 'Source', origin: 'Operator note', text: 'Shared source', nodeIds: [nodeId],
      })
      refs = [hmm.readEvidence(controller, 'shared', nodeId, { id: 'source', version: imported.document.version }).ref]
    }
    update({ action: 'complete', nodeId, lease: active.lease!, summary: 'Two supported claims', evidenceRefs: refs,
      claims: ['a', 'b'].map(id => claim(refs[0]!, { id, evidenceRefs: refs, kind: i === 0 ? 'extracted' : 'inferred' })) })
    const page = hmm.claims(controller, 'shared', undefined, { offset: i * 2, limit: 2, revision: state().revision })
    expect(page.nodes.map(node => node.referenceIntegrity)).toEqual(['valid', 'valid'])
    refs = page.nodes.map(node => node.ref)
    reviews.push(...refs.map(ref => ({ ref, verdict: 'accept' as const, reason: 'Checked shared support' })))
  }
  update({ action: 'review_claims', reviews })
  update({ action: 'validate', summary: 'Reviewed all claims',
    evidenceRefs: [hmm.context(controller, 'shared', 'n7').resultRef!] })
  expect(() => hmm.assertReady('shared')).not.toThrow()
  hmm.revokeEvidence(controller, 'shared', state().revision, 'source')
  expect(() => hmm.assertReady('shared')).toThrow('撤回')
  expect(hmm.claims(controller, 'shared', undefined, { offset: 14, revision: state().revision }).nodes)
    .toEqual([expect.objectContaining({ referenceIntegrity: 'invalid' }), expect.objectContaining({ referenceIntegrity: 'invalid' })])
})

it('断言总量受工单预算限制，超限不留下部分完成结果', () => {
  store.tickets.save(ticket('large'))
  hmm.create(controller, 'large', { goal: 'Bound graph size', nodes: [
    { id: 'root', title: 'Root', mode: 'parallel' },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, parentId: 'root', title: 'Task', instruction: 'Hypothesis', mode: 'task' as const })),
  ] })
  const large = () => hmm.view(controller, 'large')
  for (let i = 0; i < 9; i++) {
    const nodeId = `n${i}`, active = hmm.apply(controller, 'large', large().revision, { action: 'start', nodeId })
    const input = hmm.context(controller, 'large', nodeId).inputRef!
    const complete = () => hmm.apply(controller, 'large', large().revision, { action: 'complete', nodeId, lease: active.lease!,
      summary: 'Hypotheses', evidenceRefs: [input], claims: Array.from({ length: 8 }, (_, j) =>
        claim(input, { id: `c${j}`, kind: 'inferred' })) })
    if (i < 8) complete(); else expect(complete).toThrow('断言总数')
  }
  expect(large().claimReviews.total).toBe(CLAIM_LIMITS.perWorkflow)
  expect(hmm.context(controller, 'large', 'n8').state).toBe('running')
})
