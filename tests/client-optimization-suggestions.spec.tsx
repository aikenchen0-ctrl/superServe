// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelProvider } from '../src/client/provider.tsx'
import { OptimizationPanel } from '../src/client/optimization-suggestions.tsx'
import type { ApiResponse } from '../src/app/api.ts'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import { reportCatalog } from './fixtures/optimization-reports.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, args?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (match, name: string) => args && name in args ? String(args[name]) : match)) as T
const profileId = 'e'.repeat(64), suggestionId = 'a'.repeat(64)
type Catalog = ApiResponse<'GET tasks/:id/quality/suggestions'>
function catalog(ticketId = 'task-a'): Catalog {
  return { ticketId, snapshot: 'c'.repeat(64), total: 1, nextOffset: null, items: [{
    suggestion: { schemaVersion: 1, id: suggestionId, ticketId, createdAt: '2026-11-07T00:00:00.000Z',
      binding: { changeRevision: 1, scopeDigest: 'b'.repeat(64), repositoryId: 'd'.repeat(64),
        source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), identity: 'c'.repeat(64), objectFormat: 'sha1' },
        module: { id: 'f'.repeat(64), revision: 1 }, profile: { id: profileId, revision: 1, digest: '1'.repeat(64) } },
      finding: '取消分支缺少反例，尚未确认产品缺陷。',
      proposal: '先补取消场景，再判断是否简化分支。',
      validation: '保持原验收范围，核对取消后的外部行为。', decisions: [] },
    revision: 1, disposition: 'open', applicability: { state: 'matches_registration', reasons: [] },
    taskEnded: false, assurance: { proposalOnly: true, evidenceVerified: false, executionAuthorized: false, publishAllowed: false },
  }] }
}
const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
function fixture() {
  const requests: { method: string; path: string; query: string; body?: Record<string, unknown> }[] = []
  const control = { catalog: catalog(), read: undefined as undefined | (() => Promise<Response>),
    decide: undefined as undefined | (() => Promise<Response>) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, 'http://localhost'), method = init?.method ?? 'GET'
    const path = parsed.pathname.replace('/orchestrator/api/', '')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, query: parsed.search, body })
    if (path === 'state') return Response.json({ load: { running: 0, queued: 0 } })
    if (path.endsWith('/reports')) return Response.json({ ...reportCatalog(), items: [], total: 0 })
    if (path.endsWith('/suggestions')) return control.read?.() ?? Response.json(control.catalog)
    if (path.endsWith('/decision')) {
      if (control.decide) return control.decide()
      const item = control.catalog.items[0]!
      item.revision++; item.disposition = body.action === 'defer' ? 'deferred' : 'open'
      return Response.json({ changed: true, ...item })
    }
    return Response.json({ error: '未预期请求' }, { status: 404 })
  }))
  return { control, requests, reads: () => requests.filter(value => value.path.endsWith('/suggestions')),
    writes: () => requests.filter(value => value.method === 'POST') }
}
async function render() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let disposed = false
  const update = async (id = 'task-a') => {
    await act(async () => { root.render(<PanelProvider t={t} interval={60_000}>
      <OptimizationPanel key={id} id={id} profileId={profileId} /></PanelProvider>) })
    await flush()
  }
  const dispose = () => { if (!disposed) { act(() => root.unmount()); container.remove(); disposed = true } }
  disposals.push(dispose)
  await update()
  const button = (key: keyof typeof zh) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === zh[key])!
  const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); await flush() }
  const toggle = () => click(container.querySelector<HTMLElement>('[data-disclosure-row]')!)
  return { container, update, dispose, button, click, toggle }
}
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}

it('折叠不读取，展开不写入；暂缓与恢复继承版本，仅重读建议而不派发执行', async () => {
  const run = fixture(), view = await render()
  expect(run.reads()).toEqual([])
  await view.toggle()
  expect(run.reads()).toHaveLength(1)
  expect(run.reads()[0]!.query).toBe(`?profileId=${profileId}`)
  expect(run.writes()).toEqual([])
  expect(run.requests.some(request => request.path.endsWith('/reports'))).toBe(false)
  expect(view.container.textContent).toContain(zh['task.optimization.aligned'])
  await view.click(view.button('task.optimization.defer'))
  expect(run.writes()).toEqual([{ method: 'POST',
    path: `tasks/task-a/quality/suggestions/${suggestionId}/decision`, query: '', body: { revision: 1, action: 'defer' } }])
  expect(view.container.textContent).toContain(zh['task.optimization.deferred'])
  await view.click(view.button('task.optimization.reopen'))
  expect(run.writes()[1]!.body).toEqual({ revision: 2, action: 'reopen' })
  expect(run.reads()).toHaveLength(3)
  expect(view.container.textContent).not.toContain(zh['task.optimization.deferred'])
})

