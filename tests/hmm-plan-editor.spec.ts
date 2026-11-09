import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { KV } from '../src/kv.ts'
import { HMM_LIMITS, type DependencyCycleLink } from '../src/hmm/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { host = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await host.stop() })

it('管理界面读取、预览和应用走真实HTTP事务；只撤销受影响结果与授权，应用不启动节点', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-editor', dispatch: false, goal: 'Check authorized sources',
    plan: { nodes: [
      { id: 'root', title: 'Comparison', mode: 'parallel' },
      { id: 'source', parentId: 'root', title: 'Source', instruction: 'Check source' },
      { id: 'other', parentId: 'root', title: 'Independent', instruction: 'Check independent source' },
      { id: 'review', parentId: 'root', title: 'Review', instruction: 'Review result', dependsOn: ['source'] },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string
  const workflows = host.runtime.hmm
  const view = () => workflows.view(controller, id)
  const complete = (nodeId: string) => {
    const start = workflows.apply(controller, id, view().revision, { action: 'start', nodeId })
    const context = workflows.context(controller, id, nodeId)
    workflows.apply(controller, id, view().revision, { action: 'complete', nodeId, lease: start.lease!,
      summary: `Result ${nodeId}`, evidenceRefs: [context.inputRef!] })
  }
  complete('source'); complete('other')
  const evidence = workflows.importEvidence(controller, id, view().revision, {
    id: 'local', title: 'Authorized excerpt', origin: 'Operator', text: 'Source content', nodeIds: ['source', 'other'],
  })
  workflows.readEvidence(controller, id, 'source', { id: 'local', version: evidence.document.version })
  const retained = workflows.readEvidence(controller, id, 'other', { id: 'local', version: evidence.document.version })
  workflows.grantDevice(controller, id, view().revision, { id: 'phone', nodeId: 'source', deviceId: 'phone', domain: 'files' })
  await host.runtime.idle()
  const read = await host.api('GET', `tickets/${id}/hmm/plan`)
  expect(read.status).toBe(200)
  const definition = read.body as ApiResponse<'GET tickets/:id/hmm/plan'>
  const plan = structuredClone(definition.plan)
  plan.nodes.find(node => node.id === 'source')!.instruction = 'Check corrected source'
  const before = host.runtime.store.get(KV.hmm.workflow(id))!
  const sessions = host.nodeFactory.mock.calls.length
  const candidate = { revision: definition.revision, plan, reason: 'Correct source scope' }
  const preview = await host.api('POST', `tickets/${id}/hmm/revisions`, { ...candidate, preview: true })
  expect(preview).toMatchObject({ status: 200, body: { applied: false, revision: definition.revision,
    planVersion: definition.planVersion, candidatePlanVersion: definition.planVersion + 1,
    changed: ['source'], invalidated: ['source', 'review'] } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  await host.runtime.idle()
  expect(host.nodeFactory.mock.calls).toHaveLength(sessions)
  const applied = await host.api('POST', `tickets/${id}/hmm/revisions`, { ...candidate, preview: false })
  expect(applied).toMatchObject({ status: 200, body: { applied: true, revision: definition.revision + 1,
    planVersion: definition.planVersion + 1, invalidated: ['source', 'review'] } })
  await host.runtime.idle()
  expect(view()).toMatchObject({ autoRun: false, phase: 'active' })
  expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'pending' })
  expect(view().nodes.find(node => node.id === 'other')).toMatchObject({ state: 'completed' })
  const after = host.runtime.store.get(KV.hmm.workflow(id))!
  expect(after.evidence!.receipts.map(receipt => receipt.ref)).toEqual([retained.ref])
  expect(after.evidence!.documents[0]!.nodeIds).toEqual(['other'])
  expect(after.deviceGrants![0]!.revoked).toBe(true)
  expect(host.nodeFactory.mock.calls).toHaveLength(sessions)
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...candidate, preview: false }))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(after)
})

