import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DevelopmentWorkspaces, type WorkspaceBinding } from '../src/development/workspaces.ts'
import { DevelopmentExecutions } from '../src/development/executions.ts'
import { DevelopmentLaunchPermits } from '../src/development/launch-permits.ts'

const fixture = fileURLToPath(new URL('./fixtures/development-launch-crash.ts', import.meta.url))
let root: string, store: Store | undefined, executions: DevelopmentExecutions | undefined
const unexpectedSpawn = vi.fn((): never => { throw new Error('恢复不应重新调用执行提供方') })
function controller(point: string, behavior = 'crash') {
  const child = spawn(process.execPath, ['--experimental-transform-types', fixture, root, point, behavior], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = '', stderr = ''
  const messages: { event: string; binding?: WorkspaceBinding; code?: string }[] = []
  child.stdout!.on('data', chunk => { stdout += chunk.toString() })
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  child.on('message', message => { messages.push(message as typeof messages[number]) })
  const closed = new Promise<{ code: number | null; signal: string | null; error?: Error }>(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return { child, closed, messages, stdout: () => stdout, stderr: () => stderr }
}
let controllers: ReturnType<typeof controller>[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-launch-crash-'))
  await mkdir(join(root, 'workspace'))
  controllers = []
  unexpectedSpawn.mockClear()
})
afterEach(async () => {
  await writeFile(join(root, 'stop'), '')
  for (const controller of controllers) {
    if (controller.child.exitCode === null && controller.child.signalCode === null) controller.child.kill()
    await controller.closed
  }
  if (existsSync(join(root, 'writer')))
    await vi.waitFor(() => expect(existsSync(join(root, 'stopped'))).toBe(true), { timeout: 3000 })
  await executions?.shutdown()
  executions = undefined
  store?.close()
  store = undefined
  const target = resolve(root), parent = resolve(tmpdir())
  if (!target.startsWith(`${parent}${sep}`) || !target.split(sep).at(-1)!.startsWith('superagent-launch-crash-'))
    throw new Error('测试清理路径不属于临时工作区')
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
})
function restore() {
  store = new Store(join(root, 'state.sqlite'))
  const workspaces = new DevelopmentWorkspaces(store, () => true)
  const permits = new DevelopmentLaunchPermits(store, join(root, 'state.sqlite'),
    execution => workspaces.assertCurrent(execution), () => workspaces.assertControl())
  executions = new DevelopmentExecutions(store, workspaces, { admission: permits, spawn: unexpectedSpawn })
  return workspaces
}
async function crashAt(point: string) {
  const running = controller(point)
  controllers.push(running)
  const ended = await running.closed
  expect(ended.error, running.stderr()).toBeUndefined()
  expect(ended.code === 0 && ended.signal === null, running.stderr()).toBe(false)
  const receipt = JSON.parse(running.stdout()) as { point: string; binding: WorkspaceBinding }
  expect(receipt.point).toBe(point)
  return receipt.binding
}

it.each(['prepared', 'grant-before-commit'] as const)('真实进程在 %s 强制结束，未提交许可可恢复且不重放命令', async point => {
  const binding = await crashAt(point)
  const workspaces = restore()
  expect(executions!.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
  expect(workspaces.get(binding.workspaceId).phase).toBe('released')
  expect(executions!.get(binding.workspaceId)).toMatchObject({ phase: 'not_started', recoveryRequired: false })
  expect(existsSync(join(root, 'called'))).toBe(false)
  const next = await workspaces.reserve({ path: join(root, 'workspace'), owner: 'next', requestId: 'next', leaseMs: 1000 })
  expect(next.generation).toBe(binding.generation + 1)
  expect(unexpectedSpawn).not.toHaveBeenCalled()
})

it('真实进程在许可提交后、创建进程前退出，没有进程也不能凭猜测回收', async () => {
  const binding = await crashAt('issued')
  const workspaces = restore()
  expect(executions!.recoverUnstarted()).toEqual({ recovered: 0, retained: 0 })
  expect(existsSync(join(root, 'called'))).toBe(false)
  expect(executions!.get(binding.workspaceId)).toMatchObject({ phase: 'launching', recoveryRequired: true })
  await expect(workspaces.reserve({ path: join(root, 'workspace'), owner: 'next', requestId: 'next', leaseMs: 1000 }))
    .rejects.toMatchObject({ code: 'workspace_busy' })
  expect(unexpectedSpawn).not.toHaveBeenCalled()
})

it('控制进程被强制结束后实际写者继续运行，新宿主保留占用且不重复执行', async () => {
  const binding = await crashAt('started')
  const before = (await readFile(join(root, 'writer'))).length
  const workspaces = restore()
  expect(executions!.recoverUnstarted()).toEqual({ recovered: 0, retained: 0 })
  await vi.waitFor(async () => expect((await readFile(join(root, 'writer'))).length).toBeGreaterThan(before))
  expect(executions!.get(binding.workspaceId)).toMatchObject({ recoveryRequired: true, workspaceReleaseAllowed: false })
  await expect(workspaces.reserve({ path: join(root, 'workspace'), owner: 'other', requestId: 'other', leaseMs: 1000 }))
    .rejects.toMatchObject({ code: 'workspace_busy' })
  await writeFile(join(root, 'stop'), '')
  await vi.waitFor(() => expect(existsSync(join(root, 'stopped'))).toBe(true))
  expect(executions!.recoverUnstarted()).toEqual({ recovered: 0, retained: 0 })
  expect(workspaces.get(binding.workspaceId).phase).toBe('running')
  expect(unexpectedSpawn).not.toHaveBeenCalled()
})

it('旧控制进程在准备后暂停，新宿主回收并分配后，旧进程恢复也不能迟到启动', async () => {
  const running = controller('prepared', 'pause')
  controllers.push(running)
  await vi.waitFor(() => expect(running.messages.some(message => message.event === 'prepared')).toBe(true), { timeout: 4000 })
  const binding = running.messages.find(message => message.event === 'prepared')!.binding!
  const workspaces = restore()
  expect(executions!.recoverUnstarted()).toEqual({ recovered: 1, retained: 0 })
  const next = await workspaces.reserve({ path: join(root, 'workspace'), owner: 'next', requestId: 'next', leaseMs: 60_000 })
  running.child.send({ action: 'resume' })
  const ended = await running.closed
  expect(ended, running.stderr()).toMatchObject({ code: 0, signal: null })
  expect(running.messages).toContainEqual({ event: 'refused', code: 'supervisor_stale' })
  expect(existsSync(join(root, 'called'))).toBe(false)
  expect(workspaces.get(next.workspaceId)).toMatchObject({ phase: 'reserved', generation: binding.generation + 1 })
  expect(unexpectedSpawn).not.toHaveBeenCalled()
})

it.each(['closed-range-committed', 'closed-release-before-commit'] as const)(
  '真实进程在 %s 强制结束，重启凭完整持久证据回收且不重放目标', async point => {
    const binding = await crashAt(point)
    const workspaces = restore()
    expect(workspaces.get(binding.workspaceId).phase).toBe('cancelling')
    expect(executions!.get(binding.workspaceId)).toMatchObject({
      phase: 'range_quiet', rangeObservedAt: expect.any(Number),
      admission: { state: 'closed', targetStartPrevented: true },
      workspaceReleaseAllowed: false, recoveryRequired: true,
    })
    expect(executions!.recoverUnstarted()).toEqual({ recovered: 0, retained: 0 })
    expect(executions!.closePendingAdmissions()).toBe(0)
    expect(executions!.reclaimUncreated()).toEqual({ reclaimed: 1, retained: 0 })
    expect(executions!.get(binding.workspaceId)).toMatchObject({
      phase: 'released_closed', workspaceReleaseAllowed: true, recoveryRequired: false,
    })
    expect(executions!.reclaimUncreated()).toEqual({ reclaimed: 0, retained: 0 })
    const next = await workspaces.reserve({ path: join(root, 'workspace'), owner: 'next', requestId: 'next', leaseMs: 1000 })
    expect(next.generation).toBe(binding.generation + 1)
    expect(existsSync(join(root, 'called'))).toBe(false)
    expect(unexpectedSpawn).not.toHaveBeenCalled()
  })

it.each(['rejected-before-range', 'rejected-range-committed', 'rejected-release-before-commit'] as const)(
  '真实创建被拒后在 %s 强制退出，只有完整持久依据才可重启回收', async point => {
    const binding = await crashAt(point)
    const workspaces = restore()
    expect(executions!.get(binding.workspaceId)).toMatchObject({
      admission: { state: 'consumed', targetStart: { state: 'rejected' } }, workspaceReleaseAllowed: false,
    })
    expect(executions!.closePendingAdmissions()).toBe(0)
    const reusable = point !== 'rejected-before-range'
    expect(executions!.reclaimUncreated()).toEqual({
      reclaimed: reusable ? 1 : 0, retained: reusable ? 0 : 1,
    })
    expect(workspaces.get(binding.workspaceId).phase).toBe(reusable ? 'released' : 'running')
    const next = () => workspaces.reserve({ path: join(root, 'workspace'), owner: 'next', requestId: 'next', leaseMs: 1000 })
    if (reusable) {
      expect(executions!.get(binding.workspaceId)?.phase).toBe('released_start_rejected')
      expect((await next()).generation).toBe(binding.generation + 1)
    } else await expect(next()).rejects.toMatchObject({ code: 'workspace_busy' })
    expect(unexpectedSpawn).not.toHaveBeenCalled()
  })
