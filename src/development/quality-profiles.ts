import { createHash } from 'node:crypto'
import { z } from 'zod'
import { family, type Family, type Key } from '../kv-key.ts'
import type { DevelopmentChanges } from './changes.ts'
import { inspectDevelopmentSource, InspectionError } from './inspect.ts'
import { QualityBindingInputSchema, QualityDefinitionSchema, QualityProfileInputSchema, QualitySourceInputSchema, QualityToolInputSchema,
  TaskQualityQuerySchema, TaskQualitySourceSchema } from './quality-contracts.ts'
import { QualitySourceError, type verifyQualitySources } from './quality-sources.ts'
import { QualityToolError, type verifyQualityTools } from './quality-tools.ts'
import { repositoryIdentity } from './git-read.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const idSchema = z.string().regex(/^[a-f0-9]{64}$/)
const RecordSchema = QualityDefinitionSchema.extend({
  schemaVersion: z.literal(1), id: idSchema, repositoryId: idSchema, digest: idSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
}).strict()
type Profile = z.infer<typeof RecordSchema>
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
  keys<V>(key: Family<V, never>): Key<V>[]
}
interface Receipt { fingerprint: string; id: string; revision: number }
const current = family<Profile>('development:quality-profile:')
const history = family<Profile, [string, number]>('development:quality-profile-version:')
const receipts = family<Receipt>('development:quality-profile-request:')
const assurance = { configurationOnly: true as const, toolsVerified: false as const, recipeVerified: false as const,
  configurationVerified: false as const, inputClosureVerified: false as const,
  executionAuthorized: false as const, candidateAccepted: false as const, publishAllowed: false as const }
const digest = (profile: Omit<Profile, 'id' | 'revision' | 'digest'>) => hash(profile)
const content = ({ id: _, revision: __, digest: ___, ...value }: Profile) => value

/** 质量配置边界的固定错误；不返回路径、报告正文或工具执行参数。 */
export class QualityProfileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}
const fail = (code: string, message: string, status = 409): never => {
  throw new QualityProfileError(code, message, status)
}

/** 复用模块版本与现有 Store，登记配置并预览固定输入；不拥有工具安装、调度或执行权。 */
export class DevelopmentQualityProfiles {
  constructor(private readonly store: Storage, private readonly modules: Pick<DevelopmentChanges, 'module' | 'find' | 'get'>,
    private readonly host: { available(): boolean; inspect: typeof inspectDevelopmentSource;
      verifySources: typeof verifyQualitySources; verifyTools: typeof verifyQualityTools }) {}