it('增删与跨组重组通过同一HTTP修订事务；未修复引用拒绝，完整候选保留内部依赖与核验要求', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-structure', dispatch: false, goal: 'Compare permitted sources',
    plan: { maxActive: 2, nodes: [
      { id: 'root', title: 'Comparison', mode: 'parallel' },
      { id: 'sequence', parentId: 'root', title: 'Source checks', mode: 'serial' },
      { id: 'first', parentId: 'sequence', title: 'First', instruction: 'Check first source', evidenceRequired: true },
      { id: 'second', parentId: 'sequence', title: 'Second', instruction: 'Review first source',
        dependsOn: ['first'], claimsRequired: true },
      { id: 'other', parentId: 'root', title: 'Obsolete', instruction: 'Check obsolete source' },
      { id: 'review', parentId: 'root', title: 'Review', instruction: 'Compare current source results',
        dependsOn: ['sequence', 'other'] },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string
  const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  const before = host.runtime.store.get(KV.hmm.workflow(id))
  const plan = structuredClone(definition.plan)
  plan.nodes = plan.nodes.filter(node => node.id !== 'other')
  plan.nodes.find(node => node.id === 'sequence')!.parentId = 'comparison'
  plan.nodes.push({ id: 'comparison', parentId: 'root', title: 'Updated comparison', mode: 'parallel', instruction: undefined,
    evidenceRequired: false, claimsRequired: false, dependsOn: [] },
  { id: 'version', parentId: 'comparison', title: 'Check source version', mode: 'task',
    instruction: 'Compare permitted versions', evidenceRequired: false, claimsRequired: false, dependsOn: ['sequence'] })
  const request = { revision: definition.revision, plan, reason: 'Replace the obsolete source and regroup checks' }
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: true }))
    .toMatchObject({ status: 400, body: { code: 'dependency_invalid' } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  plan.nodes.find(node => node.id === 'review')!.dependsOn = ['comparison']
  const preview = await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: true })
  expect(preview).toMatchObject({ status: 200, body: { applied: false, added: ['comparison', 'version'], removed: ['other'],
    invalidated: expect.arrayContaining(['first', 'second', 'review', 'version']) } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  const applied = await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: false })
  expect(applied).toMatchObject({ status: 200, body: { applied: true, revision: definition.revision + 1,
    added: ['comparison', 'version'], removed: ['other'] } })
  await host.runtime.idle()
  const saved = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  expect(saved.plan).toEqual(plan)
  expect(saved.retiredNodeIds).toContain('other')
  expect(host.runtime.hmm.view(controller, id)).toMatchObject({ autoRun: false, runnable: ['first'] })
  expect(host.nodeFactory).not.toHaveBeenCalled()
})

it.each(['title', 'instruction', 'children', 'dependencies'] as const)(
  '%s待修复候选绕过界面直调预览或应用仍被拒绝，快照和原成果保持不变', async field => {
    const created = await host.api('POST', 'tasks', { requestId: 'plan-repair-boundary', dispatch: false,
      goal: 'Compare only authorized sources', plan: { nodes: [
        { id: 'root', title: 'Comparison', mode: 'parallel' },
        { id: 'group', parentId: 'root', title: 'Source group', mode: 'parallel' },
        { id: 'source', parentId: 'group', title: 'Read source', instruction: 'Read the permitted version' },
        { id: 'other', parentId: 'root', title: 'Other source', instruction: 'Check independent source' },
        { id: 'review', parentId: 'root', title: 'Review', instruction: 'Compare source results', dependsOn: ['group'] },
      ] } })
    expect(created.status).toBe(200)
    const id = created.body.ticketId as string, hmm = host.runtime.hmm, view = () => hmm.view(controller, id)
    const started = hmm.apply(controller, id, view().revision, { action: 'start', nodeId: 'source' })
    hmm.apply(controller, id, view().revision, { action: 'complete', nodeId: 'source', lease: started.lease!,
      summary: 'Original source checked', evidenceRefs: [hmm.context(controller, id, 'source').inputRef!] })
    const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
    const plan = structuredClone(definition.plan), source = plan.nodes.find(node => node.id === 'source')!
    if (field === 'title') source.title = ' \n'
    else if (field === 'instruction') source.instruction = ' \n'
    else if (field === 'children') plan.nodes = plan.nodes.filter(node => node.id !== 'source')
    else source.dependsOn = ['other']
    const before = host.runtime.store.get(KV.hmm.workflow(id))
    for (const preview of [true, false]) {
      const response = await host.api('POST', `tickets/${id}/hmm/revisions`, {
        revision: definition.revision, plan, reason: 'Review the invalid candidate boundary', preview,
      })
      expect(response.status).toBe(400)
      expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
    }
    await host.runtime.idle()
    expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'completed' })
    expect(host.nodeFactory).not.toHaveBeenCalled()
  })

