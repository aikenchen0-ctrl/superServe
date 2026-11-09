import { lstat, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DevelopmentWorkspaces, type WorkspaceBinding } from '../src/development/workspaces.ts'
import { DevelopmentExecutions, type DevelopmentExecutionPort, type ManagedExecution } from '../src/development/executions.ts'
import { consumeLaunchPermit } from '../src/development/launch-permits.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { runDevelopmentCommand } from '../src/index.ts'
import type { PreparedExecutionInput } from '../src/development/source-materialization.ts'

let root: string, path: string, store: Store, workspaces: DevelopmentWorkspaces, executions: DevelopmentExecutions
let host: Host | undefined
const binding = (value: WorkspaceBinding): WorkspaceBinding => ({
  workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
})
const command = { argv: ['test-runner', '--verify'] }
function processRange() {
  const done = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  const range = Promise.withResolvers<boolean>()
  const terminate = vi.fn()
  const handle: ManagedExecution = { done: done.promise, terminate, waitForExit: () => range.promise }
  return { done, range, terminate, handle }
}
let process: ReturnType<typeof processRange>, spawn: ReturnType<typeof vi.fn<DevelopmentExecutionPort['spawn']>>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-executions-'))
  path = join(root, 'workspace')
  await mkdir(path)
  store = new Store(join(root, 'state.sqlite'))
  workspaces = new DevelopmentWorkspaces(store, () => true)
  process = processRange()
  spawn = vi.fn(() => process.handle)
  executions = new DevelopmentExecutions(store, workspaces, { spawn })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await host?.stop()
  host = undefined
  await executions.shutdown()
  store.close()
  const target = resolve(root), parent = resolve(tmpdir())
  if (!target.startsWith(`${parent}${sep}`) || !target.split(sep).at(-1)!.startsWith('superagent-executions-'))
    throw new Error('测试清理路径不属于临时工作区')
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
})
const reserve = (requestId = 'work') => workspaces.reserve({ path, requestId, owner: 'developer', leaseMs: 60_000 })

it('只有持久登记后才启动；参数和输出正文不进入执行记录', async () => {
  const reserved = await reserve()
  spawn.mockImplementation(input => {
    expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
    expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'launching' })
    expect(input).toEqual({ ...command, cwd: resolve(path) })
    return process.handle
  })
  const started = await executions.start(binding(reserved), command)
  expect(started).toMatchObject({ ...binding(reserved), phase: 'observing', workspaceReleaseAllowed: false })
  await expect(executions.start(binding(reserved), command)).rejects.toMatchObject({ code: 'operation_inactive' })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(store.db.prepare("SELECT value FROM kv WHERE key LIKE 'development:execution:%'").all()))
    .not.toContain('test-runner')
})

it('执行代次绑定固定输入和输出目录，并把物化回执传给提供方', async () => {
  const source = join(root, 'source'), output = join(root, 'output')
  await mkdir(source); await mkdir(output)
  const identity = async (path: string) => { const info = await lstat(path, { bigint: true }); return `${info.dev}:${info.ino}` }
  const prepared: PreparedExecutionInput = { materializationId: '00000000-0000-4000-8000-000000000001',
    sourceDirectory: resolve(source), outputDirectory: resolve(output),
    sourceIdentity: await identity(source), outputIdentity: await identity(output) }
  spawn.mockImplementation((_command, _binding, _requirements, received) => {
    expect(received).toEqual(prepared)
    return process.handle
  })
  const reserved = await reserve('prepared-input')
  const started = await executions.start(binding(reserved), command, [], prepared)
  expect(started).toMatchObject({ phase: 'observing', prepared })
  expect(spawn).toHaveBeenCalledTimes(1)
})

it('主命令成功退出不能代替后代退出；受管范围结束也不冒充完整写者证明', async () => {
  const reserved = await reserve()
  await executions.start(binding(reserved), command)
  process.done.resolve({ exitCode: 0, signal: null })
  await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'observing', outcome: { kind: 'exited', exitCode: 0 },
  }))
  await expect(reserve('during-descendants')).rejects.toMatchObject({ code: 'workspace_busy' })
  process.range.resolve(true)
  await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'range_quiet', workspaceReleaseAllowed: false, scope: 'provider_managed_range',
  }))
  await expect(reserve('after-range')).rejects.toMatchObject({ code: 'workspace_busy' })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
})

