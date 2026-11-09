import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { until } from '../executor/background.ts'
import type { RoleModel } from '../policy.ts'

export const MODEL_STATUS_TIMEOUT_MS = 5000
type UnknownReason = 'capability_missing' | 'session_missing' | 'migration_required' | 'projection_missing'
  | 'invalid_projection' | 'read_failed' | 'timed_out' | 'cancelled'
type Observation = { state: 'unknown'; reason: UnknownReason }
  | { state: 'observed'; asOfSeq: number; lastUsed: RoleModel | null; next: RoleModel | null }
export interface ControllerModelStatus {
  sessionId: string
  observedAt: string
  configured: { model: RoleModel | null; revision: number }
  observation: Observation
}
interface SettingsReader {
  settings(): { eval: { model: RoleModel | null } }
  blockRevision(block: 'eval'): number
}
// 观察保留宿主记录的原值；配置写入的 trim 规则不适用于已发生的请求。
const RecordedModelSchema = z.object({
  provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional(),
})
const ProjectionSchema = z.object({
  kind: z.literal('sequenced'),
  asOfSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  values: z.object({
    modelSelection: z.object({ lastUsed: RecordedModelSchema.nullable(), next: RecordedModelSchema.nullable() }).optional(),
  }),
})

/** 复用宿主的只读模型投影；不激活会话，不从保存配置推断请求事实。 */
export async function controllerModelStatus(ctx: Context, store: SettingsReader, sessionId: string,
  signal: AbortSignal): Promise<ControllerModelStatus> {
  const unknown = (reason: UnknownReason): Observation => ({ state: 'unknown', reason })
  const observe = async (): Promise<Observation> => {
    if (signal.aborted) return unknown('cancelled')
    const controller = ctx.sessionController
    if (typeof controller?.projections !== 'function') return unknown('capability_missing')
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), MODEL_STATUS_TIMEOUT_MS)
    timer.unref?.()
    const bounded = AbortSignal.any([signal, timeout.signal])
    try {
      const result = await until(controller.projections({ sessionId: sessionId as SessionId }, bounded), bounded)
      if (bounded.aborted || result === false) return unknown(signal.aborted ? 'cancelled' : 'timed_out')
      if (result === null) return unknown('session_missing')
      if (result.kind === 'migration-required') return unknown('migration_required')
      const parsed = ProjectionSchema.safeParse(result)
      if (!parsed.success) return unknown('invalid_projection')
      const selection = parsed.data.values.modelSelection
      if (!selection) return unknown('projection_missing')
      return { state: 'observed', asOfSeq: parsed.data.asOfSeq, lastUsed: selection.lastUsed, next: selection.next }
    } catch {
      // 原始宿主错误可能含路径或配置内容，观察失败只返回分类。
      return unknown(bounded.aborted ? signal.aborted ? 'cancelled' : 'timed_out' : 'read_failed')
    } finally { clearTimeout(timer) }
  }
  const observation = await observe()
  return { sessionId, observedAt: new Date().toISOString(),
    configured: { model: store.settings().eval.model, revision: store.blockRevision('eval') }, observation }
}
