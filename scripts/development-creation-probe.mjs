import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { devNull, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadRangeBindings, waitProbe } from './development-range-worker.mjs'

const self = fileURLToPath(import.meta.url)
const scenarios = [
  { name: 'late_assignment_before_assign', mode: 'late', stage: 'before_assign', survives: true },
  { name: 'late_assignment_after_assign', mode: 'late', stage: 'before_resume', survives: false },
  { name: 'creation_assignment_before_assign', mode: 'creation', stage: 'before_assign', survives: false },
  { name: 'creation_assignment_descendant', mode: 'creation', stage: 'descendant', survives: false },
  { name: 'creation_assignment_invalid_job', mode: 'creation', stage: 'invalid_job', survives: false },
]
const check = (condition, message) => { if (!condition) throw new Error(message) }
const envFor = root => ({ SystemRoot: process.env.SystemRoot ?? '', TEMP: root, TMP: root })
const size = async path => { try { return (await stat(path)).size } catch (error) { if (error.code === 'ENOENT') return 0; throw error } }

async function bindings(installation) {
  check(process.arch === 'x64', '当前实验仅支持已核验的 Windows x64 布局')
  const native = await loadRangeBindings(installation)
  const require = createRequire(join(resolve(installation), 'package.json'))
  const koffi = createRequire(require.resolve('@deepseek-ai/dsh-win32-process'))('koffi')
  const api = native.library.extendWin32ProcessBindings(({ kernel32, bind }) => ({
    currentProcess: bind(kernel32, 'GetCurrentProcess', 'void *', []),
    setLastError: bind(kernel32, 'SetLastError', 'void', ['uint32']),
    openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
    duplicate: bind(kernel32, 'DuplicateHandle', 'int', ['void *', 'void *', 'void *', 'void *', 'uint32', 'int', 'uint32']),
    inJob: bind(kernel32, 'IsProcessInJob', 'int', ['void *', 'void *', 'void *']),
    initializeAttributes: bind(kernel32, 'InitializeProcThreadAttributeList', 'int', ['void *', 'uint32', 'uint32', 'void *']),
    updateAttribute: bind(kernel32, 'UpdateProcThreadAttribute', 'int', ['void *', 'uint32', 'size_t', 'void *', 'size_t', 'void *', 'void *']),
    deleteAttributes: bind(kernel32, 'DeleteProcThreadAttributeList', 'void', ['void *']),
  }))
  return { ...native, api, koffi }
}

function launch(native, args, root, api = native.api) {
  const input = openSync(devNull, 'r'), output = openSync(devNull, 'w')
  try {
    return native.library.spawnCurrentTokenJobProcess(api, {
      command: process.execPath, applicationName: process.execPath,
      args: [self, ...args], cwd: root, env: envFor(root),
      stdio: { stdin: input, stdout: output, stderr: output },
    })
  } finally { closeSync(input); closeSync(output) }
}

function isMember(native, process, job) {
  const value = Buffer.alloc(4)
  check(native.api.inJob(process, job, value) !== 0, '无法核验实验进程的范围归属')
  return value.readUInt32LE() !== 0
}

/** 创建属性只用于实验对照；不改上游文件，也不将该路径接入生产回收。 */
function createBound(native, job, args) {
  const { api, koffi } = native
  const bytes = Buffer.alloc(8)
  const measured = api.initializeAttributes(null, 1, 0, bytes)
  check(measured === 0 && api.getLastError() === 122, '创建属性长度查询失败')
  const length = Number(bytes.readBigUInt64LE())
  check(length > 0 && length <= 65_536, '创建属性长度超出实验预算')
  const attributes = koffi.alloc('uint8', length)
  let initialized = false, createError
  try {
    check(api.initializeAttributes(attributes, 1, 0, bytes) !== 0, '创建属性初始化失败')
    initialized = true
    const jobs = Buffer.alloc(8)
    koffi.encode(jobs, 'void *', job)
    check(api.updateAttribute(attributes, 0, 0x2000d, jobs, 8, null, null) !== 0, '绑定创建范围失败')
    // STARTUPINFOEXW 复用原始 STARTUPINFOW 的标准流字段，追加原生属性列表。
    const extended = Buffer.alloc(112)
    Buffer.from(koffi.decode(args[8], 'uint8', 104)).copy(extended)
    extended.writeUInt32LE(112)
    koffi.encode(extended.subarray(104), 'void *', attributes)
    const input = [...args]
    input[5] |= 0x80000
    input[8] = extended
    const result = api.createProcessW(...input)
    if (result === 0) createError = api.getLastError()
    return result
  } finally {
    if (initialized) api.deleteAttributes(attributes)
    koffi.free(attributes)
    if (createError !== undefined) api.setLastError(createError)
  }
}