it('现有取消命令在事务提交后触达进程，终止失败保留占用并继续观测', async () => {
  const reserved = await reserve()
  await executions.start(binding(reserved), command)
  process.terminate.mockImplementationOnce(() => { throw new Error('private diagnostic') })
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  expect(process.terminate).toHaveBeenCalledTimes(1)
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'observing', termination: 'unconfirmed' })
  expect(JSON.stringify(executions.get(reserved.workspaceId))).not.toContain('private diagnostic')
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  expect(process.terminate).toHaveBeenCalledTimes(2)
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
  await expect(reserve('new')).rejects.toMatchObject({ code: 'workspace_busy' })
})

it('执行意图和开始状态原子登记，保存失败保持未启动预留且能够重试', async () => {
  const reserved = await reserve()
  const set = store.set.bind(store)
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    if (String(key).startsWith('development:execution:')) throw new Error('state unavailable')
    set(key, value)
  })
  await expect(executions.start(binding(reserved), command)).rejects.toThrow('state unavailable')
  expect(spawn).not.toHaveBeenCalled()
  failure.mockRestore()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('reserved')
  expect(executions.get(reserved.workspaceId)).toBeNull()
  expect(await executions.start(binding(reserved), command)).toMatchObject({ phase: 'observing' })
  expect(spawn).toHaveBeenCalledTimes(1)
})

it('取消回滚保留正在运行的进程', async () => {
  const reserved = await reserve()
  await executions.start(binding(reserved), command)
  expect(() => store.atomic(() => {
    workspaces.command({ ...binding(reserved), action: 'cancel' })
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(process.terminate).not.toHaveBeenCalled()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
})

it('启动回执丢失、等待失败或取消观测均不释放工作区', async () => {
  const reserved = await reserve()
  spawn.mockImplementationOnce(() => { throw new Error('command and credentials must stay private') })
  expect(await executions.start(binding(reserved), command)).toMatchObject({
    phase: 'unknown', observationProblem: 'spawn_unconfirmed', workspaceReleaseAllowed: false,
  })
  await expect(reserve('retry')).rejects.toMatchObject({ code: 'workspace_busy' })
  expect(JSON.stringify(executions.get(reserved.workspaceId))).not.toContain('credentials')
})

it('等待范围异常不会成为结束回执，主命令错误只保存分类', async () => {
  const reserved = await reserve()
  await executions.start(binding(reserved), command)
  process.done.reject(new Error('secret output'))
  process.range.reject(new Error('lost range'))
  await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'unknown', observationProblem: 'range_observation_failed', outcome: { kind: 'unavailable' }, recoveryRequired: true,
  }))
  await new Promise(resolve => setImmediate(resolve))
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  expect(process.terminate).toHaveBeenCalledTimes(1)
  expect(executions.get(reserved.workspaceId)).toMatchObject({ termination: 'requested' })
  expect(JSON.stringify(executions.get(reserved.workspaceId))).not.toContain('secret')
  await expect(reserve('retry')).rejects.toMatchObject({ code: 'workspace_busy' })
})

it('关闭不被不合作的等待器挂住；晚到回执不改写关闭后的状态', async () => {
  const reserved = await reserve()
  await executions.start(binding(reserved), command)
  await executions.shutdown()
  expect(process.terminate).toHaveBeenCalledTimes(1)
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'unknown', observationProblem: 'observer_stopped' })
  const before = executions.get(reserved.workspaceId)
  process.done.resolve({ exitCode: 0, signal: null })
  process.range.resolve(true)
  await new Promise(resolve => setImmediate(resolve))
  expect(executions.get(reserved.workspaceId)).toEqual(before)
  await expect(reserve('other')).rejects.toMatchObject({ code: 'workspace_busy' })
})

it('重启保留历史观测，缺少旧句柄不能重新启动或伪造取消成功', async () => {
  const reserved = await reserve()
  await executions.start(binding(reserved), command)
  await executions.shutdown()
  store.close()
  store = new Store(join(root, 'state.sqlite'))
  workspaces = new DevelopmentWorkspaces(store, () => true)
  executions = new DevelopmentExecutions(store, workspaces, { spawn })
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'unknown', recoveryRequired: true })
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  expect(executions.get(reserved.workspaceId)).toMatchObject({ termination: 'handle_unavailable' })
  await expect(executions.start(binding(reserved), command)).rejects.toMatchObject({ code: 'operation_inactive' })
  expect(spawn).toHaveBeenCalledTimes(1)
})

it('输入错误、取消的预留和已关闭执行器不产生外部动作', async () => {
  const reserved = await reserve()
  await expect(executions.start(binding(reserved), { argv: [] })).rejects.toThrow()
  const wrongDirectory = { ...command, cwd: 'elsewhere' }
  await expect(executions.start(binding(reserved), wrongDirectory)).rejects.toThrow()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('reserved')
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  await expect(executions.start(binding(reserved), command)).rejects.toMatchObject({ code: 'operation_inactive' })
  await executions.shutdown()
  await expect(executions.start(binding(reserved), command)).rejects.toMatchObject({ code: 'runtime_unavailable' })
  expect(spawn).not.toHaveBeenCalled()
})

