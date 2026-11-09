import type { ApiResponse } from '../../src/app/api.ts'

/** 仅用于界面状态与请求核对，内容不是实际质量执行结果。 */
export function reportCatalog(ticketId = 'task-a', suggestionId = 'a'.repeat(64)):
ApiResponse<'GET tasks/:id/quality/suggestions/:suggestionId/reports'> {
  return { ticketId, suggestionId, snapshot: 'b'.repeat(64), total: 1, nextOffset: null, retained: {},
    binding: { changeRevision: 1, scopeDigest: 'c'.repeat(64), repositoryId: 'd'.repeat(64),
      source: { commit: '1'.repeat(40), tree: '2'.repeat(40), identity: 'e'.repeat(64), objectFormat: 'sha1' },
      module: { id: 'f'.repeat(64), revision: 1 }, profile: { id: '1'.repeat(64), revision: 1, digest: '2'.repeat(64) } },
    applicability: { state: 'matches_registration', reasons: [] },
    assurance: { receiptPersisted: true, sourceAuthenticated: false,
      inputClosureVerified: false, executionAuthorized: false, publishAllowed: false },
    items: [{ schemaVersion: 1, interpreterVersion: 1, id: '3'.repeat(64), ticketId, suggestionId,
      recordedAt: '2026-11-07T00:00:00.000Z', report: { adapter: 'native-crap-v1', bundleDigest: '4'.repeat(64),
        reportedExecution: 'completed', evidence: 'insufficient_evidence',
        declaredIdentity: { sourceCommit: '1'.repeat(40), scopeDigest: '5'.repeat(64), inputDigest: '6'.repeat(64) },
        artifacts: [{ name: 'summary.json', status: 'read', sha256: '7'.repeat(64), bytes: 500 },
          { name: 'native-cobertura.xml', status: 'missing' }],
        issues: [{ code: 'artifact_unavailable', kind: 'missing', message: '覆盖率文件缺失', action: '补齐原范围报告',
          artifact: 'native-cobertura.xml' }],
      } }],
  }
}

export function reportReceipt(catalog = reportCatalog()):
ApiResponse<'POST tasks/:id/quality/suggestions/:suggestionId/reports'> {
  return { created: true, ticketId: catalog.ticketId, suggestionId: catalog.suggestionId,
    receipt: catalog.items[0]!, applicability: catalog.applicability, assurance: catalog.assurance,
    retained: catalog.retained[catalog.items[0]!.id] ?? null }
}

/** 已读字节为 {}，仅供模拟下载及摘要核对，不属于真实工程报告。 */
export function retainedReportCatalog(ticketId = 'task-a', suggestionId = 'a'.repeat(64)) {
  const catalog = reportCatalog(ticketId, suggestionId), item = catalog.items[0]!
  const file = { name: 'summary.json', bytes: 2,
    sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' }
  item.report.artifacts[0] = { ...file, status: 'read' }
  catalog.retained[item.id] = { schemaVersion: 1, ticketId, reportId: item.id, retainedAt: item.recordedAt,
    files: [file], digest: '8'.repeat(64), retainedBytes: 2, scope: 'observed_bytes_only', integrity: 'checked_when_read' }
  return catalog
}

export function reportFile(catalog = retainedReportCatalog()):
ApiResponse<'GET tasks/:id/quality/suggestions/:suggestionId/reports/:reportId/file'> {
  const item = catalog.items[0]!, file = item.report.artifacts[0]!
  return { ticketId: catalog.ticketId, suggestionId: catalog.suggestionId, reportId: item.id, name: file.name,
    sha256: file.sha256!, bytes: file.bytes!, base64: 'e30=' }
}
