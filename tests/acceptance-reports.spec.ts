import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AcceptanceReports } from '../src/development/acceptance-reports.ts'
import { acceptancePreview } from './fixtures/acceptance-basis.ts'
import { acceptanceMapping } from '../src/development/acceptance-checks.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('acceptance-report-')) throw new Error('测试目录归属异常')
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-report-')); roots.push(root)
  const view = acceptancePreview()
  view.basis.profile.checks = [{ id: 'contract', title: '契约', requires: [], requirements: [],
    command: { tool: 'tool', cwd: { root: 'source', path: '.' }, argv: [] },
    result: { format: 'junit-xml', path: 'Reports/Test Results.XML', minimumTests: 1 }, timeoutMs: 1000 }]
  view.mapping = acceptanceMapping(view.basis.task.acceptance, view.basis.module.acceptance, view.basis.profile.checks)
  const preview = vi.fn(() => view), controller = new AbortController()
  const service = new AcceptanceReports({ preview }, { available: () => true, signal: controller.signal })
  const input = { sourceCheckId: view.source.requestId, basisDigest: view.basisDigest, revision: 0, checkId: 'contract', directory: root }
  await mkdir(join(root, 'Reports'))
  return { root, view, preview, service, input, controller, file: join(root, 'Reports', 'Test Results.XML') }
}
it('读取固定结果路径并返回计数；大小写空格合法，不回显目录或正文，不落库', async () => {
  const f = await setup()
  await writeFile(f.file, '<testsuite tests="1"><testcase name="PRIVATE_NAME"/></testsuite>')
  const result = await f.service.inspect('task-a', f.input)
  expect(result).toMatchObject({ persisted: false, report: { state: 'content_consistent', counts: { tests: 1 } },
    assurance: { reportMatchesSource: false, executionAuthenticated: false, publishAllowed: false } })
  expect(JSON.stringify(result)).not.toContain(f.root)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NAME')
})
it('未提供目录时只读取持久输出根，不把路径写入请求或可信结论', async () => {
  const f = await setup(), output = await mkdtemp(join(tmpdir(), 'acceptance-report-output-')); roots.push(output)
  await mkdir(join(output, 'Reports'))
  await writeFile(join(output, 'Reports', 'Test Results.XML'), '<testsuite tests="1"><testcase name="one"/></testsuite>')
  const prepared = vi.fn(async () => ({ current: true, outputDirectory: output }))
  const prepare = vi.fn()
  const service = new AcceptanceReports({ preview: f.preview }, {
    available: () => true, signal: f.controller.signal, preparedSource: prepared, prepareSource: prepare,
  })
  const { directory: _directory, ...input } = f.input
  const result = await service.inspect('task-a', input)
  expect(prepared).toHaveBeenCalledWith('task-a', f.input.sourceCheckId)
  expect(prepare).not.toHaveBeenCalled()
  expect(result).toMatchObject({ report: { state: 'content_consistent' }, assurance: { outputRootBound: true } })
})
it('缺报告不等于未执行或成功；外来 passed、格式或路径不能替换配置', async () => {
  const f = await setup()
  expect(await f.service.inspect('task-a', f.input)).toMatchObject({ artifact: { status: 'missing' }, report: null })
  await expect(f.service.inspect('task-a', { ...f.input, passed: true, path: 'elsewhere' })).rejects.toThrow()
  await expect(f.service.inspect('task-a', { ...f.input, checkId: 'missing' })).rejects.toMatchObject({ code: 'acceptance_report_check_missing' })
})
it('读取期间依据变化不返回旧结果；并发报告明确忙而不排无限队列', async () => {
  const f = await setup()
  await writeFile(f.file, '<testsuite><testcase name="x"/></testsuite>')
  const first = f.service.inspect('task-a', f.input)
  await expect(f.service.inspect('task-a', f.input)).rejects.toMatchObject({ code: 'acceptance_report_busy' })
  f.preview.mockImplementation(() => ({ ...f.view, revision: 1 }))
  await expect(first).rejects.toMatchObject({ code: 'acceptance_report_stale' })
})
it('预取消与关闭不返回部分报告，也不重做目录读取', async () => {
  const f = await setup()
  f.controller.abort()
  await expect(f.service.inspect('task-a', f.input)).rejects.toMatchObject({ code: 'acceptance_report_cancelled' })
  await f.service.shutdown()
  await expect(f.service.inspect('task-a', f.input)).rejects.toMatchObject({ code: 'runtime_unavailable' })
})
it('嵌套目录链接拒绝，外部文件保持不变', async () => {
  const f = await setup(), other = await setup()
  await writeFile(other.file, 'PRIVATE_FILE')
  await rm(join(f.root, 'Reports'), { recursive: true })
  await symlink(join(other.root, 'Reports'), join(f.root, 'Reports'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(f.service.inspect('task-a', f.input)).rejects.toMatchObject({ code: 'acceptance_report_unsafe_path' })
  expect(await readFile(other.file, 'utf8')).toBe('PRIVATE_FILE')
})
it.each(['../Other.xml', '/absolute.xml', 'C:/host.xml', '.git/config', 'Reports\\Test.xml'])('不接受路径 %s 越过显式目录', async path => {
  const f = await setup()
  f.view.mapping.checks[0]!.result.path = path
  await expect(f.service.inspect('task-a', f.input)).rejects.toMatchObject({ code: 'acceptance_report_invalid_request' })
})
