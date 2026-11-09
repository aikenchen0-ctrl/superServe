import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { DevelopmentChanges } from '../src/development/changes.ts'
import { inspectDevelopmentSource } from '../src/development/inspect.ts'
import { inspectQualityEvidence } from '../src/development/quality.ts'
import { OptimizationReports } from '../src/development/optimization-reports.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let directory: string, root: string, reportDirectory: string, h: Host, taskId: string, declarations: DevelopmentChanges
let source: Awaited<ReturnType<typeof inspectDevelopmentSource>>
let module: ReturnType<DevelopmentChanges['module']>
let profile: ReturnType<Host['runtime']['developmentQuality']['save']>['profile']
let suggestion: ReturnType<Host['runtime']['optimizationSuggestions']['save']>['suggestion']
const git = async (...args: string[]) => (await exec('git', ['-c', 'user.name=Report test',
  '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks',
  '-C', root, ...args], { env: gitEnv(), windowsHide: true })).stdout.trim()
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value))
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'superserve-report-observations-'))
  root = join(directory, 'source')
  await mkdir(root); await writeFile(join(root, 'source.cpp'), 'int sample() { return 1; }\n')
  await git('init', '--initial-branch=main'); await git('add', '.'); await git('commit', '-m', 'source')
  source = await inspectDevelopmentSource({ repository: root })
})
const intent = (revision = 0) => ({ requestId: `intent-${revision}`, revision, worktreePath: root,
  baseCommit: source.source.commit, owner: 'owner', purpose: '核对优化依据',
  modules: [{ id: module.id, revision: module.revision }], reads: ['source.cpp'], writes: ['source.cpp'],
  contracts: [], acceptance: ['保持已有行为'] })
const input = () => ({ changeRevision: 1, profileId: profile.id, profileRevision: 1,
  finding: '复杂度需要审查', proposal: '先核对报告再判断是否修改', validation: '保持行为与测量范围' })
