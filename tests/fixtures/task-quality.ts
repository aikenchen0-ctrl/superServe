import type { ApiResponse } from '../../src/app/api.ts'

/** 客户端受控数据；仅用于验证呈现与请求归属，不代表本机质量证据。 */
export function qualityCatalog(): Extract<ApiResponse<'GET tasks/:id/quality'>, { state: 'registered' }> {
  return { state: 'registered', ticketId: 'task-a', changeRevision: 1,
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), identity: 'c'.repeat(64), objectFormat: 'sha1' },
    snapshot: 'd'.repeat(64), total: 1, nextOffset: null,
    items: [{ id: 'e'.repeat(64), revision: 1, digest: 'f'.repeat(64), name: 'module-quality',
      moduleName: 'messages', format: 'native-crap-v1', configurationPath: 'quality/targets.json',
      applicable: true, recipeRepositoryRequired: false }] }
}

export function qualityReceipt(catalog = qualityCatalog()): ApiResponse<'POST tasks/:id/quality/verify-sources'> {
  const profile = catalog.items[0]!
  return { ticketId: catalog.ticketId, changeRevision: catalog.changeRevision,
    binding: { schemaVersion: 1, profile: { id: profile.id, revision: profile.revision, digest: profile.digest },
      module: { id: '1'.repeat(64), revision: 1 }, repositoryId: '2'.repeat(64), source: catalog.source },
    bindingDigest: '3'.repeat(64), sourceScope: 'committed-tree-only', persisted: false, currentProgressCaptured: false,
    assurance: { configurationOnly: true, toolsVerified: false, recipeVerified: false, configurationVerified: false,
      inputClosureVerified: false, executionAuthorized: false, candidateAccepted: false, publishAllowed: false },
    verification: { schemaVersion: 1, source: { ...catalog.source, objectFormat: 'sha1', kind: 'git-commit' },
      configuration: { path: profile.configurationPath, blob: '4'.repeat(40), bytes: 48,
        sha256: '5'.repeat(64), ancestorTreesVerified: 1, ancestorObjectBytes: 64 },
      recipe: { repositoryId: '2'.repeat(64), commit: catalog.source.commit, tree: catalog.source.tree, path: '.',
        manifestDigest: '6'.repeat(64), entries: 3, uniqueObjects: 4, directoryObjects: 4, ancestorTreesVerified: 0,
        objectBytes: 256, symlinks: 0, submodules: 0 },
      status: 'tracked_content_matched',
      assurance: { configurationContentVerified: true, recipeTrackedContentVerified: true,
        configurationSemanticsVerified: false, dependencyClosureVerified: false, toolsVerified: false,
        executionAuthorized: false, publishAllowed: false } } }
}