async function owner(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const { installation, root, parentId, mode, stage } = config
  const native = await bindings(installation)
  const { api, library } = native
  let job, processHandle, createResult, assignmentCalled = false, launched
  const publish = extra => writeFileSync(join(root, 'checkpoint.json'), JSON.stringify({
    createResult, assignmentCalled, ownerRssBytes: process.memoryUsage().rss, ...extra,
  }))
  const checkpoint = () => {
    const parent = api.openProcess(0x40, 0, parentId)
    check(!library.isNullPtr(parent), '实验父进程不可访问')
    const target = Buffer.alloc(8)
    try {
      // 复制的是进程句柄，不保留内层 Job 的观察句柄；避免实验本身延长范围寿命。
      check(api.duplicate(api.currentProcess(), processHandle, parent, target, 0, 0, 2) !== 0, '实验进程句柄移交失败')
    } finally { native.close(parent) }
    publish({ processHandle: target.readBigUInt64LE().toString(), member: isMember(native, processHandle, job),
      empty: library.isJobEmpty(api, job), rootExit: library.pollProcessExit(api, processHandle) ?? null })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)
    throw new Error('实验拥有者未在边界被终止')
  }
  const wrapped = {
    ...api,
    createJobObjectW: (...args) => { job = api.createJobObjectW(...args); return job },
    createProcessW: (...args) => {
      if (stage === 'invalid_job') {
        // 使用明确无效值验证创建拒绝，避免拿可复用的已关闭句柄当无效身份。
        createResult = createBound(native, 0n, args)
      } else createResult = mode === 'creation' ? createBound(native, job, args) : api.createProcessW(...args)
      return createResult
    },
    assignProcessToJobObject: (range, target) => {
      processHandle = target
      assignmentCalled = true
      if (stage === 'before_assign') checkpoint()
      if (mode === 'creation') return isMember(native, target, range) ? 1 : 0
      return api.assignProcessToJobObject(range, target)
    },
    resumeThread: thread => {
      if (stage === 'before_resume') checkpoint()
      return api.resumeThread(thread)
    },
  }
  try {
    launched = launch(native, [stage === 'descendant' ? '--tree-root' : '--payload', root], root, wrapped)
    check(stage === 'descendant', '目标创建未在预期边界停止')
    await waitProbe(() => size(join(root, 'writes')))
    await waitProbe(() => library.pollProcessExit(api, launched.process) !== undefined)
    checkpoint()
  } catch {
    if (stage === 'invalid_job' && createResult === 0 && !assignmentCalled) publish({ rejected: true })
    else throw new Error('实验拥有者未到达预期边界')
  } finally {
    if (launched) { native.close(launched.job); native.close(launched.process) }
  }
}

async function readCheckpoint(root) {
  try { return JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')) } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
    throw error
  }
}

async function runCase(native, installation, parentRoot, scenario) {
  const root = join(parentRoot, scenario.name)
  await mkdir(root)
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({ ...scenario, installation, root, parentId: process.pid }))
  const startedAt = performance.now()
  // 外层也在创建时绑定，避免兜底拥有者自身落入同一窗口；观察期间不终止外层。
  let safetyJob
  const safety = launch(native, ['--owner', configPath], root, {
    ...native.api,
    createJobObjectW: (...args) => { safetyJob = native.api.createJobObjectW(...args); return safetyJob },
    createProcessW: (...args) => createBound(native, safetyJob, args),
    assignProcessToJobObject: (job, process) => isMember(native, process, job) ? 1 : 0,
  })
  let target, data
  try {
    data = await waitProbe(async () => {
      const value = await readCheckpoint(root)
      if (value) return value
      check(native.library.pollProcessExit(native.api, safety.process) === undefined, '实验拥有者提前退出')
      return false
    })
    if (data.processHandle) target = BigInt(data.processHandle)
    if (scenario.stage === 'invalid_job') {
      check(data.rejected === true && data.createResult === 0 && !data.assignmentCalled, '无效范围没有阻止创建')
      await waitProbe(() => native.library.pollProcessExit(native.api, safety.process) !== undefined)
      check(await size(join(root, 'writes')) === 0, '被拒创建的目标不应写入')
      return { name: scenario.name, status: 'passed', elapsedMs: performance.now() - startedAt,
        observations: { rejected: true, targetWrites: 0, ownerRssBytes: data.ownerRssBytes } }
    }
    check(target !== undefined, '缺少用于核验的进程句柄')
    check(data.member === !scenario.survives && data.empty === scenario.survives, '创建边界的范围归属不符合预期')
    if (scenario.stage !== 'descendant') check(await size(join(root, 'writes')) === 0, '挂起目标提前执行')
    else check(data.rootExit === 0 && await size(join(root, 'writes')) > 0, '缺少主进程退出后的后代写入证据')
    check(native.library.pollProcessExit(native.api, safety.process) === undefined, '拥有者未保持在故障注入边界')
    check(native.api.terminateProcess(safety.process, 91) !== 0, '无法终止实验拥有者')
    await waitProbe(() => native.library.pollProcessExit(native.api, safety.process) !== undefined)
    check(native.library.pollProcessExit(native.api, safety.process) === 91, '拥有者未按指定方式被强制终止')
    let survived
    if (scenario.survives) {
      survived = native.library.pollProcessExit(native.api, target) === undefined
      check(survived, '未绑定目标的存活反例未出现')
    } else {
      await waitProbe(() => native.library.isJobEmpty(native.api, safety.job))
      survived = native.library.pollProcessExit(native.api, target) === undefined
      check(!survived, '拥有者退出后范围内目标仍存活')
    }
    return { name: scenario.name, status: 'passed', elapsedMs: performance.now() - startedAt,
      observations: { boundBeforeCrash: data.member, emptyBeforeCrash: data.empty, rootExit: data.rootExit,
        targetSurvivedOwnerCrash: survived, outerJobHeldDuringObservation: true,
        ownerRssBytes: data.ownerRssBytes } }
  } finally {
    try {
      native.library.terminateJob(native.api, safety.job, 92)
      await waitProbe(() => native.library.isJobEmpty(native.api, safety.job))
      await waitProbe(() => native.library.pollProcessExit(native.api, safety.process) !== undefined)
      if (!target) {
        const receipt = await readCheckpoint(root)
        if (receipt?.processHandle) target = BigInt(receipt.processHandle)
      }
      if (target) {
        await waitProbe(() => native.library.pollProcessExit(native.api, target) !== undefined)
      }
    } catch {
      throw Object.assign(new Error('实验进程清理未确认'), { cleanupUnconfirmed: true })
    } finally {
      if (target) native.close(target)
      native.close(safety.process)
      native.close(safety.job)
    }
  }
}

