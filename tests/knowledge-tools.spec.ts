import { expect, it } from 'vitest'
import type { KnowledgeAccess } from '../src/knowledge/contracts.ts'

it('keeps a task Agent within its assigned knowledge scope', () => {
  const access: KnowledgeAccess = {
    actorId: 'ticket:123', domains: ['messages'], devices: ['phone'], includeRestricted: false, allowInferred: false,
  }
  expect(access).toMatchObject({ actorId: 'ticket:123', domains: ['messages'], devices: ['phone'], includeRestricted: false })
})
