import { createHash } from 'node:crypto'
import { z } from 'zod'
import { family, type Key } from '../kv-key.ts'
import { DevelopmentChangeError, type DevelopmentChanges } from './changes.ts'
import { QualityProfileError, type DevelopmentQualityProfiles } from './quality-profiles.ts'
import type { CombinationChecks } from './combination-checks.ts'
import { acceptanceMapping } from './acceptance-checks.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const uuid = z.string().uuid()
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const text = z.string().trim().min(1).max(2000).refine(value => value.isWellFormed(), '依据说明含无效字符')
const evidence = z.object({ source: text, rationale: text }).strict()
export const AcceptanceQuerySchema = z.object({ sourceCheckId: uuid }).strict()
export const AcceptanceDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), requestId: uuid, sourceCheckId: uuid, basisDigest: digest,
    revision, evidence }).strict(),
  z.object({ action: z.literal('withdraw'), requestId: uuid, basisDigest: digest,
    revision }).strict(),
])
export type AcceptanceDecision = z.input<typeof AcceptanceDecisionSchema>
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
}
type Profile = ReturnType<DevelopmentQualityProfiles['get']>['profile']
interface Basis {
  ticketId: string; changeRevision: number
  task: { purpose: string; acceptance: string[] }
  module: { id: string; revision: number; name: string; acceptance: string[] }
  profile: Pick<Profile, 'id' | 'revision' | 'digest' | 'name' | 'recipe' | 'configuration' | 'tools' | 'environment' | 'checks'>
}
const EventSchema = z.object({
  requestId: uuid, sourceCheckId: uuid, fingerprint: digest, at: z.string().datetime(),
  action: z.enum(['confirm', 'withdraw']), evidence: evidence.optional(),
}).strict().refine(value => (value.action === 'confirm') === (value.evidence !== undefined))
type Event = z.infer<typeof EventSchema>
interface RecordValue { schemaVersion: 1; basis: Basis; events: Event[]; integrity: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const records = (ticketId: string) => family<RecordValue>(`development:acceptance:${hash(ticketId)}:`)
const requests = (ticketId: string) => family<{ basisDigest: string; fingerprint: string }>(`development:acceptance-request:${hash(ticketId)}:`)
const fail = (code: string, message: string, status = 409): never => { throw new DevelopmentChangeError(code, message, status) }
const assurance = { operatorDeclarationOnly: true as const, independentReviewerAuthenticated: false as const,
  coverageVerified: false as const, executionAuthorized: false as const, publishAllowed: false as const }

/** 记录本机操作者对既有验收依据的确认；不认证审查身份，不修改要求，不授予执行或发布权限。 */
export class AcceptanceBases {
  constructor(private readonly store: Storage, private readonly changes: Pick<DevelopmentChanges, 'get' | 'module'>,
    private readonly profiles: Pick<DevelopmentQualityProfiles, 'get'>, private readonly checks: Pick<CombinationChecks, 'get'>,
    private readonly available: () => boolean) {}
  private basis(ticketId: string, profileId: string, profileRevision: number): Basis {
    const task = this.changes.get(ticketId)
    const { profile, currency } = this.profiles.get(profileId, profileRevision)
    if (task.ended || task.moduleDeclarationsChanged || !currency.profileCurrent || !currency.moduleCurrent)
      return fail('acceptance_stale', '任务、模块或质量配置已变化，请重新核对验收依据')
    if (!task.change.modules.some(value => value.id === profile.module.id && value.revision === profile.module.revision)
      || task.change.repositoryId !== profile.repositoryId)
      return fail('acceptance_scope', '质量配置不属于当前任务的模块版本', 403)
    const module = this.changes.module(profile.module.id, profile.module.revision)
    return { ticketId, changeRevision: task.change.revision,
      task: { purpose: task.change.purpose, acceptance: task.change.acceptance },
      module: { id: module.id, revision: module.revision, name: module.name, acceptance: module.acceptance },
      profile: { id: profile.id, revision: profile.revision, digest: profile.digest, name: profile.name,
        recipe: profile.recipe, configuration: profile.configuration, tools: profile.tools, environment: profile.environment,
        ...(profile.checks !== undefined ? { checks: profile.checks } : {}) } }
  }
  private load(ticketId: string, id: string) {
    const value = this.store.get(records(ticketId)(id))
    if (!value) return undefined
    if (value.schemaVersion !== 1 || value.basis?.ticketId !== ticketId || hash(value.basis) !== id
      || !z.array(EventSchema).min(1).max(64).safeParse(value.events).success
      || new Set(value.events.map(event => event.requestId)).size !== value.events.length
      || value.integrity !== hash({ basis: value.basis, events: value.events }))
      return fail('acceptance_corrupt', '验收依据记录的版本或内容不一致')
    return value
  }
  private view(basis: Basis, value?: RecordValue) {
    const latest = value?.events.at(-1)
    return { basis, basisDigest: hash(basis), revision: value?.events.length ?? 0,
      state: latest?.action === 'confirm' ? 'confirmed' as const : latest ? 'withdrawn' as const : 'unconfirmed' as const,
      events: value?.events ?? [], assurance,
      mapping: acceptanceMapping(basis.task.acceptance, basis.module.acceptance, basis.profile.checks) }
  }
  /** 从服务端来源回执解析规则，客户端不能替换验收要求、模块或配方版本。 */
  preview(ticketId: string, input: unknown) {
    const { sourceCheckId } = AcceptanceQuerySchema.parse(input)
    return this.store.atomic(() => {
      const checked = this.checks.get(ticketId, sourceCheckId)
      const receipt = checked.record.receipt
      if (!checked.current || checked.state !== 'succeeded' || !receipt)
        return fail('acceptance_source_unconfirmed', '来源回执未确认或已过期，请先重新核验固定组合')
      const basis = this.basis(ticketId, receipt.binding.profile.id, receipt.binding.profile.revision)
      if (basis.changeRevision !== receipt.changeRevision || basis.profile.digest !== receipt.binding.profile.digest)
        return fail('acceptance_stale', '来源回执与当前验收依据不一致')
      return { ...this.view(basis, this.load(ticketId, hash(basis))),
        source: { requestId: sourceCheckId, combinationId: receipt.combinationId, commit: receipt.binding.source.commit,
          referencesUnresolved: receipt.verification.status === 'references_unresolved' },
        scope: 'task-and-selected-module' as const }
    })
  }
  /** 历史记录可读取，当前适用性另行核对；历史确认不会绕过新来源核验。 */
  get(ticketId: string, id: string) {
    digest.parse(id)
    return this.store.atomic(() => {
      this.changes.get(ticketId)
      const value = this.load(ticketId, id)
      if (!value) return fail('acceptance_missing', '验收依据记录不存在', 404)
      let current = false
      try { current = hash(this.basis(ticketId, value.basis.profile.id, value.basis.profile.revision)) === id }
      catch (error) {
        if (!(error instanceof DevelopmentChangeError || error instanceof QualityProfileError)) throw error
      }
      return { ...this.view(value.basis, value), current }
    })
  }
  decide(ticketId: string, input: unknown) {
    const args = AcceptanceDecisionSchema.parse(input), fingerprint = hash(args)
    return this.store.atomic(() => {
      if (!this.available()) return fail('runtime_unavailable', '运行环境未就绪或正在关闭')
      this.changes.get(ticketId)
      const requestKey = requests(ticketId)(args.requestId), previous = this.store.get(requestKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.basisDigest !== args.basisDigest)
          return fail('acceptance_request_conflict', '请求编号已用于其他验收决定')
        const stored = this.load(ticketId, args.basisDigest)
        if (!stored?.events.some(event => event.requestId === args.requestId && event.fingerprint === fingerprint))
          return fail('acceptance_corrupt', '请求回执与验收历史不一致')
        return { changed: false, ...this.get(ticketId, args.basisDigest) }
      }
      const preview = args.action === 'confirm' ? this.preview(ticketId, { sourceCheckId: args.sourceCheckId })
        : this.get(ticketId, args.basisDigest)
      if (preview.basisDigest !== args.basisDigest || preview.revision !== args.revision)
        return fail('acceptance_changed', '验收依据或决定已变化，请重新读取后确认')
      if (args.action === 'withdraw' && preview.state !== 'confirmed')
        return fail('acceptance_not_confirmed', '当前没有可撤回的确认')
      const event: Event = { requestId: args.requestId,
        sourceCheckId: args.action === 'confirm' ? args.sourceCheckId : preview.events.at(-1)!.sourceCheckId,
        fingerprint, at: new Date().toISOString(), action: args.action,
        ...(args.action === 'confirm' ? { evidence: args.evidence } : {}) }
      const events = [...preview.events, event], body = { basis: preview.basis, events }
      // 确认必须给一次撤回保留空间，存储上限不能把决定变成不可撤销。
      const countLimit = args.action === 'confirm' ? 63 : 64
      const byteLimit = 128 * 1024 - (args.action === 'confirm' ? 1024 : 0)
      if (events.length > countLimit || Buffer.byteLength(JSON.stringify(body)) > byteLimit)
        return fail('acceptance_budget', '验收依据历史达到存储预算；不会删除旧决定或缩减验收')
      this.store.set(records(ticketId)(args.basisDigest), { schemaVersion: 1, ...body, integrity: hash(body) })
      this.store.set(requestKey, { basisDigest: args.basisDigest, fingerprint })
      return { changed: true, ...this.get(ticketId, args.basisDigest) }
    })
  }
}
