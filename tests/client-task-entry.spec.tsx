// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/client/app.tsx'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

async function flush() {
  for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function panel(restored = false) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: restored ? { page: 'tasks', id: 'entry-task' } : { page: 'tasks', query: { filter: 'ended' } }, stack: [],
  }))
  const t = ((key, values) => zh[key].replace(/\{(\w+)\}/g, (match, name) =>
    values && name in values ? String(values[name]) : match)) as T
  const state = { masterId: 'entry-controller', paused: false, settings: SettingsSchema.parse({}),
    setup: { machine: { mode: 'hmm', stateDir: '/synthetic/task-entry' }, problem: null },
    load: { running: 0, queued: 0 }, health: {}, revisions: { policy: 0, eval: 0, executor: 0 } }
  const ended = { outcome: 'completed', by: 'agent', at: '2026-11-06T00:00:00Z' }
  const control = { paused: false, released: false, legacy: false, legacyEnded: false }, pending = Promise.withResolvers<Response>()
  const requests: { path: string; method: string }[] = []
  const status = () => control.legacy ? {
    ticketId: 'entry-task', title: 'Review prior comparison', paused: control.paused,
    ended: control.legacyEnded ? ended : null, result: null, resultError: null,
    inputs: { total: 0, pendingDelivery: 0 },
    workflow: { revision: 13, planVersion: 1, phase: 'active', initialMode: 'multi',
      autoRun: !control.legacyEnded, awaitingValidation: false,
      progress: { total: 3, pending: 0, running: 0, completed: 2, suspended: 1, pruned: 0 },
      blockers: { total: 1, omitted: 0, items: [{
        nodeId: 'evaluate', modelFailureCode: 'RATE_LIMIT', reason: '模型请求被限流，请稍后显式恢复',
      }] } },
  } : ({
    ticketId: 'entry-task', title: 'Review prior comparison', paused: control.paused, activity: 'ended', ended, question: null,
    result: { summary: 'Comparison within the authorized scope', evidenceRefs: ['result'], sourceCount: 1 }, resultError: null,
    inputs: { total: 0, pendingDelivery: 0 },
    workflow: { revision: 1, planVersion: 1, phase: 'validated', autoRun: false, awaitingValidation: false,
      progress: { total: 1, pending: 0, running: 0, completed: 1, suspended: 0, pruned: 0 },
      requiresOrchestrator: false, referenceIntegrity: 'valid', planReviewRequired: false,
      blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } },
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    requests.push({ path, method: init?.method ?? 'GET' })
    if (path === 'state') return Response.json(state)
    if (path === 'tasks') return Response.json({ items: [{
      ticketId: 'entry-task', title: 'Review prior comparison', ended, activity: 'ended', needsAnswer: false,
      createdAt: ended.at, updatedAt: ended.at,
    }], nextBefore: null })
    if (path === 'tasks/entry-task') return control.released ? Response.json(status()) : pending.promise
    return Response.json({ error: 'Unexpected request' }, { status: 404 })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<App t={t} openSession={vi.fn()} deploymentForm={undefined} />) })
  await flush()
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === label)!
  return { container, control, requests, button,
    title: () => container.querySelector<HTMLHeadingElement>('.dt-page-title h2')!,
    open: async () => {
      await act(async () => { const target = button('Review prior comparison'); target.focus(); target.click() })
      await flush()
    },
    release: async (missing = false) => {
      control.released = true
      await act(async () => { pending.resolve(missing
        ? Response.json({ error: 'Synthetic missing plan', code: 'workflow_missing' }, { status: 404 })
        : Response.json(status())) })
      await flush()
    },
    refresh: async () => { await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await flush() },
    dispose: () => { pending.resolve(Response.json(status())); act(() => root.unmount()); container.remove() },
  }
}