async function nativeReport(path: string, commit = source.source.commit) {
  await mkdir(path, { recursive: true })
  await json(join(path, 'summary.json'), { sourceCommit: commit, workingTreeDiffSha256: 'a'.repeat(64), firstPartyFiles: 1,
    filters: ['*.cpp'], jvmCoverageUsable: true, gateThreshold: 6, syntaxTreeErrors: [],
    source: 'PRIVATE_SOURCE', secret: 'PRIVATE_SECRET', exitCodes: { ctestCoverage: 0, jvmNativeCoverage: 0, exploration: 0, gate: 0, strictParse: 0 } })
  await json(join(path, 'source-manifest.json'), [{ path: 'PRIVATE_SOURCE_PATH', sha256: 'a'.repeat(64) }])
  const report = { schema_version: 1, tool: 'crap4cpp', version: '1.0.0',
    summary: { functions: 1, missing_coverage: 0, over_limit: 0, limit: 6 },
    functions: [{ file: 'sample.cpp', name: 'sample', start_line: 1, end_line: 8, complexity: 2, coverage: 100, crap: 2 }] }
  for (const name of ['gate.json', 'strict-parse.json']) await json(join(path, name), report)
  await json(join(path, 'strict-parse-files.json'), [])
  for (const name of ['native-cobertura.xml', 'jvm-native-cobertura.xml', 'combined-cobertura.xml'])
    await writeFile(join(path, name), 'PRIVATE_RAW_CONTENT')
}
beforeEach(async () => {
  h = await startRuntime(undefined, { mode: 'hmm' })
  declarations = new DevelopmentChanges(h.runtime.store, { available: () => true, inspect: async () => structuredClone(source) })
  taskId = (await h.api('POST', 'tasks', { requestId: 'task', goal: '核对优化依据', dispatch: false })).body.ticketId as string
  module = (await declarations.saveModule({ requestId: 'module', revision: 0, repositoryPath: root,
    name: 'sample', paths: ['.'], contracts: [], acceptance: ['保持已有行为'] })).module
  await declarations.save(taskId, intent())
  profile = h.runtime.developmentQuality.save({ requestId: 'profile', revision: 0, name: 'native',
    module: { id: module.id, revision: module.revision }, format: 'native-crap-v1',
    recipe: { repositoryId: module.repositoryId, commit: source.source.commit, tree: source.source.tree, path: '.' },
    configuration: { path: 'targets.json', sha256: 'a'.repeat(64) },
    tools: [{ name: 'crap', version: 'test', sha256: 'b'.repeat(64) }],
    environment: { runtime: 'windows', architecture: 'x64' } }).profile
  suggestion = h.runtime.optimizationSuggestions.save(taskId, input()).suggestion
  reportDirectory = await mkdtemp(join(directory, 'reports-'))
  await nativeReport(reportDirectory)
})
afterEach(async () => { vi.restoreAllMocks(); await h.stop() })
afterAll(async () => {
  const target = resolve(directory)
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !target.split(sep).at(-1)!.startsWith('superserve-report-observations-'))
    throw new Error('测试目录边界不符')
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
const service = () => h.runtime.optimizationReports
const capture = () => service().capture(taskId, suggestion.id, { directory: reportDirectory })
const list = () => service().list(taskId, suggestion.id)
const alternate = (inspect: typeof inspectQualityEvidence, signal = new AbortController().signal) =>
  new OptimizationReports(h.runtime.store, h.runtime.optimizationSuggestions, h.runtime.developmentQuality,
    { available: () => true, now: () => new Date().toISOString(), signal, inspect })

it('真实 HTTP 继承格式与提交，保存有界核对记录而非路径、正文、工作区或执行许可', async () => {
  const before = await readFile(join(reportDirectory, 'summary.json'))
  const task = h.runtime.store.tickets.get(taskId)
  const result = await h.api('POST', `tasks/${taskId}/quality/suggestions/${suggestion.id}/reports`, { directory: reportDirectory })
  expect(result).toMatchObject({ status: 200, body: { created: true,
    receipt: { suggestionId: suggestion.id, report: { adapter: 'native-crap-v1', evidence: 'review_required',
      declaredIdentity: { sourceCommit: source.source.commit } } },
    assurance: { receiptPersisted: true, sourceAuthenticated: false,
      inputClosureVerified: false, executionAuthorized: false, publishAllowed: false }, retained: null } })
  const stored = list()
  expect(await h.api('GET', `tasks/${taskId}/quality/suggestions/${suggestion.id}/reports`)).toEqual({ status: 200, body: stored })
  const text = JSON.stringify(h.runtime.store.keys('development:optimization-report:').map(key => h.runtime.store.get(key)))
  expect(text).not.toContain('PRIVATE_'); expect(text).not.toContain(reportDirectory); expect(text).not.toContain(root)
  expect(h.runtime.store.keys('development:quality-file:')).toEqual([])
  expect(stored.retained).toEqual({ [stored.items[0]!.id]: null })
  expect(await readFile(join(reportDirectory, 'summary.json'))).toEqual(before)
  expect(h.runtime.store.tickets.get(taskId)).toEqual(task)
  expect(h.runtime.workspaces.list().items).toEqual([])
  expect(h.nodeFactory).not.toHaveBeenCalled()
  await h.restart()
  await writeFile(join(reportDirectory, 'summary.json'), 'changed after observation')
  expect(list()).toEqual(stored)
})

it('默认摘要记录可显式补留同次字节；原目录改变后重启仍取回原件，重复采集不扩大存储', async () => {
  const summary = await readFile(join(reportDirectory, 'summary.json'))
  const first = await capture(), before = list()
  const result = await h.api('POST', `tasks/${taskId}/quality/suggestions/${suggestion.id}/reports`,
    { directory: reportDirectory, retainRaw: true })
  expect(result).toMatchObject({ status: 200, body: { created: false, receipt: JSON.parse(JSON.stringify(first.receipt)),
    retained: { scope: 'observed_bytes_only', files: expect.arrayContaining([expect.objectContaining({ name: 'summary.json' })]) } } })
  expect(list().snapshot).not.toBe(before.snapshot)
  const blobs = h.runtime.store.keys('development:quality-file:')
  const stored = list()
  await service().capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })
  expect(h.runtime.store.keys('development:quality-file:')).toEqual(blobs)
  expect(list()).toEqual(stored)
  expect((await capture()).retained).toEqual(stored.retained[first.receipt.id])
  expect(list()).toEqual(stored)
  await h.restart()
  await writeFile(join(reportDirectory, 'summary.json'), 'replaced')
  const file = await h.api('GET', `tasks/${taskId}/quality/suggestions/${suggestion.id}/reports/${first.receipt.id}/file?name=summary.json`)
  expect(file).toMatchObject({ status: 200, body: { name: 'summary.json', bytes: summary.length,
    sha256: createHash('sha256').update(summary).digest('hex') } })
  expect(Buffer.from(file.body.base64 as string, 'base64')).toEqual(summary)
  expect(file.body).not.toHaveProperty('directory')
})

