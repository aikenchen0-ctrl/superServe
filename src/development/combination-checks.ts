import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { family, type Key } from '../kv-key.ts'
import { DevelopmentChangeError, type DevelopmentChanges } from './changes.ts'
import type { DevelopmentCandidates } from './candidates.ts'
import { QualityProfileError, type DevelopmentQualityProfiles } from './quality-profiles.ts'
import { TaskQualitySourceSchema } from './quality-contracts.ts'
import { materializeCommittedSource } from './source-materialization.ts'
import { prepareAcceptanceExecution, type AcceptanceExecutionPlan } from './acceptance-execution.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const inputPolicy = 'committed-inputs-v1'
export const CombinationCheckInputSchema = TaskQualitySourceSchema.extend({
  combinationId: digest, requestId: z.string().uuid(),
}).strict()
export type CombinationCheckInput = z.input<typeof CombinationCheckInputSchema>
type Sources = Awaited<ReturnType<DevelopmentQualityProfiles['verifySources']>>
export type CombinationSourceReceipt = Omit<Sources, 'persisted'> & {
  ticketId: string; changeRevision: number; combinationId: string; requestId: string
  persisted: true; checkedAt: string
}
const MaterializationSchema = z.object({
  schemaVersion: z.literal(1), ticketId: z.string().min(1), sourceCheckId: z.string().uuid(),
  materializationId: z.string().uuid(), changeRevision: z.number().int().nonnegative(), combinationId: digest,
  profileId: z.string().min(1), profileRevision: z.number().int().nonnegative(), profileDigest: digest,
  repositoryId: digest, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  manifestDigest: digest, containerDirectory: z.string().min(1), sourceDirectory: z.string().min(1),
  outputDirectory: z.string().min(1), containerIdentity: z.string().min(1).max(200),
  sourceIdentity: z.string().min(1).max(200), outputIdentity: z.string().min(1).max(200), preparedAt: z.string().datetime(),
}).strict()
type Materialization = z.infer<typeof MaterializationSchema>
interface CheckRecord {
  schemaVersion: 1; ticketId: string; requestId: string; fingerprint: string
  inputPolicy?: string
  combinationId: string; changeRevision: number; profileId: string; profileRevision: number
  profileDigest: string; commit: string; requestedAt: string
  finishedAt?: string
  state: 'running' | 'succeeded' | 'failed'
  receipt?: CombinationSourceReceipt; receiptHash?: string; failureCode?: string
}
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
}
const records = family<CheckRecord, [string, string]>('development:combination-source-check:')
const materializations = family<Materialization, [string, string]>('development:source-materialization:')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code: string, message: string, status = 409): never => { throw new DevelopmentChangeError(code, message, status) }
async function directoryIdentity(path: string) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path))
    return fail('source_preparation_identity', '输出容器目录身份不可核验')
  return `${info.dev}:${info.ino}`
}

