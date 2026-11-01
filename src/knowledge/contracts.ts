/** Data domains with different ownership and disclosure rules. */
export const KNOWLEDGE_DOMAINS = ['messages', 'photos', 'files', 'wechat', 'im', 'tasks'] as const
export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number]

/** Where a piece of knowledge originated and whether it is still current. */
export interface SourceRef {
  deviceId: string
  sourceId: string
  version: string
  contentHash: string
}

/** A retrievable artifact whose raw content remains with its owning device. */
export interface KnowledgeArtifact {
  id: string
  domain: KnowledgeDomain
  title: string
  snippet: string
  source: SourceRef
  observedAt: string
  sensitivity: 'personal' | 'restricted'
  deleted?: boolean
}

/** Epistemic status is separate from source authenticity. */
export type AssertionStatus = 'stated' | 'extracted' | 'inferred' | 'confirmed'

/** A claim linked to the artifacts that support or contradict it. */
export interface KnowledgeAssertion {
  id: string
  subject: string
  predicate: string
  object: string
  status: AssertionStatus
  evidence: string[]
  validFrom?: string
  validTo?: string
  supersedes?: string[]
}

/** A directed graph edge derived from one or more assertions. */
export interface KnowledgeRelation {
  id: string
  from: string
  type: string
  to: string
  assertionIds: string[]
}

/** Minimum permissions required for one knowledge request. */
export interface KnowledgeAccess {
  actorId: string
  domains: readonly KnowledgeDomain[]
  devices: readonly string[]
  includeRestricted: boolean
  allowInferred: boolean
}

/** A bounded query; filtering happens before snippets leave the device. */
export interface KnowledgeQuery {
  text?: string
  domains?: readonly KnowledgeDomain[]
  devices?: readonly string[]
  from?: string
  to?: string
  limit: number
  includeInferred?: boolean
}

/** Evidence returned to an orchestrator or task agent. */
export interface KnowledgeHit {
  artifact: KnowledgeArtifact
  assertionIds: string[]
  relationIds: string[]
  score: number
}

/** One result set plus the truncation and omission facts an agent must know. */
export interface KnowledgeResult {
  hits: KnowledgeHit[]
  truncated: boolean
  omitted: {
    inaccessible: number
    deleted: number
    lowConfidence: number
  }
}

/** A device-local or remote implementation of bounded knowledge retrieval. */
export interface KnowledgeStore {
  query(query: KnowledgeQuery, access: KnowledgeAccess): Promise<KnowledgeResult>
}

/** Raised before a query reaches a knowledge backend when its access request is malformed. */
export class KnowledgeAccessError extends Error {
  readonly code = 'knowledge_access_denied'
}