it('真实预览与应用采用相同文本规范化，说明内部换行保留，读取结果与界面候选契约一致', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-text-normalization', dispatch: false,
    goal: 'Check only the permitted source', mode: 'single' })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string
  const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  const plan = structuredClone(definition.plan), step = plan.nodes.find(node => node.mode === 'task')!
  const title = 'Current source check', instruction = 'Compare source versions\nKeep the permitted scope unchanged.'
  step.title = `  ${title}  `; step.instruction = `\n  ${instruction}\n  `
  const before = host.runtime.store.get(KV.hmm.workflow(id))
  const request = { revision: definition.revision, plan, reason: '  Clarify permitted source  ' }
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: true }))
    .toMatchObject({ status: 200, body: { applied: false, changed: [step.id] } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: false }))
    .toMatchObject({ status: 200, body: { applied: true, changed: [step.id] } })
  const saved = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  expect(saved.plan).toEqual({ ...plan, nodes: plan.nodes.map(node => node.id === step.id ? { ...node, title, instruction } : node) })
  expect(host.runtime.store.get(KV.hmm.workflow(id))?.lastPlanRevision?.reason).toBe('Clarify permitted source')
  await host.runtime.idle()
  expect(host.nodeFactory).not.toHaveBeenCalled()
})

it('进度变化可轻量核对同一计划，之后权限再变化仍拒绝旧应用，并只在新预览后提交', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-identity-progress', dispatch: false,
    goal: 'Check only the permitted source', plan: { nodes: [
      { id: 'root', title: 'Source checks', mode: 'parallel' },
      { id: 'source', parentId: 'root', title: 'Private source check',
        instruction: 'Do not include this source instruction in the identity response. '.repeat(30) },
      { id: 'review', parentId: 'root', title: 'Review source', instruction: 'Review the source result', dependsOn: ['source'] },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string, hmm = host.runtime.hmm
  const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  const view = () => hmm.view(controller, id)
  const started = hmm.apply(controller, id, view().revision, { action: 'start', nodeId: 'source' })
  hmm.apply(controller, id, view().revision, { action: 'checkpoint', nodeId: 'source', lease: started.lease!, frame: 'Private work frame' })
  const beforeCheck = host.runtime.store.get(KV.hmm.workflow(id))
  const sessions = host.controller.create.mock.calls.length
  const checked = await host.api('GET', `tickets/${id}/hmm/plan-identity`)
  const identity = checked.body as ApiResponse<'GET tickets/:id/hmm/plan-identity'>
  expect(checked).toMatchObject({ status: 200, body: { ticketId: id, revision: view().revision,
    planVersion: definition.planVersion, fingerprint: definition.fingerprint } })
  expect(Object.keys(identity).sort()).toEqual(['fingerprint', 'planVersion', 'revision', 'ticketId'])
  expect(Buffer.byteLength(JSON.stringify(identity))).toBeLessThan(512)
  expect(identity.revision).toBeGreaterThan(definition.revision)
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(beforeCheck)
  expect(host.controller.create.mock.calls).toHaveLength(sessions)
  const plan = structuredClone(definition.plan)
  plan.nodes.find(node => node.id === 'source')!.instruction = 'Check the corrected permitted source'
  const draft = { plan, reason: 'Clarify permitted source' }
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...draft, revision: definition.revision, preview: true }))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...draft, revision: identity.revision, preview: true }))
    .toMatchObject({ status: 200, body: { applied: false, invalidated: ['source', 'review'] } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(beforeCheck)
  hmm.grantDevice(controller, id, view().revision, { id: 'phone', nodeId: 'source', deviceId: 'phone', domain: 'files' })
  const afterGrant = host.runtime.store.get(KV.hmm.workflow(id))
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...draft, revision: identity.revision, preview: false }))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(afterGrant)
  const current = (await host.api('GET', `tickets/${id}/hmm/plan-identity`)).body as typeof identity
  expect(current.fingerprint).toBe(identity.fingerprint)
  expect(current.revision).toBeGreaterThan(identity.revision)
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...draft, revision: current.revision, preview: true }))
    .toMatchObject({ status: 200, body: { applied: false } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(afterGrant)
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...draft, revision: current.revision, preview: false }))
    .toMatchObject({ status: 200, body: { applied: true, planVersion: definition.planVersion + 1 } })
  await host.runtime.idle()
  expect(view().autoRun).toBe(false)
  expect(host.runtime.store.get(KV.hmm.workflow(id))!.deviceGrants![0]!.revoked).toBe(true)
  expect(host.nodeFactory).not.toHaveBeenCalled()
})

