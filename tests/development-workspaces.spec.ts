import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DevelopmentWorkspaces, type WorkspaceBinding } from '../src/development/workspaces.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let directory: string, path: string, store: Store, manager: DevelopmentWorkspaces, now: number
let host: Host | undefined
const binding = (value: WorkspaceBinding): WorkspaceBinding => ({
  workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
})
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'superagent-workspaces-'))
  path = join(directory, 'workspace')
  await mkdir(path)
  now = 1000
  store = new Store(join(directory, 'state.sqlite'))
  manager = new DevelopmentWorkspaces(store, () => true, () => now)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await host?.stop()
  host = undefined
  store.close()
  // 仅清理由本用例创建的临时根，避免路径改动扩展清理范围。
  const root = resolve(directory), parent = resolve(tmpdir())
  if (!root.startsWith(`${parent}${sep}`) || !root.split(sep).at(-1)!.startsWith('superagent-workspaces-'))
    throw new Error('Unsafe test cleanup target')
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
const reserve = (requestId: string, target = path, owner = 'developer') =>
  manager.reserve({ path: target, owner, requestId, leaseMs: 1000 })

it('并发申请同一目录只有一个成功；幂等重放不续期也不重开占用', async () => {
  const results = await Promise.allSettled([reserve('first'), reserve('second')])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const success = results.find(result => result.status === 'fulfilled')!
  if (success.status !== 'fulfilled') throw new Error('Expected a reservation')
  const requestId = results[0]!.status === 'fulfilled' ? 'first' : 'second'
  const reserved = success.value
  now += 50
  expect(await reserve(requestId)).toEqual(reserved)
  await expect(reserve(requestId, path, 'optimizer')).rejects.toMatchObject({ code: 'request_conflict' })
  expect(manager.command({ ...binding(reserved), action: 'abandon' }).phase).toBe('released')
  expect((await reserve(requestId)).phase).toBe('released')
  expect((await reserve('next')).generation).toBe(reserved.generation + 1)
  await expect(reserve(requestId)).rejects.toMatchObject({ code: 'operation_stale' })
})