it('内容字节可跨建议共享，但不能越过任务、建议、报告与文件归属取回', async () => {
  const first = await service().capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })
  const before = h.runtime.store.keys('development:quality-file:')
  const another = h.runtime.optimizationSuggestions.save(taskId, { ...input(), finding: '另一项独立问题' }).suggestion
  const second = await service().capture(taskId, another.id, { directory: reportDirectory, retainRaw: true })
  expect(first.receipt.id).not.toBe(second.receipt.id)
  expect(h.runtime.store.keys('development:quality-file:')).toEqual(before)
  expect(() => service().file(taskId, another.id, first.receipt.id, { name: 'summary.json' }))
    .toThrow(expect.objectContaining({ code: 'optimization_report_missing' }))
  const peer = (await h.api('POST', 'tasks', { requestId: 'peer', goal: '其他任务', dispatch: false })).body.ticketId as string
  await declarations.save(peer, intent())
  expect(() => service().file(peer, suggestion.id, first.receipt.id, { name: 'summary.json' })).toThrow()
  for (const name of ['../summary.json', '/summary.json', 'never-read.txt', 'a'.repeat(64)]) {
    expect(() => service().file(taskId, suggestion.id, first.receipt.id, { name })).toThrow()
  }
})

it('无已读字节不伪造留存成功；格式无效的已读原文仍可明确保留，不改成通过', async () => {
  const empty = await mkdtemp(join(directory, 'empty-retained-'))
  expect(await service().capture(taskId, suggestion.id, { directory: empty, retainRaw: true }))
    .toMatchObject({ retained: null, receipt: { report: { evidence: 'insufficient_evidence' } } })
  expect(h.runtime.store.keys('development:quality-file:')).toEqual([])
  const invalid = Buffer.from([0xff, 0xfe, 0, 0x80])
  await writeFile(join(reportDirectory, 'summary.json'), invalid)
  const result = await service().capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })
  expect(result.receipt.report.evidence).toBe('insufficient_evidence')
  expect(Buffer.from(service().file(taskId, suggestion.id, result.receipt.id, { name: 'summary.json' }).base64, 'base64')).toEqual(invalid)
})

it('原件写后故障回滚字节和链接；重试不承认部分保存，取消不留下原件', async () => {
  const write = h.runtime.store.set.bind(h.runtime.store)
  const spy = vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => {
    write(key, value)
    if (key.startsWith('development:quality-files:')) throw new Error('模拟原件链接写入失败')
  })
  await expect(service().capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })).rejects.toThrow('模拟原件链接')
  spy.mockRestore()
  expect(list().total).toBe(0)
  expect(h.runtime.store.keys('development:quality-file:')).toEqual([])
  const abort = new AbortController()
  const reading = alternate(async (...args) => {
    const result = await inspectQualityEvidence(...args); abort.abort(); return result
  }, abort.signal)
  await expect(reading.capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })).rejects.toThrow()
  expect(h.runtime.store.keys('development:quality-file:')).toEqual([])
  expect((await service().capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })).retained).not.toBeNull()
})

it('必须留存实际同次字节，不能因后续路径变化而重新读取或用不匹配字节冒充', async () => {
  const before = await readFile(join(reportDirectory, 'summary.json'))
  const reading = alternate(async (...args) => {
    const result = await inspectQualityEvidence(...args)
    await writeFile(join(reportDirectory, 'summary.json'), 'changed after inspection')
    return result
  })
  const result = await reading.capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })
  expect(Buffer.from(service().file(taskId, suggestion.id, result.receipt.id, { name: 'summary.json' }).base64, 'base64')).toEqual(before)
  const corrupt = alternate(async (...args) => {
    const report = await inspectQualityEvidence(...args)
    args[2]?.set('summary.json', Buffer.from('different bytes'))
    return report
  })
  await expect(corrupt.capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true }))
    .rejects.toMatchObject({ code: 'optimization_archive_corrupt' })
  expect(list().total).toBe(1)
})

