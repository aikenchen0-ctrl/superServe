import { link, lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectQualityEvidence } from '../src/development/quality.ts'

vi.mock('node:fs/promises', async original => {
  const source = await original<typeof import('node:fs/promises')>()
  return { ...source, open: vi.fn(source.open) }
})
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const commit = '1'.repeat(40), sha = 'a'.repeat(64)
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'superserve-quality-'))
  roots.push(value)
  return value
}
async function json(root: string, name: string, value: unknown) {
  await writeFile(join(root, name), JSON.stringify(value))
}
const target = (name = 'Sample') => ({ source: `${name}.kt`, class: `example.${name}`, method: 'evaluate',
  descriptor: '()Z', status: 'within_threshold' })
const scope = (name = 'Sample') => ({ class: `example.${name}`, method: 'evaluate', jvmMethod: 'evaluate',
  descriptor: '()Z', total: 2, counts: { KILLED: 2 } })
const tests = { tests: 3, failures: 0, errors: 0, skipped: 0 }
// 按已核对的生成器结构制作合成报告；这些文件不是实际执行证明。
async function jvm(name = 'Sample') {
  const root = await directory()
  const summary = { schemaVersion: 1, status: 'review_required', fullWorkflowPassed: false,
    baseline: { sdk: tests, consumer: tests, consumerBuild: 'passed' }, targetTests: tests,
    metrics: 'metrics_only_pass', kotlinPlugin: { diagnosticOnly: false, projectCompilerCompatibilityVerified: true },
    mutation: { executed: true, status: 'report_requires_scope_review', total: 2,
      counts: { KILLED: 2 }, scope: [scope(name)] } }
  await json(root, 'summary.json', summary)
  await json(root, 'crap.json', { schemaVersion: 1, fullWorkflowPassed: false, status: 'metrics_only_pass',
    coverageMetric: 'method line', threshold: 10, targets: [target(name)] })
  await json(root, 'mutation-scope.json', [scope(name)])
  await json(root, 'commands.json', ['baseline', 'target-tests', 'kover-report', 'map-symbols', 'pit']
    .map(name => ({ name, exitCode: 0, arguments: ['PRIVATE_COMMAND'], cwd: 'PRIVATE_PATH' })))
  for (const file of ['inputs-before.json', 'inputs-after.json', 'classes-before.json', 'classes-after.json'])
    await json(root, file, [{ path: 'PRIVATE_EXTERNAL_PATH', sha256: sha }])
  for (const file of ['tools.json', 'plugin-build.json']) await json(root, file, { fixture: true })
  for (const file of ['coverage.xml', 'symbols.xml', 'detekt.sarif']) await writeFile(join(root, file), 'raw fixture')
  await mkdir(join(root, 'pit'))
  await writeFile(join(root, 'pit/mutations.xml'), 'raw fixture')
  await writeFile(join(root, 'head.txt'), `${commit}\n`)
  return { root, summary }
}
async function nativeCrap() {
  const root = await directory()
  const summary = { sourceCommit: commit, workingTreeDiffSha256: sha, firstPartyFiles: 1,
    filters: ['*.cpp'], jvmCoverageUsable: true, gateThreshold: 6, syntaxTreeErrors: [],
    source: 'PRIVATE_WORKTREE', coverageReport: 'PRIVATE_OUTSIDE_PATH',
    exitCodes: { ctestCoverage: 0, jvmNativeCoverage: 0, exploration: 0, gate: 0, strictParse: 0 } }
  await json(root, 'summary.json', summary)
  await json(root, 'source-manifest.json', [{ path: 'src/sample.cpp', sha256: sha }])
  const report = { schema_version: 1, tool: 'crap4cpp', version: '1.0.0',
    summary: { functions: 1, missing_coverage: 0, over_limit: 0, limit: 6 },
    functions: [{ file: 'sample.cpp', name: 'sample', start_line: 1, end_line: 8,
      complexity: 2, coverage: 100, crap: 2 }] }
  for (const name of ['gate.json', 'strict-parse.json']) await json(root, name, report)
  await json(root, 'strict-parse-files.json', [])
  for (const name of ['native-cobertura.xml', 'jvm-native-cobertura.xml', 'combined-cobertura.xml'])
    await writeFile(join(root, name), 'raw fixture')
  return { root, summary, report }
}
const codes = (result: Awaited<ReturnType<typeof inspectQualityEvidence>>) => result.issues.map(issue => issue.code)
const inspectJvm = (directory: string) => inspectQualityEvidence({ directory, format: 'jvm-trial-v1' })
const inspectNative = (directory: string) => inspectQualityEvidence({ directory, format: 'native-crap-v1' })
afterEach(async () => {
  vi.mocked(fs.open).mockImplementation(native.open)
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('测试目录边界不符')
    await rm(root, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 })
  }
})

