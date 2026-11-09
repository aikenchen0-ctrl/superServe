import { createHash } from 'node:crypto'
import { z } from 'zod'
import { family, type Family, type Key } from '../kv-key.ts'
import type { DevelopmentChanges } from './changes.ts'
import { QualityProfileError, type DevelopmentQualityProfiles } from './quality-profiles.ts'
import { TaskQualityQuerySchema, TaskQualitySourceSchema } from './quality-contracts.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1)
const text = z.string().trim().min(1).max(2000).refine(value => value.isWellFormed(), '建议文本含无效字符')
const Content = z.object({ finding: text, proposal: text, validation: text }).strict()
export const OptimizationInputSchema = TaskQualitySourceSchema.omit({ recipeRepositoryPath: true }).extend(Content.shape).strict()
export const OptimizationDecisionSchema = z.object({
  revision, action: z.enum(['defer', 'reopen']),
}).strict()
export const OptimizationQuerySchema = TaskQualityQuerySchema.safeExtend({ profileId: digest.optional() })
export type OptimizationInput = z.input<typeof OptimizationInputSchema>
export type OptimizationDecision = z.input<typeof OptimizationDecisionSchema>
export type OptimizationQuery = { offset?: number; limit?: number; snapshot?: string; profileId?: string }

const Binding = z.object({
  changeRevision: revision, scopeDigest: digest, repositoryId: digest,
  source: z.object({ commit: z.string(), tree: z.string(), identity: digest, objectFormat: z.string() }).strict(),
  module: z.object({ id: digest, revision }).strict(),
  profile: z.object({ id: digest, revision, digest }).strict(),
}).strict()
const RecordSchema = Content.extend({
  schemaVersion: z.literal(1), id: digest, ticketId: z.string().min(1), binding: Binding,
  createdAt: z.string().datetime(),
  decisions: z.array(z.object({ action: z.enum(['defer', 'reopen']), at: z.string().datetime() }).strict()).max(64),
}).strict()
type Suggestion = z.infer<typeof RecordSchema>
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
  keys<V>(key: Family<V, never>): Key<V>[]
}
const records = (ticketId: string) => family<Suggestion>(`development:optimization:${hash(ticketId)}:`)
const fail = (code: string, message: string, status = 409): never => { throw new QualityProfileError(code, message, status) }
const identity = (value: Pick<Suggestion, 'ticketId' | 'binding' | 'finding' | 'proposal' | 'validation'>) => {
  const { changeRevision: _, ...binding } = value.binding
  return hash({ ticketId: value.ticketId, binding, finding: value.finding, proposal: value.proposal, validation: value.validation })
}
const scopeDigest = (change: ReturnType<DevelopmentChanges['get']>['change']) =>
  hash({ purpose: change.purpose, reads: [...change.reads].sort(), writes: [...change.writes].sort(),
    contracts: [...change.contracts].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    acceptance: [...change.acceptance].sort() })
const assurance = { proposalOnly: true as const, evidenceVerified: false as const,
  executionAuthorized: false as const, publishAllowed: false as const }

/** 保存不可变优化建议及独立的关注记录；登记版本相同不等于建议有效或已有执行授权。 */
export class OptimizationSuggestions {
  constructor(private readonly store: Storage, private readonly changes: Pick<DevelopmentChanges, 'get'>,
    private readonly profiles: Pick<DevelopmentQualityProfiles, 'get'>,
    private readonly host: { available(): boolean; now(): string }) {}

