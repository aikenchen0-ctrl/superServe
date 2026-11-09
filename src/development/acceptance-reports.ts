import { z } from 'zod'
import { DevelopmentChangeError } from './changes.ts'
import type { AcceptanceBases } from './acceptance-basis.ts'
import { qualityFiles, QualityImportError } from './quality-files.ts'
import { parseTestReport } from './test-report.ts'
import type { CombinationChecks } from './combination-checks.ts'

export const AcceptanceReportInputSchema = z.object({
  sourceCheckId: z.string().uuid(), basisDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(), checkId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  directory: z.string().trim().min(1).max(4096).optional(),
}).strict()
export type AcceptanceReportInput = z.input<typeof AcceptanceReportInputSchema>
const fail = (code: string, message: string, status = 409): never => { throw new DevelopmentChangeError(code, message, status) }
type PreparedSource = { current: boolean; outputDirectory: string }

/** 显式只读核对已登记检查的报告；不保存正文，不把外部文件提升为本次执行证据。 */
export class AcceptanceReports {
  private active?: Promise<unknown>
  private stopping = false
  constructor(private readonly bases: Pick<AcceptanceBases, 'preview'>,
    private readonly host: { available(): boolean; signal: AbortSignal;
      preparedSource?: (ticketId: string, sourceCheckId: string) => Promise<PreparedSource | null> | PreparedSource | null;
      prepareSource?: CombinationChecks['prepareSource'] }) {}
  async inspect(ticketId: string, input: unknown) {
    const args = AcceptanceReportInputSchema.parse(input)
    if (this.stopping || !this.host.available()) return fail('runtime_unavailable', '运行环境未就绪或正在关闭')
    if (this.active) return fail('acceptance_report_busy', '已有报告核对进行中，请结束后重试')
    const work = this.read(ticketId, args)
    this.active = work
    try { return await work } finally { if (this.active === work) this.active = undefined }
  }
  async shutdown() { this.stopping = true; await this.active?.catch(() => {}) }
  private async read(ticketId: string, args: AcceptanceReportInput) {
    const resolve = () => {
      const view = this.bases.preview(ticketId, { sourceCheckId: args.sourceCheckId })
      if (view.basisDigest !== args.basisDigest || view.revision !== args.revision)
        return fail('acceptance_report_stale', '依据或确认版本已变化，请重新核对')
      const check = view.mapping.checks.find(check => check.id === args.checkId)
      if (!check) return fail('acceptance_report_check_missing', '此固定配置未登记该检查', 404)
      return { view, check }
    }
    const { view, check } = resolve()
    let prepared = args.directory ? undefined : await this.host.preparedSource?.(ticketId, args.sourceCheckId)
    if (!args.directory && (!prepared || !prepared.current) && this.host.prepareSource) {
      await this.host.prepareSource(ticketId, { sourceCheckId: args.sourceCheckId })
      prepared = await this.host.preparedSource?.(ticketId, args.sourceCheckId)
    }
    if (!args.directory && (!prepared || !prepared.current))
      return fail('acceptance_report_source_unprepared', '固定输出根尚未准备或已过期，请先完成受控输入准备')
    const directory = args.directory ?? prepared!.outputDirectory
    const signal = AbortSignal.any([this.host.signal, AbortSignal.timeout(30_000)])
    const collected = new Map<string, Buffer>()
    try {
      const files = await qualityFiles(directory, signal, collected)
      const artifact = await files.raw(check.result.path)
      const data = collected.get(check.result.path)
      const report = data ? parseTestReport(data, check.result) : null
      await files.finish()
      if (signal.aborted || this.stopping || !this.host.available())
        return fail('acceptance_report_cancelled', '报告核对已取消，未返回部分结果')
      resolve()
      return { ticketId, sourceCheckId: args.sourceCheckId, basisDigest: args.basisDigest, revision: args.revision,
        combinationId: view.source.combinationId, checkId: check.id, artifact, report,
        observedAt: new Date().toISOString(), persisted: false as const,
        assurance: { contentOnly: true as const, outputRootBound: Boolean(prepared),
          executionAuthenticated: false as const,
          reportMatchesSource: false as const, coverageVerified: false as const, publishAllowed: false as const } }
    } catch (error) {
      if (error instanceof QualityImportError) return fail(`acceptance_report_${error.code}`, error.message, 400)
      throw error
    } finally { collected.clear() }
  }
}
