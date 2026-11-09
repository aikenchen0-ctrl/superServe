import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  interactionPlanHash, summarizeInteraction, type InteractionInput, type InteractionObservation,
} from '../scripts/hmm-interaction-report.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture(): InteractionInput {
  const plan: InteractionInput['plan'] = {
    schemaVersion: 1, id: 'synthetic-control', mode: 'scripted', measurementHash: hash('measurement-rules'),
    variants: [{ id: 'before', implementationHash: hash('before') }, { id: 'after', implementationHash: hash('after') }],
    scenarios: [
      { id: 'practice', taskHash: hash('practice'), acceptanceHash: hash('acceptance'), exposure: 'development' },
      { id: 'sealed', taskHash: hash('sealed'), acceptanceHash: hash('acceptance'), exposure: 'held_out' },
    ],
    pairs: [
      { id: 'pair-1', participantId: 'subject-1', scenarioId: 'practice', environmentHash: hash('environment'), order: ['before', 'after'] },
      { id: 'pair-2', participantId: 'subject-2', scenarioId: 'sealed', environmentHash: hash('environment'), order: ['after', 'before'] },
    ],
  }
  const observations = plan.pairs.flatMap(pair => pair.order.map((variantId, index): InteractionObservation => ({
    pairId: pair.id, variantId, planHash: interactionPlanHash(plan),
    implementationHash: plan.variants.find(item => item.id === variantId)!.implementationHash,
    environmentHash: pair.environmentHash, mode: plan.mode, finished: true,
    attempts: [{
      id: `${pair.id}-${variantId}-1`, outcome: 'accepted',
      startedAt: `2026-11-07T00:0${index}:00Z`, endedAt: `2026-11-07T00:0${index}:10Z`,
      evidenceHash: hash(`${pair.id}-${variantId}`), costs: { interactions: 3, misoperations: 0, httpRequests: 2, httpBytes: 100 },
    }],
  })))
  return { plan, observations }
}
const arm = (input: InteractionInput) => summarizeInteraction(input).groups[0]!.arms[0]!

it('对完整配对只提供描述性差异，开发与留出声明分开统计', () => {
  const input = fixture()
  input.observations[1]!.attempts[0]!.endedAt = '2026-11-07T00:01:08Z'
  input.observations[1]!.attempts[0]!.costs.httpRequests = 1
  const result = summarizeInteraction(input)
  expect(result).toMatchObject({ comparisonReady: true, descriptiveOnly: true, mode: 'scripted', plannedRuns: 4, observedRuns: 4 })
  expect(result.comparisons[0]).toMatchObject({ elapsedMsDelta: -2000, costDeltas: { httpRequests: -1 } })
  expect(result.groups.map(group => [group.declaredExposure, group.plannedPairs])).toEqual([['development', 1], ['held_out', 1]])
  expect(result).not.toHaveProperty('winner')
})

it('重试保留失败成本及恢复间隙，后续成功只算一个完成任务', () => {
  const input = fixture(), run = input.observations[0]!
  run.attempts[0]!.outcome = 'environment_failure'
  run.attempts.push({
    ...structuredClone(run.attempts[0]!), id: 'retry', outcome: 'accepted',
    startedAt: '2026-11-07T00:00:20Z', endedAt: '2026-11-07T00:00:30Z',
  })
  expect(arm(input)).toMatchObject({
    reportedAccepted: 1, attempts: 2, retries: 1, outcomes: { environment_failure: 1, accepted: 1 },
    elapsedMs: { total: 30000 }, costs: { interactions: { total: 6 }, httpBytes: { total: 200 } },
  })
  expect(summarizeInteraction(input).comparisonReady).toBe(true)
})

it.each(['rejected', 'environment_failure', 'abandoned'] as const)('保留完整的 %s 记录而不要求所有任务成功', outcome => {
  const input = fixture()
  input.observations[0]!.attempts[0]!.outcome = outcome
  expect(summarizeInteraction(input).comparisonReady).toBe(true)
  expect(summarizeInteraction(input).comparisons[0]!.reportedFinalOutcomes).toEqual({ from: outcome, to: 'accepted' })
  expect(arm(input)).toMatchObject({ reportedAccepted: 0, attempts: 1, elapsedMs: { total: 10000 } })
  expect(arm(input).outcomes[outcome]).toBe(1)
})

