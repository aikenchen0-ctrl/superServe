// @vitest-environment jsdom
import { act } from 'react'
import { webcrypto } from 'node:crypto'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelProvider } from '../src/client/provider.tsx'
import { OptimizationReportPanel } from '../src/client/optimization-reports.tsx'
import { zh } from '../src/client/locales.ts'
import { fullTime, type T } from '../src/client/text.ts'
import { reportCatalog, reportReceipt, retainedReportCatalog, reportFile } from './fixtures/optimization-reports.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, args?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (match, name: string) => args && name in args ? String(args[name]) : match)) as T
const suggestionId = 'a'.repeat(64)
const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
function fixture() {
  const requests: { method: string; path: string; query: string; body?: Record<string, unknown> }[] = []
  const control = { catalog: reportCatalog(), read: undefined as undefined | (() => Promise<Response>),
    capture: undefined as undefined | (() => Promise<Response>), file: undefined as undefined | (() => Promise<Response>) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, 'http://localhost'), method = init?.method ?? 'GET'
    const path = parsed.pathname.replace('/orchestrator/api/', '')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, query: parsed.search, body })
    if (path === 'state') return Response.json({ load: { running: 0, queued: 0 } })
    if (path.endsWith('/file')) return control.file?.() ?? Response.json(reportFile(control.catalog))
    if (path.endsWith('/reports')) return method === 'POST'
      ? control.capture?.() ?? Response.json(reportReceipt(control.catalog))
      : control.read?.() ?? Response.json(control.catalog)
    return Response.json({ error: '未预期请求' }, { status: 404 })
  }))
  return { control, requests, reads: () => requests.filter(value => value.path.endsWith('/reports') && value.method === 'GET'),
    writes: () => requests.filter(value => value.method === 'POST') }
}
async function render() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (id = 'task-a', selected = suggestionId) => {
    await act(async () => { root.render(<PanelProvider t={t} interval={60_000}>
      <OptimizationReportPanel key={`${id}:${selected}`} id={id} suggestionId={selected} /></PanelProvider>) })
    await flush()
  }
  disposals.push(() => { act(() => root.unmount()); container.remove() })
  await update()
  const button = (key: keyof typeof zh) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === zh[key])!
  const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); await flush() }
  const fill = async (value = 'O:/reports/private') => {
    const field = container.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { container, update, button, click, fill }
}
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}

it('详情仅读取已有记录；只填目录即可核对，版本与格式不要求重复输入', async () => {
  const run = fixture(), view = await render()
  expect(run.reads()).toHaveLength(1); expect(run.writes()).toEqual([])
  expect(view.container.querySelectorAll('input:not([type="checkbox"])')).toHaveLength(1)
  expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
  expect(view.button('task.report.capture').disabled).toBe(true)
  expect(view.container.textContent).toContain(zh['task.report.insufficient_evidence'])
  const before = [localStorage.length, sessionStorage.length]
  await view.fill(' O:/reports/private '); await view.click(view.button('task.report.capture'))
  expect(run.writes()).toEqual([{ method: 'POST',
    path: `tasks/task-a/quality/suggestions/${suggestionId}/reports`, query: '', body: { directory: 'O:/reports/private' } }])
  expect(run.reads()).toHaveLength(2)
  expect(view.container.querySelector('input')!.value).toBe('')
  expect([localStorage.length, sessionStorage.length]).toEqual(before)
})

it('声明完成仍显示缺证，原始身份、缺项与保留边界可按需查看', async () => {
  const run = fixture(), view = await render()
  run.control.catalog.applicability = { state: 'needs_reassessment', reasons: ['profile_changed'] }
  await view.click(view.button('task.report.reload'))
  await view.click(view.container.querySelector<HTMLElement>('[data-disclosure-row]')!)
  expect(view.container.textContent).toContain(zh['task.report.basisChanged'])
  expect(view.container.textContent).toContain(zh['task.report.execution.completed'])
  expect(view.container.textContent).toContain('覆盖率文件缺失')
  expect(view.container.textContent).toContain('1'.repeat(40))
  expect(view.container.textContent).toContain(zh['task.report.limit'])
  expect(view.container.textContent).toContain('native-cobertura.xml')
  expect(run.writes()).toEqual([])
})