it('父子目录和路径别名互斥，兄弟目录不被错误拒绝', async () => {
  const child = join(path, 'child'), sibling = join(directory, 'workspace-other'), alias = join(directory, 'alias')
  await mkdir(child)
  await mkdir(sibling)
  await symlink(path, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const reserved = await reserve('parent')
  await expect(reserve('child', child)).rejects.toMatchObject({ code: 'workspace_busy' })
  await expect(reserve('alias', alias)).rejects.toMatchObject({ code: 'workspace_busy' })
  await expect(reserve('ancestor', directory)).rejects.toMatchObject({ code: 'workspace_busy' })
  expect((await reserve('sibling', sibling)).phase).toBe('reserved')
  manager.command({ ...binding(reserved), action: 'abandon' })
  expect((await reserve('child-now', child)).phase).toBe('reserved')
  await expect(reserve('parent-again')).rejects.toMatchObject({ code: 'workspace_busy' })
})

it('预留过期不释放目录，不允许续期复活；尚未启动的预留可以显式放弃', async () => {
  const reserved = await reserve('held')
  now = reserved.expiresAt
  expect(manager.get(reserved.workspaceId)).toMatchObject({ expired: true, phase: 'reserved' })
  await expect(reserve('other')).rejects.toMatchObject({ code: 'workspace_busy' })
  expect(() => manager.command({ ...binding(reserved), action: 'renew', leaseMs: 5000 }))
    .toThrow('已过期')
  await expect(manager.begin(binding(reserved))).rejects.toMatchObject({ code: 'operation_inactive' })
  manager.command({ ...binding(reserved), action: 'cancel' })
  await expect(reserve('still-blocked')).rejects.toMatchObject({ code: 'workspace_busy' })
  manager.command({ ...binding(reserved), action: 'abandon' })
  expect((await reserve('after-abandon')).phase).toBe('reserved')
})

it('在途作业即使租约过期和取消仍占目录，退出并由宿主确认后才允许新执行', async () => {
  const reserved = await reserve('writer')
  const execution = await manager.begin(binding(reserved))
  const file = join(path, 'writer.txt')
  const child = spawn(process.execPath, ['-e',
    'const fs=require("node:fs");let n=0;const file=process.argv[1];const timer=setInterval(()=>{fs.writeFileSync(file,String(++n));if(n===1)process.stdout.write("ready");},10);process.stdin.once("data",()=>{clearInterval(timer);process.exit(0)});',
    file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  try {
    await once(child.stdout, 'data')
    now = reserved.expiresAt + 1
    manager.command({ ...binding(reserved), action: 'cancel' })
    expect(child.exitCode).toBeNull()
    expect(await readFile(file, 'utf8')).not.toBe('')
    expect(() => manager.assertCurrent(execution)).toThrow('拒绝新的受控写入')
    expect(() => manager.command({ ...binding(reserved), action: 'abandon' }))
      .toThrow('只能由执行宿主核验结束')
    await expect(reserve('unsafe-retry')).rejects.toMatchObject({ code: 'workspace_busy' })
    child.stdin.end('stop')
    await exited
    expect(manager.confirmStopped(execution).phase).toBe('released')
    const next = await reserve('safe-retry')
    expect(next.generation).toBe(reserved.generation + 1)
    expect(() => manager.confirmStopped(execution)).toThrow('执行代次已变化')
  } finally {
    if (child.exitCode === null) { child.kill(); await exited }
  }
})

it('宿主重启保留正在运行的占用，旧控制实例和新实例都不能冒充旧执行已结束', async () => {
  const reserved = await reserve('running')
  const execution = await manager.begin(binding(reserved))
  const oldManager = manager
  // 同一 Store 上切换监督实例检验 fencing；随后关闭重开检验持久恢复。
  manager = new DevelopmentWorkspaces(store, () => true, () => now)
  expect(() => oldManager.confirmStopped(execution)).toThrow('旧控制实例')
  expect(() => oldManager.assertCurrent(execution)).toThrow('旧控制实例')
  expect(() => manager.confirmStopped(execution)).toThrow('不是当前宿主')
  expect(manager.get(reserved.workspaceId)).toMatchObject({ phase: 'running', recoveryRequired: true })
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  manager = new DevelopmentWorkspaces(store, () => true, () => now)
  now += 10_000
  expect(manager.get(reserved.workspaceId)).toMatchObject({ phase: 'running', recoveryRequired: true, expired: true })
  await expect(reserve('new-writer')).rejects.toMatchObject({ code: 'workspace_busy' })
  expect(() => manager.command({ ...binding(reserved), action: 'abandon' })).toThrow('只能由执行宿主')
})

it('预留和开始执行共同受事务约束，保存失败不留下半条占用或假的已启动状态', async () => {
  const set = store.set.bind(store)
  const failReceipt = vi.spyOn(store, 'set').mockImplementation((key, value) => {
    set(key, value)
    if (String(key).startsWith('development:workspace-request:')) throw new Error('receipt write failure')
  })
  await expect(reserve('transaction')).rejects.toThrow('receipt write failure')
  failReceipt.mockRestore()
  expect(manager.list().items).toHaveLength(0)
  const reserved = await reserve('transaction')
  const failBegin = vi.spyOn(store, 'set').mockImplementationOnce((key, value) => {
    set(key, value); throw new Error('begin write failure')
  })
  await expect(manager.begin(binding(reserved))).rejects.toThrow('begin write failure')
  failBegin.mockRestore()
  expect(manager.get(reserved.workspaceId).phase).toBe('reserved')
  expect(manager.command({ ...binding(reserved), action: 'abandon' }).phase).toBe('released')
})

it('有效续期不缩短时间，开始执行不重复，旧代次和伪造命令无法释放或改变占用', async () => {
  const reserved = await reserve('active')
  const extended = manager.command({ ...binding(reserved), action: 'renew', leaseMs: 5000 })
  expect(extended.expiresAt).toBe(now + 5000)
  expect(manager.command({ ...binding(reserved), action: 'renew', leaseMs: 1 }).expiresAt).toBe(extended.expiresAt)
  const execution = await manager.begin(binding(reserved))
  expect(() => manager.assertCurrent(execution)).not.toThrow()
  await expect(manager.begin(binding(reserved))).rejects.toMatchObject({ code: 'operation_inactive' })
  expect(() => manager.command({ ...binding(reserved), generation: reserved.generation + 1, action: 'cancel' }))
    .toThrow('执行代次已变化')
  expect(() => manager.command({ ...binding(reserved), action: 'confirmStopped', stopped: true })).toThrow()
  manager.command({ ...binding(reserved), action: 'cancel' })
  expect(() => manager.command({ ...binding(reserved), action: 'renew', leaseMs: 5000 })).toThrow()
  manager.confirmStopped(execution)
  expect(manager.confirmStopped(execution).phase).toBe('released')
})

it('预留后目录被替换时拒绝启动，原占用不会因路径相同而绑定新目录', async () => {
  const reserved = await reserve('replacement')
  const retained = join(directory, 'retained')
  await rename(path, retained)
  await mkdir(path)
  await expect(manager.begin(binding(reserved))).rejects.toMatchObject({ code: 'workspace_changed' })
  await expect(reserve('replacement')).rejects.toMatchObject({ code: 'request_conflict' })
  await expect(reserve('new-directory')).rejects.toMatchObject({ code: 'workspace_busy' })
  expect(manager.get(reserved.workspaceId).phase).toBe('reserved')
  manager.command({ ...binding(reserved), action: 'abandon' })
  expect((await reserve('new-directory')).phase).toBe('reserved')
})

it('启动前取消不可再开始，未开始预留跨重启仍可安全放弃但旧实例不可操作', async () => {
  const reserved = await reserve('cancel-before-start')
  manager.command({ ...binding(reserved), action: 'cancel' })
  await expect(manager.begin(binding(reserved))).rejects.toMatchObject({ code: 'operation_inactive' })
  const old = manager
  manager = new DevelopmentWorkspaces(store, () => true, () => now)
  expect(() => old.command({ ...binding(reserved), action: 'abandon' })).toThrow('旧控制实例')
  expect(manager.command({ ...binding(reserved), action: 'abandon' }).phase).toBe('released')
  expect((await reserve('cancel-before-start')).phase).toBe('released')
})

it('结束确认落库失败时仍占用，恢复写入后同一宿主可以重试确认', async () => {
  const reserved = await reserve('release-transaction')
  const execution = await manager.begin(binding(reserved))
  const original = store.set.bind(store)
  const failed = vi.spyOn(store, 'set').mockImplementationOnce((key, value) => {
    original(key, value); throw new Error('release write failure')
  })
  expect(() => manager.confirmStopped(execution)).toThrow('release write failure')
  failed.mockRestore()
  expect(manager.get(reserved.workspaceId).phase).toBe('running')
  await expect(reserve('next')).rejects.toMatchObject({ code: 'workspace_busy' })
  expect(manager.confirmStopped(execution).phase).toBe('released')
  expect((await reserve('next')).phase).toBe('reserved')
})

it('列举有界且只读，路径和参数错误明确拒绝，不创建目录或启动任何任务', async () => {
  const reserved = await reserve('one')
  const before = manager.get(reserved.workspaceId)
  expect(manager.list({ limit: 1 })).toEqual({ items: [before], nextOffset: null })
  expect(manager.list({ offset: 1 })).toEqual({ items: [], nextOffset: null })
  expect(() => manager.list({ limit: 51 })).toThrow()
  expect(() => manager.list({ privateState: true })).toThrow()
  expect(manager.get(reserved.workspaceId)).toEqual(before)
  await expect(reserve('missing', join(directory, 'not-created'))).rejects.toMatchObject({ code: 'path_unavailable' })
  await expect(reserve('relative', 'workspace')).rejects.toMatchObject({ code: 'path_invalid' })
  await writeFile(join(directory, 'file'), '')
  await expect(reserve('file', join(directory, 'file'))).rejects.toMatchObject({ code: 'path_invalid' })
})

it('本地 HTTP 接入真实 Runtime，不能伪造开始或结束确认，重启仍保留预留', async () => {
  host = await startRuntime(undefined, { mode: 'hmm' })
  const response = await host.api('POST', 'development/workspaces', { path, requestId: 'api', owner: 'module-author', leaseMs: 1000 })
  expect(response.status).toBe(200)
  const reserved = binding(response.body as unknown as WorkspaceBinding)
  expect(await host.api('GET', 'development/workspaces?limit=1'))
    .toMatchObject({ status: 200, body: { items: [{ ...reserved, phase: 'reserved' }], nextOffset: null } })
  expect(await host.api('POST', 'development/workspace-command', { ...reserved, action: 'begin' }))
    .toMatchObject({ status: 400 })
  expect(await host.api('POST', 'development/workspace-command', { ...reserved, action: 'confirmStopped' }))
    .toMatchObject({ status: 400 })
  expect(host.nodeFactory).not.toHaveBeenCalled()
  await host.restart()
  expect(await host.api('GET', `development/workspaces/${reserved.workspaceId}`))
    .toMatchObject({ status: 200, body: { ...reserved, phase: 'reserved' } })
  expect(await host.api('POST', 'development/workspace-command', { ...reserved, action: 'abandon' }))
    .toMatchObject({ status: 200, body: { phase: 'released' } })
  expect(host.nodeFactory).not.toHaveBeenCalled()
})