it('独立目录的执行互不取消，范围未确认也不能被主命令成功覆盖', async () => {
  const first = await reserve()
  const otherPath = join(root, 'other')
  await mkdir(otherPath)
  const second = await workspaces.reserve({ path: otherPath, owner: 'other', requestId: 'other', leaseMs: 60_000 })
  const other = processRange()
  spawn.mockReturnValueOnce(process.handle).mockReturnValueOnce(other.handle)
  await executions.start(binding(first), command)
  await executions.start(binding(second), command)
  workspaces.command({ ...binding(first), action: 'cancel' })
  expect(process.terminate).toHaveBeenCalledTimes(1)
  expect(other.terminate).not.toHaveBeenCalled()
  process.done.resolve({ exitCode: 0, signal: null })
  process.range.resolve(false)
  await vi.waitFor(() => expect(executions.get(first.workspaceId)).toMatchObject({
    phase: 'unknown', observationProblem: 'range_not_confirmed',
  }))
  expect(executions.get(second.workspaceId)).toMatchObject({ phase: 'observing' })
})

it('宿主更替后旧观测不能更新当前权威，即便旧句柄后来报告成功', async () => {
  const errors: unknown[] = []
  await executions.shutdown()
  executions = new DevelopmentExecutions(store, workspaces, { spawn }, error => errors.push(error))
  const reserved = await reserve()
  await executions.start(binding(reserved), command)
  const before = executions.get(reserved.workspaceId)
  const replacement = new DevelopmentWorkspaces(store, () => true)
  process.done.resolve({ exitCode: 0, signal: null })
  process.range.resolve(true)
  await vi.waitFor(() => expect(errors).toHaveLength(2))
  await executions.shutdown()
  workspaces = replacement
  executions = new DevelopmentExecutions(store, workspaces, { spawn })
  expect(executions.get(reserved.workspaceId)).toMatchObject({ ...before, recoveryRequired: true })
  expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'supervisor_stale' })]))
})

it('异步目录核验期间发生取消时，返回后重新检查而不继续启动', async () => {
  const reserved = await reserve()
  const prepare = workspaces.prepare.bind(workspaces)
  vi.spyOn(workspaces, 'prepare').mockImplementationOnce(async (input, register) => {
    const execution = await prepare(input, register)
    workspaces.command({ ...binding(reserved), action: 'cancel' })
    return execution
  })
  await expect(executions.start(binding(reserved), command)).rejects.toMatchObject({ code: 'operation_inactive' })
  expect(spawn).not.toHaveBeenCalled()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
})

it('启动后落库失败仍保留句柄，关闭会尝试终止且晚到结果不污染状态', async () => {
  const reserved = await reserve()
  const set = store.set.bind(store)
  vi.spyOn(store, 'set').mockImplementation((key, value) => {
    if (String(key).startsWith('development:execution:') && (value as { phase?: string }).phase === 'observing')
      throw new Error('write unavailable')
    set(key, value)
  })
  await expect(executions.start(binding(reserved), command)).rejects.toThrow('write unavailable')
  expect(spawn).toHaveBeenCalledTimes(1)
  vi.restoreAllMocks()
  await executions.shutdown()
  expect(process.terminate).toHaveBeenCalledTimes(1)
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'unknown', observationProblem: 'observer_stopped' })
})

it('本地 API 只读执行观测，管理取消能触达宿主作业，模型不能提交任意命令', async () => {
  host = await startRuntime(undefined, { mode: 'hmm' })
  host.subprocess.spawn.mockImplementation(() => process.handle as never)
  const reserved = await host.runtime.workspaces.reserve({ path, requestId: 'http', owner: 'developer', leaseMs: 60_000 })
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: null } })
  await runDevelopmentCommand(host.ctx, binding(reserved), command)
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: { phase: 'observing', workspaceReleaseAllowed: false } } })
  expect(await host.api('POST', 'development/workspace-command', { ...binding(reserved), action: 'cancel' }))
    .toMatchObject({ status: 200 })
  expect(process.terminate).toHaveBeenCalledTimes(1)
  expect(await host.api('POST', `development/workspaces/${reserved.workspaceId}/execution`, command))
    .toMatchObject({ status: 404 })
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: { admission: { state: 'closed', reason: 'cancelled', targetStartPrevented: true } } } })
  await host.restart()
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: { phase: 'unknown', recoveryRequired: true,
      targetResult: { state: 'not_started' }, validationPassed: false } } })
  process.done.resolve({ exitCode: 0, signal: null })
  process.range.resolve(true)
  await new Promise(resolve => setImmediate(resolve))
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: { phase: 'unknown', recoveryRequired: true } } })
})

