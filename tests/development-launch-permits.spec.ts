import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { PreparedExecutionInput } from '../src/development/source-materialization.ts'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DevelopmentWorkspaces } from '../src/development/workspaces.ts'
import { consumeLaunchPermit, DevelopmentLaunchPermits, type RunnerEnvelope } from '../src/development/launch-permits.ts'
import { DevelopmentExecutions } from '../src/development/executions.ts'

const runner = fileURLToPath(new URL('../src/executor/development-runner.ts', import.meta.url))
const permitsModule = new URL('../src/development/launch-permits.ts', import.meta.url).href
let root: string, path: string, database: string, store: Store, workspaces: DevelopmentWorkspaces, permits: DevelopmentLaunchPermits
function launch(envelope: RunnerEnvelope, send = true, crash = false) {
  const argv = crash ? ['--experimental-transform-types', '--input-type=module', '-e',
    `const {consumeLaunchPermit}=await import(${JSON.stringify(permitsModule)}); let input="";for await(const p of process.stdin)input+=p;consumeLaunchPermit(JSON.parse(input));process.kill(process.pid,"SIGKILL");`]
    : ['--experimental-transform-types', runner]
  const child = spawn(process.execPath, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot } })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value.toString() })
  child.stderr.on('data', value => { stderr += value.toString() })
  const ended = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  if (send) child.stdin.end(JSON.stringify(envelope))
  return { child, ended, send: () => child.stdin.end(JSON.stringify(envelope)) }
}
let children: ReturnType<typeof launch>[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-launch-permits-'))
  path = join(root, 'workspace')
  await mkdir(path)
  database = join(root, 'state.sqlite')
  store = new Store(database)
  workspaces = new DevelopmentWorkspaces(store, () => true)
  permits = new DevelopmentLaunchPermits(store, database, value => workspaces.assertCurrent(value), () => workspaces.assertControl())
  children = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children) {
    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL')
    await child.ended
  }
  store.close()
  const target = resolve(root), parent = resolve(tmpdir())
  if (!target.startsWith(`${parent}${sep}`) || !target.split(sep).at(-1)!.startsWith('superagent-launch-permits-'))
    throw new Error('测试清理路径不属于临时目录')
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
})
async function offered(argv?: string[]) {
  const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'test', leaseMs: 60_000 })
  const binding = await workspaces.begin({ workspaceId: reserved.workspaceId, operationId: reserved.operationId, generation: reserved.generation })
  const command = { argv: argv ?? [process.execPath, '-e', 'require("node:fs").appendFileSync("result.txt",process.env.TEST_MARKER)'],
    env: { TEST_MARKER: 'private-payload-value', SystemRoot: process.env.SystemRoot ?? '' } }
  return { binding, envelope: permits.offer(binding, command, resolve(path)), command }
}
function run(envelope: RunnerEnvelope, send = true, crash = false) {
  const child = launch(envelope, send, crash)
  children.push(child)
  return child
}

it('真实命令在独立启动器消费许可后执行，命令、环境和令牌不存入状态库', async () => {
  const { envelope, binding, command } = await offered()
  const saved = JSON.stringify(store.db.prepare("SELECT value FROM kv WHERE key LIKE 'development:launch-permit:%'").all())
  expect(saved).not.toContain(command.argv[2])
  expect(saved).not.toContain(command.env.TEST_MARKER)
  expect(saved).not.toContain(envelope.secret)
  expect(await run(envelope).ended).toMatchObject({ code: 0 })
  expect(await readFile(join(path, 'result.txt'), 'utf8')).toBe(command.env.TEST_MARKER)
  expect(permits.read(binding)).toMatchObject({
    state: 'consumed', targetStartPrevented: false, targetStart: { state: 'spawned' },
  })
  expect(() => permits.offer(binding, command, resolve(path))).toThrow('不允许重建')
})

