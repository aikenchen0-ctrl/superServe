import type { ApiResponse } from '../../src/app/api.ts'
import { combinationInputs, combinationReceipt } from './task-candidates.ts'
import { qualityReceipt } from './task-quality.ts'
import { acceptanceMapping } from '../../src/development/acceptance-checks.ts'

/** 界面固定数据，不是实际来源、独立审查或执行证据。 */
export function acceptanceSource(): ApiResponse<'POST tasks/:id/quality/verify-combination'> {
  const base = qualityReceipt(), combo = combinationReceipt(), source = { ...base.binding.source, ...combo.combination.source! }
  return { ...base, persisted: true, combinationId: combo.combination.id,
    requestId: '00000000-0000-4000-8000-000000000001', checkedAt: '2026-11-08T00:00:00Z',
    binding: { ...base.binding, source, repositoryId: source.repositoryId },
    verification: { ...base.verification, source: { ...base.verification.source, ...source },
      sourceInputs: combinationInputs(source.tree) } }
}
export function acceptancePreview(receipt = acceptanceSource()): ApiResponse<'GET tasks/:id/quality/acceptance'> {
  return { basisDigest: '9'.repeat(64), revision: 0, state: 'unconfirmed', events: [],
    mapping: acceptanceMapping(['不得丢失消息', '不得改变消息顺序'], ['兼容原协议']),
    basis: { ticketId: receipt.ticketId, changeRevision: receipt.changeRevision,
      task: { purpose: '保留消息顺序', acceptance: ['不得丢失消息', '不得改变消息顺序'] },
      module: { ...receipt.binding.module, name: 'messages', acceptance: ['兼容原协议'] },
      profile: { ...receipt.binding.profile, name: 'module-quality',
        recipe: { ...receipt.verification.recipe }, configuration: { path: 'targets.json', sha256: '5'.repeat(64) },
        tools: [{ name: 'tool', version: 'fixture', sha256: '6'.repeat(64) }],
        environment: { runtime: 'windows', architecture: 'x64' } } },
    source: { requestId: receipt.requestId, combinationId: receipt.combinationId, commit: receipt.binding.source.commit,
      referencesUnresolved: false }, scope: 'task-and-selected-module',
    assurance: { operatorDeclarationOnly: true, independentReviewerAuthenticated: false, coverageVerified: false,
      executionAuthorized: false, publishAllowed: false } }
}
