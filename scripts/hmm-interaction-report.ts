import { createHash } from 'node:crypto'
import { z } from 'zod'

const Id = z.string().trim().min(1).max(100)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Count = z.number().int().nonnegative()
const Mode = z.enum(['human', 'scripted'])
const Outcome = z.enum(['accepted', 'rejected', 'environment_failure', 'abandoned', 'incomplete'])
export const INTERACTION_COSTS = ['interactions', 'misoperations', 'httpRequests', 'httpBytes'] as const
const PlanSchema = z.object({
  schemaVersion: z.literal(1), id: Id, mode: Mode, measurementHash: Hash,
  variants: z.tuple([
    z.object({ id: Id, implementationHash: Hash }).strict(),
    z.object({ id: Id, implementationHash: Hash }).strict(),
  ]),
  scenarios: z.array(z.object({
    id: Id, taskHash: Hash, acceptanceHash: Hash,
    exposure: z.enum(['development', 'held_out']),
  }).strict()).min(1).max(100),
  pairs: z.array(z.object({
    id: Id, participantId: Id, scenarioId: Id, environmentHash: Hash,
    order: z.tuple([Id, Id]),
  }).strict()).min(1).max(1000),
}).strict()
const ObservationSchema = z.object({
  pairId: Id, variantId: Id, planHash: Hash, implementationHash: Hash, environmentHash: Hash,
  mode: Mode, finished: z.boolean(),
  attempts: z.array(z.object({
    id: Id, outcome: Outcome, startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(),
    evidenceHash: Hash.nullable(),
    costs: z.object({
      interactions: Count.nullable(), misoperations: Count.nullable(), httpRequests: Count.nullable(), httpBytes: Count.nullable(),
    }).strict(),
  }).strict()).min(1).max(100),
}).strict()
const InputSchema = z.object({
  plan: PlanSchema, observations: z.array(ObservationSchema).max(2000),
}).strict()
export type InteractionPlan = z.infer<typeof PlanSchema>
export type InteractionObservation = z.infer<typeof ObservationSchema>
export type InteractionInput = z.infer<typeof InputSchema>

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label}存在重复身份，不能重复计量。`)
}

function readPlan(input: unknown) {
  const plan = PlanSchema.parse(input)
  unique(plan.variants.map(item => item.id), '版本')
  unique(plan.scenarios.map(item => item.id), '场景')
  unique(plan.pairs.map(item => item.id), '配对')
  for (const pair of plan.pairs) {
    if (!plan.scenarios.some(item => item.id === pair.scenarioId)
      || new Set(pair.order).size !== 2 || pair.order.some(id => !plan.variants.some(item => item.id === id)))
      throw new Error('配对必须引用已登记的场景，并按明确顺序包含两个不同版本。')
  }
  return plan
}

/** 结构化解析固定字段顺序；摘要只绑定计划内容，不能证明外部记录真实或计划事先冻结。 */
export function interactionPlanHash(input: unknown) {
  return createHash('sha256').update(JSON.stringify(readPlan(input))).digest('hex')
}

function total(values: (number | null)[]) {
  const known = values.filter((value): value is number => value !== null)
  const sum = known.reduce((a, b) => a + b, 0), overflow = !Number.isSafeInteger(sum)
  const missing = values.length - known.length
  return { total: missing || overflow ? null : sum, observedTotal: overflow ? null : sum, missing, overflow }
}

/** 先报告计划缺口和全部尝试，再计算同口径差异；失败不是删样本的理由。 */
export function summarizeInteraction(input: unknown) {
  const parsed = InputSchema.parse(input), plan = readPlan(parsed.plan), planHash = interactionPlanHash(plan)
  const observations = parsed.observations
  unique(observations.map(item => JSON.stringify([item.pairId, item.variantId])), '运行')
  unique(observations.flatMap(item => item.attempts.map(attempt => attempt.id)), '尝试')
  const issues: { pairId: string; variantId?: string; code: string; message: string }[] = []
  const add = (pairId: string, variantId: string | undefined, code: string, message: string) =>
    issues.push({ pairId, ...(variantId ? { variantId } : {}), code, message })
  const developmentTasks = new Set(plan.scenarios.filter(item => item.exposure === 'development').map(item => item.taskHash))
  for (const pair of plan.pairs) {
    const scenario = plan.scenarios.find(item => item.id === pair.scenarioId)!
    if (scenario.exposure === 'held_out' && developmentTasks.has(scenario.taskHash))
      add(pair.id, undefined, 'exposure_overlap', '同一任务摘要已用于开发，不能更名后作为留出样本。')
  }
  for (const run of observations) {
    if (!plan.pairs.some(item => item.id === run.pairId) || !plan.variants.some(item => item.id === run.variantId))
      throw new Error('观测引用了计划外运行；请单独保留并核对计划，不能静默丢弃。')
  }
  const runs = plan.pairs.flatMap(pair => plan.variants.map(variant => {
    const run = observations.find(item => item.pairId === pair.id && item.variantId === variant.id)
    const startIssues = issues.length
    if (!run) {
      add(pair.id, variant.id, 'missing_run', '计划运行缺少观测，不能计为零成本或完成。')
      return { pair, variantId: variant.id, run, elapsedMs: null, valid: false }
    }
    if (run.planHash !== planHash || run.implementationHash !== variant.implementationHash
      || run.environmentHash !== pair.environmentHash || run.mode !== plan.mode)
      add(pair.id, variant.id, 'binding_mismatch', '计划、版本、环境或采集方式不一致，保留成本但不能直接比较。')
    if (!run.finished || run.attempts.at(-1)!.outcome === 'incomplete')
      add(pair.id, variant.id, 'unfinished_run', '运行尚未完成，不能只选已成功的部分。')
    let chronologyValid = true
    for (const [index, attempt] of run.attempts.entries()) {
      const previous = run.attempts[index - 1]
      if (attempt.endedAt === null || Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt)
        || (previous && (previous.endedAt === null
          || Date.parse(attempt.startedAt) < Date.parse(previous.endedAt)))) chronologyValid = false
      if (previous && !['rejected', 'environment_failure'].includes(previous.outcome))
        add(pair.id, variant.id, 'invalid_retry', '成功、放弃或未核清的尝试之后不能直接追加重试。')
      if (!attempt.evidenceHash)
        add(pair.id, variant.id, 'missing_evidence', '尝试缺少证据引用；结果声明不是独立验收证明。')
      if (INTERACTION_COSTS.some(key => attempt.costs[key] === null))
        add(pair.id, variant.id, 'missing_cost', '存在未测成本；未知值不能当作零。')
    }
    if (!chronologyValid) add(pair.id, variant.id, 'invalid_time', '时间缺失、倒置或重叠，不能计算完整耗时。')
    // 重试间隙也计入任务耗时，不能只累计执行片段而遗漏恢复等待。
    const elapsedMs = chronologyValid
      ? Date.parse(run.attempts.at(-1)!.endedAt!) - Date.parse(run.attempts[0]!.startedAt) : null
    return { pair, variantId: variant.id, run, elapsedMs, valid: startIssues === issues.length }
  }))
  for (const pair of plan.pairs) {
    const first = runs.find(item => item.pair.id === pair.id && item.variantId === pair.order[0])!
    const second = runs.find(item => item.pair.id === pair.id && item.variantId === pair.order[1])!
    if (first.run && second.run && first.elapsedMs !== null && second.elapsedMs !== null
      && Date.parse(first.run.attempts.at(-1)!.endedAt!) > Date.parse(second.run.attempts[0]!.startedAt))
      add(pair.id, undefined, 'order_mismatch', '实际执行顺序与预先计划不符或两个版本重叠。')
  }
  if (plan.mode === 'human') {
    const people = new Map<string, typeof runs>()
    for (const run of runs) {
      const list = people.get(run.pair.participantId) ?? []
      if (run.run && run.elapsedMs !== null) list.push(run)
      people.set(run.pair.participantId, list)
    }
    for (const list of people.values()) {
      list.sort((a, b) => Date.parse(a.run!.attempts[0]!.startedAt) - Date.parse(b.run!.attempts[0]!.startedAt))
      let latestEnd = -Infinity
      for (const item of list) {
        if (Date.parse(item.run!.attempts[0]!.startedAt) < latestEnd)
          add(item.pair.id, item.variantId, 'participant_overlap', '同一参与者的观测时间重叠，需核实真实采集归属。')
        latestEnd = Math.max(latestEnd, Date.parse(item.run!.attempts.at(-1)!.endedAt!))
      }
    }
  }
  const groups = (['development', 'held_out'] as const).map(exposure => {
    const pairs = plan.pairs.filter(pair => plan.scenarios.find(item => item.id === pair.scenarioId)!.exposure === exposure)
    const arms = plan.variants.map(variant => {
      const selected = runs.filter(item => item.variantId === variant.id && pairs.some(pair => pair.id === item.pair.id))
      const attempts = selected.flatMap(item => item.run?.attempts ?? [])
      return {
        variantId: variant.id, planned: pairs.length, observed: selected.filter(item => item.run).length,
        finished: selected.filter(item => item.run?.finished && item.run.attempts.at(-1)!.outcome !== 'incomplete').length,
        reportedAccepted: selected.filter(item => item.run?.finished && item.run.attempts.at(-1)!.outcome === 'accepted').length,
        attempts: attempts.length, retries: selected.reduce((sum, item) => sum + Math.max(0, (item.run?.attempts.length ?? 0) - 1), 0),
        outcomes: Object.fromEntries(Outcome.options.map(outcome => [outcome, attempts.filter(item => item.outcome === outcome).length])),
        elapsedMs: total(selected.map(item => item.elapsedMs)),
        costs: Object.fromEntries(INTERACTION_COSTS.map(key => [key,
          total(selected.flatMap(item => item.run ? item.run.attempts.map(attempt => attempt.costs[key]) : [null])),
        ])),
      }
    })
    return { declaredExposure: exposure, plannedPairs: pairs.length,
      participants: new Set(pairs.map(item => item.participantId)).size, arms }
  })
  const order = plan.scenarios.map(scenario => {
    const pairs = plan.pairs.filter(pair => pair.scenarioId === scenario.id)
    const firstCounts = plan.variants.map(variant => pairs.filter(pair => pair.order[0] === variant.id).length)
    return { scenarioId: scenario.id, firstCounts, balanced: firstCounts[0] === firstCounts[1] }
  })
  const comparisons = plan.pairs.map(pair => {
    const paired = runs.filter(item => item.pair.id === pair.id)
    const [first, second] = paired
    const costs = INTERACTION_COSTS.map(key => ({ key,
      before: total(first?.run?.attempts.map(item => item.costs[key]) ?? [null]),
      after: total(second?.run?.attempts.map(item => item.costs[key]) ?? [null]),
    }))
    const usable = paired.every(item => item.valid) && !issues.some(issue => issue.pairId === pair.id)
      && costs.every(item => item.before.total !== null && item.after.total !== null)
    const costDeltas = Object.fromEntries(costs.map(item => [
      item.key, usable ? item.after.total! - item.before.total! : null,
    ]))
    return { pairId: pair.id, available: usable,
      reportedFinalOutcomes: { from: first?.run?.attempts.at(-1)?.outcome ?? null, to: second?.run?.attempts.at(-1)?.outcome ?? null },
      elapsedMsDelta: usable ? second!.elapsedMs! - first!.elapsedMs! : null, costDeltas }
  })
  const overflow = groups.some(group => group.arms.some(arm =>
    arm.elapsedMs.overflow || Object.values(arm.costs).some(value => value.overflow)))
  return {
    schemaVersion: 1, experimentId: plan.id, planHash, mode: plan.mode, descriptiveOnly: true,
    comparisonReady: issues.length === 0 && !overflow,
    deltaDirection: { from: plan.variants[0].id, to: plan.variants[1].id },
    plannedRuns: runs.length, observedRuns: observations.length, issues, groups, order, comparisons, overflow,
    limitations: [
      '身份摘要仅核对记录口径，未读取外部证据，也不能证明预先登记、独立验收或留出集未被使用。',
      plan.mode === 'human' ? '参与者和计量均来自导入记录；不能仅凭 human 标记确认真实用户实验。'
        : '本报告为脚本采集，不能解释为人类认知负荷或人工耗时改善。',
      '描述性差异不证明因果、统计显著性或持续收益；重复参与者不是独立样本。',
      '本口径仅包含墙钟时间、交互次数和 HTTP 成本，未覆盖模型费用、磁盘、内存或完整运维成本。',
      ...(!order.every(item => item.balanced) ? ['版本先后顺序未按场景平衡，学习和顺序效应仍可能影响差异。'] : []),
    ],
  }
}
