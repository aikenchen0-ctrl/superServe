import { expect, it } from 'vitest'
import type { KnowledgeArtifact, KnowledgeResult, KnowledgeStore } from '../src/knowledge/contracts.ts'
import { KnowledgeRouter } from '../src/knowledge/router.ts'

const hit = (id: string, deviceId: string, score: number): KnowledgeResult => ({
  hits: [{
    artifact: {
      id, domain: 'messages', title: id, snippet: id,
      source: { deviceId, sourceId: id, version: '1', contentHash: id },
      observedAt: '2026-10-01T00:00:00.000Z', sensitivity: 'personal',
    } satisfies KnowledgeArtifact,
    assertionIds: [], relationIds: [], score,
  }],
  truncated: false, omitted: { inaccessible: 0, deleted: 0, lowConfidence: 0 },
})
const store = (deviceId: string): KnowledgeStore => ({ query: async () => hit(deviceId, deviceId, deviceId === 'phone' ? 1 : 2) })

it('queries only authorized devices and enforces the global result limit', async () => {
  const router = new KnowledgeRouter([
    { deviceId: 'phone', domains: ['messages'], store: store('phone') },
    { deviceId: 'root', domains: ['messages'], store: store('root') },
  ])
  const result = await router.query({ limit: 1 }, {
    actorId: 'orchestrator', domains: ['messages'], devices: ['phone', 'root'], includeRestricted: false, allowInferred: false,
  })
  expect(result.hits.map(item => item.artifact.id)).toEqual(['root'])
  expect(result.truncated).toBe(true)
})

it('drops a backend response from a device or domain outside the resolved scope', async () => {
  const router = new KnowledgeRouter([
    { deviceId: 'phone', domains: ['messages', 'messages'], store: {
      query: async () => ({ ...hit('leak', 'stranger', 9), hits: [
        { ...hit('phone', 'phone', 1).hits[0]!, artifact: { ...hit('phone', 'phone', 1).hits[0]!.artifact, domain: 'wechat' } },
        hit('leak', 'stranger', 9).hits[0]!,
      ] }),
    } },
  ])
  const result = await router.query({ limit: 10 }, {
    actorId: 'task-agent', domains: ['messages'], devices: ['phone'], includeRestricted: false, allowInferred: false,
  })
  expect(result.hits).toEqual([])
})