it('关闭先完成，已经存在但延迟收到命令的启动器不得执行目标，关闭可持久重查', async () => {
  const { envelope, binding } = await offered()
  const late = run(envelope, false)
  expect(permits.close(binding, 'cancelled')).toMatchObject({ state: 'closed', targetStartPrevented: true })
  store.close()
  store = new Store(database)
  workspaces = new DevelopmentWorkspaces(store, () => true)
  permits = new DevelopmentLaunchPermits(store, database, value => workspaces.assertCurrent(value), () => workspaces.assertControl())
  late.send()
  const result = await late.ended
  expect(result.code).toBe(125)
  expect(result.stderr).not.toContain(envelope.secret)
  expect(existsSync(join(path, 'result.txt'))).toBe(false)
  expect(permits.read(binding)).toMatchObject({ state: 'closed', reason: 'cancelled', targetStartPrevented: true })
})

it('两个真实启动器并发消费同一许可，只产生一次目标副作用', async () => {
  const { envelope, binding, command } = await offered()
  const first = run(envelope, false), second = run(envelope, false)
  first.send(); second.send()
  const results = await Promise.all([first.ended, second.ended])
  expect(results.map(result => result.code).sort()).toEqual([0, 125])
  expect(await readFile(join(path, 'result.txt'), 'utf8')).toBe(command.env.TEST_MARKER)
  expect(permits.close(binding, 'host_restarted')).toMatchObject({
    state: 'consumed', targetStartPrevented: false, targetStart: { state: 'spawned' },
  })
})

it('消费已提交但创建目标前崩溃，不能变成未启动证明，也不能重放', async () => {
  const { envelope, binding } = await offered()
  const ended = await run(envelope, true, true).ended
  expect(ended.code === 0 && ended.signal === null).toBe(false)
  expect(permits.read(binding)).toMatchObject({ state: 'consumed', targetStart: { state: 'unobserved' } })
  expect(existsSync(join(path, 'result.txt'))).toBe(false)
  expect(permits.close(binding, 'host_restarted')).toMatchObject({ state: 'consumed' })
  expect(await run(envelope).ended).toMatchObject({ code: 125 })
})

it('伪造命令、环境、目录、执行身份或令牌被拒绝，正确许可仍能执行', async () => {
  const { envelope } = await offered()
  const modified = [
    { ...envelope, payload: { ...envelope.payload, command: { ...envelope.payload.command, argv: [process.execPath, '-e', ''] } } },
    { ...envelope, payload: { ...envelope.payload, command: { ...envelope.payload.command, env: { TEST_MARKER: 'tampered' } } } },
    { ...envelope, payload: { ...envelope.payload, cwd: root } },
    { ...envelope, binding: { ...envelope.binding, generation: envelope.binding.generation + 1 } },
    { ...envelope, secret: '0'.repeat(64) },
  ]
  for (const value of modified) expect(() => consumeLaunchPermit(value)).toThrow('不一致')
  expect(await run(envelope).ended).toMatchObject({ code: 0 })
})

it('取消或宿主更替即使尚未写关闭回执，也不能让旧许可被消费', async () => {
  const { envelope, binding } = await offered()
  workspaces.command({ workspaceId: binding.workspaceId, operationId: binding.operationId, generation: binding.generation, action: 'cancel' })
  expect(() => consumeLaunchPermit(envelope)).toThrow('已取消')
  workspaces = new DevelopmentWorkspaces(store, () => true)
  expect(() => consumeLaunchPermit(envelope)).toThrow('已取消')
  expect(permits.closeOutstanding(workspaces.activeExecutions(), 'host_restarted')).toBe(1)
  expect(existsSync(join(path, 'result.txt'))).toBe(false)
})

it('关闭事务失败保持 offered，重新关闭成功后才可声明阻止目标启动', async () => {
  const { binding } = await offered()
  const set = store.set.bind(store)
  const failure = vi.spyOn(store, 'set').mockImplementation((key, value) => { set(key, value); throw new Error('receipt failure') })
  expect(() => permits.close(binding, 'cancelled')).toThrow('receipt failure')
  failure.mockRestore()
  expect(permits.read(binding)).toMatchObject({ state: 'offered', targetStartPrevented: false })
  expect(permits.close(binding, 'cancelled')).toMatchObject({ state: 'closed', targetStartPrevented: true })
})

