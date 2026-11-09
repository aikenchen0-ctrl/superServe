import { createHash } from 'node:crypto'
import type { Ticket } from '../core/model.ts'
import { family, record, type Family, type Key } from '../kv-key.ts'
import { inspectDevelopmentSource, InspectionError } from './inspect.ts'
import { repositoryIdentity } from './git-read.ts'
import { DevelopmentChangeSchema, DevelopmentModuleSchema, DevelopmentRelatedSchema, DevelopmentReadSchema,
  type DevelopmentChangeInput } from './change-contracts.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bounded = (value: unknown) => {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32 * 1024)
    fail('declaration_budget', '声明超过 32 KiB，请缩减重复内容；不能据此缩减验收要求', 400)
}
const normalized = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
const nested = (a: string, b: string) => {
  a = normalized(a); b = normalized(b)
  return a === '.' || a === b || b.startsWith(`${a}/`)
}
const overlap = (a: string, b: string) => nested(a, b) || nested(b, a)
type Source = Awaited<ReturnType<typeof inspectDevelopmentSource>>['source']
interface ModuleDefinition {
  schemaVersion: 1
  id: string
  revision: number
  repositoryId: string
  name: string
  paths: string[]
  contracts: { name: string; version: string }[]
  acceptance: string[]
}
interface ChangeDefinition extends Omit<DevelopmentChangeInput, 'requestId' | 'revision' | 'baseCommit'> {
  schemaVersion: 1
  ticketId: string
  revision: number
  repositoryId: string
  source: Pick<Source, 'identity' | 'objectFormat' | 'commit' | 'tree'>
}
interface Receipt { fingerprint: string; id: string; revision: number }
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  keys<V>(name: Family<V, never>): Key<V>[]
  tickets: { get(id: string): Ticket | undefined }
}
const modules = family<ModuleDefinition>('development:module:')
const moduleHistory = family<ModuleDefinition, [string, number]>('development:module-version:')
const changes = family<ChangeDefinition>('development:change:')
const changeHistory = family<ChangeDefinition, [string, number]>('development:change-version:')
const receipts = family<Receipt>('development:change-request:')
const catalogRevision = record<number>('development:change-catalog-revision')
const assertions = { compatibility: 'unassessed' as const, executionAuthorized: false as const,
  progressCaptured: false as const, candidateAccepted: false as const }

/** 变更登记与关联读取的有界拒绝；不会执行计划、写源码或授予权限。 */
export class DevelopmentChangeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}
const fail = (code: string, message: string, status = 409): never => { throw new DevelopmentChangeError(code, message, status) }

/**
 * 在现有 Store 上登记模块版本与本地 HMM 任务的变更意图。
 * 模块可关联多个任务；声明的路径/契约仅用于发现潜在关系，不是物理占用、完整依赖分析或兼容性结论。
 */
