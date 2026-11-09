import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { appendFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { devNull } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const self = fileURLToPath(import.meta.url)

/** 仅从显式指定的既有安装加载公开 Win32 原语；不读取用户配置或安装依赖。 */
export async function loadRangeBindings(installation) {
  const require = createRequire(join(resolve(installation), 'package.json'))
  const entry = require.resolve('@deepseek-ai/dsh-win32-process')
  const library = await import(pathToFileURL(entry).href)
  const api = library.extendWin32ProcessBindings(({ kernel32, bind }) => ({
    createNamedJob: bind(kernel32, 'CreateJobObjectW', 'void *', ['void *', 'str16']),
    openNamedJob: bind(kernel32, 'OpenJobObjectW', 'void *', ['uint32', 'int', 'str16']),
  }))
  const version = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-win32-process/package.json'), 'utf8')).version
  const close = handle => library.closeHandleChecked(api, handle, '范围实验句柄')
  return { api, library, version, close,
    open(name) {
      const handle = api.openNamedJob(4, 0, name)
      if (!library.isNullPtr(handle)) return { kind: 'opened', handle }
      const error = api.getLastError()
      if (error === 2) return { kind: 'absent', error }
      return { kind: 'unavailable', error }
    },
    create(name) {
      const handle = api.createNamedJob(null, name)
      const error = api.getLastError()
      if (library.isNullPtr(handle)) throw new Error(`创建实验作业失败：${error}`)
      return { handle, existed: error === 183 }
    },
  }
}

/** 有界等待只用于实验断言，超时必须报告失败，不能被解释为范围已经结束。 */
export async function waitProbe(condition, timeoutMs = 4000) {
  const until = performance.now() + timeoutMs
  do {
    const value = await condition()
    if (value) return value
    await delay(20)
  } while (performance.now() < until)
  throw new Error('原生范围实验等待超时')
}

export async function fileSize(path) {
  try { return (await stat(path)).size } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}

async function payload(root) {
  // 写者只访问本次实验目录，停止文件是测试清理后备通道，不是生产恢复证据。
  for (;;) {
    if (await fileSize(join(root, 'stop'))) {
      await writeFile(join(root, 'stopped'), 'stopped')
      return
    }
    await appendFile(join(root, 'writes'), 'x')
    await delay(20)
  }
}

async function treeRoot(root) {
  const child = spawn(process.execPath, [self, '--payload', root], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot },
  })
  child.on('error', () => process.exit(72))
  child.unref()
  await waitProbe(() => fileSize(join(root, 'writes')))
  process.exit(0)
}

async function owner() {
  if (!process.send) throw new Error('实验拥有者需要父进程 IPC')
  const first = await new Promise(resolve => process.once('message', resolve))
  const { installation, root, name, tree } = first
  if (!/^Local\\superServe-range-probe-[a-f0-9-]+$/.test(name) || typeof root !== 'string')
    throw new Error('实验拥有者输入无效')
  const native = await loadRangeBindings(installation)
  const handles = []
  const empty = native.create(name)
  if (empty.existed) { native.close(empty.handle); throw new Error('实验作业名称已经存在') }
  handles.push(empty.handle)
  process.send({ event: 'empty', quiet: native.library.isJobEmpty(native.api, empty.handle) })
  let launched
  const command = async message => {
    if (message.action === 'launch') {
      if (launched) throw new Error('实验命令不能重复启动')
      const nullInput = openSync(devNull, 'r'), nullOutput = openSync(devNull, 'w')
      try {
        // 复用上游挂起创建、加入 Job 后再恢复的顺序；只在实验中为新对象提供名称。
        launched = native.library.spawnCurrentTokenJobProcess({
          ...native.api, createJobObjectW: () => native.api.createNamedJob(null, name),
        }, {
          command: process.execPath, applicationName: process.execPath,
          args: [self, tree ? '--tree-root' : '--payload', root],
          cwd: root, env: { SystemRoot: process.env.SystemRoot ?? '' },
          stdio: { stdin: nullInput, stdout: nullOutput, stderr: nullOutput },
        })
      } finally { closeSync(nullInput); closeSync(nullOutput) }
      handles.push(launched.job)
      await waitProbe(() => fileSize(join(root, 'writes')))
      const rootExit = tree ? await waitProbe(() => {
        const code = native.library.pollProcessExit(native.api, launched.process)
        return code === undefined ? false : { code }
      }) : undefined
      process.send({ event: 'running', quiet: native.library.isJobEmpty(native.api, empty.handle),
        ...(rootExit ? { rootExit: rootExit.code } : {}) })
    } else if (message.action === 'crash') {
      process.send({ event: 'crashing' }, () => process.kill(process.pid, 'SIGKILL'))
    } else if (message.action === 'close') {
      for (const handle of handles.splice(0)) native.close(handle)
      if (launched) {
        await waitProbe(() => native.library.pollProcessExit(native.api, launched.process) !== undefined)
        native.close(launched.process)
      }
      process.send({ event: 'closed' }, () => process.disconnect())
    } else throw new Error('未知实验命令')
  }
  process.on('message', message => { void command(message).catch(() => process.exit(73)) })
  // 父实验异常退出时内核句柄随本进程关闭，避免遗留真实写者。
  process.once('disconnect', () => process.exit(0))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(self)) {
  try {
    if (process.argv[2] === '--owner') await owner()
    else if (process.argv[2] === '--payload') await payload(process.argv[3])
    else if (process.argv[2] === '--tree-root') await treeRoot(process.argv[3])
    else throw new Error('此文件仅供范围实验入口调用')
  } catch { process.stderr.write('范围实验子进程失败\n'); process.exitCode = 1 }
}