it('旧控制实例不能关闭新实例许可，状态库身份被替换时拒绝消费', async () => {
  const { binding, envelope } = await offered()
  const previous = workspaces
  const old = new DevelopmentLaunchPermits(store, database, value => previous.assertCurrent(value), () => previous.assertControl())
  workspaces = new DevelopmentWorkspaces(store, () => true)
  expect(() => old.close(binding, 'host_stopped')).toThrow('旧控制实例')
  store.close()
  await rename(database, join(root, 'old.sqlite'))
  store = new Store(database)
  expect(() => consumeLaunchPermit(envelope)).toThrow('身份已变化')
})

it('关闭与真实启动器消费竞争，只有关闭或消费之一成立', async () => {
  const { binding, envelope, command } = await offered()
  const child = run(envelope, false)
  child.send()
  const closed = permits.close(binding, 'cancelled')
  const result = await child.ended
  if (closed?.state === 'closed') {
    expect(result.code).toBe(125)
    expect(existsSync(join(path, 'result.txt'))).toBe(false)
  } else {
    expect(closed?.state).toBe('consumed')
    expect(result.code).toBe(0)
    expect(await readFile(join(path, 'result.txt'), 'utf8')).toBe(command.env.TEST_MARKER)
  }
  expect(permits.read(binding)?.state).toBe(closed?.state)
})

it('实际消费拒绝过期和非 issued 占用，不把相同操作字符串当作执行授权', async () => {
  const { envelope, binding } = await offered()
  store.db.prepare("UPDATE kv SET value=json_set(value,'$.expiresAt',0) WHERE key=?")
    .run(`development:workspace:${binding.workspaceId}`)
  expect(() => consumeLaunchPermit(envelope)).toThrow('已取消')
  store.db.prepare("UPDATE kv SET value=json_set(value,'$.expiresAt',?,'$.execution.launch','prepared') WHERE key=?")
    .run(Date.now() + 60_000, `development:workspace:${binding.workspaceId}`)
  expect(() => consumeLaunchPermit(envelope)).toThrow('已取消')
  expect(permits.read(binding)?.state).toBe('offered')
})

it.each(['missing-program', 'missing-directory', 'exit-125'] as const)('真实启动器区分 %s 和创建后退出，不靠退出码推断', async scenario => {
  const reserved = await workspaces.reserve({ path, owner: 'test', requestId: 'start-result', leaseMs: 60_000 })
  const binding = await workspaces.begin({
    workspaceId: reserved.workspaceId, operationId: reserved.operationId, generation: reserved.generation,
  })
  const argv = scenario === 'missing-program' ? [join(root, 'missing-program.exe')]
    : [process.execPath, '-e', 'process.exit(125)']
  const envelope = permits.offer(binding, { argv }, resolve(path))
  if (scenario === 'missing-directory') await rename(path, join(root, 'moved-workspace'))
  expect(await run(envelope).ended).toMatchObject({ code: 125 })
  expect(permits.read(binding)).toMatchObject({
    state: 'consumed', targetStartPrevented: false,
    targetStart: { state: scenario === 'exit-125' ? 'spawned' : 'rejected', observedAt: expect.any(Number) },
    targetExit: scenario === 'exit-125' ? { state: 'exited', exitCode: 125, signal: null } : { state: 'unobserved' },
  })
})

it('只有消费获胜者得到创建回执写权，结果只能重复核实而不能反转', async () => {
  const { binding, envelope } = await offered()
  const consumer = consumeLaunchPermit(envelope)
  expect(() => consumeLaunchPermit(envelope)).toThrow('已关闭或消费')
  consumer.recordStart('spawned')
  const first = permits.read(binding)
  consumer.recordStart('spawned')
  expect(permits.read(binding)).toEqual(first)
  expect(() => consumer.recordStart('rejected')).toThrow('不能改写')
  expect(await run(envelope).ended).toMatchObject({ code: 125 })
  expect(permits.read(binding)).toEqual(first)
})

