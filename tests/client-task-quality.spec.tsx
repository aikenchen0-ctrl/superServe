// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelProvider } from '../src/client/provider.tsx'
import { TaskQuality } from '../src/client/task-quality.tsx'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import { qualityCatalog, qualityReceipt } from './fixtures/task-quality.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, args?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (match, name: string) => args && name in args ? String(args[name]) : match)) as T
const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
function fixture() {
  const requests: { method: string; path: string; query: string; body?: Record<string, unknown> }[] = []
  const control = { catalog: qualityCatalog(), read: undefined as undefined | (() => Promise<Response>),
    verify: undefined as undefined | (() => Promise<Response>) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, 'http://localhost'), method = init?.method ?? 'GET'
    const path = parsed.pathname.replace('/orchestrator/api/', '')
    requests.push({ method, path, query: parsed.search, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (path === 'state') return Response.json({ load: { running: 0, queued: 0 } })
    if (path.endsWith('/quality')) return control.read?.() ?? Response.json(control.catalog)
    if (path.endsWith('/quality/verify-sources')) return control.verify?.() ?? Response.json(qualityReceipt(control.catalog))
    if (path.endsWith('/candidates')) return Response.json({
      ticketId: 'task-a', snapshot: 'a'.repeat(64), total: 0, items: [], nextOffset: null,
    })
    return Response.json({ error: '未预期请求' }, { status: 404 })
  }))
  return { control, requests, reads: () => requests.filter(value => value.path.endsWith('/quality')),
    writes: () => requests.filter(value => value.method === 'POST') }
}
async function render() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let disposed = false
  const update = async (id = 'task-a') => {
    await act(async () => { root.render(<PanelProvider t={t} interval={60_000}><TaskQuality key={id} id={id} /></PanelProvider>) })
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

it('折叠零读取，展开不自动核验，单次操作继承版本且没有目标路径或提交表单', async () => {
  const run = fixture(), view = await render()
  expect(run.reads()).toHaveLength(0)
  await view.toggle()
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toEqual([])
  expect(view.container.querySelectorAll('input')).toHaveLength(0)
  await view.click(view.button('task.quality.verify'))
  expect(run.writes()).toEqual([{ method: 'POST', path: 'tasks/task-a/quality/verify-sources', query: '', body: {
    changeRevision: 1, profileId: run.control.catalog.items[0]!.id, profileRevision: 1,
  } }])
  expect(view.container.textContent).toContain(zh['task.quality.matched'])
  expect(view.container.textContent).toContain(zh['task.quality.remaining'])
  await view.toggle(); await view.toggle()
  expect(run.reads()).toHaveLength(2)
  expect(view.container.textContent).not.toContain(zh['task.quality.matched'])
})

it('跨仓只补配方位置，重复点击不并发核验，路径不进入浏览器持久存储', async () => {
  const run = fixture(), view = await render(), pending = deferred()
  run.control.catalog.items[0]!.recipeRepositoryRequired = true
  run.control.verify = () => pending.promise
  const before = [localStorage.length, sessionStorage.length]
  await view.toggle()
  expect(view.button('task.quality.verify').disabled).toBe(true)
  const field = view.container.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'R:/shared/recipe')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const verify = view.button('task.quality.verify')
  await act(async () => { verify.click(); verify.click() })
  expect(run.writes()).toHaveLength(1)
  expect(run.writes()[0]!.body).toHaveProperty('recipeRepositoryPath', 'R:/shared/recipe')
  expect(field.disabled).toBe(true)
  pending.resolve(Response.json(qualityReceipt(run.control.catalog))); await flush()
  expect([localStorage.length, sessionStorage.length]).toEqual(before)
})

it.each(['read-success', 'read-failure', 'verify-success', 'verify-failure'])('离页再返回时 %s 迟到不影响新访问', async scenario => {
  const run = fixture(), view = await render(), pending = deferred()
  if (scenario.startsWith('read')) run.control.read = () => pending.promise
  else run.control.verify = () => pending.promise
  await view.toggle()
  if (scenario.startsWith('verify')) await view.click(view.button('task.quality.verify'))
  await view.update('task-b')
  run.control.read = undefined; run.control.verify = undefined
  await view.update('task-a'); await view.toggle()
  pending.resolve(scenario.endsWith('failure') ? Response.json({ error: '旧访问失败' }, { status: 500 })
    : Response.json(scenario.startsWith('read') ? { state: 'unregistered' } : qualityReceipt()))
  await flush()
  expect(view.container.textContent).toContain('module-quality')
  expect(view.container.textContent).not.toContain('旧访问失败')
  expect(view.container.textContent).not.toContain(zh['task.quality.unregistered'])
  expect(view.container.textContent).not.toContain(zh['task.quality.matched'])
})