/** 核验固定组合来源，按可信宿主请求准备独立源码；管理接口不能上传成功或触发目录准备。 */
export class CombinationChecks {
  private active?: { key: string; fingerprint: string; done: Promise<CombinationSourceReceipt> }
  private stopping = false
  private preparing?: Promise<Awaited<ReturnType<typeof materializeCommittedSource>>>
  private readonly preparationLifetime = new AbortController()
  constructor(private readonly store: Storage, private readonly changes: Pick<DevelopmentChanges, 'get'>,
    private readonly candidates: Pick<DevelopmentCandidates, 'combination' | 'get'>,
    private readonly quality: Pick<DevelopmentQualityProfiles, 'get' | 'verifySources'>,
    private readonly available: () => boolean, private readonly defaultParentDirectory?: string) {}
  private ready() {
    if (this.stopping || !this.available()) fail('runtime_unavailable', '运行环境未就绪或正在关闭')
  }
  private basis(ticketId: string, args: Omit<CombinationCheckInput, 'requestId'>) {
    const task = this.changes.get(ticketId), combo = this.candidates.combination(args.combinationId)
    const members = combo.combination.candidates.map(id => this.candidates.get(id).candidate)
    if (task.ended || task.moduleDeclarationsChanged || task.change.revision !== args.changeRevision
      || combo.basisChanged || combo.combination.phase !== 'prepared' || !combo.combination.source)
      return fail('combination_check_stale', '组合或任务依据已失效，不能沿用核验')
    if (!members.some(member => member.ticketId === ticketId && member.changeRevision === args.changeRevision))
      return fail('combination_check_scope', '组合不包含当前任务的固定候选', 403)
    const { profile, currency } = this.quality.get(args.profileId, args.profileRevision)
    if (!task.change.modules.some(module => module.id === profile.module.id && module.revision === profile.module.revision)
      || profile.repositoryId !== combo.combination.source.repositoryId)
      return fail('combination_check_scope', '质量配置不属于该任务及组合仓库', 403)
    if (!currency.profileCurrent || !currency.moduleCurrent)
      return fail('combination_check_stale', '质量配置或模块声明已变化，请重新核对')
    return { task, profile, combo: combo.combination, source: combo.combination.source }
  }
  private load(ticketId: string, requestId: string) {
    this.changes.get(ticketId)
    const value = this.store.get(records(ticketId, z.string().uuid().parse(requestId)))
    if (!value) return fail('combination_check_missing', '核验记录不存在', 404)
    if (value.schemaVersion !== 1 || value.ticketId !== ticketId || value.requestId !== requestId
      || !['running', 'succeeded', 'failed'].includes(value.state)
      || (value.state === 'succeeded' && (!value.receipt || hash(value.receipt) !== value.receiptHash)))
      return fail('combination_check_corrupt', '核验记录不完整或内容不一致')
    return value
  }
  get(ticketId: string, requestId: string) {
    return this.store.atomic(() => {
      const value = this.load(ticketId, requestId)
      let current = false
      try {
        const basis = this.basis(ticketId, value)
        current = value.inputPolicy === inputPolicy && basis.source.commit === value.commit && basis.profile.digest === value.profileDigest
      } catch (error) {
        if (!(error instanceof DevelopmentChangeError || error instanceof QualityProfileError)) throw error
      }
      return { record: value, current,
        state: value.state === 'running' && this.active?.key !== records(ticketId, requestId) ? 'interrupted' as const : value.state,
        validationRequired: true as const, publishAllowed: false as const }
    })
  }
  async verify(ticketId: string, input: unknown): Promise<CombinationSourceReceipt> {
    const args = CombinationCheckInputSchema.parse(input), key = records(ticketId, args.requestId)
    const fingerprint = hash([ticketId, args, inputPolicy])
    this.ready()
    if (this.active) {
      if (this.active.key === key && this.active.fingerprint === fingerprint) return this.active.done
      return fail('combination_check_busy', '已有来源核验正在执行，请结束后重试')
    }
    const done = this.run(ticketId, args, fingerprint)
    this.active = { key, fingerprint, done }
    try { return await done } finally { if (this.active?.done === done) this.active = undefined }
  }
  /** 内部宿主接线：仅消费当前完整来源回执，不能自选仓库/提交/摘要。没有 HTTP 或模型入口。 */
  async prepareSource(ticketId: string, input: { sourceCheckId: string; parentDirectory?: string }) {
    const args = z.object({ sourceCheckId: z.string().uuid(), parentDirectory: z.string().min(1).max(4096).optional() }).strict().parse(input)
    const parentDirectory = args.parentDirectory ?? this.defaultParentDirectory
    if (!parentDirectory) return fail('source_preparation_parent_missing', '受控源码准备目录未配置')
    this.ready()
    if (this.preparing) return fail('source_preparation_busy', '已有源码准备进行中')
    const resolve = () => {
      this.ready()
      const checked = this.get(ticketId, args.sourceCheckId)
      const receipt = checked.record.receipt
      if (!checked.current || checked.state !== 'succeeded' || !receipt
        || receipt.verification.sourceInputs?.status !== 'tracked_content_matched')
        return fail('source_preparation_unconfirmed', '完整来源回执尚未匹配或已过期')
      return { receipt, basis: this.basis(ticketId, checked.record), record: checked.record }
    }
    const { receipt, basis } = resolve()
    const inputs = receipt.verification.sourceInputs!
    const done = materializeCommittedSource({ repositoryPath: basis.combo.repositoryPath,
      repositoryId: basis.source.repositoryId, commit: basis.source.commit, tree: basis.source.tree,
      manifestDigest: inputs.manifestDigest, parentDirectory },
    { signal: this.preparationLifetime.signal, beforePublish: () => { resolve() } })
    this.preparing = done
    try {
      const materialized = await done
      const containerIdentity = await directoryIdentity(materialized.containerDirectory)
      const sourceIdentity = await directoryIdentity(materialized.directory)
      const outputIdentity = await directoryIdentity(materialized.outputDirectory)
      const saved = this.store.atomic(() => {
        const checked = resolve()
        if (checked.receipt.requestId !== args.sourceCheckId
          || checked.receipt.combinationId !== checked.basis.combo.id
          || checked.receipt.binding.source.commit !== checked.basis.source.commit
          || checked.receipt.verification.sourceInputs?.manifestDigest !== materialized.manifestDigest)
          return fail('source_preparation_stale', '源码准备完成时固定来源已变化，未保存输出容器')
        const materialization: Materialization = {
          schemaVersion: 1, ticketId, sourceCheckId: args.sourceCheckId, materializationId: randomUUID(),
          changeRevision: checked.record.changeRevision, combinationId: checked.record.combinationId,
          profileId: checked.record.profileId, profileRevision: checked.record.profileRevision,
          profileDigest: checked.record.profileDigest, repositoryId: materialized.repositoryId,
          commit: materialized.commit, tree: materialized.tree, manifestDigest: materialized.manifestDigest,
          containerDirectory: materialized.containerDirectory, sourceDirectory: materialized.directory,
          outputDirectory: materialized.outputDirectory, containerIdentity, sourceIdentity, outputIdentity,
          preparedAt: materialized.preparedAt,
        }
        this.store.set(materializations(ticketId, args.sourceCheckId), materialization)
        return materialization
      })
      return { ...materialized, materializationId: saved.materializationId }
    } finally { if (this.preparing === done) this.preparing = undefined }
  }
  /** 只供受控报告读取；不向 HTTP 或模型暴露目录。旧目录补证不经过此回执。 */
  async preparedSource(ticketId: string, sourceCheckId: string) {
    const id = z.string().uuid().parse(sourceCheckId)
    const raw = this.store.get(materializations(ticketId, id))
    if (!raw) return null
    const value = MaterializationSchema.parse(raw)
    let current = false
    try {
      const checked = this.get(ticketId, id)
      current = checked.current && checked.state === 'succeeded'
        && checked.record.changeRevision === value.changeRevision
        && checked.record.combinationId === value.combinationId
        && checked.record.profileId === value.profileId
        && checked.record.profileRevision === value.profileRevision
        && checked.record.profileDigest === value.profileDigest
        && checked.record.receipt?.binding.source.commit === value.commit
        && checked.record.receipt.verification.sourceInputs?.manifestDigest === value.manifestDigest
    } catch (error) {
      if (!(error instanceof DevelopmentChangeError || error instanceof QualityProfileError)) throw error
    }
    if (current) {
      try {
        current = await Promise.all([
          directoryIdentity(value.containerDirectory), directoryIdentity(value.sourceDirectory), directoryIdentity(value.outputDirectory),
        ]).then(([container, source, output]) => container === value.containerIdentity && source === value.sourceIdentity
          && output === value.outputIdentity && resolve(value.sourceDirectory) === join(resolve(value.containerDirectory), 'source')
          && resolve(value.outputDirectory) === join(resolve(value.containerDirectory), 'output'))
      } catch { current = false }
    }
    return { ...value, current }
  }
  /** 仅供未来可信执行器消费；按当前组合回执生成计划，不启动命令或授予执行权。 */
  async prepareAcceptanceExecution(ticketId: string, sourceCheckId: string, checkId: string): Promise<AcceptanceExecutionPlan> {
    const checked = this.get(ticketId, sourceCheckId)
    if (!checked.current || checked.state !== 'succeeded' || !checked.record.receipt)
      return fail('acceptance_execution_source_unconfirmed', '固定来源回执未确认或已过期')
    const prepared = await this.preparedSource(ticketId, sourceCheckId)
    if (!prepared?.current) return fail('acceptance_execution_unprepared', '固定输入尚未准备或已过期')
    const check = this.basis(ticketId, checked.record).profile.checks?.find(value => value.id === checkId)
    if (!check) return fail('acceptance_execution_check_missing', '当前质量配置未登记该检查', 404)
    return prepareAcceptanceExecution(check, {
      materializationId: prepared.materializationId, sourceDirectory: prepared.sourceDirectory,
      outputDirectory: prepared.outputDirectory, sourceIdentity: prepared.sourceIdentity, outputIdentity: prepared.outputIdentity,
    })
  }
  async shutdown() {
    this.stopping = true; this.preparationLifetime.abort()
    await Promise.allSettled([this.active?.done, this.preparing])
  }
  private async run(ticketId: string, args: CombinationCheckInput, fingerprint: string): Promise<CombinationSourceReceipt> {
    const key = records(ticketId, args.requestId)
    const { basis, previous, record } = this.store.atomic(() => {
      const basis = this.basis(ticketId, args)
      const previous = this.store.get(key) ? this.load(ticketId, args.requestId) : undefined
      if (previous && previous.inputPolicy !== inputPolicy)
        return fail('combination_check_policy_changed', '历史核验未覆盖当前代码输入范围；请使用新的请求编号重新核验')
      if (previous && previous.fingerprint !== fingerprint) return fail('combination_check_reused', '请求编号已用于其他核验输入')
      const record: CheckRecord = previous ?? {
        schemaVersion: 1, inputPolicy, ticketId, requestId: args.requestId, fingerprint,
        combinationId: args.combinationId, changeRevision: args.changeRevision,
        profileId: args.profileId, profileRevision: args.profileRevision, profileDigest: basis.profile.digest,
        commit: basis.source.commit, requestedAt: new Date().toISOString(), state: 'running',
      }
      if (!previous) this.store.set(key, record)
      return { basis, previous, record }
    })
    if (previous && (previous.commit !== basis.source.commit || previous.profileDigest !== basis.profile.digest
      || (previous.receipt && (previous.receipt.binding.source.tree !== basis.source.tree
        || previous.receipt.binding.repositoryId !== basis.source.repositoryId))))
      return fail('combination_check_stale', '历史回执与当前固定输入不一致，不能重用')
    if (previous?.state === 'succeeded') return previous.receipt!
    if (previous?.state === 'failed') return fail('combination_check_failed', '该次核验已失败；重新核对后使用新的请求编号重试')
    try {
      const observed = await this.quality.verifySources({
        profileId: args.profileId, profileRevision: args.profileRevision,
        repositoryPath: basis.combo.repositoryPath, commit: basis.source.commit,
        ...(args.recipeRepositoryPath ? { recipeRepositoryPath: args.recipeRepositoryPath } : {}),
      }, 'committed-tree')
      return this.store.atomic(() => {
        this.ready()
        const latest = this.basis(ticketId, args)
        if (latest.profile.digest !== basis.profile.digest || JSON.stringify(latest.source) !== JSON.stringify(basis.source)
          || observed.binding.profile.id !== args.profileId || observed.binding.profile.revision !== args.profileRevision
          || observed.binding.profile.digest !== basis.profile.digest || observed.binding.repositoryId !== basis.source.repositoryId
          || observed.binding.source.commit !== basis.source.commit || observed.binding.source.tree !== basis.source.tree
          || observed.binding.source.objectFormat !== basis.source.objectFormat
          || observed.verification.source.commit !== basis.source.commit || observed.verification.source.tree !== basis.source.tree
          || observed.verification.sourceInputs?.scope !== 'committed-tree'
          || observed.verification.sourceInputs.tree !== basis.source.tree
          || !['tracked_content_matched', 'references_unresolved'].includes(observed.verification.status))
          return fail('combination_check_mismatch', '核验输入或回执与固定组合不一致，未保存成功结论')
        const receipt: CombinationSourceReceipt = { ...observed, ticketId, changeRevision: args.changeRevision,
          combinationId: args.combinationId, requestId: args.requestId, persisted: true, checkedAt: new Date().toISOString() }
        this.store.set(key, { ...record, state: 'succeeded', finishedAt: receipt.checkedAt, receipt, receiptHash: hash(receipt) })
        return receipt
      })
    } catch (error) {
      // 若成功已落库但响应丢失，保留成功；否则记录失败类别，不持久化路径、正文或原始异常。
      this.store.atomic(() => {
        if (this.store.get(key)?.state === 'succeeded') return
        this.store.set(key, { ...record, state: 'failed', finishedAt: new Date().toISOString(), failureCode:
          error instanceof DevelopmentChangeError || error instanceof QualityProfileError ? error.code : 'verification_unconfirmed' })
      })
      throw error
    }
  }
}
