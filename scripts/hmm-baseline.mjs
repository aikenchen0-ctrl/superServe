import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { summarizeBaseline, compareBaselines } from './hmm-baseline-report.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = join(root, '.artifacts', 'hmm-baseline.json')
const args = process.argv.slice(2)
const usage = '用法：pnpm eval:hmm [--samples 1..5] [--compare 历史报告路径]\n运行固定模拟任务；报告写入 .artifacts/hmm-baseline.json。真实模型、网络和设备性能不在本报告范围内。'
let repetitions = 3, comparePath
try {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') { console.log(usage); process.exit(0) }
    if (args[index] === '--samples') repetitions = Number(args[++index])
    else if (args[index] === '--compare' && args[index + 1]) comparePath = resolve(args[++index])
    else throw new Error(usage)
  }
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('采样次数必须为 1 至 5')
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请使用 Node.js 24 或更高版本运行基线')
  // 先读取历史值，允许同一路径与本次运行前的报告比较；不执行历史报告中的内容。
  const comparing = comparePath !== undefined
  const previous = comparing ? JSON.parse(readFileSync(comparePath, 'utf8')) : undefined
  if (comparing) summarizeBaseline(previous)
  const hashFiles = paths => {
    const hash = createHash('sha256')
    for (const path of [...paths].sort()) hash.update(path.replaceAll('\\', '/')).update('\0').update(readFileSync(join(root, path))).update('\0')
    return hash.digest('hex')
  }
  const fingerprints = () => ({
    protocolHash: hashFiles(['tests/fixtures/hmm-baseline.ts', 'tests/hmm-baseline.spec.ts', 'scripts/hmm-baseline.mjs',
      'scripts/hmm-baseline-report.ts', 'tests/fixtures/host.ts', 'tests/fixtures/deployment.ts', 'vitest.config.ts']),
    implementationHash: hashFiles(['package.json', 'pnpm-lock.yaml',
      ...readdirSync(join(root, 'src'), { recursive: true }).filter(path => /\.tsx?$/.test(path)).map(path => join('src', path))]),
  })
  const before = fingerprints()
  mkdirSync(dirname(reportPath), { recursive: true })
  const runId = randomUUID()
  const child = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/hmm-baseline.spec.ts'], {
    cwd: root, stdio: 'inherit', timeout: 180_000,
    env: { ...process.env, HMM_BASELINE_RUN_ID: runId, HMM_BASELINE_SAMPLES: String(repetitions) },
  })
  if (child.error) throw child.error
  const raw = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (raw.runId !== runId) throw new Error('本轮没有生成完整报告，不能把旧报告当作当前结果')
  const report = summarizeBaseline(raw), after = fingerprints()
  Object.assign(report, before)
  report.environment = { node: process.versions.node, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model ?? 'unknown' }
  report.generatedAt = new Date().toISOString()
  report.passed = child.status === 0 && report.passed && before.protocolHash === after.protocolHash && before.implementationHash === after.implementationHash
  if (before.protocolHash !== after.protocolHash || before.implementationHash !== after.implementationHash)
    report.invalidReason = '执行期间实现或评测协议发生变化，请重新运行以获得一致基线。'
  if (comparing) report.comparison = compareBaselines(previous, report)
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(`\n基线${report.passed ? '通过' : '失败'}：${report.cases.length}/${report.expectedRuns} 个采样。报告：${reportPath}`)
  for (const item of report.summary) console.log(item.metrics
    ? `${item.scenario}：会话 ${item.metrics.nodeSessions.max}，设备查询/读取 ${item.metrics.deviceQueryCalls.max}/${item.metrics.deviceReadCalls.max}，快照采样最大 ${item.metrics.snapshotJsonBytesSampledMax.max} 字节，本地过程耗时中位数 ${item.observedWallMsMedian} 毫秒。`
    : `${item.scenario}：未产生采样。`)
  if (report.invalidReason) console.error(report.invalidReason)
  if (report.comparison && !report.comparison.compatible) console.error(report.comparison.reason)
  process.exitCode = report.passed && (!report.comparison || report.comparison.compatible) ? 0 : 1
} catch (error) {
  console.error(`基线运行失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