it('缺失运行和未测成本分别留空，不用成功子集生成完整对照', () => {
  const input = fixture()
  input.observations.pop()
  input.observations[0]!.attempts[0]!.costs.httpBytes = null
  const result = summarizeInteraction(input)
  expect(result.comparisonReady).toBe(false)
  expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining(['missing_run', 'missing_cost']))
  expect(result.comparisons.every(item => !item.available && item.elapsedMsDelta === null)).toBe(true)
  expect(arm(input).costs.httpBytes).toEqual({ total: null, observedTotal: 0, missing: 1, overflow: false })
})

it.each(['planHash', 'implementationHash', 'environmentHash', 'mode'] as const)('阻止 %s 变化后沿用结论，但保留实际成本', key => {
  const input = fixture()
  Object.assign(input.observations[0]!, { [key]: key === 'mode' ? 'human' : hash('changed') })
  const result = summarizeInteraction(input)
  expect(result.comparisonReady).toBe(false)
  expect(result.issues.some(item => item.code === 'binding_mismatch')).toBe(true)
  expect(arm(input).costs.httpBytes!.total).toBe(100)
})

it('改变验收、采集规则或留出声明需要新计划摘要，不能追改口径', () => {
  for (const change of ['acceptance', 'exposure', 'order', 'measurement']) {
    const input = fixture()
    if (change === 'acceptance') input.plan.scenarios[0]!.acceptanceHash = hash('relaxed')
    if (change === 'exposure') input.plan.scenarios[0]!.exposure = 'held_out'
    if (change === 'order') input.plan.pairs[0]!.order.reverse()
    if (change === 'measurement') input.plan.measurementHash = hash('different-counter')
    expect(summarizeInteraction(input).comparisonReady).toBe(false)
  }
})

it('误操作单独计量，同样的交互次数不能推断错误率相同', () => {
  const input = fixture()
  input.observations[1]!.attempts[0]!.costs.misoperations = 1
  expect(summarizeInteraction(input).comparisons[0]!.costDeltas).toMatchObject({ interactions: 0, misoperations: 1 })
})

it('相同任务不能仅更名就变成留出样本', () => {
  const input = fixture()
  input.plan.scenarios[1]!.taskHash = input.plan.scenarios[0]!.taskHash
  for (const item of input.observations) item.planHash = interactionPlanHash(input.plan)
  const result = summarizeInteraction(input)
  expect(result.issues.some(item => item.code === 'exposure_overlap')).toBe(true)
  expect(result.comparisons[1]!.available).toBe(false)
  expect(result.groups[1]!.arms[0]!.attempts).toBe(1)
})

it('对象字段顺序不改变语义摘要，未知字段不能伪装成既有协议', () => {
  const plan = fixture().plan
  expect(interactionPlanHash(Object.fromEntries(Object.entries(plan).reverse()))).toBe(interactionPlanHash(plan))
  expect(() => interactionPlanHash({ ...plan, success: true })).toThrow()
})

it('导入顺序和版本名称不影响成本方向，零观测仍保留全部计划缺口', () => {
  const input = fixture(), expected = summarizeInteraction(input)
  input.observations.reverse()
  expect(summarizeInteraction(input)).toEqual(expected)
  input.plan.variants[0].id = 'arbitrary-variant'
  for (const pair of input.plan.pairs) pair.order = pair.order.map(id => id === 'before' ? 'arbitrary-variant' : id) as [string, string]
  for (const run of input.observations) {
    if (run.variantId === 'before') run.variantId = 'arbitrary-variant'
    run.planHash = interactionPlanHash(input.plan)
  }
  expect(summarizeInteraction(input).comparisons).toEqual(expected.comparisons)
  input.observations = []
  const empty = summarizeInteraction(input)
  expect(empty).toMatchObject({ comparisonReady: false, plannedRuns: 4, observedRuns: 0 })
  expect(empty.issues.filter(item => item.code === 'missing_run')).toHaveLength(4)
  expect(empty.groups[0]!.arms[0]!.elapsedMs.total).toBe(null)
})

it.each(['run', 'attempt', 'pair', 'scenario', 'variant', 'unplanned'])('拒绝身份重复或计划外的 %s', what => {
  const input = fixture()
  if (what === 'run') input.observations.push(structuredClone(input.observations[0]!))
  if (what === 'attempt') input.observations[1]!.attempts[0]!.id = input.observations[0]!.attempts[0]!.id
  if (what === 'pair') input.plan.pairs.push(structuredClone(input.plan.pairs[0]!))
  if (what === 'scenario') input.plan.scenarios.push(structuredClone(input.plan.scenarios[0]!))
  if (what === 'variant') input.plan.variants[1].id = input.plan.variants[0].id
  if (what === 'unplanned') input.observations[0]!.pairId = 'not-planned'
  expect(() => summarizeInteraction(input)).toThrow()
})