it('同一计划版本下剪枝也改变摘要，完整定义与轻量核对来自同一规范化算法', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-identity-pruning', dispatch: false,
    goal: 'Check independent sources', plan: { nodes: [
      { id: 'root', title: 'Sources', mode: 'parallel' },
      { id: 'source', parentId: 'root', title: 'Source', instruction: 'Check source' },
      { id: 'other', parentId: 'root', title: 'Other source', instruction: 'Check another source' },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string, hmm = host.runtime.hmm
  const original = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  hmm.apply(controller, id, original.revision, { action: 'prune', nodeId: 'source', reason: 'Source unavailable', reconsiderWhen: 'New source' })
  const before = host.runtime.store.get(KV.hmm.workflow(id))
  const identity = (await host.api('GET', `tickets/${id}/hmm/plan-identity`)).body as ApiResponse<'GET tickets/:id/hmm/plan-identity'>
  const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  expect(identity.planVersion).toBe(original.planVersion)
  expect(identity.fingerprint).not.toBe(original.fingerprint)
  expect(identity).toMatchObject({ revision: definition.revision, planVersion: definition.planVersion, fingerprint: definition.fingerprint })
  expect(definition.prunedNodeIds).toEqual(['source'])
  expect(hmm.definition(controller, id)).not.toHaveProperty('fingerprint')
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(host.nodeFactory).not.toHaveBeenCalled()
})

it('计划修改后再恢复原定义时摘要可以相同，但计划版本仍变化，不能把它当作仅有执行进度变化', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-identity-aba', dispatch: false,
    goal: 'Review permitted source', mode: 'single' })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string, hmm = host.runtime.hmm
  const original = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  const plan = structuredClone(original.plan)
  plan.nodes.find(node => node.mode === 'task')!.instruction += ' Review the updated condition.'
  hmm.revise(controller, id, { revision: original.revision, plan, reason: 'Update condition' })
  hmm.revise(controller, id, { revision: hmm.view(controller, id).revision, plan: original.plan, reason: 'Reconsider condition' })
  const identity = (await host.api('GET', `tickets/${id}/hmm/plan-identity`)).body as ApiResponse<'GET tickets/:id/hmm/plan-identity'>
  expect(identity.fingerprint).toBe(original.fingerprint)
  expect(identity.planVersion).toBe(original.planVersion + 2)
  expect(host.nodeFactory).not.toHaveBeenCalled()
})

