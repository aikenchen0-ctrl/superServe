import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../../src/app/store.ts'
import { DevelopmentWorkspaces } from '../../src/development/workspaces.ts'
import { DevelopmentExecutions } from '../../src/development/executions.ts'
import { DevelopmentLaunchPermits } from '../../src/development/launch-permits.ts'

const [root, point, behavior] = process.argv.slice(2)
if (!root || !point || !['prepared', 'grant-before-commit', 'issued', 'started',
  'closed-range-committed', 'closed-release-before-commit',
  'rejected-before-range', 'rejected-range-committed', 'rejected-release-before-commit'].includes(point ?? '')
  || !['crash', 'pause'].includes(behavior ?? ''))
  throw new Error('必须指定临时目录、有效崩溃边界及测试行为')
const store = new Store(join(root, 'state.sqlite'))
const workspaces = new DevelopmentWorkspaces(store, () => true)
const workspace = await workspaces.reserve({ path: join(root, 'workspace'), owner: 'fixture', requestId: 'fixture', leaseMs: 60_000 })
const binding = { workspaceId: workspace.workspaceId, operationId: workspace.operationId, generation: workspace.generation }
const writer = [
  'const fs = require("node:fs"); const path = require("node:path"); const root = process.argv[1];',
  'let count = 0;',
  'const timer = setInterval(() => {',
  '  if (fs.existsSync(path.join(root, "stop"))) {',
  '    clearInterval(timer); fs.writeFileSync(path.join(root, "stopped"), "stopped"); process.exit(0);',
  '  }',
  '  fs.appendFileSync(path.join(root, "writer"), "x");',
  '  if (++count === 1) process.stdout.write("ready");',
  '}, 20);',
].join('\n')
function crash(): never {
  // 同步回执让父进程识别边界；SIGKILL 跳过 Store.close、shutdown 及退出钩子。
  writeSync(1, `${JSON.stringify({ point, binding })}\n`)
  process.kill(process.pid, 'SIGKILL')
  throw new Error('强制结束测试进程未生效')
}
const prepare = workspaces.prepare.bind(workspaces)
workspaces.prepare = async (...args) => {
  const execution = await prepare(...args)
  if (point === 'prepared') {
    if (behavior === 'crash') crash()
    process.send?.({ event: 'prepared', binding })
    await once(process, 'message')
  }
  return execution
}
const set = store.set.bind(store)
store.set = (key, value) => {
  set(key, value)
  if (point === 'grant-before-commit' && String(key).startsWith('development:execution:')
    && (value as { phase?: string }).phase === 'launching') crash()
  if (['closed-range-committed', 'rejected-range-committed'].includes(point)
    && String(key).startsWith('development:execution:')
    && (value as { phase?: string }).phase === 'range_quiet') store.afterCommit(crash)
  if (['closed-release-before-commit', 'rejected-release-before-commit'].includes(point)
    && String(key).startsWith('development:workspace:')
    && (value as { phase?: string }).phase === 'released') crash()
}
const afterCommit = store.afterCommit.bind(store)
store.afterCommit = action => afterCommit(() => {
  if (point === 'issued') crash()
  action()
})
const permits = new DevelopmentLaunchPermits(store, join(root, 'state.sqlite'),
  execution => workspaces.assertCurrent(execution), () => workspaces.assertControl())
const executions = new DevelopmentExecutions(store, workspaces, point?.startsWith('rejected-') ? {
  admission: permits, outcomeScope: 'trusted_launcher',
  spawn: (command, execution) => {
    const envelope = permits.offer(execution, { argv: [join(root, 'missing-program.exe')] }, command.cwd)
    const runner = fileURLToPath(new URL('../../src/executor/development-runner.ts', import.meta.url))
    const child = spawn(process.execPath, ['--experimental-transform-types', runner], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { SystemRoot: process.env.SystemRoot },
    })
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => {
        if (point === 'rejected-before-range') crash()
        resolve({ exitCode, signal })
      })
    })
    child.stdin.end(JSON.stringify(envelope))
    return { done, terminate() { child.kill() }, waitForExit: async () => { await done; return true } }
  },
} : point?.startsWith('closed-') ? {
  admission: permits, outcomeScope: 'trusted_launcher',
  spawn: (command, execution) => {
    permits.offer(execution, { argv: command.argv }, command.cwd)
    workspaces.command({ ...binding, action: 'cancel' })
    // 此处仅提供受管范围证据，强制退出验证的是数据库持久性，不代表真实 DSH 范围能力。
    return { done: Promise.resolve({ exitCode: 125, signal: null }),
      waitForExit: async () => true, terminate() {} }
  },
} : {
  spawn: () => {
    writeFileSync(join(root, 'called'), 'called')
    const child = spawn(process.execPath, ['-e', writer, root], {
      detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    // 此夹具提供实际单进程范围；它允许写者跨控制进程退出，不能被误当成完整 DSH 原生范围。
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    if (point === 'started') child.stdout.once('data', crash)
    return { done, terminate() { child.kill() }, waitForExit: async () => { await done; return true } }
  },
}, error => { writeSync(2, `${error instanceof Error ? error.name : 'Error'}\n`) })

// 只约束测试夹具，避免父测试异常时等待 IPC 永久挂起。
const deadline = setTimeout(() => process.exit(74), 10_000)
try {
  await executions.start(binding, { argv: [process.execPath, '-e', writer, root] })
  if (point !== 'started' && !point?.startsWith('closed-') && !point?.startsWith('rejected-'))
    throw new Error('预期边界未被命中')
} catch (error) {
  process.send?.({ event: 'refused', code: (error as { code?: string }).code })
  await executions.shutdown()
  store.close()
  clearTimeout(deadline)
  process.disconnect?.()
}
