import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/development-range-probe.mjs', import.meta.url))
function run(args: string[]) {
  return new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [script, ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }))
  })
}
it('帮助入口明确说明真实进程实验和适用边界，不需要安装依赖', async () => {
  const result = await run(['--help'])
  expect(result.code).toBeUndefined()
  expect(result.stdout).toContain('Windows')
  expect(result.stdout).toContain('不执行真实工程任务')
  expect(result.stdout).toContain('--dsh-install')
  expect(result.stdout).toContain('不安装依赖')
})

it('缺少安装位置和未知参数不能冒充已通过实验，也不回显任意输入', async () => {
  for (const args of [[], ['--invalid-secret-argument']]) {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'range_probe_unavailable' })
    expect(result.stderr).not.toContain('invalid-secret-argument')
  }
})

interface Report {
  status: string
  cleanup: string
  platform: string
  win32LibraryVersion: string
  elapsedMs: number
  observerRssBytes: number
  cases: { name: string; status: string; observations: Record<string, unknown> }[]
  assurance: Record<string, boolean>
  attempts: { planned: number; passed: number; failed: number; notRun: number }
}
const installation = process.env.SUPERSERVE_TEST_DSH_INSTALL
describe.skipIf(process.platform !== 'win32' || !installation)('真实 Windows 命名范围实验', () => {
  let report: Report
  beforeAll(async () => {
    const result = await run(['--dsh-install', installation!])
    expect(result.code, result.stderr || result.stdout).toBeUndefined()
    report = JSON.parse(result.stdout)
  }, 25_000)
  const observations = (name: string) => report.cases.find(item => item.name === name)!.observations

  it('范围当前为空不禁止后续加入，主进程退出不代表后代已结束', () => {
    const result = observations('empty_is_not_sealed_and_descendants_survive_root')
    expect(result).toMatchObject({ emptyBeforeLaunch: true, rootExit: 0, quietWithDescendant: false, emptyAfterStop: true })
    expect(result.bytesAfterRootExit).toBeGreaterThan(result.firstBytes as number)
  })
  it('原拥有者崩溃后仍可重查，但只读观察句柄会延长写者寿命', () => {
    const result = observations('observer_handle_extends_lifetime_after_owner_crash')
    expect(result).toMatchObject({ quietAfterOwnerCrash: false, absentAfterLastObserverClosed: true })
    expect(result.bytesAfterCrash).toBeGreaterThan(result.firstBytes as number)
  })
  it('名字消失后可以重建，重查同名空作业不能证明原作业的终态', () => {
    expect(observations('last_owner_close_and_same_name_recreation')).toMatchObject({
      absentBeforeRecreation: true, replacementWasNew: true, replacementEmpty: true,
    })
  })
  it('全部实验及清理经过核实，成本与结论范围明确', () => {
    expect(report).toMatchObject({ status: 'passed', cleanup: 'verified', platform: 'win32' })
    expect(report.cases).toHaveLength(3)
    expect(report.cases.every(item => item.status === 'passed')).toBe(true)
    expect(report.attempts).toEqual({ planned: 3, passed: 3, failed: 0, notRun: 0 })
    expect(report.win32LibraryVersion).not.toBe('')
    expect(report.elapsedMs).toBeGreaterThan(0)
    expect(report.observerRssBytes).toBeGreaterThan(0)
    expect(report.assurance).toEqual({
      productionRecoveryImplemented: false, totalProcessMemoryMeasured: false,
      emptyMeansSealed: false, missingNameMeansTerminal: false, sameNameMeansSameRange: false,
    })
  })
})