it.each(['success', 'missing'] as const)('明确从目录进入后衔接标题，延迟读取%s也不丢失阅读位置或增加请求', async outcome => {
  const view = await panel()
  try {
    await view.open()
    const loadingTitle = view.title()
    expect(document.activeElement).toBe(loadingTitle)
    expect(loadingTitle.tabIndex).toBe(-1)
    await view.release(outcome === 'missing')
    expect(view.title()).toBe(loadingTitle)
    expect(document.activeElement).toBe(loadingTitle)
    expect(view.title().textContent).toBe(outcome === 'missing' ? zh['tab.tasks'] : 'Review prior comparison')
    expect(view.requests.filter(item => item.path === 'tasks/entry-task')).toHaveLength(1)
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
    expect(view.requests.some(item => item.path.endsWith('/result-sources'))).toBe(false)
  } finally { view.dispose() }
})

it.each([false, true])('旧任务详情缺少依赖和活动投影时仍能打开，已结束=%s', async ended => {
  const view = await panel()
  try {
    view.control.legacy = true
    view.control.legacyEnded = ended
    await view.open()
    await view.release()
    expect(view.title().textContent).toBe('Review prior comparison')
    expect(view.container.textContent).toContain(zh['taskFailure.RATE_LIMIT'])
    expect(view.container.querySelector('.dt-task-dependencies')).toBeNull()
    expect(view.container.textContent).not.toContain(zh['task.dispatch'])
    expect(view.container.textContent).not.toContain(zh['task.resume'])
    if (!ended) {
      expect(view.container.textContent).toContain(zh['task.openState'])
      expect(view.button(zh['task.openOrchestrator'])).toBeTruthy()
    }
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
    expect(view.requests.filter(item => item.path === 'tasks/entry-task')).toHaveLength(1)
  } finally { view.dispose() }
})

it('创建成功后进入旧版任务详情，不白屏或重新提交创建请求', async () => {
  const view = await panel()
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname === '/orchestrator/api/tasks' && init?.method === 'POST') {
      view.requests.push({ path: 'tasks', method: 'POST' })
      return Response.json({ ticketId: 'entry-task', created: true, ended: null, workflow: {} })
    }
    return original(url, init)
  }))
  try {
    view.control.legacy = true
    view.control.released = true
    const goal = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, '检查创建后详情兼容')
      goal.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { view.button(zh['task.create']).click() })
    await flush()
    expect(view.title().textContent).toBe('Review prior comparison')
    expect(view.container.textContent).toContain(zh['taskFailure.RATE_LIMIT'])
    expect(view.requests.filter(item => item.method === 'POST')).toEqual([{ path: 'tasks', method: 'POST' }])
    expect(view.requests.filter(item => item.path === 'tasks/entry-task')).toHaveLength(1)
  } finally { view.dispose() }
})

it('等待期间移向其他控件后，回执和后续状态变化都不抢回焦点', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const view = await panel()
  try {
    await view.open()
    const master = view.button(zh.openMaster)
    master.focus()
    await view.release()
    expect(document.activeElement).toBe(master)
    view.control.paused = true
    await view.refresh()
    expect(view.container.textContent).toContain(zh['task.globallyPaused'])
    expect(document.activeElement).toBe(master)
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it('恢复存储中的任务路由不视为新的目录打开，不移动已有焦点', async () => {
  const external = document.createElement('input'); document.body.append(external); external.focus()
  const view = await panel(true)
  try {
    expect(document.activeElement).toBe(external)
    await view.release()
    expect(document.activeElement).toBe(external)
  } finally { view.dispose(); external.remove() }
})

it('等待详情时离开页面，旧读取完成不能把焦点带回旧任务', async () => {
  const view = await panel()
  try {
    await view.open()
    const settings = view.button(zh['tab.settings'])
    await act(async () => { settings.focus(); settings.click() })
    await flush()
    const focused = document.activeElement
    await view.release()
    expect(document.activeElement).toBe(focused)
    expect(view.container.textContent).not.toContain('Comparison within the authorized scope')
  } finally { view.dispose() }
})
