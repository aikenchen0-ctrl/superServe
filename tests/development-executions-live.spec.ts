import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Store } from '../src/app/store.ts'
import { DevelopmentWorkspaces, type WorkspaceBinding } from '../src/development/workspaces.ts'
import { DevelopmentExecutions, type ManagedExecution } from '../src/development/executions.ts'
import { developmentDshPort } from '../src/executor/development-dsh.ts'
import { DevelopmentLaunchPermits } from '../src/development/launch-permits.ts'

// 显式指定已有 DSH 安装，未指定时报告跳过；不安装、升级或加载用户的在线配置。
const installation = process.env.SUPERSERVE_TEST_DSH_INSTALL
describe.skipIf(!installation)('本机真实 DSH 进程监督', () => {
  let context: { fiber: { dispose(): Promise<void> } }, provider: SubprocessRuntime
  let root: string, path: string, stopFile: string, store: Store
  let workspaces: DevelopmentWorkspaces, executions: DevelopmentExecutions
  let handles: ManagedExecution[]
  const binding = (value: WorkspaceBinding): WorkspaceBinding => ({
    workspaceId: value.workspaceId, operationId: value.operationId, generation: value.generation,
  })
  beforeAll(async () => {
    const require = createRequire(join(resolve(installation!), 'package.json'))
    const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
    const subprocess = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess-local')).href)
    context = new cordis.Context()
    provider = new subprocess.LocalSubprocessRuntime(context)
  }, 30_000)
  afterAll(async () => { await context?.fiber.dispose() })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'superagent-executions-live-'))
    path = join(root, 'workspace')
    await mkdir(path)
    stopFile = join(path, 'stop')
    store = new Store(join(root, 'state.sqlite'))
    workspaces = new DevelopmentWorkspaces(store, () => true)
    handles = []
    const port = developmentDshPort(provider)
    executions = new DevelopmentExecutions(store, workspaces, {
      spawn: (command, binding) => { const handle = port.spawn(command, binding); handles.push(handle); return handle },
    })
  })
  afterEach(async () => {
    if (!root) return
    // 独立停止文件也约束测试写者，提供方能力不足时不能遗留测试进程。
    await writeFile(stopFile, '')
    for (const handle of handles) handle.terminate()
    await Promise.all(handles.map(handle => handle.waitForExit(AbortSignal.timeout(3000))))
    await executions.shutdown()
    store.close()
    const target = resolve(root), parent = resolve(tmpdir())
    if (!target.startsWith(`${parent}${sep}`) || !target.split(sep).at(-1)!.startsWith('superagent-executions-live-'))
      throw new Error('测试清理路径不属于临时工作区')
    await rm(target, { recursive: true, force: true, maxRetries: 3 })
  })
  const writer = [
    'const fs = require("node:fs");',
    'const [file, stop] = process.argv.slice(1); let count = 0;',
    'const timer = setInterval(() => {',
    '  if (fs.existsSync(stop)) { clearInterval(timer); process.exit(0); }',
    '  fs.appendFileSync(file, "x");',
    '  if (++count === 1 && process.stdout.writable) process.stdout.write("ready");',
    '}, 20);',
  ].join('\n')

  it('真实主命令退出后仍跟踪其持续写入的后代，范围结束后仍不签发目录释放许可', async () => {
    const file = join(path, 'descendant.txt')
    const parent = [
      'const { spawn } = require("node:child_process");',
      'const [source, file, stop] = process.argv.slice(1);',
      'const child = spawn(process.execPath, ["-e", source, file, stop],',
      '  { detached: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });',
      'child.stdout.once("data", () => process.exit(0));',
    ].join('\n')
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'descendant', leaseMs: 60_000 })
    await executions.start(binding(reserved), { argv: [process.execPath, '-e', parent, writer, file, stopFile] })
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: 'observing', outcome: { kind: 'exited', exitCode: 0 },
    }), { timeout: 4000 })
    const before = (await readFile(file)).length
    await vi.waitFor(async () => expect((await readFile(file)).length).toBeGreaterThan(before))
    await writeFile(stopFile, '')
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: 'range_quiet', workspaceReleaseAllowed: false,
    }), { timeout: 4000 })
    expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  })

  it('已有取消入口终止真实写入命令，关闭和终止观测不伪造工作区空闲', async () => {
    const file = join(path, 'writer.txt')
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'cancel', leaseMs: 60_000 })
    await executions.start(binding(reserved), { argv: [process.execPath, '-e', writer, file, stopFile] })
    await vi.waitFor(async () => expect((await readFile(file)).length).toBeGreaterThan(0), { timeout: 4000 })
    workspaces.command({ ...binding(reserved), action: 'cancel' })
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: 'range_quiet', termination: 'requested',
    }), { timeout: 4000 })
    expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
    await expect(workspaces.reserve({ path, owner: 'other', requestId: 'repeat', leaseMs: 1000 }))
      .rejects.toMatchObject({ code: 'workspace_busy' })
  })

  it('真实 DSH 适配器不把可启动当作可恢复；强保证请求先拒绝且不产生目标', async () => {
    await guarded()
    const called = vi.spyOn(provider, 'spawn')
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'required-contract', leaseMs: 60_000 })
    await expect(executions.start(binding(reserved), {
      argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("unexpected", "unexpected")'],
    }, ['atomic_range_creation', 'no_containment_fallback', 'durable_range_identity']))
      .rejects.toMatchObject({ code: 'execution_guarantee_unavailable' })
    expect(called).not.toHaveBeenCalled()
    expect(executions.get(reserved.workspaceId)).toBeNull()
    expect(workspaces.get(reserved.workspaceId).phase).toBe('reserved')
    expect(existsSync(join(path, 'unexpected'))).toBe(false)
    called.mockRestore()
  })

  async function guarded(built = false, beforeSpawn: () => void = () => {}) {
    await executions.shutdown()
    const permits = new DevelopmentLaunchPermits(store, join(root, 'state.sqlite'),
      binding => workspaces.assertCurrent(binding), () => workspaces.assertControl())
    const port = developmentDshPort({ spawn: spec => { beforeSpawn(); return provider.spawn(spec) } }, {
      permits, argv: built ? [process.execPath, fileURLToPath(new URL('../lib/development-runner.js', import.meta.url))]
        : [process.execPath, '--experimental-transform-types',
          fileURLToPath(new URL('../src/executor/development-runner.ts', import.meta.url))], cwd: root,
    })
    executions = new DevelopmentExecutions(store, workspaces, { admission: port.admission, outcomeScope: port.outcomeScope,
      guarantees: port.guarantees,
      spawn: (command, binding, requirements) => {
        const handle = port.spawn(command, binding, requirements); handles.push(handle); return handle
      } })
  }

  it('真实 DSH 经可信启动器消费后运行目标，目标环境不在消费前注入启动器', async () => {
    await guarded()
    const hook = join(root, 'hook.cjs'), marker = join(root, 'hook-marker')
    await writeFile(hook, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x")`)
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'guarded', leaseMs: 60_000 })
    await executions.start(binding(reserved), {
      argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("result","ok")'],
      env: { NODE_OPTIONS: `--require "${hook.replaceAll('\\', '/')}"` },
    })
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: 'range_quiet', outcome: { kind: 'exited', exitCode: 0 },
      outcomeScope: 'trusted_launcher',
      admission: { state: 'consumed', targetStartPrevented: false },
    }), { timeout: 4000 })
    expect(await readFile(join(path, 'result'), 'utf8')).toBe('ok')
    // 仅目标 Node 加载钩子一次；启动器不得继承目标的 NODE_OPTIONS。
    expect(await readFile(marker, 'utf8')).toBe('x')
    expect(workspaces.get(reserved.workspaceId).phase).toBe('running')
  })

  it('已消费的真实长任务可取消，但取消不能把 consumed 变成从未启动', async () => {
    await guarded()
    const file = join(path, 'guarded-writer')
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'guarded-cancel', leaseMs: 60_000 })
    await executions.start(binding(reserved), { argv: [process.execPath, '-e', writer, file, stopFile] })
    await vi.waitFor(async () => expect((await readFile(file)).length).toBeGreaterThan(0), { timeout: 4000 })
    workspaces.command({ ...binding(reserved), action: 'cancel' })
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: 'range_quiet', admission: { state: 'consumed', targetStartPrevented: false },
    }), { timeout: 4000 })
    expect(workspaces.get(reserved.workspaceId).phase).toBe('cancelling')
  })

  it('许可登记后实际 DSH 启动前取消，迟到启动器不得加载目标环境或执行目标', async () => {
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'late-dsh', leaseMs: 60_000 })
    await guarded(false, () => { workspaces.command({ ...binding(reserved), action: 'cancel' }) })
    const hook = join(root, 'late-hook.cjs'), marker = join(root, 'late-hook-marker')
    await writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected")`)
    await executions.start(binding(reserved), {
      argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("unexpected-result","unexpected")'],
      env: { NODE_OPTIONS: `--require "${hook.replaceAll('\\', '/')}"` },
    })
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: 'released_closed', outcomeScope: 'trusted_launcher', outcome: { kind: 'exited', exitCode: 125 },
      admission: { state: 'closed', reason: 'cancelled', targetStartPrevented: true },
      workspaceReleaseAllowed: true, recoveryRequired: false,
    }), { timeout: 4000 })
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(path, 'unexpected-result'))).toBe(false)
    expect(workspaces.get(reserved.workspaceId).phase).toBe('released')
    const next = await workspaces.reserve({ path, owner: 'next', requestId: 'after-closed', leaseMs: 60_000 })
    expect(next.generation).toBe(reserved.generation + 1)
  })

  it.skipIf(process.env.SUPERSERVE_TEST_BUILT_RUNNER !== '1')('打包后的启动器可由真实 DSH 运行并查询消费回执', async () => {
    await guarded(true)
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'bundle', leaseMs: 60_000 })
    await executions.start(binding(reserved), {
      argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("bundle-result","built")'],
    })
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: 'range_quiet', outcome: { kind: 'exited', exitCode: 0 }, admission: { state: 'consumed' },
    }), { timeout: 4000 })
    expect(await readFile(join(path, 'bundle-result'), 'utf8')).toBe('built')
  })

  it.each(['missing-program', 'exit-125'] as const)('真实 DSH 的 %s 只按创建回执决定可否回收', async scenario => {
    await guarded(process.env.SUPERSERVE_TEST_BUILT_RUNNER === '1')
    const reserved = await workspaces.reserve({ path, owner: 'test', requestId: scenario, leaseMs: 60_000 })
    const argv = scenario === 'missing-program' ? [join(root, 'missing-target.exe')]
      : [process.execPath, '-e', 'process.exit(125)']
    await executions.start(binding(reserved), { argv })
    await vi.waitFor(() => expect(executions.get(reserved.workspaceId)).toMatchObject({
      phase: scenario === 'missing-program' ? 'released_start_rejected' : 'range_quiet',
      outcome: { kind: 'exited', exitCode: 125 },
      admission: { state: 'consumed', targetStart: { state: scenario === 'missing-program' ? 'rejected' : 'spawned' } },
      workspaceReleaseAllowed: scenario === 'missing-program',
    }), { timeout: 4000 })
    const next = () => workspaces.reserve({ path, owner: 'next', requestId: 'next', leaseMs: 60_000 })
    if (scenario === 'missing-program') expect((await next()).generation).toBe(reserved.generation + 1)
    else await expect(next()).rejects.toMatchObject({ code: 'workspace_busy' })
  })
})