it.each([false, true])('同名步骤换前置仍按身份核算失效与可运行状态，逆序声明=%s', async reversed => {
  const sources = [
    { id: 'source_a', parentId: 'root', title: 'Check', instruction: 'Read original source' },
    { id: 'source_b', parentId: 'root', title: 'Check', instruction: 'Read alternative source' },
  ]
  const created = await host.api('POST', 'tasks', { requestId: 'plan-same-titles', dispatch: false,
    goal: 'Review distinct authorized sources', plan: { nodes: [
      { id: 'root', title: 'Comparison', mode: 'parallel' },
      ...(reversed ? sources.toReversed() : sources),
      { id: 'review', parentId: 'root', title: 'Check', instruction: 'Review selected source', dependsOn: ['source_a'] },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string, hmm = host.runtime.hmm, view = () => hmm.view(controller, id)
  for (const nodeId of ['source_a', 'review']) {
    const started = hmm.apply(controller, id, view().revision, { action: 'start', nodeId })
    hmm.apply(controller, id, view().revision, { action: 'complete', nodeId, lease: started.lease!,
      summary: `Checked ${nodeId}`, evidenceRefs: [hmm.context(controller, id, nodeId).inputRef!] })
  }
  const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  const plan = structuredClone(definition.plan)
  plan.nodes.find(node => node.id === 'review')!.dependsOn = ['source_b']
  const before = host.runtime.store.get(KV.hmm.workflow(id))
  const request = { revision: definition.revision, plan, reason: 'Use the alternative source with the same title' }
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: true }))
    .toMatchObject({ status: 200, body: { changed: ['review'], invalidated: ['review'] } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: false }))
    .toMatchObject({ status: 200, body: { applied: true, invalidated: ['review'] } })
  await host.runtime.idle()
  expect(view().runnable).toEqual(['source_b'])
  expect(view().nodes.find(node => node.id === 'source_a')).toMatchObject({ state: 'completed' })
  expect(view().nodes.find(node => node.id === 'review')).toMatchObject({ state: 'pending', dependsOn: ['source_b'] })
  const saved = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  expect(saved.plan).toEqual(plan)
  expect(host.nodeFactory).not.toHaveBeenCalled()
})