it('Runtime 失去旧句柄后关闭未消费许可，保存回执但不自动释放 issued 目录', async () => {
  host = await startRuntime(undefined, { mode: 'hmm' })
  host.subprocess.spawn.mockImplementation(() => process.handle as never)
  const reserved = await host.runtime.workspaces.reserve({ path, requestId: 'lost-handle', owner: 'developer', leaseMs: 60_000 })
  await runDevelopmentCommand(host.ctx, binding(reserved), command)
  expect(host.runtime.developmentExecutions.get(reserved.workspaceId))
    .toMatchObject({ outcomeScope: 'trusted_launcher', admission: { state: 'offered', targetStartPrevented: false } })
  // 模拟旧控制面无法执行关闭回调；重启只能使用持久许可事实。
  vi.spyOn(host.runtime.developmentExecutions, 'shutdown').mockResolvedValue()
  await host.restart()
  expect(host.runtime.developmentExecutions.get(reserved.workspaceId)).toMatchObject({
    recoveryRequired: true, workspaceReleaseAllowed: false,
    admission: { state: 'closed', reason: 'host_restarted', targetStartPrevented: true },
  })
  expect(host.runtime.workspaces.get(reserved.workspaceId).phase).toBe('running')
})

it('Runtime 重启关闭未消费许可并复核已提交范围证据，API 展示回收且不重放目标', async () => {
  host = await startRuntime(undefined, { mode: 'hmm' })
  host.subprocess.spawn.mockImplementation(() => process.handle as never)
  const reserved = await host.runtime.workspaces.reserve({ path, requestId: 'closed-restart', owner: 'developer', leaseMs: 60_000 })
  await runDevelopmentCommand(host.ctx, binding(reserved), command)
  process.done.resolve({ exitCode: 125, signal: null })
  process.range.resolve(true)
  await vi.waitFor(() => expect(host!.runtime.developmentExecutions.get(reserved.workspaceId)).toMatchObject({
    phase: 'range_quiet', admission: { state: 'offered' },
  }))
  // 跳过旧关闭链，只允许新 Runtime 从已提交事实恢复；真实强制退出另由跨进程夹具覆盖。
  vi.spyOn(host.runtime.developmentExecutions, 'shutdown').mockResolvedValue()
  const before = host.subprocess.spawn.mock.calls.length
  await host.restart()
  expect(host.subprocess.spawn.mock.calls.length).toBe(before)
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: {
      phase: 'released_closed', workspaceReleaseAllowed: true, recoveryRequired: false,
      admission: { state: 'closed', reason: 'host_restarted' },
    } } })
  expect(host.runtime.workspaces.get(reserved.workspaceId).phase).toBe('released')
  const next = await host.runtime.workspaces.reserve({ path, requestId: 'after-restart', owner: 'next', leaseMs: 60_000 })
  expect(next.generation).toBe(reserved.generation + 1)
})

it('Runtime 与只读 API 传递创建失败依据，不把同一退出码当作目标失败或强制释放', async () => {
  host = await startRuntime(undefined, { mode: 'hmm' })
  host.subprocess.spawn.mockImplementation(spec => {
    const stdin = spec.stdio.stdin
    if (typeof stdin !== 'object') throw new Error('启动器缺少受控输入')
    consumeLaunchPermit(JSON.parse(String(stdin.data))).recordStart('rejected')
    return process.handle as never
  })
  const reserved = await host.runtime.workspaces.reserve({ path, requestId: 'start-rejected', owner: 'developer', leaseMs: 60_000 })
  await runDevelopmentCommand(host.ctx, binding(reserved), command)
  process.done.resolve({ exitCode: 125, signal: null })
  process.range.resolve(true)
  await vi.waitFor(() => expect(host!.runtime.developmentExecutions.get(reserved.workspaceId)?.phase).toBe('released_start_rejected'))
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}/execution`))
    .toMatchObject({ status: 200, body: { execution: {
      phase: 'released_start_rejected', workspaceReleaseAllowed: true,
      admission: { state: 'consumed', targetStart: { state: 'rejected' } },
      reclamation: { basis: 'target_start_rejected_range_quiet' },
    } } })
  const before = host.subprocess.spawn.mock.calls.length
  await host.restart()
  expect(host.subprocess.spawn.mock.calls.length).toBe(before)
  expect(host.runtime.developmentExecutions.get(reserved.workspaceId)).toMatchObject({
    phase: 'released_start_rejected', recoveryRequired: false,
  })
})