it.each(['accepted', 'abandoned', 'incomplete'] as const)('不能在 %s 后直接重试并删掉先前副作用', outcome => {
  const input = fixture(), run = input.observations[0]!
  run.attempts[0]!.outcome = outcome
  run.attempts.push({ ...structuredClone(run.attempts[0]!), id: 'next', outcome: 'accepted',
    startedAt: '2026-11-07T00:00:20Z', endedAt: '2026-11-07T00:00:30Z' })
  expect(summarizeInteraction(input).issues.some(item => item.code === 'invalid_retry')).toBe(true)
  expect(arm(input).attempts).toBe(2)
})

it.each(['missing', 'reversed', 'overlap', 'order', 'unfinished', 'evidence'])('不能隐去 %s 证据问题', change => {
  const input = fixture(), first = input.observations[0]!, second = input.observations[1]!
  if (change === 'missing') first.attempts[0]!.endedAt = null
  if (change === 'reversed') first.attempts[0]!.endedAt = '2026-11-06T23:59:00Z'
  if (change === 'overlap') first.attempts[0]!.endedAt = '2026-11-07T00:01:01Z'
  if (change === 'order') {
    first.attempts[0]!.startedAt = '2026-11-07T00:02:00Z'
    first.attempts[0]!.endedAt = '2026-11-07T00:02:10Z'
  }
  if (change === 'unfinished') second.finished = false
  if (change === 'evidence') second.attempts[0]!.evidenceHash = null
  expect(summarizeInteraction(input).comparisonReady).toBe(false)
})

it('同一真实参与者不能在两个配对中同时操作，不混同模拟并行', () => {
  const input = fixture()
  input.plan.mode = 'human'
  input.plan.pairs[1]!.participantId = input.plan.pairs[0]!.participantId
  for (const item of input.observations) {
    item.mode = 'human'
    item.planHash = interactionPlanHash(input.plan)
  }
  expect(summarizeInteraction(input).issues.some(item => item.code === 'participant_overlap')).toBe(true)
  expect(summarizeInteraction(fixture()).comparisonReady).toBe(true)
})

it('超出安全整数的成本总量不产生看似精确的比较', () => {
  const input = fixture(), run = input.observations[0]!
  run.attempts[0]!.outcome = 'rejected'
  run.attempts[0]!.costs.httpBytes = Number.MAX_SAFE_INTEGER
  run.attempts.push({ ...structuredClone(run.attempts[0]!), id: 'retry', outcome: 'accepted',
    startedAt: '2026-11-07T00:00:20Z', endedAt: '2026-11-07T00:00:30Z' })
  const result = summarizeInteraction(input)
  expect(result).toMatchObject({ comparisonReady: false, overflow: true })
  expect(result.groups[0]!.arms[0]!.costs.httpBytes!.total).toBe(null)
  expect(result.comparisons[0]).toMatchObject({ available: false, elapsedMsDelta: null })
})

it('数值格式错误、负数、无穷值和额外通过标记不能进入报告', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '1', undefined]) {
    const input = fixture()
    Object.assign(input.observations[0]!.attempts[0]!.costs, { interactions: value })
    expect(() => summarizeInteraction(input)).toThrow()
  }
  expect(() => summarizeInteraction({ ...fixture(), passed: true })).toThrow()
})

it('命令行只读输入，完整和缺证记录使用不同退出码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmm-interaction-'))
  try {
    const path = join(dir, 'observations.json'), script = resolve('scripts/hmm-interaction.mjs')
    const input = fixture(), text = JSON.stringify(input)
    writeFileSync(path, text)
    const complete = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(complete.status, complete.stderr).toBe(0)
    expect(JSON.parse(complete.stdout)).toMatchObject({ comparisonReady: true, mode: 'scripted' })
    expect(readFileSync(path, 'utf8')).toBe(text)
    input.observations.pop()
    writeFileSync(path, JSON.stringify(input))
    const incomplete = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(incomplete.status, incomplete.stderr).toBe(2)
    writeFileSync(path, '{}')
    const invalid = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('字段格式不符合协议')
    writeFileSync(path, '{')
    const malformed = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('有效的 JSON')
    const directory = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(directory.status).toBe(1)
    expect(directory.stderr).toContain('不接受目录')
    const planPath = join(dir, 'plan.json')
    writeFileSync(planPath, JSON.stringify(input.plan))
    const fingerprint = spawnSync(process.execPath, [script, '--plan-hash', planPath], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(fingerprint.status, fingerprint.stderr).toBe(0)
    expect(fingerprint.stdout.trim()).toBe(interactionPlanHash(input.plan))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