it('已保存字节损坏时禁止取回或重放成功，不从原目录静默补写', async () => {
  const result = await service().capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true })
  const file = result.retained!.files.find(item => item.name === 'summary.json')!
  const key = h.runtime.store.keys('development:quality-file:').find(key => key.endsWith(file.sha256))!
  const value = h.runtime.store.get(key) as { base64: string }
  h.runtime.store.set(key, { ...value, base64: 'ZmFrZQ==' })
  expect(() => service().file(taskId, suggestion.id, result.receipt.id, { name: file.name }))
    .toThrow(expect.objectContaining({ code: 'optimization_archive_corrupt' }))
  await expect(service().capture(taskId, suggestion.id, { directory: reportDirectory, retainRaw: true }))
    .rejects.toMatchObject({ code: 'optimization_archive_corrupt' })
  expect(h.runtime.store.get(key)).toEqual({ ...value, base64: 'ZmFrZQ==' })
})

it('相同字节跨目录或重复提交复用原记录；原文件改动新建记录且保留失败与旧依据', async () => {
  const first = await capture()
  const other = join(directory, `copy-${suggestion.id}`)
  await cp(reportDirectory, other, { recursive: true })
  expect(await service().capture(taskId, suggestion.id, { directory: other }))
    .toEqual({ ...first, created: false })
  await writeFile(join(reportDirectory, 'summary.json'), '{"broken":')
  const next = await capture()
  expect(next.receipt.id).not.toBe(first.receipt.id)
  expect(next.receipt.report.evidence).toBe('insufficient_evidence')
  expect(list().items).toEqual(expect.arrayContaining([first.receipt, next.receipt]))
})

it('报告缺失与提交不匹配均保留观察，不能误报为空、成功或适用于当前工作区', async () => {
  await nativeReport(reportDirectory, 'f'.repeat(40))
  const mismatch = await capture()
  expect(mismatch.receipt.report.evidence).toBe('stale')
  expect(mismatch.receipt.report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'expected_identity_mismatch' })]))
  const empty = await mkdtemp(join(directory, 'empty-'))
  const missing = await service().capture(taskId, suggestion.id, { directory: empty })
  expect(missing.receipt.report.evidence).toBe('insufficient_evidence')
  expect(missing.receipt.report.artifacts).toContainEqual({ name: 'summary.json', status: 'missing' })
  expect(list().total).toBe(2)
})

it('读取期间任务依据变化不重绑原建议；关注动作独立保留', async () => {
  const reading = alternate(async (...args) => {
    const result = await inspectQualityEvidence(...args)
    await declarations.save(taskId, { ...intent(1), acceptance: ['新行为要求'] })
    h.runtime.optimizationSuggestions.decide(taskId, suggestion.id, { revision: 1, action: 'defer' })
    return result
  })
  const result = await reading.capture(taskId, suggestion.id, { directory: reportDirectory })
  expect(result.applicability).toEqual({ state: 'needs_reassessment', reasons: ['scope_changed'] })
  expect(result.receipt.suggestionId).toBe(suggestion.id)
  expect(list().binding).toEqual(suggestion.binding)
  expect(h.runtime.optimizationSuggestions.get(taskId, suggestion.id).disposition).toBe('deferred')
})

it('旧配置记录决定解释格式，不因当前配置升级而把历史报告按另一种格式解释', async () => {
  const { id: _, digest: __, schemaVersion: ___, repositoryId: ____, ...definition } = profile
  h.runtime.developmentQuality.save({ ...definition, revision: 1, requestId: 'next-profile', format: 'jvm-trial-v1' })
  const result = await capture()
  expect(result.receipt.report.adapter).toBe('native-crap-v1')
  expect(result.applicability.reasons).toContain('profile_changed')
})

it('采集取消后不保存部分记录，旧读取未结束时不释放单次读取预算', async () => {
  const aborted = new AbortController()
  let finish!: () => void
  const pending = new Promise<void>(done => { finish = done })
  const inspect = vi.fn(async (...args: Parameters<typeof inspectQualityEvidence>) => {
    const result = await inspectQualityEvidence(...args)
    await pending
    return result
  })
  const reading = alternate(inspect, aborted.signal)
  const result = reading.capture(taskId, suggestion.id, { directory: reportDirectory })
  await expect(reading.capture(taskId, suggestion.id, { directory: reportDirectory }))
    .rejects.toMatchObject({ code: 'optimization_report_busy' })
  aborted.abort(); finish()
  await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/cancelled|runtime_unavailable/) })
  expect(list().total).toBe(0)
})