it('复制已完成分支时仅复制计划定义，新编号不继承成果、取证回执或设备授权', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-branch-copy', dispatch: false,
    goal: 'Compare independent sources', plan: { nodes: [
      { id: 'root', title: 'Source comparison', mode: 'parallel' },
      { id: 'branch', parentId: 'root', title: 'Source branch', mode: 'serial' },
      { id: 'source', parentId: 'branch', title: 'Check source', instruction: 'Read permitted source',
        evidenceRequired: true, claimsRequired: false },
      { id: 'review', parentId: 'branch', title: 'Review source', instruction: 'Review the source result',
        dependsOn: ['source'], evidenceRequired: false, claimsRequired: true },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string, hmm = host.runtime.hmm, revision = () => hmm.view(controller, id).revision
  const sourceStart = hmm.apply(controller, id, revision(), { action: 'start', nodeId: 'source' })
  const sourceInput = hmm.context(controller, id, 'source').inputRef!
  const sourceEvidence = hmm.importEvidence(controller, id, revision(), { id: 'source_doc', title: 'Allowed source',
    origin: 'Operator', text: 'A limited excerpt', nodeIds: ['source', 'review'] })
  const sourceReceipt = hmm.readEvidence(controller, id, 'source', { id: 'source_doc', version: sourceEvidence.document.version })
  hmm.apply(controller, id, revision(), { action: 'checkpoint', nodeId: 'source', lease: sourceStart.lease!,
    frame: 'Original source working notes' })
  hmm.apply(controller, id, revision(), { action: 'complete', nodeId: 'source', lease: sourceStart.lease!,
    summary: 'Original source checked', evidenceRefs: [sourceInput, sourceReceipt.ref] })
  const reviewStart = hmm.apply(controller, id, revision(), { action: 'start', nodeId: 'review' })
  const reviewInput = hmm.context(controller, id, 'review').inputRef!
  const reviewEvidence = hmm.readEvidence(controller, id, 'review', { id: 'source_doc', version: sourceEvidence.document.version })
  hmm.apply(controller, id, revision(), { action: 'complete', nodeId: 'review', lease: reviewStart.lease!,
    summary: 'Original review completed', evidenceRefs: [reviewInput, reviewEvidence.ref], claims: [
      { id: 'claim', subject: 'Source', predicate: 'contains', object: 'A limited excerpt',
        kind: 'extracted', evidenceRefs: [reviewEvidence.ref], counterEvidenceRefs: [] },
    ] })
  hmm.grantDevice(controller, id, revision(), { id: 'original-phone', nodeId: 'source', deviceId: 'phone',
    domain: 'files' })
  const before = host.runtime.store.get(KV.hmm.workflow(id))!
  const sessions = host.nodeFactory.mock.calls.length
  const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  expect(definition.limits).toEqual({ nodes: HMM_LIMITS.nodes })
  const plan = structuredClone(definition.plan), copies = new Map([['branch', 'copy_branch'], ['source', 'copy_source'], ['review', 'copy_review']])
  const copied = plan.nodes.filter(node => copies.has(node.id)).map(node => ({
    ...node, id: copies.get(node.id)!, parentId: node.parentId ? copies.get(node.parentId) ?? node.parentId : undefined,
    title: node.id === 'branch' ? 'Source branch copy' : node.title,
    dependsOn: node.dependsOn.map(dependency => copies.get(dependency) ?? dependency),
  }))
  plan.nodes.push(...copied)
  const request = { revision: definition.revision, plan, reason: 'Explore a second independent source branch' }
  const preview = await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: true })
  expect(preview).toMatchObject({ status: 200, body: { applied: false,
    added: ['copy_branch', 'copy_source', 'copy_review'] } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  await host.runtime.idle()
  expect(host.nodeFactory.mock.calls).toHaveLength(sessions)
  const applied = await host.api('POST', `tickets/${id}/hmm/revisions`, { ...request, preview: false })
  expect(applied).toMatchObject({ status: 200, body: { applied: true,
    added: ['copy_branch', 'copy_source', 'copy_review'] } })
  await host.runtime.idle()
  const after = host.runtime.store.get(KV.hmm.workflow(id))!
  const saved = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  expect(saved.plan).toEqual(plan)
  expect(saved.retiredNodeIds).toEqual([])
  expect(after.nodes.find(node => node.id === 'source')).toMatchObject({ state: 'completed', attempt: 1 })
  expect(after.nodes.find(node => node.id === 'review')).toMatchObject({ state: 'completed', attempt: 1 })
  expect(after.nodes.find(node => node.id === 'copy_source')).toMatchObject({ state: 'pending', attempt: 0 })
  expect(after.nodes.find(node => node.id === 'copy_review')).toMatchObject({ state: 'pending', attempt: 0,
    dependsOn: ['copy_source'], evidenceRequired: false, claimsRequired: true })
  expect(after.nodes.find(node => node.id === 'copy_source')!.frame).toBe('')
  expect(after.nodes.find(node => node.id === 'copy_source')!.result).toBeUndefined()
  expect(after.nodes.find(node => node.id === 'copy_review')!.result).toBeUndefined()
  expect(after.evidence!.receipts).toEqual(before.evidence!.receipts)
  expect(after.evidence!.documents).toEqual(before.evidence!.documents)
  expect(after.deviceGrants!.filter(grant => !grant.revoked).map(grant => grant.nodeId)).toEqual(['source'])
  expect(after.nodes.find(node => node.id === 'review')!.result!.claims).toMatchObject([{ id: 'claim' }])
  expect(() => hmm.readEvidence(controller, id, 'copy_source', { id: 'source_doc', version: sourceEvidence.document.version })).toThrow()
  expect(() => hmm.deviceAccess(controller, id, 'copy_source', 'original-phone')).toThrow('授权')
  expect(after.autoRun).toBe(false)
  expect(host.nodeFactory.mock.calls).toHaveLength(sessions)
})

it('串行组中插入步骤副本时，后端重新核算后继失效，原消费者不自动改接副本', async () => {
  const created = await host.api('POST', 'tasks', { requestId: 'plan-copy-serial', dispatch: false,
    goal: 'Check sources in order', plan: { nodes: [
      { id: 'root', title: 'Checks', mode: 'serial' },
      { id: 'source', parentId: 'root', title: 'Source', instruction: 'Check source' },
      { id: 'review', parentId: 'root', title: 'Review', instruction: 'Review original source', dependsOn: ['source'] },
    ] } })
  expect(created.status).toBe(200)
  const id = created.body.ticketId as string, hmm = host.runtime.hmm, view = () => hmm.view(controller, id)
  for (const nodeId of ['source', 'review']) {
    const start = hmm.apply(controller, id, view().revision, { action: 'start', nodeId })
    const inputRef = hmm.context(controller, id, nodeId).inputRef!
    hmm.apply(controller, id, view().revision, { action: 'complete', nodeId, lease: start.lease!,
      summary: `Result ${nodeId}`, evidenceRefs: [inputRef] })
  }
  const before = host.runtime.store.get(KV.hmm.workflow(id))
  const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
  const source = definition.plan.nodes.find(node => node.id === 'source')!
  const plan = { ...definition.plan, nodes: [definition.plan.nodes[0]!, source,
    { ...source, id: 'copy_source', title: 'Source copy' }, definition.plan.nodes[2]!] }
  const candidate = { revision: definition.revision, plan, reason: 'Check another source before reviewing' }
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...candidate, preview: true }))
    .toMatchObject({ status: 200, body: { applied: false, added: ['copy_source'], invalidated: ['copy_source', 'review'] } })
  expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
  expect(await host.api('POST', `tickets/${id}/hmm/revisions`, { ...candidate, preview: false }))
    .toMatchObject({ status: 200, body: { applied: true } })
  await host.runtime.idle()
  expect(view().runnable).toEqual(['copy_source'])
  expect(view().nodes.find(node => node.id === 'source')).toMatchObject({ state: 'completed', attempt: 1 })
  expect(view().nodes.find(node => node.id === 'copy_source')).toMatchObject({ state: 'pending', attempt: 0 })
  expect(view().nodes.find(node => node.id === 'review')).toMatchObject({ state: 'pending', dependsOn: ['source'] })
  expect(host.runtime.store.get(KV.hmm.workflow(id))!.nodes.find(node => node.id === 'review')!.result).toBeUndefined()
  expect(view().autoRun).toBe(false)
  expect(host.nodeFactory).not.toHaveBeenCalled()
})