it('结果写入失败保留未知，原消费方可以补写，不能将写入失败当作未启动', async () => {
  const { binding, envelope } = await offered()
  const consumer = consumeLaunchPermit(envelope)
  store.db.exec(`CREATE TRIGGER reject_start_receipt BEFORE UPDATE ON kv
    WHEN NEW.key LIKE 'development:launch-permit:%'
      AND json_extract(NEW.value,'$.targetStart.state') != 'unobserved'
    BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`)
  expect(() => consumer.recordStart('rejected')).toThrow('receipt unavailable')
  expect(permits.read(binding)).toMatchObject({ targetStart: { state: 'unobserved' } })
  store.db.exec('DROP TRIGGER reject_start_receipt')
  consumer.recordStart('rejected')
  expect(permits.read(binding)).toMatchObject({ targetStart: { state: 'rejected' } })
})

it('宿主更替允许原消费方补精确执行事实，新代次分配后拒绝旧结果', async () => {
  const { binding, envelope } = await offered()
  const consumer = consumeLaunchPermit(envelope)
  workspaces = new DevelopmentWorkspaces(store, () => true)
  consumer.recordStart('rejected')
  expect(permits.read(binding)).toMatchObject({ targetStart: { state: 'rejected' } })
  // 只在测试中令可信恢复器通过已有精确事实释放，再验证旧写权不能穿过代次边界。
  workspaces.releaseVerified(binding, () => expect(permits.read(binding)?.targetStart?.state).toBe('rejected'))
  await workspaces.reserve({ path, owner: 'next', requestId: 'next', leaseMs: 60_000 })
  expect(() => consumer.recordStart('rejected')).toThrow('不属于当前占用')
})

it('旧 consumed 记录仍可读，但不凭升级或关闭操作生成创建结果', async () => {
  const { binding, envelope } = await offered()
  consumeLaunchPermit(envelope)
  store.db.prepare("UPDATE kv SET value=json_remove(json_set(value,'$.schemaVersion',1),'$.consumerHash','$.targetStart','$.targetExit') WHERE key=?")
    .run(`development:launch-permit:${binding.executionId}`)
  expect(permits.read(binding)).toEqual({ state: 'consumed', targetStartPrevented: false })
  expect(permits.close(binding, 'host_restarted')).toEqual({ state: 'consumed', targetStartPrevented: false })
  expect(await run(envelope).ended).toMatchObject({ code: 125 })
})

it('真实目标已运行但创建回执写失败，启动器不能将其改写成未创建', async () => {
  const { binding, envelope } = await offered()
  store.db.exec(`CREATE TRIGGER reject_spawned_receipt BEFORE UPDATE ON kv
    WHEN NEW.key LIKE 'development:launch-permit:%'
      AND json_extract(NEW.value,'$.targetStart.state') = 'spawned'
    BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`)
  expect(await run(envelope).ended).toMatchObject({ code: 125 })
  expect(existsSync(join(path, 'result.txt'))).toBe(true)
  expect(permits.read(binding)).toMatchObject({ targetStart: { state: 'unobserved' } })
})

it.each([0, 7, 125])('真实目标退出 %i 的观测可重读，不提升为目录释放或验收通过', async exitCode => {
  const { binding, envelope } = await offered([process.execPath, '-e', `process.exit(${exitCode})`])
  expect(await run(envelope).ended).toMatchObject({ code: exitCode })
  const observation = permits.read(binding)
  expect(observation).toMatchObject({ targetStart: { state: 'spawned' },
    targetExit: { state: 'exited', exitCode, signal: null, observedAt: expect.any(Number) } })
  store.close(); store = new Store(database)
  workspaces = new DevelopmentWorkspaces(store, () => true)
  permits = new DevelopmentLaunchPermits(store, database, value => workspaces.assertCurrent(value), () => workspaces.assertControl())
  expect(permits.read(binding)).toEqual(observation)
  expect(workspaces.get(binding.workspaceId).phase).not.toBe('released')
})

