import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DevelopmentWorkspaces, type WorkspaceBinding } from '../src/development/workspaces.ts'
import { DevelopmentExecutions, type ManagedExecution } from '../src/development/executions.ts'
import { family } from '../src/kv-key.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let root: string, path: string, store: Store, workspaces: DevelopmentWorkspaces, executions: DevelopmentExecutions
let host: Host | undefined
const command = { argv: ['test-runner'] }
const binding = (value: WorkspaceBinding): WorkspaceBinding => ({
  workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
})
const records = family<Record<string, unknown>>('development:execution:')
const spawn = vi.fn<(input: unknown) => ManagedExecution>()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-launch-recovery-'))
  path = join(root, 'workspace')
  await mkdir(path)
  store = new Store(join(root, 'state.sqlite'))
  workspaces = new DevelopmentWorkspaces(store, () => true)
  spawn.mockReset()
  spawn.mockImplementation(() => ({
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true,
  }))
  executions = new DevelopmentExecutions(store, workspaces, { spawn })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await host?.stop()
  host = undefined
  await executions.shutdown()
  store.close()
  const target = resolve(root), parent = resolve(tmpdir())
  if (!target.startsWith(`${parent}${sep}`) || !target.split(sep).at(-1)!.startsWith('superagent-launch-recovery-'))
    throw new Error('测试清理路径不属于临时工作区')
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
})
const reserve = (requestId = 'work') => workspaces.reserve({ path, requestId, owner: 'developer', leaseMs: 60_000 })
const preparedRecord = (execution: WorkspaceBinding & { executionId: string }) => ({
  ...execution, schemaVersion: 2, phase: 'prepared', startedAt: 1, updatedAt: 1,
})

it('尚未发出许可的操作可以回收，回收持久化并阻止旧宿主迟到启动', async () => {
  const reserved = await reserve()
  const old = workspaces
  const execution = await old.prepare(binding(reserved), value => {
    store.set(records(value.operationId), preparedRecord(value))
  })
  await executions.shutdown()
  workspaces = new DevelopmentWorkspaces(store, () => true)
  executions = new DevelopmentExecutions(store, workspaces, { spawn })
  expect(executions.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
  expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'not_started', scope: 'launch_not_issued', recoveryRequired: false, workspaceReleaseAllowed: true,
  })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
  expect(executions.recoverUnstarted()).toEqual({ recovered: 0, retained: 0 })
  expect(() => old.issueLaunch(execution)).toThrow('旧控制实例')
  const next = await reserve('next')
  expect(next.generation).toBe(reserved.generation + 1)
  expect(() => workspaces.retireUnlaunched(execution)).toThrow('执行代次已变化')
  expect(spawn).not.toHaveBeenCalled()
})

it('同一宿主中恢复先成功时，暂停的旧启动链也不能获得许可', async () => {
  const reserved = await reserve()
  const prepare = workspaces.prepare.bind(workspaces)
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  vi.spyOn(workspaces, 'prepare').mockImplementationOnce(async (input, register) => {
    const execution = await prepare(input, register)
    entered.resolve()
    await resume.promise
    return execution
  })
  const starting = executions.start(binding(reserved), command)
  const result = starting.then(value => ({ value }), error => ({ error }))
  await entered.promise
  expect(executions.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
  resume.resolve()
  expect(await result).toMatchObject({ error: { code: 'operation_inactive' } })
  expect(spawn).not.toHaveBeenCalled()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
})

it('许可一旦提交，即便没有进程或已报告范围结束，也不归入未启动恢复', async () => {
  const reserved = await reserve()
  const execution = await workspaces.prepare(binding(reserved), value => store.set(records(value.operationId), preparedRecord(value)))
  workspaces.issueLaunch(execution)
  expect(() => workspaces.issueLaunch(execution)).toThrow('启动许可')
  expect(executions.recoverUnstarted()).toEqual({ recovered: 0, retained: 0 })
  expect(() => workspaces.retireUnlaunched(execution)).toThrow('不能按未启动回收')
  await expect(reserve('duplicate')).rejects.toMatchObject({ code: 'workspace_busy' })
  expect(spawn).not.toHaveBeenCalled()
})

it('旧版 launching 记录和旧 begin 入口不能被推断为尚未启动', async () => {
  const reserved = await reserve()
  const execution = await workspaces.begin(binding(reserved))
  store.db.prepare("UPDATE kv SET value=json_remove(value,'$.execution.launch') WHERE key=?")
    .run(`development:workspace:${reserved.workspaceId}`)
  store.set(records(reserved.operationId), { ...preparedRecord(execution), schemaVersion: 1, phase: 'launching' })
  expect(executions.recoverUnstarted()).toEqual({ recovered: 0, retained: 0 })
  expect(() => workspaces.retireUnlaunched(execution)).toThrow('不能按未启动回收')
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'launching', workspaceReleaseAllowed: false })
  await expect(reserve('new')).rejects.toMatchObject({ code: 'workspace_busy' })
})