  private available() {
    if (!this.host.available()) fail('runtime_unavailable', '运行环境尚未就绪或正在关闭')
  }
  private load(key: Key<Profile>) {
    const raw = this.store.get(key)
    if (raw === undefined) return fail('quality_profile_missing', '质量配置不存在', 404)
    const parsed = RecordSchema.safeParse(raw)
    if (!parsed.success) return fail('quality_profile_unsupported', '质量配置记录版本或内容不受支持')
    const profile = parsed.data
    if (profile.digest !== digest(content(profile))
      || profile.id !== hash([profile.repositoryId, profile.module.id, profile.name])
      || (key !== current(profile.id) && key !== history(profile.id, profile.revision)))
      return fail('quality_profile_corrupt', '质量配置身份或摘要不一致，请核对持久记录')
    return profile
  }
  private view(profile: Profile) {
    const latest = this.load(current(profile.id))
    const module = this.modules.module(profile.module.id)
    return { profile, currency: {
      profileCurrent: latest.revision === profile.revision && latest.digest === profile.digest,
      moduleCurrent: module.revision === profile.module.revision && module.repositoryId === profile.repositoryId,
    }, assurance }
  }
  private required(id: string, revision: number) {
    const value = this.view(this.load(history(id, revision)))
    if (!value.currency.profileCurrent) return fail('quality_profile_changed', '质量配置已更新，请读取新版本后重新绑定')
    if (!value.currency.moduleCurrent) return fail('quality_module_changed', '模块或验收声明已更新，请重新核对质量配置')
    return value.profile
  }
  /** 同一请求可重放；新增版本必须同时匹配当前配置与模块版本。 */
  save(input: unknown) {
    const parsed = QualityProfileInputSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_quality_profile', '质量配置字段、版本、路径或工具声明无效', 400)
    this.available()
    const { requestId, revision, ...definition } = parsed.data
    if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 32 * 1024)
      return fail('quality_profile_budget', '质量配置超过 32 KiB，请缩减重复元数据；不能据此缩小验收', 400)
    return this.store.atomic(() => {
      this.available()
      const module = this.modules.module(definition.module.id, definition.module.revision)
      for (const check of definition.checks ?? []) {
        if (!definition.tools.some(tool => tool.name === check.command.tool))
          return fail('quality_check_tool_missing', '检查引用了未登记的工具', 400)
        if (check.requirements.some(ref => ref.scope === 'module' && module.acceptance[ref.index] !== ref.text))
          return fail('quality_check_requirement_mismatch', '检查引用的模块要求与固定版本不一致', 400)
      }
      const id = hash([module.repositoryId, module.id, definition.name])
      const fingerprint = hash({ id, revision, definition })
      const key = receipts(hash(requestId)), receipt = this.store.get(key)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) return fail('request_conflict', '请求编号已用于不同质量配置')
        return { created: false, ...this.view(this.load(history(receipt.id, receipt.revision))) }
      }
      const latestModule = this.modules.module(module.id)
      if (latestModule.revision !== module.revision || latestModule.repositoryId !== module.repositoryId)
        return fail('quality_module_changed', '模块声明已更新，请先核对新范围及验收')
      const previous = this.store.get(current(id)) === undefined ? undefined : this.load(current(id))
      if ((previous?.revision ?? 0) !== revision) return fail('revision_conflict', '质量配置版本已变化，请读取后修改')
      const value = { ...definition, schemaVersion: 1 as const, repositoryId: module.repositoryId }
      const profile: Profile = { ...value, id, revision: revision + 1, digest: digest(value) }
      const versionKey = history(id, profile.revision)
      if (this.store.get(versionKey) !== undefined)
        return fail('quality_profile_corrupt', '历史质量配置已存在，不能覆盖；请核对当前版本指针')
      this.store.set(versionKey, profile)
      this.store.set(current(id), profile)
      this.store.set(key, { fingerprint, id, revision: profile.revision })
      return { created: true, ...this.view(profile) }
    })
  }
  get(id: string, revision?: number) {
    if (!idSchema.safeParse(id).success || (revision !== undefined
      && (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER)))
      return fail('invalid_quality_profile', '质量配置标识或版本无效', 400)
    return this.store.atomic(() => this.view(this.load(revision === undefined ? current(id) : history(id, revision))))
  }
  /** 按需投影任务关联配置，不读取本机文件，不把目录查询提升为执行授权。 */
  forTask(ticketId: string, input: unknown = {}) {
    const args = TaskQualityQuerySchema.parse(input)
    return this.store.atomic(() => {
      const task = this.modules.find(ticketId)
      if (!task) return { state: 'unregistered' as const }
      const { change } = task
      const items = this.store.keys(current).sort().flatMap(key => {
        const profile = this.load(key)
        const module = task.modules.find(ref => ref.id === profile.module.id)
        if (!module || profile.repositoryId !== change.repositoryId) return []
        const applicable = module.revision === module.currentRevision && profile.module.revision === module.revision
        return [{ id: profile.id, revision: profile.revision, digest: profile.digest, name: profile.name,
          moduleName: module.name, format: profile.format, configurationPath: profile.configuration.path,
          applicable, recipeRepositoryRequired: profile.recipe.repositoryId !== change.repositoryId }]
      })
      const snapshot = hash([change.revision, change.source.identity, task.modules, items])
      if (args.snapshot !== undefined && args.snapshot !== snapshot)
        return fail('quality_catalog_changed', '任务或质量配置已更新，请重新读取后核验')
      return { state: 'registered' as const, ticketId, changeRevision: change.revision,
        source: change.source, snapshot, total: items.length,
        items: items.slice(args.offset, args.offset + args.limit),
        nextOffset: args.offset + args.limit < items.length ? args.offset + args.limit : null }
    })
  }
  /** 从任务登记解析固定输入，禁止客户端替换提交或目标目录；核验后再次检查绑定。 */
  async verifyTaskSources(ticketId: string, input: unknown) {
    const parsed = TaskQualitySourceSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_quality_binding', '任务来源核验参数无效', 400)
    const args = parsed.data
    const resolve = () => {
      const task = this.modules.get(ticketId)
      if (task.change.revision !== args.changeRevision)
        return fail('quality_change_changed', '任务登记已更新，请重新读取后核验')
      const profile = this.required(args.profileId, args.profileRevision)
      if (task.change.repositoryId !== profile.repositoryId
        || !task.change.modules.some(ref => ref.id === profile.module.id && ref.revision === profile.module.revision))
        return fail('quality_task_mismatch', '质量配置不适用于当前任务绑定的模块版本')
      return task.change
    }
    this.available()
    const change = this.store.atomic(resolve)
    const result = await this.verifySources({ profileId: args.profileId, profileRevision: args.profileRevision,
      repositoryPath: change.worktreePath, commit: change.source.commit,
      ...(args.recipeRepositoryPath ? { recipeRepositoryPath: args.recipeRepositoryPath } : {}) })
    return this.store.atomic(() => {
      resolve()
      return { ticketId, changeRevision: change.revision, ...result }
    })
  }
  /** 只读固定提交。配置与工具摘要仍是声明，结果不能交给执行器当作执行许可。 */
  async preview(input: unknown) {
    const parsed = QualityBindingInputSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_quality_binding', '请指定质量配置版本、仓库和完整提交标识', 400)
    const args = parsed.data
    this.available()
    const profile = this.store.atomic(() => this.required(args.profileId, args.profileRevision))
    let inspected: Awaited<ReturnType<typeof inspectDevelopmentSource>>
    try { inspected = await this.host.inspect({ repository: args.repositoryPath, revision: args.commit }) }
    catch (error) {
      if (error instanceof InspectionError) return fail(error.code, error.message, 400)
      return fail('quality_inspection_failed', '固定输入检查失败，未生成绑定', 400)
    }
    const common = inspected.repository.commonDirectory
    const repositoryId = repositoryIdentity(common)
    if (repositoryId !== profile.repositoryId) return fail('quality_repository_mismatch', '固定输入不属于质量配置登记的仓库')
    if (inspected.observation.referenceChanged || inspected.source.commit !== args.commit)
      return fail('quality_source_changed', '检查期间输入身份变化，请重新核对固定提交')
    return this.completeBinding(profile, inspected.source)
  }
  /** 固定提交中的配置及配方字节核对；不证明配方依赖闭合、工具兼容或执行授权。 */
  async verifySources(input: unknown, scope: 'selected' | 'committed-tree' = 'selected') {
    const parsed = QualitySourceInputSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_quality_binding', '固定来源核验参数无效', 400)
    const args = parsed.data
    this.available()
    const profile = this.store.atomic(() => this.required(args.profileId, args.profileRevision))
    if (!args.recipeRepositoryPath && profile.recipe.repositoryId !== profile.repositoryId)
      return fail('quality_recipe_path_required', '配方来自其他仓库，请显式指定该仓库目录', 400)
    let verification: Awaited<ReturnType<typeof verifyQualitySources>>
    try {
      verification = await this.host.verifySources({
        target: { repositoryPath: args.repositoryPath, repositoryId: profile.repositoryId,
          commit: args.commit, configuration: profile.configuration,
          ...(scope === 'committed-tree' ? { scope } : {}) },
        recipe: { ...profile.recipe, repositoryPath: args.recipeRepositoryPath ?? args.repositoryPath },
      })
    } catch (error) {
      if (error instanceof QualitySourceError) return fail(error.code, error.message)
      if (error instanceof InspectionError) return fail(error.code, error.message, 400)
      return fail('quality_source_failed', '固定来源核验失败，未保存部分结果', 400)
    }
    return { ...this.completeBinding(profile, verification.source), verification }
  }
  /** 文件位置仅用于本次本机只读核验；不保存宿主路径或授予执行权。 */
  async verifyTools(input: unknown) {
    const parsed = QualityToolInputSchema.safeParse(input)
    if (!parsed.success) return fail('invalid_tool_request', '工具核验参数或版本无效', 400)
    const args = parsed.data
    this.available()
    const profile = this.store.atomic(() => this.required(args.profileId, args.profileRevision))
    let verification: Awaited<ReturnType<typeof verifyQualityTools>>
    try { verification = await this.host.verifyTools({ tools: profile.tools, locations: args.locations }) }
    catch (error) {
      if (error instanceof QualityToolError) return fail(error.code, error.message, 400)
      return fail('quality_tool_failed', '工具内容核验失败，未保存部分结果', 400)
    }
    return this.store.atomic(() => {
      this.available()
      const latest = this.required(profile.id, profile.revision)
      if (latest.digest !== profile.digest) return fail('quality_profile_changed', '工具核验期间配置变化')
      const binding = { profileId: profile.id, profileRevision: profile.revision, profileDigest: profile.digest,
        observationDigest: verification.observationDigest }
      return { binding, bindingDigest: hash(binding), verification, persisted: false as const, assurance }
    })
  }
  private completeBinding(profile: Profile, source: Pick<Awaited<ReturnType<typeof inspectDevelopmentSource>>['source'],
    'commit' | 'tree' | 'identity' | 'objectFormat'>) {
    return this.store.atomic(() => {
      this.available()
      const latest = this.required(profile.id, profile.revision)
      if (latest.digest !== profile.digest) return fail('quality_profile_changed', '检查期间质量配置发生变化')
      const { commit, tree, identity, objectFormat } = source
      const binding = { schemaVersion: 1 as const, profile: { id: profile.id, revision: profile.revision, digest: profile.digest },
        module: profile.module, repositoryId: profile.repositoryId, source: { commit, tree, identity, objectFormat } }
      return { binding, bindingDigest: hash(binding), sourceScope: 'committed-tree-only' as const,
        persisted: false as const, currentProgressCaptured: false as const, assurance }
    })
  }
}
