import { expect, it } from 'vitest'
import { compareBaselines, METRIC_KEYS, SCENARIOS, summarizeBaseline } from '../scripts/hmm-baseline-report.ts'

const report = () => ({
  schemaVersion: 1, runId: '00000000-0000-4000-8000-000000000001', corpusVersion: 'fixture',
  corpusHash: 'a'.repeat(64), protocolHash: 'b'.repeat(64), implementationHash: 'c'.repeat(64),
  repetitions: 1, expectedRuns: 4, passed: true, sourceCorpusUtf8Bytes: 100,
  mode: 'scripted-host-and-device-ports', exclusions: [],
  environment: { node: '24.22.1', platform: 'win32', arch: 'x64', osRelease: 'test', cpu: 'test' },
  cases: SCENARIOS.map(scenario => ({ scenario, sample: 1, completed: true, passed: true,
    checks: [{ name: '固定预期', passed: true }],
    metrics: Object.fromEntries(METRIC_KEYS.map(key => [key, 1])),
    observed: { wallMs: 10, rssStartBytes: 100, rssEndBytes: 110 },
  })),
})

it('只比较相同样本和协议，允许实现变化并重算历史摘要', () => {
  const before = { ...report(), summary: [{ scenario: 'forged', metrics: {} }] }, current = report()
  current.implementationHash = 'd'.repeat(64)
  current.cases[0]!.metrics.deviceReadCalls = 2
  current.cases[0]!.observed.wallMs = 14
  const result = compareBaselines(before, current)
  expect(result).toMatchObject({ compatible: true, timingComparable: true })
  expect(result.deltas?.[0]).toMatchObject({ maxMetricDeltas: { deviceReadCalls: 1 }, observedWallMsMedianDelta: 4 })
})

it.each(['missing', 'duplicate', 'failed-check', 'incomplete', 'wrong-count'] as const)('阻止伪通过报告：%s', change => {
  const input = report()
  if (change === 'missing') input.cases.pop()
  if (change === 'duplicate') input.cases[1] = input.cases[0]!
  if (change === 'failed-check') input.cases[0]!.checks[0]!.passed = false
  if (change === 'incomplete') input.cases[0]!.completed = false
  if (change === 'wrong-count') input.expectedRuns = 3
  expect(summarizeBaseline(input).passed).toBe(false)
  expect(compareBaselines(input, report()).compatible).toBe(false)
})

it.each(['corpusHash', 'protocolHash', 'corpusVersion'] as const)('拒绝不同评测口径：%s', key => {
  const changed = report()
  changed[key] = key === 'corpusVersion' ? 'other' : 'e'.repeat(64)
  expect(compareBaselines(report(), changed).compatible).toBe(false)
})

it('不同环境仍可比较计数，但不比较过程耗时', () => {
  const changed = report()
  changed.environment.cpu = 'other'
  expect(compareBaselines(report(), changed)).toMatchObject({ compatible: true, timingComparable: false })
  expect(compareBaselines(report(), changed).deltas?.every(item => item.observedWallMsMedianDelta === null)).toBe(true)
})

it('允许有界重复采样，报告最大资源量与过程耗时中位数', () => {
  const input = report(), original = structuredClone(input.cases)
  input.repetitions = 2; input.expectedRuns = 8
  input.cases.push(...original.map(item => ({ ...item, sample: 2, observed: { ...item.observed, wallMs: 30 } })))
  input.cases[4]!.metrics.deviceReadCalls = 3
  const result = summarizeBaseline(input)
  expect(result.passed).toBe(true)
  expect(result.summary[0]).toMatchObject({ samples: 2, metrics: { deviceReadCalls: { min: 1, max: 3 } }, observedWallMsMedian: 20 })
})

it('拒绝非数值、负数、缺项和无限量采样，不能将缺失计量当作零', () => {
  for (const value of [-1, Infinity, NaN, '1', undefined]) {
    const input = report()
    Object.assign(input.cases[0]!.metrics, { deviceReadCalls: value })
    expect(() => summarizeBaseline(input)).toThrow()
  }
  expect(() => summarizeBaseline({ ...report(), repetitions: 6 })).toThrow()
  expect(() => summarizeBaseline({ ...report(), schemaVersion: 2 })).toThrow()
})