it.each(['Sample', 'DifferentModule'])('合法 JVM 待审查报告保留完成声明，不升级为通过：%s', async name => {
  const { root } = await jvm(name)
  const before = await readFile(join(root, 'summary.json')), metadata = await lstat(join(root, 'summary.json'))
  const result = await inspectJvm(root)
  expect(result).toMatchObject({ reportedExecution: 'completed', evidence: 'review_required',
    declaredIdentity: { sourceCommit: commit }, mutationCounts: { KILLED: 2 },
    assurance: { readOnly: true, persisted: false, rawArtifactsParsed: false, sourceAuthenticated: false,
      inputClosureVerified: false, snapshotCaptured: false, candidateEligible: false, publishAllowed: false } })
  expect(codes(result)).toEqual(['external_evidence_unverified'])
  expect(result.artifacts.find(file => file.name === 'summary.json')).toMatchObject({
    status: 'read', bytes: before.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  expect(await readFile(join(root, 'summary.json'))).toEqual(before)
  expect((await lstat(join(root, 'summary.json'))).mtimeMs).toBe(metadata.mtimeMs)
  expect((await inspectJvm(root)).bundleDigest).toBe(result.bundleDigest)
})

it('读取完整原生报告仍只进入审查，不跟随报告给出的外部路径', async () => {
  const { root } = await nativeCrap()
  const result = await inspectNative(root)
  expect(result.evidence).toBe('review_required')
  expect(codes(result)).toEqual(['external_evidence_unverified'])
  expect(result.assurance.publishAllowed).toBe(false)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})

it.each(['missing', 'truncated', 'version', 'symbol-only'])('汇总缺失或不受支持不返回成功：%s', async kind => {
  const root = await directory()
  if (kind === 'truncated') await writeFile(join(root, 'summary.json'), '{"status":"PRIVATE_')
  if (kind === 'version') await json(root, 'summary.json', { schemaVersion: 99, status: 'passed' })
  if (kind === 'symbol-only') await json(root, 'summary.json', [{ passed: true, supported: false, case: 'example' }])
  const result = await inspectJvm(root)
  expect(result.reportedExecution).toBe('unknown')
  expect(result.evidence).toBe('insufficient_evidence')
  expect(result.assurance.publishAllowed).toBe(false)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})

it('gate 为零但严格解析失败，保留独立缺证，不把普通门禁冒充完整验收', async () => {
  const { root, summary } = await nativeCrap()
  summary.exitCodes.strictParse = 1
  await json(root, 'summary.json', summary)
  await writeFile(join(root, 'strict-parse.json'), '')
  const result = await inspectNative(root)
  expect(result.reportedExecution).toBe('completed')
  expect(result.evidence).toBe('insufficient_evidence')
  expect(codes(result)).toContain('strict_parse_incomplete')
  expect(result.artifacts.find(file => file.name === 'strict-parse.json')?.status).toBe('invalid_json')
})

it('原生报告阈值或函数分母矛盾时不能沿用成功声明', async () => {
  const { root, report } = await nativeCrap()
  report.summary.functions = 2
  await json(root, 'gate.json', report)
  expect(codes(await inspectNative(root))).toContain('native_report_conflict')
})

it('零变异和未证实插件兼容性分别要求补证，不按没有存活判断成功', async () => {
  const { root, summary } = await jvm()
  summary.mutation.total = 0
  summary.mutation.executed = false
  summary.kotlinPlugin.projectCompilerCompatibilityVerified = false
  await json(root, 'summary.json', summary)
  const result = await inspectJvm(root)
  expect(codes(result)).toEqual(expect.arrayContaining(['mutation_missing', 'plugin_compatibility_unknown']))
  expect(result.evidence).toBe('insufficient_evidence')
})

it('不可计算方法不能被汇总中的低分遮盖', async () => {
  const { root } = await jvm()
  await json(root, 'crap.json', { schemaVersion: 1, fullWorkflowPassed: false, status: 'insufficient_evidence',
    coverageMetric: 'method line', threshold: 10, targets: [{ ...target(), status: 'not_computable', crap: null }] })
  expect(codes(await inspectJvm(root))).toContain('mapping_incomplete')
})

it.each(['TIMED_OUT', 'NO_COVERAGE', 'RUN_ERROR', 'PRIVATE_UNKNOWN_STATUS'])('非杀死状态独立保留且不泄露未知字段：%s', async status => {
  const { root, summary } = await jvm()
  await json(root, 'summary.json', { ...summary, mutation: { ...summary.mutation, counts: { [status]: 2 } } })
  const result = await inspectJvm(root)
  expect(result.evidence).toBe('insufficient_evidence')
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  expect(result.mutationCounts?.KILLED).toBeUndefined()
})

it('测试、CRAP 和变异针对不同方法时报告范围不一致', async () => {
  const { root } = await jvm()
  await json(root, 'crap.json', { schemaVersion: 1, fullWorkflowPassed: false, status: 'metrics_only_pass',
    coverageMetric: 'method line', threshold: 10, targets: [target('Another')] })
  expect(codes(await inspectJvm(root))).toContain('target_scope_mismatch')
})

it('改变同名输入内容摘要会使报告过期，不能从前后快照中任选一个', async () => {
  const { root } = await jvm()
  await json(root, 'inputs-after.json', [{ path: 'PRIVATE_EXTERNAL_PATH', sha256: 'b'.repeat(64) }])
  const result = await inspectJvm(root)
  expect(result.evidence).toBe('stale')
  expect(codes(result)).toContain('inputs_changed')
  expect(result.declaredIdentity.inputDigest).toBeUndefined()
})

it('外部预期版本和范围不匹配时失效，匹配也不自动获得发布资格', async () => {
  const { root } = await nativeCrap()
  const first = await inspectNative(root)
  const same = await inspectQualityEvidence({ directory: root, format: 'native-crap-v1',
    expectedCommit: commit, expectedScopeDigest: first.declaredIdentity.scopeDigest })
  expect(same.evidence).toBe('review_required')
  const changed = await inspectQualityEvidence({ directory: root, format: 'native-crap-v1',
    expectedCommit: '2'.repeat(40), expectedScopeDigest: 'f'.repeat(64) })
  expect(changed.evidence).toBe('stale')
  expect(codes(changed).filter(code => code === 'expected_identity_mismatch')).toHaveLength(2)
})

it('报告超过预算保留缺证，不放宽大小限制或读取正文', async () => {
  const root = await directory()
  await writeFile(join(root, 'summary.json'), Buffer.alloc(4 * 1024 * 1024 + 1, 32))
  const result = await inspectJvm(root)
  expect(result.evidence).toBe('insufficient_evidence')
  expect(result.artifacts).toEqual([{ name: 'summary.json', status: 'oversized' }])
})

it('缺少原始变异报告时不能仅凭 summary 判断证据完整', async () => {
  const { root } = await jvm()
  await rm(join(root, 'pit/mutations.xml'))
  const result = await inspectJvm(root)
  expect(result.evidence).toBe('insufficient_evidence')
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'artifact_unavailable', artifact: 'pit/mutations.xml' }))
})

