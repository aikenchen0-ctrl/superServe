import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DevelopmentExecutions, type DevelopmentExecutionPort, type ManagedExecution } from '../src/development/executions.ts'
import { executionContract, type DevelopmentExecutionRequirement } from '../src/development/execution-contract.ts'
import { DevelopmentLaunchPermits } from '../src/development/launch-permits.ts'
import { DevelopmentWorkspaces, type WorkspaceBinding } from '../src/development/workspaces.ts'
import { developmentDshPort } from '../src/executor/development-dsh.ts'
import { runDevelopmentCommand } from '../src/index.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const required: DevelopmentExecutionRequirement[] = ['atomic_range_creation', 'no_containment_fallback', 'durable_range_identity']
const command = { argv: ['test-only-command'] }
const binding = (value: WorkspaceBinding): WorkspaceBinding => ({
  workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
})
let root: string, path: string, store: Store, workspaces: DevelopmentWorkspaces, executions: DevelopmentExecutions
let guarantees: DevelopmentExecutionRequirement[] | undefined, host: Host | undefined
let spawn: ReturnType<typeof vi.fn<DevelopmentExecutionPort['spawn']>>
let range: ReturnType<typeof Promise.withResolvers<boolean>>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-execution-contract-'))
  path = join(root, 'workspace')
  await mkdir(path)
  store = new Store(join(root, 'state.sqlite'))
  workspaces = new DevelopmentWorkspaces(store, () => true)
  range = Promise.withResolvers<boolean>()
  const handle: ManagedExecution = {
    done: Promise.resolve({ exitCode: 0, signal: null }), terminate: vi.fn(), waitForExit: () => range.promise,
  }
  guarantees = undefined
  spawn = vi.fn(() => handle)
  executions = new DevelopmentExecutions(store, workspaces, { get guarantees() { return guarantees }, spawn })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await executions?.shutdown()
  await host?.stop(); host = undefined
  store?.close()
  if (root) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('测试目录不在临时目录中')
    await rm(root, { recursive: true, force: true })
  }
})
const reserve = () => workspaces.reserve({ path, owner: 'test', requestId: randomUUID(), leaseMs: 60_000 })

it.each(required)('缺少 %s 时不改变占用、不写执行记录、不调用提供方', async requirement => {
  const reserved = await reserve(), before = workspaces.get(reserved.workspaceId)
  await expect(executions.start(binding(reserved), command, [requirement]))
    .rejects.toMatchObject({ code: 'execution_guarantee_unavailable' })
  expect(workspaces.get(reserved.workspaceId)).toEqual(before)
  expect(executions.get(reserved.workspaceId)).toBeNull()
  expect(spawn).not.toHaveBeenCalled()
})

it('部分保证不能冒充全部要求，读取能力不能改变原适配器', async () => {
  guarantees = ['atomic_range_creation']
  const contract = executions.contract()
  contract.guarantees.push('durable_range_identity')
  expect(executions.contract().guarantees).toEqual(['atomic_range_creation'])
  expect(executions.contract()).toMatchObject({ evidenceScope: 'launch_contract_only',
    workspaceReleaseAllowed: false, externalWritersCovered: false })
  const reserved = await reserve()
  await expect(executions.start(binding(reserved), command, required))
    .rejects.toMatchObject({ code: 'execution_guarantee_unavailable' })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('reserved')
  expect(spawn).not.toHaveBeenCalled()
})

it.each([['unknown_requirement'], ['atomic_range_creation', 'atomic_range_creation'], null, {}].map(input => [input]))(
  '无效要求 %j 不能静默降级成普通启动', async input => {
    const reserved = await reserve()
    await expect(executions.start(binding(reserved), command, input as DevelopmentExecutionRequirement[]))
      .rejects.toMatchObject({ code: 'execution_requirements_invalid' })
    expect(executions.get(reserved.workspaceId)).toBeNull()
    expect(workspaces.get(reserved.workspaceId).phase).toBe('reserved')
    expect(spawn).not.toHaveBeenCalled()
  })

it('异步目录核验期间保证失效，登记事务回滚且不发许可', async () => {
  guarantees = [...required]
  const original = workspaces.prepare.bind(workspaces)
  vi.spyOn(workspaces, 'prepare').mockImplementation(async (...args) => {
    guarantees = []
    return original(...args)
  })
  const reserved = await reserve(), before = workspaces.get(reserved.workspaceId)
  await expect(executions.start(binding(reserved), command, required))
    .rejects.toMatchObject({ code: 'execution_guarantee_unavailable' })
  expect(workspaces.get(reserved.workspaceId)).toEqual(before)
  expect(executions.get(reserved.workspaceId)).toBeNull()
  expect(spawn).not.toHaveBeenCalled()
})

