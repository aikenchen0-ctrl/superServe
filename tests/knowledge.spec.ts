import { expect, it } from 'vitest'
import type { KnowledgeAccess, KnowledgeArtifact, KnowledgeAssertion, KnowledgeRelation } from '../src/knowledge/contracts.ts'
import { KnowledgeAccessError } from '../src/knowledge/contracts.ts'
import { searchKnowledge } from '../src/knowledge/query.ts'

const artifact = (id: string, deviceId: string, snippet = id): KnowledgeArtifact => ({
  id, deviceId, title: id, snippet, source: { deviceId, sourceId: id, version: '1', contentHash: `hash-${id}` },
  domain: id === 'wechat' ? 'wechat' : 'messages', observedAt: '2026-10-01T00:00:00.000Z', sensitivity: 'personal',
} as KnowledgeArtifact)

const access: KnowledgeAccess = {
  actorId: 'supervisor', domains: ['messages', 'wechat'], devices: ['phone', 'root'], includeRestricted: false, allowInferred: false,
}
const artifacts = [artifact('sms', 'phone', 'project launch'), artifact('wechat', 'root', 'project launch detail'),
  artifact('other', 'stranger', 'project launch')]
const assertions: KnowledgeAssertion[] = [
  { id: 'a1', subject: 'project', predicate: 'hasEvent', object: 'launch', status: 'stated', evidence: ['sms'] },
  { id: 'a2', subject: 'project', predicate: 'hasRisk', object: 'delay', status: 'inferred', evidence: ['wechat'] },
]
const relations: KnowledgeRelation[] = [{ id: 'r1', from: 'project', type: 'hasEvent', to: 'launch', assertionIds: ['a1'] }]

it('returns bounded evidence and does not expose another device or inferred claims', () => {
  const result = searchKnowledge({ artifacts, assertions, relations, scores: new Map([['sms', 2], ['wechat', 3]]) },
    { text: 'project', limit: 1 }, access)
  expect(result.hits.map(hit => hit.artifact.id)).toEqual(['sms'])
  expect(result.hits[0]?.assertionIds).toEqual(['a1'])
  expect(result.hits[0]?.relationIds).toEqual(['r1'])
  expect(result.omitted).toEqual({ inaccessible: 1, deleted: 0, lowConfidence: 1 })
})

it('includes inferred claims only when the resolved scope allows them', () => {
  const result = searchKnowledge({ artifacts, assertions, relations, scores: new Map() },
    { text: 'project', includeInferred: true, limit: 10 }, access)
  expect(result.hits.find(hit => hit.artifact.id === 'wechat')?.assertionIds).toEqual(['a2'])
})

it('rejects an empty or invalid scope before a backend query runs', () => {
  expect(() => searchKnowledge({ artifacts, assertions, relations, scores: new Map() },
    { devices: ['stranger'], limit: 10 }, access)).toThrow(KnowledgeAccessError)
  expect(() => searchKnowledge({ artifacts, assertions, relations, scores: new Map() },
    { limit: 0 }, access)).toThrow(KnowledgeAccessError)
})
