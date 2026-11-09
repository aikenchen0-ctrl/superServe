import { createHash } from 'node:crypto'
import { z } from 'zod'
import { family, type Family, type Key } from '../kv-key.ts'
import type { OptimizationSuggestions } from './optimization-suggestions.ts'
import { QualityProfileError, type DevelopmentQualityProfiles } from './quality-profiles.ts'
import { QualityFormatSchema, TaskQualityQuerySchema } from './quality-contracts.ts'
import { QualityImportError, type inspectQualityEvidence } from './quality.ts'
import { OptimizationReportFiles } from './optimization-report-files.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const text = z.string().min(1).max(1024)
export const OptimizationReportInputSchema = z.object({
  directory: z.string().trim().min(1).max(4096).refine(value => !value.includes('\0'), '报告目录无效'),
  retainRaw: z.boolean().optional(),
}).strict()
export type OptimizationReportInput = z.input<typeof OptimizationReportInputSchema>
export const OptimizationReportFileQuerySchema = z.object({ name: z.string().min(1).max(128) }).strict()
export type OptimizationReportFileQuery = z.input<typeof OptimizationReportFileQuerySchema>
const ReportSchema = z.object({
  adapter: QualityFormatSchema, bundleDigest: digest,
  reportedExecution: z.enum(['unknown', 'running', 'failed', 'completed']),
  evidence: z.enum(['stale', 'insufficient_evidence', 'findings_reported', 'review_required']),
  declaredIdentity: z.object({ sourceCommit: oid.optional(), scopeDigest: digest.optional(), inputDigest: digest.optional() }).strict(),
  mutationCounts: z.record(z.string().regex(/^[A-Z_]{1,80}$/), count).optional(),
  artifacts: z.array(z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9./-]*$/).max(128),
    status: z.enum(['read', 'missing', 'oversized', 'unreadable', 'invalid_json']),
    bytes: count.optional(), sha256: digest.optional(),
  }).strict()).max(32),
  issues: z.array(z.object({
    code: z.string().regex(/^[a-z_]{1,80}$/), kind: z.enum(['missing', 'finding', 'review', 'stale']),
    message: text, action: text, artifact: text.optional(),
  }).strict()).max(128),
}).strict()
const RecordSchema = z.object({
  schemaVersion: z.literal(1), interpreterVersion: z.literal(1), id: digest,
  ticketId: z.string().min(1), suggestionId: digest, recordedAt: z.string().datetime(), report: ReportSchema,
}).strict()
type Record = z.infer<typeof RecordSchema>
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
  keys<V>(key: Family<V, never>): Key<V>[]
}
const records = (ticketId: string) => family<Record>(`development:optimization-report:${hash(ticketId)}:`)
const content = ({ id: _, recordedAt: __, ...value }: Record) => value
const assurance = { receiptPersisted: true as const,
  sourceAuthenticated: false as const, inputClosureVerified: false as const,
  executionAuthorized: false as const, publishAllowed: false as const }
const fail = (code: string, message: string, status = 409): never => { throw new QualityProfileError(code, message, status) }

/** 复用只读解释器保存有界报告观察；不保存原目录，不将外来声明提升为执行证据。 */
export class OptimizationReports {
  private reading = false
  private readonly files: OptimizationReportFiles
  constructor(private readonly store: Storage,
    private readonly suggestions: Pick<OptimizationSuggestions, 'get'>,
    private readonly profiles: Pick<DevelopmentQualityProfiles, 'get'>,
    private readonly host: { available(): boolean; now(): string; signal: AbortSignal; inspect: typeof inspectQualityEvidence }) {
    this.files = new OptimizationReportFiles(store)
  }

