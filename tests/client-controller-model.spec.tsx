// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { ControllerModelStatus } from '../src/client/controller-model-status.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
type Status = ApiResponse<'GET models/controller'>
const t = ((key: keyof typeof zh, values?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)) as T
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals() })
const status = (sessionId = 'master', model = 'used-model'): Status => ({ sessionId,
  observedAt: '2026-11-07T00:00:00.000Z', configured: { revision: 2, model: { provider: 'new', model: 'saved-default' } },
  observation: { state: 'observed', asOfSeq: 10, lastUsed: { provider: 'used', model },
    next: { provider: 'next', model: 'pending-model' } } })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function fixture() {
  const requests: { path: string; method: string }[] = [], openSession = vi.fn(async () => {})
  const control = { read: async (): Promise<Response> => Response.json(status()) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname
    requests.push({ path, method: init?.method ?? 'GET' })
    if (path.endsWith('/models/controller')) return control.read()
    if (path.endsWith('/state')) return Response.json({ masterId: 'master', load: { running: 0 }, setup: { machine: { mode: 'hmm' } } })
    throw new Error(`未预期的请求：${path}`)
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (sessionId = 'master') => {
    await act(async () => root.render(<PanelProvider t={t} interval={60000} openSession={openSession}>
      <ControllerModelStatus key={sessionId} sessionId={sessionId} />
    </PanelProvider>))
    await flush()
  }
  const dispose = () => { act(() => root.unmount()); container.remove() }
  cleanups.push(dispose)
  await render()
  const click = async (label: string) => {
    const element = [...container.querySelectorAll<HTMLElement>('button,[role="button"]')]
      .find(node => node.textContent === label)!
    expect(element).toBeTruthy()
    await act(async () => element.click())
    await flush()
  }
  return { container, control, render, click, requests, openSession,
    reads: () => requests.filter(request => request.path.endsWith('/models/controller')) }
}

it('折叠零读取，展开和刷新各读一次，三种模型分别展示且只显式打开自己的会话', async () => {
  const run = await fixture()
  expect(run.reads()).toHaveLength(0)
  await run.click(zh['controllerModel.title'])
  expect(run.reads()).toHaveLength(1)
  for (const model of ['saved-default', 'used-model', 'pending-model']) expect(run.container.textContent).toContain(model)
  expect(run.container.textContent).not.toContain('master')
  expect(run.openSession).not.toHaveBeenCalled()
  await run.click(zh['controllerModel.openSession'])
  expect(run.openSession).toHaveBeenCalledExactlyOnceWith('master')
  expect(run.reads()).toHaveLength(1)
  await run.click(zh['controllerModel.reload'])
  expect(run.reads()).toHaveLength(2)
  await run.click(zh['controllerModel.title'])
  expect(run.reads()).toHaveLength(2)
  expect(run.requests.every(request => request.method === 'GET')).toBe(true)
})

it('折叠后重开，旧读取迟到不能覆盖新结果', async () => {
  const run = await fixture()
  let finish!: (response: Response) => void
  run.control.read = () => new Promise(resolve => { finish = resolve })
  await run.click(zh['controllerModel.title'])
  await run.click(zh['controllerModel.title'])
  run.control.read = async () => Response.json(status('master', 'latest-model'))
  await run.click(zh['controllerModel.title'])
  await act(async () => finish(Response.json(status('master', 'old-model'))))
  expect(run.container.textContent).toContain('latest-model')
  expect(run.container.textContent).not.toContain('old-model')
})

it('更换总管后忽略旧读取，身份不匹配的响应不显示其他会话模型', async () => {
  const run = await fixture()
  let finish!: (response: Response) => void
  run.control.read = () => new Promise(resolve => { finish = resolve })
  await run.click(zh['controllerModel.title'])
  await run.render('another-master')
  run.control.read = async () => Response.json(status('master', 'PRIVATE_MODEL'))
  await run.click(zh['controllerModel.title'])
  await act(async () => finish(Response.json(status('master', 'OLD_MODEL'))))
  expect(run.container.textContent).toContain(zh['controllerModel.identityChanged'])
  expect(run.container.textContent).not.toContain('PRIVATE_MODEL')
  expect(run.container.textContent).not.toContain('OLD_MODEL')
  await run.click(zh['controllerModel.openSession'])
  expect(run.openSession).toHaveBeenCalledExactlyOnceWith('another-master')
})

it('失败刷新移除旧观察，未知投影不拿保存配置充当已用模型', async () => {
  const run = await fixture()
  await run.click(zh['controllerModel.title'])
  run.control.read = async () => Response.json({ error: '读取暂时失败' }, { status: 503 })
  await run.click(zh['controllerModel.reload'])
  expect(run.container.textContent).toContain('读取暂时失败')
  expect(run.container.textContent).not.toContain('used-model')
  run.control.read = async () => Response.json({ ...status(), observation: { state: 'unknown', reason: 'migration_required' } })
  await run.click(zh['controllerModel.reload'])
  expect(run.container.textContent).toContain(zh['controllerModel.reason.migration_required'])
  expect(run.container.textContent).toContain('saved-default')
  expect(run.container.textContent).not.toContain('pending-model')
  expect(run.container.textContent).not.toContain(zh['controllerModel.lastUsed'])
})
