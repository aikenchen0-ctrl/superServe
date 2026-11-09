import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { family, record, type Family, type Key } from '../kv-key.ts'

const identity = z.string().trim().min(1).max(160)
const duration = z.number().int().min(1).max(86_400_000)
export const ReserveWorkspaceSchema = z.object({
  path: z.string().min(1).max(4096),
  owner: identity,
  requestId: identity,
  leaseMs: duration,
}).strict()
export const WorkspaceBindingSchema = z.object({
  workspaceId: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
export const WorkspaceCommandSchema = z.discriminatedUnion('action', [
  WorkspaceBindingSchema.extend({ action: z.literal('renew'), leaseMs: duration }).strict(),
  WorkspaceBindingSchema.extend({ action: z.literal('cancel') }).strict(),
  WorkspaceBindingSchema.extend({ action: z.literal('abandon') }).strict(),
])
export const WorkspaceListSchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict()
export type WorkspaceBinding = z.infer<typeof WorkspaceBindingSchema>
export type WorkspaceExecutionBinding = WorkspaceBinding & { executionId: string }
export type WorkspaceRequest = z.input<typeof ReserveWorkspaceSchema>
export type WorkspaceCommand = z.input<typeof WorkspaceCommandSchema>

type Phase = 'reserved' | 'running' | 'cancelling' | 'released'
interface DirectoryIdentity { path: string; fileId: string }
interface Workspace extends DirectoryIdentity, WorkspaceBinding {
  schemaVersion: 1
  owner: string
  phase: Phase
  expiresAt: number
  execution?: { id: string; supervisorId: string; launch?: 'prepared' | 'issued' | 'retired' }
}
interface RequestReceipt extends WorkspaceBinding, DirectoryIdentity {
  owner: string
  leaseMs: number
}
interface Storage {
  atomic<T>(action: () => T): T
  afterCommit(action: () => void): void
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  keys<V>(name: Family<V, never>): Key<V>[]
}
const slots = family<Workspace>('development:workspace:')
const requests = family<RequestReceipt>('development:workspace-request:')
const supervisor = record<string>('development:workspace-supervisor')
const hash = (...values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
const inside = (parent: string, child: string) => {
  const rel = relative(pathKey(parent), pathKey(child))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
const overlaps = (a: DirectoryIdentity, b: DirectoryIdentity) =>
  a.fileId === b.fileId || inside(a.path, b.path) || inside(b.path, a.path)

/** 管理端可识别的占用拒绝；不将 OS 错误或绝对输入正文回显给模型。 */
export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}
const fail = (code: string, message: string, status = 409): never => { throw new WorkspaceError(code, message, status) }

async function directory(path: string): Promise<DirectoryIdentity> {
  if (!isAbsolute(path)) return fail('path_invalid', '工作区必须是已存在的绝对目录', 400)
  try {
    const canonical = await realpath(path)
    const information = await stat(canonical, { bigint: true })
    if (!information.isDirectory() || information.ino === 0n)
      return fail('path_invalid', '工作区不是可识别的目录', 400)
    return { path: resolve(canonical), fileId: `${information.dev}:${information.ino}` }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    return fail('path_unavailable', '工作区无法读取，未取得占用', 400)
  }
}

/**
 * 单控制面下持久保存目录占用与执行代次。
 * 过期、取消和重启都不代表外部写者已停止；启动及结束确认只提供给可信执行宿主，
 * 不提供进程管理、OS 隔离或基于 PID 的停止推断。
 */
export class DevelopmentWorkspaces {
  private readonly supervisorId = randomUUID()
  private readonly cancellationListeners = new Set<(binding: WorkspaceBinding) => void>()
  constructor(private readonly store: Storage, private readonly available: () => boolean,
    private readonly now = Date.now) {
    store.atomic(() => { store.set(supervisor, this.supervisorId) })
  }
  private assertSupervisor() {
    if (!this.available()) fail('runtime_unavailable', '运行环境未就绪或正在关闭')
    this.assertAuthority()
  }
  private assertAuthority() {
    if (this.store.get(supervisor) !== this.supervisorId)
      fail('supervisor_stale', '旧控制实例不能继续操作工作区')
  }
  private load(id: string) {
    const value = this.store.get(slots(id))
    if (!value) return fail('workspace_missing', '工作区记录不存在', 404)
    if (value.schemaVersion !== 1) return fail('schema_unsupported', '工作区记录版本不受支持')
    return value
  }
  private current(binding: WorkspaceBinding) {
    const value = this.load(binding.workspaceId)
    if (value.generation !== binding.generation || value.operationId !== binding.operationId)
      return fail('operation_stale', '执行代次已变化，不能操作当前占用')
    return value
  }
  private view(value: Workspace) {
    const { fileId: _, schemaVersion: __, execution, ...publicFields } = value
    return { ...publicFields, expired: value.phase !== 'released' && this.now() >= value.expiresAt,
      recoveryRequired: !!execution && value.phase !== 'released' && execution.supervisorId !== this.supervisorId }
  }
  get(id: string) { return this.view(this.load(id)) }
  /** 关闭及恢复可在运行环境未就绪时执行，但不能由旧控制实例改变新实例的许可。 */
  assertControl() { this.assertAuthority() }
  activeExecutions(): WorkspaceExecutionBinding[] {
    this.assertAuthority()
    return this.store.keys(slots).flatMap(key => {
      const value = this.load(key.slice(slots.prefix.length))
      return value.phase !== 'released' && value.execution
        ? [{ workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
          executionId: value.execution.id }] : []
    })
  }
  /** 只用于宿主作业接线；取消提交后再通知，事务回滚不得触发外部动作。 */
  onCancel(listener: (binding: WorkspaceBinding) => void) {
    this.cancellationListeners.add(listener)
    return () => { this.cancellationListeners.delete(listener) }
  }
  /** 观测允许已过期或取消的执行，仍要求当前宿主和精确代次。 */
  assertExecutionOwner(input: WorkspaceBinding & { executionId: string }) {
    // 关闭期间仍需保存结束观测；新启动由 assertCurrent 另行限制。
    this.assertAuthority()
    const value = this.current(input)
    if (value.execution?.id !== input.executionId || value.execution.supervisorId !== this.supervisorId)
      fail('execution_stale', '不是当前宿主登记的执行，不能更新观测')
  }
  list(input: unknown = {}) {
    const { offset, limit } = WorkspaceListSchema.parse(input)
    const keys = this.store.keys(slots).sort()
    return { items: keys.slice(offset, offset + limit).map(key => this.view(this.load(key.slice(slots.prefix.length)))),
      nextOffset: offset + limit < keys.length ? offset + limit : null }
  }
  async reserve(input: unknown) {
    const args = ReserveWorkspaceSchema.parse(input)
    this.assertSupervisor()
    const target = await directory(args.path)
    return this.store.atomic(() => {
      this.assertSupervisor()
      const receiptKey = requests(hash(args.requestId))
      const previous = this.store.get(receiptKey)
      if (previous) {
        if (previous.owner !== args.owner || pathKey(previous.path) !== pathKey(target.path)
          || previous.fileId !== target.fileId || previous.leaseMs !== args.leaseMs)
          return fail('request_conflict', '请求编号已用于另一组占用条件')
        // 成功重放仅返回原占用；不能借重放重开已结束的操作或代替续期。
        return this.view(this.current(previous))
      }
      const all = this.store.keys(slots).map(key => this.load(key.slice(slots.prefix.length)))
      if (all.some(value => value.phase !== 'released' && overlaps(value, target)))
        return fail('workspace_busy', '该目录或登记父子目录仍被占用，过期或取消不能自动释放')
      const workspaceId = hash(target.fileId)
      const last = this.store.get(slots(workspaceId))
      if (last && last.generation >= Number.MAX_SAFE_INTEGER) return fail('generation_exhausted', '执行代次已达上限')
      const value: Workspace = { ...target, schemaVersion: 1, workspaceId,
        owner: args.owner, operationId: randomUUID(), generation: (last?.generation ?? 0) + 1,
        phase: 'reserved', expiresAt: this.now() + args.leaseMs }
      this.store.set(slots(workspaceId), value)
      this.store.set(receiptKey, { ...target, workspaceId, operationId: value.operationId,
        generation: value.generation, owner: args.owner, leaseMs: args.leaseMs })
      return this.view(value)
    })
  }
  command(input: unknown) {
    const args = WorkspaceCommandSchema.parse(input)
    return this.store.atomic(() => {
      this.assertSupervisor()
      const value = this.current(args)
      if (args.action === 'renew') {
        if (value.phase === 'released' || value.phase === 'cancelling' || this.now() >= value.expiresAt)
          return fail('operation_inactive', '结束、取消或已过期的占用不能续期')
        if (value.execution && value.execution.supervisorId !== this.supervisorId)
          return fail('recovery_required', '旧宿主执行仍需核验，不能靠续期恢复')
        value.expiresAt = Math.max(value.expiresAt, this.now() + args.leaseMs)
      } else if (args.action === 'cancel') {
        if (value.phase !== 'released') value.phase = 'cancelling'
      } else {
        if (value.execution) return fail('execution_unconfirmed', '已登记启动的占用只能由执行宿主核验结束')
        value.phase = 'released'
      }
      this.store.set(slots(value.workspaceId), value)
      if (args.action === 'cancel' && value.execution && value.phase !== 'released') {
        const binding = { workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation }
        this.store.afterCommit(() => { for (const listener of this.cancellationListeners) listener(binding) })
      }
      return this.view(value)
    })
  }
  /** 兼容原宿主入口：返回即可能调用外部进程，不能当作未发许可的准备状态回收。 */
  begin(input: WorkspaceBinding, register?: (execution: WorkspaceExecutionBinding) => void) {
    return this.registerExecution(input, 'issued', register)
  }
  /** 仅登记执行意图；调用方必须另行提交 issueLaunch 才能调用外部提供方。 */
  prepare(input: WorkspaceBinding, register?: (execution: WorkspaceExecutionBinding) => void) {
    return this.registerExecution(input, 'prepared', register)
  }
  private async registerExecution(input: WorkspaceBinding, launch: 'prepared' | 'issued',
    register?: (execution: WorkspaceExecutionBinding) => void) {
    const binding = WorkspaceBindingSchema.parse(input)
    this.assertSupervisor()
    const initial = this.current(binding)
    const target = await directory(initial.path)
    return this.store.atomic(() => {
      this.assertSupervisor()
      const value = this.current(binding)
      if (value.phase !== 'reserved' || this.now() >= value.expiresAt)
        return fail('operation_inactive', '该占用不能启动新执行')
      if (target.fileId !== value.fileId || pathKey(target.path) !== pathKey(value.path))
        return fail('workspace_changed', '工作区路径或目录身份已变化')
      value.phase = 'running'
      value.execution = { id: randomUUID(), supervisorId: this.supervisorId, launch }
      this.store.set(slots(value.workspaceId), value)
      const execution = { ...binding, executionId: value.execution.id }
      register?.(execution)
      return execution
    })
  }
  /** 只允许 prepared -> issued；许可与恢复串行竞争，禁止重新发出同一许可。 */
  issueLaunch(input: WorkspaceExecutionBinding) {
    return this.store.atomic(() => {
      this.assertCurrent(input)
      const value = this.current(input)
      if (value.execution?.launch !== 'prepared')
        return fail('launch_already_issued', '启动许可已发出或缺少新协议依据，不能重复发出')
      value.execution.launch = 'issued'
      this.store.set(slots(value.workspaceId), value)
    })
  }
  /** 仅扫描当前目录记录，不扫描全部历史操作；旧版缺少 launch 字段的执行不在此列。 */
  preparedLaunches(): WorkspaceExecutionBinding[] {
    this.assertAuthority()
    return this.store.keys(slots).flatMap(key => {
      const value = this.load(key.slice(slots.prefix.length))
      return value.phase !== 'released' && value.execution?.launch === 'prepared'
        ? [{ workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
          executionId: value.execution.id }] : []
    })
  }
  /** 当前控制面撤销尚未发出的许可；无需接管旧执行身份，不允许据此回收 issued 或旧版记录。 */
  retireUnlaunched(input: WorkspaceExecutionBinding) {
    return this.store.atomic(() => {
      this.assertAuthority()
      const value = this.current(input)
      if (value.execution?.id !== input.executionId)
        return fail('execution_stale', '未启动恢复与当前执行身份不一致')
      if (value.execution.launch === 'retired' && value.phase === 'released') return this.view(value)
      if (value.execution.launch !== 'prepared')
        return fail('launch_unconfirmed', '启动许可已经发出或缺少依据，不能按未启动回收')
      value.execution.launch = 'retired'
      value.phase = 'released'
      this.store.set(slots(value.workspaceId), value)
      return this.view(value)
    })
  }
  /** 只验证协议中的当前代次；真实写者和资源权限仍由执行宿主验证。 */
  assertCurrent(input: WorkspaceBinding & { executionId: string }) {
    this.assertSupervisor()
    const value = this.current(input)
    if (value.phase !== 'running' || value.execution?.id !== input.executionId
      || value.execution.supervisorId !== this.supervisorId || this.now() >= value.expiresAt)
      fail('operation_inactive', '执行已过期、取消或属于旧宿主，拒绝新的受控写入')
  }
  /** 宿主已经核验全部写者停止后调用；不因超时或取消请求自动调用。旧宿主不得确认。 */
  confirmStopped(input: WorkspaceBinding & { executionId: string }) {
    return this.store.atomic(() => {
      this.assertSupervisor()
      const value = this.current(input)
      if (value.execution?.id !== input.executionId || value.execution.supervisorId !== this.supervisorId)
        return fail('execution_stale', '不是当前宿主登记的执行，不能确认结束')
      value.phase = 'released'
      this.store.set(slots(value.workspaceId), value)
      return this.view(value)
    })
  }
  /** 可信恢复器专用：在当前事务中核验持久证据后释放精确执行，不接管旧宿主身份。不得开放给 HTTP/模型。 */
  releaseVerified(input: WorkspaceExecutionBinding, verify: () => void) {
    return this.store.atomic(() => {
      this.assertAuthority()
      const value = this.current(input)
      if (value.execution?.id !== input.executionId || value.execution.launch !== 'issued')
        return fail('execution_stale', '回收依据不属于当前已发许可执行')
      verify()
      value.phase = 'released'
      this.store.set(slots(value.workspaceId), value)
      return this.view(value)
    })
  }
}