async function probe(installation) {
  const start = performance.now(), native = await bindings(installation)
  const root = await mkdtemp(join(tmpdir(), 'superServe-creation-probe-'))
  const cases = []
  let cleanup = 'not_confirmed', processesStopped = true
  try {
    for (const scenario of scenarios) {
      try { cases.push(await runCase(native, installation, root, scenario)) }
      catch (error) {
        if (error.cleanupUnconfirmed) processesStopped = false
        cases.push({ name: scenario.name, status: 'failed' })
        break
      }
    }
    check(processesStopped, '实验进程清理未确认，保留目录用于核验')
    check(resolve(root).startsWith(resolve(tmpdir()) + sep), '实验目录超出临时目录')
    await rm(root, { recursive: true, force: true })
    cleanup = 'removed'
  } catch { /* 清理失败必须进入报告，不能伪称实验完全成功。 */ }
  const passed = cases.filter(item => item.status === 'passed').length
  return {
    status: passed === scenarios.length && cleanup === 'removed' ? 'passed' : 'failed',
    platform: process.platform, arch: process.arch, nodeVersion: process.version, win32LibraryVersion: native.version,
    cases, cleanup, attempts: { planned: scenarios.length, passed, failed: cases.length - passed, notRun: scenarios.length - cases.length },
    elapsedMs: performance.now() - start, observerRssBytes: process.memoryUsage().rss,
    measurement: { elapsedScope: 'native_load_through_cleanup', includesNodeStartup: false,
      rssScope: 'observer_at_report_and_owner_at_checkpoint', comparableStartupBenchmark: false },
    assurance: { productionRecoveryImplemented: false, externalWritersCovered: false, totalProcessMemoryMeasured: false,
      sameAccountSecurityBoundary: false, creatorCrashWindowRemovedInTestedPath: passed === scenarios.length },
  }
}

try {
  if (process.argv[2] === '--owner') await owner(process.argv[3])
  else if (process.argv[2] === '--payload') {
    const path = join(process.argv[3], 'writes')
    const timer = setInterval(() => writeFileSync(path, '.', { flag: 'a' }), 20)
    setTimeout(() => clearInterval(timer), 15_000)
  } else if (process.argv[2] === '--tree-root') {
    const root = process.argv[3]
    const child = spawn(process.execPath, [self, '--payload', root], {
      cwd: root, env: envFor(root), windowsHide: true, detached: true, stdio: 'ignore',
    })
    child.on('error', () => { process.exitCode = 72 })
    child.unref()
    await waitProbe(() => size(join(root, 'writes')))
  } else {
    const { values } = parseArgs({ options: { 'dsh-install': { type: 'string' }, help: { type: 'boolean' } },
      strict: true, allowPositionals: false })
    if (values.help) {
      console.log('比较 Windows x64 目标创建与范围绑定的崩溃窗口，不执行真实工程任务。')
      console.log('用法：node scripts/development-creation-probe.mjs --dsh-install <已有可信 DSH 安装目录>')
      console.log('不安装依赖；外层测试 Job 清理本次子进程；不开放生产回收或执行任意命令。')
    } else {
      check(process.platform === 'win32' && values['dsh-install'], '需要 Windows 和已有可信安装')
      const report = await probe(values['dsh-install'])
      console.log(JSON.stringify(report, null, 2))
      if (report.status !== 'passed') process.exitCode = 1
    }
  }
} catch {
  console.error(JSON.stringify({ error: 'creation_probe_unavailable', message: '创建范围实验未完成，不能据此释放工作区。' }))
  process.exitCode = 1
}