it('退出观测只能在创建后写入，重复相同结果幂等，矛盾结果拒绝', async () => {
  const { binding, envelope } = await offered()
  const consumer = consumeLaunchPermit(envelope)
  expect(() => consumer.recordExit({ exitCode: 0, signal: null })).toThrow('创建未确认')
  consumer.recordStart('spawned')
  expect(() => consumer.recordExit({ exitCode: null, signal: null })).toThrow()
  expect(() => consumer.recordExit({ exitCode: 0, signal: 'SIGTERM' })).toThrow()
  consumer.recordExit({ exitCode: null, signal: 'SIGTERM' })
  const observed = permits.read(binding)
  consumer.recordExit({ exitCode: null, signal: 'SIGTERM' })
  expect(permits.read(binding)).toEqual(observed)
  expect(() => consumer.recordExit({ exitCode: 0, signal: null })).toThrow('不能改写')
  expect(() => consumer.recordStart('rejected')).toThrow('不能改写')
})

it('目标实际退出但写回失败仍为未知，不能用启动器 125 补出目标结果', async () => {
  const { binding, envelope } = await offered([process.execPath, '-e', 'process.exit(7)'])
  store.db.exec(`CREATE TRIGGER reject_target_exit BEFORE UPDATE ON kv
    WHEN NEW.key LIKE 'development:launch-permit:%' AND json_extract(NEW.value,'$.targetExit.state') = 'exited'
    BEGIN SELECT RAISE(ABORT,'exit receipt unavailable'); END`)
  expect(await run(envelope).ended).toMatchObject({ code: 125 })
  expect(permits.read(binding)).toMatchObject({ targetStart: { state: 'spawned' }, targetExit: { state: 'unobserved' } })
})

it('取消和宿主更替后可补原目标退出事实；目录释放后旧写权失效', async () => {
  const { binding, envelope } = await offered()
  const consumer = consumeLaunchPermit(envelope)
  consumer.recordStart('spawned')
  workspaces.command({ workspaceId: binding.workspaceId, operationId: binding.operationId,
    generation: binding.generation, action: 'cancel' })
  workspaces = new DevelopmentWorkspaces(store, () => true)
  consumer.recordExit({ exitCode: 9, signal: null })
  expect(permits.read(binding)?.targetExit).toMatchObject({ exitCode: 9 })
  // 人为注入代次变化只验证拒绝旧写权，不证明实际范围已经静止。
  store.db.prepare("UPDATE kv SET value=json_set(value,'$.generation',2) WHERE key=?")
    .run(`development:workspace:${binding.workspaceId}`)
  expect(() => consumer.recordExit({ exitCode: 9, signal: null })).toThrow('不属于当前占用')
})

it('旧 v2 consumed 记录不从启动器状态推断新退出事实', async () => {
  const { binding, envelope } = await offered()
  const consumer = consumeLaunchPermit(envelope)
  consumer.recordStart('spawned')
  store.db.prepare("UPDATE kv SET value=json_remove(json_set(value,'$.schemaVersion',2),'$.targetExit') WHERE key=?")
    .run(`development:launch-permit:${binding.executionId}`)
  expect(permits.read(binding)).toMatchObject({ targetStart: { state: 'spawned' } })
  expect(permits.read(binding)).not.toHaveProperty('targetExit')
  expect(() => consumer.recordExit({ exitCode: 0, signal: null })).toThrow('当前版本')
})

it('启动器在目标退出后、后代仍持有输出时即可留下直属目标回执', async () => {
  const descendant = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('release-descendant'))process.exit(0)},20);
    setTimeout(()=>process.exit(1),6000)`
  const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],
    {stdio:['ignore','inherit','inherit'],windowsHide:true}).unref();process.exit(0)`
  const { binding, envelope } = await offered([process.execPath, '-e', program])
  const running = run(envelope)
  let ended = false
  void running.ended.then(() => { ended = true })
  try {
    await vi.waitFor(() => expect(permits.read(binding)?.targetExit?.state).toBe('exited'), { timeout: 5000, interval: 15 })
    expect(ended).toBe(false)
    expect(workspaces.get(binding.workspaceId).phase).toBe('running')
  } finally { await writeFile(join(path, 'release-descendant'), '') }
  expect(await running.ended).toMatchObject({ code: 0 })
}, 10_000)

