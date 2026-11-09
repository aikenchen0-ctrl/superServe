import type { ApiResponse } from '../../src/app/api.ts'

/** 组合界面测试的受控输入回执，不表示真实执行或物化。 */
export function combinationInputs(tree = '4'.repeat(40)):
  NonNullable<ApiResponse<'POST tasks/:id/quality/verify-combination'>['verification']['sourceInputs']> {
  return { scope: 'committed-tree', tree, manifestDigest: '7'.repeat(64), entries: 6, files: 4,
    logicalFileBytes: 1200, uniqueObjects: 6, objectBytes: 1000, symlinks: 0, submodules: 0,
    status: 'tracked_content_matched', materialized: false, executionAttempted: false, dependencyClosureVerified: false }
}

/** 仅供界面测试的固定目录；不代表真实候选或验收证据。 */
export function candidateCatalog(ticketId = 'task-a'): ApiResponse<'GET development/changes/:id/candidates'> {
  const id = 'a'.repeat(64), commit = '1'.repeat(40)
  return { ticketId, snapshot: 'b'.repeat(64), total: 1, nextOffset: null, items: [{
    candidate: {
      schemaVersion: 1, id, ticketId, changeRevision: 1, declarationHash: 'c'.repeat(64),
      repositoryPath: 'R:/workspace', source: { repositoryId: 'd'.repeat(64), commit, tree: '2'.repeat(40), objectFormat: 'sha1' },
      requires: [], declaredComplete: true, phase: 'ready', createdAt: '2026-11-08T00:00:00Z',
    },
    purpose: '保留消息顺序',
    declarationChanged: false, taskEnded: false, validationRequired: true, publishAllowed: false,
    worktreeChanged: false, progressCaptured: false,
    plan: { state: 'ready', request: { baseCommit: '0'.repeat(40), candidates: [id] },
      members: [{ id, ticketId, purpose: '保留消息顺序', commit }] },
  }] }
}

export function combinationReceipt(catalog: ApiResponse<'GET development/changes/:id/candidates'> = candidateCatalog()): ApiResponse<'POST development/combinations'> {
  const item = catalog.items[0]!
  if (item.plan.state !== 'ready') throw new Error('测试需要可准备计划')
  return { combination: {
    schemaVersion: 1, id: 'e'.repeat(64),
    base: { ...item.candidate.source, commit: item.plan.request.baseCommit },
    candidates: item.plan.request.candidates, policy: 'builtin-ort-v1', gitVersion: 'fixture-only',
    repositoryPath: item.candidate.repositoryPath, phase: 'prepared',
    source: { ...item.candidate.source, commit: '3'.repeat(40), tree: '4'.repeat(40) },
    createdAt: '2026-11-08T00:01:00Z',
  }, basisChanged: false, validationRequired: true, publishAllowed: false, worktreeChanged: false }
}
