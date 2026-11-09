import { z } from 'zod'

export const SCENARIOS = ['selective-read', 'revision-reuse', 'revoked-source', 'offline-device'] as const
export const METRIC_KEYS = ['deviceQueryCalls', 'deviceReadCalls', 'deviceRequestJsonBytes', 'deviceResponseJsonBytes',
  'transferredFragmentUtf8Bytes', 'nodeToolCalls', 'nodeToolFailures', 'nodeToolRequestJsonBytes', 'nodeToolSuccessJsonBytes',
  'contextJsonBytesMax', 'nodeDeliveryUtf8Bytes', 'nodeSessions', 'activeSessionsSampledMax',
  'snapshotJsonBytesSampledMax', 'snapshotJsonBytesFinal', 'retainedSourceUtf8BytesSampledMax',
  'retainedSourceUtf8BytesFinal', 'evidenceDocumentsFinal', 'attemptsFinal'] as const
const count = z.number().int().nonnegative()
const metrics = z.object(Object.fromEntries(METRIC_KEYS.map(key => [key, count])) as Record<typeof METRIC_KEYS[number], typeof count>).strict()
const CaseSchema = z.object({
  scenario: z.enum(SCENARIOS), sample: z.number().int().min(1).max(5), completed: z.boolean(), passed: z.boolean(),
  checks: z.array(z.object({ name: z.string().min(1).max(200), passed: z.boolean() }).strict()).min(1).max(100),
  metrics, observed: z.object({ wallMs: z.number().nonnegative(), rssStartBytes: count, rssEndBytes: count }).strict(),
}).strict()
const EnvironmentSchema = z.object({
  node: z.string(), platform: z.string(), arch: z.string(), osRelease: z.string(), cpu: z.string(),
}).strict()
const ReportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().uuid(), corpusVersion: z.string().min(1),
  corpusHash: z.string().regex(/^[a-f0-9]{64}$/), repetitions: z.number().int().min(1).max(5),
  expectedRuns: count, passed: z.boolean(), sourceCorpusUtf8Bytes: count,
  mode: z.literal('scripted-host-and-device-ports'), exclusions: z.array(z.string()).max(20),
  cases: z.array(CaseSchema).max(20),
  protocolHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  implementationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  environment: EnvironmentSchema.optional(), generatedAt: z.iso.datetime().optional(),
})
export type BaselineMetrics = z.infer<typeof metrics>
export type BaselineCase = z.infer<typeof CaseSchema>

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** 从原始采样重算结论，忽略历史报告声称的 summary，防止缺失、重复或失败样本被当作通过。 */
export function summarizeBaseline(input: unknown) {
  const report = ReportSchema.parse(input)
  const keys = new Set(report.cases.map(item => `${item.scenario}:${item.sample}`))
  const complete = report.expectedRuns === SCENARIOS.length * report.repetitions
    && report.cases.length === report.expectedRuns && keys.size === report.expectedRuns
    && SCENARIOS.every(scenario => Array.from({ length: report.repetitions }, (_, index) => index + 1)
      .every(sample => keys.has(`${scenario}:${sample}`)))
  report.passed = report.passed && complete
    && report.cases.every(item => item.completed && item.passed && item.checks.every(check => check.passed))
  const summary = SCENARIOS.map(scenario => {
    const cases = report.cases.filter(item => item.scenario === scenario)
    if (!cases.length) return { scenario, samples: 0, passed: false, metrics: null, observedWallMsMedian: null }
    return { scenario, samples: cases.length, passed: cases.length === report.repetitions
      && cases.every(item => item.completed && item.passed && item.checks.every(check => check.passed)),
    metrics: Object.fromEntries(METRIC_KEYS.map(key => [key, {
      min: Math.min(...cases.map(item => item.metrics[key])), max: Math.max(...cases.map(item => item.metrics[key])),
    }])) as Record<typeof METRIC_KEYS[number], { min: number; max: number }>,
    observedWallMsMedian: median(cases.map(item => item.observed.wallMs)) }
  })
  return { ...report, summary }
}

export function compareBaselines(previousInput: unknown, currentInput: unknown) {
  const previous = summarizeBaseline(previousInput), current = summarizeBaseline(currentInput)
  const compatible = previous.passed && current.passed && !!previous.protocolHash
    && previous.protocolHash === current.protocolHash && previous.corpusHash === current.corpusHash
    && previous.corpusVersion === current.corpusVersion
  const timingComparable = compatible && !!previous.environment && !!current.environment
    && Object.keys(previous.environment).every(key =>
      previous.environment![key as keyof typeof previous.environment] === current.environment![key as keyof typeof current.environment])
  if (!compatible) return { compatible, timingComparable: false,
    reason: '两份报告必须完整通过，且版本、样本和评测协议一致；不能直接比较不同口径。' }
  return { compatible, timingComparable, deltas: current.summary.map(item => {
    const before = previous.summary.find(old => old.scenario === item.scenario)!
    return { scenario: item.scenario,
      maxMetricDeltas: Object.fromEntries(METRIC_KEYS.map(key => [key, item.metrics![key].max - before.metrics![key].max])),
      observedWallMsMedianDelta: timingComparable ? item.observedWallMsMedian! - before.observedWallMsMedian! : null }
  }) }
}
