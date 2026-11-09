import { afterEach, beforeEach, expect, it } from 'vitest'
import { HMM_LIMITS, type HmmCommand, type PlanInput } from '../src/hmm/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

function prepare(requestId: string, options: { grouped?: boolean; optional?: boolean; serial?: boolean; pending?: boolean } = {}) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const ticket = h.runtime.engine.createLocalTask({ requestId, title: 'Dependency review', goal: 'Review authorized evidence' })
  const view = () => h.runtime.hmm.view(controller, ticket.id)
  const command = (input: HmmCommand) => h.runtime.hmm.apply(controller, ticket.id, view().revision, input)
  const downstream = ['quality', 'consistency', 'coverage']
  h.runtime.hmm.create(controller, ticket.id, { goal: ticket.mandate.scope, maxActive: 4, nodes: [
    { id: 'root', title: 'Review', mode: options.serial ? 'serial' : 'parallel' },
    { id: 'extract', parentId: 'root', title: 'PRIVATE_SOURCE_TITLE', instruction: 'Read evidence', evidenceRequired: true },
    { id: 'independent', parentId: 'root', title: 'Budget', instruction: 'Check the budget' },
    ...(options.grouped ? [{ id: 'checks', parentId: 'root', title: 'Checks', mode: 'parallel', dependsOn: ['extract'] }] : []),
    ...downstream.map(id => ({ id, parentId: options.grouped ? 'checks' : 'root', title: id,
      instruction: 'Check the result', dependsOn: options.grouped || options.optional ? [] : ['extract'] })),
  ] })
  const document = h.runtime.hmm.importEvidence(controller, ticket.id, view().revision, {
    id: 'memo', title: 'PRIVATE_DOCUMENT_TITLE', origin: 'Operator', text: 'PRIVATE_SOURCE_BODY', nodeIds: ['extract'],
  }).document
  if (!options.pending) {
    const { lease } = command({ action: 'start', nodeId: 'extract' })
    const receipt = h.runtime.hmm.readEvidence(controller, ticket.id, 'extract', { id: document.id, version: document.version })
    command({ action: 'complete', nodeId: 'extract', lease: lease!, summary: 'PRIVATE_RESULT_BODY', evidenceRefs: [receipt.ref] })
  }
  const revoke = () => h.runtime.hmm.revokeEvidence(controller, ticket.id, view().revision, document.id)
  const isBlockedNotice = (item: Record<string, unknown>) =>
    item.kind === 'hmm_attention' && item.reasonCode === 'dependency_invalid' && item.ticket_id === ticket.id
  const notices = () => h.relays(h.runtime.masterId).filter(isBlockedNotice)
  const queued = () => (h.runtime.store.db.prepare("SELECT value FROM effect WHERE kind = 'relay'").all() as { value: string }[])
    .map(row => JSON.parse(JSON.parse(row.value).text) as Record<string, unknown>).filter(isBlockedNotice)
  return { id: ticket.id, view, command, downstream, revoke, notices, queued }
}

it.each(['before-dispatch', 'during-dispatch'] as const)('%s 发生依据失效时，聚合通知总管一次，独立执行不受影响', async moment => {
  const run = prepare(moment)
  if (moment === 'before-dispatch') {
    run.revoke()
    await h.runtime.idle()
    expect(run.notices()).toHaveLength(0)
  }
  const dispatched = run.command({ action: 'dispatch' })
  await h.runtime.idle()
  const revision = moment === 'during-dispatch' ? run.revoke().revision : dispatched.revision
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  expect(run.notices()[0]).toMatchObject({ revision })
  expect(JSON.stringify(run.notices())).not.toContain('PRIVATE_')
  expect(Buffer.byteLength(JSON.stringify(run.notices()[0]))).toBeLessThan(512)
  expect(run.view().autoRun).toBe(true)
  for (const id of run.downstream)
    expect(run.view().nodes.find(node => node.id === id)).toMatchObject({ state: 'pending', attempt: 0, blockedBy: ['extract'] })
  const independent = run.view().nodes.find(node => node.id === 'independent')!
  expect(independent.state).toBe('running')
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)

  run.command({ action: 'dispatch' })
  run.revoke()
  await h.runTool(independent.sessionId!, 'hmm_node_report', { action: 'checkpoint', frame: 'Still working' })
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)
})