it('准备提交后能力失效，不发启动许可，原未启动恢复可释放占用', async () => {
  guarantees = [...required]
  const set = store.set.bind(store)
  vi.spyOn(store, 'set').mockImplementation((key, value) => {
    set(key, value)
    if (String(key).startsWith('development:execution:') && (value as { phase?: string }).phase === 'prepared')
      guarantees = []
  })
  const reserved = await reserve()
  await expect(executions.start(binding(reserved), command, required))
    .rejects.toMatchObject({ code: 'execution_guarantee_unavailable' })
  expect(executions.get(reserved.workspaceId)).toMatchObject({ phase: 'prepared', workspaceReleaseAllowed: false })
  expect(spawn).not.toHaveBeenCalled()
  expect(executions.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
})

it('无效提供方声明不能因普通调用没有强要求而被接受', async () => {
  guarantees = ['unrecognized-provider-claim'] as unknown as DevelopmentExecutionRequirement[]
  const reserved = await reserve()
  await expect(executions.start(binding(reserved), command)).rejects.toMatchObject({ code: 'execution_contract_invalid' })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('reserved')
  expect(spawn).not.toHaveBeenCalled()
})

it('提交后能力失效不调用弱执行入口，已发许可占用保留待核验', async () => {
  guarantees = [...required]
  const callbacks: (() => void)[] = []
  vi.spyOn(store, 'afterCommit').mockImplementation(callback => callbacks.push(callback))
  const reserved = await reserve()
  const start = executions.start(binding(reserved), command, required)
  await vi.waitFor(() => expect(callbacks).toHaveLength(1))
  guarantees = []
  callbacks[0]!()
  expect(await start).toMatchObject({ phase: 'unknown', observationProblem: 'spawn_unconfirmed',
    workspaceReleaseAllowed: false })
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  expect(spawn).not.toHaveBeenCalled()
})

it('固定调用要求传给本次执行，调用方随后修改数组不能放宽要求；能力不授权回收', async () => {
  guarantees = [...required]
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
  const original = workspaces.prepare.bind(workspaces)
  vi.spyOn(workspaces, 'prepare').mockImplementation(async (...args) => {
    entered.resolve()
    await proceed.promise
    return original(...args)
  })
  const reserved = await reserve(), requested = [...required]
  const start = executions.start(binding(reserved), command, requested)
  await entered.promise
  requested.length = 0
  proceed.resolve()
  await start
  expect(spawn.mock.calls[0]![2]).toEqual(required)
  expect(Object.isFrozen(spawn.mock.calls[0]![2])).toBe(true)
  range.resolve(true)
  await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
    phase: 'range_quiet', workspaceReleaseAllowed: false,
  }))
  expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
})

it.each([false, true])('DSH 适配器自身拒绝强保证，可信启动器=%s，许可与目标均不产生', async guarded => {
  const permits = new DevelopmentLaunchPermits(store, join(root, 'state.sqlite'), () => {}, () => {})
  const offer = vi.spyOn(permits, 'offer')
  const provider = { spawn: vi.fn() }
  const port = developmentDshPort(provider, guarded ? { permits, argv: ['test-runner'], cwd: root } : undefined)
  expect(executionContract(port.guarantees).guarantees).toEqual([])
  const input = { workspaceId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(), generation: 1 }
  for (const requirement of required) expect(() => port.spawn({ ...command, cwd: path }, input, [requirement]))
    .toThrow(expect.objectContaining({ code: 'execution_guarantee_unavailable' }))
  expect(provider.spawn).not.toHaveBeenCalled()
  expect(offer).not.toHaveBeenCalled()
})

it('管理 API 可读能力但不能改写保证或启动，可信调用拒绝后占用不变', async () => {
  host = await startRuntime(undefined, { mode: 'hmm' })
  expect(await host.api('GET', 'development/execution-contract')).toMatchObject({
    status: 200, body: { guarantees: [], evidenceScope: 'launch_contract_only',
      externalWritersCovered: false, workspaceReleaseAllowed: false },
  })
  expect(await host.api('POST', 'development/execution-contract', { guarantees: required })).toMatchObject({ status: 404 })
  const reserved = await host.runtime.workspaces.reserve({ path, owner: 'test', requestId: 'runtime', leaseMs: 60_000 })
  await expect(runDevelopmentCommand(host.ctx, binding(reserved), command, required))
    .rejects.toMatchObject({ code: 'execution_guarantee_unavailable' })
  expect(host.runtime.workspaces.get(reserved.workspaceId).phase).toBe('reserved')
  expect(host.runtime.developmentExecutions.get(reserved.workspaceId)).toBeNull()
  expect(host.subprocess.spawn).not.toHaveBeenCalled()
})