it('连续提交不并发；失败保留目录供修正，重读不重放文件采集', async () => {
  const run = fixture(), view = await render(), pending = deferred()
  run.control.capture = () => pending.promise
  await view.fill()
  await act(async () => { view.button('task.report.capture').click(); view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(run.writes()).toHaveLength(1)
  expect(view.container.querySelector('input')!.disabled).toBe(true)
  pending.resolve(Response.json({ error: '报告仍在写入，请提供封存副本' }, { status: 400 })); await flush()
  expect(view.container.textContent).toContain('报告仍在写入')
  expect(view.container.querySelector('input')!.value).toBe('O:/reports/private')
  await view.click(view.button('task.report.reload'))
  expect(run.writes()).toHaveLength(1)
})

it.each(['read-success', 'read-failure', 'capture-success', 'capture-failure'])('返回原任务后 %s 的迟到响应不污染新访问', async scenario => {
  const run = fixture(), pending = deferred()
  if (scenario.startsWith('read')) run.control.read = () => pending.promise
  else run.control.capture = () => pending.promise
  const view = await render()
  if (scenario.startsWith('capture')) { await view.fill(); await view.click(view.button('task.report.capture')) }
  await view.update('task-b')
  run.control.read = undefined; run.control.capture = undefined
  await view.update('task-a')
  const reads = run.reads().length
  pending.resolve(scenario.endsWith('failure') ? Response.json({ error: '旧访问错误' }, { status: 500 })
    : Response.json(scenario.startsWith('read') ? { ...reportCatalog(), items: [] } : reportReceipt()))
  await flush()
  expect(view.container.textContent).not.toContain('旧访问错误')
  expect(view.container.textContent).not.toContain(zh['task.report.empty'])
  expect(view.container.textContent).toContain(zh['task.report.insufficient_evidence'])
  expect(run.reads()).toHaveLength(reads)
})

it.each(['null', 'wrong-task', 'wrong-suggestion', 'invalid-id'])('%s 采集回执不得显示为已保存', async kind => {
  const run = fixture(), view = await render(), receipt = reportReceipt()
  run.control.capture = async () => Response.json(kind === 'null' ? null : { ...receipt,
    ticketId: kind === 'wrong-task' ? 'task-b' : receipt.ticketId,
    receipt: { ...receipt.receipt, suggestionId: kind === 'wrong-suggestion' ? 'b'.repeat(64) : suggestionId,
      id: kind === 'invalid-id' ? 'invalid' : receipt.receipt.id } })
  await view.fill(); await view.click(view.button('task.report.capture'))
  expect(view.container.textContent).toContain(zh['task.report.unconfirmed'])
  expect(run.reads()).toHaveLength(1)
})

it('读取错误不能变成零记录；串任务回执被拒绝，重新读取不自动采集', async () => {
  const run = fixture()
  run.control.read = async () => Response.json(null)
  const view = await render()
  expect(view.container.textContent).toContain(zh['task.report.unconfirmed'])
  run.control.read = async () => Response.json(reportCatalog('task-b'))
  await view.click(view.button('task.report.reload'))
  expect(view.container.textContent).toContain(zh['task.report.unconfirmed'])
  run.control.read = async () => Response.json({ error: '核对记录读取失败' }, { status: 503 })
  await view.click(view.button('task.report.reload'))
  expect(view.container.textContent).toContain('核对记录读取失败')
  expect(view.container.textContent).not.toContain(zh['task.report.empty'])
  expect(run.writes()).toEqual([])
})

it('分页只显示当前页并继承快照，重读首页不保留目录和展开状态', async () => {
  const run = fixture()
  run.control.catalog.nextOffset = 8; run.control.catalog.total = 9
  const view = await render()
  await view.fill()
  const firstTime = run.control.catalog.items[0]!.recordedAt, snapshot = run.control.catalog.snapshot
  run.control.catalog.items[0]!.recordedAt = '2026-11-06T00:00:00.000Z'
  run.control.catalog.nextOffset = null
  await view.click(view.button('task.report.next'))
  expect(run.reads()[1]!.query).toContain(`snapshot=${snapshot}`)
  expect(run.reads()[1]!.query).toContain('offset=8')
  expect(view.container.textContent).not.toContain(fullTime(firstTime, 'zh'))
  expect(view.container.textContent).toContain(fullTime(run.control.catalog.items[0]!.recordedAt, 'zh'))
  expect(view.container.querySelectorAll('.dt-report-item')).toHaveLength(1)
  expect(view.container.querySelector('input')!.value).toBe('')
  await view.click(view.button('task.report.previous'))
  expect(run.reads()[2]!.query).toContain('offset=0')
  await view.click(view.button('task.report.reload'))
  expect(run.reads()[3]!.query).toBe('')
})

it('原件留存必须显式勾选；成功后清空目录与选择，不把下一次操作默认升级为留存', async () => {
  const run = fixture(), view = await render()
  await view.click(view.container.querySelector<HTMLElement>('input[type="checkbox"]')!)
  expect(view.container.textContent).toContain(zh['task.report.retainNotice'])
  run.control.capture = async () => {
    run.control.catalog = retainedReportCatalog()
    return Response.json(reportReceipt(run.control.catalog))
  }
  await view.fill(); await view.click(view.button('task.report.capture'))
  expect(run.writes()[0]!.body).toEqual({ directory: 'O:/reports/private', retainRaw: true })
  expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
  expect(view.container.textContent).toContain('已保留 1 个已读文件，共 2 字节')
  expect(view.container.textContent).not.toContain(zh['task.report.retainNotice'])
})

function downloads() {
  const create = vi.fn((_blob: Blob) => 'blob:report-test'), revoke = vi.fn()
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  const clicks: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download) })
  return { create, revoke, clicks }
}
it('展开原件清单不下载；显式下载核对字节和摘要后创建文件，结束后释放对象链接', async () => {
  const run = fixture(), saved = downloads()
  run.control.catalog = retainedReportCatalog()
  const view = await render()
  await view.click(view.container.querySelector<HTMLElement>('[data-disclosure-row]')!)
  expect(run.requests.filter(item => item.path.endsWith('/file'))).toEqual([])
  await view.click(view.button('task.report.download'))
  await vi.waitFor(() => expect(saved.clicks).toEqual(['summary.json']))
  expect(saved.create.mock.calls[0]?.[0]).toMatchObject({ size: 2, type: 'application/octet-stream' })
  expect(saved.revoke).toHaveBeenCalledWith('blob:report-test')
  expect(run.requests.at(-1)).toMatchObject({ method: 'GET',
    path: `tasks/task-a/quality/suggestions/${suggestionId}/reports/${'3'.repeat(64)}/file`, query: '?name=summary.json' })
  expect(run.writes()).toEqual([])
})

