import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { family, type Family, type Key } from '../kv-key.ts'
import { DevelopmentChangeError, type DevelopmentChanges } from './changes.ts'
import { candidateGit, COMBINATION_POLICY, type CandidateSource } from './candidate-git.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const CandidateInputSchema = z.object({
  changeRevision: z.number().int().positive(), commit: oid, declaredComplete: z.literal(true),
  requires: z.array(digest).max(16).refine(items => new Set(items).size === items.length).default([]),
}).strict()
export const CombinationInputSchema = z.object({
  baseCommit: oid, candidates: z.array(digest).min(1).max(16).refine(items => new Set(items).size === items.length),
}).strict()
export const CandidateListSchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  snapshot: digest.optional(),
}).strict()
export type CandidateInput = z.input<typeof CandidateInputSchema>
export type CombinationInput = z.input<typeof CombinationInputSchema>
interface Candidate {
  schemaVersion: 1; id: string; ticketId: string; changeRevision: number; declarationHash: string
  repositoryPath: string; source: CandidateSource; requires: string[]; declaredComplete: true
  phase: 'recording' | 'ready'; createdAt: string
}
interface Combination {
  schemaVersion: 1; id: string; base: CandidateSource; candidates: string[]; policy: string; gitVersion: string
  repositoryPath: string; phase: 'preparing' | 'prepared' | 'conflicted'
  source?: CandidateSource; conflictIndex?: number; createdAt: string
}
type CandidatePlan = {
  state: 'ready'
  request: z.input<typeof CombinationInputSchema>
  members: { id: string; ticketId: string; purpose: string; commit: string }[]
} | { state: 'blocked'; reason: 'candidate_unavailable' | 'basis_changed' | 'dependency_unavailable' | 'dependency_limit' }
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
  keys<V>(key: Family<V, never>): Key<V>[]
}
const candidates = family<Candidate>('development:candidate:')
const combinations = family<Combination>('development:combination:')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const candidateIdentity = (value: Candidate) => hash({
  ticketId: value.ticketId, changeRevision: value.changeRevision, declarationHash: value.declarationHash,
  source: value.source, requires: value.requires, declaredComplete: value.declaredComplete,
})
const combinationIdentity = (value: Combination) => hash({
  base: value.base, candidates: value.candidates, policy: value.policy, gitVersion: value.gitVersion,
})
const fail = (code: string, message: string, status = 409): never => { throw new DevelopmentChangeError(code, message, status) }
const assurance = { validationRequired: true as const, publishAllowed: false as const, worktreeChanged: false as const }

