import { z } from 'zod'

const Timestamp = z.iso.datetime()
const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const Finish = z.enum(['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'])
const RunSchema = z.object({
  marker: z.string().min(1),
  onlyToolResultChanged: z.boolean(),
  toolsExecuted: z.number().int().nonnegative(),
  calls: z.array(z.object({
    variant: z.enum(['A', 'B']),
    at: Timestamp,
    endedAt: Timestamp.optional(),
    expectedHash: Hash,
    outputHash: Hash.optional(),
    outputChars: z.number().int().nonnegative().optional(),
    finish: Finish.optional(),
    toolCalls: z.number().int().nonnegative(),
  })).max(2),
})
const WireSchema = z.object({
  marker: z.string(),
  active: z.boolean(),
  observationErrors: z.number().int().nonnegative(),
  droppedCalls: z.number().int().nonnegative(),
  records: z.array(z.object({
    sessionId: z.string(),
    at: Timestamp,
    endedAt: Timestamp.optional(),
    finish: Finish.optional(),
    requests: z.array(z.object({
      checksPassed: z.boolean(),
      bodyBytes: z.number().int().nonnegative(),
      toolResults: z.number().int().nonnegative().optional(),
      status: z.number().int().optional(),
      failure: z.string().optional(),
      transportError: z.boolean().optional(),
    })).max(6),
  })).max(2),
})

interface ControlSample {
  variant: 'A' | 'B'
  httpStatus?: number
  finish?: string
  wireVerified: boolean
  completed: boolean
  matched: boolean
  toolCalls: number
  transportSignal: boolean
}
export interface ToolControlConclusion {
  verdict: 'passed' | 'failed' | 'inconclusive'
  reason: string
  completedCalls: number
  matchedCalls: number
  samples: ControlSample[]
}

/** 实验生命周期不是验收结论；重新核对事实，不信任预计算的通过标记。 */
export function evaluateToolControl(runInput: unknown, wireInput: unknown): ToolControlConclusion {
  const run = RunSchema.safeParse(runInput), wire = WireSchema.safeParse(wireInput)
  const result: ToolControlConclusion = {
    verdict: 'inconclusive', reason: 'invalid_report', completedCalls: 0, matchedCalls: 0, samples: [],
  }
  if (!run.success || !wire.success) return result
  const r = run.data, w = wire.data
  if (!r.onlyToolResultChanged || r.toolsExecuted !== 0 || r.marker !== w.marker) {
    return { ...result, reason: 'uncontrolled_input' }
  }
  if (r.calls.length !== 2 || w.records.length !== 2 || new Set(r.calls.map(call => call.variant)).size !== 2
    || new Set(r.calls.map(call => call.expectedHash)).size !== 2
    || new Set(w.records.map(record => record.sessionId)).size !== 1) {
    return { ...result, reason: 'incomplete_or_ambiguous_pair' }
  }
  if (w.active || w.observationErrors !== 0 || w.droppedCalls !== 0) {
    return { ...result, reason: 'observation_incomplete' }
  }
  const pairs = r.calls.map(call => ({
    call, records: w.records.filter(record => call.endedAt && record.endedAt
      && Date.parse(record.at) >= Date.parse(call.at)
      && Date.parse(record.endedAt) >= Date.parse(record.at)
      && Date.parse(record.endedAt) <= Date.parse(call.endedAt)),
  }))
  if (pairs.some(pair => pair.records.length !== 1 || pair.records[0]!.requests.length !== 1)
    || new Set(pairs.map(pair => pair.records[0])).size !== 2) {
    return { ...result, reason: 'request_correlation_failed' }
  }
  for (const { call, records } of pairs) {
    const record = records[0]!, request = record.requests[0]!
    const verified = request.checksPassed && !request.failure && request.bodyBytes > 0 && request.toolResults === 1
    const completed = verified && request.status === 200 && call.finish === 'stop' && record.finish === 'stop'
    result.samples.push({
      variant: call.variant, httpStatus: request.status, finish: call.finish,
      wireVerified: verified, completed,
      matched: completed && call.outputChars !== undefined && call.outputChars > 0 && call.outputHash === call.expectedHash,
      toolCalls: call.toolCalls, transportSignal: request.transportError === true,
    })
  }
  result.completedCalls = result.samples.filter(sample => sample.completed).length
  result.matchedCalls = result.samples.filter(sample => sample.matched).length
  if (result.completedCalls !== 2) return { ...result, reason: 'call_or_wire_incomplete' }
  if (r.calls.some(call => call.outputHash === undefined || call.outputChars === undefined)) {
    return { ...result, reason: 'answer_evidence_missing' }
  }
  if (result.samples.some(sample => sample.toolCalls !== 0)) return { ...result, verdict: 'failed', reason: 'unexpected_tool_call' }
  return { ...result, verdict: result.matchedCalls === 2 ? 'passed' : 'failed',
    reason: result.matchedCalls === 2 ? 'both_values_matched' : 'answer_mismatch' }
}