it('版本冲突保留原因并要求重读，重读不会自动重放核验', async () => {
  const run = fixture(), view = await render()
  run.control.verify = async () => Response.json({ error: '配置已更新', code: 'quality_profile_changed' }, { status: 409 })
  await view.toggle(); await view.click(view.button('task.quality.verify'))
  expect(view.container.textContent).toContain('配置已更新')
  expect(view.button('task.quality.verify').disabled).toBe(true)
  run.control.catalog.items[0]!.revision = 2
  run.control.verify = undefined
  await view.click(view.button('task.quality.refresh'))
  expect(run.writes()).toHaveLength(1)
  expect(view.container.textContent).toContain('配置版本 2')
  await view.click(view.button('task.quality.verify'))
  expect(run.writes()[1]!.body?.profileRevision).toBe(2)
})

it('过时模块不可核验，缺少引用证据不显示为完整通过', async () => {
  const run = fixture(), view = await render()
  run.control.catalog.items[0]!.applicable = false
  await view.toggle()
  expect(view.button('task.quality.verify').disabled).toBe(true)
  expect(view.container.textContent).toContain(zh['task.quality.stale'])
  run.control.catalog.items[0]!.applicable = true
  const receipt = qualityReceipt()
  receipt.verification.status = 'references_unresolved'
  receipt.verification.recipe.submodules = 2
  run.control.verify = async () => Response.json(receipt)
  await view.click(view.button('task.quality.refresh')); await view.click(view.button('task.quality.verify'))
  expect(view.container.textContent).toContain(zh['task.quality.unresolved'])
  expect(view.container.textContent).toContain('2 个子模块')
  expect(view.container.textContent).toContain(zh['task.quality.remaining'])
})

it('错误任务或配置回执不得显示成功，读取失败不得伪装成尚未登记', async () => {
  const run = fixture(), view = await render()
  run.control.read = async () => Response.json({ error: '读取失败' }, { status: 503 })
  await view.toggle()
  expect(view.container.textContent).toContain('读取失败')
  expect(view.container.textContent).not.toContain(zh['task.quality.unregistered'])
  run.control.read = undefined
  run.control.verify = async () => Response.json({ ...qualityReceipt(), ticketId: 'task-b' })
  await view.click(view.button('task.quality.refresh')); await view.click(view.button('task.quality.verify'))
  expect(view.container.textContent).toContain(zh['task.quality.unconfirmed'])
  expect(view.container.textContent).not.toContain(zh['task.quality.matched'])
})

it('空核验回执只显示未确认，不能当作成功或泄漏底层异常文案', async () => {
  const run = fixture(), view = await render()
  run.control.verify = async () => Response.json(null)
  await view.toggle(); await view.click(view.button('task.quality.verify'))
  expect(view.container.textContent).toContain(zh['task.quality.unconfirmed'])
  expect(view.container.textContent).not.toContain(zh['task.quality.matched'])
})

it('翻页只保留当前页，沿用快照；重读回到首屏且不累积旧回执', async () => {
  const run = fixture(), view = await render()
  run.control.catalog.nextOffset = 8; run.control.catalog.total = 9
  await view.toggle()
  const snapshot = run.control.catalog.snapshot
  run.control.catalog.items[0]!.name = 'last-profile'; run.control.catalog.nextOffset = null
  await view.click(view.button('task.quality.next'))
  expect(run.reads()[1]!.query).toContain('offset=8')
  expect(run.reads()[1]!.query).toContain(`snapshot=${snapshot}`)
  expect(view.container.querySelectorAll('.dt-quality-item')).toHaveLength(1)
  expect(view.container.textContent).not.toContain('module-quality')
  expect(document.activeElement).toBe(view.container.querySelector('[role="region"]'))
  await view.click(view.button('task.quality.previous'))
  expect(run.reads()[2]!.query).toContain('offset=0')
  expect(run.reads()[2]!.query).toContain(`snapshot=${snapshot}`)
  await view.click(view.button('task.quality.refresh'))
  expect(run.reads()[3]!.query).toBe('')
})