it.each(['null', 'wrong-task', 'wrong-report', 'wrong-digest', 'wrong-bytes', 'bad-base64', 'tampered'])('%s 下载回执不生成文件', async kind => {
  const run = fixture(), saved = downloads()
  run.control.catalog = retainedReportCatalog()
  const file = reportFile(run.control.catalog)
  run.control.file = async () => Response.json(kind === 'null' ? null : { ...file,
    ticketId: kind === 'wrong-task' ? 'task-b' : file.ticketId,
    reportId: kind === 'wrong-report' ? 'f'.repeat(64) : file.reportId,
    sha256: kind === 'wrong-digest' ? 'b'.repeat(64) : file.sha256,
    bytes: kind === 'wrong-bytes' ? 3 : file.bytes,
    base64: kind === 'bad-base64' ? '!!!!' : kind === 'tampered' ? 'W10=' : file.base64 })
  const view = await render()
  await view.click(view.container.querySelector<HTMLElement>('[data-disclosure-row]')!)
  await view.click(view.button('task.report.download'))
  await vi.waitFor(() => expect(view.container.textContent).toContain(zh['task.report.fileUnconfirmed']))
  expect(saved.create).not.toHaveBeenCalled(); expect(saved.clicks).toEqual([])
})

it('下载返回前切换任务再返回，不产生迟到文件或把下载错误归给新访问', async () => {
  const run = fixture(), saved = downloads(), pending = deferred()
  run.control.catalog = retainedReportCatalog()
  run.control.file = () => pending.promise
  const view = await render()
  await view.click(view.container.querySelector<HTMLElement>('[data-disclosure-row]')!)
  await view.click(view.button('task.report.download'))
  await view.update('task-b'); await view.update('task-a')
  pending.resolve(Response.json(reportFile()))
  await flush()
  expect(saved.create).not.toHaveBeenCalled()
  expect(saved.clicks).toEqual([])
  expect(view.container.textContent).not.toContain(zh['task.report.fileUnconfirmed'])
})