  private available() {
    if (!this.host.available()) fail('runtime_unavailable', '运行环境尚未就绪或正在关闭')
  }
  private load(ticketId: string, id: string) {
    const raw = this.store.get(records(ticketId)(id))
    if (raw === undefined) return fail('optimization_missing', '优化建议不存在', 404)
    const parsed = RecordSchema.safeParse(raw)
    if (!parsed.success || parsed.data.ticketId !== ticketId || parsed.data.id !== id || identity(parsed.data) !== id)
      return fail('optimization_corrupt', '优化建议的版本或内容不一致，请核对持久记录')
    return parsed.data
  }
  private all(ticketId: string) {
    const group = records(ticketId)
    return this.store.keys(group).sort().map(key => this.load(ticketId, key.slice(group.prefix.length)))
  }
  private view(suggestion: Suggestion, task = this.changes.get(suggestion.ticketId)) {
    const profile = this.profiles.get(suggestion.binding.profile.id)
    const reasons: ('source_changed' | 'scope_changed' | 'module_changed' | 'profile_changed')[] = []
    if (task.change.repositoryId !== suggestion.binding.repositoryId
      || task.change.source.identity !== suggestion.binding.source.identity) reasons.push('source_changed')
    if (scopeDigest(task.change) !== suggestion.binding.scopeDigest) reasons.push('scope_changed')
    if (!task.modules.some(ref => ref.id === suggestion.binding.module.id && ref.revision === suggestion.binding.module.revision
      && ref.currentRevision === ref.revision)) reasons.push('module_changed')
    if (profile.profile.revision !== suggestion.binding.profile.revision
      || profile.profile.digest !== suggestion.binding.profile.digest) reasons.push('profile_changed')
    return { suggestion, revision: suggestion.decisions.length + 1,
      disposition: suggestion.decisions.at(-1)?.action === 'defer' ? 'deferred' as const : 'open' as const,
      applicability: { state: reasons.length ? 'needs_reassessment' as const : 'matches_registration' as const, reasons },
      taskEnded: task.ended, assurance }
  }
  private budget(ticketId: string, next: Suggestion) {
    const values = this.all(ticketId).filter(item => item.id !== next.id)
    values.push(next)
    if (values.length > 64 || Buffer.byteLength(JSON.stringify(values), 'utf8') > 256 * 1024)
      fail('optimization_budget', '本任务的建议或历史已达保存预算，请评估容量；旧建议不会自动删除')
  }
  /** 以内容和必要输入去重；重放返回原建议，不重新绑定或恢复已暂缓的事项。 */
  save(ticketId: string, input: unknown) {
    const parsed = OptimizationInputSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_optimization', '请提供完整依据版本、问题、改进建议和验证要求', 400)
    const args = parsed.data
    return this.store.atomic(() => {
      this.available()
      const historical = this.changes.get(ticketId, args.changeRevision)
      const profile = this.profiles.get(args.profileId, args.profileRevision).profile
      if (historical.change.repositoryId !== profile.repositoryId
        || !historical.change.modules.some(ref => ref.id === profile.module.id && ref.revision === profile.module.revision))
        return fail('optimization_scope_mismatch', '质量配置不属于该任务登记的模块版本')
      const binding = Binding.parse({ changeRevision: args.changeRevision, scopeDigest: scopeDigest(historical.change),
        repositoryId: historical.change.repositoryId, source: historical.change.source, module: profile.module,
        profile: { id: profile.id, revision: profile.revision, digest: profile.digest } })
      const content = { ticketId, binding, finding: args.finding, proposal: args.proposal, validation: args.validation }
      const id = identity(content)
      if (this.store.get(records(ticketId)(id)) !== undefined)
        return { created: false, ...this.view(this.load(ticketId, id)) }
      const suggestion: Suggestion = { schemaVersion: 1, ...content, id, createdAt: this.host.now(), decisions: [] }
      const view = this.view(suggestion)
      if (view.taskEnded) return fail('ticket_inactive', '任务已结束，不能登记新的优化建议')
      if (view.applicability.state !== 'matches_registration')
        return fail('optimization_basis_changed', '建议依据已变化，请核对新版本；不能直接沿用旧结论')
      this.budget(ticketId, suggestion)
      this.store.set(records(ticketId)(id), suggestion)
      return { created: true, ...view }
    })
  }
  list(ticketId: string, input: unknown = {}) {
    const args = OptimizationQuerySchema.parse(input)
    return this.store.atomic(() => {
      const task = this.changes.get(ticketId)
      const items = this.all(ticketId).filter(value => !args.profileId || value.binding.profile.id === args.profileId)
        .map(value => this.view(value, task))
      const snapshot = hash(items)
      if (args.snapshot !== undefined && args.snapshot !== snapshot)
        return fail('optimization_catalog_changed', '优化建议或依据已更新，请从首页重新读取')
      return { ticketId, snapshot, total: items.length, items: items.slice(args.offset, args.offset + args.limit),
        nextOffset: args.offset + args.limit < items.length ? args.offset + args.limit : null }
    })
  }
  /** 精确读取原建议，供只读报告观察引用；不改变关注状态。 */
  get(ticketId: string, id: string) {
    if (!digest.safeParse(id).success) return fail('invalid_optimization', '建议编号无效', 400)
    return this.store.atomic(() => {
      const task = this.changes.get(ticketId)
      return this.view(this.load(ticketId, id), task)
    })
  }
  /** 暂缓与恢复关注仅改变处理状态；保留依据、正文及所有处理事件。 */
  decide(ticketId: string, id: string, input: unknown) {
    const parsed = OptimizationDecisionSchema.safeParse(input)
    if (!digest.safeParse(id).success || !parsed.success) return fail('invalid_optimization', '建议编号、版本或处理动作无效', 400)
    const args = parsed.data
    return this.store.atomic(() => {
      this.available()
      this.changes.get(ticketId)
      const suggestion = this.load(ticketId, id)
      const currentRevision = suggestion.decisions.length + 1
      if (args.revision !== currentRevision) {
        if (args.revision < currentRevision && suggestion.decisions[args.revision - 1]?.action === args.action)
          return { changed: false, ...this.view(suggestion) }
        return fail('optimization_revision_changed', '建议处理状态已更新，请重新读取')
      }
      if ((suggestion.decisions.at(-1)?.action ?? 'reopen') === args.action)
        return { changed: false, ...this.view(suggestion) }
      if (suggestion.decisions.length >= 64) return fail('optimization_budget', '建议处理历史已达预算，不能覆盖旧记录')
      const next: Suggestion = { ...suggestion, decisions: [...suggestion.decisions, { action: args.action, at: this.host.now() }] }
      this.budget(ticketId, next)
      this.store.set(records(ticketId)(id), next)
      return { changed: true, ...this.view(next) }
    })
  }
}
