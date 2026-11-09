import { modelFailure, type ModelFailureCode } from '../hmm/model-failure.ts'
import type { RetryHealthEvent } from './retry-health.ts'

export interface ControllerFailure { modelFailureCode: ModelFailureCode; reason: string; observedAt: string }
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const ordinal = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** 总管原生回合日志的有界投影；不保存正文，不把空闲或重试启动视为恢复。 */
export class ControllerHealth {
  private seq = -1
  private turn = -1
  private failure: ControllerFailure | null = null

  restore(events: readonly RetryHealthEvent[]): void {
    this.seq = -1; this.turn = -1; this.failure = null
    for (const event of events) this.observe(event)
  }

  get(): ControllerFailure | null { return this.failure ? { ...this.failure } : null }

  observe(event: RetryHealthEvent): void {
    if (!ordinal(event.seq) || event.seq <= this.seq || !Number.isFinite(event.time)
      || event.time < 0 || event.time > 8.64e15) return
    this.seq = event.seq
    if (event.type !== 'turn/end') return
    const data = record(event.data), reason = record(data?.reason)
    if (!data || !ordinal(data.turn) || data.turn < this.turn || !reason) return
    this.turn = data.turn
    if (reason.kind === 'error') {
      const failure = modelFailure(reason.error)
      this.failure = { modelFailureCode: failure.code, reason: failure.reason, observedAt: new Date(event.time).toISOString() }
    } else if (reason.kind === 'completed') {
      this.failure = null
    }
  }
}
