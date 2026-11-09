// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DevelopmentExecutionObservations } from '../src/client/development-executions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { developmentWorkspace, developmentExecution } from './fixtures/development-executions.ts'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, args?: Record<string, unknown>) => zh[key].replace(/\{(\w+)\}/g,
  (text, name: string) => args?.[name] !== undefined ? String(args[name]) : text)) as T
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
async function fixture() {
  const requests: { path: string; method: string }[] = []
  const response = developmentExecution()
  const controls = { read: undefined as (() => Promise<Response>) | undefined,
    list: undefined as (() => Promise<Response>) | undefined }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, 'http://localhost'), path = parsed.pathname.replace('/orchestrator/api/', '')
    if (path === 'state') return Response.json({ load: { running: 0, queued: 0 } })
    requests.push({ path, method: init?.method ?? 'GET' })
    if (path === 'development/workspaces')
      return controls.list?.() ?? Response.json({ items: [developmentWorkspace()], nextOffset: null })
    return controls.read?.() ?? Response.json({ execution: response })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<PanelProvider t={t} interval={60000}><DevelopmentExecutionObservations /></PanelProvider>))
  cleanups.push(() => { act(() => root.unmount()); container.remove() })
  const click = async (label: string) => {
    const button = [...container.querySelectorAll<HTMLElement>('button,[role="button"]')].find(item => item.textContent === label)!
    expect(button).toBeTruthy()
    await act(async () => button.click()); await flush()
  }
  return { container, requests, controls, response, click }
}
it('折叠不读取，展开两层才读目标退出；不把启动器零退出当目标通过', async () => {
  const f = await fixture()
  expect(f.requests).toHaveLength(0)
  await f.click(zh['devExecution.title'])
  expect(f.requests).toHaveLength(1)
  await f.click('task-run · 1')
  expect(f.requests).toHaveLength(2)
  expect(f.container.textContent).toContain(t('devExecution.result', { code: 7, signal: '—' }))
  expect(f.container.textContent).toContain(zh['devExecution.retained'])
  expect(f.container.textContent).toContain(zh['devExecution.scope'])
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})
it('旧宿主没有目标结果时明确未知，不复制启动器结果', async () => {
  const f = await fixture()
  const { targetResult: _, ...legacy } = f.response
  f.controls.read = async () => Response.json({ execution: legacy })
  await f.click(zh['devExecution.title']); await f.click('task-run · 1')
  expect(f.container.textContent).toContain(zh['devExecution.unknown'])
  expect(f.container.textContent).not.toContain(zh['devExecution.targetExited'])
})
it.each(['generation', 'workspaceId', 'operationId'] as const)('%s 错配结果不进入当前目录', async key => {
  const f = await fixture()
  f.controls.read = async () => Response.json({ execution: { ...f.response, [key]: key === 'generation' ? 2 : 'other' } })
  await f.click(zh['devExecution.title']); await f.click('task-run · 1')
  expect(f.container.textContent).toContain(zh['devExecution.changed'])
  expect(f.container.textContent).not.toContain(zh['devExecution.targetExited'])
})
it('折叠后迟到结果不污染重新展开，旧宿主错误不自动重试', async () => {
  const f = await fixture()
  let done!: (response: Response) => void
  f.controls.read = () => new Promise(resolve => { done = resolve })
  await f.click(zh['devExecution.title']); await f.click('task-run · 1')
  await f.click(zh['devExecution.title'])
  done(Response.json({ execution: f.response })); await flush()
  f.controls.list = async () => Response.json({ error: '当前宿主不可读' }, { status: 404 })
  await f.click(zh['devExecution.title'])
  expect(f.container.textContent).toContain('当前宿主不可读')
  expect(f.container.textContent).not.toContain(zh['devExecution.targetExited'])
  expect(f.requests).toHaveLength(3)
})
it.each(['scope', 'validation', 'emptyExit'] as const)('%s 违背观测边界时不显示目标结果', async kind => {
  const f = await fixture()
  f.controls.read = async () => Response.json({ execution: { ...f.response,
    ...(kind === 'scope' ? { targetResultScope: 'all_writers' } : kind === 'validation' ? { validationPassed: true }
      : { targetResult: { state: 'exited', exitCode: null, signal: null } }) } })
  await f.click(zh['devExecution.title']); await f.click('task-run · 1')
  expect(f.container.textContent).toContain(zh['devExecution.unconfirmed'])
  expect(f.container.textContent).not.toContain(zh['devExecution.targetExited'])
})
