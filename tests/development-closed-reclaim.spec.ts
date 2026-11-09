import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DevelopmentExecutions } from '../src/development/executions.ts'
import { DevelopmentLaunchPermits, consumeLaunchPermit, type RunnerEnvelope } from '../src/development/launch-permits.ts'
import { DevelopmentWorkspaces, type WorkspaceBinding } from '../src/development/workspaces.ts'

let root: string, path: string, store: Store, workspaces: DevelopmentWorkspaces
let permits: DevelopmentLaunchPermits, executions: DevelopmentExecutions, envelope: RunnerEnvelope
let done: ReturnType<typeof Promise.withResolvers<{ exitCode: number | null; signal: string | null }>>
let range: ReturnType<typeof Promise.withResolvers<boolean>>
let errors: unknown[], available: boolean, now: number
const command = { argv: ['never-executed-test-command'] }
const binding = (value: WorkspaceBinding): WorkspaceBinding => ({
  workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
})
function createExecutions(outcomeScope: 'provider_command' | 'trusted_launcher' = 'trusted_launcher') {
  const manager = workspaces
  permits = new DevelopmentLaunchPermits(store, join(root, 'state.sqlite'),
    value => manager.assertCurrent(value), () => manager.assertControl())
  executions = new DevelopmentExecutions(store, manager, {
    admission: permits, outcomeScope,
    spawn(input, execution) {
      envelope = permits.offer(execution, { argv: input.argv }, input.cwd)
      return { done: done.promise, waitForExit: () => range.promise, terminate() {} }
    },
  }, error => errors.push(error), () => now)
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-closed-reclaim-'))
  path = join(root, 'workspace')
  await mkdir(path)
  store = new Store(join(root, 'state.sqlite'))
  available = true
  now = Date.now()
  errors = []
  done = Promise.withResolvers()
  range = Promise.withResolvers()
  workspaces = new DevelopmentWorkspaces(store, () => available, () => now)
  createExecutions()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await executions.shutdown()
  store.close()
  const target = resolve(root), parent = resolve(tmpdir())
  if (!target.startsWith(`${parent}${sep}`) || !target.split(sep).at(-1)!.startsWith('superagent-closed-reclaim-'))
    throw new Error('测试清理目录不属于本用例')
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
})
async function start() {
  const reserved = await workspaces.reserve({ path, requestId: 'one', owner: 'developer', leaseMs: 60_000 })
  await executions.start(binding(reserved), command)
  return reserved
}
const next = () => workspaces.reserve({ path, requestId: 'next', owner: 'next', leaseMs: 60_000 })
async function quiet() {
  done.resolve({ exitCode: 125, signal: null })
  range.resolve(true)
  await new Promise(resolve => setImmediate(resolve))
}

it('关闭许可不足以回收，正向范围结束证据保存后原子释放并允许新代次', async () => {
  const reserved = await start()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  done.resolve({ exitCode: 125, signal: null })
  await new Promise(resolve => setImmediate(resolve))
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  await expect(next()).rejects.toMatchObject({ code: 'workspace_busy' })
  range.resolve(true)
  await vi.waitFor(() => expect(workspaces.get(reserved.workspaceId).phase).toBe('released'))
  expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'released_closed', rangeObservedAt: now, workspaceReleaseAllowed: true, recoveryRequired: false,
    reclamation: { basis: 'target_closed_range_quiet', releasedAt: now },
  })
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 0 })
  expect((await next()).generation).toBe(reserved.generation + 1)
  expect(errors).toEqual([])
})

it('先观察范围结束后取消，同样可回收，不能依赖事件先后顺序', async () => {
  const reserved = await start()
  await quiet()
  expect(executions.get(reserved.workspaceId)?.phase).toBe('range_quiet')
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  now += 1000
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
  expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'released_closed', updatedAt: now, rangeObservedAt: now - 1000,
    reclamation: { releasedAt: now },
  })
})

