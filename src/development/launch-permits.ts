import { createHash, createHmac, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { family, type Key } from '../kv-key.ts'
import { DevelopmentCommandSchema } from './command.ts'
import { WorkspaceBindingSchema, WorkspaceError, type WorkspaceExecutionBinding } from './workspaces.ts'
import { PreparedExecutionInputSchema, type PreparedExecutionInput, verifyPreparedExecutionInput } from './source-materialization.ts'

const BindingSchema = WorkspaceBindingSchema.extend({ executionId: z.string().uuid() }).strict()
const PayloadSchema = z.object({
  command: DevelopmentCommandSchema,
  cwd: z.string().min(1).max(4096).refine(isAbsolute, '目标目录必须为绝对路径'),
  prepared: PreparedExecutionInputSchema.optional(),
}).strict()
const fields = z.object({
  schemaVersion: z.literal(1), binding: BindingSchema,
  secretHash: z.string().regex(/^[a-f0-9]{64}$/), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().finite(),
}).strict()
const LegacyPermitSchema = z.discriminatedUnion('state', [
  fields.extend({ state: z.literal('offered') }).strict(),
  fields.extend({ state: z.literal('consumed'), consumedAt: z.number().finite() }).strict(),
  fields.extend({ state: z.literal('closed'), closedAt: z.number().finite(),
    reason: z.enum(['cancelled', 'host_restarted', 'host_stopped']) }).strict(),
])
const StartResultSchema = z.enum(['spawned', 'rejected'])
const TargetExitFields = z.object({
  exitCode: z.number().int().safe().nullable(), signal: z.string().min(1).max(64).nullable(),
}).strict()
const isExit = (value: z.infer<typeof TargetExitFields>) => (value.exitCode !== null) !== (value.signal !== null)
export const TargetExitSchema = TargetExitFields.refine(isExit, '退出观测必须是退出码或信号之一')
const ConsumedPermitSchema = fields.extend({
  schemaVersion: z.literal(2), state: z.literal('consumed'), consumedAt: z.number().finite(),
  consumerHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetStart: z.discriminatedUnion('state', [
    z.object({ state: z.literal('unobserved') }).strict(),
    z.object({ state: StartResultSchema, observedAt: z.number().finite() }).strict(),
  ]),
}).strict()
const PermitSchema = z.discriminatedUnion('schemaVersion', [
  LegacyPermitSchema,
  ConsumedPermitSchema,
  ConsumedPermitSchema.extend({
    schemaVersion: z.literal(3),
    targetExit: z.union([
      z.object({ state: z.literal('unobserved') }).strict(),
      TargetExitFields.extend({ state: z.literal('exited'), observedAt: z.number().finite() }).strict().refine(isExit),
    ]),
  }).strict().refine(value => value.targetExit.state === 'unobserved' || value.targetStart.state === 'spawned',
  '未确认目标创建，不能记录目标退出'),
])
const WorkspaceStateSchema = WorkspaceBindingSchema.extend({
  schemaVersion: z.literal(1), phase: z.string(), expiresAt: z.number().finite(), path: z.string(),
  execution: z.object({ id: z.string().uuid(), supervisorId: z.string().uuid(), launch: z.string().optional() }).optional(),
}).passthrough()
type Permit = z.infer<typeof PermitSchema>
const permits = family<Permit>('development:launch-permit:')
export const RunnerEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), binding: BindingSchema,
  database: z.string().min(1).max(4096).refine(isAbsolute, '状态库必须为绝对路径'),
  databaseFileId: z.string().max(160),
  secret: z.string().regex(/^[a-f0-9]{64}$/), payload: PayloadSchema,
}).strict()
export type RunnerEnvelope = z.infer<typeof RunnerEnvelopeSchema>
interface Storage {
  atomic<T>(action: () => T): T
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const bindingKey = (binding: WorkspaceExecutionBinding) =>
  JSON.stringify([binding.workspaceId, binding.operationId, binding.generation, binding.executionId])
const payloadHash = (secret: string, payload: z.infer<typeof PayloadSchema>) =>
  createHmac('sha256', secret).update(JSON.stringify([payload.cwd, payload.command.argv,
    Object.entries(payload.command.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), payload.prepared ?? null])).digest('hex')
function fileId(path: string) {
  const info = statSync(path, { bigint: true })
  if (!info.isFile() || info.ino === 0n) throw new WorkspaceError('database_unavailable', '状态库不是可识别的既有文件')
  return `${info.dev}:${info.ino}`
}
const deny = (code: string, message: string): never => { throw new WorkspaceError(code, message) }

/** 一次性目标启动许可。记录不含命令、环境或原始令牌，关闭不能覆盖已经消费的事实。 */
export class DevelopmentLaunchPermits {
  constructor(private readonly store: Storage, private readonly database: string,
    private readonly authorize: (binding: WorkspaceExecutionBinding) => void,
    private readonly assertAuthority: () => void) {}
  offer(input: WorkspaceExecutionBinding, command: z.input<typeof DevelopmentCommandSchema>, cwd: string, prepared?: PreparedExecutionInput): RunnerEnvelope {
    const binding = BindingSchema.parse(input)
    const payload = PayloadSchema.parse({ command, cwd, ...(prepared ? { prepared } : {}) })
    if (payload.prepared) verifyPreparedExecutionInput(payload.prepared)
    const databaseFileId = fileId(this.database)
    const secret = randomBytes(32).toString('hex')
    this.store.atomic(() => {
      this.authorize(binding)
      if (this.store.get(permits(binding.executionId)))
        deny('launch_offer_exists', '该执行已经登记过启动许可，不允许重建或重放')
      this.store.set(permits(binding.executionId), { schemaVersion: 1, binding, state: 'offered',
        createdAt: Date.now(), secretHash: digest(secret), payloadHash: payloadHash(secret, payload) })
    })
    return { schemaVersion: 1, binding, database: this.database, databaseFileId, secret, payload }
  }
  private load(input: WorkspaceExecutionBinding) {
    const raw = this.store.get(permits(input.executionId))
    if (!raw) return null
    const value = PermitSchema.parse(raw)
    if (bindingKey(value.binding) !== bindingKey(input)) return deny('permit_mismatch', '启动许可与执行身份不一致')
    return value
  }
  read(input: WorkspaceExecutionBinding) {
    const value = this.load(input)
    if (!value) return null
    return { state: value.state, ...(value.state === 'closed' ? { reason: value.reason } : {}),
      ...(value.schemaVersion !== 1 ? { targetStart: value.targetStart } : {}),
      ...(value.schemaVersion === 3 ? { targetExit: value.targetExit } : {}),
      targetStartPrevented: value.state === 'closed' }
  }
  close(input: WorkspaceExecutionBinding, reason: 'cancelled' | 'host_restarted' | 'host_stopped') {
    return this.store.atomic(() => {
      this.assertAuthority()
      const value = this.load(input)
      if (value?.state !== 'offered') return this.read(input)
      this.store.set(permits(input.executionId), { ...value, state: 'closed', closedAt: Date.now(), reason })
      return this.read(input)
    })
  }
  /** 仅在持有部署状态锁且旧调度器已经失权后调用；不是定时清理任务。 */
  closeOutstanding(bindings: readonly WorkspaceExecutionBinding[], reason: 'host_restarted' | 'host_stopped') {
    this.assertAuthority()
    let closed = 0
    for (const binding of bindings) {
      if (this.read(binding)?.state === 'offered' && this.close(binding, reason)?.state === 'closed') closed++
    }
    return closed
  }
}

/** 真实启动器使用独立连接消费一次许可；不创建表、不迁移数据库、不重放已消费命令。 */
export function consumeLaunchPermit(input: unknown) {
  const envelope = RunnerEnvelopeSchema.parse(input)
  if (fileId(envelope.database) !== envelope.databaseFileId) return deny('database_changed', '状态库身份已变化')
  const database = new DatabaseSync(envelope.database)
  try {
    if (fileId(envelope.database) !== envelope.databaseFileId) return deny('database_changed', '状态库身份已变化')
    database.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    try {
      const key = permits(envelope.binding.executionId)
      const raw = database.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value
      if (typeof raw !== 'string') return deny('permit_missing', '没有对应的目标启动许可')
      const value = PermitSchema.parse(JSON.parse(raw))
      if (bindingKey(value.binding) !== bindingKey(envelope.binding)
        || value.secretHash !== digest(envelope.secret) || value.payloadHash !== payloadHash(envelope.secret, envelope.payload))
        return deny('permit_mismatch', '目标命令与启动许可不一致')
      if (value.state !== 'offered') return deny('permit_unavailable', '启动许可已关闭或消费，目标命令未启动')
      const workspaceRaw = database.prepare('SELECT value FROM kv WHERE key=?')
        .get(`development:workspace:${envelope.binding.workspaceId}`)?.value
      const supervisorRaw = database.prepare('SELECT value FROM kv WHERE key=?').get('development:workspace-supervisor')?.value
      if (typeof workspaceRaw !== 'string' || typeof supervisorRaw !== 'string')
        return deny('operation_inactive', '执行归属无法核验')
      const workspace = WorkspaceStateSchema.parse(JSON.parse(workspaceRaw))
      if (!workspace.execution || bindingKey({ ...workspace, executionId: workspace.execution.id }) !== bindingKey(envelope.binding)
        || workspace.phase !== 'running' || workspace.execution.launch !== 'issued'
        || workspace.execution.supervisorId !== JSON.parse(supervisorRaw)
        || workspace.path !== envelope.payload.cwd || Date.now() >= workspace.expiresAt)
        return deny('operation_inactive', '执行已取消、过期或属于旧宿主，目标命令未启动')
      if (envelope.payload.prepared) try { verifyPreparedExecutionInput(envelope.payload.prepared) }
      catch { return deny('prepared_input_stale', '固定输入或输出目录身份已变化，目标命令未启动') }
      // 结果写权只返回消费获胜者；持有相同输入的重复启动器无法取得它。
      const consumerSecret = randomBytes(32).toString('hex')
      const consumed: Permit = { ...value, schemaVersion: 3, state: 'consumed', consumedAt: Date.now(),
        consumerHash: digest(consumerSecret), targetStart: { state: 'unobserved' }, targetExit: { state: 'unobserved' } }
      database.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(consumed), key)
      database.exec('COMMIT')
      return { ...envelope.payload,
        recordStart: (result: z.infer<typeof StartResultSchema>) =>
          recordObservation(envelope, consumerSecret, { kind: 'start', result: StartResultSchema.parse(result) }),
        recordExit: (result: z.infer<typeof TargetExitSchema>) =>
          recordObservation(envelope, consumerSecret, { kind: 'exit', result: TargetExitSchema.parse(result) }) }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally { database.close() }
}

/** 消费方独立令牌只存在启动器闭包；旧宿主可补精确执行事实，不能更新新代次。 */
function recordObservation(envelope: RunnerEnvelope, consumerSecret: string, observation:
  { kind: 'start'; result: z.infer<typeof StartResultSchema> } | { kind: 'exit'; result: z.infer<typeof TargetExitSchema> }) {
  if (fileId(envelope.database) !== envelope.databaseFileId) return deny('database_changed', '状态库身份已变化')
  const database = new DatabaseSync(envelope.database)
  try {
    if (fileId(envelope.database) !== envelope.databaseFileId) return deny('database_changed', '状态库身份已变化')
    database.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    try {
      const key = permits(envelope.binding.executionId)
      const raw = database.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value
      if (typeof raw !== 'string') return deny('permit_missing', '没有对应的目标启动许可')
      const value = PermitSchema.parse(JSON.parse(raw))
      if (value.schemaVersion !== 3 || bindingKey(value.binding) !== bindingKey(envelope.binding)
        || value.consumerHash !== digest(consumerSecret))
        return deny('consumer_mismatch', '目标观测不属于当前版本的许可消费方')
      const workspaceRaw = database.prepare('SELECT value FROM kv WHERE key=?')
        .get(`development:workspace:${envelope.binding.workspaceId}`)?.value
      if (typeof workspaceRaw !== 'string') return deny('operation_inactive', '执行归属无法核验')
      const workspace = WorkspaceStateSchema.parse(JSON.parse(workspaceRaw))
      if (!workspace.execution || bindingKey({ ...workspace, executionId: workspace.execution.id }) !== bindingKey(envelope.binding)
        || !['running', 'cancelling'].includes(workspace.phase) || workspace.execution.launch !== 'issued')
        return deny('operation_inactive', '目标观测不属于当前占用')
      if (observation.kind === 'start') {
        if (value.targetStart.state !== 'unobserved' && value.targetStart.state !== observation.result)
          return deny('start_result_conflict', '创建结果已经确定，不能改写')
        if (value.targetStart.state === 'unobserved') database.prepare('UPDATE kv SET value=? WHERE key=?')
          .run(JSON.stringify({ ...value, targetStart: { state: observation.result, observedAt: Date.now() } }), key)
      } else {
        if (value.targetStart.state !== 'spawned') return deny('target_not_started', '目标创建未确认，不能记录退出')
        if (value.targetExit.state === 'exited') {
          if (value.targetExit.exitCode !== observation.result.exitCode || value.targetExit.signal !== observation.result.signal)
            return deny('target_exit_conflict', '目标退出观测已经确定，不能改写')
        } else database.prepare('UPDATE kv SET value=? WHERE key=?')
          .run(JSON.stringify({ ...value, targetExit: { state: 'exited', ...observation.result, observedAt: Date.now() } }), key)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally { database.close() }
}
