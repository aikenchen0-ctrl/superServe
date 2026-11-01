import {
  KNOWLEDGE_DOMAINS,
  KnowledgeAccessError,
  type KnowledgeAccess,
  type KnowledgeArtifact,
  type KnowledgeAssertion,
  type KnowledgeDomain,
  type KnowledgeHit,
  type KnowledgeQuery,
  type KnowledgeRelation,
  type KnowledgeResult,
} from './contracts.ts'

const MAX_LIMIT = 50

/** Checks request bounds and resolves the permitted domain and device scope. */
export function authorizeKnowledgeQuery(query: KnowledgeQuery, access: KnowledgeAccess): {
  domains: ReadonlySet<KnowledgeDomain>
  devices: ReadonlySet<string>
  limit: number
} {
  if (!Number.isInteger(query.limit) || query.limit < 1) throw new KnowledgeAccessError('query limit must be a positive integer')
  if (!access.actorId.trim()) throw new KnowledgeAccessError('actor identity is required')
  const requestedDomains = query.domains ?? access.domains
  const requestedDevices = query.devices ?? access.devices
  const invalidDomains = requestedDomains.filter(domain => !KNOWLEDGE_DOMAINS.includes(domain))
  if (invalidDomains.length) throw new KnowledgeAccessError(`unknown domains: ${invalidDomains.join(', ')}`)
  const domains = requestedDomains.filter(domain => access.domains.includes(domain))
  const devices = requestedDevices.filter(device => access.devices.includes(device))
  if (!domains.length || !devices.length) throw new KnowledgeAccessError('the request has no accessible knowledge scope')
  return { domains: new Set(domains), devices: new Set(devices), limit: Math.min(query.limit, MAX_LIMIT) }
}

/** Returns whether an artifact satisfies the scope, time, deletion, and sensitivity filters. */
export function permitsArtifact(artifact: KnowledgeArtifact, query: KnowledgeQuery, access: KnowledgeAccess,
  scope: { domains: ReadonlySet<KnowledgeDomain>; devices: ReadonlySet<string> }): boolean {
  if (artifact.deleted || !scope.domains.has(artifact.domain) || !scope.devices.has(artifact.source.deviceId)) return false
  if (artifact.sensitivity === 'restricted' && !access.includeRestricted) return false
  return (!query.from || artifact.observedAt >= query.from) && (!query.to || artifact.observedAt <= query.to)
}

/** Returns only assertions backed entirely by evidence that the caller may receive. */
export function visibleAssertions(assertions: readonly KnowledgeAssertion[], visibleArtifacts: ReadonlySet<string>,
  includeInferred: boolean): KnowledgeAssertion[] {
  return assertions.filter(assertion => (includeInferred || assertion.status !== 'inferred')
    && assertion.evidence.length > 0 && assertion.evidence.every(id => visibleArtifacts.has(id)))
}

/** Retrieves a candidate result from already materialized knowledge. */
export function searchKnowledge(input: {
  artifacts: readonly KnowledgeArtifact[]
  assertions: readonly KnowledgeAssertion[]
  relations: readonly KnowledgeRelation[]
  scores: ReadonlyMap<string, number>
}, query: KnowledgeQuery, access: KnowledgeAccess): KnowledgeResult {
  const scope = authorizeKnowledgeQuery(query, access)
  const accessible = input.artifacts.filter(artifact => permitsArtifact(artifact, query, access, scope))
  const visible = new Set(accessible.map(artifact => artifact.id))
  const assertions = visibleAssertions(input.assertions, visible, query.includeInferred ?? access.allowInferred)
  const assertionByArtifact = new Map<string, string[]>()
  for (const assertion of assertions) {
    for (const artifactId of assertion.evidence) {
      const ids = assertionByArtifact.get(artifactId) ?? []
      ids.push(assertion.id)
      assertionByArtifact.set(artifactId, ids)
    }
  }
  const visibleAssertionIds = new Set(assertions.map(assertion => assertion.id))
  const relations = input.relations.filter(relation => relation.assertionIds.some(id => visibleAssertionIds.has(id)))
  const relationByAssertion = new Map<string, string[]>()
  for (const relation of relations) {
    for (const assertionId of relation.assertionIds) {
      const ids = relationByAssertion.get(assertionId) ?? []
      ids.push(relation.id)
      relationByAssertion.set(assertionId, ids)
    }
  }
  const text = query.text?.trim().toLocaleLowerCase()
  const ranked = accessible.flatMap(artifact => {
    if (text && !`${artifact.title}\n${artifact.snippet}`.toLocaleLowerCase().includes(text)) return []
    const assertionIds = assertionByArtifact.get(artifact.id) ?? []
    if (!assertionIds.length) return []
    const hit: KnowledgeHit = {
      artifact,
      assertionIds,
      relationIds: [...new Set(assertionIds.flatMap(id => relationByAssertion.get(id) ?? []))],
      score: input.scores.get(artifact.id) ?? 0,
    }
    return [hit]
  }).sort((left, right) => right.score - left.score || right.artifact.observedAt.localeCompare(left.artifact.observedAt)
    || left.artifact.id.localeCompare(right.artifact.id))
  return {
    hits: ranked.slice(0, scope.limit),
    truncated: ranked.length > scope.limit,
    omitted: {
      inaccessible: input.artifacts.filter(artifact => !visible.has(artifact.id) && !artifact.deleted).length,
      deleted: input.artifacts.filter(artifact => artifact.deleted).length,
      lowConfidence: input.assertions.filter(assertion => assertion.status === 'inferred'
        && !(query.includeInferred ?? access.allowInferred)).length,
    },
  }
}
