import { z } from 'zod'
import { family, type Key } from '../kv-key.ts'
import { DevelopmentWorkspaces, WorkspaceBindingSchema, WorkspaceError, type WorkspaceBinding, type WorkspaceExecutionBinding } from './workspaces.ts'
import { DevelopmentCommandSchema, type DevelopmentCommand } from './command.ts'
import type { DevelopmentLaunchPermits } from './launch-permits.ts'
import { executionContract, requireExecutionContract, type DevelopmentExecutionRequirement } from './execution-contract.ts'
import { PreparedExecutionInputSchema, type PreparedExecutionInput, verifyPreparedExecutionInput } from './source-materialization.ts'
export { DevelopmentCommandSchema, type DevelopmentCommand } from './command.ts'

/** 仅承诺提供方定义的进程范围，不承诺文件权限、外部守护进程或设备状态。 */
export interface ManagedExecution {
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
export interface DevelopmentExecutionPort {
  readonly admission?: Pick<DevelopmentLaunchPermits, 'read' | 'close' | 'closeOutstanding'>
  readonly outcomeScope?: 'provider_command' | 'trusted_launcher'
  /** 适配器必须逐次启动兑现这些保证；不能由界面、模型或安装版本自行宣告。 */
  readonly guarantees?: readonly DevelopmentExecutionRequirement[]
  spawn(command: DevelopmentCommand & { cwd: string }, binding: WorkspaceExecutionBinding,
    requirements?: readonly DevelopmentExecutionRequirement[], prepared?: PreparedExecutionInput): ManagedExecution
}
interface Storage {
  atomic<T>(action: () => T): T
  afterCommit(action: () => void): void
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
}
const ExecutionFields = WorkspaceBindingSchema.extend({
  executionId: z.string().uuid(),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  outcomeScope: z.enum(['provider_command', 'trusted_launcher']).optional(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('exited'), exitCode: z.number().int().nullable(), signal: z.string().max(64).nullable() }).strict(),
    z.object({ kind: z.literal('unavailable') }).strict(),
  ]).optional(),
  termination: z.enum(['requested', 'unconfirmed', 'handle_unavailable']).optional(),
  observationProblem: z.enum(['spawn_unconfirmed', 'range_observation_failed', 'range_not_confirmed', 'observer_stopped']).optional(),
  prepared: PreparedExecutionInputSchema.optional(),
}).strict()
const phases = ['launching', 'observing', 'range_quiet', 'unknown'] as const
const ObservedExecutionFields = ExecutionFields.extend({ schemaVersion: z.union([z.literal(3), z.literal(4)]) })
const ExecutionSchema = z.discriminatedUnion('schemaVersion', [
  ExecutionFields.extend({ schemaVersion: z.literal(1), phase: z.enum(phases) }).strict(),
  z.discriminatedUnion('phase', [
    ExecutionFields.extend({ schemaVersion: z.literal(2), phase: z.enum(phases) }).strict(),
    ExecutionFields.extend({
      schemaVersion: z.literal(2), phase: z.enum(['prepared', 'not_started']),
      outcome: z.never().optional(),
      termination: z.literal('handle_unavailable').optional(),
      observationProblem: z.literal('observer_stopped').optional(),
    }).strict(),
  ]),
  z.discriminatedUnion('phase', [
    ObservedExecutionFields.extend({
      phase: z.enum(['launching', 'observing', 'unknown']),
    }).strict(),
    ObservedExecutionFields.extend({
      phase: z.enum(['prepared', 'not_started']),
      outcome: z.never().optional(), termination: z.literal('handle_unavailable').optional(),
      observationProblem: z.literal('observer_stopped').optional(),
    }).strict(),
    ObservedExecutionFields.extend({
      phase: z.literal('range_quiet'), rangeObservedAt: z.number().finite(),
    }).strict(),
    ObservedExecutionFields.extend({
      phase: z.literal('released_closed'),
      outcomeScope: z.literal('trusted_launcher'), rangeObservedAt: z.number().finite(),
      reclamation: z.object({
        basis: z.literal('target_closed_range_quiet'), releasedAt: z.number().finite(),
      }).strict(),
    }).strict(),
    ExecutionFields.extend({
      schemaVersion: z.literal(4), phase: z.literal('released_start_rejected'),
      outcomeScope: z.literal('trusted_launcher'), rangeObservedAt: z.number().finite(),
      reclamation: z.object({
        basis: z.literal('target_start_rejected_range_quiet'), releasedAt: z.number().finite(),
      }).strict(),
    }).strict(),
  ]),
])
type Execution = z.infer<typeof ExecutionSchema>
const records = family<Execution>('development:execution:')
const sameBinding = (left: WorkspaceBinding, right: WorkspaceBinding) =>
  left.workspaceId === right.workspaceId && left.operationId === right.operationId && left.generation === right.generation
