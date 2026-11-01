import { expect, it } from 'vitest'
import type { KnowledgeAccess, KnowledgeStore } from '../src/knowledge/contracts.ts'

it('allows a device adapter to implement the knowledge port without exposing storage details', async () => {
  const store: KnowledgeStore = {
    query: async (_query, access: KnowledgeAccess) => ({
      hits: [{
        artifact: {
          id: 'evidence-1', domain: 'files', title: 'plan', snippet: 'plan',
          source: { deviceId: access.devices[0]!, sourceId: 'doc', version: '1', contentHash: 'hash' },
          observedAt: '2026-10-01T00:00:00.000Z', sensitivity: 'personal',
        },
        assertionIds: [], relationIds: [], score: 1,
      }],
      truncated: false, omitted: { inaccessible: 0, deleted: 0, lowConfidence: 0 },
    }),
  }
  const result = await store.query({ limit: 1 }, {
    actorId: 'task-agent', domains: ['files'], devices: ['phone'], includeRestricted: false, allowInferred: false,
  })
  expect(result.hits[0]?.artifact.source.deviceId).toBe('phone')
})
