// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskCheckReport } from '../src/client/task-check-report.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { parseTestReport } from '../src/development/test-report.ts'
import type { AcceptanceCheck } from '../src/development/acceptance-checks.ts'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, args?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (text, name: string) => args?.[name] !== undefined ? String(args[name]) : text)) as T
const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
async function fixture() {
  const check: AcceptanceCheck = { id: 'contract', title: '契约', requires: [], requirements: [], timeoutMs: 1000,
    command: { tool: 'tool', cwd: { root: 'source', path: '.' }, argv: [] },
    result: { format: 'junit-xml', path: 'Results/Test.xml', minimumTests: 1 } }
  const props = { id: 'task-a', sourceCheckId: '00000000-0000-4000-8000-000000000001',
    combinationId: 'a'.repeat(64), basisDigest: 'b'.repeat(64), revision: 1, check }
  const report = parseTestReport(Buffer.from('<testsuite tests="1"><testcase name="one"/></testsuite>'), check.result)
  const response = { ticketId: props.id, sourceCheckId: props.sourceCheckId, combinationId: props.combinationId,
    basisDigest: props.basisDigest, revision: 1, checkId: check.id, persisted: false, observedAt: '2026-11-08T00:00:00Z',
    report, artifact: { name: check.result.path, status: 'read', bytes: report.bytes, sha256: report.sha256 },
    assurance: { contentOnly: true, outputRootBound: true, executionAuthenticated: false, reportMatchesSource: false,
      coverageVerified: false, publishAllowed: false } }
  const requests: Record<string, unknown>[] = [], control = { pending: undefined as (() => Promise<Response>) | undefined }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/state')) return Response.json({ load: { running: 0, queued: 0 } })
    requests.push(JSON.parse(String(init?.body)))
    return control.pending?.() ?? Response.json(response)
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (key = 'first') => act(async () => root.render(<PanelProvider t={t} interval={60000}>
    <TaskCheckReport key={key} {...props} /></PanelProvider>))
  await render()
  disposals.push(() => { act(() => root.unmount()); container.remove() })
  const click = async () => { await act(async () => container.querySelector<HTMLButtonElement>('button')!.click()); await flush() }
  return { container, response, requests, control, click, render }
}
it('通过受控输出根读取一次并继承固定检查，不发送路径、格式或通过结论', async () => {
  const view = await fixture()
  expect(view.requests).toHaveLength(0)
  await view.click()
  expect(view.requests).toHaveLength(1)
  expect(view.requests[0]).not.toHaveProperty('directory')
  expect(view.requests[0]).not.toHaveProperty('format')
  expect(view.requests[0]).not.toHaveProperty('passed')
  expect(view.container.textContent).toContain(zh['task.checkReport.content_consistent'])
  expect(view.container.textContent).toContain(zh['task.checkReport.scope'])
})
it.each(['source', 'path', 'digest', 'authority'])('%s 错配回执不能显示内容一致', async scenario => {
  const view = await fixture()
  if (scenario === 'source') view.response.combinationId = 'f'.repeat(64)
  if (scenario === 'path') view.response.artifact.name = 'Other.xml'
  if (scenario === 'digest') view.response.artifact.sha256 = 'f'.repeat(64)
  if (scenario === 'authority') view.response.assurance.publishAllowed = true
  await view.click()
  expect(view.container.textContent).not.toContain(zh['task.checkReport.content_consistent'])
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull()
})
it('重复点击去重，离页迟到结果不能污染新访问', async () => {
  const view = await fixture()
  let done!: (value: Response) => void
  view.control.pending = () => new Promise(resolve => { done = resolve })
  await act(async () => { const button = view.container.querySelector<HTMLButtonElement>('button')!; button.click(); button.click() })
  expect(view.requests).toHaveLength(1)
  await view.render('next')
  done(Response.json(view.response)); await flush()
  expect(view.container.querySelector('[role="status"]')).toBeNull()
})
it('旧宿主或读取错误不隐式重试', async () => {
  const view = await fixture()
  view.control.pending = async () => Response.json({ error: '当前无法核对报告' }, { status: 404 })
  await view.click()
  expect(view.requests).toHaveLength(1)
  expect(view.container.textContent).toContain('当前无法核对报告')
})