it('恢复回执保存失败时目录释放也回滚，稍后重试只产生一次有效恢复', async () => {
  const reserved = await reserve()
  await workspaces.prepare(binding(reserved), value => store.set(records(value.operationId), preparedRecord(value)))
  const set = store.set.bind(store), errors: unknown[] = []
  await executions.shutdown()
  executions = new DevelopmentExecutions(store, workspaces, { spawn }, error => errors.push(error))
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    if (String(key).startsWith('development:execution:')) throw new Error('receipt write failed')
    set(key, value)
  })
  expect(executions.recoverUnstarted()).toEqual({ recovered: 0, retained: 1 })
  expect(errors).toHaveLength(1)
  failure.mockRestore()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  expect(executions.get(reserved.workspaceId)?.phase).toBe('prepared')
  expect(executions.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
})

it('启动许可或对应执行记录落库失败，不调用提供方且原准备仍可恢复', async () => {
  const reserved = await reserve()
  const set = store.set.bind(store)
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    if (String(key).startsWith('development:execution:') && (value as { phase?: string }).phase === 'launching')
      throw new Error('launch write failed')
    set(key, value)
  })
  await expect(executions.start(binding(reserved), command)).rejects.toThrow('launch write failed')
  failure.mockRestore()
  expect(spawn).not.toHaveBeenCalled()
  expect(executions.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
})

it('声明已提交前不能启动，外层事务回滚保留准备状态且没有外部动作', async () => {
  const reserved = await reserve()
  const issue = workspaces.issueLaunch.bind(workspaces)
  vi.spyOn(workspaces, 'issueLaunch').mockImplementationOnce(execution => {
    issue(execution)
    throw new Error('outer transaction aborted')
  })
  await expect(executions.start(binding(reserved), command)).rejects.toThrow('outer transaction aborted')
  expect(spawn).not.toHaveBeenCalled()
  expect(executions.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
})

it('提供方被调用时，独立数据库连接已能读取同时提交的许可和启动记录', async () => {
  const reserved = await reserve()
  const witness = new DatabaseSync(join(root, 'state.sqlite'), { readOnly: true })
  const original = spawn.getMockImplementation()!
  let observed: { workspace: unknown; execution: unknown } | undefined
  spawn.mockImplementationOnce(input => {
    const read = (key: string) => JSON.parse(String(witness.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value))
    observed = { workspace: read(`development:workspace:${reserved.workspaceId}`), execution: read(`development:execution:${reserved.operationId}`) }
    return original(input)
  })
  try {
    await executions.start(binding(reserved), command)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(observed).toMatchObject({
      workspace: { execution: { launch: 'issued' } }, execution: { schemaVersion: 4, phase: 'launching' },
    })
  } finally { witness.close() }
})

it('恢复验证精确记录，缺失或不一致的凭据不能导致释放', async () => {
  const reserved = await reserve()
  const execution = await workspaces.prepare(binding(reserved))
  const errors: unknown[] = []
  await executions.shutdown()
  executions = new DevelopmentExecutions(store, workspaces, { spawn }, error => errors.push(error))
  expect(executions.recoverUnstarted()).toEqual({ recovered: 0, retained: 1 })
  store.set(records(execution.operationId), { ...preparedRecord(execution), executionId: '00000000-0000-4000-8000-000000000000' })
  expect(executions.recoverUnstarted()).toEqual({ recovered: 0, retained: 1 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  expect(errors).toHaveLength(2)
})

it('准备记录却带有进程结束结果时，矛盾的持久状态必须保留而非自动回收', async () => {
  const reserved = await reserve()
  const errors: unknown[] = []
  await executions.shutdown()
  executions = new DevelopmentExecutions(store, workspaces, { spawn }, error => errors.push(error))
  await workspaces.prepare(binding(reserved), value => store.set(records(value.operationId), {
    ...preparedRecord(value), outcome: { kind: 'exited', exitCode: 0, signal: null },
  }))
  expect(executions.recoverUnstarted()).toEqual({ recovered: 0, retained: 1 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  expect(errors).toHaveLength(1)
  expect(spawn).not.toHaveBeenCalled()
})

it('Runtime 重启自动回收 prepared，只读 API 呈现未启动，不调用 DSH', async () => {
  host = await startRuntime(undefined, { mode: 'hmm' })
  const reserved = await host.runtime.workspaces.reserve({ path, requestId: 'runtime', owner: 'developer', leaseMs: 60_000 })
  await host.runtime.workspaces.prepare(binding(reserved), value => {
    host!.runtime.store.set(records(value.operationId), preparedRecord(value))
  })
  const before = host.subprocess.spawn.mock.calls.length
  await host.restart()
  expect(host.subprocess.spawn.mock.calls.length).toBe(before)
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: { phase: 'not_started', workspaceReleaseAllowed: true } } })
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}`))
    .toMatchObject({ status: 200, body: { phase: 'released', recoveryRequired: false } })
})