it.each([false, true])('全部下游已运行时仍聚合报告失效依赖，支持回滚和显式恢复（分组：%s）', async grouped => {
  const run = prepare(`running-${grouped}`, { grouped })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 4 } })
  run.command({ action: 'dispatch' })
  await h.runtime.idle()
  const active = run.view().nodes.filter(node => run.downstream.includes(node.id))
  expect(active).toHaveLength(3)
  expect(active.every(node => node.state === 'running')).toBe(true)
  const before = run.view()
  expect(() => h.runtime.store.atomic(() => {
    run.revoke()
    expect(run.queued()).toHaveLength(1)
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(run.view()).toEqual(before)
  expect(run.queued()).toHaveLength(0)
  expect(run.notices()).toHaveLength(0)

  const revision = run.revoke().revision
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  expect(run.notices()[0]).toMatchObject({ revision })
  expect(Buffer.byteLength(JSON.stringify(run.notices()[0]))).toBeLessThan(512)
  const status = await h.api('GET', `tasks/${run.id}`)
  expect(status).toMatchObject({ status: 200, body: { workflow: {
    progress: { running: 4, suspended: 0 },
    blockers: { total: 0 },
    dependencyBlockers: { total: 3, omitted: 0, items: run.downstream.map(nodeId =>
      ({ nodeId, blockedBy: ['extract'], omittedDependencies: 0 })) },
  } } })
  expect(JSON.stringify(status.body)).not.toContain('PRIVATE_')
  expect(Buffer.byteLength(JSON.stringify(status.body))).toBeLessThan(4096)
  expect(await h.api('GET', `tasks/${run.id}`)).toEqual(status)
  expect(run.view().revision).toBe(revision)
  for (const node of active) {
    expect(run.view().nodes.find(item => item.id === node.id)).toMatchObject({
      state: 'running', attempt: 1, sessionId: node.sessionId, blockedBy: ['extract'],
    })
    await h.runTool(node.sessionId!, 'hmm_node_report', { action: 'checkpoint', frame: 'Waiting for evidence review' })
  }
  run.command({ action: 'dispatch' })
  run.revoke()
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  const independent = run.view().nodes.find(node => node.id === 'independent')!
  const context = await h.runTool(independent.sessionId!, 'hmm_node_context', {})
  await h.runTool(independent.sessionId!, 'hmm_node_report', {
    action: 'complete', summary: 'Independent result', evidenceRefs: [context.inputRef],
  })
  await h.runtime.idle()
  const stable = run.view().nodes.find(node => node.id === 'independent')!.resultRef
  run.command({ action: 'recheck', nodeId: 'extract', reason: 'Read the updated evidence' })
  await h.runtime.idle()
  expect(h.runtime.hmmDispatcher.activeCount()).toBe(0)
  expect(run.view().nodes.find(node => node.id === 'independent')?.resultRef).toBe(stable)
  const document = h.runtime.hmm.importEvidence(controller, run.id, run.view().revision, {
    id: 'memo', title: 'Updated evidence', origin: 'Operator', text: 'Updated source', nodeIds: ['extract'],
  }).document
  run.command({ action: 'dispatch' })
  await h.runtime.idle()
  const source = run.view().nodes.find(node => node.id === 'extract')!
  const receipt = await h.runTool(source.sessionId!, 'hmm_evidence_read', { id: document.id, version: document.version })
  await h.runTool(source.sessionId!, 'hmm_node_report', { action: 'complete', summary: 'Updated result', evidenceRefs: [receipt.ref] })
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  for (const node of active) {
    const current = run.view().nodes.find(item => item.id === node.id)!
    expect(current).toMatchObject({ state: 'running', attempt: 2 })
    expect(current.sessionId).not.toBe(node.sessionId)
    expect(current.blockedBy).toBeUndefined()
  }
})

it('最后一次已启动的执行仍报告依据失效，不把通知视为增加重试额度', async () => {
  const run = prepare('running-last-attempt', { grouped: true })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 4 } })
  run.command({ action: 'dispatch' })
  await h.runtime.idle()
  for (let attempt = 1; attempt < HMM_LIMITS.attempts; attempt++) {
    run.command({ action: 'suspend', nodeId: 'checks', reason: 'Operator checkpoint' })
    await h.runtime.idle()
    run.command({ action: 'resume', nodeId: 'checks' })
    await h.runtime.idle()
  }
  run.revoke()
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  for (const nodeId of run.downstream)
    expect(run.view().nodes.find(node => node.id === nodeId)).toMatchObject({
      state: 'running', attempt: HMM_LIMITS.attempts, blockedBy: ['extract'],
    })
  expect(() => run.command({ action: 'recheck', nodeId: 'extract', reason: 'Recheck after invalidation' }))
    .toThrow(expect.objectContaining({ code: 'attempts_exhausted' }))
})