export class DevelopmentChanges {
  constructor(private readonly store: Storage, private readonly host: {
    available(): boolean
    inspect: typeof inspectDevelopmentSource
  }) {}
  private available() {
    if (!this.host.available()) fail('runtime_unavailable', '运行环境尚未就绪或正在关闭')
  }
  private task(ticketId: string) {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return fail('ticket_missing', '任务不存在', 404)
    if (ticket.executionMode !== 'hmm' || ticket.mandate.actor.source !== 'local' || ticket.mandate.basis.via !== 'operator')
      return fail('scope_denied', '变更登记只适用于本地 HMM 任务', 403)
    return ticket
  }
  private load<V extends { schemaVersion: number }>(key: Key<V>): V {
    const value = this.store.get(key)
    if (!value) return fail('development_record_missing', '开发声明不存在', 404)
    if (value.schemaVersion !== 1) return fail('schema_unsupported', '开发声明版本不受支持')
    return value
  }
  private tick() {
    const next = (this.store.get(catalogRevision) ?? 0) + 1
    if (!Number.isSafeInteger(next)) fail('revision_exhausted', '目录版本已达上限')
    this.store.set(catalogRevision, next)
  }
  private receipt(key: Key<Receipt>, fingerprint: string) {
    const prior = this.store.get(key)
    if (prior && prior.fingerprint !== fingerprint) fail('request_conflict', '请求编号已用于不同声明')
    return prior
  }
  private async inspect(path: string, revision?: string) {
    try {
      const result = await this.host.inspect({ repository: path, revision })
      if (result.observation.referenceChanged) fail('source_changed', '检查期间提交引用变化，请重新检查')
      return result
    } catch (error) {
      if (error instanceof InspectionError) return fail(error.code, error.message, 400)
      throw error
    }
  }
  /** 版本化模块定义。不是对仓库、路径或契约所有权的授权。 */
  async saveModule(input: unknown) {
    const args = DevelopmentModuleSchema.parse(input)
    this.available()
    const inspection = await this.inspect(args.repositoryPath)
    const repositoryId = repositoryIdentity(inspection.repository.commonDirectory)
    const id = hash([repositoryId, args.name])
    const { requestId, repositoryPath: _, revision, ...definition } = args
    const fingerprint = hash({ id, revision, ...definition })
    const receiptKey = receipts(hash(['module', requestId]))
    return this.store.atomic(() => {
      this.available()
      const prior = this.receipt(receiptKey, fingerprint)
      if (prior) return { created: false, module: this.load(moduleHistory(prior.id, prior.revision)) }
      const previous = this.store.get(modules(id))
      if (previous && previous.schemaVersion !== 1) return fail('schema_unsupported', '模块记录版本不受支持')
      if ((previous?.revision ?? 0) !== revision) return fail('revision_conflict', '模块声明已变化，请读取后修改')
      const value: ModuleDefinition = { schemaVersion: 1, id, repositoryId, revision: revision + 1, ...definition }
      bounded(value)
      this.store.set(moduleHistory(id, value.revision), value)
      this.store.set(modules(id), value)
      this.store.set(receiptKey, { fingerprint, id, revision: value.revision })
      this.tick()
      return { created: true, module: value }
    })
  }
  module(id: string, revision?: number) {
    return this.load(revision === undefined ? modules(id) : moduleHistory(id, revision))
  }
  /** 只读绑定真实提交；当前工作树中的未提交内容不被登记成候选。 */
  async save(ticketId: string, input: unknown) {
    const args = DevelopmentChangeSchema.parse(input)
    this.available()
    this.task(ticketId)
    const inspection = await this.inspect(args.worktreePath, args.baseCommit)
    if (!inspection.workspace) return fail('worktree_required', '变更意图需要关联已存在的工作树')
    const repositoryId = repositoryIdentity(inspection.repository.commonDirectory)
    const { requestId, revision, baseCommit: _, worktreePath: __, ...definition } = args
    const { identity, objectFormat, commit, tree } = inspection.source
    const declared = { ...definition, source: { identity, objectFormat, commit, tree },
      worktreePath: inspection.workspace.root, repositoryId }
    const fingerprint = hash({ ticketId, revision, ...declared })
    const receiptKey = receipts(hash(['change', ticketId, requestId]))
    return this.store.atomic(() => {
      this.available()
      const ticket = this.task(ticketId)
      const prior = this.receipt(receiptKey, fingerprint)
      if (prior) return { created: false, change: this.load(changeHistory(prior.id, prior.revision)), ...assertions }
      if (ticket.ended) return fail('ticket_inactive', '任务已结束，不能登记新变更意图')
      const previous = this.store.get(changes(ticketId))
      if (previous && previous.schemaVersion !== 1) return fail('schema_unsupported', '变更记录版本不受支持')
      if ((previous?.revision ?? 0) !== revision) return fail('revision_conflict', '变更意图已更新，请读取后修改')
      const definitions = args.modules.map(ref => {
        const current = this.module(ref.id)
        if (current.repositoryId !== repositoryId) return fail('repository_mismatch', '模块与工作树不属于同一本地仓库')
        if (current.revision !== ref.revision) return fail('module_changed', '模块声明已更新，请重新核对')
        return current
      })
      if ([...args.reads, ...args.writes].some(path => !definitions.some(module => module.paths.some(root => nested(root, path)))))
        return fail('scope_undeclared', '读写范围超出登记模块，请先扩展模块声明并核对影响')
      if (args.contracts.some(contract => !definitions.some(module =>
        module.contracts.some(declared => declared.name === contract.name && declared.version === contract.version))))
        return fail('contract_undeclared', '契约及版本未包含在绑定模块中，请先核对契约声明')
      const value: ChangeDefinition = { schemaVersion: 1, ticketId, revision: revision + 1, ...declared }
      bounded(value)
      this.store.set(changeHistory(ticketId, value.revision), value)
      this.store.set(changes(ticketId), value)
      this.store.set(receiptKey, { fingerprint, id: ticketId, revision: value.revision })
      this.tick()
      return { created: true, change: value, ...assertions }
    })
  }
  private view(value: ChangeDefinition) {
    const ticket = this.task(value.ticketId)
    const bindings = value.modules.map(ref => {
      const definition = this.module(ref.id, ref.revision)
      return { ...ref, name: definition.name,
        currentRevision: this.module(ref.id).revision }
    })
    return { change: value, ended: !!ticket.ended, modules: bindings,
      moduleDeclarationsChanged: bindings.some(ref => ref.revision !== ref.currentRevision), ...assertions }
  }
  get(ticketId: string, revision?: number) {
    return this.store.atomic(() => {
      this.task(ticketId)
      return this.view(this.load(revision === undefined ? changes(ticketId) : changeHistory(ticketId, revision)))
    })
  }
  /** 区分尚未登记与记录损坏；任务权限仍先由原入口核对。 */
  find(ticketId: string) {
    return this.store.atomic(() => {
      this.task(ticketId)
      return this.store.get(changes(ticketId)) === undefined ? null : this.get(ticketId)
    })
  }
  /** 总管按任务读取登记资料，模块正文仅限该任务精确绑定的历史声明；不开放任意路径。 */
  read(ticketId: string, input: unknown) {
    const args = DevelopmentReadSchema.parse(input)
    if (args.view === 'related') {
      if (args.moduleId) return fail('query_invalid', '关联查询不接受模块过滤', 400)
      return this.related(ticketId, { revision: args.revision, snapshot: args.snapshot,
        offset: args.offset, limit: args.limit })
    }
    if (args.offset !== undefined || args.limit !== undefined || args.snapshot !== undefined)
      return fail('query_invalid', '分页只适用于关联查询', 400)
    const view = this.get(ticketId, args.revision)
    if (args.view === 'module') {
      const binding = view.change.modules.find(ref => ref.id === args.moduleId)
      if (!binding) return fail('scope_denied', '只能读取该变更意图绑定的模块声明', 403)
      return this.module(binding.id, binding.revision)
    }
    if (args.moduleId) return fail('query_invalid', '模块编号仅用于模块正文读取', 400)
    const { worktreePath: _, ...change } = view.change
    return { ...view, change }
  }
  related(ticketId: string, input: unknown = {}) {
    const args = DevelopmentRelatedSchema.parse(input)
    return this.store.atomic(() => {
      this.task(ticketId)
      const current = this.load(changes(ticketId))
      const revision = this.store.get(catalogRevision) ?? 0
      if (args.revision !== undefined && args.revision !== revision) return fail('revision_conflict', '关联目录已更新，请从首页重新读取')
      const matches = this.store.keys(changes).sort().flatMap(key => {
        const other = this.load(key)
        if (other.ticketId === ticketId || other.repositoryId !== current.repositoryId) return []
        const ticket = this.store.tickets.get(other.ticketId)
        if (!ticket || ticket.executionMode !== 'hmm' || ticket.mandate.actor.source !== 'local' || ticket.mandate.basis.via !== 'operator')
          return []
        // 保留结束任务的关联并标明终态，避免一边翻页一边结束任务时改变偏移。
        const reasons: string[] = []
        if (other.modules.some(a => current.modules.some(b => a.id === b.id))) reasons.push('same_module')
        if (other.writes.some(a => current.writes.some(b => overlap(a, b)))) reasons.push('write_overlap')
        if (other.reads.some(a => current.writes.some(b => overlap(a, b)))
          || other.writes.some(a => current.reads.some(b => overlap(a, b)))) reasons.push('read_write_overlap')
        const common = current.contracts.filter(a => other.contracts.some(b => a.name === b.name))
        if (common.length) reasons.push('shared_contract')
        if (common.some(a => other.contracts.some(b => b.name === a.name && b.version !== a.version)))
          reasons.push('contract_version_difference')
        if (!reasons.length) return []
        const view = this.view(other)
        return [{ ticketId: other.ticketId, revision: other.revision, owner: other.owner, ended: !!ticket.ended,
          moduleDeclarationsChanged: view.moduleDeclarationsChanged, reasons, compatibility: 'unassessed' as const }]
      })
      const snapshot = hash({ revision, sourceRevision: current.revision, matches })
      if (args.snapshot !== undefined && args.snapshot !== snapshot)
        return fail('revision_conflict', '关联范围或任务状态已更新，请从首页重新读取')
      return { revision, sourceRevision: current.revision, total: matches.length,
        snapshot,
        items: matches.slice(args.offset, args.offset + args.limit),
        nextOffset: args.offset + args.limit < matches.length ? args.offset + args.limit : null,
        dependencyAnalysisComplete: false as const, compatibility: 'unassessed' as const }
    })
  }
}