it('采集失败释放读取预算；错误目录不给出路径、原文或成功收据', async () => {
  await expect(service().capture(taskId, suggestion.id, { directory: join(directory, 'PRIVATE_MISSING') }))
    .rejects.toMatchObject({ code: 'optimization_report_path_unavailable', message: '证据目录不可读取' })
  expect(list().total).toBe(0)
  expect((await capture()).created).toBe(true)
})

it('写后故障原子回滚，丢失回执可由第二连接读取并幂等重试', async () => {
  const original = h.runtime.store.set.bind(h.runtime.store)
  const spy = vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => {
    original(key, value)
    if (key.startsWith('development:optimization-report:')) throw new Error('模拟持久化失败')
  })
  await expect(capture()).rejects.toThrow('模拟持久化失败')
  expect(list().total).toBe(0)
  spy.mockRestore()
  const saved = await capture()
  const peer = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const other = new OptimizationReports(peer, h.runtime.optimizationSuggestions, h.runtime.developmentQuality, {
      available: () => true, now: () => new Date().toISOString(), signal: new AbortController().signal, inspect: inspectQualityEvidence,
    })
    expect(other.list(taskId, suggestion.id).items).toEqual([saved.receipt])
    expect(await other.capture(taskId, suggestion.id, { directory: reportDirectory })).toEqual({ ...saved, created: false })
  } finally { peer.close() }
})

it('分页快照禁止拼接新旧集合；达到容量不删除历史，相同内容仍可重放', async () => {
  for (let index = 0; index < 16; index++) {
    await writeFile(join(reportDirectory, 'native-cobertura.xml'), `coverage ${index}`)
    await capture()
  }
  const first = list(), second = service().list(taskId, suggestion.id, { offset: 8, snapshot: first.snapshot })
  expect(first.items).toHaveLength(8); expect(second.items).toHaveLength(8)
  expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(16)
  expect((await capture()).created).toBe(false)
  await writeFile(join(reportDirectory, 'native-cobertura.xml'), 'over capacity')
  await expect(capture()).rejects.toMatchObject({ code: 'optimization_report_budget' })
  expect(list()).toEqual(first)
  await declarations.save(taskId, { ...intent(1), acceptance: ['新要求'] })
  expect(() => service().list(taskId, suggestion.id, { offset: 8, snapshot: first.snapshot }))
    .toThrow(expect.objectContaining({ code: 'optimization_report_changed' }))
  expect(() => service().list(taskId, suggestion.id, { offset: 8 })).toThrow()
})

it('记录正文损坏、过大解释结果、跨任务引用均不得默默接受', async () => {
  const saved = await capture()
  const peer = (await h.api('POST', 'tasks', { requestId: 'peer', goal: '另一任务', dispatch: false })).body.ticketId as string
  await declarations.save(peer, intent())
  const inspect = vi.fn(inspectQualityEvidence)
  await expect(alternate(inspect).capture(peer, suggestion.id, { directory: reportDirectory }))
    .rejects.toMatchObject({ code: 'optimization_missing' })
  expect(inspect).not.toHaveBeenCalled()
  const big = alternate(async (...args) => ({ ...await inspectQualityEvidence(...args), issues: Array.from({ length: 128 },
    () => ({ code: 'large', kind: 'review' as const, message: 'a'.repeat(1000), action: 'b'.repeat(1000) })) }))
  await expect(big.capture(taskId, suggestion.id, { directory: reportDirectory })).rejects.toMatchObject({ code: 'optimization_report_budget' })
  expect(list().items).toEqual([saved.receipt])
  const key = h.runtime.store.keys('development:optimization-report:')[0]!
  h.runtime.store.set(key, { ...saved.receipt, report: { ...saved.receipt.report, evidence: 'review_required', bundleDigest: 'f'.repeat(64) } })
  expect(list).toThrow(expect.objectContaining({ code: 'optimization_report_corrupt' }))
})

it('调用方不能替换格式、提交、依据或自行声明许可', async () => {
  for (const extra of [{ expectedCommit: 'f'.repeat(40) }, { format: 'jvm-trial-v1' }, { publishAllowed: true }])
    expect(await h.api('POST', `tasks/${taskId}/quality/suggestions/${suggestion.id}/reports`,
      { directory: reportDirectory, ...extra })).toMatchObject({ status: 400 })
  expect(list().total).toBe(0)
})