it.each(['before-dispatch', 'during-dispatch'] as const)('%s 剪枝必需上游时，呈现继承依赖并聚合通知，不影响独立分支', async moment => {
  const run = prepare(`pruned-${moment}`, { grouped: true, pending: true })
  const prune = () => run.command({ action: 'prune', nodeId: 'extract', reason: 'PRIVATE_PRUNE_REASON', reconsiderWhen: 'New input' })
  if (moment === 'before-dispatch') {
    prune()
    await h.runtime.idle()
    expect(run.notices()).toHaveLength(0)
  }
  const dispatched = run.command({ action: 'dispatch' })
  await h.runtime.idle()
  const revision = moment === 'during-dispatch' ? prune().revision : dispatched.revision
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  expect(run.notices()[0]).toMatchObject({ revision })
  expect(JSON.stringify(run.notices())).not.toContain('PRIVATE_')
  expect(Buffer.byteLength(JSON.stringify(run.notices()[0]))).toBeLessThan(512)
  expect(run.view()).toMatchObject({ autoRun: true, referenceIntegrity: 'valid', awaitingValidation: false })
  for (const id of run.downstream)
    expect(run.view().nodes.find(node => node.id === id)).toMatchObject({ state: 'pending', attempt: 0, blockedBy: ['extract'] })
  const independent = run.view().nodes.find(node => node.id === 'independent')!
  expect(independent.state).toBe('running')
  expect(h.nodeFactory).toHaveBeenCalledTimes(moment === 'during-dispatch' ? 2 : 1)

  run.command({ action: 'dispatch' })
  await h.runTool(independent.sessionId!, 'hmm_node_report', { action: 'checkpoint', frame: 'Still working' })
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  expect(() => run.command({ action: 'resume', nodeId: 'extract' })).toThrow('挂起')
  expect(() => run.command({ action: 'recheck', nodeId: 'extract', reason: 'Try again' })).toThrow('剪枝')

  const context = await h.runTool(independent.sessionId!, 'hmm_node_context', {})
  await h.runTool(independent.sessionId!, 'hmm_node_report', {
    action: 'complete', summary: 'Budget checked', evidenceRefs: [context.inputRef],
  })
  await h.runtime.idle()
  const stable = run.view().nodes.find(node => node.id === 'independent')!.resultRef
  const plan: PlanInput = h.runtime.hmm.definition(controller, run.id).plan
  plan.nodes = plan.nodes.filter(node => node.id !== 'extract')
  plan.nodes.push({ id: 'replacement', parentId: 'root', title: 'Replacement', instruction: 'Check the revised assumption' })
  plan.nodes.find(node => node.id === 'checks')!.dependsOn = ['replacement']
  h.runtime.hmm.revise(controller, run.id, { revision: run.view().revision, plan, reason: 'Replace the unavailable path' })
  expect(run.view().nodes.some(node => node.blockedBy?.length)).toBe(false)
  expect(run.view().nodes.find(node => node.id === 'independent')?.resultRef).toBe(stable)
  run.command({ action: 'dispatch' })
  await h.runtime.idle()
  const replacement = run.view().nodes.find(node => node.id === 'replacement')!
  expect(replacement.state).toBe('running')
  const input = await h.runTool(replacement.sessionId!, 'hmm_node_context', {})
  await h.runTool(replacement.sessionId!, 'hmm_node_report', {
    action: 'complete', summary: 'Revised assumption checked', evidenceRefs: [input.inputRef],
  })
  await h.runtime.idle()
  expect(run.view().nodes.find(node => node.id === run.downstream[0])?.state).toBe('running')
  expect(run.notices()).toHaveLength(1)
})