it.each(['explicit', 'serial', 'both', 'prefix', 'long'] as const)(
  '%s循环诊断只返回真实闭环与约束类型，预览和应用均拒绝且保留原快照', async kind => {
    const created = await host.api('POST', 'tasks', { requestId: `plan-cycle-${kind}`, dispatch: false,
      goal: 'Review independent source checks', plan: { nodes: [
        { id: 'root', title: 'Source checks', mode: 'parallel' },
        ...(kind === 'prefix' ? [{ id: 'prefix', parentId: 'root', title: 'Uninvolved check',
          instruction: 'Review the output of A', dependsOn: ['a'] }] : []),
        { id: 'a', parentId: 'root', title: 'Check A', instruction: 'Private instruction A' },
        { id: 'b', parentId: 'root', title: 'Check B', instruction: 'Private instruction B' },
        { id: 'c', parentId: 'root', title: 'Check C', instruction: 'Private instruction C' },
      ] } })
    expect(created.status).toBe(200)
    const id = created.body.ticketId as string
    const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
    const plan = structuredClone(definition.plan)
    if (kind === 'serial' || kind === 'both') plan.nodes[0]!.mode = 'serial'
    plan.nodes.find(node => node.id === 'a')!.dependsOn = ['b']
    plan.nodes.find(node => node.id === 'b')!.dependsOn = kind === 'serial' ? [] : [kind === 'long' ? 'c' : 'a']
    if (kind === 'long') plan.nodes.find(node => node.id === 'c')!.dependsOn = ['a']
    const before = host.runtime.store.get(KV.hmm.workflow(id))
    const sessions = host.nodeFactory.mock.calls.length
    for (const preview of [true, false]) {
      const rejected = await host.api('POST', `tickets/${id}/hmm/revisions`, {
        revision: definition.revision, plan, reason: 'Review a changed prerequisite', preview,
      })
      expect(rejected).toMatchObject({ status: 400, body: { code: 'dependency_cycle', cycle: expect.any(Array) } })
      expect(Object.keys(rejected.body).sort()).toEqual(['code', 'cycle', 'error'])
      const cycle = rejected.body.cycle as DependencyCycleLink[]
      expect(cycle).toHaveLength(kind === 'long' ? 3 : 2)
      expect(new Set(cycle.map(link => link.nodeId)).size).toBe(cycle.length)
      expect(cycle.every((link, index) => link.dependencyId === cycle[(index + 1) % cycle.length]!.nodeId)).toBe(true)
      expect(new Set(cycle.map(link => `${link.nodeId}:${link.dependencyId}`))).toEqual(new Set(kind === 'long'
        ? ['a:b', 'b:c', 'c:a'] : ['a:b', 'b:a']))
      expect(cycle.find(link => link.nodeId === 'a')!.kind).toBe('explicit')
      expect(cycle.find(link => link.nodeId === 'b')!.kind).toBe(kind === 'serial' ? 'serial' : kind === 'both' ? 'both' : 'explicit')
      expect(JSON.stringify(rejected.body)).not.toContain('Private instruction')
      expect(JSON.stringify(cycle)).not.toContain('prefix')
      expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
    }
    plan.nodes.find(node => node.id === 'a')!.dependsOn = []
    expect(await host.api('POST', `tickets/${id}/hmm/revisions`, {
      revision: definition.revision, plan, reason: 'Keep the corrected prerequisite chain', preview: true,
    })).toMatchObject({ status: 200, body: { applied: false } })
    expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
    await host.runtime.idle()
    expect(host.nodeFactory.mock.calls).toHaveLength(sessions)
  })

