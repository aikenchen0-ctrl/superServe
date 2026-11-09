import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { fileSize, loadRangeBindings, waitProbe } from './development-range-worker.mjs'

const worker = join(dirname(fileURLToPath(import.meta.url)), 'development-range-worker.mjs')

/** 独立实验进程，不能向已有 DSH、工作树或设备发送命令。 */
function startOwner(installation, root, name, tree) {
  const child = spawn(process.execPath, [worker, '--owner'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root },
  })
  const messages = []
  child.on('message', message => messages.push(message))
  // 只消费而不回显第三方诊断，避免复制绝对路径或本机环境。
  child.stderr.resume()
  const exited = new Promise(resolve => {
    child.once('error', () => resolve({ kind: 'spawn_error' }))
    child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }))
  })
  const send = message => new Promise((resolve, reject) => child.send(message, error => error ? reject(error) : resolve()))
  const ready = send({ installation, root, name, tree })
  return {
    child, exited, ready, send,
    message: event => waitProbe(() => messages.find(message => message.event === event)),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    },
  }
}

async function probe(installation) {
  const startedAt = performance.now()
  const native = await loadRangeBindings(installation)
  const root = await mkdtemp(join(tmpdir(), 'superServe-range-probe-'))
  const cases = [], owners = [], observed = new Set(), ownedNames = []
  const take = name => {
    const opened = native.open(name)
    if (opened.kind !== 'opened') throw new Error('实验作业不可重查')
    observed.add(opened.handle)
    return opened.handle
  }
  const release = handle => { native.close(handle); observed.delete(handle) }
  const check = (condition, detail) => { if (!condition) throw new Error(detail) }
  const scenario = async (name, action) => {
    const started = performance.now()
    try {
      const observations = await action()
      cases.push({ name, status: 'passed', elapsedMs: performance.now() - started, observations })
    } catch {
      cases.push({ name, status: 'failed', elapsedMs: performance.now() - started })
      throw new Error('原生范围实验未达到预期')
    }
  }
  let failure = false, cleanup = 'not_finished'
  try {
    await scenario('empty_is_not_sealed_and_descendants_survive_root', async () => {
      const directory = join(root, 'descendants')
      await mkdir(directory)
      const name = `Local\\superServe-range-probe-${randomUUID()}`
      ownedNames.push(name)
      const owner = startOwner(installation, directory, name, true)
      owners.push(owner)
      await owner.ready
      const initial = await owner.message('empty')
      const handle = take(name)
      const emptyBeforeLaunch = native.library.isJobEmpty(native.api, handle)
      await owner.send({ action: 'launch' })
      const running = await owner.message('running')
      const firstBytes = await fileSize(join(directory, 'writes'))
      await waitProbe(async () => (await fileSize(join(directory, 'writes'))) > firstBytes)
      const bytesAfterRootExit = await fileSize(join(directory, 'writes'))
      const quietWithDescendant = native.library.isJobEmpty(native.api, handle)
      await writeFile(join(directory, 'stop'), 'stop')
      await waitProbe(() => native.library.isJobEmpty(native.api, handle))
      const emptyAfterStop = native.library.isJobEmpty(native.api, handle)
      release(handle)
      await owner.send({ action: 'close' })
      const ended = await owner.exited
      check(initial.quiet && emptyBeforeLaunch && running.rootExit === 0 && !quietWithDescendant
        && bytesAfterRootExit > firstBytes && emptyAfterStop && ended.code === 0, '后代范围观测不一致')
      return { emptyBeforeLaunch, rootExit: running.rootExit, quietWithDescendant, firstBytes, bytesAfterRootExit, emptyAfterStop }
    })
    await scenario('observer_handle_extends_lifetime_after_owner_crash', async () => {
      const directory = join(root, 'observer')
      await mkdir(directory)
      const name = `Local\\superServe-range-probe-${randomUUID()}`
      ownedNames.push(name)
      const owner = startOwner(installation, directory, name, false)
      owners.push(owner)
      await owner.ready
      await owner.message('empty')
      await owner.send({ action: 'launch' })
      await owner.message('running')
      const observer = take(name)
      await owner.send({ action: 'crash' })
      const ownerExit = await owner.exited
      const firstBytes = await fileSize(join(directory, 'writes'))
      await waitProbe(async () => (await fileSize(join(directory, 'writes'))) > firstBytes)
      const bytesAfterCrash = await fileSize(join(directory, 'writes'))
      const reopened = take(name)
      const quietAfterOwnerCrash = native.library.isJobEmpty(native.api, reopened)
      release(reopened)
      release(observer)
      await waitProbe(() => {
        const result = native.open(name)
        if (result.kind === 'opened') { native.close(result.handle); return false }
        if (result.kind === 'unavailable') throw new Error('无法确认命名对象状态')
        return true
      })
      check(!quietAfterOwnerCrash && bytesAfterCrash > firstBytes && (ownerExit.code !== 0 || ownerExit.signal),
        '拥有者退出后观察句柄行为不一致')
      return { ownerExit, quietAfterOwnerCrash, firstBytes, bytesAfterCrash, absentAfterLastObserverClosed: true }
    })
    await scenario('last_owner_close_and_same_name_recreation', async () => {
      const directory = join(root, 'name-reuse')
      await mkdir(directory)
      const name = `Local\\superServe-range-probe-${randomUUID()}`
      ownedNames.push(name)
      const owner = startOwner(installation, directory, name, false)
      owners.push(owner)
      await owner.ready
      await owner.message('empty')
      await owner.send({ action: 'launch' })
      await owner.message('running')
      // 不保留观察句柄，避免观测本身延长 kill-on-close 资源寿命。
      await owner.send({ action: 'crash' })
      const ownerExit = await owner.exited
      await waitProbe(() => {
        const result = native.open(name)
        if (result.kind === 'opened') { native.close(result.handle); return false }
        if (result.kind === 'unavailable') throw new Error('范围状态未知')
        return true
      })
      const replacement = native.create(name)
      observed.add(replacement.handle)
      const reopened = take(name)
      const replacementEmpty = native.library.isJobEmpty(native.api, reopened)
      release(reopened)
      release(replacement.handle)
      check(!replacement.existed && replacementEmpty && (ownerExit.code !== 0 || ownerExit.signal), '名称重建未被识别')
      return { ownerExit, absentBeforeRecreation: true, replacementWasNew: !replacement.existed, replacementEmpty }
    })
  } catch { failure = true }
  finally {
    // 范围句柄与拥有者都关闭后才删除测试目录，不能靠递归删除掩盖残留写者。
    const settled = await Promise.allSettled(owners.map(owner => owner.stop()))
    for (const handle of [...observed]) {
      try { release(handle) } catch { failure = true }
    }
    try {
      check(settled.every(result => result.status === 'fulfilled'), '实验拥有者未结束')
      for (const name of ownedNames) await waitProbe(() => {
        const result = native.open(name)
        if (result.kind === 'opened') { native.close(result.handle); return false }
        if (result.kind === 'unavailable') throw new Error('无法确认实验范围已结束')
        return true
      })
      const target = resolve(root), parent = resolve(tmpdir())
      check(target.startsWith(`${parent}${sep}`) && target.split(sep).at(-1).startsWith('superServe-range-probe-'),
        '清理目标不在实验临时根内')
      await rm(target, { recursive: true, force: true, maxRetries: 3 })
      cleanup = 'verified'
    } catch { failure = true; cleanup = 'unconfirmed' }
  }
  return {
    schemaVersion: 1, status: failure ? 'failed' : 'passed', platform: process.platform, arch: process.arch,
    nodeVersion: process.version, win32LibraryVersion: native.version, cases, cleanup,
    attempts: { planned: 3, passed: cases.filter(item => item.status === 'passed').length,
      failed: cases.filter(item => item.status === 'failed').length, notRun: 3 - cases.length },
    elapsedMs: performance.now() - startedAt, observerRssBytes: process.memoryUsage().rss,
    measurement: { elapsedScope: 'native_load_through_cleanup', includesNodeStartup: false, rssScope: 'observer_at_report' },
    assurance: { productionRecoveryImplemented: false, totalProcessMemoryMeasured: false,
      emptyMeansSealed: false, missingNameMeansTerminal: false, sameNameMeansSameRange: false },
  }
}

try {
  const { values } = parseArgs({
    options: { 'dsh-install': { type: 'string' }, help: { type: 'boolean' } }, strict: true, allowPositionals: false,
  })
  if (values.help) {
    console.log('在临时目录验证 Windows 命名作业的跨进程身份及生命周期，不执行真实工程任务。')
    console.log('用法：node scripts/development-range-probe.mjs --dsh-install <已有且可信的 DSH 安装目录>')
    console.log('仅加载该安装的公开 Win32 库，不安装依赖；实验会创建并强制结束自身的测试进程。')
  } else {
    if (process.platform !== 'win32') throw new Error('此原生范围实验仅适用于 Windows')
    if (!values['dsh-install']) throw new Error('缺少 --dsh-install，请指定已有可信安装')
    const result = await probe(values['dsh-install'])
    console.log(JSON.stringify(result, null, 2))
    if (result.status !== 'passed') process.exitCode = 1
  }
} catch {
  console.error(JSON.stringify({ error: 'range_probe_unavailable', message: '范围实验无法完成，请检查平台、参数及已有安装；未取得恢复证明。' }))
  process.exitCode = 1
}