const interrupted = Symbol('interrupted')

/** 即使提供方忽略取消，也能结束本地观测；晚到结果没有持久写入权。 */
function observe<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof interrupted> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(interrupted) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void work.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/**
 * 将工作区占用接到真实宿主进程接口，并保存有明确范围的观测。
 * 范围结束不等于全部写者停止；只回收未发许可，或目标确定未创建且可信启动器范围已结束的操作。
 * 不提供凭 PID 恢复，也不重放已消费的目标。
 */
export class DevelopmentExecutions {
  private readonly lifetime = new AbortController()
  private readonly live = new Map<string, { execution: Execution; handle: ManagedExecution }>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly unsubscribe: () => void
  private stopping?: Promise<void>
  constructor(private readonly store: Storage, private readonly workspaces: DevelopmentWorkspaces,
    private readonly port: DevelopmentExecutionPort, private readonly report: (error: unknown) => void = () => {},
    private readonly now = Date.now) {
    this.unsubscribe = workspaces.onCancel(binding => { this.cancel(binding) })
  }
  contract() { return executionContract(this.port.guarantees) }
  get(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId)
    const raw = this.store.get(records(workspace.operationId))
    if (!raw) return null
    const value = ExecutionSchema.parse(raw)
    if (!sameBinding(workspace, value)) throw new WorkspaceError('execution_stale', '执行记录与工作区代次不一致')
    const { schemaVersion: _, executionId, ...fields } = value
    const notStarted = value.phase === 'not_started' && workspace.phase === 'released'
    const uncreatedReleased = (value.phase === 'released_closed' || value.phase === 'released_start_rejected')
      && workspace.phase === 'released'
    const admission = this.port.admission?.read(value)
    const targetResult = admission?.targetExit?.state === 'exited' ? admission.targetExit
      : notStarted || admission?.targetStartPrevented || admission?.targetStart?.state === 'rejected'
        ? { state: 'not_started' as const } : { state: 'unobserved' as const }
    return { ...fields, outcomeScope: value.outcomeScope ?? 'provider_command',
      scope: notStarted ? 'launch_not_issued' as const : 'provider_managed_range' as const,
      ...(this.port.admission ? { admission } : {}),
      targetResult, targetResultScope: 'direct_child_only' as const, validationPassed: false as const,
      workspaceReleaseAllowed: notStarted || uncreatedReleased,
      recoveryRequired: !uncreatedReleased && (workspace.recoveryRequired || value.phase === 'unknown'
        || (!notStarted && !this.live.has(executionId) && value.phase !== 'range_quiet')) }
  }
  /** 重启只关闭尚未消费的目标许可；不回收 issued 目录，也不重放命令。 */
  closePendingAdmissions() {
    return this.port.admission?.closeOutstanding(this.workspaces.activeExecutions(), 'host_restarted') ?? 0
  }
  /** 复核当前占用的持久证据；只做数据库状态转移，绝不重新启动命令或探测 PID。 */
  reclaimUncreated() {
    let reclaimed = 0, retained = 0
    for (const execution of this.workspaces.activeExecutions()) {
      try {
        if (this.reclaimUncreatedExecution(execution)) reclaimed++
        else retained++
      } catch (error) { retained++; this.report(error) }
    }
    return { reclaimed, retained }
  }
  private reclaimUncreatedExecution(execution: WorkspaceExecutionBinding) {
    return this.store.atomic(() => {
      const raw = this.store.get(records(execution.operationId))
      if (!raw) return false
      const value = ExecutionSchema.parse(raw)
      if (!sameBinding(value, execution) || value.executionId !== execution.executionId)
        throw new WorkspaceError('execution_stale', '回收记录与当前执行身份不一致')
      if ((value.schemaVersion !== 3 && value.schemaVersion !== 4) || value.phase !== 'range_quiet'
        || value.outcomeScope !== 'trusted_launcher')
        return false
      const admission = this.port.admission?.read(execution)
      const release = admission?.state === 'closed'
        ? { phase: 'released_closed', basis: 'target_closed_range_quiet' } as const
        : admission?.state === 'consumed' && admission.targetStart?.state === 'rejected'
          ? { phase: 'released_start_rejected', basis: 'target_start_rejected_range_quiet' } as const
          : undefined
      if (!release) return false
      this.workspaces.releaseVerified(execution, () => {
        // 许可和范围证据在同一事务读取；回执失败必须连同目录释放回滚。
        const releasedAt = this.now()
        this.store.set(records(execution.operationId), ExecutionSchema.parse({
          ...value, schemaVersion: 4, phase: release.phase, updatedAt: releasedAt,
          reclamation: { basis: release.basis, releasedAt },
        }))
      })
      return true
    })
  }
  /** 启动时恢复已提交的准备记录；不会重新调用提供方或推断旧版 launching 的真实状态。 */
  recoverUnstarted() {
    if (this.lifetime.signal.aborted) throw new WorkspaceError('runtime_unavailable', '执行器已关闭')
    let recovered = 0, retained = 0
    for (const execution of this.workspaces.preparedLaunches()) {
      try {
        this.store.atomic(() => {
          const value = ExecutionSchema.parse(this.store.get(records(execution.operationId)))
          if (!sameBinding(value, execution) || value.executionId !== execution.executionId
            || value.schemaVersion === 1 || value.phase !== 'prepared')
            throw new WorkspaceError('recovery_unconfirmed', '缺少与未启动许可一致的执行记录，保留占用')
          this.workspaces.retireUnlaunched(execution)
          this.store.set(records(execution.operationId), { ...value, phase: 'not_started', updatedAt: this.now() })
        })
        recovered++
      } catch (error) { retained++; this.report(error) }
    }
    return { recovered, retained }
  }
  /** 可信宿主专用：调用方负责命令授权；工作目录只能来自本次占用。 */
  start(input: WorkspaceBinding, command: DevelopmentCommand, requirements: readonly DevelopmentExecutionRequirement[] = [], prepared?: PreparedExecutionInput) {
    const task = this.launch(input, command, requirements, prepared)
    this.track(task)
    return task
  }
  private track(task: Promise<unknown>) {
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
  }
  private update(execution: Execution, change: Partial<Execution>) {
    this.store.atomic(() => {
      this.workspaces.assertExecutionOwner(execution)
      const current = ExecutionSchema.parse(this.store.get(records(execution.operationId)))
      if (current.executionId !== execution.executionId || !sameBinding(current, execution))
        throw new WorkspaceError('execution_stale', '执行观测身份已变化')
      this.store.set(records(execution.operationId), ExecutionSchema.parse({ ...current, ...change, updatedAt: this.now() }))
    })
  }
  private async launch(input: WorkspaceBinding, command: DevelopmentCommand, requested: readonly DevelopmentExecutionRequirement[], preparedInput?: PreparedExecutionInput) {
    if (this.lifetime.signal.aborted) throw new WorkspaceError('runtime_unavailable', '执行器已关闭')
    const binding = WorkspaceBindingSchema.parse(input)
    const args = DevelopmentCommandSchema.parse(command)
    const requirements = requireExecutionContract(requested, this.port.guarantees)
    const prepared = preparedInput === undefined ? undefined : PreparedExecutionInputSchema.parse(preparedInput)
    if (prepared) verifyPreparedExecutionInput(prepared)
    let record!: Execution
    const execution = await this.workspaces.prepare(binding, execution => {
      requireExecutionContract(requirements, this.port.guarantees)
      if (prepared) verifyPreparedExecutionInput(prepared)
      record = { ...execution, schemaVersion: 4, phase: 'prepared', startedAt: this.now(), updatedAt: this.now(),
        outcomeScope: this.port.outcomeScope ?? 'provider_command', ...(prepared ? { prepared } : {}) }
      this.store.set(records(execution.operationId), record)
    })
    // prepare 的目录核验是异步操作；返回后必须重新检查关闭、取消和租期。
    if (this.lifetime.signal.aborted) {
      this.update(record, { observationProblem: 'observer_stopped' })
      return this.get(binding.workspaceId)!
    }
    const started = Promise.withResolvers<void>()
    this.store.atomic(() => {
      requireExecutionContract(requirements, this.port.guarantees)
      this.workspaces.issueLaunch(execution)
      this.update(record, { phase: 'launching' })
      // 必须等最外层事务提交；内层保存点的 RELEASE 不是外部启动许可。
      this.store.afterCommit(() => {
        try {
          if (this.lifetime.signal.aborted) this.update(record, { phase: 'unknown', observationProblem: 'observer_stopped' })
          else this.spawn(record, args, requirements)
          started.resolve()
        } catch (error) { started.reject(error) }
      })
    })
    await observe(started.promise, this.lifetime.signal)
    return this.get(binding.workspaceId)!
  }
  private spawn(record: Execution, args: DevelopmentCommand, requirements: readonly DevelopmentExecutionRequirement[]) {
    this.workspaces.assertCurrent(record)
    let handle: ManagedExecution
    try {
      requireExecutionContract(requirements, this.port.guarantees)
    const prepared = record.prepared
    if (prepared) verifyPreparedExecutionInput(prepared)
    handle = this.port.spawn({ ...args, cwd: this.workspaces.get(record.workspaceId).path }, {
        workspaceId: record.workspaceId, operationId: record.operationId, generation: record.generation, executionId: record.executionId,
      }, requirements, prepared)
    }
    catch {
      this.update(record, { phase: 'unknown', observationProblem: 'spawn_unconfirmed' })
      return
    }
    this.live.set(record.executionId, { execution: record, handle })
    // 即使启动后的落库失败，句柄仍由监督器持有并参与关闭，不能遗失真实进程。
    const watching = this.watch(record, handle).catch(error => { this.report(error) })
    this.track(watching)
    this.update(record, { phase: 'observing' })
  }
  private async watch(execution: Execution, handle: ManagedExecution) {
    const signal = this.lifetime.signal
    const outcome = observe(handle.done, signal).then(value => {
      if (value !== interrupted) this.update(execution, { outcome: { kind: 'exited', ...value } })
    }, () => {
      if (!signal.aborted) this.update(execution, { outcome: { kind: 'unavailable' } })
    })
    // 提供方也可能同步抛错；两种失败都不能被提升为成功结束。
    const range = observe(Promise.resolve().then(() => handle.waitForExit(signal)), signal).then(value => {
      this.update(execution, value === true ? { phase: 'range_quiet', rangeObservedAt: this.now() } : {
        phase: 'unknown', observationProblem: value === interrupted ? 'observer_stopped' : 'range_not_confirmed',
      })
      if (value === true) this.reclaimUncreatedExecution(execution)
      return value === true ? 'quiet' : 'unknown'
    }, () => {
      this.update(execution, { phase: 'unknown', observationProblem: 'range_observation_failed' })
      return 'unknown'
    })
    const results = await Promise.allSettled([outcome, range])
    for (const result of results) if (result.status === 'rejected') this.report(result.reason)
    // 观测失败不使终止能力失效；保留原句柄供取消重试和宿主关闭使用。
    if (results[1].status === 'fulfilled' && results[1].value === 'quiet') this.live.delete(execution.executionId)
  }
  private cancel(binding: WorkspaceBinding) {
    const raw = this.store.get(records(binding.operationId))
    if (!raw) return
    const execution = ExecutionSchema.parse(raw)
    if (!sameBinding(execution, binding)) throw new WorkspaceError('execution_stale', '取消请求与执行记录不一致')
    this.port.admission?.close(execution, 'cancelled')
    if (this.reclaimUncreatedExecution(execution)) return
    const current = this.live.get(execution.executionId)
    if (!current) {
      // 新宿主可以记录缺少句柄，不能声称已向旧进程发送信号。
      this.store.atomic(() => {
        const workspace = this.workspaces.get(binding.workspaceId)
        if (!sameBinding(workspace, binding)) throw new WorkspaceError('operation_stale', '取消目标已变化')
        this.store.set(records(binding.operationId), { ...execution, termination: 'handle_unavailable', updatedAt: this.now() })
      })
      return
    }
    this.terminate(current.execution, current.handle)
  }
  private terminate(execution: Execution, handle: ManagedExecution) {
    this.workspaces.assertExecutionOwner(execution)
    let termination: Execution['termination'] = 'requested'
    try { handle.terminate() } catch { termination = 'unconfirmed' }
    this.update(execution, { termination })
  }
  /** 关闭利用已持久证据回收，其他操作只请求停止并结束观测；不等待提供方，不推断未知范围。 */
  shutdown(): Promise<void> { return this.stopping ??= this.stop() }
  private async stop() {
    this.unsubscribe()
    try { this.port.admission?.closeOutstanding(this.workspaces.activeExecutions(), 'host_stopped') }
    catch (error) { this.report(error) }
    try { this.reclaimUncreated() } catch (error) { this.report(error) }
    for (const { execution, handle } of this.live.values()) {
      try { this.terminate(execution, handle) } catch (error) { this.report(error) }
    }
    this.lifetime.abort()
    while (this.pending.size) await Promise.allSettled([...this.pending])
    this.live.clear()
  }
}