it('消费过的许可即使范围结束并取消，也不能被当作目标从未启动', async () => {
  const reserved = await start()
  consumeLaunchPermit(envelope)
  await quiet()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
  expect(executions.get(reserved.workspaceId)).toMatchObject({ admission: { state: 'consumed' }, workspaceReleaseAllowed: false })
  await expect(next()).rejects.toMatchObject({ code: 'workspace_busy' })
})

it('普通命令的范围结束不能替代可信启动器证据，即使同时存在关闭的目标许可', async () => {
  await executions.shutdown()
  createExecutions('provider_command')
  const reserved = await start()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  await quiet()
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'range_quiet', outcomeScope: 'provider_command', admission: { state: 'closed' }, workspaceReleaseAllowed: false,
  })
  await expect(next()).rejects.toMatchObject({ code: 'workspace_busy' })
})

it.each([false, 'rejected'] as const)('范围观测为 %s 时关闭许可仍保留占用', async result => {
  const reserved = await start()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  done.resolve({ exitCode: 125, signal: null })
  if (result === false) range.resolve(false)
  else range.reject(new Error('范围无法观测'))
  await vi.waitFor(() => expect(executions.get(reserved.workspaceId)?.phase).toBe('unknown'))
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
})

it.each(['receipt', 'workspace'] as const)('回收 %s 写入失败时整笔回滚，持久范围证据可重启重试', async failurePoint => {
  const reserved = await start()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  const set = store.set.bind(store)
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    set(key, value)
    const record = value as { phase?: string }
    if ((failurePoint === 'receipt' && String(key).startsWith('development:execution:') && record.phase === 'released_closed')
      || (failurePoint === 'workspace' && String(key).startsWith('development:workspace:') && record.phase === 'released'))
      throw new Error('release write failed')
  })
  await quiet()
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'range_quiet', rangeObservedAt: now })
  failure.mockRestore()
  // 不执行旧关闭链，模拟持久证据保存后控制进程失去状态。
  const old = executions
  store.close()
  store = new Store(join(root, 'state.sqlite'))
  workspaces = new DevelopmentWorkspaces(store, () => available, () => now)
  createExecutions()
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 1, retained: 0 })
  const released = executions.get(reserved.workspaceId)
  expect(released).toMatchObject({ phase: 'released_closed', recoveryRequired: false, workspaceReleaseAllowed: true })
  await old.shutdown()
  expect(executions.get(reserved.workspaceId)).toEqual(released)
  expect((await next()).generation).toBe(reserved.generation + 1)
})

it('正向观测落库失败不能回收，丢失内存句柄后仍需要补证', async () => {
  const reserved = await start()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  const set = store.set.bind(store)
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    if (String(key).startsWith('development:execution:') && (value as { phase?: string }).phase === 'range_quiet')
      throw new Error('observation write failed')
    set(key, value)
  })
  await quiet()
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
  failure.mockRestore()
  await executions.shutdown()
  workspaces = new DevelopmentWorkspaces(store, () => true)
  createExecutions()
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
})

it('旧版本的 range_quiet 没有新版范围证据，不能升级为可回收', async () => {
  const reserved = await start()
  await quiet()
  store.db.prepare("UPDATE kv SET value=json_remove(json_set(value,'$.schemaVersion',2),'$.rangeObservedAt') WHERE key=?")
    .run(`development:execution:${reserved.operationId}`)
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
})

it('旧宿主迟到观测不能释放新控制面的占用，后续代次也不受旧结果影响', async () => {
  const reserved = await start()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  const old = executions
  workspaces = new DevelopmentWorkspaces(store, () => true)
  createExecutions()
  await quiet()
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
  await old.shutdown()
})

it('范围先结束后重启，关闭仍 offered 的许可并凭持久证据回收', async () => {
  const reserved = await start()
  await quiet()
  const old = executions
  workspaces = new DevelopmentWorkspaces(store, () => true)
  createExecutions()
  expect(executions.closePendingAdmissions()).toBe(1)
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 1, retained: 0 })
  await old.shutdown()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
})

it('关闭期间可利用已持久范围证据回收，但不等待未来可能到来的范围结果', async () => {
  const reserved = await start()
  await quiet()
  available = false
  await executions.shutdown()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'released_closed', workspaceReleaseAllowed: true })
})