it('嵌套目录链接和硬链接拒绝越界，外部文件保持不变', async () => {
  const { root } = await jvm(), outside = await directory()
  await writeFile(join(outside, 'mutations.xml'), 'PRIVATE_OUTSIDE')
  await rm(join(root, 'pit/mutations.xml'))
  await rmdir(join(root, 'pit'))
  await symlink(outside, join(root, 'pit'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(inspectJvm(root)).rejects.toMatchObject({ code: 'unsafe_path' })
  const hardRoot = await directory()
  await link(join(outside, 'mutations.xml'), join(hardRoot, 'summary.json'))
  await expect(inspectJvm(hardRoot)).rejects.toMatchObject({ code: 'unsafe_path' })
  expect(await readFile(join(outside, 'mutations.xml'), 'utf8')).toBe('PRIVATE_OUTSIDE')
})

it('读取后文件被替换时拒绝返回混合报告', async () => {
  const { root } = await jvm()
  let replaced = false
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof native.open>) => {
    const handle = await native.open(...args)
    if (!replaced && String(args[0]).endsWith('crap.json')) {
      replaced = true
      await json(root, 'summary.json', { schemaVersion: 99 })
    }
    return handle
  })
  await expect(inspectJvm(root)).rejects.toMatchObject({ code: 'bundle_changed' })
  expect(replaced).toBe(true)
})

it('预取消、错误目录和不支持配方明确失败，不返回部分结论', async () => {
  const root = await directory(), abort = new AbortController()
  abort.abort()
  await expect(inspectQualityEvidence({ directory: root, format: 'jvm-trial-v1' }, abort.signal))
    .rejects.toMatchObject({ code: 'cancelled' })
  await expect(inspectJvm(join(root, 'missing'))).rejects.toMatchObject({ code: 'path_unavailable' })
  await expect(inspectQualityEvidence({ directory: root, format: 'unknown' as 'jvm-trial-v1' }))
    .rejects.toMatchObject({ code: 'invalid_request' })
})