it('物化输入目录被替换时，启动许可在消费前拒绝目标', async () => {
  const source = join(root, 'prepared-source'), output = join(root, 'prepared-output')
  await mkdir(source); await mkdir(output)
  const identity = async (path: string) => { const info = await lstat(path, { bigint: true }); return `${info.dev}:${info.ino}` }
  const prepared: PreparedExecutionInput = { materializationId: '00000000-0000-4000-8000-000000000001', sourceDirectory: resolve(source),
    outputDirectory: resolve(output), sourceIdentity: await identity(source), outputIdentity: await identity(output) }
  const reserved = await workspaces.reserve({ path, owner: 'prepared', requestId: 'prepared', leaseMs: 60_000 })
  const binding = await workspaces.begin({ workspaceId: reserved.workspaceId, operationId: reserved.operationId, generation: reserved.generation })
  const withPrepared = permits.offer(binding, { argv: [process.execPath, '-e', 'process.exit(0)'] }, resolve(path), prepared)
  await rm(source, { recursive: true }); await mkdir(source)
  expect(() => consumeLaunchPermit(withPrepared)).toThrow('输入或输出目录身份已变化')
})

it('真实目标与启动器结果分别投影；未观测静止不能回收，前端无需猜测退出码', async () => {
  const supervisor = new DevelopmentExecutions(store, workspaces, {
    admission: permits, outcomeScope: 'trusted_launcher',
    spawn: ({ cwd, ...command }, binding) => {
      const running = run(permits.offer(binding, command, cwd))
      return { done: running.ended.then(value => ({ exitCode: value.code, signal: value.signal })),
        terminate: () => running.child.kill(), waitForExit: async () => false }
    },
  })
  const workspace = await workspaces.reserve({ path, owner: 'integration', requestId: 'real-exit', leaseMs: 60000 })
  await supervisor.start({ workspaceId: workspace.workspaceId, operationId: workspace.operationId, generation: workspace.generation },
    { argv: [process.execPath, '-e', 'process.exit(7)'] })
  try {
    expect(children).toHaveLength(1)
    expect(await children[0]!.ended).toMatchObject({ code: 7 })
    expect(supervisor.get(workspace.workspaceId)).toMatchObject({ targetResult: { state: 'exited', exitCode: 7 },
      targetResultScope: 'direct_child_only', workspaceReleaseAllowed: false, validationPassed: false })
  } finally { await supervisor.shutdown() }
}, 10_000)

it('目标已创建但启动器被终止，不能补猜目标退出；目标自行结束也不释放占用', async () => {
  const { binding, envelope } = await offered([process.execPath, '-e', 'setTimeout(()=>process.exit(6),600)'])
  const running = run(envelope)
  await vi.waitFor(() => expect(permits.read(binding)?.targetStart?.state).toBe('spawned'), { timeout: 5000, interval: 10 })
  running.child.kill('SIGKILL')
  await running.ended
  await new Promise(resolve => setTimeout(resolve, 700))
  expect(permits.read(binding)?.targetExit).toEqual({ state: 'unobserved' })
  expect(workspaces.get(binding.workspaceId).phase).not.toBe('released')
}, 10_000)

it('新回执只公开目标观测，不泄露消费方密钥或载荷摘要', async () => {
  const { binding, envelope } = await offered()
  const consumer = consumeLaunchPermit(envelope)
  consumer.recordStart('spawned')
  consumer.recordExit({ exitCode: 0, signal: null })
  const response = JSON.stringify(permits.read(binding))
  expect(response).not.toContain('Hash')
  expect(response).not.toContain(envelope.secret)
  expect(response).not.toContain('private-payload-value')
})
