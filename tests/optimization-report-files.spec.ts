import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { OptimizationReportFiles } from '../src/development/optimization-report-files.ts'
import type { Family, Key } from '../src/kv-key.ts'

it('全局序列化字节有上限，超限不写部分原件且不同报告共享已有字节', () => {
  const records = new Map<string, unknown>()
  const store = {
    get<V>(key: Key<V>) { return records.get(key) as V | undefined },
    set<V>(key: Key<V>, value: V) { records.set(key, value) },
    keys<V>(key: Family<V, never>) { return [...records.keys()].filter(name => name.startsWith(key.prefix)) as Key<V>[] },
  }
  const files = new OptimizationReportFiles(store)
  let accepted = 0
  for (let index = 0; index < 16; index++) {
    const data = Buffer.alloc(4 * 1024 * 1024, index)
    const sha256 = createHash('sha256').update(data).digest('hex')
    const artifacts = [{ name: 'report.json', status: 'read' as const, sha256, bytes: data.length }]
    const collected = new Map([['report.json', data]])
    const before = records.size, id = index.toString(16).padStart(64, '0')
    try {
      files.retain('task', id, artifacts, collected, '2026-11-07T00:00:00.000Z')
      accepted++
      const blobCount = [...records.keys()].filter(key => key.startsWith('development:quality-file:')).length
      files.retain('other-task', id, artifacts, collected, '2026-11-07T00:00:00.000Z')
      expect([...records.keys()].filter(key => key.startsWith('development:quality-file:'))).toHaveLength(blobCount)
    } catch (error) {
      expect(error).toMatchObject({ code: 'optimization_archive_budget' })
      expect(records.size).toBe(before)
      break
    }
  }
  expect(accepted).toBeGreaterThan(0)
  expect(accepted).toBeLessThan(16)
  const bytes = [...records.entries()].filter(([key]) => key.startsWith('development:quality-file:'))
    .reduce((sum, [, value]) => sum + Buffer.byteLength(JSON.stringify(value)), 0)
  expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
})