it.each(['held', 'suspended', 'serial', 'optional'] as const)('%s 不因剪枝制造无效通知，其他等待解除后才报告必需阻断', async mode => {
  const run = prepare(`quiet-prune-${mode}`, {
    pending: true, grouped: mode === 'suspended', serial: mode === 'serial' || mode === 'optional', optional: mode === 'optional',
  })
  if (mode === 'suspended') run.command({ action: 'suspend', nodeId: 'checks', reason: 'Wait for operator' })
  if (mode === 'held') run.command({ action: 'hold' })
  run.command({ action: 'prune', nodeId: 'extract', reason: 'Unavailable', reconsiderWhen: 'New input' })
  if (mode !== 'held') run.command({ action: 'dispatch' })
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(0)
  if (mode === 'held') run.command({ action: 'dispatch' })
  else if (mode === 'suspended') run.command({ action: 'resume', nodeId: 'checks' })
  else {
    const independent = run.view().nodes.find(node => node.id === 'independent')!
    const context = await h.runTool(independent.sessionId!, 'hmm_node_context', {})
    await h.runTool(independent.sessionId!, 'hmm_node_report', {
      action: 'complete', summary: 'Budget checked', evidenceRefs: [context.inputRef],
    })
  }
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(mode === 'optional' ? 0 : 1)
  if (mode === 'optional') {
    expect(run.view().nodes.some(node => node.blockedBy?.length)).toBe(false)
    expect(run.view().nodes.find(node => node.id === run.downstream[0])?.state).toBe('running')
  }
})

it('挂起分组不因依据失效唤醒总管，显式恢复后通知其新出现的依赖阻断', async () => {
  const run = prepare('suspended-group', { grouped: true })
  run.command({ action: 'suspend', nodeId: 'checks', reason: 'Wait for operator' })
  run.command({ action: 'dispatch' })
  await h.runtime.idle()
  run.revoke()
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(0)
  run.command({ action: 'resume', nodeId: 'checks' })
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  for (const id of run.downstream)
    expect(run.view().nodes.find(node => node.id === id)).toMatchObject({ state: 'pending', blockedBy: ['extract'] })
})

it('可选共享结果失效不产生依赖阻断通知', async () => {
  const run = prepare('optional-publication', { optional: true })
  run.command({ action: 'publish', nodeId: 'extract' })
  run.command({ action: 'dispatch' })
  await h.runtime.idle()
  run.revoke()
  await h.runtime.idle()
  expect(run.view().referenceIntegrity).toBe('invalid')
  expect(run.view().runnable).toEqual(run.downstream)
  expect(run.notices()).toHaveLength(0)
})

it('串行等待不通知，前置任务完成后才报告实际妨碍下一步的依赖阻断', async () => {
  const run = prepare('serial-prerequisite', { serial: true })
  run.command({ action: 'dispatch' })
  await h.runtime.idle()
  run.revoke()
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(0)
  const independent = run.view().nodes.find(node => node.id === 'independent')!
  const context = await h.runTool(independent.sessionId!, 'hmm_node_context', {})
  await h.runTool(independent.sessionId!, 'hmm_node_report', {
    action: 'complete', summary: 'Budget checked', evidenceRefs: [context.inputRef],
  })
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  expect(run.view().runnable).toEqual([])
  expect(h.nodeFactory).toHaveBeenCalledTimes(1)
})

it.each(['revoke', 'prune'] as const)('%s 阻断与通知同事务回滚，已提交通知跨重启送达但不自动恢复执行', async cause => {
  const run = prepare('durable-blocked-notice', { pending: cause === 'prune' })
  const block = () => cause === 'revoke' ? run.revoke()
    : run.command({ action: 'prune', nodeId: 'extract', reason: 'Unavailable', reconsiderWhen: 'New input' })
  await h.runtime.effects.drain()
  const before = run.view()
  expect(() => h.runtime.store.atomic(() => {
    block()
    run.command({ action: 'dispatch' })
    expect(run.queued()).toHaveLength(1)
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(run.view()).toEqual(before)
  expect(run.queued()).toHaveLength(0)

  block()
  run.command({ action: 'dispatch' })
  const revision = run.view().revision
  expect(run.queued()).toHaveLength(1)
  expect(run.notices()).toHaveLength(0)
  await h.restart()
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
  expect(run.notices()[0]).toMatchObject({ revision })
  expect(run.queued()).toHaveLength(0)
  expect(run.view().autoRun).toBe(false)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  await h.restart()
  await h.runtime.idle()
  expect(run.notices()).toHaveLength(1)
})
