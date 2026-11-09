import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/development-creation-probe.mjs', import.meta.url))
function run(args: string[]) {
  return new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [script, ...args], { windowsHide: true, timeout: 25_000, maxBuffer: 128 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }))
  })
}

it('创建范围实验明确平台、清理和生产边界，不要求安装依赖', async () => {
  const result = await run(['--help'])
  expect(result.code).toBeUndefined()
  expect(result.stdout).toContain('Windows x64')
  expect(result.stdout).toContain('不执行真实工程任务')
  expect(result.stdout).toContain('不安装依赖')
  expect(result.stdout).toContain('不开放生产回收')
})

it('缺少安装或未知参数拒绝运行，不把任意输入带入诊断', async () => {
  for (const args of [[], ['--untrusted-secret']]) {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'creation_probe_unavailable' })
    expect(result.stderr).not.toContain('untrusted-secret')
  }
})

interface Report {
  status: string
  cleanup: string
  cases: { name: string; status: string; observations: Record<string, unknown> }[]
  attempts: { planned: number; passed: number; failed: number; notRun: number }
  assurance: Record<string, boolean>
  measurement: Record<string, unknown>
}
const installation = process.env.SUPERSERVE_TEST_DSH_INSTALL
describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64' || !installation)('真实创建边界与拥有者崩溃', () => {
  let report: Report
  beforeAll(async () => {
    const result = await run(['--dsh-install', installation!])
    expect(result.stderr).toBe('')
    report = JSON.parse(result.stdout)
    expect(result.code, JSON.stringify(report)).toBeUndefined()
    expect(report.status).toBe('passed')
  }, 30_000)
  const observations = (name: string) => {
    const entry = report.cases.find(item => item.name === name)
    expect(entry?.status).toBe('passed')
    return entry!.observations
  }

  it('先创建后绑定会在拥有者崩溃时留下尚未运行的目标，范围空不是未创建证明', () => {
    expect(observations('late_assignment_before_assign')).toMatchObject({
      boundBeforeCrash: false, emptyBeforeCrash: true, rootExit: null, targetSurvivedOwnerCrash: true,
    })
  })
  it.each(['late_assignment_after_assign', 'creation_assignment_before_assign'])('%s 在首次运行前已受范围约束', name => {
    expect(observations(name)).toMatchObject({
      boundBeforeCrash: true, emptyBeforeCrash: false, rootExit: null,
      targetSurvivedOwnerCrash: false, outerJobHeldDuringObservation: true,
    })
  })
  it('主进程退出而脱离父进程存活的后代仍随内层范围结束，外层尚未终止', () => {
    expect(observations('creation_assignment_descendant')).toMatchObject({
      boundBeforeCrash: true, emptyBeforeCrash: false, rootExit: 0,
      targetSurvivedOwnerCrash: false, outerJobHeldDuringObservation: true,
    })
  })
  it('无效创建范围拒绝目标创建，不悄悄退回无范围运行', () => {
    expect(observations('creation_assignment_invalid_job')).toMatchObject({ rejected: true, targetWrites: 0 })
  })
  it('报告包含全部计划尝试和清理结果，不将实验推断成完整恢复或总内存收益', () => {
    expect(report.attempts).toEqual({ planned: 5, passed: 5, failed: 0, notRun: 0 })
    expect(report.cleanup).toBe('removed')
    expect(report.assurance).toEqual({
      productionRecoveryImplemented: false, externalWritersCovered: false, totalProcessMemoryMeasured: false,
      sameAccountSecurityBoundary: false, creatorCrashWindowRemovedInTestedPath: true,
    })
    expect(report.measurement.comparableStartupBenchmark).toBe(false)
  })
})