it('过期依据保留原版本与原因，不能显示为已验证改进', async () => {
  const run = fixture(), view = await render()
  run.control.catalog.items[0]!.applicability = { state: 'needs_reassessment', reasons: ['source_changed', 'profile_changed'] }
  await view.toggle(); await view.click(view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')[1]!)
  expect(view.container.textContent).toContain(zh['task.optimization.stale'])
  expect(view.container.textContent).toContain(zh['task.optimization.source_changed'])
  expect(view.container.textContent).toContain(zh['task.optimization.profile_changed'])
  expect(view.container.textContent).toContain('a'.repeat(40))
  expect(view.container.textContent).toContain(zh['task.optimization.scope'])
  expect(view.container.textContent).not.toContain(zh['task.optimization.aligned'])
  expect(run.writes()).toEqual([])
})

it('连续点击不产生并发处理；版本冲突后要求重读且不自动重放', async () => {
  const run = fixture(), view = await render(), pending = deferred()
  run.control.decide = () => pending.promise
  await view.toggle()
  await act(async () => { view.button('task.optimization.defer').click(); view.button('task.optimization.defer').click() })
  expect(run.writes()).toHaveLength(1)
  pending.resolve(Response.json({ error: '其他人已处理' }, { status: 409 })); await flush()
  expect(view.container.textContent).toContain(zh['task.optimization.changed'])
  expect(view.button('task.optimization.defer').disabled).toBe(true)
  run.control.catalog.items[0]!.revision = 3
  run.control.decide = undefined
  await view.click(view.button('task.optimization.refresh'))
  expect(run.writes()).toHaveLength(1)
  await view.click(view.button('task.optimization.defer'))
  expect(run.writes()[1]!.body).toEqual({ revision: 3, action: 'defer' })
})

it.each(['read-success', 'read-failure', 'decision-success', 'decision-failure'])('换任务再返回时 %s 迟到不污染新访问', async scenario => {
  const run = fixture(), view = await render(), pending = deferred(), old = catalog().items[0]!
  if (scenario.startsWith('read')) run.control.read = () => pending.promise
  else run.control.decide = () => pending.promise
  await view.toggle()
  if (scenario.startsWith('decision')) await view.click(view.button('task.optimization.defer'))
  await view.update('task-b')
  run.control.read = undefined; run.control.decide = undefined
  await view.update('task-a'); await view.toggle()
  const reads = run.reads().length
  pending.resolve(scenario.endsWith('failure') ? Response.json({ error: '旧访问失败' }, { status: 500 })
    : Response.json(scenario.startsWith('read') ? { ...catalog(), items: [] } : { ...old, revision: 2, disposition: 'deferred' }))
  await flush()
  expect(run.reads()).toHaveLength(reads)
  expect(view.container.textContent).toContain(old.suggestion.finding)
  expect(view.container.textContent).not.toContain('旧访问失败')
  expect(view.container.textContent).not.toContain(zh['task.optimization.empty'])
  expect(view.container.textContent).not.toContain(zh['task.optimization.deferred'])
})

it.each(['null', 'wrong-task', 'missing-revision', 'old-revision'])('%s 回执不能当作处理成功', async kind => {
  const run = fixture(), view = await render(), item = catalog().items[0]!
  run.control.catalog.items[0]!.revision = 3
  run.control.decide = async () => Response.json(kind === 'null' ? null : { changed: true, ...item,
    revision: kind === 'missing-revision' ? undefined : kind === 'old-revision' ? 2 : 4,
    suggestion: { ...item.suggestion, ticketId: kind === 'wrong-task' ? 'task-b' : 'task-a' } })
  await view.toggle(); await view.click(view.button('task.optimization.defer'))
  expect(view.container.textContent).toContain(zh['task.optimization.unconfirmed'])
  expect(run.reads()).toHaveLength(1)
  expect(view.button('task.optimization.defer').disabled).toBe(true)
})

it('分页沿用快照且不累积旧项，重读回到首页；失败不伪装为空列表', async () => {
  const run = fixture(), view = await render()
  run.control.catalog.nextOffset = 8; run.control.catalog.total = 9
  await view.toggle()
  const snapshot = run.control.catalog.snapshot
  run.control.catalog.items[0]!.suggestion.finding = '下一页的问题'; run.control.catalog.nextOffset = null
  await view.click(view.button('task.optimization.next'))
  expect(run.reads()[1]!.query).toContain('offset=8')
  expect(run.reads()[1]!.query).toContain(`snapshot=${snapshot}`)
  expect(view.container.querySelectorAll('.dt-optimization-item')).toHaveLength(1)
  expect(view.container.textContent).not.toContain(catalog().items[0]!.suggestion.finding)
  expect(document.activeElement).toBe(view.container.querySelector('[role="region"]'))
  await view.click(view.button('task.optimization.previous'))
  expect(run.reads()[2]!.query).toContain('offset=0')
  run.control.read = async () => Response.json({ error: '建议读取失败' }, { status: 503 })
  await view.click(view.button('task.optimization.refresh'))
  expect(run.reads()[3]!.query).toBe(`?profileId=${profileId}`)
  expect(view.container.textContent).toContain('建议读取失败')
  expect(view.container.textContent).not.toContain(zh['task.optimization.empty'])
})