it('独立解析错误不能被空汇总隐藏，也不回显原始错误正文', async () => {
  const { root } = await nativeCrap()
  await json(root, 'strict-parse-files.json', [{ file: 'PRIVATE_SOURCE', error: 'PRIVATE_ERROR' }])
  const result = await inspectNative(root)
  expect(result.evidence).toBe('insufficient_evidence')
  expect(codes(result)).toContain('parse_errors_conflict')
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})

it('原生工具错误和未知报告版本保留缺证，不变成阈值发现', async () => {
  const { root, summary, report } = await nativeCrap()
  summary.exitCodes.gate = 1
  report.schema_version = 2
  await json(root, 'summary.json', summary)
  await json(root, 'gate.json', report)
  const result = await inspectNative(root)
  expect(result).toMatchObject({ reportedExecution: 'failed', evidence: 'insufficient_evidence' })
  expect(codes(result)).toContain('native_execution_failed')
  expect(codes(result)).toContain('unsupported_report')
})

it('原生函数仅重新排序不产生冲突，摘要仍绑定原始文件', async () => {
  const { root, report } = await nativeCrap()
  report.functions.push({ ...report.functions[0]!, name: 'other', start_line: 4, end_line: 6 })
  report.summary.functions = 2
  await json(root, 'gate.json', report)
  await json(root, 'strict-parse.json', { ...report, functions: [...report.functions].reverse() })
  expect((await inspectNative(root)).evidence).toBe('review_required')
})

it('方法范围与总计独立保留，不能声明多于总计的杀死数量', async () => {
  const { root, summary } = await jvm()
  summary.mutation.scope[0]!.total = 3
  summary.mutation.scope[0]!.counts.KILLED = 3
  await json(root, 'summary.json', summary)
  await json(root, 'mutation-scope.json', summary.mutation.scope)
  const result = await inspectJvm(root)
  expect(result.evidence).toBe('insufficient_evidence')
  expect(codes(result)).toContain('mutation_scope_incomplete')
})

it('输入清单仅重新排序时保持身份，改变原始文件仍改变包摘要', async () => {
  const { root } = await jvm()
  const entries = [{ path: 'b.kt', sha256: sha }, { path: 'a.kt', sha256: 'b'.repeat(64) }]
  for (const name of ['inputs-before.json', 'inputs-after.json']) await json(root, name, entries)
  const first = await inspectJvm(root)
  for (const name of ['inputs-before.json', 'inputs-after.json']) await json(root, name, [...entries].reverse())
  const second = await inspectJvm(root)
  expect(second.evidence).toBe('review_required')
  expect(second.declaredIdentity.inputDigest).toBe(first.declaredIdentity.inputDigest)
  expect(second.bundleDigest).not.toBe(first.bundleDigest)
})

it('多个合法大小文件也必须服从总读取预算', async () => {
  const { root } = await jvm()
  const raw = Buffer.alloc(4 * 1024 * 1024, 'x')
  for (const name of ['tools.json', 'plugin-build.json', 'coverage.xml', 'symbols.xml', 'detekt.sarif', 'pit/mutations.xml'])
    await writeFile(join(root, name), raw)
  const result = await inspectJvm(root)
  expect(result.evidence).toBe('insufficient_evidence')
  expect(result.artifacts).toContainEqual({ name: 'pit/mutations.xml', status: 'oversized' })
  expect(result.artifacts.reduce((sum, file) => sum + (file.bytes ?? 0), 0)).toBeLessThanOrEqual(24 * 1024 * 1024)
})

const runCli = async (args: string[]) => {
  try {
    const result = await promisify(execFile)(process.execPath, ['scripts/development-quality.mjs', ...args],
      { cwd: resolve(import.meta.dirname, '..'), windowsHide: true, timeout: 10_000 })
    return { ...result, code: 0 }
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string }
    if (typeof result.code !== 'number') throw error
    return result
  }
}
it.runIf(process.env.SUPERSERVE_TEST_BUILT_QUALITY === '1')('实际 CLI 区分帮助、待审查、缺证与参数错误', async () => {
  const { root } = await jvm()
  const help = await runCli(['--help'])
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('只读解释')
  const review = await runCli(['--directory', root, '--format', 'jvm-trial-v1'])
  expect(review.code).toBe(3)
  expect(JSON.parse(review.stdout)).toMatchObject({ evidence: 'review_required', assurance: { publishAllowed: false } })
  const absent = await runCli(['--directory', await directory(), '--format', 'jvm-trial-v1'])
  expect(absent.code).toBe(2)
  expect(JSON.parse(absent.stdout).evidence).toBe('insufficient_evidence')
  const invalid = await runCli(['--PRIVATE_ARGUMENT'])
  expect(invalid.code).toBe(1)
  expect(JSON.parse(invalid.stderr).error).toBe('import_failed')
  expect(invalid.stderr).not.toContain('PRIVATE_ARGUMENT')
})