/** 操作者显式登记完成提交；持久意图与专用 Git 引用分步对账，不提交或捕获工作区进度。 */
export class DevelopmentCandidates {
  private readonly pending = new Map<string, Promise<unknown>>()
  private stopping = false
  constructor(private readonly store: Storage, private readonly changes: Pick<DevelopmentChanges, 'get'>,
    private readonly host: { stateDir: string; available(): boolean; signal: AbortSignal }) {}
  private available() {
    if (this.stopping || !this.host.available() || this.host.signal.aborted) fail('runtime_unavailable', '运行环境未就绪或正在关闭')
  }
  /** 对象计算初期只占一个槽；相同在途请求共用结果，不创建等待队列或重复元数据目录。 */
  private async operate<T>(key: string, action: () => Promise<T>): Promise<T> {
    this.available()
    const previous = this.pending.get(key)
    if (previous) return previous as Promise<T>
    if (this.pending.size) return fail('candidate_operation_busy', '另一个候选操作正在执行，请完成后重试')
    const work = action()
    this.pending.set(key, work)
    try { return await work } finally { if (this.pending.get(key) === work) this.pending.delete(key) }
  }
  /** Runtime 先中止生命周期，再等待 Git 关闭及临时目录清理，避免关闭状态库后仍写回执。 */
  async shutdown() {
    this.stopping = true
    await Promise.allSettled([...this.pending.values()])
  }
  private candidate(id: string) {
    if (!digest.safeParse(id).success) return fail('candidate_invalid', '候选编号无效', 400)
    const value = this.store.get(candidates(id))
    if (!value) return fail('candidate_missing', '候选不存在', 404)
    if (value.schemaVersion !== 1 || value.id !== id || candidateIdentity(value) !== id
      || !['recording', 'ready'].includes(value.phase)) return fail('candidate_corrupt', '候选记录版本或身份不一致')
    this.changes.get(value.ticketId, value.changeRevision)
    return value
  }
  private async git(path: string) {
    this.available()
    const parent = join(this.host.stateDir, 'candidate-operations')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    return candidateGit(path, parent, AbortSignal.any([this.host.signal, AbortSignal.timeout(30_000)]))
  }
  private view(value: Candidate) {
    const current = this.changes.get(value.ticketId)
    return { candidate: value, declarationChanged: current.change.revision !== value.changeRevision || current.moduleDeclarationsChanged,
      taskEnded: current.ended, ...assurance, progressCaptured: false as const }
  }
  get(id: string) { return this.store.atomic(() => this.view(this.candidate(id))) }
  /** 只展开作者声明的配套依赖，不把路径重叠推断为应当合并；计划本身不产生 Git 副作用。 */
  private plan(root: Candidate): CandidatePlan {
    const members: Extract<CandidatePlan, { state: 'ready' }>['members'] = []
    const seen = new Set<string>(), visiting = new Set<string>()
    let blocked: Extract<CandidatePlan, { state: 'blocked' }>['reason'] | undefined
    const visit = (value: Candidate) => {
      if (blocked || seen.has(value.id)) return
      if (visiting.has(value.id)) { blocked = 'dependency_unavailable'; return }
      if (seen.size + visiting.size >= 16) { blocked = 'dependency_limit'; return }
      const view = this.view(value)
      if (value.phase !== 'ready' || value.source.repositoryId !== root.source.repositoryId) {
        blocked = value.id === root.id ? 'candidate_unavailable' : 'dependency_unavailable'; return
      }
      if (view.declarationChanged || view.taskEnded) { blocked = 'basis_changed'; return }
      visiting.add(value.id)
      for (const dependency of value.requires) {
        if (blocked) break
        try { visit(this.candidate(dependency)) }
        catch (error) {
          if (!(error instanceof DevelopmentChangeError)) throw error
          blocked = 'dependency_unavailable'
        }
      }
      visiting.delete(value.id)
      if (blocked) return
      seen.add(value.id)
      const declaration = this.changes.get(value.ticketId, value.changeRevision).change
      members.push({ id: value.id, ticketId: value.ticketId, purpose: declaration.purpose, commit: value.source.commit })
    }
    visit(root)
    if (blocked) return { state: 'blocked', reason: blocked }
    return { state: 'ready', request: {
      baseCommit: this.changes.get(root.ticketId, root.changeRevision).change.source.commit,
      candidates: members.map(value => value.id),
    }, members }
  }
  list(ticketId: string, input: unknown = {}) {
    const args = CandidateListSchema.parse(input)
    return this.store.atomic(() => {
      const task = this.changes.get(ticketId)
      const values = this.store.keys(candidates).filter(key => this.store.get(key)?.ticketId === ticketId)
        .map(key => this.candidate(key.slice(candidates.prefix.length))).sort((a, b) => a.id.localeCompare(b.id))
      // 快照约束目录成员与当前任务依据；依赖状态仍在每次计划读取和执行时重新核对。
      const snapshot = hash([task.change.revision, task.modules, task.ended, values])
      if (args.snapshot !== undefined && args.snapshot !== snapshot)
        return fail('candidate_catalog_changed', '候选或任务依据已变化，请从首页重新读取')
      return { ticketId, snapshot, total: values.length,
        items: values.slice(args.offset, args.offset + args.limit).map(value => ({
          ...this.view(value), purpose: this.changes.get(value.ticketId, value.changeRevision).change.purpose, plan: this.plan(value),
        })),
        nextOffset: args.offset + args.limit < values.length ? args.offset + args.limit : null }
    })
  }
  async register(ticketId: string, input: unknown) {
    const args = CandidateInputSchema.parse(input)
    return this.operate(hash(['candidate', ticketId, args]), () => this.record(ticketId, args))
  }
  private async record(ticketId: string, args: z.infer<typeof CandidateInputSchema>) {
    const view = this.changes.get(ticketId, args.changeRevision)
    if (view.ended || view.moduleDeclarationsChanged) return fail('candidate_basis_changed', '任务或模块声明已失效，不能登记新候选')
    const git = await this.git(view.change.worktreePath)
    try {
      const source = await git.commit(args.commit)
      if (source.repositoryId !== view.change.repositoryId || !await git.ancestor(view.change.source.commit, source.commit))
        return fail('candidate_basis_mismatch', '候选必须属于登记仓库并包含声明基线')
      const paths = await git.changedPaths(view.change.source.commit, source.commit)
      if (!paths.length) return fail('candidate_empty', '候选没有相对声明基线的文件改动')
      // 不将路径分离视为语义独立；这里只核对原声明的写入边界。
      const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
      if (paths.some(path => !view.change.writes.some(root =>
        root === '.' || normalize(path) === normalize(root) || normalize(path).startsWith(`${normalize(root)}/`))))
        return fail('candidate_scope', '候选包含声明写入范围以外的修改，请先核对并更新变更意图')
      const definition = { ticketId, changeRevision: args.changeRevision, declarationHash: hash(view.change),
        source, requires: [...args.requires].sort(), declaredComplete: true as const }
      const id = hash(definition)
      const value = this.store.atomic(() => {
        this.available()
        const current = this.changes.get(ticketId)
        if (current.ended || current.moduleDeclarationsChanged || hash(current.change) !== definition.declarationHash)
          return fail('candidate_basis_changed', '登记期间任务或声明变化，请按新范围核对')
        for (const required of definition.requires) {
          const dependency = this.candidate(required)
          if (dependency.phase !== 'ready' || dependency.source.repositoryId !== source.repositoryId)
            return fail('candidate_dependency', '依赖候选尚未就绪或来自其他仓库')
        }
        const previous = this.store.get(candidates(id))
        if (previous) return this.candidate(id)
        const created: Candidate = { schemaVersion: 1, id, ...definition, phase: 'recording',
          repositoryPath: view.change.worktreePath, createdAt: new Date().toISOString() }
        this.store.set(candidates(id), created)
        return created
      })
      await git.keep(`refs/superserve/candidates/${id}`, source.commit)
      await git.check()
      return this.store.atomic(() => {
        this.available()
        const next = { ...value, phase: 'ready' as const }
        this.store.set(candidates(id), next)
        return this.view(next)
      })
    } finally { await git.close() }
  }
  combination(id: string) {
    if (!digest.safeParse(id).success) return fail('combination_invalid', '组合编号无效', 400)
    const value = this.store.get(combinations(id))
    if (!value) return fail('combination_missing', '组合不存在', 404)
    if (value.schemaVersion !== 1 || value.id !== id || combinationIdentity(value) !== id
      || !['preparing', 'prepared', 'conflicted'].includes(value.phase)
      || (value.phase === 'prepared' && !value.source)) return fail('combination_corrupt', '组合记录不一致')
    const members = value.candidates.map(id => this.get(id))
    return { combination: value, basisChanged: members.some(item => item.declarationChanged || item.taskEnded), ...assurance }
  }
  async prepare(input: unknown) {
    const args = CombinationInputSchema.parse(input)
    return this.operate(hash(['combination', args]), () => this.compose(args))
  }
  private async compose(args: z.infer<typeof CombinationInputSchema>) {
    const members = args.candidates.map(id => this.candidate(id))
    const repositoryId = members[0]!.source.repositoryId
    for (const member of members) {
      const view = this.view(member)
      if (member.phase !== 'ready' || member.source.repositoryId !== repositoryId || view.declarationChanged || view.taskEnded)
        return fail('combination_basis_changed', '组合包含未就绪、跨仓或已失效候选')
      if (member.requires.some(id => !args.candidates.includes(id)))
        return fail('combination_dependency', '组合缺少候选声明的配套依赖')
    }
    const git = await this.git(members[0]!.repositoryPath)
    try {
      const base = await git.commit(args.baseCommit)
      if (base.repositoryId !== repositoryId) return fail('combination_repository', '组合仓库与候选不一致')
      for (const member of members) {
        if (JSON.stringify(await git.commit(member.source.commit)) !== JSON.stringify(member.source))
          return fail('candidate_object', '候选对象与登记内容不一致')
        await git.keep(`refs/superserve/candidates/${member.id}`, member.source.commit)
      }
      const identity = { base, candidates: args.candidates, policy: COMBINATION_POLICY, gitVersion: git.version }
      const id = hash(identity)
      const prior = this.store.atomic(() => {
        this.available()
        if (members.some(member => { const current = this.view(this.candidate(member.id)); return current.declarationChanged || current.taskEnded }))
          return fail('combination_basis_changed', '准备期间候选依据变化')
        const existing = this.store.get(combinations(id))
        if (existing) return this.combination(id).combination
        const value: Combination = { schemaVersion: 1, id, ...identity, phase: 'preparing',
          repositoryPath: members[0]!.repositoryPath, createdAt: new Date().toISOString() }
        this.store.set(combinations(id), value)
        return value
      })
      await git.keep(`refs/superserve/combination-bases/${id}`, base.commit)
      if (prior.phase === 'conflicted') return this.combination(id)
      if (prior.phase === 'prepared' && prior.source) {
        if (JSON.stringify(await git.commit(prior.source.commit)) !== JSON.stringify(prior.source))
          return fail('combination_object', '组合对象与历史回执不一致')
        await git.keep(`refs/superserve/combinations/${id}`, prior.source.commit)
        await git.check()
        return this.combination(id)
      }
      const result = await git.combine(base.commit, members.map(member => member.source.commit), id)
      if (result.state === 'prepared') await git.keep(`refs/superserve/combinations/${id}`, result.source.commit)
      await git.check()
      return this.store.atomic(() => {
        this.available()
        // 即使声明后来变化也保留真实计算结果；读取时标为失效，不沿用为放行。
        const next: Combination = { ...prior, phase: result.state,
          ...(result.state === 'prepared' ? { source: result.source } : { conflictIndex: result.conflictIndex }) }
        this.store.set(combinations(id), next)
        return this.combination(id)
      })
    } finally { await git.close() }
  }
}