  private available() {
    if (!this.host.available() || this.host.signal.aborted) fail('runtime_unavailable', '运行环境尚未就绪或正在关闭')
  }
  private load(ticketId: string, key: Key<Record>) {
    const parsed = RecordSchema.safeParse(this.store.get(key))
    if (!parsed.success || parsed.data.ticketId !== ticketId || records(ticketId)(parsed.data.id) !== key
      || hash(content(parsed.data)) !== parsed.data.id)
      return fail('optimization_report_corrupt', '报告核对记录的版本、归属或摘要不一致')
    return parsed.data
  }
  private all(ticketId: string) {
    return this.store.keys(records(ticketId)).sort().map(key => this.load(ticketId, key))
  }
  /** 分页返回当时记录及当前建议适用性；读取不重开目录或重新解释报告。 */
  list(ticketId: string, suggestionId: string, input: unknown = {}) {
    const args = TaskQualityQuerySchema.parse(input)
    return this.store.atomic(() => {
      const view = this.suggestions.get(ticketId, suggestionId)
      const items = this.all(ticketId).filter(item => item.suggestionId === suggestionId)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))
      const selected = items.slice(args.offset, args.offset + args.limit)
      const retained = Object.fromEntries(items.map(item => [item.id, this.files.describe(ticketId, item.id, item.report.artifacts)]))
      const snapshot = hash([items, retained, view.applicability])
      if (args.snapshot !== undefined && args.snapshot !== snapshot)
        return fail('optimization_report_changed', '记录或建议依据已变化，请从首页重新读取')
      return { ticketId, suggestionId, binding: view.suggestion.binding, applicability: view.applicability,
        assurance, snapshot, total: items.length, items: selected,
        retained: Object.fromEntries(selected.map(item => [item.id, retained[item.id] ?? null])),
        nextOffset: args.offset + args.limit < items.length ? args.offset + args.limit : null }
    })
  }
  /** 必须先确认任务及报告属于该建议，不能用全局内容摘要读取其他任务的原件。 */
  file(ticketId: string, suggestionId: string, reportId: string, input: unknown) {
    const query = OptimizationReportFileQuerySchema.parse(input)
    if (!digest.safeParse(reportId).success) return fail('invalid_optimization_report', '报告编号无效', 400)
    return this.store.atomic(() => {
      this.suggestions.get(ticketId, suggestionId)
      const key = records(ticketId)(reportId)
      if (this.store.get(key) === undefined) return fail('optimization_report_missing', '核对记录不存在', 404)
      const record = this.load(ticketId, key)
      if (record.suggestionId !== suggestionId) return fail('optimization_report_missing', '核对记录不属于该建议', 404)
      return { ...this.files.read(ticketId, reportId, record.report.artifacts, query.name), suggestionId }
    })
  }
  /** 文件读取在事务外完成；保存时重新确认原建议归属，变化不会重绑报告或恢复关注。 */
  async capture(ticketId: string, suggestionId: string, input: unknown) {
    const parsed = OptimizationReportInputSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_optimization_report', '请提供有效报告目录，不允许指定提交或修改核验结论', 400)
    this.available()
    const original = this.suggestions.get(ticketId, suggestionId)
    const profile = this.profiles.get(original.suggestion.binding.profile.id, original.suggestion.binding.profile.revision).profile
    if (this.reading) return fail('optimization_report_busy', '另一份报告仍在读取，请完成后再试')
    this.reading = true
    const collected = parsed.data.retainRaw ? new Map<string, Buffer>() : undefined
    try {
      const signal = AbortSignal.any([this.host.signal, AbortSignal.timeout(30_000)])
      const result = await this.host.inspect({ directory: parsed.data.directory, format: profile.format,
        expectedCommit: original.suggestion.binding.source.commit }, signal, collected)
      if (signal.aborted) return fail('optimization_report_cancelled', '报告读取已取消或超时，未保存部分记录')
      const { adapter, bundleDigest, reportedExecution, evidence, declaredIdentity, mutationCounts, artifacts, issues } = result
      const report = ReportSchema.parse({ adapter, bundleDigest, reportedExecution, evidence, declaredIdentity,
        mutationCounts, artifacts, issues })
      const value = { schemaVersion: 1 as const, interpreterVersion: 1 as const, ticketId, suggestionId, report }
      const id = hash(value), key = records(ticketId)(id)
      return this.store.atomic(() => {
        this.available()
        const current = this.suggestions.get(ticketId, suggestionId)
        const existing = this.store.get(key)
        const receipt = existing === undefined
          ? RecordSchema.parse({ ...value, id, recordedAt: this.host.now() }) : this.load(ticketId, key)
        if (existing === undefined) {
          const previous = this.all(ticketId)
          if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > 64 * 1024 || previous.length >= 64
            || previous.filter(item => item.suggestionId === suggestionId).length >= 16
            || Buffer.byteLength(JSON.stringify([...previous, receipt]), 'utf8') > 2 * 1024 * 1024)
            return fail('optimization_report_budget', '核对记录达到保存预算，未覆盖旧记录；请评估保留容量')
          this.store.set(key, receipt)
        }
        const retained = collected ? this.files.retain(ticketId, id, receipt.report.artifacts, collected, this.host.now())
          : this.files.describe(ticketId, id, receipt.report.artifacts)
        return { created: existing === undefined, ticketId, suggestionId, receipt,
          applicability: current.applicability, assurance, retained }
      })
    } catch (error) {
      if (error instanceof QualityImportError) return fail(`optimization_report_${error.code}`, error.message, 400)
      if (error instanceof z.ZodError) return fail('optimization_report_unsupported', '报告解释结果超出支持范围或保存预算，未截断保存')
      throw error
    } finally { collected?.clear(); this.reading = false }
  }
}