it('并行组的显式依赖判断不依赖声明顺序，闭合从两步到节点上限的链都给出完整真实路径', async () => {
  for (const count of [2, 5, 16, HMM_LIMITS.nodes - 1]) {
    const nodes = Array.from({ length: count }, (_, index) => ({
      id: `step_${index}`, parentId: 'root', title: `Check ${index}`, instruction: `Check independent condition ${index}`,
      dependsOn: index ? [`step_${index - 1}`] : [],
    }))
    // 由拓扑链构造无环图，再整体反向声明；只改变展示顺序，不改变显式关系。
    const created = await host.api('POST', 'tasks', { requestId: `cycle-order-${count}`, dispatch: false,
      goal: 'Check an explicit prerequisite chain', plan: { nodes: [
        { id: 'root', title: 'Checks', mode: 'parallel' }, ...nodes.toReversed(),
      ] } })
    expect(created.status).toBe(200)
    const id = created.body.ticketId as string
    const definition = (await host.api('GET', `tickets/${id}/hmm/plan`)).body as ApiResponse<'GET tickets/:id/hmm/plan'>
    const before = host.runtime.store.get(KV.hmm.workflow(id))
    for (const reverse of [false, true]) {
      const plan = structuredClone(definition.plan)
      if (reverse) plan.nodes.reverse()
      plan.nodes.find(node => node.id === 'step_0')!.dependsOn = [`step_${count - 1}`]
      const rejected = await host.api('POST', `tickets/${id}/hmm/revisions`, {
        revision: definition.revision, plan, reason: 'Close the prerequisite chain', preview: true,
      })
      expect(rejected).toMatchObject({ status: 400, body: { code: 'dependency_cycle' } })
      const cycle = rejected.body.cycle as DependencyCycleLink[]
      expect(cycle).toHaveLength(count)
      expect(new Set(cycle.map(link => link.nodeId)).size).toBe(count)
      expect(cycle.every((link, index) => link.kind === 'explicit'
        && link.dependencyId === cycle[(index + 1) % cycle.length]!.nodeId
        && plan.nodes.find(node => node.id === link.nodeId)!.dependsOn.includes(link.dependencyId))).toBe(true)
      expect(host.runtime.store.get(KV.hmm.workflow(id))).toEqual(before)
    }
  }
  await host.runtime.idle()
  expect(host.nodeFactory).not.toHaveBeenCalled()
})
