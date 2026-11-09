import { AsyncLocalStorage } from 'node:async_hooks'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { checkWireHistory, WireProbeError } from './hmm-provider-wire.ts'

export const name = 'superserve-live-wire-audit'
export const inject = ['llm']

const ConfigSchema = z.object({
  marker: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  endpoint: z.string().url().refine(value => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  }),
  reportPath: z.string().refine(isAbsolute),
  maxCalls: z.number().int().min(1).max(32).default(16),
  maxBodyBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(2 * 1024 * 1024),
}).strict()

export type AuditConfig = z.input<typeof ConfigSchema>
type Usage = Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>
interface WireRecord extends Partial<ReturnType<typeof checkWireHistory>> {
  bodyBytes: number
  checksPassed: boolean
  status?: number
  failure?: string
  transportError?: boolean
}
interface CallRecord {
  sessionId: string
  at: string
  endedAt?: string
  finish?: string
  toolCalls: string[]
  usage?: Partial<Usage>
  requests: WireRecord[]
}
interface Capture {
  options: GenerateOptions
  wire: WireRecord
  chunks: Buffer[]
  retained: number
}
interface RequestEvent {
  request: object & { origin: string; path: string }
  chunk?: Uint8Array | string
  response?: { statusCode: number }
}

/** 仅观察显式标记的合成任务；不接管传输、凭据或业务调度。 */
export function apply(ctx: Context, input: AuditConfig): void {
  const parsed = ConfigSchema.safeParse(input)
  if (!parsed.success) throw new Error('诊断配置无效；必须指定合成标记、无凭据端点和绝对报告路径')
  const config = parsed.data
  const endpoint = new URL(config.endpoint)
  const storage = new AsyncLocalStorage<{ options: GenerateOptions; record: CallRecord }>()
  let requests = new WeakMap<object, Capture>()
  const active = new Set<Capture>()
  const report = {
    schemaVersion: 1, marker: config.marker, startedAt: new Date().toISOString(),
    active: true, closedAt: undefined as string | undefined,
    nodeVersion: process.version, undiciVersion: process.versions.undici,
    rawMessagesSaved: false, requestHeadersRead: false, requestMutated: false,
    droppedCalls: 0, observationErrors: 0, bufferedBytes: 0, peakBufferedBytes: 0,
    records: [] as CallRecord[],
  }
  const flush = () => {
    try { writeFileSync(config.reportPath, JSON.stringify(report, null, 2) + '\n') }
    catch { report.observationErrors++ }
  }
  const release = (capture: Capture) => {
    report.bufferedBytes -= capture.retained
    capture.retained = 0
    capture.chunks.length = 0
    active.delete(capture)
  }
  // 诊断订阅的异常不得进入宿主的 uncaughtException 路径。
  const safe = (handler: (event: RequestEvent) => void) => (event: unknown) => {
    if (!report.active) return
    try { handler(event as RequestEvent) } catch { report.observationErrors++ }
  }
  const handlers = {
    'undici:request:create': safe(({ request }) => {
      const trace = storage.getStore()
      if (!trace || String(request.origin) !== endpoint.origin || request.path !== endpoint.pathname) return
      if (trace.record.requests.length >= 6) { report.droppedCalls++; return }
      const wire: WireRecord = { bodyBytes: 0, checksPassed: false }
      trace.record.requests.push(wire)
      const capture: Capture = { options: trace.options, wire, chunks: [], retained: 0 }
      requests.set(request, capture)
      active.add(capture)
    }),
    'undici:request:bodyChunkSent': safe(({ request, chunk }) => {
      const capture = requests.get(request)
      if (!capture || chunk === undefined) return
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
      capture.wire.bodyBytes += size
      if (capture.wire.failure) return
      // 所有并发请求共用预算；超限只停止观察，不取消模型请求。
      if (report.bufferedBytes + size > config.maxBodyBytes) {
        capture.wire.failure = 'audit_buffer_limit'
        release(capture)
        return
      }
      capture.chunks.push(Buffer.from(chunk))
      capture.retained += size
      report.bufferedBytes += size
      report.peakBufferedBytes = Math.max(report.peakBufferedBytes, report.bufferedBytes)
    }),
    'undici:request:bodySent': safe(({ request }) => {
      const capture = requests.get(request)
      if (!capture) return
      try {
        if (!capture.wire.failure) {
          const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(capture.chunks))
          Object.assign(capture.wire, checkWireHistory(capture.options, JSON.parse(body)), { checksPassed: true })
        }
      } catch (error) {
        capture.wire.failure = error instanceof WireProbeError ? error.code : 'audit_body_parse'
      } finally { release(capture); flush() }
    }),
    'undici:request:headers': safe(({ request, response }) => {
      const capture = requests.get(request)
      if (capture && response && Number.isInteger(response.statusCode)) capture.wire.status = response.statusCode
    }),
    'undici:request:error': safe(({ request }) => {
      const capture = requests.get(request)
      if (!capture) return
      capture.wire.transportError = true
      release(capture)
      flush()
    }),
  }
  ctx.effect(() => {
    for (const [channel, handler] of Object.entries(handlers)) subscribe(channel, handler)
    flush()
    return () => {
      for (const [channel, handler] of Object.entries(handlers)) unsubscribe(channel, handler)
      for (const capture of active) release(capture)
      requests = new WeakMap()
      storage.disable()
      report.active = false
      report.closedAt = new Date().toISOString()
      flush()
    }
  }, 'synthetic task wire observation')
  ctx.on('llm/stream', (options, next) => {
    if (!report.active || !String(options.sessionId ?? '').startsWith('hmm-')
      || !options.messages.some(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text.includes(config.marker)))) return next()
    if (report.records.length >= config.maxCalls) { report.droppedCalls++; flush(); return next() }
    const record: CallRecord = {
      sessionId: String(options.sessionId), at: new Date().toISOString(), requests: [], toolCalls: [],
    }
    report.records.push(record)
    flush()
    const trace = { options, record }
    return (async function* () {
      let iterator: AsyncIterator<StreamChunk> | undefined
      let completed = false
      try {
        iterator = storage.run(trace, () => next()[Symbol.asyncIterator]())
        while (true) {
          const item = await storage.run(trace, () => iterator!.next())
          if (item.done) { completed = true; break }
          const chunk = item.value
          if (report.active) {
            if (chunk.type === 'usage') {
              record.usage = {}
              for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
                const value = chunk.usage[key]
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record.usage[key] = value
              }
            }
            if (chunk.type === 'finish') record.finish = chunk.reason.kind
            if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && record.toolCalls.length < 64) {
              const toolName = chunk.block.name
              record.toolCalls.push(options.tools?.some(tool => tool.name === toolName) ? toolName : 'unregistered_tool')
            }
          }
          yield chunk
        }
      } finally {
        try { if (!completed && iterator?.return) await storage.run(trace, () => iterator!.return!()) }
        finally {
          if (report.active) {
            for (const capture of active) {
              if (!record.requests.includes(capture.wire)) continue
              capture.wire.failure ??= 'audit_incomplete'
              release(capture)
            }
            record.endedAt = new Date().toISOString()
            flush()
          }
        }
      }
    })()
  })
}