it('范围证明后已释放并分配新代次，旧主命令的迟到结果不改变新占用或历史回收依据', async () => {
  const reserved = await start()
  range.resolve(true)
  await vi.waitFor(() => expect(executions.get(reserved.workspaceId)?.phase).toBe('range_quiet'))
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  const history = () => store.db.prepare('SELECT value FROM kv WHERE key=?')
    .get(`development:execution:${reserved.operationId}`)?.value
  const released = history()
  const current = await next()
  done.resolve({ exitCode: 125, signal: null })
  await vi.waitFor(() => expect(errors).toContainEqual(expect.objectContaining({ code: 'operation_stale' })))
  expect(history()).toBe(released)
  expect(workspaces.get(current.workspaceId)).toEqual(current)
  expect(executions.get(current.workspaceId)).toBeNull()
})

it('回收首次失败但范围证据仍有效，关闭重试不会把 released_closed 降为未知', async () => {
  const reserved = await start()
  workspaces.command({ ...binding(reserved), action: 'cancel' })
  const set = store.set.bind(store)
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    if (String(key).startsWith('development:execution:') && (value as { phase?: string }).phase === 'released_closed')
      throw new Error('receipt unavailable')
    set(key, value)
  })
  await quiet()
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
  failure.mockRestore()
  available = false
  await executions.shutdown()
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
  expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'released_closed', workspaceReleaseAllowed: true, recoveryRequired: false,
  })
})

it('目标拒绝创建回执不能单独释放，范围结束后无需取消即可原子回收', async () => {
  const reserved = await start()
  consumeLaunchPermit(envelope).recordStart('rejected')
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  await expect(next()).rejects.toMatchObject({ code: 'workspace_busy' })
  await quiet()
  expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'released_start_rejected', workspaceReleaseAllowed: true, recoveryRequired: false,
    admission: { state: 'consumed', targetStart: { state: 'rejected' } },
    reclamation: { basis: 'target_start_rejected_range_quiet' },
  })
  expect((await next()).generation).toBe(reserved.generation + 1)
})

it('目标已经创建，即使退出码为 125 且范围结束，仍需完整写者证明', async () => {
  const reserved = await start()
  consumeLaunchPermit(envelope).recordStart('spawned')
  await quiet()
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 1 })
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'range_quiet', workspaceReleaseAllowed: false })
  await expect(next()).rejects.toMatchObject({ code: 'workspace_busy' })
})

it('版本 3 的有效范围证据可组合消费方补交的创建回执，不强制重跑已确认观测', async () => {
  const reserved = await start()
  consumeLaunchPermit(envelope).recordStart('rejected')
  store.db.prepare("UPDATE kv SET value=json_set(value,'$.schemaVersion',3) WHERE key=?")
    .run(`development:execution:${reserved.operationId}`)
  await quiet()
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 0 })
  expect(executions.get(reserved.workspaceId)?.phase).toBe('released_start_rejected')
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
})

it('拒绝创建的回收事务失败会整体回滚，重启只复核持久证据不重放目标', async () => {
  const reserved = await start()
  consumeLaunchPermit(envelope).recordStart('rejected')
  const set = store.set.bind(store)
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    set(key, value)
    if (String(key).startsWith('development:workspace:') && (value as { phase?: string }).phase === 'released')
      throw new Error('workspace release unavailable')
  })
  await quiet()
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  expect(executions.get(reserved.workspaceId)?.phase).toBe('range_quiet')
  failure.mockRestore()
  const old = executions
  workspaces = new DevelopmentWorkspaces(store, () => true)
  createExecutions()
  expect(executions.closePendingAdmissions()).toBe(0)
  expect(executions.reclaimUncreated()).toEqual({ reclaimed: 1, retained: 0 })
  await old.shutdown()
  expect(executions.get(reserved.workspaceId)?.phase).toBe('released_start_rejected')
  expect((await next()).generation).toBe(reserved.generation + 1)
})
