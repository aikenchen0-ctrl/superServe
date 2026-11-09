// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, caller, usePoll } from '../src/client/api.ts'
import { apply } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'
import { readTaskCreation, saveTaskCreation, taskCreationKey, type TaskCreation } from '../src/client/task-creation.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { ApiResponse } from '../src/app/api.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof zh, values?: Record<string, unknown>) =>
  (zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)) as never
function fixture(listed: string[]) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { effect() },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    // Omit config form service so Deployment renders read-only.
    get: () => undefined,
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, main: entry('main'), nav: entry('sidebar.panellist') }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
async function fillTaskGoal(container: HTMLElement, value: string) {
  const goal = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, value)
    goal.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const serve = (mode: 'repository' | 'hmm' = 'repository', requests: { path: string; method: string; body?: unknown }[] = [],
  pagedTasks = false, awaitingValidation = false) => {
  let taskHeld = false, taskSuspended = !awaitingValidation, taskDependenciesBlocked = !awaitingValidation
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  const address = new URL(url, 'http://127.0.0.1')
  const path = address.pathname.replace('/orchestrator/api/', '')
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
  requests.push({ path: `${path}${address.search}`, method, ...body ? { body } : {} })
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', mode, worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  if (path === 'tasks' && method === 'GET') return Response.json(address.searchParams.has('before')
    ? { items: [{ ticketId: 'local-2', title: '第二页任务', createdAt: '2026-11-03T00:00:00.000Z',
      updatedAt: '2026-11-03T00:00:00.000Z', ended: null }], nextBefore: null }
    : { items: [{ ticketId: 'local-1', title: '测试任务', createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z', ended: null }], nextBefore: pagedTasks ? 'cursor-1' : null })
  if (path === 'tasks' && method === 'POST') return Response.json({ ticketId: 'local-1', created: true, ended: null, workflow: {} })
  if (path === 'tasks/local-1' && method === 'GET') return Response.json({ ticketId: 'local-1', title: '测试任务', paused: false, ended: null,
    activity: awaitingValidation ? 'review' : taskHeld ? 'held' : taskSuspended ? 'attention' : 'waiting',
    workflow: { revision: 3, planVersion: 1, phase: 'active', initialMode: 'multi', autoRun: !taskHeld, awaitingValidation,
      progress: { total: 2, pending: awaitingValidation || taskSuspended ? 0 : 1, running: 0,
        completed: awaitingValidation ? 2 : 0, suspended: taskSuspended ? 1 : 0, pruned: 0 }, referenceIntegrity: 'valid',
      requiresOrchestrator: taskSuspended || taskDependenciesBlocked || awaitingValidation,
      planReviewRequired: false,
      blockers: { total: taskSuspended ? 1 : 0, omitted: 0, requiresOrchestrator: taskSuspended, items: taskSuspended
        ? [{ nodeId: 'internal_analyze_id', title: '核对授权资料', resume: 'available',
          reason: 'private model diagnostic', modelFailureCode: 'RATE_LIMIT' }] : [] },
      dependencyBlockers: { total: taskDependenciesBlocked ? 1 : 0, omitted: 0, items: taskDependenciesBlocked
        ? [{ nodeId: 'internal_review_id', blockedBy: ['internal_source_id'], omittedDependencies: 0 }] : [] } },
    inputs: { total: 1, pendingDelivery: 0 }, result: null, resultError: null })
  if (path === 'tasks/local-1/inputs' && method === 'POST') return Response.json({ ticketId: 'local-1', inputId: 'input-1', created: true })
  if (path === 'tasks/local-1/discuss' && method === 'POST') return Response.json({ sessionId: 'master' })
  if (path === 'tasks/local-1/resume' && method === 'POST') {
    taskSuspended = false; taskDependenciesBlocked = false; taskHeld = false
      return Response.json({ ticketId: 'local-1', workflow: { revision: 5, autoRun: true,
        blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] } } })
  }
  if (path === 'tickets/local-1/hmm/commands' && method === 'POST') {
    const command = body?.command as { action: string } | undefined
    if (command?.action === 'hold') taskHeld = true
    if (command?.action === 'dispatch') taskHeld = false
    if (command?.action === 'resume') { taskSuspended = false; taskDependenciesBlocked = false }
    return Response.json({ ticketId: 'local-1', revision: 4, phase: 'active' })
  }
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

it('registers a localized main panel, sidebar entry and Plugin Manager row page, and no settings section', () => {
  const { entries, dictionaries, main, nav } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'sidebar.panellist', 'plugins.row.config'])
  expect(entries[2]!.options).toMatchObject({ key: 'dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(nav.options).toMatchObject({ id: 'dsh-superagent', order: 10, locale: 'dshSuperagent' })
  expect(nav.options.label?.()).toBe('Superagent')
})

it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main } = fixture(['master'])
  const view = await render(main, { t })
  expect([...view.container.querySelectorAll('[role="tab"]')].some(item => item.textContent === zh['tab.tasks'])).toBe(false)
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('reports a Session missing from the catalog in the interface language', async () => {
  serve()
  const { ctx, main } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose()
})

it('only exposes local HMM tasks in HMM mode and creates, monitors and supplies context to a task', async () => {
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests, true)
  const { main } = fixture([])
  const view = await render(main, { t })
  const tasksTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === zh['tab.tasks'])!
  expect(tasksTab).toBeTruthy()
  expect([...view.container.querySelectorAll('[role="tab"]')].map(item => item.textContent))
    .toEqual([zh['tab.tasks'], zh['tab.settings']])
  expect(tasksTab.getAttribute('aria-selected')).toBe('true')
  expect(view.container.textContent).toContain(zh['task.list'])
  expect(view.container.textContent).toContain('测试任务')
  expect(view.container.textContent).not.toContain(zh['task.title'])
  expect(view.container.textContent).not.toContain(zh['task.modeLabel'])
  const nextPage = [...view.container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === zh['task.nextPage'])!
  await act(async () => { nextPage.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(view.container.textContent).toContain('第二页任务')
  expect(requests.some(item => item.path === 'tasks?state=open&before=cursor-1&limit=50')).toBe(true)

  const goal = view.container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, '检查本地任务目标')
    goal.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const create = [...view.container.querySelectorAll('button')].find(item => item.textContent === zh['task.create'])!
  await act(async () => { create.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(requests.find(item => item.path === 'tasks' && item.method === 'POST')?.body).toMatchObject({
    goal: '检查本地任务目标', mode: 'multi', requestId: expect.any(String),
  })
  expect(view.container.textContent).toContain(zh['task.progress'])
  expect(view.container.textContent).toContain(zh['task.suspended'])
  expect(view.container.textContent).toContain(zh['taskFailure.RATE_LIMIT'])
  expect(view.container.textContent).toContain(zh['task.blockedByCount'].replace('{count}', '1'))
  expect(view.container.textContent).not.toContain('RATE_LIMIT')
  expect(view.container.textContent).not.toContain('internal_analyze_id')
  expect(view.container.textContent).not.toContain('internal_review_id')
  expect(view.container.textContent).not.toContain('internal_source_id')
  expect(view.container.textContent).not.toContain('private model diagnostic')
  expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.openOrchestrator'])).toBe(true)

  const hold = [...view.container.querySelectorAll('button')].find(item => item.textContent === zh['task.hold'])!
  await act(async () => { hold.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(requests.find(item => item.path === 'tickets/local-1/hmm/commands')?.body).toMatchObject({
    revision: 3, command: { action: 'hold' },
  })
  const resume = [...view.container.querySelectorAll('button')].find(item => item.textContent === zh['task.resume'])!
  await act(async () => { resume.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(requests.filter(item => item.path === 'tasks/local-1/resume' && item.method === 'POST')).toHaveLength(1)
  expect(requests.find(item => item.path === 'tasks/local-1/resume')?.body)
    .toEqual({ revision: 3, nodeId: 'internal_analyze_id' })
  expect(requests.filter(item => item.path === 'tickets/local-1/hmm/commands')).toHaveLength(1)
  expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.openOrchestrator'])).toBe(false)
  expect(view.container.querySelector('textarea')).toBeNull()
  const addContext = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
    .find(item => item.textContent?.includes(zh['task.addContext']))!
  await act(async () => { addContext.click() })
  const context = view.container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(context, '补充一项约束')
    context.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const send = [...view.container.querySelectorAll('button')].find(item => item.textContent === zh['task.sendContext'])!
  await act(async () => { send.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(requests.find(item => item.path === 'tasks/local-1/inputs')?.body).toMatchObject({
    requestId: expect.any(String), text: '补充一项约束',
  })
  view.dispose()
})

it('查看已有任务再返回保留未提交目标、标题和模式，只在明确创建时提交且成功后不残留草稿', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const { main } = fixture([]), view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  const goal = '  比较两份授权资料\n保留尚未确定的范围  '
  try {
    await fillTaskGoal(view.container, goal)
    await act(async () => {
      [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
        .find(item => item.textContent?.includes(zh['task.optionalSettings']))!.click()
    })
    const title = view.container.querySelector<HTMLInputElement>('.dt-task-options input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '  新一轮核对  ')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button(zh['task.single']).click() })
    for (const filter of ['open', 'all'] as const) {
      if (filter !== 'open') await act(async () => { button(zh[`task.filter.${filter}`]).click() })
      await flushPanel()
      await act(async () => { button('测试任务').click() })
      await flushPanel()
      expect(view.container.textContent).toContain(zh['task.progress'])
      await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
      await flushPanel()
      expect(view.container.querySelector('textarea')).toMatchObject({ value: goal, disabled: false })
      expect(view.container.querySelector('.dt-task-options input')).toMatchObject({ value: '  新一轮核对  ' })
      expect(view.container.querySelector('.dt-task-options [aria-selected="true"]')?.textContent).toBe(zh['task.single'])
      expect(requests.every(request => request.method === 'GET')).toBe(true)
      expect(readTaskCreation(taskCreationKey('master', '/srv/state'))).toEqual({ status: 'ready' })
      expect(sessionStorage.getItem('dsh-superagent/route')).not.toContain('比较两份授权资料')
    }
    await act(async () => { button(zh['task.create']).click() })
    await flushPanel()
    expect(requests.filter(request => request.method === 'POST')).toEqual([{
      path: 'tasks', method: 'POST', body: {
        requestId: expect.any(String), goal: goal.trim(), title: '新一轮核对', mode: 'single',
      },
    }])
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    expect(view.container.querySelector('textarea')).toMatchObject({ value: '', disabled: false })
    expect(view.container.querySelector('.dt-task-options input')).toMatchObject({ value: '' })
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
  } finally { view.dispose() }
})

it.each(['masterId', 'stateDir'] as const)('查看详情期间切换 %s，不将未提交的新建草稿带入其他宿主', async field => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let other = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/state')) return response
    const state = await response.json()
    return Response.json({ ...state, masterId: other && field === 'masterId' ? 'other-master' : state.masterId,
      setup: { ...state.setup, machine: { ...state.setup.machine,
        stateDir: other && field === 'stateDir' ? '/srv/other' : state.setup.machine.stateDir } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await fillTaskGoal(view.container, '原宿主的私人草稿')
    await act(async () => {
      [...view.container.querySelectorAll('button')].find(item => item.textContent === '测试任务')!.click()
    })
    await flushPanel()
    other = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    expect(view.container.querySelector('textarea')).toMatchObject({ value: '', disabled: false })
    expect(requests.every(request => request.method === 'GET')).toBe(true)
    expect(sessionStorage.getItem('dsh-superagent/route')).not.toContain('私人草稿')
  } finally { view.dispose() }
})

it.each(['success', 'offline', 'rejected'] as const)('创建中查看已有任务后收到%s，不抢导航、不重复创建，并正确区分草稿与未知提交', async result => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  const writes: TaskCreation[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return pending.promise
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    await act(async () => {
      [...view.container.querySelectorAll('button')].find(item => item.textContent === label)!.click()
    })
    await flushPanel()
  }
  try {
    await fillTaskGoal(view.container, '核对当前来源的范围')
    await click(zh['task.create'])
    expect(writes).toHaveLength(1)
    await click('测试任务')
    const route = sessionStorage.getItem('dsh-superagent/route')
    await act(async () => {
      if (result === 'offline') pending.reject(new TypeError('模拟创建回执丢失'))
      else pending.resolve(result === 'success' ? Response.json({ ticketId: 'created-task', created: true })
        : Response.json({ code: 'paused', error: '创建前已暂停' }, { status: 409 }))
    })
    await flushPanel()
    expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    expect(view.container.querySelector('textarea')).toMatchObject({
      value: result === 'success' ? '' : writes[0]!.goal, disabled: result === 'offline',
    })
    expect(readTaskCreation(taskCreationKey('master', '/srv/state'))).toEqual(result === 'offline'
      ? { status: 'ready', submission: writes[0] } : { status: 'ready' })
    expect(writes).toHaveLength(1)
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

it('旧创建请求迟到拒绝不能覆盖后来重新填写的新目标', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const first = Promise.withResolvers<Response>()
  const writes: TaskCreation[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return writes.length === 1 ? first.promise
        : Promise.resolve(Response.json({ code: 'runtime_unavailable', error: '创建前未就绪' }, { status: 409 }))
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    await act(async () => {
      [...view.container.querySelectorAll('button')].find(item => item.textContent === label)!.click()
    })
    await flushPanel()
  }
  try {
    await fillTaskGoal(view.container, '先前目标')
    await click(zh['task.create'])
    await click('测试任务')
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    await click(zh['task.confirmCreation'])
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(view.container.querySelector('textarea')?.disabled).toBe(false)
    await fillTaskGoal(view.container, '用户重新判断后填写的新目标')
    await act(async () => {
      first.resolve(Response.json({ code: 'paused', error: '先前请求也被拒绝' }, { status: 409 }))
    })
    await flushPanel()
    expect(view.container.querySelector('textarea')).toMatchObject({ value: '用户重新判断后填写的新目标', disabled: false })
    expect(readTaskCreation(taskCreationKey('master', '/srv/state'))).toEqual({ status: 'ready' })
    expect(writes).toHaveLength(2)
  } finally { first.resolve(Response.json({})); view.dispose() }
})

it.each([false, true])('创建结果未知时锁定首次提交，重试找回同一任务；已创建时暂停仍可找回（已保存：%s）', async committed => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  type Creation = { requestId: string; title?: string; goal: string; mode: string }
  const writes: Creation[] = []
  let saved: Creation | undefined, paused = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tasks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Creation
      writes.push(body)
      if (writes.length === 1) {
        if (committed) { saved = body; throw new TypeError('模拟创建成功后响应丢失') }
        return Response.json({ error: '创建暂时不可用' }, { status: 503 })
      }
      if (saved && Object.entries(saved).some(([name, value]) => body[name as keyof Creation] !== value))
        return Response.json({ code: 'request_conflict', error: '编号已用于其他任务' }, { status: 409 })
      saved ??= body
      return Response.json({ ticketId: 'local-1', created: !committed })
    }
    const response = await original(url, init)
    if (!path.endsWith('/state')) return response
    return Response.json({ ...await response.json(), paused })
  }))
  const { ctx, main } = fixture(['master'])
  let view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  const fill = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  try {
    const goal = view.container.querySelector('textarea')!
    await fill(goal, '  核对授权范围内的交付时间  ')
    const options = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(row => row.textContent?.includes(zh['task.optionalSettings']))!
    await act(async () => { options.click() })
    const title = view.container.querySelector<HTMLInputElement>('.dt-task-options input')!
    await fill(title, '  交付核对  ')
    const single = [...view.container.querySelectorAll<HTMLButtonElement>('.dt-task-options [role="tab"]')]
      .find(tab => tab.textContent === zh['task.single'])!
    await act(async () => { single.click() })
    await act(async () => { button(zh['task.create']).click() })
    await flushPanel()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ requestId: expect.any(String), goal: '核对授权范围内的交付时间', title: '交付核对', mode: 'single' })
    expect(view.container.textContent).toContain(zh['task.creationUnconfirmed'])
    expect(goal.disabled).toBe(true)
    expect(title.disabled).toBe(true)
    expect([...view.container.querySelectorAll<HTMLButtonElement>('.dt-task-options [role="tab"]')].every(tab => tab.disabled)).toBe(true)
    view.dispose()
    view = await render(main, { t })
    expect(writes).toHaveLength(1)
    expect(view.container.querySelector('textarea')).toMatchObject({ value: writes[0]!.goal, disabled: true })
    expect(view.container.textContent).toContain(zh['task.confirmCreation'])
    const restoredOptions = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(row => row.textContent?.includes(zh['task.optionalSettings']))!
    await act(async () => { restoredOptions.click() })
    expect(view.container.querySelector('.dt-task-options input')).toMatchObject({ value: '交付核对', disabled: true })
    expect(view.container.querySelector('.dt-task-options [aria-selected="true"]')?.textContent).toBe(zh['task.single'])
    // 已创建的工单即使此后全局暂停，仍应能按原请求恢复回执。
    if (committed) {
      paused = true
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await flushPanel()
      expect(view.container.textContent).toContain(zh['task.pausedCreate'])
    }
    expect(button(zh['task.confirmCreation']).disabled).toBe(false)
    await act(async () => { button(zh['task.confirmCreation']).click(); button(zh['task.confirmCreation'])?.click() })
    await flushPanel()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(saved).toEqual(writes[0])
    expect(readTaskCreation(taskCreationKey('master', '/srv/state'))).toEqual({ status: 'ready' })
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route).toEqual({ page: 'tasks', id: 'local-1' })
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each([
  { code: 'paused', status: 409, issues: [] },
  { code: 'runtime_unavailable', status: 409, issues: [] },
  { code: undefined, status: 400, issues: [{ path: 'goal', message: 'Invalid input' }] },
])('创建前明确拒绝后允许修改草稿再提交，不沿用其他目标编号（$code，$status）', async failure => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: { requestId: string; goal: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return writes.length === 1 ? Response.json({ ...failure, error: '创建请求已拒绝' }, { status: failure.status })
        : Response.json({ ticketId: 'local-1', created: true })
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const fill = async (value: string) => {
    const goal = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, value)
      goal.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const create = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.create'])!
  try {
    await fill('原目标')
    await act(async () => { create().click() })
    await flushPanel()
    expect(view.container.querySelector('textarea')?.disabled).toBe(false)
    expect(readTaskCreation(taskCreationKey('master', '/srv/state'))).toEqual({ status: 'ready' })
    expect(view.container.textContent).not.toContain(zh['task.creationUnconfirmed'])
    await fill('修改后的目标')
    await act(async () => { create().click() })
    await flushPanel()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ goal: '修改后的目标' })
    expect(writes[1]!.requestId).not.toBe(writes[0]!.requestId)
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route).toEqual({ page: 'tasks', id: 'local-1' })
  } finally { view.dispose() }
})

it('创建请求冲突保持原提交快照，不通过新编号绕过已存在的工单', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return Promise.resolve(Response.json({ code: 'request_conflict', error: '已有工单与提交不一致' }, { status: 409 }))
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!
    await act(async () => { button.click() })
    await flushPanel()
  }
  try {
    const goal = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, '保持原目标')
      goal.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(zh['task.create'])
    expect(goal.disabled).toBe(true)
    await click(zh['task.confirmCreation'])
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route).toEqual({ page: 'tasks' })
  } finally { view.dispose() }
})

it('在途创建先保存身份，离开并返回只恢复表单；离页后的成功回执清理原记录而不抢导航', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const response = Promise.withResolvers<Response>()
  const writes: TaskCreation[] = []
  const key = taskCreationKey('master', '/srv/state')
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as TaskCreation
      expect(readTaskCreation(key)).toEqual({ status: 'ready', submission: body })
      writes.push(body)
      return response.promise
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
    await act(async () => { button.click() })
    await flushPanel()
  }
  try {
    await fillTaskGoal(view.container, '保留正在提交的目标')
    await click(zh['task.create'])
    expect(writes).toHaveLength(1)
    await click(zh['tab.settings'])
    await click(zh['tab.tasks'])
    expect(writes).toHaveLength(1)
    expect(view.container.querySelector('textarea')).toMatchObject({ value: writes[0]!.goal, disabled: true })
    expect(view.container.textContent).toContain(zh['task.confirmCreation'])
    await click(zh['tab.settings'])
    await act(async () => { response.resolve(Response.json({ ticketId: 'local-1', created: true })) })
    await flushPanel()
    expect(readTaskCreation(key)).toEqual({ status: 'ready' })
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route.page).toBe('settings')
    await click(zh['tab.tasks'])
    expect(view.container.querySelector('textarea')).toMatchObject({ value: '', disabled: false })
    expect(writes).toHaveLength(1)
  } finally { view.dispose() }
})

it('旧页面迟到回执不能删除新页面保留的另一提交，也不能跳转', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const response = Promise.withResolvers<Response>()
  const writes: TaskCreation[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return response.promise
    }
    return original(url, init)
  }))
  const { main } = fixture([])
  let view = await render(main, { t })
  const key = taskCreationKey('master', '/srv/state')
  try {
    await fillTaskGoal(view.container, '原请求')
    await act(async () => {
      [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === zh['task.create'])!.click()
    })
    await flushPanel()
    view.dispose()
    const newer: TaskCreation = { requestId: 'newer-submission', goal: '另一份待确认提交', mode: 'multi' }
    sessionStorage.setItem(key, JSON.stringify({ version: 1, submission: newer }))
    view = await render(main, { t })
    await act(async () => { response.resolve(Response.json({ ticketId: 'local-1', created: true })) })
    await flushPanel()
    expect(readTaskCreation(key)).toEqual({ status: 'ready', submission: newer })
    expect(view.container.querySelector('textarea')).toMatchObject({ value: newer.goal, disabled: true })
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route).toEqual({ page: 'tasks' })
    expect(writes).toHaveLength(1)
  } finally { view.dispose() }
})

it.each(['masterId', 'stateDir'] as const)('同页切换 %s 时隔离待确认提交，回到原控制器才恢复且不发送', async changed => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const key = taskCreationKey('master', '/srv/state')
  const submission: TaskCreation = { requestId: 'pending-host-task', goal: '原控制器的目标', mode: 'single' }
  expect(saveTaskCreation(key, submission)).toBe(true)
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let other = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/state')) return response
    const state = await response.json()
    return Response.json({ ...state, masterId: other && changed === 'masterId' ? 'other' : 'master',
      setup: { ...state.setup, machine: { ...state.setup.machine, stateDir: other && changed === 'stateDir' ? '/srv/other' : '/srv/state' } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelector('textarea')).toMatchObject({ value: submission.goal, disabled: true })
    other = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector('textarea')).toMatchObject({ value: '', disabled: false })
    other = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector('textarea')).toMatchObject({ value: submission.goal, disabled: true })
    expect(readTaskCreation(key)).toEqual({ status: 'ready', submission })
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each(['read', 'write'] as const)('浏览器存储 %s 失败时不发送创建，恢复后由用户重新操作', async failure => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const key = taskCreationKey('master', '/srv/state')
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  let blocked = true
  if (failure === 'read') {
    const original = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name: string) {
      if (blocked && name === key) throw new Error('模拟存储不可用')
      return original.call(this, name)
    })
  } else {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
      if (blocked && name === key) throw new Error('模拟存储不可用')
      original.call(this, name, value)
    })
  }
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
    await act(async () => { button.click() })
    await flushPanel()
  }
  try {
    if (failure === 'write') {
      await fillTaskGoal(view.container, '保存后才发送')
      await click(zh['task.create'])
    }
    expect(view.container.textContent).toContain(zh['task.creationStorageUnavailable'])
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
    expect(view.container.querySelector('textarea')?.disabled).toBe(true)
    blocked = false
    await click(zh['task.reload'])
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
    expect(view.container.querySelector('textarea')?.disabled).toBe(false)
    await fillTaskGoal(view.container, '保存后才发送')
    await click(zh['task.create'])
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(readTaskCreation(key)).toEqual({ status: 'ready' })
  } finally { view.dispose() }
})

it('已创建但清理失败时保留原编号，恢复存储后确认原提交而不另建', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const key = taskCreationKey('master', '/srv/state')
  let blocked = true
  const original = Storage.prototype.removeItem
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, name: string) {
    if (blocked && name === key) throw new Error('模拟清理失败')
    original.call(this, name)
  })
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
    await act(async () => { button.click() })
    await flushPanel()
  }
  try {
    await fillTaskGoal(view.container, '清理失败也不换号')
    await click(zh['task.create'])
    expect(view.container.textContent).toContain(zh['task.creationStorageUnavailable'])
    expect(view.container.querySelector('textarea')?.disabled).toBe(true)
    blocked = false
    await click(zh['task.reload'])
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    await click(zh['task.confirmCreation'])
    const writes = requests.filter(request => request.path === 'tasks' && request.method === 'POST')
    expect(writes).toHaveLength(2)
    expect(writes[1]!.body).toEqual(writes[0]!.body)
    expect(readTaskCreation(key)).toEqual({ status: 'ready' })
  } finally { view.dispose() }
})

it('损坏或带额外执行字段的记录不重放、不覆盖；明确清理只解锁表单', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const key = taskCreationKey('master', '/srv/state')
  const raw = JSON.stringify({ version: 1, submission: { requestId: 'forged', goal: '原目标', mode: 'multi', dispatch: true } })
  sessionStorage.setItem(key, raw)
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
    await act(async () => { button.click() })
    await flushPanel()
  }
  try {
    expect(view.container.textContent).toContain(zh['task.creationStorageInvalid'])
    expect(view.container.querySelector('textarea')?.disabled).toBe(true)
    await click(zh['task.reload'])
    expect(sessionStorage.getItem(key)).toBe(raw)
    await click(zh['task.clearCreationRecord'])
    expect(sessionStorage.getItem(key)).toBe(raw)
    expect(document.body.textContent).toContain(zh['task.clearCreationRecordConfirm'])
    await click(zh.confirm)
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(view.container.querySelector('textarea')).toMatchObject({ value: '', disabled: false })
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it('响应缺少任务回执时保留原编号；临时读失败及浏览器记录消失也不默认为创建失败', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const key = taskCreationKey('master', '/srv/state')
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: TaskCreation[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return Promise.resolve(Response.json(writes.length === 1 ? {} : { ticketId: 'local-1', created: false }))
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
    await act(async () => { button.click() })
    await flushPanel()
  }
  try {
    await fillTaskGoal(view.container, '回执有效才清理')
    await click(zh['task.create'])
    expect(readTaskCreation(key)).toEqual({ status: 'ready', submission: writes[0] })
    const get = Storage.prototype.getItem
    const failed = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name: string) {
      if (name === key) throw new Error('模拟临时读失败')
      return get.call(this, name)
    })
    await click(zh['task.confirmCreation'])
    expect(view.container.textContent).toContain(zh['task.creationStorageUnavailable'])
    expect(writes).toHaveLength(1)
    failed.mockRestore()
    sessionStorage.removeItem(key)
    await click(zh['task.reload'])
    expect(view.container.querySelector('textarea')?.disabled).toBe(true)
    expect(writes).toHaveLength(1)
    await click(zh['task.confirmCreation'])
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(readTaskCreation(key)).toEqual({ status: 'ready' })
  } finally { view.dispose() }
})

it.each([
  { named: false, omitted: 0 }, { named: true, omitted: 0 },
  { named: false, omitted: 2 }, { named: true, omitted: 2 },
  { named: true, omitted: 58 },
])('依赖摘要区分受影响步骤，明确省略范围且不增加查询（有标题：$named，省略：$omitted）', async ({ named, omitted }) => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const extraTitles = omitted ? ['核对统计口径', '检查引用范围'] : []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, workflow: { ...status.workflow, dependencyBlockers: {
      total: 2 + extraTitles.length + omitted, omitted, items: [
        { nodeId: 'internal_review_id', ...(named ? { title: '复核交付时间' } : {}),
          blockedBy: ['internal_source_id', 'internal_source_2', 'internal_source_3', 'internal_source_4'], omittedDependencies: 2 },
        { nodeId: 'internal_check_id', ...(named ? { title: '核对资料范围' } : {}),
          blockedBy: ['internal_source_id'], omittedDependencies: 0 },
        ...extraTitles.map((title, index) => ({ nodeId: `internal_extra_check_${index}`, ...(named ? { title } : {}),
          blockedBy: ['internal_source_id'], omittedDependencies: 0 })),
      ],
    } } })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    const rows = [...view.container.querySelectorAll('.dt-task-dependencies > li')]
    const titles = ['复核交付时间', '核对资料范围', ...extraTitles]
    expect(rows.map(row => row.querySelector('.dt-row-title')?.textContent))
      .toEqual(named ? titles : titles.map(() => zh['task.dependencyStep']))
    expect(rows.map(row => row.querySelector('.dt-row-meta')?.textContent))
      .toEqual([6, 1, ...extraTitles.map(() => 1)].map(count => zh['task.blockedByCount'].replace('{count}', String(count))))
    const section = rows[0]!.closest('.dt-section')!
    expect(section.querySelector('.dt-count')?.textContent).toBe(String(titles.length + omitted))
    expect([...section.querySelectorAll('.dt-hint')].map(hint => hint.textContent)).toEqual([
      ...(omitted ? [zh['task.omittedDependencySteps'].replace('{count}', String(omitted))] : []),
      zh['task.dependencyItem'],
    ])
    expect(view.container.textContent?.split(zh['task.dependencyItem'])).toHaveLength(2)
    expect(view.container.textContent).not.toContain('internal_')
    expect(requests.filter(item => item.path === 'tasks/local-1')).toHaveLength(1)
    expect(requests.every(item => item.method === 'GET')).toBe(true)
    expect(requests.some(item => item.path.includes('/hmm') || item.path.includes('/blockers'))).toBe(false)
    const open = [...view.container.querySelectorAll('button')].find(item => item.textContent === zh['task.openOrchestrator'])!
    await act(async () => { open.click() })
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  } finally { view.dispose() }
})

it.each([false, true])('停止任务先确认，取消不请求、失败可重试，完成后隐藏执行入口（全局暂停：%s）', async paused => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  let ended = false, writes = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tasks/local-1/stop')) {
      requests.push({ path: 'tasks/local-1/stop', method: init?.method ?? 'GET' })
      writes++
      if (writes === 1) return Response.json({ error: '模拟停止失败' }, { status: 500 })
      const response = await pending.promise
      ended = true
      return response
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, paused, activity: ended ? 'ended' : paused ? 'paused' : status.activity,
      ended: ended ? { at: '2026-11-05T00:00:00.000Z', by: 'human', outcome: 'stopped' } : null })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const stop = () => [...view.container.querySelectorAll('button')].find(button => button.textContent === zh['task.stop'])!
  const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(button => button.textContent === zh.confirm)!
  try {
    expect(stop().disabled).toBe(false)
    await act(async () => { stop().click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh['task.stopConfirm'].replace('{title}', '测试任务'))
    expect(writes).toBe(0)
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find(button => button.textContent === zh.cancel)!
    await act(async () => { cancel.click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(writes).toBe(0)

    await act(async () => { stop().click(); })
    await act(async () => { confirm().click() })
    await flushPanel()
    expect(document.body.textContent).toContain(zh['task.controlUnconfirmed'])
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(stop()).toBeTruthy()
    await act(async () => { confirm().click(); confirm().click() })
    expect(writes).toBe(2)
    expect(confirm().disabled).toBe(true)
    await act(async () => { pending.resolve(Response.json({ ticketId: 'local-1' })) })
    await flushPanel()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(stop()).toBeUndefined()
    expect(view.container.textContent).toContain(zh['outcome.stopped'])
    expect([...view.container.querySelectorAll('button')].some(button =>
      [zh['task.resume'], zh['task.dispatch'], zh['task.hold']].includes(button.textContent ?? ''))).toBe(false)
    expect(view.container.textContent).not.toContain(zh['task.addContext'])
    expect(requests.filter(request => request.method === 'POST').map(request => request.path))
      .toEqual(['tasks/local-1/stop', 'tasks/local-1/stop'])
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

it('同次任务页访问复用定位编号，写入及导航失败可重试，成功后反复打开不生成新背景身份', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  const bodies: { requestId: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/discuss')) return original(url, init)
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) return Response.json({ error: '模拟背景写入失败' }, { status: 503 })
    if (bodies.length === 2) return pending.promise
    return Response.json({ sessionId: 'master' })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  ctx.uiWorkspace.openSession.mockImplementationOnce(() => { throw new Error('模拟导航失败') })
  const discuss = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.openOrchestrator'])!
  try {
    expect(bodies).toHaveLength(0)
    await act(async () => { discuss().click() })
    await flushPanel()
    expect(document.body.textContent).toContain('模拟背景写入失败')
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    await act(async () => { discuss().click(); discuss().click() })
    expect(bodies).toHaveLength(2)
    expect(discuss().disabled).toBe(true)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(Response.json({ sessionId: 'master' })) })
    await flushPanel()
    expect(document.body.textContent).toContain('模拟导航失败')
    await act(async () => { discuss().click() })
    await flushPanel()
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledTimes(2)
    expect(bodies[0]).toEqual({ requestId: expect.any(String) })
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
    await act(async () => { discuss().click() })
    await flushPanel()
    expect(bodies[3]).toEqual(bodies[0])
    expect(requests.some(item => item.method === 'POST')).toBe(false)
  } finally { pending.resolve(Response.json({ sessionId: 'master' })); view.dispose() }
})

it('离开再进入同一任务时建立新定位身份，不能把另一个访问的定位永久合并', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const { ctx, main } = fixture(['master'])
  let view = await render(main, { t })
  const open = async () => {
    const discuss = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.openOrchestrator'])!
    await act(async () => { discuss.click() })
    await flushPanel()
  }
  try {
    await open()
    await open()
    view.dispose()
    view = await render(main, { t })
    await open()
    const calls = requests.filter(request => request.path === 'tasks/local-1/discuss')
    expect(calls).toHaveLength(3)
    expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'POST'])
    expect(calls[0]!.body).toEqual({ requestId: expect.any(String) })
    expect(calls[1]!.body).toEqual(calls[0]!.body)
    expect(calls[2]!.body).not.toEqual(calls[0]!.body)
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledTimes(3)
  } finally { view.dispose() }
})

it('离开任务后晚到的讨论背景响应不自动打开旧会话', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
    new URL(url, 'http://127.0.0.1').pathname.endsWith('/discuss') ? pending.promise : original(url, init)))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  const discuss = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.openOrchestrator'])!
  await act(async () => { discuss.click() })
  view.dispose()
  await act(async () => { pending.resolve(Response.json({ sessionId: 'master' })) })
  await flushPanel()
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
})

it('surfaces the orchestrator only when completed nodes need validation', async () => {
  sessionStorage.clear()
  serve('hmm', [], false, true)
  const { main } = fixture([])
  const view = await render(main, { t })
  expect(view.container.textContent).toContain('测试任务')
  const openTask = [...view.container.querySelectorAll('button')].find(item => item.textContent === '测试任务')!
  await act(async () => { openTask.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(view.container.textContent).toContain(zh['task.awaitingValidation'])
  expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.openOrchestrator'])).toBe(true)
  expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.hold'])).toBe(false)
  expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.dispatch'])).toBe(false)
  view.dispose()
})

it('任务页直接回答总管问题，重复点击只提交一次，保存后不派发或导航', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  let answered = false
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/inputs')) {
      writes.push(JSON.parse(String(init?.body)))
      const response = await pending.promise
      answered = true
      return response
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, question: answered ? null : { id: 'question-1', text: '优先比较成本还是延迟？' } })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    expect(view.container.textContent).toContain('优先比较成本还是延迟？')
    expect(view.container.textContent).not.toContain(zh['task.resume'])
    const textarea = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '先比较延迟。')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === zh['task.sendAnswer'])!
    await act(async () => { submit.click(); submit.click() })
    expect(writes).toEqual([{ requestId: expect.any(String), questionId: 'question-1', text: '先比较延迟。' }])
    expect(submit.disabled).toBe(true)
    await act(async () => { pending.resolve(Response.json({ ticketId: 'local-1', inputId: 'saved-answer', created: true })) })
    await flushPanel()
    expect(view.container.textContent).not.toContain(zh['task.question'])
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

function questionPriorityFixture(paused = false) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const control = { question: true, paused, failed: false, ended: false }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'tasks/local-1/inputs' && init?.method === 'POST') {
      requests.push({ path, method: 'POST', body: JSON.parse(String(init.body)) })
      control.question = false
      return Response.json({ ticketId: 'local-1', inputId: 'priority-answer', created: true })
    }
    if (path === 'tasks/local-1/goal' || path === 'tasks/local-1/plan-change') {
      requests.push({ path, method: 'GET' })
      return Response.json(path.endsWith('/goal') ? { ticketId: 'local-1', planVersion: 2,
        text: '需要按需回看的完整目标与限制。'.repeat(20) } : { ticketId: 'local-1', planVersion: 2,
        at: '2026-11-06T00:00:00Z', reason: '此前已发生的计划调整原因。'.repeat(15),
        added: 1, removed: 0, changed: 2, affected: 2,
        affectedSteps: { items: ['先前受影响的步骤 A', '先前受影响的步骤 B'], omitted: 0 } })
    }
    if (path === 'tasks/local-1' && control.failed) {
      requests.push({ path, method: 'GET' })
      return Response.json({ error: '任务状态暂时无法确认' }, { status: 503 })
    }
    const response = await original(url, init)
    if (path !== 'tasks/local-1') return response
    const status = await response.json()
    return Response.json({ ...status, paused: control.paused, goalAvailable: true,
      activity: control.paused ? 'paused' : control.question ? 'attention' : 'held',
      ended: control.ended ? { outcome: 'stopped', at: '2026-11-06T00:00:00Z', by: 'human' } : null,
      question: control.question ? { id: 'priority-question', text: '本轮只采用哪份授权资料？' } : null,
      workflow: { ...status.workflow, planVersion: 2, planChangeAvailable: true, autoRun: false,
        requiresOrchestrator: control.question } })
  }))
  return { control, requests }
}

const priorityQuestion = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('section')]
  .find(section => section.querySelector('h2')?.textContent === zh['task.question'])!

it.each([false, true])('待回答问题优先于目标和历史信息，状态提示与列表一致，暂停仍可回答且不恢复执行；暂停%s', async paused => {
  const run = questionPriorityFixture(paused), { ctx, main } = fixture(['master']), view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  try {
    const tag = view.container.querySelector('.dt-page-title .dt-tag')!
    expect(tag.textContent).toBe(zh['task.question'])
    expect(tag.getAttribute('data-tone')).toBe('warning')
    const content = [...view.container.querySelectorAll('.dt-section, [data-disclosure-row]')]
    expect(content.indexOf(priorityQuestion(view.container))).toBeLessThan(content.indexOf(goalToggle(view.container)))
    expect(content.indexOf(priorityQuestion(view.container))).toBeLessThan(content.indexOf(planChangeToggle(view.container)))
    expect(view.container.textContent.includes(zh['task.globallyPaused'])).toBe(paused)
    expect(run.requests.filter(request => request.path.endsWith('/goal') || request.path.endsWith('/plan-change'))).toHaveLength(0)
    expect(button(zh['task.dispatch'])).toBeUndefined()
    expect(button(zh['task.resume'])).toBeUndefined()
    await fillTaskGoal(view.container, '本轮只采用资料 A')
    await act(async () => { button(zh['task.sendAnswer']).click(); button(zh['task.sendAnswer']).click() })
    await flushPanel()
    expect(run.requests.filter(request => request.method === 'POST')).toEqual([{
      path: 'tasks/local-1/inputs', method: 'POST',
      body: { requestId: expect.any(String), questionId: 'priority-question', text: '本轮只采用资料 A' },
    }])
    expect(priorityQuestion(view.container)).toBeUndefined()
    expect(view.container.querySelector('.dt-page-title .dt-tag')?.textContent).toBe(zh[paused ? 'task.processingPaused' : 'task.held'])
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  } finally { view.dispose() }
})

it('新问题出现后排在只读信息前，不抢输入焦点、不丢补充草稿或重取已展开正文', async () => {
  const run = questionPriorityFixture(), visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  run.control.question = false
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { goalToggle(view.container).click() })
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    const goal = goalToggle(view.container), change = planChangeToggle(view.container)
    const context = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(row => row.textContent?.includes(zh['task.addContext']))!
    await act(async () => { context.click() })
    await fillTaskGoal(view.container, '正在编写但尚未提交的补充')
    const input = view.container.querySelector<HTMLTextAreaElement>('.dt-task-context textarea')!
    input.focus()
    const reads = run.requests.filter(request => request.path.endsWith('/goal') || request.path.endsWith('/plan-change')).length
    run.control.question = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    const content = [...view.container.querySelectorAll('.dt-section, [data-disclosure-row]')]
    expect(content.indexOf(priorityQuestion(view.container))).toBeLessThan(content.indexOf(goalToggle(view.container)))
    expect(goalToggle(view.container)).toBe(goal)
    expect(planChangeToggle(view.container)).toBe(change)
    for (const label of [zh['task.currentGoal'], zh['task.planChange']])
      expect([...view.container.querySelectorAll('[data-disclosure-row]')].filter(row => row.textContent === label)).toHaveLength(1)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('正在编写但尚未提交的补充')
    expect(goalToggle(view.container).getAttribute('aria-expanded')).toBe('true')
    expect(planChangeToggle(view.container).getAttribute('aria-expanded')).toBe('true')
    expect(run.requests.filter(request => request.path.endsWith('/goal') || request.path.endsWith('/plan-change'))).toHaveLength(reads)
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose(); visible.mockRestore() }
})

it('未知状态与终态仍优先于待回答提示，不把旧问题宣称为当前任务状态', async () => {
  const run = questionPriorityFixture(true), visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await fillTaskGoal(view.container, '尚未提交的回答')
    run.control.failed = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector('.dt-page-title .dt-tag')?.textContent).toBe(zh['task.statusUnknown'])
    expect(view.container.querySelector('textarea')?.value).toBe('尚未提交的回答')
    run.control.failed = false
    run.control.ended = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector('.dt-page-title .dt-tag')?.textContent).toBe(zh['outcome.stopped'])
    expect(priorityQuestion(view.container)).toBeUndefined()
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose(); visible.mockRestore() }
})

it.each([false, true])('重进任务可展开已保存问答，显示历史事实且不请求、不恢复（节选：%s）', async truncated => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const receipt = {
    inputId: 'saved-answer', at: '2026-11-05T00:00:00.000Z',
    question: { text: '当时需要确认的范围', truncated },
    answer: { text: '<img src=x onerror=alert(1)>采用资料 B', truncated },
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, lastAnswer: receipt, question: { id: 'new-question', text: '这是另一条当前问题' } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.textContent).toContain('这是另一条当前问题')
    expect(view.container.textContent).toContain(zh['task.lastAnswer'])
    expect(view.container.textContent).not.toContain(receipt.answer.text)
    const initialReads = requests.length
    const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(row => row.textContent?.includes(zh['task.lastAnswer']))!
    await act(async () => { disclosure.click() })
    expect(view.container.textContent).toContain(zh['task.answeredQuestion'])
    expect(view.container.textContent).toContain(receipt.question.text)
    expect(view.container.textContent).toContain(receipt.answer.text)
    expect(view.container.textContent?.includes(zh['task.answerExcerpt'])).toBe(truncated)
    expect(view.container.querySelector('img[src="x"]')).toBeNull()
    expect(view.container.textContent).not.toContain(zh['task.answerSaved'])
    expect(requests).toHaveLength(initialReads)
    expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0)
    await act(async () => { disclosure.click() })
    expect(view.container.textContent).not.toContain(receipt.answer.text)
  } finally { view.dispose() }
})

it.each(['choice', 'other'] as const)('任务问题提供原生单选与自由回答，选择不提交，确认后保存原文（%s）', async mode => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let answered = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/inputs')) answered = true
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, question: answered ? null : {
      id: 'with-choices', text: '本轮优先比较哪项？', choices: ['更低成本', '更低延迟'],
    } })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    const radios = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    const submit = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.sendAnswer'])!
    expect(radios).toHaveLength(3)
    expect(radios.every(radio => !radio.checked)).toBe(true)
    expect(view.container.querySelector('textarea')).toBeNull()
    expect(submit.disabled).toBe(true)
    await act(async () => { radios[mode === 'choice' ? 1 : 2]!.click() })
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
    if (mode === 'other') {
      expect(submit.disabled).toBe(true)
      const textarea = view.container.querySelector('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '先确认数据范围')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(submit.disabled).toBe(false)
    await act(async () => { submit.click(); submit.click() })
    await flushPanel()
    expect(requests.filter(request => request.method === 'POST')).toEqual([{
      path: 'tasks/local-1/inputs', method: 'POST', body: {
        requestId: expect.any(String), questionId: 'with-choices', text: mode === 'choice' ? '更低延迟' : '先确认数据范围',
      },
    }])
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain(zh['task.question'])
  } finally { view.dispose() }
})

it.each([
  { ended: false, truncated: false, pending: 2 }, { ended: false, truncated: true, pending: 0 },
  { ended: true, truncated: false, pending: 0 }, { ended: true, truncated: true, pending: 0 },
])('补充入口内可展开最近保存事实，结束后只读且不冒充采纳；结束$ended，节选$truncated，待送达$pending',
  async ({ ended, truncated, pending }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const receipt = { inputId: 'saved-context', at: '2026-11-05T00:00:00.000Z',
      text: '<img src=x onerror=alert(1)>先核对资料 B', truncated }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const response = await original(url, init)
      if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
      const status = await response.json()
      return Response.json({ ...status, lastContext: receipt, inputs: { total: 2, pendingDelivery: pending },
        ...(ended ? { ended: { outcome: 'stopped' }, activity: 'ended' } : {}) })
    }))
    const { ctx, main } = fixture(['master']), view = await render(main, { t })
    try {
      const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
        .find(row => row.textContent?.includes(zh['task.lastContext']))!
      expect(disclosure).toBeTruthy()
      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      expect(disclosure.querySelector('time')).toHaveProperty('dateTime', receipt.at)
      expect(view.container.textContent).not.toContain(receipt.text)
      expect(view.container.querySelector('textarea')).toBeNull()
      const reads = requests.length
      await act(async () => { disclosure.click() })
      expect(view.container.textContent).toContain(receipt.text)
      expect(view.container.textContent?.includes(zh['task.contextExcerpt'])).toBe(truncated)
      expect(view.container.querySelector('img[src="x"]')).toBeNull()
      expect(view.container.textContent).not.toContain(zh['task.answerSaved'])
      expect(view.container.textContent).not.toMatch(/已采纳|已执行/)
      if (ended) {
        expect(view.container.querySelector('textarea')).toBeNull()
        expect(view.container.textContent).not.toContain(zh['task.sendContext'])
      } else expect(view.container.querySelector('textarea')?.value).toBe('')
      expect(requests).toHaveLength(reads)
      expect(requests.every(request => request.method === 'GET')).toBe(true)
      expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    } finally { view.dispose() }
  })

it('保存回执轮询更新不覆盖正在填写的新补充，问题回答与补充仍保持独立', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let version = 1
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, lastContext: { inputId: `context-${version}`, at: '2026-11-06T00:00:00.000Z',
      text: version === 1 ? '先前补充' : '另一窗口保存的新补充', truncated: false },
      question: { id: 'current-question', text: '当前待回答问题' },
      lastAnswer: { inputId: 'previous-answer', at: '2026-11-05T00:00:00.000Z',
        question: { text: '上次问题', truncated: false }, answer: { text: '上次答案', truncated: false } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelector('textarea')?.value).toBe('')
    const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(row => row.textContent?.includes(zh['task.addContext']))!
    await act(async () => { disclosure.click() })
    const textarea = view.container.querySelector<HTMLTextAreaElement>('.dt-task-context textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '正在填写的草稿')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    version++
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector<HTMLTextAreaElement>('.dt-task-context textarea')?.value).toBe('正在填写的草稿')
    expect(view.container.textContent).toContain('另一窗口保存的新补充')
    expect(view.container.textContent).not.toContain('先前补充')
    expect(view.container.textContent).toContain('当前待回答问题')
    expect(view.container.textContent).toContain(zh['task.lastAnswer'])
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it('补充已保存但刷新失败仍显示保存事实，重新进入可回读；没有重复写入或自动继续', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: { requestId: string; text: string }[] = []
  let failReload = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/inputs') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return Response.json({ ticketId: 'local-1', inputId: 'saved-context', created: true })
    }
    if (path.endsWith('/tasks/local-1') && writes.length && failReload) {
      failReload = false
      return Response.json({ error: '状态暂时无法读取' }, { status: 503 })
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, inputs: { total: 2, pendingDelivery: 0 }, ...(writes.length
      ? { lastContext: { inputId: 'saved-context', at: '2026-11-06T00:00:00.000Z',
        text: writes[0]!.text, truncated: false } } : {}) })
  }))
  const { ctx, main } = fixture(['master'])
  let view = await render(main, { t })
  const toggle = () => [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
    .find(row => row.textContent?.includes(zh['task.addContext']))!
  try {
    await act(async () => { toggle().click() })
    await fillTaskGoal(view.container, '已保存不代表已采纳')
    const submit = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.sendContext'])!
    await act(async () => { submit.click(); submit.click() })
    await flushPanel()
    expect(writes).toHaveLength(1)
    expect(view.container.querySelector('textarea')?.value).toBe('')
    expect(document.body.textContent).toContain(zh['task.contextSaved'])
    expect(view.container.textContent).toContain('状态暂时无法读取')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.textContent).toContain(zh['task.lastContext'])
    expect(view.container.textContent).toContain(writes[0]!.text)
    expect(writes).toHaveLength(1)
    view.dispose()
    view = await render(main, { t })
    expect(toggle().textContent).toContain(zh['task.lastContext'])
    expect(view.container.textContent).not.toContain(writes[0]!.text)
    await act(async () => { toggle().click() })
    expect(view.container.textContent).toContain(writes[0]!.text)
    expect(writes).toHaveLength(1)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  } finally { view.dispose() }
})

it.each(['settings', 'return', 'other'].flatMap(destination =>
  ['saved', 'invalid', 'conflict', 'offline'].map(result => ({ destination, result }))))(
  '补充请求离页后仅收尾，不通知或重读旧任务；去向$destination，迟到结果$result',
  async ({ destination, result }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
      route: { page: 'tasks', id: 'local-1' }, stack: [],
    }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const response = Promise.withResolvers<Response>()
    const writes: { requestId: string; text: string }[] = []
    let savedText: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const address = new URL(url, 'http://127.0.0.1'), path = address.pathname
      if (path.endsWith('/tasks/local-1/inputs') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        const reply = await response.promise
        if (result === 'saved') savedText = writes[0]!.text
        return reply
      }
      if (path.endsWith('/tasks/local-2')) {
        requests.push({ path: 'tasks/local-2', method: 'GET' })
        const status = await (await original('/orchestrator/api/tasks/local-1', init)).json()
        return Response.json({ ...status, ticketId: 'local-2', title: '另一个任务' })
      }
      const reply = await original(url, init)
      if (path.endsWith('/tasks') && (init?.method ?? 'GET') === 'GET') {
        const page = await reply.json()
        return Response.json({ ...page, items: [...page.items, {
          ticketId: 'local-2', title: '另一个任务', ended: null,
          createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
        }] })
      }
      if (path.endsWith('/tasks/local-1') && savedText) {
        const status = await reply.json()
        return Response.json({ ...status, lastContext: { inputId: 'saved-context', at: '2026-11-06T00:00:00.000Z',
          text: savedText, truncated: false } })
      }
      return reply
    }))
    const { ctx, main } = fixture(['master']), view = await render(main, { t })
    const click = async (label: string) => {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.textContent === label)!
      await act(async () => { button.click() })
      await flushPanel()
    }
    const expandContext = async () => {
      const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
        .find(item => item.textContent?.includes(zh['task.addContext']))!
      await act(async () => { disclosure.click() })
    }
    try {
      await expandContext()
      await fillTaskGoal(view.container, '原页面提交的补充')
      await click(zh['task.sendContext'])
      expect(writes).toHaveLength(1)
      if (destination === 'settings') await click(zh['tab.settings'])
      else {
        await click(zh['tab.tasks'])
        await click(destination === 'return' ? '测试任务' : '另一个任务')
        await expandContext()
        await fillTaskGoal(view.container, '新页面尚未提交的草稿')
      }
      const reads = requests.length
      const route = sessionStorage.getItem('dsh-superagent/route')
      await act(async () => {
        if (result === 'offline') response.reject(new TypeError('旧补充请求断网'))
        else response.resolve(result === 'conflict'
          ? Response.json({ code: 'request_conflict', error: '旧补充请求冲突' }, { status: 409 })
          : Response.json(result === 'invalid' ? {} : { ticketId: 'local-1', inputId: 'saved-context', created: true }))
      })
      await flushPanel()
      expect(document.querySelector('.dt-toast')).toBeNull()
      expect(requests).toHaveLength(reads)
      expect(writes).toHaveLength(1)
      expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
      expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
      if (destination !== 'settings')
        expect(view.container.querySelector('textarea')?.value).toBe('新页面尚未提交的草稿')
      if (destination === 'return' && result === 'saved') {
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        await flushPanel()
        expect(view.container.textContent).toContain(zh['task.lastContext'])
        expect(view.container.textContent).toContain('原页面提交的补充')
        expect(view.container.querySelector('textarea')?.value).toBe('新页面尚未提交的草稿')
        expect(writes).toHaveLength(1)
      }
    } finally { response.resolve(Response.json({})); view.dispose() }
  })

it.each([null, {}, { ticketId: 'local-1' }, { ticketId: 'other-task', inputId: 'input-1' },
  { ticketId: 'local-1', inputId: ' ' }])('缺少有效补充回执时保留草稿与重试编号，不显示已保存：%j', async receipt => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (new URL(url, 'http://127.0.0.1').pathname.endsWith('/inputs') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return Promise.resolve(Response.json(writes.length === 1 ? receipt
        : { ticketId: 'local-1', inputId: 'input-1', created: false }))
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const submit = async () => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.sendContext'])!
    await act(async () => { button.click() })
    await flushPanel()
  }
  try {
    await act(async () => {
      [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
        .find(row => row.textContent?.includes(zh['task.addContext']))!.click()
    })
    await fillTaskGoal(view.container, '回执未知仍保留原文')
    await submit()
    expect(document.body.textContent).toContain(zh['task.contextUnconfirmed'])
    expect(document.body.textContent).not.toContain(zh['task.contextSaved'])
    expect(view.container.querySelector('textarea')?.value).toBe('回执未知仍保留原文')
    await submit()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(view.container.querySelector('textarea')?.value).toBe('')
    expect(document.body.textContent).toContain(zh['task.contextSaved'])
  } finally { view.dispose() }
})

it.each(['unavailable', 'replaced'] as const)('回答遇到 %s 时不自动重放，保留原草稿或要求重新核对问题', async failure => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: { requestId: string; questionId: string; text: string }[] = []
  let current = 'first', answered = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/inputs')) {
      writes.push(JSON.parse(String(init?.body)))
      if (writes.length === 1) {
        if (failure === 'replaced') current = 'second'
        return Response.json({ error: failure === 'replaced' ? '问题已更新' : '保存失败' }, { status: failure === 'replaced' ? 409 : 503 })
      }
      answered = true
      return Response.json({ ticketId: 'local-1', inputId: 'saved-answer', created: true })
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, question: answered ? null : {
      id: current, text: current === 'first' ? '优先成本还是延迟？' : '资料范围是 A 还是 B？',
    } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const fill = async (text: string) => {
    const textarea = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const submit = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.sendAnswer'])!
  try {
    await fill('先比较延迟')
    await act(async () => { submit().click() })
    await flushPanel()
    expect(writes).toHaveLength(1)
    if (failure === 'unavailable') {
      expect(view.container.querySelector('textarea')?.value).toBe('先比较延迟')
      expect(document.body.textContent).toContain('保存失败')
    } else {
      expect(view.container.textContent).toContain('资料范围是 A 还是 B？')
      expect(view.container.querySelector('textarea')?.value).toBe('')
      expect(document.body.textContent).toContain('问题已更新')
      await fill('资料 A')
    }
    await act(async () => { submit().click() })
    await flushPanel()
    expect(writes).toHaveLength(2)
    if (failure === 'unavailable') expect(writes[1]).toEqual(writes[0])
    else {
      expect(writes[1]).toMatchObject({ questionId: 'second', text: '资料 A' })
      expect(writes[1]!.requestId).not.toBe(writes[0]!.requestId)
    }
    expect(view.container.textContent).not.toContain(zh['task.question'])
  } finally { view.dispose() }
})

it.each(['text', 'choice'] as const)('%s 回答只有取得匹配任务的有效回执才显示已保存，无效响应原样重试且不丢答案', async mode => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: { requestId: string; questionId: string; text: string }[] = []
  const invalid = [null, {}, { ticketId: 'local-1' }, { ticketId: 'other-task', inputId: 'input-1' },
    { ticketId: 'local-1', inputId: '' }, { ticketId: 'local-1', inputId: ' ' }]
  let accepted = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/inputs') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      if (writes.length <= invalid.length) return Response.json(invalid[writes.length - 1])
      accepted = true
      return Response.json({ ticketId: 'local-1', inputId: 'saved-answer', created: false })
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, question: accepted ? null : {
      id: 'receipt-question', text: '优先核对哪项？', ...(mode === 'choice' ? { choices: ['成本', '延迟'] } : {}),
    } })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  const submit = async () => {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent === zh['task.sendAnswer'])!
    expect(button.disabled).toBe(false)
    await act(async () => { button.click(); button.click() })
    await flushPanel()
  }
  try {
    if (mode === 'text') await fillTaskGoal(view.container, '先核对延迟')
    else await act(async () => { view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click() })
    for (let index = 0; index < invalid.length; index++) {
      await submit()
      expect(writes).toHaveLength(index + 1)
      expect(writes[index]).toEqual(writes[0])
      expect(view.container.textContent).toContain('优先核对哪项？')
      expect(document.body.textContent).toContain(zh['task.answerUnconfirmed'])
      expect(document.body.textContent).not.toContain(zh['task.answerSaved'])
      if (mode === 'text') expect(view.container.querySelector('textarea')?.value).toBe('先核对延迟')
      else expect(view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.checked).toBe(true)
    }
    await submit()
    expect(writes).toHaveLength(invalid.length + 1)
    expect(writes.at(-1)).toEqual(writes[0])
    expect(view.container.textContent).not.toContain(zh['task.question'])
    expect(document.body.textContent).toContain(zh['task.answerSaved'])
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  } finally { view.dispose() }
})

async function answerDraftFixture() {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const control: { question: { id: string; text: string; choices?: string[] } | null } = {
    question: { id: 'draft-first', text: '旧问题：先核对哪些来源？' },
  }
  const writes: { questionId: string; text: string; requestId: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/inputs') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      control.question = null
      return Response.json({ ticketId: 'local-1', inputId: 'saved-answer', created: true })
    }
    const response = await original(url, init)
    return path.endsWith('/tasks/local-1') ? Response.json({ ...await response.json(), question: control.question }) : response
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const click = async (label: string) => {
    const element = [...view.container.querySelectorAll<HTMLElement>('button,[data-disclosure-row]')]
      .find(item => item.textContent === label)!
    expect(element).toBeTruthy()
    await act(async () => { element.click() })
    await flushPanel()
  }
  const refresh = async () => {
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
  }
  return { view, main, control, writes, requests, click, refresh }
}

it('问题变更保留先前填写内容，显式填入后只绑定当前问题，保存后不再恢复旧内容', async () => {
  const run = await answerDraftFixture()
  try {
    const original = ' 保留两份资料\n并核对边界 🧭 '
    await fillTaskGoal(run.view.container, original)
    await run.refresh()
    expect(run.view.container.querySelector('textarea')!.value).toBe(original)
    expect(run.view.container.textContent).not.toContain(zh['task.previousAnswer'])
    run.control.question = { id: 'draft-second', text: '新问题：这轮需要怎样处理？', choices: ['保留', '排除'] }
    await run.refresh()
    expect(run.view.container.querySelector('textarea')).toBeNull()
    expect(run.view.container.querySelectorAll('input[type="radio"]:checked')).toHaveLength(0)
    expect(run.view.container.textContent).not.toContain(original)
    expect(run.writes).toHaveLength(0)
    await run.click(zh['task.previousAnswer'])
    expect(run.view.container.textContent).toContain('旧问题：先核对哪些来源？')
    expect([...priorityQuestion(run.view.container).querySelectorAll('p')].map(item => item.textContent)).toContain(original)
    await run.click(zh['task.usePreviousAnswer'])
    const field = run.view.container.querySelector('textarea')!
    expect(field.value).toBe(original)
    expect(document.activeElement).toBe(field)
    expect(run.view.container.querySelector('input[type="radio"]:checked')?.closest('label')?.textContent).toBe(zh['task.answerOther'])
    expect(run.writes).toHaveLength(0)
    await run.click(zh['task.sendAnswer'])
    expect(run.writes).toEqual([{ questionId: 'draft-second', text: original.trim(), requestId: expect.any(String) }])
    run.control.question = { id: 'draft-third', text: '接下来核对什么？' }
    await run.refresh()
    expect(run.view.container.querySelector('textarea')!.value).toBe('')
    expect(run.view.container.textContent).not.toContain(zh['task.previousAnswer'])
  } finally { run.view.dispose() }
})

it('旧内容不能覆盖新回答，保留最近填写的一份且丢弃或离页后不复活', async () => {
  const run = await answerDraftFixture()
  let next: Awaited<ReturnType<typeof render>> | undefined
  try {
    await fillTaskGoal(run.view.container, '最早填写的私密内容')
    run.control.question = { id: 'draft-second', text: '第二个问题' }
    await run.refresh()
    await fillTaskGoal(run.view.container, '新的独立回答')
    await run.click(zh['task.previousAnswer'])
    const reuse = [...run.view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.usePreviousAnswer'])!
    expect(reuse.disabled).toBe(true)
    await act(async () => { reuse.click() })
    expect(run.view.container.querySelector('textarea')!.value).toBe('新的独立回答')
    run.control.question = { id: 'draft-third', text: '第三个问题' }
    await run.refresh()
    await run.click(zh['task.previousAnswer'])
    expect(run.view.container.textContent).toContain('新的独立回答')
    expect(run.view.container.textContent).not.toContain('最早填写的私密内容')
    await run.click(zh['task.discardPreviousAnswer'])
    expect(document.activeElement).toBe(run.view.container.querySelector('textarea'))
    run.control.question = { id: 'draft-fourth', text: '第四个问题' }
    await run.refresh()
    expect(run.view.container.textContent).not.toContain(zh['task.previousAnswer'])
    await fillTaskGoal(run.view.container, '只留在这次页面里的内容')
    run.view.dispose()
    next = await render(run.main, { t })
    expect(next.container.querySelector('textarea')!.value).toBe('')
    expect(next.container.textContent).not.toContain(zh['task.previousAnswer'])
    expect(run.writes).toHaveLength(0)
    expect(sessionStorage.getItem('dsh-superagent/route')).not.toContain('只留在')
  } finally { if (next) next.dispose(); else run.view.dispose() }
})

it.each(['text', 'choice'] as const)('清空当前回答不会隐式丢弃仍展示的先前内容，下一次换题仍可显式恢复：%s', async kind => {
  const run = await answerDraftFixture()
  try {
    await fillTaskGoal(run.view.container, '应保留的先前填写内容')
    run.control.question = { id: 'second-emptyable', text: '第二个问题',
      ...(kind === 'choice' ? { choices: ['先比较限制', '先收集条件'] } : {}) }
    await run.refresh()
    if (kind === 'text') {
      await fillTaskGoal(run.view.container, '本轮试写后决定清空的内容')
      await fillTaskGoal(run.view.container, '')
    } else {
      const radios = run.view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
      await act(async () => { radios[0]!.click() })
      await act(async () => { radios[2]!.click() })
      expect(run.view.container.querySelector('textarea')!.value).toBe('')
    }
    await run.click(zh['task.previousAnswer'])
    expect(run.view.container.textContent).toContain('应保留的先前填写内容')
    run.control.question = { id: 'third-after-clear', text: '第三个问题' }
    await run.refresh()
    expect(run.view.container.textContent).toContain(zh['task.previousAnswer'])
    await run.click(zh['task.previousAnswer'])
    expect(run.view.container.textContent).toContain('应保留的先前填写内容')
    expect(run.view.container.textContent).not.toContain('本轮试写后决定清空的内容')
    await run.click(zh['task.usePreviousAnswer'])
    expect(run.view.container.querySelector('textarea')!.value).toBe('应保留的先前填写内容')
    expect(run.writes).toHaveLength(0)
  } finally { run.view.dispose() }
})

it.each(['replaced', 'left'].flatMap(change =>
  ['saved', 'invalid', 'conflict', 'offline'].map(result => ({ change, result }))))(
  '旧问题迟到时不影响当前页面；页面$change，响应$result', async ({ change, result }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const response = Promise.withResolvers<Response>()
    const writes: unknown[] = []
    let current = 'first'
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname
      if (path.endsWith('/inputs') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        return response.promise
      }
      const reply = await original(url, init)
      if (!path.endsWith('/tasks/local-1')) return reply
      const status = await reply.json()
      return Response.json({ ...status, question: { id: current,
        text: current === 'first' ? '先前待回答的问题' : '现在待回答的新问题' } })
    }))
    const { main } = fixture([]), view = await render(main, { t })
    try {
      await fillTaskGoal(view.container, '原问题的答案')
      await act(async () => {
        [...view.container.querySelectorAll<HTMLButtonElement>('button')]
          .find(item => item.textContent === zh['task.sendAnswer'])!.click()
      })
      await flushPanel()
      expect(writes).toHaveLength(1)
      if (change === 'replaced') {
        current = 'second'
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        await flushPanel()
        expect(view.container.textContent).toContain('现在待回答的新问题')
        await fillTaskGoal(view.container, '正在填写新问题的答案')
      } else {
        await act(async () => {
          [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            .find(item => item.textContent === zh['tab.settings'])!.click()
        })
        await flushPanel()
      }
      const reads = requests.length
      await act(async () => {
        if (result === 'offline') response.reject(new TypeError('模拟旧请求网络失败'))
        else response.resolve(result === 'conflict'
          ? Response.json({ code: 'question_conflict', error: '旧问题已更新' }, { status: 409 })
          : Response.json(result === 'invalid' ? {} : { ticketId: 'local-1', inputId: 'saved-answer', created: true }))
      })
      await flushPanel()
      expect(document.body.textContent).not.toContain(zh['task.answerSaved'])
      expect(document.body.textContent).not.toContain(zh['task.answerUnconfirmed'])
      expect(document.body.textContent).not.toContain('旧问题已更新')
      expect(document.querySelector('.dt-toast')).toBeNull()
      expect(requests).toHaveLength(reads)
      expect(writes).toHaveLength(1)
      if (change === 'replaced') {
        expect(view.container.textContent).toContain('现在待回答的新问题')
        expect(view.container.querySelector('textarea')?.value).toBe('正在填写新问题的答案')
      } else expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route.page).toBe('settings')
    } finally { response.resolve(Response.json({})); view.dispose() }
  })

it.each(['stay', 'settings', 'return'].flatMap(destination =>
  [false, true].map(readFailed => ({ destination, readFailed }))))(
  '回答冲突后重读期间按任务页隔离反馈，保留当前答案和原样重试；去向$destination，重读失败$readFailed',
  async ({ destination, readFailed }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const pending = Promise.withResolvers<Response>()
    const writes: { requestId: string; questionId: string; text: string }[] = []
    let holdNext = false, accepted = false
    let oldStatus: ApiResponse<'GET tasks/:id'> | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname
      if (path.endsWith('/tasks/local-1/inputs') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        if (writes.length === 1) {
          holdNext = true
          return Response.json({ code: 'question_conflict', error: '回答存在冲突，本次答案未保存' }, { status: 409 })
        }
        accepted = true
        return Response.json({ ticketId: 'local-1', inputId: 'retried-answer', created: true })
      }
      const response = await original(url, init)
      if (!path.endsWith('/tasks/local-1')) return response
      const status = { ...await response.json(), question: accepted ? null
        : { id: 'conflict-question', text: '本轮先核对哪个来源？' } }
      if (holdNext) {
        holdNext = false
        oldStatus = status
        return pending.promise
      }
      return Response.json(status)
    }))
    const { ctx, main } = fixture(['master']), view = await render(main, { t })
    const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent === label)!
    try {
      await fillTaskGoal(view.container, '原问题尚未确认的答案')
      await act(async () => { button(zh['task.sendAnswer']).click(); button(zh['task.sendAnswer']).click() })
      await flushPanel()
      expect(oldStatus).toBeDefined()
      expect(writes).toEqual([{ requestId: expect.any(String), questionId: 'conflict-question', text: '原问题尚未确认的答案' }])
      expect(button(zh['task.sendAnswer']).disabled).toBe(true)
      expect(document.querySelector('.dt-toast')).toBeNull()
      if (destination !== 'stay') {
        await act(async () => { button(zh['tab.settings']).click() })
        await flushPanel()
        if (destination === 'return') {
          await act(async () => { button(zh['tab.tasks']).click() })
          await flushPanel()
          await act(async () => { button('测试任务').click() })
          await flushPanel()
          await fillTaskGoal(view.container, '重新进入后正在填写的新答案')
        }
      }
      const reads = requests.filter(request => request.path === 'tasks/local-1').length
      const route = sessionStorage.getItem('dsh-superagent/route')
      await act(async () => { pending.resolve(readFailed
        ? Response.json({ error: '旧回答后的状态读取失败' }, { status: 503 })
        : Response.json(oldStatus)) })
      await flushPanel()
      expect(writes).toHaveLength(1)
      expect(requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
      expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
      expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toContain(zh['task.answerSaved'])
      if (destination === 'stay') {
        expect(document.body.textContent).toContain('回答存在冲突，本次答案未保存')
        expect(view.container.querySelector('textarea')?.value).toBe('原问题尚未确认的答案')
        expect(button(zh['task.sendAnswer']).disabled).toBe(false)
        expect(view.container.textContent.includes('旧回答后的状态读取失败')).toBe(readFailed)
        await act(async () => { button(zh['task.sendAnswer']).click() })
        await flushPanel()
        expect(writes).toHaveLength(2)
        expect(writes[1]).toEqual(writes[0])
        expect(view.container.textContent).not.toContain('本轮先核对哪个来源？')
        expect(document.body.textContent).toContain(zh['task.answerSaved'])
      } else {
        expect(document.querySelector('.dt-toast')).toBeNull()
        expect(document.body.textContent).not.toContain('回答存在冲突，本次答案未保存')
        expect(view.container.textContent).not.toContain('旧回答后的状态读取失败')
        if (destination === 'return') {
          expect(view.container.querySelector('textarea')?.value).toBe('重新进入后正在填写的新答案')
          expect(button(zh['task.sendAnswer']).disabled).toBe(false)
        }
      }
    } finally { pending.resolve(Response.json({})); view.dispose() }
  })

it.each(['retry', 'text', 'choice', 'other'].flatMap(mode =>
  [false, true].map(committed => ({ mode, committed }))))(
  '回答失败后区分原样重试和改答，不覆盖已保存答案（方式：$mode，原答案已保存：$committed）',
  async ({ mode, committed }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    serve('hmm')
    const original = vi.mocked(fetch).getMockImplementation()!
    type Answer = { requestId: string; questionId: string; text: string }
    const writes: Answer[] = []
    const choices = mode === 'choice' || mode === 'other' ? ['更低成本', '更低延迟'] : undefined
    let accepted: Answer | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname
      if (path.endsWith('/inputs')) {
        const body = JSON.parse(String(init?.body)) as Answer
        writes.push(body)
        if (writes.length === 1) {
          if (committed) { accepted = body; throw new TypeError('模拟保存后响应丢失') }
          return Response.json({ error: '暂时无法保存' }, { status: 503 })
        }
        if (accepted && accepted.requestId !== body.requestId)
          return Response.json({ code: 'question_conflict', error: '此问题已保存过回答，本次修改未保存' }, { status: 409 })
        accepted ??= body
        return Response.json({ ticketId: 'local-1', inputId: 'saved-answer', created: !committed })
      }
      const response = await original(url, init)
      if (!path.endsWith('/tasks/local-1')) return response
      const status = await response.json()
      return Response.json({ ...status, question: accepted ? null : {
        id: 'retry-question', text: '本轮优先核对哪项？', ...(choices ? { choices } : {}),
      } })
    }))
    const { ctx, main } = fixture(['master']), view = await render(main, { t })
    const fill = async (text: string) => {
      const textarea = view.container.querySelector('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const select = async (index: number) => {
      await act(async () => { view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]!.click() })
    }
    const submit = async () => {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === zh['task.sendAnswer'])!
      await act(async () => { button.click() })
      await flushPanel()
    }
    try {
      if (choices) await select(0)
      else await fill('先比较成本')
      await submit()
      expect(writes).toHaveLength(1)
      expect(view.container.textContent).toContain('本轮优先核对哪项？')
      expect(document.body.textContent).not.toContain(zh['task.answerSaved'])
      if (mode === 'choice') await select(1)
      else if (mode === 'other') { await select(2); await fill('先核对授权范围') }
      else await fill(mode === 'text' ? '先比较延迟' : '  先比较成本  ')
      // 编辑或选择本身不发送答案。
      expect(writes).toHaveLength(1)
      await submit()
      expect(writes).toHaveLength(2)
      expect(writes[1]).toMatchObject({
        questionId: 'retry-question',
        text: mode === 'choice' ? '更低延迟' : mode === 'other' ? '先核对授权范围'
          : mode === 'text' ? '先比较延迟' : '先比较成本',
      })
      if (mode === 'retry') expect(writes[1]).toEqual(writes[0])
      else expect(writes[1]!.requestId).not.toBe(writes[0]!.requestId)
      expect(accepted).toEqual(committed ? writes[0] : writes[1])
      expect(view.container.textContent).not.toContain(zh['task.question'])
      if (committed && mode !== 'retry') {
        expect(document.body.textContent).toContain('本次修改未保存')
        expect(document.body.textContent).not.toContain(zh['task.answerSaved'])
      } else expect(document.body.textContent).toContain(zh['task.answerSaved'])
      expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    } finally { view.dispose() }
  })

it('回答已保存但状态刷新失败时显示保存事实，重新读取不重复提交答案', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  let saved = false, failReload = true, writes = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/inputs')) {
      writes++; saved = true
      return Response.json({ ticketId: 'local-1', inputId: 'saved-answer', created: true })
    }
    if (path.endsWith('/tasks/local-1') && saved && failReload) {
      failReload = false
      return Response.json({ error: '状态暂时无法读取' }, { status: 503 })
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, question: saved ? null : { id: 'first', text: '需要比较哪项？' } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    const textarea = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '延迟')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.sendAnswer'])!
    await act(async () => { submit.click() })
    await flushPanel()
    expect(writes).toBe(1)
    expect(view.container.textContent).toContain(zh['task.answerSaved'])
    expect(view.container.textContent).toContain('状态暂时无法读取')
    expect(view.container.querySelector('textarea')).toBeNull()
    expect([...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent === zh['task.reload'])).toHaveLength(1)
    const reload = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.reload'])!
    await act(async () => { reload.click() })
    await flushPanel()
    expect(writes).toBe(1)
    expect(view.container.textContent).not.toContain(zh['task.question'])
  } finally { view.dispose() }
})

it.each(['list', 'detail'].flatMap(page => [false, true].map(loaded => ({ page, loaded }))))(
  '$page 状态读取失败可重读，保留草稿且重复点击不堆积请求；已有数据$loaded', async ({ page, loaded }) => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: page === 'detail' ? { page: 'tasks', id: 'local-1' } : { page: 'tasks', query: { filter: 'needs_answer' } }, stack: [],
  }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const reads: string[] = []
  const pending = Promise.withResolvers<void>()
  let fail = !loaded, wait = false, updated = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1'), path = address.pathname
    const target = page === 'detail' ? path.endsWith('/tasks/local-1') : path.endsWith('/tasks')
    if (target && (init?.method ?? 'GET') === 'GET') {
      reads.push(path + address.search)
      if (wait) await pending.promise
      if (fail) return Response.json({ error: '状态暂时无法读取' }, { status: 503 })
    }
    const response = await original(url, init)
    if (!target || !updated) return response
    const value = await response.json()
    return Response.json(page === 'detail' ? { ...value, title: '已更新的任务' } : {
      ...value, items: value.items.map((item: Record<string, unknown>) => ({ ...item, title: '已更新的任务' })),
    })
  }))
  const { main } = fixture(['master']), view = await render(main, { t })
  const retry = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.reload'])!
  try {
    if (loaded) {
      if (page === 'detail') {
        const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
          .find(item => item.textContent?.includes(zh['task.addContext']))!
        await act(async () => { disclosure.click() })
      }
      await fillTaskGoal(view.container, '保留未提交的草稿')
      fail = true
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await flushPanel()
      expect(view.container.textContent).toContain('测试任务')
    }
    expect(view.container.textContent).toContain('状态暂时无法读取')
    expect(retry()).toBeTruthy()
    const beforeFailure = reads.length
    await act(async () => { retry().click() })
    await flushPanel()
    expect(reads).toHaveLength(beforeFailure + 1)
    expect(retry().disabled).toBe(false)
    expect(view.container.textContent).toContain('状态暂时无法读取')
    if (loaded) expect(view.container.querySelector('textarea')?.value).toBe('保留未提交的草稿')
    fail = false; wait = true; updated = true
    const beforeSuccess = reads.length
    const button = retry()
    await act(async () => { button.click(); button.click(); button.click() })
    await flushPanel()
    expect(reads).toHaveLength(beforeSuccess + 1)
    expect(button.disabled).toBe(true)
    await act(async () => { pending.resolve() })
    await flushPanel()
    expect(reads).toHaveLength(beforeSuccess + 1)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
    expect(view.container.textContent).not.toContain('状态暂时无法读取')
    expect(view.container.textContent).toContain('已更新的任务')
    expect(retry()).toBeUndefined()
    if (page === 'list') {
      for (const path of reads) {
        const url = new URL(path, 'http://127.0.0.1')
        expect(url.pathname).toBe('/orchestrator/api/tasks')
        expect(Object.fromEntries(url.searchParams)).toEqual({ state: 'needs_answer', limit: '50' })
      }
      expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route.query.filter).toBe('needs_answer')
    }
    if (loaded) expect(view.container.querySelector('textarea')?.value).toBe('保留未提交的草稿')
    expect(requests.some(request => request.method !== 'GET')).toBe(false)
  } finally { pending.resolve(); view.dispose() }
})

it.each(['resume', 'dispatch'] as const)('详情状态读取失败时保留草稿并禁用 %s，重读后须再次明确操作且使用最新版本', async action => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let failed = false, revision = 3
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tasks/local-1') && (init?.method ?? 'GET') === 'GET' && failed)
      return Response.json({ error: '任务状态读取中断' }, { status: 503 })
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, activity: 'held', workflow: { ...status.workflow, revision, autoRun: false,
      ...(action === 'dispatch' ? { progress: { total: 2, pending: 2, running: 0, completed: 0, suspended: 0, pruned: 0 },
        blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } } : {}) } })
  }))
  const { main } = fixture(['master']), view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  const label = zh[action === 'resume' ? 'task.resume' : 'task.dispatch']
  try {
    expect(button(label).disabled).toBe(false)
    const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(item => item.textContent?.includes(zh['task.addContext']))!
    await act(async () => { disclosure.click() })
    await fillTaskGoal(view.container, '尚未提交的新条件')
    failed = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(button(label).disabled).toBe(true)
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.statusUnknown'])
    expect(view.container.textContent).toContain(zh['task.staleStatus'])
    expect(view.container.textContent).toContain('测试任务')
    expect(view.container.querySelector('textarea')?.value).toBe('尚未提交的新条件')
    expect(button(zh['task.stop']).disabled).toBe(false)
    await act(async () => { button(label).click() })
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
    await act(async () => { button(zh['task.reload']).click() })
    await flushPanel()
    expect(button(label).disabled).toBe(true)
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.statusUnknown'])
    expect(view.container.querySelector('textarea')?.value).toBe('尚未提交的新条件')
    failed = false; revision = 9
    await act(async () => { button(zh['task.reload']).click() })
    await flushPanel()
    expect(button(label).disabled).toBe(false)
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.held'])
    expect(view.container.textContent).not.toContain(zh['task.staleStatus'])
    expect(view.container.querySelector('textarea')?.value).toBe('尚未提交的新条件')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
    await act(async () => { button(label).click() })
    await flushPanel()
    const writes = requests.filter(request => request.method === 'POST')
    expect(writes).toEqual([action === 'resume'
      ? { path: 'tasks/local-1/resume', method: 'POST', body: { revision: 9, nodeId: 'internal_analyze_id' } }
      : { path: 'tickets/local-1/hmm/commands', method: 'POST', body: { revision: 9, command: { action: 'dispatch' } } }])
  } finally { view.dispose() }
})

it('容量等待原因是只读投影，同一节点版本也随读取更新；状态过期和更重要的全局暂停时不冒充当前等待', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: { page: 'tasks', id: 'local-1' }, stack: [],
  }))
  const requests: { path: string; method: string }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let readable = true, globallyPaused = false, waitingFor: string | undefined = 'capacity'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    const response = await original(url, init)
    if (path === 'state') return Response.json({ ...await response.json(), paused: globallyPaused })
    if (path !== 'tasks/local-1') return response
    if (!readable) return Response.json({ error: 'Synthetic status is unavailable' }, { status: 503 })
    const status = await response.json()
    return Response.json({ ...status, activity: 'waiting', paused: false,
      workflow: { ...status.workflow, revision: 3, autoRun: true, requiresOrchestrator: false,
        progress: { total: 2, pending: 2, running: 0, suspended: 0, completed: 0, pruned: 0 },
        blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
        dependencyBlockers: { total: 0, omitted: 0, items: [] },
        ...(waitingFor ? { waitingFor } : {}) } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const refresh = async () => {
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
  }
  try {
    expect(view.container.textContent).toContain(zh['task.capacityWaiting'])
    const context = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(item => item.textContent?.includes(zh['task.addContext']))!
    await act(async () => { context.click() })
    await fillTaskGoal(view.container, '等待期间保留的来源范围')
    waitingFor = undefined
    await refresh()
    expect(view.container.textContent).not.toContain(zh['task.capacityWaiting'])
    waitingFor = 'capacity'
    await refresh()
    expect(view.container.textContent).toContain(zh['task.capacityWaiting'])
    readable = false
    await refresh()
    expect(view.container.textContent).not.toContain(zh['task.capacityWaiting'])
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.statusUnknown'])
    expect(view.container.textContent).toContain(zh['task.staleStatus'])
    readable = true
    await refresh()
    expect(view.container.textContent).toContain(zh['task.capacityWaiting'])
    // 全局状态和任务状态独立轮询；更晚读到全局暂停时，旧的任务投影不能继续宣称自动等待。
    globallyPaused = true
    await refresh()
    expect(view.container.textContent).not.toContain(zh['task.capacityWaiting'])
    globallyPaused = false
    waitingFor = 'future-reason'
    await refresh()
    expect(view.container.textContent).not.toContain(zh['task.capacityWaiting'])
    expect(view.container.textContent).not.toContain('future-reason')
    expect(view.container.querySelector('textarea')?.value).toBe('等待期间保留的来源范围')
    expect(requests.filter(request => request.method === 'POST')).toEqual([])
    expect(requests.filter(request => request.path === 'tasks/local-1').length).toBeGreaterThan(1)
  } finally { view.dispose(); visible.mockRestore() }
})

it('详情失去更新时不冒充当前正在运行，仍可暂停派发和确认停止', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let failed = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tasks/local-1/stop') && init?.method === 'POST') {
      requests.push({ path: 'tasks/local-1/stop', method: 'POST' })
      return Response.json({ ticketId: 'local-1', ended: { outcome: 'stopped' } })
    }
    if (path.endsWith('/tasks/local-1') && failed) return Response.json({ error: '无法取得当前状态' }, { status: 503 })
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, activity: 'running', workflow: { ...status.workflow, autoRun: true,
      requiresOrchestrator: false, progress: { total: 2, pending: 1, running: 1, completed: 0, suspended: 0, pruned: 0 },
      runningSteps: { total: 1, omitted: 0, items: [{ nodeId: 'internal_analyze_id', title: '核对授权资料' }] },
      blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  try {
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.running'])
    failed = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.statusUnknown'])
    expect(view.container.querySelector('.dt-task-running')?.getAttribute('aria-label')).toBe(zh['task.previousRunningSteps'])
    expect(view.container.querySelector('.dt-task-progress .dt-spinner')).toBeNull()
    expect(view.container.querySelector('.dt-task-running .dt-spinner')).toBeNull()
    expect(view.container.textContent).toContain('核对授权资料')
    expect(button(zh['task.hold']).disabled).toBe(false)
    expect(button(zh['task.stop']).disabled).toBe(false)
    await act(async () => { button(zh['task.hold']).click() })
    await flushPanel()
    expect(requests.filter(request => request.method === 'POST')).toEqual([{
      path: 'tickets/local-1/hmm/commands', method: 'POST', body: { revision: 3, command: { action: 'hold' } },
    }])
    await act(async () => { button(zh['task.stop']).click() })
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    await act(async () => { button(zh.cancel).click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    await act(async () => { button(zh['task.stop']).click() })
    await act(async () => { button(zh.confirm).click() })
    await flushPanel()
    expect(requests.filter(request => request.method === 'POST').map(request => request.path))
      .toEqual(['tickets/local-1/hmm/commands', 'tasks/local-1/stop'])
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.statusUnknown'])
  } finally { view.dispose() }
})

it.each(['dispatch', 'hold', 'resume', 'stop'].flatMap(action =>
  ['offline', 'server'].flatMap(failure => [false, true].map(committed => ({ action, failure, committed })))))(
  '$action回执$failure且已提交=$committed时只读核对一次，不依据异常推断成败或自动重发', async ({ action, failure, committed }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
      route: { page: 'tasks', id: 'local-1' }, stack: [],
    }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const pendingCheck = Promise.withResolvers<Response>()
    let initial!: ApiResponse<'GET tasks/:id'>, current: typeof initial | undefined
    let reads = 0, sent = false
    const endpoint = action === 'stop' || action === 'resume' ? `tasks/local-1/${action}` : 'tickets/local-1/hmm/commands'
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
      if (path === 'tasks/local-1' && init?.method === 'GET') {
        reads++
        const response = await original(url, init)
        if (!initial) {
          const status = await response.json()
          initial = action === 'resume' ? { ...status, title: '操作前的状态' }
            : { ...status, title: '操作前的状态', activity: action === 'dispatch' ? 'held' : 'waiting',
              workflow: { ...status.workflow, autoRun: action !== 'dispatch', requiresOrchestrator: false,
                progress: { total: 2, pending: 2, running: 0, completed: 0, suspended: 0, pruned: 0 },
                blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
                dependencyBlockers: { total: 0, omitted: 0, items: [] } } }
        }
        return sent ? pendingCheck.promise : Response.json(initial)
      }
      if (path === endpoint && init?.method === 'POST') {
        requests.push({ path, method: 'POST', ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
        sent = true
        const stopped = action === 'stop', automatic = action === 'dispatch' || action === 'resume'
        current = committed ? { ...initial, title: '重新读取的已提交状态',
          ended: stopped ? { outcome: 'stopped', by: 'human', at: '2026-11-06T08:00:00Z' } : null,
          activity: stopped ? 'ended' : automatic ? 'waiting' : 'held',
          workflow: { ...initial.workflow, revision: 9, autoRun: automatic,
            progress: { total: 2, pending: 2, running: 0, completed: 0, suspended: 0, pruned: 0 },
            blockers: { snapshot: 'b'.repeat(64), total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
            dependencyBlockers: { total: 0, omitted: 0, items: [] } } } : initial
        if (failure === 'offline') throw new TypeError('Synthetic response was lost')
        return Response.json({ error: 'Synthetic gateway failure' }, { status: 503 })
      }
      return original(url, init)
    }))
    const { main } = fixture([]), view = await render(main, { t })
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.getAttribute('aria-label') === label || item.textContent === label)!
    try {
      if (action !== 'stop') {
        await act(async () => view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')
          .forEach(item => { if (item.textContent?.includes(zh['task.addContext'])) item.click() }))
        await fillTaskGoal(view.container, '核对未知结果期间保留的补充')
      }
      const label = zh[action === 'dispatch' ? 'task.dispatch' : action === 'hold' ? 'task.hold'
        : action === 'resume' ? 'task.resume' : 'task.stop']
      await act(async () => button(label).click())
      if (action === 'stop') await act(async () => button(zh.confirm).click())
      await flushPanel()
      expect(reads).toBe(2)
      expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
      expect(button(action === 'stop' ? zh.confirm : label).disabled).toBe(true)
      await act(async () => pendingCheck.resolve(Response.json(current!)))
      await flushPanel()
      expect(view.container.textContent).toContain(committed ? '重新读取的已提交状态' : '操作前的状态')
      expect(view.container.querySelector('.dt-tag')?.textContent).not.toBe(zh['task.statusUnknown'])
      expect(reads).toBe(2)
      const writes = requests.filter(item => item.method === 'POST')
      expect(writes).toEqual([{ path: endpoint, method: 'POST', ...(action === 'stop' ? {} : { body: action === 'resume'
        ? { revision: 3, nodeId: 'internal_analyze_id' } : { revision: 3, command: { action } } }) }])
      if (action !== 'stop') {
        expect(view.container.querySelector('textarea')?.value).toBe('核对未知结果期间保留的补充')
        expect(document.body.textContent).toContain(zh['task.controlUnconfirmed'])
      }
    } finally {
      pendingCheck.resolve(Response.json(initial))
      view.dispose()
    }
  })

it.each(['dispatch', 'resume'] as const)('%s未知回执后的核对也失败时显示待核实，人工重读只读事实不重发旧动作', async action => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: { page: 'tasks', id: 'local-1' }, stack: [],
  }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let sent = false, recovered = false, reads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'tasks/local-1' && init?.method === 'GET') {
      reads++
      const response = await original(url, init)
      if (sent && !recovered) return Response.json({ error: '状态仍不可读' }, { status: 503 })
      const value = await response.json()
      return Response.json(action === 'resume' && !recovered ? value
        : { ...value, activity: recovered ? 'waiting' : 'held',
          workflow: { ...value.workflow, revision: recovered ? 9 : 3, autoRun: recovered, requiresOrchestrator: false,
            progress: { total: 2, pending: 2, running: 0, completed: 0, suspended: 0, pruned: 0 },
            blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
            dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
    }
    if (init?.method === 'POST' && (path.endsWith('/resume') || path.endsWith('/hmm/commands'))) {
      requests.push({ path, method: 'POST', body: JSON.parse(String(init.body)) })
      sent = true
      throw new TypeError('Synthetic response was lost')
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  try {
    const label = zh[action === 'dispatch' ? 'task.dispatch' : 'task.resume']
    await act(async () => button(label).click())
    await flushPanel()
    expect(reads).toBe(2)
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.statusUnknown'])
    expect(view.container.textContent).toContain(zh['task.staleStatus'])
    expect(button(label).disabled).toBe(true)
    await act(async () => button(label).click())
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
    recovered = true
    await act(async () => button(zh['task.reload']).click())
    await flushPanel()
    expect(reads).toBe(3)
    expect(view.container.querySelector('.dt-tag')?.textContent).not.toBe(zh['task.statusUnknown'])
    expect(view.container.textContent).not.toContain(zh['task.staleStatus'])
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
  } finally { view.dispose() }
})

it.each([
  { action: 'dispatch', status: 400 }, { action: 'hold', status: 400 },
  { action: 'resume', status: 403 }, { action: 'stop', status: 403 },
])('$action被明确拒绝$status时保留具体错误，不增加无关状态读取', async ({ action, status }) => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: { page: 'tasks', id: 'local-1' }, stack: [],
  }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (init?.method === 'POST') {
      requests.push({ path, method: 'POST', ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
      return Response.json({ error: '明确拒绝此操作' }, { status })
    }
    const response = await original(url, init)
    if (path === 'tasks/local-1' && action === 'dispatch') {
      const value = await response.json()
      return Response.json({ ...value, activity: 'held', workflow: { ...value.workflow, autoRun: false,
        requiresOrchestrator: false, progress: { total: 2, pending: 2, running: 0, suspended: 0, completed: 0, pruned: 0 },
        blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
        dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
    }
    return response
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  try {
    const label = zh[action === 'dispatch' ? 'task.dispatch' : action === 'hold' ? 'task.hold'
      : action === 'resume' ? 'task.resume' : 'task.stop']
    await act(async () => button(label).click())
    if (action === 'stop') await act(async () => button(zh.confirm).click())
    await flushPanel()
    expect(document.body.textContent).toContain('明确拒绝此操作')
    expect(document.body.textContent).not.toContain(zh['task.controlUnconfirmed'])
    expect(requests.filter(item => item.path === 'tasks/local-1')).toHaveLength(1)
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
  } finally { view.dispose() }
})

it.each(['answer', 'context'].flatMap(kind => ['projection', 'legacy'].map(transport => ({ kind, transport }))))(
  '输入$kind确认保存后接续就近阅读区域，$transport路径不额外读取或执行', async ({ kind, transport }) => {
    const run = await inputFocusFixture(kind, transport === 'projection')
    try {
      await run.submit()
      expect(run.submitter.disabled).toBe(true)
      await run.complete()
      expect(document.activeElement).toBe(run.target())
      expect(run.target().tabIndex).toBe(-1)
      expect(run.reads()).toBe(transport === 'projection' ? 1 : 2)
      expect(run.writes).toHaveLength(1)
      await act(async () => {
        run.target().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }))
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await flushPanel()
      expect(document.activeElement).toBe(run.target())
      expect(run.writes).toHaveLength(1)
    } finally { run.dispose() }
  })

async function inputFocusFixture(kind: string, projection = true) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  const writes: unknown[] = []
  let initial!: ApiResponse<'GET tasks/:id'>, current: typeof initial | undefined
  let readCount = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'tasks/local-1/inputs' && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return pending.promise
    }
    if (path === 'tasks/local-1' && init?.method === 'GET') {
      readCount++
      if (!initial) initial = { ...await (await original(url, init)).json(),
        question: kind === 'answer' ? { id: 'focus-question', text: 'Select the authorized source' } : null }
      return Response.json(current ?? initial)
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  if (kind === 'context') await act(async () => {
    [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(item => item.textContent?.includes(zh['task.addContext']))!.click()
  })
  await fillTaskGoal(view.container, 'Use the approved source')
  const submitter = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh[kind === 'answer' ? 'task.sendAnswer' : 'task.sendContext'])!
  const refresh = async () => { await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await flushPanel() }
  return { ...view, writes, submitter, requests, reads: () => readCount,
    title: () => view.container.querySelector<HTMLHeadingElement>('.dt-page-title h2')!,
    target: () => view.container.querySelector<HTMLDivElement>(
      `div[role="group"][aria-label="${zh[kind === 'answer' ? 'task.answer' : 'task.context']}"]`)!,
    submit: async (focused = true) => { await act(async () => { if (focused) submitter.focus(); submitter.click() }); await flushPanel() },
    refresh,
    replace: async () => {
      current = { ...initial, question: { id: 'new-focus-question', text: 'A new question' } }
      await refresh()
    },
    complete: async (outcome = 'saved') => {
      current ??= { ...initial, question: null, inputs: { total: initial.inputs.total + 1, pendingDelivery: 1 },
        ...(kind === 'answer' ? { lastAnswer: { inputId: 'saved-focus', at: '2026-11-07T04:00:00Z',
          question: { text: 'Select the authorized source', truncated: false },
          answer: { text: 'Use the approved source', truncated: false } } }
          : { lastContext: { inputId: 'saved-focus', at: '2026-11-07T04:00:00Z', text: 'Use the approved source', truncated: false } }) }
      await act(async () => pending.resolve(outcome === 'invalid' ? Response.json({})
        : outcome === 'failed' ? Response.json({ error: 'Save unavailable' }, { status: 503 })
          : Response.json({ ticketId: 'local-1', inputId: 'saved-focus', created: true, ...(projection ? { task: current } : {}) })))
      await flushPanel()
    },
    dispose: () => { pending.resolve(Response.json({})); view.dispose() },
  }
}

it.each(['answer', 'context'].flatMap(kind =>
  ['focus_elsewhere', 'focus_then_blur', 'pointer_elsewhere', 'hidden', 'invalid', 'failed', 'unfocused', 'left',
    ...(kind === 'answer' ? ['replaced'] : [])].map(situation => ({ kind, situation }))))(
  '输入$kind的焦点交接在$situation时让位，不增加执行', async ({ kind, situation }) => {
    const run = await inputFocusFixture(kind)
    const other = document.createElement('input'); document.body.append(other)
    try {
      await run.submit(situation !== 'unfocused')
      if (situation === 'focus_elsewhere' || situation === 'focus_then_blur') {
        other.focus()
        if (situation === 'focus_then_blur') other.blur()
      } else if (situation === 'pointer_elsewhere') {
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        run.submitter.blur()
      } else if (situation === 'hidden') vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      else if (situation === 'replaced') {
        await run.replace()
        run.container.querySelector<HTMLTextAreaElement>('textarea')!.focus()
      } else if (situation === 'left') {
        const settings = [...run.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find(button => button.textContent === zh['tab.settings'])!
        await act(async () => { settings.focus(); settings.click() })
        await flushPanel()
      }
      await run.complete(situation === 'invalid' || situation === 'failed' ? situation : 'saved')
      expect(document.activeElement).not.toBe(run.target())
      if (situation === 'focus_elsewhere') expect(document.activeElement).toBe(other)
      if (situation === 'replaced') expect(document.activeElement).toBe(run.container.querySelector('textarea'))
      if (situation === 'invalid' || situation === 'failed') {
        expect(run.container.querySelector('textarea')?.value).toBe('Use the approved source')
        expect(document.body.textContent).not.toContain(zh[kind === 'answer' ? 'task.answerSaved' : 'task.contextSaved'])
      }
      expect(run.writes).toHaveLength(1)
    } finally { run.dispose(); other.remove() }
  })

it.each(['answer', 'context'].flatMap(kind =>
  ['idle', 'old_success', 'old_failure', 'newer_input', 'missing', 'unavailable', 'partial', 'wrong_task',
    'missing_question', ...(kind === 'answer' ? ['same_question'] : [])].map(situation => ({ kind, situation }))))(
  '输入$kind直接接纳保存状态且隔离并发读取，情形$situation', async ({ kind, situation }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const pendingSave = Promise.withResolvers<Response>(), pendingRead = Promise.withResolvers<Response>()
    const preferences: (string | null)[] = []
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    let initial!: ApiResponse<'GET tasks/:id'>, current: typeof initial | undefined, projected!: typeof initial
    let reads = 0, waitRead = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
      if (path === 'tasks/local-1' && init?.method === 'GET') {
        reads++
        if (!initial) {
          const status = await (await original(url, init)).json()
          initial = { ...status, question: kind === 'answer' ? { id: 'input-question', text: 'Which source should be used?' } : null }
        }
        if (waitRead) { waitRead = false; return pendingRead.promise }
        return Response.json(current ?? initial)
      }
      if (path === 'tasks/local-1/inputs' && init?.method === 'POST') {
        requests.push({ path, method: 'POST', body: JSON.parse(String(init.body)) })
        preferences.push(new Headers(init.headers).get('x-orchestrator-task-view'))
        projected = { ...initial, title: '输入保存后的状态', question: null,
          inputs: { total: initial.inputs.total + 1, pendingDelivery: 1 },
          ...(kind === 'answer' ? { lastAnswer: { inputId: 'saved-input', at: '2026-11-07T04:00:00Z',
            question: { text: 'Which source should be used?', truncated: false },
            answer: { text: 'Use the approved source', truncated: false } } }
            : { lastContext: { inputId: 'saved-input', at: '2026-11-07T04:00:00Z', text: 'Use the approved source', truncated: false } }),
        }
        current = projected
        return pendingSave.promise
      }
      return original(url, init)
    }))
    const { main } = fixture([]), view = await render(main, { t })
    try {
      if (kind === 'context') await act(async () => {
        [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
          .find(item => item.textContent?.includes(zh['task.addContext']))!.click()
      })
      await fillTaskGoal(view.container, 'Use the approved source')
      if (situation.startsWith('old_')) {
        waitRead = true
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await flushPanel()
        expect(reads).toBe(2)
      }
      await act(async () => {
        [...view.container.querySelectorAll<HTMLButtonElement>('button')]
          .find(button => button.textContent === zh[kind === 'answer' ? 'task.sendAnswer' : 'task.sendContext'])!.click()
      })
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
      if (situation === 'newer_input') {
        current = { ...projected, title: '后来更新的输入状态', paused: true,
          inputs: { total: projected.inputs.total + 1, pendingDelivery: 2 },
          ...(kind === 'answer' ? { question: { id: 'new-question', text: 'A new question must remain visible' } } : {}) }
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await flushPanel()
      }
      const task = situation === 'unavailable' ? null
        : situation === 'partial' ? { ticketId: 'local-1', question: null }
          : situation === 'wrong_task' ? { ...projected, ticketId: 'other-task' }
            : situation === 'missing_question' ? { ...projected, question: undefined }
              : situation === 'same_question' ? { ...projected, question: initial.question } : projected
      await act(async () => pendingSave.resolve(Response.json({
        ticketId: 'local-1', inputId: 'saved-input', created: true, ...(situation === 'missing' ? {} : { task }),
      })))
      await flushPanel()
      if (situation.startsWith('old_')) {
        await act(async () => pendingRead.resolve(situation === 'old_failure'
          ? Response.json({ error: '迟到的旧状态错误' }, { status: 503 }) : Response.json(initial)))
        await flushPanel()
        expect(view.container.textContent).not.toContain('迟到的旧状态错误')
        expect(view.container.textContent).not.toContain(zh['task.staleStatus'])
      }
      const replacedQuestion = kind === 'answer' && situation === 'newer_input'
      expect(view.container.textContent).toContain(situation === 'newer_input' ? '后来更新的输入状态' : '输入保存后的状态')
      expect(reads).toBe(situation === 'idle' ? 1 : situation === 'newer_input' && !replacedQuestion ? 3 : 2)
      if (replacedQuestion) {
        expect(view.container.textContent).toContain('A new question must remain visible')
        expect(view.container.querySelector('textarea')!.value).toBe('')
        expect(document.body.textContent).not.toContain(zh['task.answerSaved'])
      }
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
      expect(preferences).toEqual(['state'])
      expect(view.container.textContent).not.toContain('other-task')
    } finally {
      pendingRead.resolve(Response.json(initial))
      pendingSave.resolve(Response.json({}))
      view.dispose()
      visible.mockRestore()
    }
  })

it.each(['dispatch', 'hold'].flatMap(action =>
  ['idle', 'old_success', 'old_failure', 'newer_input', 'missing', 'partial', 'wrong_task',
    'wrong_revision', 'wrong_plan', 'wrong_phase', 'wrong_action'].map(situation => ({ action, situation }))))(
  '派发控制$action核对完整回执并隔离并发读取，情形$situation', async ({ action, situation }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
      route: { page: 'tasks', id: 'local-1' }, stack: [],
    }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const pendingCommand = Promise.withResolvers<Response>(), pendingRead = Promise.withResolvers<Response>()
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    let initial!: ApiResponse<'GET tasks/:id'>, current: typeof initial | undefined, receipt!: typeof initial
    let reads = 0, waitRead = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
      if (path === 'tasks/local-1' && init?.method === 'GET') {
        reads++
        const response = await original(url, init)
        if (!initial) {
          const status = await response.json()
          initial = { ...status, activity: action === 'dispatch' ? 'held' : 'waiting',
            workflow: { ...status.workflow, autoRun: action === 'hold', requiresOrchestrator: false,
              progress: { total: 2, pending: 2, running: 0, completed: 0, pruned: 0, suspended: 0 },
              blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
              dependencyBlockers: { total: 0, omitted: 0, items: [] } } }
        }
        if (waitRead) { waitRead = false; return pendingRead.promise }
        return Response.json(current ?? initial)
      }
      if (path === 'tickets/local-1/hmm/commands' && init?.method === 'POST') {
        requests.push({ path, method: 'POST', body: JSON.parse(String(init.body)) })
        receipt = { ...initial, title: '控制动作已确认', activity: action === 'dispatch' ? 'waiting' : 'held',
          workflow: { ...initial.workflow, revision: 4, autoRun: action === 'dispatch' } }
        current = receipt
        return pendingCommand.promise
      }
      return original(url, init)
    }))
    const { main } = fixture([]), view = await render(main, { t })
    const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent === label)!
    try {
      const context = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
        .find(item => item.textContent?.includes(zh['task.addContext']))!
      await act(async () => context.click())
      await fillTaskGoal(view.container, '控制动作期间保留的未提交补充')
      if (situation.startsWith('old_')) {
        waitRead = true
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await flushPanel()
        expect(reads).toBe(2)
      }
      await act(async () => button(zh[action === 'dispatch' ? 'task.dispatch' : 'task.hold']).click())
      expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
      if (situation === 'newer_input') {
        current = { ...receipt, title: '更新的输入与暂停状态', paused: true,
          inputs: { ...receipt.inputs, total: receipt.inputs.total + 1, pendingDelivery: 1 } }
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await flushPanel()
      }
      const projected = situation === 'partial' ? { ticketId: 'local-1', workflow: { revision: 4 } }
        : situation === 'wrong_task' ? { ...receipt, ticketId: 'different-task' }
          : situation === 'wrong_revision' ? { ...receipt, workflow: { ...receipt.workflow, revision: 5 } }
            : situation === 'wrong_plan' ? { ...receipt, workflow: { ...receipt.workflow, planVersion: 2 } }
              : situation === 'wrong_phase' ? { ...receipt, workflow: { ...receipt.workflow, phase: 'validated' } }
                : situation === 'wrong_action' ? { ...receipt, workflow: { ...receipt.workflow, autoRun: action !== 'dispatch' } }
                  : receipt
      await act(async () => pendingCommand.resolve(Response.json({
        ticketId: 'local-1', revision: 4, phase: 'active', awaitingValidation: false,
        ...(situation !== 'missing' ? { task: projected } : {}),
      })))
      await flushPanel()
      expect(view.container.textContent).toContain(situation === 'newer_input' ? '更新的输入与暂停状态' : '控制动作已确认')
      if (situation.startsWith('old_')) {
        await act(async () => pendingRead.resolve(situation === 'old_failure'
          ? Response.json({ error: '过期控制状态读取失败' }, { status: 503 }) : Response.json(initial)))
        await flushPanel()
        expect(view.container.textContent).toContain('控制动作已确认')
        expect(view.container.textContent).not.toContain('过期控制状态读取失败')
        expect(view.container.textContent).not.toContain(zh['task.staleStatus'])
      }
      expect(reads).toBe(situation === 'idle' ? 1 : situation === 'newer_input' ? 3 : 2)
      expect(view.container.querySelector('textarea')?.value).toBe('控制动作期间保留的未提交补充')
      expect(requests.filter(item => item.method === 'POST')).toEqual([{
        path: 'tickets/local-1/hmm/commands', method: 'POST', body: { revision: 3, command: { action } },
      }])
      if (situation === 'newer_input') expect(view.container.textContent).toContain(zh['task.globallyPaused'])
      expect(view.container.textContent).not.toContain('different-task')
    } finally {
      pendingRead.resolve(Response.json(initial))
      pendingCommand.resolve(Response.json({}))
      view.dispose()
      visible.mockRestore()
    }
  })

it.each(['resume', 'stop'].flatMap(action =>
  ['idle', 'old_success', 'old_failure', 'newer_input', 'partial', 'wrong_task'].map(situation => ({ action, situation }))))(
  '任务$action采用完整回执且不覆盖并发状态；情形$situation', async ({ action, situation }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const pendingCommand = Promise.withResolvers<Response>(), pendingRead = Promise.withResolvers<Response>()
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    let initial!: ApiResponse<'GET tasks/:id'>, current: typeof initial | undefined, receipt!: typeof initial
    let reads = 0, waitRead = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
      if (path === 'tasks/local-1' && init?.method === 'GET') {
        reads++
        const response = await original(url, init)
        initial ??= await response.json()
        if (waitRead) { waitRead = false; return pendingRead.promise }
        return Response.json(current ?? initial)
      }
      if (path === `tasks/local-1/${action}` && init?.method === 'POST') {
        requests.push({ path, method: 'POST', ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
        receipt = { ...initial, title: '已经确认的任务状态', activity: action === 'stop' ? 'ended' : 'waiting',
          ended: action === 'stop' ? { outcome: 'stopped', by: 'human', at: '2026-11-06T08:00:00Z' } : null,
          workflow: { ...initial.workflow, revision: 5, autoRun: action === 'resume',
            progress: { ...initial.workflow.progress, suspended: 0, pending: 2 },
            blockers: { snapshot: 'b'.repeat(64), total: 0, omitted: 0, requiresOrchestrator: false, items: [] } } }
        current = receipt
        return pendingCommand.promise
      }
      return original(url, init)
    }))
    const { main } = fixture([]), view = await render(main, { t })
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent === label)!
    try {
      if (situation.startsWith('old_')) {
        waitRead = true
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        await flushPanel()
        expect(reads).toBe(2)
      }
      await act(async () => { button(zh[action === 'resume' ? 'task.resume' : 'task.stop']).click() })
      if (action === 'stop') await act(async () => { button(zh.confirm).click() })
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
      if (situation === 'newer_input') {
        // 输入与全局暂停可在相同节点版本下变化，不能仅比较 revision。
        current = { ...receipt, title: '收到新补充后的任务', paused: true,
          inputs: { ...receipt.inputs, total: receipt.inputs.total + 1, pendingDelivery: 1 } }
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        await flushPanel()
        expect(view.container.textContent).toContain('收到新补充后的任务')
      }
      await act(async () => { pendingCommand.resolve(Response.json(situation === 'partial'
        ? { ticketId: 'local-1', workflow: { revision: 5 } }
        : situation === 'wrong_task' ? { ...receipt, ticketId: 'other-task' } : receipt)) })
      await flushPanel()
      expect(view.container.textContent).toContain(situation === 'newer_input' ? '收到新补充后的任务' : '已经确认的任务状态')
      if (situation.startsWith('old_')) {
        await act(async () => { pendingRead.resolve(situation === 'old_failure'
          ? Response.json({ error: '回执之前的状态读取失败' }, { status: 503 }) : Response.json(initial)) })
        await flushPanel()
        expect(view.container.textContent).toContain('已经确认的任务状态')
        expect(view.container.textContent).not.toContain('回执之前的状态读取失败')
        expect(view.container.textContent).not.toContain(zh['task.staleStatus'])
      }
      expect(reads).toBe(situation === 'newer_input' ? 3 : situation === 'idle' ? 1 : 2)
      expect(button(zh['task.resume'])).toBeUndefined()
      if (action === 'stop') expect(button(zh['task.stop'])).toBeUndefined()
      if (situation === 'newer_input') expect(view.container.textContent).toContain(zh['task.globallyPaused'])
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    } finally {
      pendingRead.resolve(Response.json(initial))
      pendingCommand.resolve(Response.json({}))
      view.dispose()
      visible.mockRestore()
    }
  })

it('待送达补充信息在折叠入口外显示一次，并保留讨论入口，不把送达当作已采纳', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, activity: 'running',
      inputs: { total: status.inputs.total + 1, pendingDelivery: 1 },
      workflow: { ...status.workflow, requiresOrchestrator: true,
        progress: { ...status.workflow.progress, running: 1, pending: 1, suspended: 0 },
        runningSteps: { total: 1, omitted: 0, items: [{ nodeId: 'internal_analyze_id', title: '核对授权资料' }] },
        blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
        dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    const queued = zh['task.inputCount'].replace('{count}', '1')
    expect(view.container.textContent).toContain(queued)
    expect(view.container.textContent?.split(queued)).toHaveLength(2)
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.openOrchestrator'])).toBe(true)
    expect(view.container.textContent).not.toContain(zh['task.lastContext'])
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each(['hold', 'dispatch', 'resume', 'stop'].flatMap(action =>
  ['settings', 'return'].flatMap(destination =>
    ['saved', 'conflict', 'offline'].map(result => ({ action, destination, result })))))(
  '执行命令离页后不重读或通知旧页面；动作$action，去向$destination，结果$result',
  async ({ action, destination, result }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
      route: { page: 'tasks', id: 'local-1' }, stack: [],
    }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const response = Promise.withResolvers<Response>()
    const writes: { path: string; body?: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname
      if (init?.method === 'POST') {
        writes.push({ path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
        return response.promise
      }
      const reply = await original(url, init)
      if (!path.endsWith('/tasks/local-1')) return reply
      const status = await reply.json()
      return Response.json({ ...status, workflow: { ...status.workflow, autoRun: action !== 'dispatch',
        ...(action === 'dispatch' ? {
          progress: { total: 2, pending: 2, running: 0, completed: 0, suspended: 0, pruned: 0 },
          blockers: { total: 0, omitted: 0, items: [] },
        } : {}) } })
    }))
    const { ctx, main } = fixture(['master']), view = await render(main, { t })
    const click = async (label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.textContent === label)!
      await act(async () => { button.click() })
      await flushPanel()
    }
    try {
      await click(zh[action === 'resume' ? 'task.resume' : action === 'dispatch' ? 'task.dispatch'
        : action === 'hold' ? 'task.hold' : 'task.stop'])
      if (action === 'stop') await click(zh.confirm)
      expect(writes).toHaveLength(1)
      expect(writes[0]!.path).toBe(action === 'resume' || action === 'stop'
        ? `/orchestrator/api/tasks/local-1/${action}` : '/orchestrator/api/tickets/local-1/hmm/commands')
      if (action !== 'stop') expect(writes[0]!.body).toEqual(action === 'resume'
        ? { revision: 3, nodeId: 'internal_analyze_id' } : { revision: 3, command: { action } })
      if (action === 'stop') await click(zh.cancel)
      await click(zh[destination === 'settings' ? 'tab.settings' : 'tab.tasks'])
      if (destination === 'return') {
        await click('测试任务')
        const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
          .find(item => item.textContent?.includes(zh['task.addContext']))!
        await act(async () => { disclosure.click() })
        await fillTaskGoal(view.container, '新页面尚未提交的补充')
      }
      const reads = requests.length, route = sessionStorage.getItem('dsh-superagent/route')
      await act(async () => {
        if (result === 'offline') response.reject(new TypeError('旧执行命令断网'))
        else response.resolve(result === 'conflict'
          ? Response.json({ code: 'revision_conflict', error: '旧执行命令版本冲突' }, { status: 409 })
          : Response.json({ ticketId: 'local-1', workflow: { revision: 4,
            blockers: { snapshot: 'b'.repeat(64), total: 0, omitted: 0, items: [] } } }))
      })
      await flushPanel()
      expect(requests).toHaveLength(reads)
      expect(writes).toHaveLength(1)
      expect(document.querySelector('.dt-toast')).toBeNull()
      expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
      expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
      if (destination === 'return') {
        expect(view.container.querySelector('textarea')?.value).toBe('新页面尚未提交的补充')
        if (action === 'resume') expect(view.container.textContent).toContain('核对授权资料')
      }
    } finally { response.resolve(Response.json({})); view.dispose() }
  })

it('恢复期间拦住重复点击，版本冲突后刷新并等待重新判断，不自动重放旧动作', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: { revision: number; nodeId: string }[] = []
  const first = Promise.withResolvers<Response>()
  let revision = 3, resumed = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tasks/local-1/resume') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      if (writes.length === 1) return first.promise
      resumed = true
      return original(url, init)
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, activity: resumed ? 'waiting' : 'held',
      workflow: { ...status.workflow, revision, autoRun: resumed } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const flush = async () => {
    for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  const button = () => [...view.container.querySelectorAll('button')].find(item => item.textContent === zh['task.resume'])!
  try {
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.dispatch'])).toBe(false)
    expect(writes).toEqual([])
    await act(async () => { button().click(); button().click() })
    expect(writes).toEqual([{ revision: 3, nodeId: 'internal_analyze_id' }])
    expect(button().disabled).toBe(true)
    revision = 9
    first.resolve(Response.json({ error: '任务状态已更新，请检查后再继续', code: 'revision_conflict' }, { status: 409 }))
    await flush()
    expect(document.body.textContent).toContain('任务状态已更新，请检查后再继续')
    expect(button().disabled).toBe(false)
    expect(writes).toHaveLength(1)
    expect(requests.filter(item => item.path === 'tasks/local-1' && item.method === 'GET').length).toBeGreaterThan(1)
    await act(async () => { button().click() })
    await flush()
    expect(writes).toEqual([
      { revision: 3, nodeId: 'internal_analyze_id' }, { revision: 9, nodeId: 'internal_analyze_id' },
    ])
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.resume'])).toBe(false)
    expect(view.container.textContent).not.toContain(zh['task.held'])
    expect(requests.filter(item => item.path === 'tickets/local-1/hmm/commands')).toHaveLength(0)
  } finally { first.resolve(Response.json({}, { status: 500 })); view.dispose() }
})

it.each(['paused', 'ended', 'pending'] as const)('%s 任务只呈现当前有效的恢复或派发动作', async situation => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, paused: situation !== 'ended', activity: situation === 'ended' ? 'ended' : 'paused',
      ended: situation === 'ended' ? { outcome: 'stopped', by: 'human', at: '2026-11-05T00:00:00Z' } : null,
      workflow: { ...status.workflow, autoRun: false,
        ...(situation === 'pending' ? { blockers: { total: 0, omitted: 0, items: [] },
          progress: { ...status.workflow.progress, suspended: 0, pending: 2 } } : {}) } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    const buttons = [...view.container.querySelectorAll('button')]
    const resume = buttons.find(item => item.textContent === zh['task.resume'])
    const dispatch = buttons.find(item => item.textContent === zh['task.dispatch'])
    if (situation === 'ended') { expect(resume).toBeUndefined(); expect(dispatch).toBeUndefined() }
    else if (situation === 'pending') { expect(resume).toBeUndefined(); expect(dispatch?.disabled).toBe(true); dispatch?.click() }
    else { expect(resume?.disabled).toBe(true); expect(dispatch).toBeUndefined(); resume?.click() }
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(0)
    const settings = [...view.container.querySelectorAll('button')].find(button => button.textContent === zh['task.openExecutionSettings'])
    expect(settings ? situation !== 'ended' : true).toBe(true)
    if (situation !== 'ended') {
      await act(async () => { settings!.click() })
      expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route).toEqual({ page: 'settings', query: { group: 'execution' } })
      if (situation === 'paused') {
        const returnToTask = [...view.container.querySelectorAll('button')].find(button => button.textContent === zh['task.returnToTask'])!
        await act(async () => { returnToTask.click() })
        expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route).toEqual({ page: 'tasks', id: 'local-1' })
      }
    }
  } finally { view.dispose() }
})

it.each([
  ['parent_suspended', 'task.resumeParent'],
  ['attempts_exhausted', 'task.resumeExhausted'],
  ['manual_running', 'task.resumeManual'],
  [undefined, 'task.resumeUnknown'],
  ['future_condition', 'task.resumeUnknown'],
] as const)('面板对 %s 条件显示处理方向，拒绝推测恢复许可或发出必然失败的请求', async (resume, hint) => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, workflow: { ...status.workflow, blockers: {
      total: 1, omitted: 0, items: status.workflow.blockers.items.map((item: object) => ({ ...item, resume })),
    } } })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    expect(view.container.textContent).toContain('核对授权资料')
    expect(view.container.textContent).toContain(zh[hint])
    expect(view.container.textContent).toContain(zh['taskFailure.RATE_LIMIT'])
    expect([...view.container.querySelectorAll('button')].some(button => button.textContent === zh['task.resume'])).toBe(false)
    const open = [...view.container.querySelectorAll('button')].find(button => button.textContent === zh['task.openOrchestrator'])!
    await act(async () => { open.click() })
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
    expect(requests.filter(request => request.method === 'POST')).toEqual([{
      path: 'tasks/local-1/discuss', method: 'POST', body: { requestId: expect.any(String) },
    }])
  } finally { view.dispose() }
})

it('多个挂起步骤显示各自名称，只为当前允许恢复的步骤发送选中编号', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, workflow: { ...status.workflow, blockers: {
      total: 2, omitted: 0, items: [
        { nodeId: 'internal_other_id', title: '复核过期方案', resume: 'attempts_exhausted', reason: '等待核查' },
        { nodeId: 'internal_analyze_id', title: '核对授权资料', resume: 'available', reason: '等待核查' },
      ],
    } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.textContent).toContain('复核过期方案')
    expect(view.container.textContent).toContain('核对授权资料')
    expect(view.container.textContent).not.toContain('internal_other_id')
    const resumes = [...view.container.querySelectorAll('button')].filter(button => button.textContent === zh['task.resume'])
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!.getAttribute('aria-label')).toBe('恢复并继续任务：核对授权资料')
    await act(async () => { resumes[0]!.click() })
    expect(requests.filter(request => request.path === 'tasks/local-1/resume')).toEqual([
      { path: 'tasks/local-1/resume', method: 'POST', body: { revision: 3, nodeId: 'internal_analyze_id' } },
    ])
  } finally { view.dispose() }
})

it('只有可直接恢复的挂起步骤时隐藏总管入口，保留直接恢复动作', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, workflow: { ...status.workflow, requiresOrchestrator: false,
      blockers: { total: 1, omitted: 0, requiresOrchestrator: false, items: [
        { nodeId: 'internal_analyze_id', title: '核对授权资料', resume: 'available', reason: '资料已补充' },
      ] },
      dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.openOrchestrator'])).toBe(false)
    expect([...view.container.querySelectorAll('button')].filter(item => item.textContent === zh['task.resume'])).toHaveLength(1)
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each([false, true])('手动执行时不提供必然失败的派发；更新后仅恢复可用动作，全局暂停=%s', async paused => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let manual = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, paused, activity: 'running', workflow: { ...status.workflow, autoRun: false,
      requiresOrchestrator: manual, ...(manual ? { dispatchBlocker: 'manual_running' } : {}),
      progress: { total: 2, pending: 1, running: 1, completed: 0, suspended: 0, pruned: 0 },
      runningSteps: { total: 1, omitted: 0, items: [{ nodeId: 'source', title: '核对授权资料' }] },
      blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
      dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
  }))
  const { main } = fixture(['master']), view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)
  try {
    expect(button(zh['task.dispatch'])).toBeUndefined()
    expect(view.container.textContent).toContain(zh['task.resumeManual'])
    expect(button(zh['task.openOrchestrator'])).toBeTruthy()
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh['task.running'])
    expect(view.container.textContent).toContain('核对授权资料')
    const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(item => item.textContent?.includes(zh['task.addContext']))!
    await act(async () => { disclosure.click() })
    await fillTaskGoal(view.container, '等待核对期间保留的新条件')
    manual = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.textContent).not.toContain(zh['task.resumeManual'])
    expect(button(zh['task.openOrchestrator'])).toBeUndefined()
    expect(button(zh['task.dispatch'])?.disabled).toBe(paused)
    expect(view.container.querySelector('textarea')?.value).toBe('等待核对期间保留的新条件')
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(0)
    if (!paused) {
      await act(async () => { button(zh['task.dispatch'])!.click() })
      await flushPanel()
      expect(requests.filter(item => item.method === 'POST')).toEqual([{
        path: 'tickets/local-1/hmm/commands', method: 'POST', body: { revision: 3, command: { action: 'dispatch' } },
      }])
    }
  } finally { view.dispose() }
})

it('旧状态派发遇到手动执行冲突后重读并移除派发入口，不自动重试或丢失草稿', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let manual = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if (path === 'tickets/local-1/hmm/commands' && init?.method === 'POST') {
      requests.push({ path, method: 'POST', body: JSON.parse(String(init.body)) })
      manual = true
      return Response.json({ code: 'manual_running', error: '请先结束或挂起手动执行的节点' }, { status: 409 })
    }
    const response = await original(url, init)
    if (path !== 'tasks/local-1') return response
    const status = await response.json()
    return Response.json({ ...status, activity: manual ? 'running' : 'held', workflow: { ...status.workflow,
      revision: manual ? 4 : 3, autoRun: false, requiresOrchestrator: manual,
      ...(manual ? { dispatchBlocker: 'manual_running' } : {}),
      progress: { total: 2, pending: manual ? 1 : 2, running: manual ? 1 : 0, completed: 0, suspended: 0, pruned: 0 },
      blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
      dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
  }))
  const { main } = fixture(['master']), view = await render(main, { t })
  try {
    const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(item => item.textContent?.includes(zh['task.addContext']))!
    await act(async () => { disclosure.click() })
    await fillTaskGoal(view.container, '保留尚未提交的判断依据')
    const dispatch = [...view.container.querySelectorAll('button')].find(item => item.textContent === zh['task.dispatch'])!
    await act(async () => { dispatch.click() })
    await flushPanel()
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.dispatch'])).toBe(false)
    expect(view.container.textContent).toContain(zh['task.resumeManual'])
    expect(view.container.querySelector('textarea')?.value).toBe('保留尚未提交的判断依据')
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
  } finally { view.dispose() }
})

it('全步骤剪枝时直接说明需要重新评估计划', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, workflow: { ...status.workflow, requiresOrchestrator: true,
      planReviewRequired: true, autoRun: true,
      progress: { ...status.workflow.progress, total: 3, pruned: 3, pending: 0, running: 0, completed: 0 },
      blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.textContent).toContain(zh['task.planReviewRequired'])
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.openOrchestrator'])).toBe(true)
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.hold'])).toBe(false)
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.dispatch'])).toBe(false)
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it('全部挂起时隐藏空操作，但仍有运行节点时保留暂停派发', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm', [])
  const original = vi.mocked(fetch).getMockImplementation()!
  let running = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, workflow: { ...status.workflow, autoRun: true,
      progress: { ...status.workflow.progress, total: 2, pending: 0, running, suspended: running ? 1 : 2 } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.hold'])).toBe(false)
    running = 1
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect([...view.container.querySelectorAll('button')].some(item => item.textContent === zh['task.hold'])).toBe(true)
  } finally { view.dispose() }
})

const flushPanel = async () => {
  for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

function goalFixture() {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const control = {
    revision: 3, planVersion: 1, available: true as boolean | undefined, failStatus: false,
    text: '核对来源 A 的排期。\n只比较已授权资料，不能执行外部操作。<img src=x onerror=alert(1)>',
    response: undefined as ((goal: ApiResponse<'GET tasks/:id/goal'>) => Response | Promise<Response>) | undefined,
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1'), path = address.pathname.replace('/orchestrator/api/', '')
    if (path === 'tasks/local-1/goal') {
      requests.push({ path: path + address.search, method: 'GET' })
      const goal = { ticketId: 'local-1', planVersion: control.planVersion, text: control.text }
      return control.response ? control.response(goal) : Response.json(goal)
    }
    if (path === 'tasks/local-1' && control.failStatus)
      return Response.json({ error: '目标所属任务状态暂时无法读取' }, { status: 503 })
    const response = await original(url, init)
    if (path !== 'tasks/local-1') return response
    const status = await response.json()
    return Response.json({ ...status, goalAvailable: control.available,
      workflow: { ...status.workflow, revision: control.revision, planVersion: control.planVersion } })
  }))
  return { control, requests, reads: () => requests.filter(request => request.path.startsWith('tasks/local-1/goal?')) }
}

const goalToggle = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
  .find(row => row.textContent?.includes(zh['task.currentGoal']))!

function planChangeFixture() {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const control = { revision: 4, planVersion: 2, available: true as boolean | undefined, failStatus: false,
    reason: '根据新来源重新组织核对步骤',
    added: 1, removed: 0, changed: 2, affected: 4,
    affectedSteps: { items: ['重新核对来源 A', '汇总比较条件'], omitted: 2 } as ApiResponse<'GET tasks/:id/plan-change'>['affectedSteps'] | undefined,
    response: undefined as Response | Promise<Response> | undefined }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1'), path = address.pathname.replace('/orchestrator/api/', '')
    if (path === 'tasks/local-1/plan-change') {
      requests.push({ path: path + address.search, method: 'GET' })
      return control.response ?? Response.json({ ticketId: 'local-1', planVersion: control.planVersion,
        at: '2026-11-06T00:00:00Z', reason: control.reason, added: control.added, removed: control.removed,
        changed: control.changed, affected: control.affected, affectedSteps: control.affectedSteps })
    }
    if (path === 'tasks/local-1' && control.failStatus) {
      requests.push({ path, method: 'GET' })
      return Response.json({ error: '计划状态暂时无法读取' }, { status: 503 })
    }
    const response = await original(url, init)
    if (path !== 'tasks/local-1') return response
    const status = await response.json()
    return Response.json({ ...status, workflow: { ...status.workflow, revision: control.revision,
      planVersion: control.planVersion, planChangeAvailable: control.available } })
  }))
  return { control, requests, reads: () => requests.filter(request => request.path.startsWith('tasks/local-1/plan-change?')) }
}

const planChangeToggle = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
  .find(row => row.textContent?.includes(zh['task.planChange']))!

it('最近计划调整默认折叠，展开读取有界摘要，收起再开复用结果且不显示节点详情', async () => {
  const run = planChangeFixture(), { main } = fixture([]), view = await render(main, { t })
  try {
    expect(planChangeToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(run.reads()).toHaveLength(0)
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('根据新来源重新组织核对步骤')
    expect(view.container.textContent).toContain('新增项')
    expect(view.container.textContent).toContain('受影响步骤')
    const values = [...view.container.querySelectorAll('.dt-lv')].map(item =>
      [item.querySelector('.dt-lv-label')?.textContent, item.querySelector('.dt-lv-value')?.textContent])
    expect(values).toEqual([['新增项', '1'], ['调整项', '2'], ['受影响步骤', '4']])
    expect(view.container.querySelector('.dt-task-plan-impact')?.getAttribute('aria-label'))
      .toBe(zh['task.planChange.affectedSteps'])
    expect([...view.container.querySelectorAll('.dt-task-plan-impact > li')].map(item => item.textContent))
      .toEqual(run.control.affectedSteps!.items)
    expect(view.container.textContent).toContain('另有 2 个受影响步骤未列出。')
    expect(run.reads()).toHaveLength(1)
    await act(async () => { planChangeToggle(view.container).click() })
    await act(async () => { planChangeToggle(view.container).click() })
    expect(run.reads()).toHaveLength(1)
    expect(view.container.textContent).toContain('根据新来源重新组织核对步骤')
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { view.dispose() }
})

it('受影响名称是只读历史信息，安全显示重复标题及文本，不新增操作、请求或清除补充草稿', async () => {
  const run = planChangeFixture()
  run.control.affectedSteps = { items: ['相同的核对步骤', '相同的核对步骤', '<img src=x onerror=alert(1)>范围核验'], omitted: 1 }
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    const context = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(row => row.textContent?.includes(zh['task.addContext']))!
    await act(async () => { context.click() })
    await fillTaskGoal(view.container, '阅读调整时保留的新补充')
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    expect([...view.container.querySelectorAll('.dt-task-plan-impact > li')].map(item => item.textContent))
      .toEqual(run.control.affectedSteps.items)
    expect(view.container.querySelector('.dt-task-plan-impact [src="x"]')).toBeNull()
    expect(view.container.querySelector('.dt-task-plan-impact button')).toBeNull()
    expect(view.container.querySelector('textarea')?.value).toBe('阅读调整时保留的新补充')
    expect(run.reads().map(request => request.path)).toEqual(['tasks/local-1/plan-change?planVersion=2'])
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  } finally { view.dispose() }
})

it.each(['legacy', 'empty'] as const)('缺名称能力或没有受影响任务时继续显示原有摘要，不显示空列表和多余提示；%s', async mode => {
  const run = planChangeFixture()
  run.control.affectedSteps = mode === 'legacy' ? undefined : { items: [], omitted: 0 }
  if (mode === 'empty') run.control.affected = 0
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain(run.control.reason)
    expect(view.container.querySelector('.dt-task-plan-impact')).toBeNull()
    expect(view.container.textContent).not.toContain(zh['task.planChange.affectedSteps'])
    expect(view.container.textContent).not.toContain('受影响步骤未列出')
    expect(run.reads()).toHaveLength(1)
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { view.dispose() }
})

it('计划调整摘要换版后忽略旧响应，网络失败可原版本重试', async () => {
  const run = planChangeFixture(), pending = Promise.withResolvers<Response>()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  run.control.response = pending.promise
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { planChangeToggle(view.container).click() })
    run.control.planVersion = 3
    run.control.revision++
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    await act(async () => { pending.resolve(Response.json({ ticketId: 'local-1', planVersion: 2,
      at: '2026-11-06T00:00:00Z', reason: '旧调整', added: 1, removed: 0, changed: 1, affected: 1 })) })
    await flushPanel()
    expect(view.container.textContent).not.toContain('旧调整')
    expect(planChangeToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    run.control.response = Response.json({ error: '摘要暂时无法读取' }, { status: 503 })
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('摘要暂时无法读取')
    expect(document.querySelector('.dt-toast')).toBeNull()
    run.control.response = undefined
    await act(async () => { [...view.container.querySelectorAll('button')].find(button => button.textContent === zh['task.reload'])!.click() })
    await flushPanel()
    expect(view.container.textContent).toContain('根据新来源重新组织核对步骤')
    expect(run.reads().at(-1)?.path).toBe('tasks/local-1/plan-change?planVersion=3')
  } finally { pending.resolve(Response.json({})); view.dispose(); visible.mockRestore() }
})

it.each([false, true])('无关执行进度不清除计划调整的已读或在途摘要，不增加读取；在途%s', async inflight => {
  const run = planChangeFixture(), pending = Promise.withResolvers<Response>()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  if (inflight) run.control.response = pending.promise
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    await act(async () => { planChangeToggle(view.container).click() })
    await act(async () => { planChangeToggle(view.container).click() })
    expect(run.reads()).toHaveLength(1)
    run.control.revision++
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    if (inflight) await act(async () => { pending.resolve(Response.json({ ticketId: 'local-1', planVersion: 2,
      at: '2026-11-06T00:00:00Z', reason: run.control.reason, added: 1, removed: 0, changed: 2, affected: 4 })) })
    await flushPanel()
    expect(planChangeToggle(view.container).getAttribute('aria-expanded')).toBe('true')
    expect(view.container.textContent).toContain(run.control.reason)
    expect(run.reads().map(request => request.path)).toEqual(['tasks/local-1/plan-change?planVersion=2'])
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose(); visible.mockRestore() }
})

it('计划调整摘要遇到冲突先重读最新计划，再由用户展开新摘要，不自动重试旧请求', async () => {
  const run = planChangeFixture(), { main } = fixture([]), view = await render(main, { t })
  try {
    run.control.planVersion++
    run.control.revision++
    run.control.reason = '最新一次调整的原因'
    run.control.response = Response.json({ code: 'revision_conflict', error: '计划已再次调整' }, { status: 409 })
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    expect(planChangeToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(run.reads().map(request => request.path)).toEqual(['tasks/local-1/plan-change?planVersion=2'])
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads + 1)
    expect(document.querySelector('.dt-toast')).toBeNull()
    run.control.response = undefined
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('最新一次调整的原因')
    expect(run.reads().at(-1)?.path).toBe('tasks/local-1/plan-change?planVersion=3')
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each(['plan', 'leave'].flatMap(boundary => [200, 409, 503].map(status => ({ boundary, status }))))(
  '计划调整旧摘要的$status响应隔离，边界$boundary，不提示、不重读旧任务', async ({ boundary, status }) => {
    const run = planChangeFixture(), pending = Promise.withResolvers<Response>()
    const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    run.control.response = pending.promise
    const { main } = fixture([]), view = await render(main, { t })
    try {
      await act(async () => { planChangeToggle(view.container).click() })
      if (boundary === 'plan') {
        run.control.planVersion++
        run.control.revision++
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      } else {
        await act(async () => { [...view.container.querySelectorAll<HTMLButtonElement>('button')]
          .find(button => button.textContent === zh['tab.settings'])!.click() })
      }
      await flushPanel()
      const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
      const route = sessionStorage.getItem('dsh-superagent/route')
      await act(async () => { pending.resolve(Response.json(status === 200
        ? { ticketId: 'local-1', planVersion: 2, at: '2026-11-06T00:00:00Z',
          reason: '旧摘要原因', added: 1, removed: 0, changed: 2, affected: 4,
          affectedSteps: { items: ['旧计划受影响步骤'], omitted: 3 } }
        : { error: '旧摘要读取错误' }, { status })) })
      await flushPanel()
      expect(view.container.textContent).not.toContain('旧摘要原因')
      expect(view.container.textContent).not.toContain('旧计划受影响步骤')
      expect(view.container.querySelector('.dt-task-plan-impact')).toBeNull()
      expect(view.container.textContent).not.toContain('旧摘要读取错误')
      expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
      expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
      expect(document.querySelector('.dt-toast')).toBeNull()
      expect(run.reads()).toHaveLength(1)
      expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
    } finally { pending.resolve(Response.json({})); view.dispose(); visible.mockRestore() }
  })

it('无修订记录或旧宿主不显示摘要入口；状态读取失败不展示旧摘要，恢复后不自动读取', async () => {
  const run = planChangeFixture(), visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  run.control.available = undefined
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(planChangeToggle(view.container)).toBeUndefined()
    run.control.available = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(planChangeToggle(view.container)).toBeUndefined()
    expect(run.reads()).toHaveLength(0)
    run.control.available = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    await act(async () => { planChangeToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain(run.control.reason)
    run.control.failStatus = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(planChangeToggle(view.container)).toBeUndefined()
    expect(view.container.textContent).not.toContain(run.control.reason)
    run.control.failStatus = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(planChangeToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(run.reads()).toHaveLength(1)
  } finally { view.dispose(); visible.mockRestore() }
})

it.each([false, true])('当前目标默认折叠，展开才读取，重复点击不并发且执行进度不打断阅读；在途=%s', async inflight => {
  const run = goalFixture(), pending = Promise.withResolvers<Response>()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let first: ApiResponse<'GET tasks/:id/goal'> | undefined
  if (inflight) run.control.response = goal => { first = goal; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(goalToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(view.container.textContent).not.toContain(run.control.text)
    expect(run.reads()).toHaveLength(0)
    await act(async () => { goalToggle(view.container).click() })
    await act(async () => { goalToggle(view.container).click() })
    await act(async () => { goalToggle(view.container).click() })
    expect(run.reads()).toHaveLength(1)
    run.control.revision = 10
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    if (inflight) await act(async () => { pending.resolve(Response.json(first)) })
    await flushPanel()
    expect(goalToggle(view.container).getAttribute('aria-expanded')).toBe('true')
    expect(view.container.textContent).toContain(run.control.text)
    expect(view.container.querySelector('img[src="x"]')).toBeNull()
    await act(async () => { goalToggle(view.container).click() })
    expect(view.container.textContent).not.toContain(run.control.text)
    await act(async () => { goalToggle(view.container).click() })
    expect(view.container.textContent).toContain(run.control.text)
    expect(run.reads().map(request => request.path)).toEqual(['tasks/local-1/goal?planVersion=1'])
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose(); visible.mockRestore() }
})

it('目标读取失败可原样重试；计划冲突后核对新定义，再由用户展开读取', async () => {
  const run = goalFixture(), { main } = fixture([]), view = await render(main, { t })
  const retry = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.reload'])!
  try {
    run.control.response = () => Response.json({ error: '目标暂时无法读取' }, { status: 503 })
    await act(async () => { goalToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('目标暂时无法读取')
    expect(document.querySelector('.dt-toast')).toBeNull()
    run.control.planVersion = 2
    run.control.text = '新计划目标：仅复核来源 B。'
    run.control.response = () => Response.json({ error: '目标所属计划已变化' }, { status: 409 })
    await act(async () => { retry().click(); retry().click() })
    await flushPanel()
    expect(goalToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(view.container.textContent).not.toContain('目标所属计划已变化')
    expect(run.reads()).toHaveLength(2)
    run.control.response = undefined
    await act(async () => { goalToggle(view.container).click() })
    await flushPanel()
    expect(run.reads().at(-1)?.path).toBe('tasks/local-1/goal?planVersion=2')
    expect(view.container.textContent).toContain(run.control.text)
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each([200, 409, 503])('计划换版后旧目标的%s响应不覆盖当前定义或触发额外重读', async status => {
  const run = goalFixture(), pending = Promise.withResolvers<Response>()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let first: ApiResponse<'GET tasks/:id/goal'> | undefined
  run.control.response = goal => { first = goal; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { goalToggle(view.container).click() })
    run.control.planVersion++
    run.control.text = '只核对更新后的目标。'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    await act(async () => { pending.resolve(Response.json(status === 200 ? first : { error: '旧目标的读取错误' }, { status })) })
    await flushPanel()
    expect(view.container.textContent).not.toContain(first!.text)
    expect(view.container.textContent).not.toContain('旧目标的读取错误')
    expect(goalToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    run.control.response = undefined
    await act(async () => { goalToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain(run.control.text)
    expect(run.reads().at(-1)?.path).toBe('tasks/local-1/goal?planVersion=2')
  } finally { pending.resolve(Response.json({})); view.dispose(); visible.mockRestore() }
})

it('旧宿主或相同标题不新增目标入口，状态失败后移除旧目标，恢复时不自动重取正文', async () => {
  const run = goalFixture(), visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  run.control.available = undefined
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(goalToggle(view.container)).toBeUndefined()
    run.control.available = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(goalToggle(view.container)).toBeUndefined()
    expect(run.reads()).toHaveLength(0)
    run.control.available = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    await act(async () => { goalToggle(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain(run.control.text)
    run.control.failStatus = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(goalToggle(view.container)).toBeUndefined()
    expect(view.container.textContent).not.toContain(run.control.text)
    run.control.failStatus = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(goalToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(run.reads()).toHaveLength(1)
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { view.dispose(); visible.mockRestore() }
})

it.each([200, 409, 503])('离页后旧目标的%s响应不影响导航、不通知或重读旧任务', async status => {
  const run = goalFixture(), pending = Promise.withResolvers<Response>()
  let first: ApiResponse<'GET tasks/:id/goal'> | undefined
  run.control.response = goal => { first = goal; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { goalToggle(view.container).click() })
    const settings = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['tab.settings'])!
    await act(async () => { settings.click() })
    await flushPanel()
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    const route = sessionStorage.getItem('dsh-superagent/route')
    await act(async () => { pending.resolve(Response.json(status === 200 ? first : { error: '离页前的目标错误' }, { status })) })
    await flushPanel()
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
    expect(document.querySelector('.dt-toast')).toBeNull()
    expect(view.container.textContent).not.toContain(first!.text)
    expect(view.container.textContent).not.toContain('离页前的目标错误')
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

function resultSourcesFixture() {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  type Page = ApiResponse<'GET tasks/:id/result-sources'>
  const control = {
    revision: 20, valid: true, supported: true, failStatus: false,
    items: Array.from({ length: 9 }, (_, index): Page['items'][number] => ({
      nodeId: `internal_source_${index}`, title: `采用的步骤 ${index + 1}`,
      summary: { text: index ? `步骤成果 ${index + 1}` : '<img src=x onerror=alert(1)>核查结果', truncated: index === 0 },
    })),
    response: undefined as ((page: Page, offset: number) => Response | Promise<Response>) | undefined,
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1'), path = address.pathname.replace('/orchestrator/api/', '')
    if (path === 'tasks/local-1/result-sources') {
      requests.push({ path: path + address.search, method: 'GET' })
      const offset = Number(address.searchParams.get('offset'))
      const page = { ticketId: 'local-1', revision: control.revision, offset, total: control.items.length,
        items: control.items.slice(offset, offset + 4),
        nextOffset: offset + 4 < control.items.length ? offset + 4 : null }
      return control.response ? control.response(page, offset) : Response.json(page)
    }
    if (path === 'tasks/local-1' && control.failStatus)
      return Response.json({ error: '结果状态暂时无法读取' }, { status: 503 })
    const response = await original(url, init)
    if (path !== 'tasks/local-1') return response
    const status = await response.json()
    return Response.json({ ...status, activity: 'ended', ended: { outcome: 'completed', by: 'agent', at: '2026-11-06T00:00:00Z' },
      workflow: { ...status.workflow, revision: control.revision, phase: 'validated', autoRun: false,
        requiresOrchestrator: !control.valid, awaitingValidation: false,
        progress: { total: 9, pending: 0, running: 0, completed: 9, pruned: 0, suspended: 0 },
        blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } },
      result: control.valid ? { summary: '限定条件下的比较结论', evidenceRefs: ['private-result-ref'],
        ...(control.supported ? { sourceCount: control.items.length } : {}) } : null,
      resultError: control.valid ? null : 'evidence_invalid' })
  }))
  return { control, requests,
    reads: () => requests.filter(request => request.path.startsWith('tasks/local-1/result-sources?')) }
}

const sourceToggle = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
  .find(row => row.textContent?.includes(zh['task.resultSources']))!

it('完成结果默认不增加讨论入口，展开依据后只持久定位当前任务，确认响应后才打开总管', async () => {
  const run = resultSourcesFixture(), original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/tasks/local-1/discuss')) {
      run.requests.push({ path: 'tasks/local-1/discuss', method: init?.method ?? 'GET',
        body: JSON.parse(String(init?.body)) })
      return pending.promise
    }
    return original(url, init)
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  const discuss = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.openOrchestrator'])!
  try {
    expect(discuss()).toBeUndefined()
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
    await act(async () => { sourceToggle(view.container).click() })
    await flushPanel()
    expect(discuss()).toBeTruthy()
    const reads = run.requests.length
    await act(async () => { discuss().click(); discuss().click() })
    expect(discuss().disabled).toBe(true)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(run.requests.slice(reads)).toEqual([{
      path: 'tasks/local-1/discuss', method: 'POST', body: { requestId: expect.any(String) },
    }])
    await act(async () => { pending.resolve(Response.json({ sessionId: 'master' })) })
    await flushPanel()
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
    expect(view.container.textContent).toContain('限定条件下的比较结论')
    expect(view.container.querySelectorAll('.dt-task-result-sources > li')).toHaveLength(4)
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(run.reads()).toHaveLength(1)
  } finally { pending.resolve(Response.json({ sessionId: 'master' })); view.dispose() }
})

it('结果讨论与既有入口共用访问身份，写入或导航失败可重试且不重新读取成果', async () => {
  const run = resultSourcesFixture(), original = vi.mocked(fetch).getMockImplementation()!
  const requests: unknown[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (!url.endsWith('/tasks/local-1/discuss')) return original(url, init)
    requests.push(JSON.parse(String(init?.body)))
    return Promise.resolve(requests.length === 1
      ? Response.json({ error: '任务讨论背景保存失败' }, { status: 503 }) : Response.json({ sessionId: 'master' }))
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  ctx.uiWorkspace.openSession.mockImplementationOnce(() => { throw new Error('总管页面暂时无法打开') })
  const discuss = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.textContent === zh['task.openOrchestrator'])
  try {
    await act(async () => { sourceToggle(view.container).click() })
    await flushPanel()
    await act(async () => { discuss()[0]!.click() })
    await flushPanel()
    expect(document.body.textContent).toContain('任务讨论背景保存失败')
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    await act(async () => { discuss()[0]!.click() })
    await flushPanel()
    expect(document.body.textContent).toContain('总管页面暂时无法打开')
    await act(async () => { sourceToggle(view.container).click() })
    expect(discuss()).toHaveLength(0)
    await act(async () => { sourceToggle(view.container).click() })
    await act(async () => { discuss()[0]!.click() })
    await flushPanel()
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(3)
    expect(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0]))).toBe(true)
    expect(run.reads()).toHaveLength(1)
    run.control.valid = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(sourceToggle(view.container)).toBeUndefined()
    expect(discuss()).toHaveLength(1)
    await act(async () => { discuss()[0]!.click() })
    await flushPanel()
    expect(requests[3]).toEqual(requests[0])
    expect(view.container.textContent).toContain(zh['task.resultInvalid'])
  } finally { view.dispose(); visible.mockRestore() }
})

it.each([200, 409, 503])('离开完成任务后，结果讨论的%s回执不打开旧总管、不通知或重读', async status => {
  const run = resultSourcesFixture(), original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  let writes = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/tasks/local-1/discuss')) { writes++; return pending.promise }
    return original(url, init)
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === label)!
  try {
    await act(async () => { sourceToggle(view.container).click() })
    await flushPanel()
    await act(async () => { button(zh['task.openOrchestrator']).click() })
    expect(writes).toBe(1)
    await act(async () => { button(zh['tab.settings']).click() })
    await flushPanel()
    const reads = run.requests.length, route = sessionStorage.getItem('dsh-superagent/route')
    await act(async () => { pending.resolve(Response.json(status === 200 ? { sessionId: 'master' }
      : { error: '旧结果讨论请求失败' }, { status })) })
    await flushPanel()
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(document.querySelector('.dt-toast')).toBeNull()
    expect(run.requests).toHaveLength(reads)
    expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
    expect(writes).toBe(1)
  } finally { pending.resolve(Response.json({ sessionId: 'master' })); view.dispose() }
})

it('验收步骤默认折叠，展开才读取有界页，合并点击、保留已读并按需翻页，不执行或输出原始标识', async () => {
  const run = resultSourcesFixture(), pending = Promise.withResolvers<Response>()
  let first: ApiResponse<'GET tasks/:id/result-sources'> | undefined
  run.control.response = page => { first = page; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(sourceToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(view.container.textContent).not.toContain('采用的步骤 1')
    expect(run.reads()).toHaveLength(0)
    await act(async () => { sourceToggle(view.container).click() })
    await act(async () => { sourceToggle(view.container).click() })
    await act(async () => { sourceToggle(view.container).click() })
    expect(run.reads()).toHaveLength(1)
    await act(async () => { pending.resolve(Response.json(first)) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-result-sources > li')).toHaveLength(4)
    expect(view.container.textContent).toContain('<img src=x onerror=alert(1)>核查结果')
    expect(view.container.querySelector('img[src="x"]')).toBeNull()
    expect(view.container.textContent).toContain(zh['task.resultSourceExcerpt'])
    expect(view.container.textContent).not.toMatch(/internal_source_|private-result-ref/)
    await act(async () => { sourceToggle(view.container).click() })
    await act(async () => { sourceToggle(view.container).click() })
    expect(run.reads()).toHaveLength(1)
    run.control.response = undefined
    for (const count of [8, 9]) {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.textContent?.startsWith('更多步骤'))!
      await act(async () => { button.click(); button.click() })
      await flushPanel()
      expect(view.container.querySelectorAll('.dt-task-result-sources > li')).toHaveLength(count)
    }
    expect(run.reads().map(request => request.path)).toEqual([0, 4, 8]
      .map(offset => `tasks/local-1/result-sources?revision=20&offset=${offset}`))
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

it('验收步骤翻页失败保留已读页与游标供重试，冲突后移除旧依据并重新核对任务', async () => {
  const run = resultSourcesFixture(), { main } = fixture([]), view = await render(main, { t })
  const more = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent?.startsWith('更多步骤'))!
  const retry = () => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === zh['task.reload'])!
  try {
    await act(async () => { sourceToggle(view.container).click() })
    await flushPanel()
    run.control.response = () => Response.json({ error: '依据页暂时无法读取' }, { status: 503 })
    await act(async () => { more().click() })
    await flushPanel()
    expect(view.container.textContent).toContain('依据页暂时无法读取')
    expect(view.container.querySelectorAll('.dt-task-result-sources > li')).toHaveLength(4)
    expect(document.querySelector('.dt-toast')).toBeNull()
    run.control.response = undefined
    await act(async () => { retry().click() })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-result-sources > li')).toHaveLength(8)
    expect(run.reads().slice(1).map(request => request.path))
      .toEqual(Array(2).fill('tasks/local-1/result-sources?revision=20&offset=4'))
    run.control.valid = false
    run.control.response = () => Response.json({ error: '验收依据已失效' }, { status: 409 })
    await act(async () => { more().click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-task-result-sources')).toBeNull()
    expect(sourceToggle(view.container)).toBeUndefined()
    expect(view.container.textContent).toContain(zh['task.resultInvalid'])
    expect(view.container.textContent).not.toContain('步骤成果 8')
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each([200, 409, 503])('结果换版后忽略旧依据页的%s响应，不重读旧任务或混入新结果', async status => {
  const run = resultSourcesFixture(), pending = Promise.withResolvers<Response>()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let oldPage: ApiResponse<'GET tasks/:id/result-sources'> | undefined
  run.control.response = page => { oldPage = page; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { sourceToggle(view.container).click() })
    run.control.revision++
    run.control.items = run.control.items.map(item => ({ ...item, title: `新版本 ${item.title}` }))
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    await act(async () => { pending.resolve(Response.json(status === 200 ? oldPage : { error: '旧结果的读取错误' }, { status })) })
    await flushPanel()
    expect(view.container.querySelector('.dt-task-result-sources')).toBeNull()
    expect(view.container.textContent).not.toContain('旧结果的读取错误')
    expect(sourceToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    run.control.response = undefined
    await act(async () => { sourceToggle(view.container).click() })
    await flushPanel()
    expect(run.reads().at(-1)?.path).toBe('tasks/local-1/result-sources?revision=21&offset=0')
    expect(view.container.textContent).toContain('新版本 采用的步骤 1')
  } finally { pending.resolve(Response.json({})); view.dispose(); visible.mockRestore() }
})

it('详情读取失败时不继续显示旧依据，恢复读取后由用户重新展开；旧宿主无能力标识时隐藏入口', async () => {
  const run = resultSourcesFixture(), visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { sourceToggle(view.container).click() })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-result-sources > li')).toHaveLength(4)
    run.control.failStatus = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(sourceToggle(view.container)).toBeUndefined()
    expect(view.container.querySelector('.dt-task-result-sources')).toBeNull()
    expect(run.reads()).toHaveLength(1)
    run.control.failStatus = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(sourceToggle(view.container).getAttribute('aria-expanded')).toBe('false')
    expect(run.reads()).toHaveLength(1)
    run.control.supported = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(sourceToggle(view.container)).toBeUndefined()
    expect(view.container.textContent).toContain('限定条件下的比较结论')
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { view.dispose(); visible.mockRestore() }
})

it.each([200, 409, 503])('离开任务后旧验收依据页的%s响应不导航、不通知或重读旧任务', async status => {
  const run = resultSourcesFixture(), pending = Promise.withResolvers<Response>()
  let oldPage: ApiResponse<'GET tasks/:id/result-sources'> | undefined
  run.control.response = page => { oldPage = page; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { sourceToggle(view.container).click() })
    const settings = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['tab.settings'])!
    await act(async () => { settings.click() })
    await flushPanel()
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    const route = sessionStorage.getItem('dsh-superagent/route')
    await act(async () => { pending.resolve(Response.json(status === 200 ? oldPage : { error: '旧任务的验收依据错误' }, { status })) })
    await flushPanel()
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    expect(sessionStorage.getItem('dsh-superagent/route')).toBe(route)
    expect(view.container.textContent).not.toContain('旧任务的验收依据错误')
    expect(view.container.textContent).not.toContain('采用的步骤 1')
    expect(document.querySelector('.dt-toast')).toBeNull()
    expect(run.requests.filter(request => request.method !== 'GET')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

type BlockerPageFixture = Omit<ApiResponse<'GET tasks/:id/blockers'>, 'snapshot' | 'requiresOrchestrator'>
  & { snapshot?: string; requiresOrchestrator?: boolean }
function pagedBlockers(withSnapshot = false, fullReceipt = false) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let lastStatus: ApiResponse<'GET tasks/:id'> | undefined
  type Page = BlockerPageFixture
  const control = {
    revision: 3, paused: false, ended: false, snapshot: withSnapshot ? 'a'.repeat(64) : undefined,
    items: Array.from({ length: 9 }, (_, index): Page['items'][number] => ({
      nodeId: `step_${index}`, title: `待核对步骤 ${index + 1}`, reason: '来源需要再次核查',
      resume: index < 4 ? 'parent_suspended' : 'available',
    })),
    response: undefined as ((page: Page, offset: number) => Response | Promise<Response>) | undefined,
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1'), path = address.pathname.replace('/orchestrator/api/', '')
    if (path === 'tasks/local-1/blockers') {
      requests.push({ path: `${path}${address.search}`, method: 'GET' })
      const offset = Number(address.searchParams.get('offset'))
      const page = { revision: control.revision, snapshot: control.snapshot, total: control.items.length, items: control.items.slice(offset, offset + 4),
        nextOffset: offset + 4 < control.items.length ? offset + 4 : null }
      return control.response ? control.response(page, offset) : Response.json(page)
    }
    if (path === 'tasks/local-1/resume' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      requests.push({ path, method: 'POST', body })
      const continuedFrom = control.snapshot
      control.items = control.items.filter(item => item.nodeId !== body.nodeId)
      control.revision++
      if (control.snapshot) control.snapshot = control.revision.toString(16).padStart(64, '0')
      const receipt = { ticketId: 'local-1', workflow: { revision: control.revision, autoRun: true,
        blockers: { snapshot: control.snapshot, continuedFrom, total: control.items.length,
          omitted: Math.max(0, control.items.length - 4), items: control.items.slice(0, 4) } } }
      return Response.json(fullReceipt && lastStatus
        ? { ...lastStatus, ...receipt, workflow: { ...lastStatus.workflow, ...receipt.workflow,
          progress: { ...lastStatus.workflow.progress, suspended: control.items.length } } } : receipt)
    }
    const response = await original(url, init)
    if (path !== 'tasks/local-1') return response
    const status = await response.json()
    lastStatus = { ...status, paused: control.paused,
      ended: control.ended ? { outcome: 'stopped', by: 'human', at: '2026-11-05T00:00:00Z' } : null,
      workflow: { ...status.workflow, revision: control.revision, autoRun: false,
        progress: { ...status.workflow.progress, total: 9, suspended: control.items.length },
        blockers: { snapshot: control.snapshot, total: control.items.length, omitted: Math.max(0, control.items.length - 4), items: control.items.slice(0, 4) },
        dependencyBlockers: { total: 0, omitted: 0, items: [] } } }
    return Response.json(lastStatus)
  }))
  return { control, requests, pages: () => requests.filter(request => request.path.startsWith('tasks/local-1/blockers?')) }
}

const moreSteps = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('更多步骤'))!

it('完整恢复回执保留展开位置并支持连续操作，使用新版本且不额外读取任务详情', async () => {
  const run = pagedBlockers(true, true), { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    for (const number of [8, 7]) {
      await act(async () => { view.container.querySelector<HTMLButtonElement>(`[aria-label="恢复并继续任务：待核对步骤 ${number}"]`)!.click() })
      await flushPanel()
      expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(number - 1)
    }
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    expect(run.requests.filter(request => request.method === 'POST')).toEqual([
      { path: 'tasks/local-1/resume', method: 'POST', body: { revision: 3, nodeId: 'step_7' } },
      { path: 'tasks/local-1/resume', method: 'POST', body: { revision: 4, nodeId: 'step_6' } },
    ])
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(run.pages().at(-1)?.path).toBe(`tasks/local-1/blockers?revision=5&offset=6&snapshot=${run.control.snapshot}`)
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(7)
    expect(view.container.textContent).toContain('待核对步骤 9')
  } finally { view.dispose() }
})

it.each(['next', 'previous', 'more', 'blocked', 'progress'].flatMap(target =>
  [false, true].map(fullReceipt => ({ target, fullReceipt }))))(
  '键盘恢复后就近延续焦点，沿用既有读取路径；目标$target，完整回执$fullReceipt', async ({ target, fullReceipt }) => {
    const run = pagedBlockers(true, fullReceipt)
    if (target === 'more')
      run.control.items = run.control.items.map((item, index) => ({ ...item,
        resume: index === 7 ? 'available' : 'parent_suspended' }))
    if (target === 'blocked') run.control.items = [...run.control.items.slice(0, 4), run.control.items[7]!]
    if (target === 'progress') run.control.items = [run.control.items[7]!]
    const { main } = fixture([]), view = await render(main, { t })
    try {
      if (target !== 'progress') {
        await act(async () => { moreSteps(view.container).click() })
        await flushPanel()
      }
      const number = target === 'next' ? 7 : 8
      const trigger = view.container.querySelector<HTMLButtonElement>(`[aria-label="恢复并继续任务：待核对步骤 ${number}"]`)!
      trigger.focus()
      expect(document.activeElement).toBe(trigger)
      const reads = run.requests.filter(request => request.path === 'tasks/local-1').length, pages = run.pages().length
      await act(async () => { trigger.click() })
      await flushPanel()
      const expected = target === 'next' || target === 'previous'
        ? view.container.querySelector(`[aria-label="恢复并继续任务：待核对步骤 ${target === 'next' ? 8 : 7}"]`)
        : target === 'more' ? moreSteps(view.container)
          : view.container.querySelector(target === 'blocked' ? '.dt-task-blockers' : '.dt-task-progress')
      expect(expected).toBeTruthy()
      expect(document.activeElement).toBe(expected)
      if (target === 'blocked' || target === 'progress') {
        expect(expected!.getAttribute('tabindex')).toBe('-1')
        expect(expected!.getAttribute('aria-label')).toBe(zh[target === 'blocked' ? 'task.blockers' : 'task.progress'])
      }
      expect(trigger.isConnected).toBe(false)
      expect(run.requests.filter(request => request.method === 'POST')).toEqual([{
        path: 'tasks/local-1/resume', method: 'POST', body: { revision: 3, nodeId: `step_${number - 1}` },
      }])
      expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads + (fullReceipt ? 0 : 1))
      expect(run.pages()).toHaveLength(pages)
    } finally { view.dispose() }
  })

it.each(['input', 'unfocused', 'failure'] as const)('恢复期间%s时不把焦点移往其他步骤或改变补充草稿', async situation => {
  const run = pagedBlockers(true, true), original = vi.mocked(fetch).getMockImplementation()!
  const pending = Promise.withResolvers<void>()
  let writes = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/tasks/local-1/resume')) {
      writes++
      await pending.promise
      if (situation === 'failure') return Response.json({ error: '本次恢复未完成' }, { status: 503 })
    }
    return original(url, init)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
      .find(item => item.textContent?.includes(zh['task.addContext']))!
    await act(async () => { disclosure.click() })
    const input = view.container.querySelector<HTMLTextAreaElement>('.dt-task-context textarea')!
    await fillTaskGoal(view.container, '等待期间继续填写的补充')
    const trigger = view.container.querySelector<HTMLButtonElement>('[aria-label="恢复并继续任务：待核对步骤 7"]')!
    if (situation !== 'unfocused') trigger.focus()
    await act(async () => { trigger.click() })
    if (situation === 'input') input.focus()
    const focused = document.activeElement
    await act(async () => { pending.resolve() })
    await flushPanel()
    expect(document.activeElement).toBe(focused)
    expect(input.value).toBe('等待期间继续填写的补充')
    if (situation === 'failure') {
      expect(document.body.textContent).toContain(zh['task.controlUnconfirmed'])
      expect(trigger.isConnected).toBe(true)
    } else expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(writes).toBe(1)
  } finally { pending.resolve(); view.dispose() }
})

it.each(['loaded', 'inflight'] as const)('无关进度更新时%s分页保持有效且不额外读取，恢复仍使用最新执行版本', async timing => {
  const run = pagedBlockers(true), visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const pending = Promise.withResolvers<Response>()
  let initialPage: BlockerPageFixture | undefined
  if (timing === 'inflight') run.control.response = page => { initialPage = page; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(timing === 'loaded' ? 8 : 4)
    const first = new URL(run.pages()[0]!.path, 'http://127.0.0.1')
    expect(first.searchParams.get('snapshot')).toBe(run.control.snapshot)
    run.control.revision = 8
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    if (timing === 'inflight') {
      await act(async () => { pending.resolve(Response.json(initialPage)) })
      await flushPanel()
      run.control.response = undefined
    }
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(run.pages()).toHaveLength(1)
    expect(moreSteps(view.container).textContent).toContain('剩余 1 项')
    const resume = view.container.querySelector<HTMLButtonElement>('[aria-label="恢复并继续任务：待核对步骤 8"]')!
    await act(async () => { resume.click() })
    await flushPanel()
    expect(run.requests.filter(request => request.method === 'POST')).toEqual([
      { path: 'tasks/local-1/resume', method: 'POST', body: { revision: 8, nodeId: 'step_7' } },
    ])
    if (run.control.snapshot) {
      expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(7)
      expect(moreSteps(view.container).textContent).toContain('剩余 1 项')
      await act(async () => { moreSteps(view.container).click() })
      await flushPanel()
      expect(run.pages().at(-1)?.path).toBe(`tasks/local-1/blockers?revision=9&offset=7&snapshot=${run.control.snapshot}`)
      expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
      expect(view.container.textContent).toContain('待核对步骤 9')
    } else {
      expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
      expect(moreSteps(view.container).textContent).toContain('剩余 4 项')
    }
  } finally { pending.resolve(Response.json({}, { status: 500 })); view.dispose(); visible.mockRestore() }
})

it('挂起摘要不预取，按需展开防止重复请求，并能单独恢复首屏之外的步骤', async () => {
  const run = pagedBlockers(), first = Promise.withResolvers<Response>()
  let firstPage: BlockerPageFixture | undefined
  run.control.response = page => { firstPage = page; return first.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
    expect(view.container.textContent).not.toContain('待核对步骤 5')
    expect(moreSteps(view.container).textContent).toContain('剩余 5 项')
    expect(run.pages()).toHaveLength(0)
    await act(async () => { moreSteps(view.container).click(); moreSteps(view.container).click() })
    expect(run.pages().map(request => request.path)).toEqual(['tasks/local-1/blockers?revision=3&offset=4'])
    expect(moreSteps(view.container).disabled).toBe(true)
    run.control.response = undefined
    await act(async () => { first.resolve(Response.json(firstPage)) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(moreSteps(view.container).textContent).toContain('剩余 1 项')
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(9)
    expect(moreSteps(view.container)).toBeUndefined()
    expect(run.pages().map(request => request.path)).toEqual([
      'tasks/local-1/blockers?revision=3&offset=4', 'tasks/local-1/blockers?revision=3&offset=8',
    ])
    const resume = view.container.querySelector<HTMLButtonElement>('[aria-label="恢复并继续任务：待核对步骤 9"]')!
    await act(async () => { resume.click() })
    await flushPanel()
    expect(run.requests.filter(request => request.method === 'POST')).toEqual([
      { path: 'tasks/local-1/resume', method: 'POST', body: { revision: 3, nodeId: 'step_8' } },
    ])
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
    expect(moreSteps(view.container).textContent).toContain('剩余 4 项')
  } finally { first.resolve(Response.json({}, { status: 500 })); view.dispose() }
})

it('翻页失败保留已读步骤与游标，计划冲突则丢弃扩展页并重新读取，不自动重试', async () => {
  const run = pagedBlockers(), { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    run.control.response = () => Response.json({ error: '读取暂时失败' }, { status: 503 })
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(document.body.textContent).toContain('读取暂时失败')
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(moreSteps(view.container).disabled).toBe(false)
    run.control.revision = 7
    run.control.items = run.control.items.slice(1)
    run.control.response = () => Response.json({ error: '计划已更新，请重新读取后查看挂起步骤' }, { status: 409 })
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(document.body.textContent).toContain('计划已更新，请重新读取后查看挂起步骤')
    expect(run.pages().map(request => request.path)).toEqual([
      'tasks/local-1/blockers?revision=3&offset=4',
      'tasks/local-1/blockers?revision=3&offset=8',
      'tasks/local-1/blockers?revision=3&offset=8',
    ])
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
    expect(view.container.textContent).not.toContain('待核对步骤 1')
    expect(view.container.textContent).not.toContain('待核对步骤 6')
    expect(run.requests.filter(request => request.path === 'tasks/local-1').length).toBeGreaterThan(1)
    run.control.response = undefined
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(run.pages().at(-1)?.path).toBe('tasks/local-1/blockers?revision=7&offset=4')
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each([false, true])('轮询先读到新版本时，晚到的旧分页不拼入新计划，也不沿用旧游标；快照支持=%s', async withSnapshot => {
  const run = pagedBlockers(withSnapshot), pending = Promise.withResolvers<Response>()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let oldPage: BlockerPageFixture | undefined
  run.control.response = page => { oldPage = page; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    run.control.revision = 11
    if (withSnapshot) run.control.snapshot = 'b'.repeat(64)
    run.control.items = run.control.items.map(item => ({ ...item, title: `新计划 ${item.title}` }))
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.textContent).toContain('新计划 待核对步骤 1')
    await act(async () => { pending.resolve(Response.json(oldPage)) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
    expect(view.container.textContent).not.toContain('待核对步骤 5')
    run.control.response = undefined
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(run.pages().at(-1)?.path).toBe(`tasks/local-1/blockers?revision=11&offset=4${withSnapshot ? `&snapshot=${run.control.snapshot}` : ''}`)
    expect(view.container.textContent).toContain('新计划 待核对步骤 5')
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { pending.resolve(Response.json({}, { status: 500 })); view.dispose(); visible.mockRestore() }
})

it('首屏未变化但后页内容改变时，按新快照清除旧扩展页', async () => {
  const run = pagedBlockers(true), visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('待核对步骤 8')
    run.control.items[7]!.title = '第八步已重新规划'
    run.control.snapshot = 'c'.repeat(64)
    run.control.revision = 12
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
    expect(run.pages()).toHaveLength(1)
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('第八步已重新规划')
    expect(view.container.textContent).not.toContain('待核对步骤 8')
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose(); visible.mockRestore() }
})

it.each(['missing', 'unrelated', 'changed'] as const)('恢复回执的延续证明为%s时不把旧扩展页标为新快照', async proof => {
  const run = pagedBlockers(true), original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!url.endsWith('/tasks/local-1/resume')) return response
    const status = await response.json()
    if (proof === 'unrelated') status.workflow.blockers.continuedFrom = 'c'.repeat(64)
    else delete status.workflow.blockers.continuedFrom
    if (proof === 'changed') {
      run.control.items[6] = { ...run.control.items[6]!, resume: 'manual_running', reason: '其他步骤正在手动执行' }
      run.control.snapshot = 'd'.repeat(64)
      status.workflow.blockers.snapshot = run.control.snapshot
    }
    return Response.json(status)
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="恢复并继续任务：待核对步骤 8"]')!.click() })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
    expect(view.container.textContent).not.toContain('待核对步骤 7')
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(run.pages().at(-1)?.path).toBe(`tasks/local-1/blockers?revision=4&offset=4&snapshot=${run.control.snapshot}`)
    const seventh = [...view.container.querySelectorAll('.dt-task-blockers > li')].find(row => row.textContent?.includes('待核对步骤 7'))!
    expect(seventh).toBeDefined()
    if (proof === 'changed') {
      expect(seventh.textContent).toContain('其他步骤正在手动执行')
      expect(seventh.querySelector('button')).toBeNull()
    }
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  } finally { view.dispose() }
})

it.each([200, 409, 503])('恢复后忽略旧分页的%s响应，保留已证明有效的已读步骤和新游标', async status => {
  const run = pagedBlockers(true), pending = Promise.withResolvers<Response>()
  const { main } = fixture([]), view = await render(main, { t })
  let oldPage: BlockerPageFixture | undefined
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    run.control.response = page => { oldPage = page; return pending.promise }
    await act(async () => { moreSteps(view.container).click() })
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="恢复并继续任务：待核对步骤 8"]')!.click() })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(7)
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    await act(async () => { pending.resolve(Response.json(status === 200 ? oldPage : { error: '旧分页已经失效' }, { status })) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(7)
    expect(document.body.textContent).not.toContain('旧分页已经失效')
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    run.control.response = undefined
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(run.pages().at(-1)?.path).toBe(`tasks/local-1/blockers?revision=4&offset=7&snapshot=${run.control.snapshot}`)
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

it.each([200, 409])('恢复回执已到但状态重读未完成时，旧分页的%s响应也不能破坏延续页', async status => {
  const run = pagedBlockers(true), pendingPage = Promise.withResolvers<Response>(), pendingRead = Promise.withResolvers<Response>()
  const original = vi.mocked(fetch).getMockImplementation()!
  let delayRead = false, nextRead: Response | undefined, oldPage: BlockerPageFixture | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (delayRead && url.endsWith('/tasks/local-1')) {
      delayRead = false; nextRead = response
      return pendingRead.promise
    }
    return response
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    run.control.response = page => { oldPage = page; return pendingPage.promise }
    await act(async () => { moreSteps(view.container).click() })
    delayRead = true
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="恢复并继续任务：待核对步骤 8"]')!.click() })
    await flushPanel()
    expect(nextRead).toBeDefined()
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    await act(async () => { pendingPage.resolve(Response.json(status === 200 ? oldPage : { error: '恢复前的旧分页冲突' }, { status })) })
    await flushPanel()
    expect(document.body.textContent).not.toContain('恢复前的旧分页冲突')
    await act(async () => { pendingRead.resolve(nextRead!) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(7)
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    run.control.response = undefined
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(run.pages().at(-1)?.path).toBe(`tasks/local-1/blockers?revision=4&offset=7&snapshot=${run.control.snapshot}`)
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  } finally { pendingPage.resolve(Response.json({})); pendingRead.resolve(Response.json({})); view.dispose() }
})

it.each([200, 409, 503])('挂起快照 A/B/A 后忽略第一次 A 的%s分页响应', async status => {
  const run = pagedBlockers(true), pending = Promise.withResolvers<Response>()
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let oldPage: BlockerPageFixture | undefined
  run.control.response = page => { oldPage = page; return pending.promise }
  const { main } = fixture([]), view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    for (const snapshot of ['b', 'a']) {
      run.control.snapshot = snapshot.repeat(64)
      run.control.revision++
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await flushPanel()
    }
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    await act(async () => { pending.resolve(Response.json(status === 200 ? oldPage : { error: '旧访问分页已失效' }, { status })) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(4)
    expect(document.body.textContent).not.toContain('旧访问分页已失效')
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    run.control.response = undefined
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(run.pages().at(-1)?.path).toBe(`tasks/local-1/blockers?revision=5&offset=4&snapshot=${run.control.snapshot}`)
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose(); visible.mockRestore() }
})

it.each([409, 503])('离开任务再打开后旧分页的%s错误不清除新页、不弹提示或重读旧任务', async status => {
  const run = pagedBlockers(true), pending = Promise.withResolvers<Response>()
  run.control.response = () => pending.promise
  const { main } = fixture([])
  let view = await render(main, { t })
  try {
    await act(async () => { moreSteps(view.container).click() })
    view.dispose()
    run.control.response = undefined
    view = await render(main, { t })
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    const reads = run.requests.filter(request => request.path === 'tasks/local-1').length
    await act(async () => { pending.resolve(Response.json({ error: '离页前的旧分页错误' }, { status })) })
    await flushPanel()
    expect(view.container.querySelectorAll('.dt-task-blockers > li')).toHaveLength(8)
    expect(document.body.textContent).not.toContain('离页前的旧分页错误')
    expect(run.requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(reads)
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { pending.resolve(Response.json({})); view.dispose() }
})

it.each(['paused', 'ended'] as const)('%s 任务仍能按需阅读后续挂起步骤，但不能执行恢复', async situation => {
  const run = pagedBlockers()
  run.control[situation] = true
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(moreSteps(view.container).disabled).toBe(false)
    await act(async () => { moreSteps(view.container).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('待核对步骤 8')
    const resumes = [...view.container.querySelectorAll('button')].filter(button => button.textContent === zh['task.resume'])
    if (situation === 'ended') expect(resumes).toHaveLength(0)
    else {
      expect(resumes).toHaveLength(4)
      expect(resumes.every(button => button.disabled)).toBe(true)
      resumes.forEach(button => button.click())
    }
    expect([...view.container.querySelectorAll('button')].some(button => button.textContent === zh['task.stop']))
      .toBe(situation !== 'ended')
    expect(run.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each([
  ['running', 'task.running'],
  ['paused', 'task.processingPaused'],
  ['held', 'task.held'],
  ['review', 'task.awaitingValidation'],
  ['attention', 'task.attention'],
  ['waiting', 'task.waiting'],
  ['legacy', 'task.openState'],
] as const)('任务详情按后端 %s 状态显示，不根据派发开关猜测执行中', async (activity, label) => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, activity: activity === 'legacy' ? undefined : activity,
      paused: activity === 'paused',
      workflow: { ...status.workflow, autoRun: activity !== 'held',
        awaitingValidation: activity === 'review',
        progress: { total: 2, running: activity === 'running' ? 1 : 0,
          pending: activity === 'review' ? 0 : 1, suspended: 0, completed: activity === 'review' ? 2 : 1, pruned: 0 },
        blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelector('.dt-tag')?.textContent).toBe(zh[label])
    if (activity === 'attention')
      expect([...view.container.querySelectorAll('button')].some(button => button.textContent === zh['task.openOrchestrator'])).toBe(true)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it.each([
  { count: 1, paused: false, ended: false, legacy: false },
  { count: 6, paused: false, ended: false, legacy: false },
  { count: 1, paused: true, ended: false, legacy: false },
  { count: 0, paused: false, ended: false, legacy: false },
  { count: 1, paused: false, ended: true, legacy: false },
  { count: 1, paused: false, ended: false, legacy: true },
])('进度区只展示已返回的当前步骤，不追加查询或操作；数量$count，暂停$paused，结束$ended，旧响应$legacy',
  async ({ count, paused, ended, legacy }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    const titles = ['核对授权资料中的交付时间', '<img src=x onerror=alert(1)>', 'CompareIndependentAuthorizedSourcesAcrossRegions',
      '复核另一个来源']
    const items = titles.slice(0, Math.min(count, 4)).map((title, index) => ({ nodeId: `internal_running_${index}`, title }))
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const response = await original(url, init)
      if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
      const status = await response.json()
      return Response.json({ ...status, paused, activity: ended ? 'ended' : count ? 'running' : 'waiting',
        ended: ended ? { outcome: 'stopped' } : null,
        workflow: { ...status.workflow, progress: { ...status.workflow.progress, total: count + 1, running: count },
          ...(legacy ? {} : { runningSteps: { total: count, omitted: Math.max(0, count - items.length), items } }) } })
    }))
    const { ctx, main } = fixture(['master']), view = await render(main, { t })
    try {
      const visible = !ended && !legacy && count > 0
      expect([...view.container.querySelectorAll('.dt-task-running .dt-row-title')].map(row => row.textContent))
        .toEqual(visible ? items.map(item => item.title) : [])
      expect(view.container.querySelector('.dt-task-running img')).toBeNull()
      expect(view.container.textContent).not.toContain('internal_running_')
      const hint = zh['task.omittedRunningSteps'].replace('{count}', String(Math.max(0, count - 4)))
      if (visible && count > 4) expect(view.container.textContent).toContain(hint)
      else expect(view.container.textContent).not.toContain(hint)
      expect(requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(1)
      expect(requests.every(request => request.method === 'GET')).toBe(true)
      expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    } finally { view.dispose() }
  })

it('步骤完成或挂起后由既有轮询移除旧标题，不残留上一执行快照或显示成下一步', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let phase = 0
  const titles = ['核对初始来源', '复核比较结果']
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, activity: phase < 2 ? 'running' : 'attention',
      workflow: { ...status.workflow, revision: 3 + phase,
        runningSteps: { total: phase < 2 ? 1 : 0, omitted: 0,
          items: phase < 2 ? [{ nodeId: `step_${phase}`, title: titles[phase] }] : [] } } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelector('.dt-task-running')?.textContent).toContain(titles[0])
    for (phase = 1; phase <= 2; phase++) {
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await flushPanel()
      expect(view.container.textContent).not.toContain(titles[0])
      if (phase === 1) expect(view.container.querySelector('.dt-task-running')?.textContent).toContain(titles[1])
      else expect(view.container.querySelector('.dt-task-running')).toBeNull()
    }
    expect(requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(3)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it('旧宿主任务列表缺少状态时只标明未结束，不逐条查询详情或猜测运行', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelector('.dt-row-meta')?.textContent).toContain(zh['task.openState'])
    expect(view.container.querySelector('.dt-list .dt-spinner')).toBeNull()
    expect(requests.some(request => request.path === 'tasks/local-1')).toBe(false)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  } finally { view.dispose() }
})

it('任务目录显示服务端状态，待回答及终态优先，刷新变化无需逐条读取或执行', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const activities = ['running', 'paused', 'held', 'review', 'attention', 'waiting', 'unknown'] as const
  let changed = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks')) return response
    const base = { createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', ended: null, needsAnswer: false }
    return Response.json({ items: [
      ...activities.map(activity => ({ ...base, ticketId: activity, title: `任务 ${activity}`,
        activity: changed && activity === 'running' ? 'held' : activity })),
      { ...base, ticketId: 'question', title: '需要确认范围', activity: 'running', needsAnswer: true },
      { ...base, ticketId: 'ended', title: '已经停止', activity: 'running', needsAnswer: true, ended: { outcome: 'stopped' } },
    ], nextBefore: null })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    const labels = () => [...view.container.querySelectorAll('.dt-list > li .dt-row-meta > span:first-child')]
      .map(item => item.textContent)
    expect(labels()).toEqual([
      zh['task.running'], zh['task.processingPaused'], zh['task.held'], zh['task.awaitingValidation'],
      zh['task.attention'], zh['task.waiting'], zh['task.statusUnknown'], zh['task.question'], zh['outcome.stopped'],
    ])
    changed = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(labels()[0]).toBe(zh['task.held'])
    expect(requests.some(request => /^tasks\//.test(request.path))).toBe(false)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it('目录用已知只读原因说明需要处理，未知、待回答和结束状态不显示错误的处理原因', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const reasons = [
    ['reference_invalid', '成果依据已失效'],
    ['dependency_blocked', '前置步骤不可用'],
    ['suspended', '有步骤挂起'],
    ['plan_review', '计划需要核对'],
  ] as const
  let cleared = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks')) return response
    const base = { createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z', ended: null, needsAnswer: false }
    return Response.json({ items: [
      ...reasons.map(([reason]) => ({ ...base, ticketId: reason, title: `核对 ${reason}`, activity: 'attention',
        ...(cleared ? {} : { attentionReason: reason }) })),
      { ...base, ticketId: 'unknown', title: '未知原因', activity: 'attention', attentionReason: '<img src=x onerror=alert(1)>' },
      { ...base, ticketId: 'question', title: '回答当前问题', activity: 'attention', needsAnswer: true, attentionReason: 'suspended' },
      { ...base, ticketId: 'ended', title: '历史任务', activity: 'ended', ended: { outcome: 'stopped' }, attentionReason: 'plan_review' },
      { ...base, ticketId: 'running', title: '仍在执行', activity: 'running', attentionReason: 'dependency_blocked' },
    ], nextBefore: null })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    const rows = () => [...view.container.querySelectorAll('.dt-list > li')]
    expect(rows().slice(0, 4).map(row => row.querySelector('.dt-row-meta')?.textContent)).toEqual(reasons.map(([, label]) => expect.stringContaining(label)))
    expect(rows().slice(0, 4).every(row => row.querySelector('.dt-row-meta')?.textContent?.includes(zh['task.attention']))).toBe(true)
    expect(rows()[4]!.textContent).not.toContain('onerror')
    expect(rows()[5]!.querySelector('.dt-row-meta')?.textContent).toContain(zh['task.question'])
    expect(rows()[5]!.querySelector('.dt-row-meta')?.textContent).not.toContain('有步骤挂起')
    expect(rows()[6]!.querySelector('.dt-row-meta')?.textContent).not.toContain('计划需要核对')
    expect(rows()[7]!.querySelector('.dt-row-meta')?.textContent).not.toContain('前置步骤不可用')
    cleared = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    for (const [, label] of reasons) expect(view.container.textContent).not.toContain(label)
    expect(view.container.querySelector('img')).toBeNull()
    expect(requests.some(request => request.path.startsWith('tasks/'))).toBe(false)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  } finally { view.dispose() }
})

it('任务目录就近显示待送达补充信息，不改变执行状态或触发详情读取', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  let pendingDelivery = 2, ended = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!new URL(url, 'http://127.0.0.1').pathname.endsWith('/tasks')) return response
    const status = await response.json()
    return Response.json({ ...status, items: [
      { ticketId: 'pending', title: '等待总管处理', createdAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:00Z', needsAnswer: false, pendingDelivery,
        ended: ended ? { outcome: 'stopped' } : null, activity: 'running' },
    ] })
  }))
  const { ctx, main } = fixture(['master']), view = await render(main, { t })
  try {
    expect(view.container.textContent).toContain('等待总管处理')
    expect(view.container.textContent).toContain(zh['task.running'])
    expect(view.container.textContent).toContain(zh['task.inputCount'].replace('{count}', '2'))
    expect(requests.filter(request => request.method === 'GET' && request.path.startsWith('tasks?')).length).toBe(1)
    pendingDelivery = 0
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.textContent).not.toContain(zh['task.inputCount'].replace('{count}', '2'))
    expect(view.container.textContent).not.toContain(zh['task.inputCount'].replace('{count}', '0'))
    pendingDelivery = 2; ended = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.textContent).toContain(zh['outcome.stopped'])
    expect(view.container.textContent).not.toContain(zh['task.inputCount'].replace('{count}', '2'))
    expect(requests.some(request => request.path === 'tasks/pending')).toBe(false)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  } finally { view.dispose() }
})

it('任务列表直接标记待回答，筛选和翻页不查询逐条详情，清空筛选时不遗留旧页', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    const address = new URL(url, 'http://127.0.0.1')
    if (!address.pathname.endsWith('/tasks')) return response
    const row = (ticketId: string, title: string, needsAnswer: boolean) => ({
      ticketId, title, needsAnswer, ended: null,
      createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
    })
    const filtered = address.searchParams.get('state') === 'needs_answer'
    return Response.json(filtered ? address.searchParams.has('before')
      ? { items: [row('older-question', '较早的待回答任务', true)], nextBefore: null }
      : { items: [row('local-1', '需要确认比较范围', true)], nextBefore: 'local-1' }
      : { items: [row('normal', '继续整理资料', false), row('local-1', '需要确认比较范围', true)], nextBefore: null })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const button = (text: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === text || item.getAttribute('aria-label') === text)!
  try {
    const rows = [...view.container.querySelectorAll('.dt-list > li')]
    expect(rows.map(row => row.querySelector('.dt-row-meta')?.textContent))
      .toEqual([expect.stringContaining(zh['task.openState']), expect.stringContaining(zh['task.question'])])
    expect(view.container.querySelector('.dt-list .dt-spinner')).toBeNull()
    await act(async () => { button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    expect(view.container.textContent).not.toContain('继续整理资料')
    expect(view.container.textContent).toContain('需要确认比较范围')
    await act(async () => { button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(view.container.textContent).toContain('较早的待回答任务')
    expect(view.container.textContent).not.toContain('需要确认比较范围')
    expect(button(zh['task.nextPage']).disabled).toBe(true)
    expect(button(zh['task.previousPage']).disabled).toBe(false)
    await act(async () => { button(zh['task.filter.open']).click() })
    await flushPanel()
    expect(view.container.textContent).not.toContain('较早的待回答任务')
    expect(view.container.textContent).toContain('继续整理资料')
    expect(requests.filter(request => /^tasks\//.test(request.path))).toHaveLength(0)
    expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0)
    await act(async () => { button('需要确认比较范围').click() })
    await flushPanel()
    expect(requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(1)
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route).toEqual({ page: 'tasks', id: 'local-1' })
  } finally { view.dispose() }
})

it('待回答目录只在该范围请求节选，安全显示有界问题且仍由详情页核对回答', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const queries: URLSearchParams[] = []
  let answered = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    const address = new URL(url, 'http://127.0.0.1')
    if (!address.pathname.endsWith('/tasks')) return response
    queries.push(address.searchParams)
    expect(new Headers(init?.headers).get('x-orchestrator-task-view')).toBe('questions')
    const row = { ticketId: 'local-1', title: '需要判断范围的任务', createdAt: '2026-11-07T00:00:00Z',
      updatedAt: '2026-11-07T00:00:00Z', needsAnswer: !answered, ended: null, activity: 'attention',
      ...(address.searchParams.get('state') === 'needs_answer'
        ? { questionPreview: { text: '<img src=x>先核对哪份材料？', truncated: true } } : {}) }
    return Response.json({ items: [row], nextBefore: null })
  }))
  const { main, ctx } = fixture([]), view = await render(main, { t })
  const button = (name: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent === name)!
  try {
    expect(queries[0]!.has('preview')).toBe(false)
    expect(view.container.querySelector('.dt-task-question-preview')).toBeNull()
    await act(async () => { button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    expect(queries.at(-1)!.get('state')).toBe('needs_answer')
    expect(queries.at(-1)!.has('preview')).toBe(false)
    const preview = view.container.querySelector('.dt-task-question-preview')!
    expect(preview.textContent).toContain('<img src=x>先核对哪份材料？')
    expect(preview.textContent).toContain(zh['task.questionExcerpt'])
    expect(view.container.querySelector('img')).toBeNull()
    expect(button('需要判断范围的任务').getAttribute('aria-describedby')).toBe(preview.id)
    expect(requests.some(request => request.path.startsWith('tasks/'))).toBe(false)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
    // 即使旧服务继续附带节选，也不能将已回答问题显示成当前问题。
    answered = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector('.dt-task-question-preview')).toBeNull()
    await act(async () => { button(zh['task.filter.open']).click() })
    await flushPanel()
    expect(queries.at(-1)!.has('preview')).toBe(false)
    await act(async () => { button('需要判断范围的任务').click() })
    await flushPanel()
    expect(requests.filter(request => request.path === 'tasks/local-1')).toHaveLength(1)
  } finally { view.dispose() }
})

it('待回答列表为空时明确显示空状态，旧列表没有标记时仍正常显示未结束', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1')
    const response = await original(url, init)
    return address.pathname.endsWith('/tasks') && address.searchParams.get('state') === 'needs_answer'
      ? Response.json({ items: [], nextBefore: null }) : response
  }))
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelector('.dt-row-meta')?.textContent).toContain(zh['task.openState'])
    const filter = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === zh['task.filter.needs_answer'])!
    await act(async () => { filter.click() })
    await flushPanel()
    expect(view.container.textContent).toContain(zh['task.noQuestions'])
    expect(view.container.querySelectorAll('.dt-list > li')).toHaveLength(0)
  } finally { view.dispose() }
})

it('从待回答列表处理任务后返回保留筛选并读最新状态，重新挂载也恢复该范围', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: { page: 'tasks' }, stack: [{ page: 'overview' }],
  }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const lists: string[] = []
  let answered = false, writes = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1')
    const response = await original(url, init)
    if (address.pathname.endsWith('/inputs')) { writes++; answered = true }
    if (address.pathname.endsWith('/tasks')) {
      const filter = address.searchParams.get('state')!
      lists.push(filter)
      return Response.json({ items: filter === 'needs_answer' && answered ? [] : [{
        ticketId: 'local-1', title: '确认本轮资料范围', needsAnswer: !answered, ended: null,
        createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
      }], nextBefore: null })
    }
    if (!address.pathname.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, question: answered ? null : { id: 'return-question', text: '优先核对哪份资料？' } })
  }))
  const { ctx, main } = fixture(['master'])
  let view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!
  try {
    await act(async () => { button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    const scope = { page: 'tasks', query: { filter: 'needs_answer' } }
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!))
      .toMatchObject({ route: scope, stack: [{ page: 'overview' }] })
    await act(async () => { button('确认本轮资料范围').click() })
    await flushPanel()
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!))
      .toMatchObject({ route: { page: 'tasks', id: 'local-1' }, stack: [{ page: 'overview' }, scope] })
    const textarea = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '资料 B')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button(zh['task.sendAnswer']).click() })
    await flushPanel()
    expect(writes).toBe(1)
    const beforeReturn = lists.length
    const back = view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!
    await act(async () => { back.click() })
    await flushPanel()
    expect(lists.slice(beforeReturn)).toEqual(['needs_answer'])
    expect(view.container.textContent).toContain(zh['task.noQuestions'])
    expect(view.container.querySelectorAll('.dt-list > li')).toHaveLength(0)
    expect(button(zh['task.filter.needs_answer']).getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!))
      .toMatchObject({ route: scope, stack: [{ page: 'overview' }] })
    view.dispose()
    const beforeReload = lists.length
    view = await render(main, { t })
    expect(lists.slice(beforeReload)).toEqual(['needs_answer'])
    expect(view.container.textContent).toContain(zh['task.noQuestions'])
    expect(writes).toBe(1)
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  } finally { view.dispose() }
})

it('列表 A/B/A 切换拒绝旧分页和错范围首屏，导航替换筛选而不丢新建草稿', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string; body?: unknown }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  const pendingMore = Promise.withResolvers<Response>(), pendingQuestions = Promise.withResolvers<Response>()
  const row = (ticketId: string, title: string, needsAnswer: boolean) => ({
    ticketId, title, needsAnswer, ended: null,
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    const address = new URL(url, 'http://127.0.0.1')
    if (!address.pathname.endsWith('/tasks')) return response
    if (address.searchParams.has('before')) return pendingMore.promise
    return address.searchParams.get('state') === 'needs_answer' ? pendingQuestions.promise
      : Response.json({ items: [row('normal', '继续整理资料', false)], nextBefore: 'normal' })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const button = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label || item.getAttribute('aria-label') === label)!
  try {
    const goal = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, '尚未提交的目标草稿')
      goal.dispatchEvent(new Event('input', { bubbles: true }))
      button(zh['task.nextPage']).click()
    })
    await act(async () => { button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')).toBeNull()
    expect(button(zh['task.nextPage'])).toBeUndefined()
    expect(view.container.querySelector('textarea')?.value).toBe('尚未提交的目标草稿')
    await act(async () => { button(zh['task.filter.open']).click() })
    await flushPanel()
    await act(async () => {
      pendingQuestions.resolve(Response.json({ items: [row('question', '旧范围的待回答任务', true)], nextBefore: null }))
      pendingMore.resolve(Response.json({ items: [row('stale-page', '旧访问的后续任务', false)], nextBefore: 'stale-page' }))
    })
    await flushPanel()
    expect(view.container.textContent).toContain('继续整理资料')
    expect(view.container.textContent).not.toContain('旧范围的待回答任务')
    expect(view.container.textContent).not.toContain('旧访问的后续任务')
    expect(view.container.querySelector('textarea')?.value).toBe('尚未提交的目标草稿')
    expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!)).toMatchObject({
      route: { page: 'tasks', query: { filter: 'open' } }, stack: [],
    })
    expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0)
    expect(requests.filter(request => /^tasks\//.test(request.path))).toHaveLength(0)
  } finally {
    pendingMore.resolve(Response.json({ items: [], nextBefore: null }))
    pendingQuestions.resolve(Response.json({ items: [], nextBefore: null }))
    view.dispose()
  }
})

function directoryRow(ticketId: string, activity: 'running' | 'held' = 'running', needsAnswer = false) {
  return { ticketId, title: `任务 ${ticketId}`, activity, needsAnswer, ended: null,
    createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z' }
}

async function taskDirectory(respond: (query: URLSearchParams, headers: Headers) => Response | Promise<Response>) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  const requests: { path: string; method: string }[] = []
  serve('hmm', requests)
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    const address = new URL(url, 'http://127.0.0.1')
    return address.pathname.endsWith('/tasks') ? respond(address.searchParams, new Headers(init?.headers)) : response
  }))
  const { main } = fixture([]), view = await render(main, { t })
  return { ...view, main, requests,
    reads: () => requests.filter(request => request.path.startsWith('tasks?')).map(request =>
      new URL(request.path, 'http://127.0.0.1').searchParams.get('before')),
    button: (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === label || button.textContent === label)!,
  }
}

// 冻结旧接口的选择契约，不能从现行 schema 删除字段后冒充历史兼容性。
const legacyTaskQuery = z.object({
  state: z.enum(['open', 'needs_answer', 'ended', 'all']).default('open'),
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(100).optional(),
}).strict()

it.each([false, true])('严格旧目录接口仍可搜索、翻页和切换筛选，支持节选=%s', async previewSupported => {
  const schema = previewSupported ? legacyTaskQuery.extend({ preview: z.literal('question').optional() }) : legacyTaskQuery
  const queries: Record<string, string>[] = []
  const view = await taskDirectory(query => {
    const input = Object.fromEntries(query)
    queries.push(input)
    const parsed = schema.safeParse(input)
    if (!parsed.success) return Response.json({ error: 'Invalid settings',
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }, { status: 400 })
    return Response.json({ items: [directoryRow(parsed.data.before ? 'older' : 'first')],
      nextBefore: parsed.data.before ? null : 'scope/older+1' })
  })
  try {
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
    expect(queries).toHaveLength(1)
    await fillTaskGoal(view.container, '保留未提交目标')
    const q = 'module %_\\ review'
    await searchTasks(view.container, q)
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(queries.at(-1)).toEqual({ state: 'open', q, before: 'scope/older+1', limit: '50' })
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 older')
    for (const state of ['needs_answer', 'ended', 'all', 'open'] as const) {
      const count = queries.length
      await act(async () => { view.button(zh[`task.filter.${state}`]).click() })
      await flushPanel()
      expect(queries).toHaveLength(count + 1)
      expect(queries.at(-1)).toEqual({ state, q, limit: '50' })
      expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
    }
    expect(view.container.querySelector('textarea')!.value).toBe('保留未提交目标')
    expect(view.button(zh['task.filter.needs_answer']).querySelector('[role="img"]')).toBeNull()
    expect(view.requests.every(request => request.method === 'GET' && !request.path.startsWith('tasks/'))).toBe(true)
  } finally { view.dispose() }
})

it('宿主升级与回退只改变可选目录展示，每次读取一次且保留范围和草稿', async () => {
  let enhanced = false
  const view = await taskDirectory((query, headers) => {
    const parsed = legacyTaskQuery.safeParse(Object.fromEntries(query))
    if (!parsed.success) return Response.json({ error: 'Invalid settings' }, { status: 400 })
    const hints = enhanced && headers.get('x-orchestrator-task-view') === 'questions'
    return Response.json({ items: [{ ...directoryRow(query.has('before') ? 'older' : 'first', 'running', true),
      ...(hints && query.get('state') === 'needs_answer' ? { questionPreview: { text: '当前范围是否正确？', truncated: false } } : {}) }],
      nextBefore: query.has('before') ? null : 'older', ...(hints ? { hasQuestions: true } : {}) })
  })
  try {
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
    await fillTaskGoal(view.container, '保留目标草稿')
    await searchTasks(view.container, 'scope')
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    for (const supported of [true, false, true]) {
      enhanced = supported
      const count = view.reads().length
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await flushPanel()
      expect(view.reads()).toHaveLength(count + 1)
      expect(view.reads().at(-1)).toBe('older')
      expect(!!view.button(zh['task.filter.needs_answer']).querySelector('[role="img"]')).toBe(supported)
    }
    await act(async () => { view.button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-task-question-preview')?.textContent).toBe('当前范围是否正确？')
    enhanced = false
    const count = view.reads().length
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.reads()).toHaveLength(count + 1)
    expect(view.container.querySelector('.dt-task-question-preview')).toBeNull()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
    expect(view.container.querySelector('textarea')!.value).toBe('保留目标草稿')
    expect(view.requests.every(request => request.method === 'GET' && !request.path.startsWith('tasks/'))).toBe(true)
  } finally { view.dispose() }
})

it.each([400, 403, 404, 503])('目录%s错误不降级或重试扩大范围，原读取恢复后才恢复提示', async status => {
  let failed = false
  const view = await taskDirectory(() => failed ? Response.json({ error: '目录暂时不可读取' }, { status })
    : Response.json({ items: [directoryRow('first')], nextBefore: null, hasQuestions: true }))
  const marker = () => view.button(zh['task.filter.needs_answer']).querySelector('[role="img"]')
  try {
    expect(marker()).toBeTruthy()
    await searchTasks(view.container, 'scope')
    failed = true
    const count = view.reads().length
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.reads()).toHaveLength(count + 1)
    expect(view.container.textContent).toContain('目录暂时不可读取')
    expect(view.container.textContent).toContain(zh['task.staleStatus'])
    expect(marker()).toBeNull()
    failed = false
    await act(async () => { view.button(zh['task.reload']).click() })
    await flushPanel()
    expect(view.reads()).toHaveLength(count + 2)
    expect(view.requests.filter(request => request.path.startsWith('tasks?')).slice(-2)
      .map(request => Object.fromEntries(new URL(request.path, 'http://127.0.0.1').searchParams)))
      .toEqual([{ state: 'open', q: 'scope', limit: '50' }, { state: 'open', q: 'scope', limit: '50' }])
    expect(marker()).toBeTruthy()
    expect(view.container.textContent).not.toContain('目录暂时不可读取')
  } finally { view.dispose() }
})

it('较早页出现待答状态时只更新既有筛选标记，不跳页或读取详情，点击后接续筛选焦点', async () => {
  let available = false, failed = false
  const queries: URLSearchParams[] = []
  const view = await taskDirectory(query => {
    queries.push(query)
    return failed ? Response.json({ error: '目录读取失败' }, { status: 503 }) : Response.json({
      items: [directoryRow(query.has('before') ? 'older' : 'newer')],
      nextBefore: query.has('before') ? null : 'older-page', hasQuestions: available,
    })
  })
  const marker = () => view.button(zh['task.filter.needs_answer']).querySelector('[role="img"]')
  try {
    expect(marker()).toBeNull()
    await fillTaskGoal(view.container, '保留正在填写的目标')
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 older')
    available = true
    const before = view.reads().length
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.reads().length).toBe(before + 1)
    expect(view.reads().at(-1)).toBe('older-page')
    expect(marker()?.getAttribute('aria-label')).toBe(zh['task.questionsAvailable'])
    expect(view.container.querySelector('textarea')!.value).toBe('保留正在填写的目标')
    expect(view.requests.some(request => request.path.startsWith('tasks/'))).toBe(false)
    failed = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(marker()).toBeNull()
    failed = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(marker()).toBeTruthy()
    await act(async () => { view.button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    expect(queries.at(-1)!.get('state')).toBe('needs_answer')
    expect(queries.at(-1)!.has('before')).toBe(false)
    expect(queries.at(-1)!.has('attention')).toBe(false)
    expect(document.activeElement).toBe(view.button(zh['task.filter.needs_answer']))
    expect(marker()).toBeNull()
    expect(view.requests.every(request => request.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it('待答提示遵守当前搜索范围，旧范围迟到结果及旧宿主缺字段不制造标记', async () => {
  const delayed = Promise.withResolvers<Response>()
  const view = await taskDirectory(query => query.get('q') === 'old' ? delayed.promise : Response.json({
    items: [directoryRow(query.get('q') || 'first')], nextBefore: null,
    ...(query.get('q') === 'new' ? { hasQuestions: true } : {}),
  }))
  try {
    expect(view.button(zh['task.filter.needs_answer']).querySelector('[role="img"]')).toBeNull()
    await searchTasks(view.container, 'old')
    await searchTasks(view.container, 'new')
    const button = view.button(zh['task.filter.needs_answer'])
    expect(button.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(zh['task.questionsInSearch'])
    await act(async () => { delayed.resolve(Response.json({ items: [], nextBefore: null, hasQuestions: false })) })
    await flushPanel()
    expect(button.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(zh['task.questionsInSearch'])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 new')
    expect(view.requests.every(request => request.method === 'GET')).toBe(true)
  } finally { delayed.resolve(Response.json({ items: [], nextBefore: null })); view.dispose() }
})

async function searchTasks(container: HTMLElement, text: string, submit = true) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${zh['task.search']}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (submit) {
    await act(async () => { container.querySelector<HTMLFormElement>('.dt-task-search')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flushPanel()
  }
  return input
}

it.each(['hmm', 'repository'] as const)('%s模式只展示对应范围的搜索入口，不增加目录或正文读取', async mode => {
  const requests: { path: string; method: string }[] = []
  serve(mode, requests)
  const { main } = fixture([]), view = await render(main, { t })
  try {
    expect(view.container.querySelectorAll('form[role="search"]')).toHaveLength(1)
    const taskSearch = view.container.querySelector('.dt-task-search')
    const repositorySearch = view.container.querySelector('header .dt-search')
    expect(!!taskSearch).toBe(mode === 'hmm')
    expect(!!repositorySearch).toBe(mode === 'repository')
    expect(view.container.querySelector('header input[aria-label="搜索"]')).toBe(mode === 'hmm'
      ? null : repositorySearch?.querySelector('input'))
    expect(requests.filter(request => request.path.startsWith('search?'))).toEqual([])
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it('任务名称搜索只在提交时读取，提交回到第一页并保留新建草稿，清除后恢复原目录', async () => {
  const searches: string[] = []
  const view = await taskDirectory(query => {
    searches.push(query.get('q') ?? '')
    return query.has('q')
      ? Response.json({ items: [directoryRow('matched')], nextBefore: null })
      : Response.json({ items: [directoryRow('first')], nextBefore: 'first' })
  })
  try {
    await fillTaskGoal(view.container, '搜索期间保留的任务目标')
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(view.reads()).toEqual([null, 'first'])
    const input = await searchTasks(view.container, 'matched', false)
    await flushPanel()
    expect(searches).toEqual(['', ''])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
    await act(async () => { view.button(zh['task.search']).click() })
    await flushPanel()
    expect(searches).toEqual(['', '', 'matched'])
    expect(view.reads()).toEqual([null, 'first', null])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 matched')
    expect(view.container.querySelector('.dt-list')?.textContent).not.toContain('任务 first')
    expect(view.container.querySelector('textarea')?.value).toBe('搜索期间保留的任务目标')
    expect(view.button(zh['task.nextPage'])).toBeUndefined()
    const clear = view.button(zh['task.searchClear'])
    await act(async () => { clear.click() })
    await flushPanel()
    expect(searches).toEqual(['', '', 'matched', ''])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(view.container.querySelector('textarea')?.value).toBe('搜索期间保留的任务目标')
  } finally { view.dispose() }
})

it('任务搜索按回车提交，筛选切换保留关键词并从第一页读取，未提交的新词不影响当前结果', async () => {
  const queries: [string, string][] = []
  const view = await taskDirectory(query => {
    queries.push([query.get('state') ?? '', query.get('q') ?? ''])
    const q = query.get('q')
    return Response.json({ items: [directoryRow(q ? `hit-${q}` : 'open')], nextBefore: null })
  })
  try {
    const input = await searchTasks(view.container, 'old')
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 hit-old')
    await act(async () => { view.button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    expect(queries).toEqual([['open', ''], ['open', 'old'], ['needs_answer', 'old']])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 hit-old')
    await searchTasks(view.container, 'unsubmitted', false)
    await flushPanel()
    expect(queries).toHaveLength(3)
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 hit-old')
    expect(input.value).toBe('unsubmitted')
  } finally { view.dispose() }
})

it.each([false, true])('搜索 A/B/A 切换忽略初次 A 的迟到结果或故障，失败=%s', async failed => {
  const pending = Promise.withResolvers<Response>()
  let visits = 0
  const view = await taskDirectory(query => {
    const q = query.get('q')
    if (q === 'A' && ++visits === 1) return pending.promise
    return Response.json({ items: [directoryRow(q === 'A' ? 'current-A' : q === 'B' ? 'current-B' : 'initial')], nextBefore: null })
  })
  try {
    await fillTaskGoal(view.container, '搜索切换不能覆盖此目标')
    await searchTasks(view.container, 'A')
    expect(view.container.querySelector('.dt-list')).toBeNull()
    await searchTasks(view.container, 'B')
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 current-B')
    await searchTasks(view.container, 'A')
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 current-A')
    await act(async () => { pending.resolve(failed ? Response.json({ error: '过期搜索失败' }, { status: 503 })
      : Response.json({ items: [directoryRow('outdated-A')], nextBefore: 'outdated-A' })) })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 current-A')
    expect(view.container.textContent).not.toContain('outdated-A')
    expect(view.container.textContent).not.toContain('过期搜索失败')
    expect(view.container.querySelector('textarea')?.value).toBe('搜索切换不能覆盖此目标')
    expect(view.requests.every(request => request.method === 'GET')).toBe(true)
  } finally { pending.resolve(Response.json({ items: [], nextBefore: null })); view.dispose() }
})

it('搜索后分页、进入详情和返回保留关键词与原页，切换关键词从首屏重新读取', async () => {
  const queries: [string | null, string | null][] = []
  const view = await taskDirectory(query => {
    const q = query.get('q'), before = query.get('before')
    queries.push([q, before])
    return Response.json({ items: [directoryRow(q && before ? 'local-1' : `first-${q ?? 'all'}`)],
      nextBefore: q && !before ? 'matching-first' : null })
  })
  try {
    await fillTaskGoal(view.container, '返回搜索结果仍保留的草稿')
    await searchTasks(view.container, 'source')
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(queries.at(-1)).toEqual(['source', 'matching-first'])
    await act(async () => { view.button('任务 local-1').click() })
    await flushPanel()
    const before = queries.length
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(queries).toHaveLength(before)
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    expect(queries.slice(before)).toEqual([['source', 'matching-first']])
    expect(view.container.querySelector<HTMLInputElement>(`input[aria-label="${zh['task.search']}"]`)!.value).toBe('source')
    expect(view.container.querySelector('textarea')?.value).toBe('返回搜索结果仍保留的草稿')
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 local-1')
    await searchTasks(view.container, 'different')
    expect(queries.at(-1)).toEqual(['different', null])
    expect(view.container.querySelector('.dt-list')?.textContent).not.toContain('任务 local-1')
    expect(view.button(zh['task.previousPage']).disabled).toBe(true)
    expect(view.requests.every(request => request.method === 'GET')).toBe(true)
    expect(sessionStorage.getItem('dsh-superagent/route')).not.toContain('matching-first')
  } finally { view.dispose() }
})

it('无匹配与搜索失败分别呈现，错误不伪装成零结果；重试保留当前关键词和草稿', async () => {
  let fail = true
  const view = await taskDirectory(query => query.has('q')
    ? fail ? Response.json({ error: '搜索暂时不可用' }, { status: 503 }) : Response.json({ items: [], nextBefore: null })
    : Response.json({ items: [directoryRow('initial')], nextBefore: null }))
  try {
    await fillTaskGoal(view.container, '失败后继续编辑的目标')
    const input = await searchTasks(view.container, 'no matches')
    expect(view.container.textContent).toContain('搜索暂时不可用')
    expect(view.container.textContent).not.toContain(zh['task.searchNone'])
    expect(view.container.querySelector('.dt-list')).toBeNull()
    fail = false
    await act(async () => { view.button(zh['task.reload']).click() })
    await flushPanel()
    expect(view.container.textContent).toContain(zh['task.searchNone'])
    expect(view.container.textContent).not.toContain('搜索暂时不可用')
    expect(input.value).toBe('no matches')
    expect(view.container.querySelector('textarea')?.value).toBe('失败后继续编辑的目标')
    expect(view.requests.every(request => request.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it.each([1, 3])('浏览深度为 %i 页后只刷新当前页，返回重读且保留草稿和键盘焦点', async depth => {
  let activity: 'running' | 'held' = 'running'
  const view = await taskDirectory(query => {
    const index = Number(query.get('before')?.split('-')[1] ?? 0)
    return Response.json({ items: [directoryRow(`${index}-a`, activity), directoryRow(`${index}-b`, activity)],
      nextBefore: index < depth ? `cursor-${index + 1}` : null })
  })
  try {
    await fillTaskGoal(view.container, '翻页前写下的目标')
    for (let index = 1; index <= depth; index++) {
      await act(async () => { view.button(zh['task.nextPage']).click() })
      await flushPanel()
      expect(view.container.querySelectorAll('.dt-list > li')).toHaveLength(2)
      expect(view.container.querySelector('.dt-list')?.textContent).toContain(`任务 ${index}-a`)
      expect(view.container.querySelector('.dt-list')?.textContent).not.toContain(`任务 ${index - 1}-a`)
      expect(document.activeElement?.getAttribute('aria-label')).toBe(zh['task.pageNumber'].replace('{number}', String(index + 1)))
    }
    const goal = view.container.querySelector('textarea')!
    goal.focus()
    const reads = view.reads().length
    activity = 'held'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.reads().slice(reads)).toEqual([`cursor-${depth}`])
    expect(view.container.querySelector('.dt-row-meta')?.textContent).toContain(zh['task.held'])
    expect(view.container.querySelector('.dt-list .dt-spinner')).toBeNull()
    expect(document.activeElement).toBe(goal)
    for (let index = depth - 1; index >= 0; index--) {
      const before = view.reads().length
      await act(async () => { view.button(zh['task.previousPage']).click() })
      await flushPanel()
      expect(view.reads().slice(before)).toEqual([index ? `cursor-${index}` : null])
      expect(view.container.querySelector('.dt-list')?.textContent).toContain(`任务 ${index}-a`)
      expect(view.container.querySelector('.dt-row-meta')?.textContent).toContain(zh['task.held'])
    }
    expect(goal.value).toBe('翻页前写下的目标')
    expect(view.requests.every(request => request.method === 'GET' && !request.path.startsWith('tasks/'))).toBe(true)
  } finally { view.dispose() }
})

it.each(['open', 'needs_answer'] as const)('%s 后续页成员变化时移除旧任务，空页可返回且不误报全局为空', async filter => {
  let changed = false
  const view = await taskDirectory(query => Response.json({
    items: query.has('before') ? changed ? [] : [directoryRow('older', 'running', filter === 'needs_answer')]
      : [directoryRow('first', 'held', filter === 'needs_answer')],
    nextBefore: query.has('before') ? null : 'first',
  }))
  try {
    if (filter !== 'open') {
      await act(async () => { view.button(zh[`task.filter.${filter}`]).click() })
      await flushPanel()
    }
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 older')
    changed = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')).toBeNull()
    expect(view.container.textContent).toContain(zh['task.emptyPage'])
    expect(view.container.textContent).not.toContain(zh['task.noQuestions'])
    expect(view.button(zh['task.nextPage']).disabled).toBe(true)
    await act(async () => { view.button(zh['task.previousPage']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
  } finally { view.dispose() }
})

it.each([false, true])('翻页 A/B/A/B 后忽略第一次 B 的迟到响应或错误，失败=%s', async failed => {
  const pending = Promise.withResolvers<Response>()
  let visits = 0
  const view = await taskDirectory(query => {
    if (!query.has('before')) return Response.json({ items: [directoryRow('first')], nextBefore: 'first' })
    return ++visits === 1 ? pending.promise : Response.json({ items: [directoryRow('current')], nextBefore: null })
  })
  try {
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')).toBeNull()
    await act(async () => { view.button(zh['task.previousPage']).click() })
    await flushPanel()
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    await act(async () => {
      pending.resolve(failed ? Response.json({ error: '旧页读取失败' }, { status: 503 })
        : Response.json({ items: [directoryRow('outdated')], nextBefore: 'outdated' }))
    })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 current')
    expect(view.container.textContent).not.toContain('任务 outdated')
    expect(view.container.textContent).not.toContain('旧页读取失败')
    expect(view.button(zh['task.nextPage']).disabled).toBe(true)
    expect(view.reads()).toEqual([null, 'first', null, 'first'])
  } finally { pending.resolve(Response.json({ items: [], nextBefore: null })); view.dispose() }
})

it('当前页刷新失败保留旧数据并停止运行指示，重试合并点击且只重读当前游标', async () => {
  let phase: 'ready' | 'failed' | 'retry' = 'ready'
  const pending = Promise.withResolvers<Response>()
  const view = await taskDirectory(query => {
    if (!query.has('before')) return Response.json({ items: [directoryRow('first')], nextBefore: 'first' })
    if (phase === 'failed') return Response.json({ error: '暂时无法读取目录' }, { status: 503 })
    if (phase === 'retry') return pending.promise
    return Response.json({ items: [directoryRow('older')], nextBefore: 'older' })
  })
  try {
    await fillTaskGoal(view.container, '失败重试也要保留的草稿')
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    phase = 'failed'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.container.textContent).toContain(zh['task.staleStatus'])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 older')
    expect(view.container.querySelector('.dt-list .dt-spinner')).toBeNull()
    expect(view.button(zh['task.nextPage']).disabled).toBe(true)
    expect(view.button(zh['task.previousPage']).disabled).toBe(false)
    const before = view.reads().length
    phase = 'retry'
    await act(async () => { view.button(zh['task.reload']).click(); view.button(zh['task.reload']).click() })
    await flushPanel()
    expect(view.reads().slice(before)).toEqual(['first'])
    await act(async () => {
      pending.resolve(Response.json({ items: [directoryRow('older', 'held')], nextBefore: null }))
    })
    await flushPanel()
    expect(view.container.textContent).not.toContain(zh['task.staleStatus'])
    expect(view.container.textContent).not.toContain('暂时无法读取目录')
    expect(view.container.querySelector('.dt-row-meta')?.textContent).toContain(zh['task.held'])
    expect(view.container.querySelector('textarea')?.value).toBe('失败重试也要保留的草稿')
  } finally { pending.resolve(Response.json({ items: [], nextBefore: null })); view.dispose() }
})

it('新页首次读取失败不显示上一页数据，返回时重新读取并清除旧页错误', async () => {
  const view = await taskDirectory(query => query.has('before')
    ? Response.json({ error: '新页暂时不可读' }, { status: 503 })
    : Response.json({ items: [directoryRow('first')], nextBefore: 'first' }))
  try {
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')).toBeNull()
    expect(view.container.textContent).toContain('新页暂时不可读')
    expect(view.container.textContent).not.toContain(zh['task.staleStatus'])
    expect(view.button(zh['task.nextPage']).disabled).toBe(true)
    await act(async () => { view.button(zh['task.previousPage']).click() })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
    expect(view.container.textContent).not.toContain('新页暂时不可读')
    expect(view.reads()).toEqual([null, 'first', null])
  } finally { view.dispose() }
})

it.each([
  { depth: 1, filter: 'open' }, { depth: 3, filter: 'needs_answer' }, { depth: 3, filter: 'all' },
] as const)('从 $filter 的第 $depth 个后续页进入详情后，一次返回直读原页且不后台轮询目录', async ({ depth, filter }) => {
  let changed = false
  const view = await taskDirectory(query => {
    const page = Number(query.get('before')?.split('-')[1] ?? 0)
    return Response.json({ items: [directoryRow(page === depth ? 'local-1' : `page-${page}`,
      changed ? 'held' : 'running', filter === 'needs_answer')], nextBefore: page < depth ? `cursor-${page + 1}` : null })
  })
  try {
    if (filter !== 'open') {
      await act(async () => { view.button(zh[`task.filter.${filter}`]).click() })
      await flushPanel()
    }
    for (let page = 0; page < depth; page++) {
      await act(async () => { view.button(zh['task.nextPage']).click() })
      await flushPanel()
    }
    const beforeDetail = view.reads().length
    await act(async () => { view.button('任务 local-1').click() })
    await flushPanel()
    expect(view.container.textContent).toContain(zh['task.progress'])
    changed = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.reads()).toHaveLength(beforeDetail)
    const back = view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!
    await act(async () => { back.click() })
    await flushPanel()
    expect(view.reads().slice(beforeDetail)).toEqual([`cursor-${depth}`])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 local-1')
    expect(view.container.querySelector('.dt-row-meta')?.textContent).toContain(
      zh[filter === 'needs_answer' ? 'task.question' : 'task.held'])
    expect(view.button(zh[`task.filter.${filter}`]).getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(zh['task.pageNumber'].replace('{number}', String(depth + 1)))
    expect(view.requests.every(request => request.method === 'GET')).toBe(true)
    // 仅恢复阅读位置，不将目录数据或游标写入可跨宿主复用的持久记录。
    expect(sessionStorage.getItem('dsh-superagent/route')).not.toContain('cursor-')
    const beforePrevious = view.reads().length
    await act(async () => { view.button(zh['task.previousPage']).click() })
    await flushPanel()
    expect(view.reads().slice(beforePrevious)).toEqual([depth === 1 ? null : `cursor-${depth - 1}`])
  } finally { view.dispose() }
})

it('从详情返回时已退出筛选的任务不复活，切换筛选清除原阅读位置', async () => {
  let changed = false
  const view = await taskDirectory(query => Response.json({ items: query.has('before')
    ? changed ? [] : [directoryRow('local-1', 'held', true)] : [directoryRow('first', 'held', true)],
  nextBefore: query.has('before') ? null : 'first' }))
  try {
    await act(async () => { view.button(zh['task.filter.needs_answer']).click() })
    await flushPanel()
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    await act(async () => { view.button('任务 local-1').click() })
    await flushPanel()
    changed = true
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    expect(view.container.textContent).toContain(zh['task.emptyPage'])
    expect(view.container.querySelector('.dt-list')).toBeNull()
    const before = view.reads().length
    for (const filter of ['open', 'needs_answer'] as const) {
      await act(async () => { view.button(zh[`task.filter.${filter}`]).click() })
      await flushPanel()
    }
    expect(view.reads().slice(before)).toEqual([null, null])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
  } finally { view.dispose() }
})

it.each(['masterId', 'stateDir'] as const)('详情期间 %s 变化后返回从首屏读取，不携带旧宿主游标', async field => {
  let other = false
  const view = await taskDirectory(query => Response.json({ items: [directoryRow(query.has('before') ? 'local-1' : 'first')],
    nextBefore: query.has('before') ? null : 'first' }))
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (!other || !new URL(url, 'http://127.0.0.1').pathname.endsWith('/state')) return response
    const state = await response.json()
    return Response.json({ ...state, masterId: field === 'masterId' ? 'other-master' : state.masterId,
      setup: { ...state.setup, machine: { ...state.setup.machine,
        stateDir: field === 'stateDir' ? '/srv/other-state' : state.setup.machine.stateDir } } })
  }))
  try {
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    await act(async () => { view.button('任务 local-1').click() })
    await flushPanel()
    const before = view.reads().length
    other = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    expect(view.reads()).toHaveLength(before)
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    expect(view.reads().slice(before)).toEqual([null])
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
  } finally { view.dispose() }
})

it.each([false, true])('详情返回的重读不受离页前迟到目录结果影响，旧读取失败=%s', async failed => {
  const pending = Promise.withResolvers<Response>()
  let oldPoll = false
  const view = await taskDirectory(query => query.has('before') && oldPoll ? pending.promise
    : Response.json({ items: [directoryRow(query.has('before') ? 'local-1' : 'first', 'held')],
      nextBefore: query.has('before') ? null : 'first' }))
  try {
    await act(async () => { view.button(zh['task.nextPage']).click() })
    await flushPanel()
    oldPoll = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flushPanel()
    await act(async () => { view.button('任务 local-1').click() })
    await flushPanel()
    oldPoll = false
    const before = view.reads().length
    await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-page-head > button')!.click() })
    await flushPanel()
    expect(view.reads().slice(before)).toEqual(['first'])
    await act(async () => { pending.resolve(failed ? Response.json({ error: '过期目录故障' }, { status: 503 })
      : Response.json({ items: [directoryRow('outdated')], nextBefore: 'outdated' })) })
    await flushPanel()
    expect(view.container.querySelector('.dt-list')?.textContent).toContain('任务 local-1')
    expect(view.container.textContent).not.toContain('任务 outdated')
    expect(view.container.textContent).not.toContain('过期目录故障')
  } finally { pending.resolve(Response.json({ items: [], nextBefore: null })); view.dispose() }
})

it('面板重新挂载从首屏重读，不将旧游标当作持久恢复状态', async () => {
  const view = await taskDirectory(query => Response.json({ items: [directoryRow(query.has('before') ? 'older' : 'first')],
    nextBefore: query.has('before') ? null : 'first' }))
  await act(async () => { view.button(zh['task.nextPage']).click() })
  await flushPanel()
  view.dispose()
  const before = view.reads().length
  const next = await render(view.main, { t })
  try {
    expect(view.reads().slice(before)).toEqual([null])
    expect(next.container.querySelector('.dt-list')?.textContent).toContain('任务 first')
  } finally { next.dispose() }
})

it.each([0, 2])('context disclosure preserves a draft and retries safely with %i queued inputs', async initialPending => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
  serve('hmm')
  const original = vi.mocked(fetch).getMockImplementation()!
  const writes: { requestId: string; text: string }[] = []
  let pendingDelivery = initialPending
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tasks/local-1/inputs') && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      if (writes.length === 1) return Response.json({ error: '暂时无法保存' }, { status: 503 })
      pendingDelivery++
      return Response.json({ ticketId: 'local-1', inputId: 'input-1', created: true })
    }
    const response = await original(url, init)
    if (!path.endsWith('/tasks/local-1')) return response
    const status = await response.json()
    return Response.json({ ...status, inputs: { total: pendingDelivery + 1, pendingDelivery } })
  }))
  const { main } = fixture([]), view = await render(main, { t })
  const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  const toggle = () => [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
    .find(element => element.textContent?.includes(zh['task.addContext']))!
  const queued = (count: number) => zh['task.inputCount'].replace('{count}', String(count))
  try {
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('textarea')).toBeNull()
    expect(view.container.textContent?.includes(queued(initialPending))).toBe(initialPending > 0)
    expect(writes).toHaveLength(0)
    await act(async () => { toggle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const draft = '补充限制：只使用已授权的资料。'
    const field = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, draft)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().textContent?.includes(queued(initialPending))).toBe(false)
    await act(async () => { toggle().click() })
    expect(view.container.querySelector('textarea')).toBeNull()
    await act(async () => { toggle().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    expect(view.container.querySelector('textarea')?.value).toBe(draft)
    const send = () => [...view.container.querySelectorAll('button')].find(button => button.textContent === zh['task.sendContext'])!
    await act(async () => { send().click() })
    await flush()
    expect(writes).toHaveLength(1)
    expect(document.body.textContent).toContain('暂时无法保存')
    expect(view.container.querySelector('textarea')?.value).toBe(draft)
    await act(async () => { toggle().click() })
    expect(view.container.textContent?.includes(queued(initialPending))).toBe(initialPending > 0)
    await act(async () => { toggle().click() })
    expect(view.container.querySelector('textarea')?.value).toBe(draft)
    await act(async () => { send().click() })
    await flush()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[1]).toEqual({ requestId: expect.any(String), text: draft })
    expect(view.container.querySelector('textarea')?.value).toBe('')
    expect(view.container.textContent).toContain(queued(initialPending + 1))
    await act(async () => { toggle().click() })
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(view.container.textContent).toContain(queued(initialPending + 1))
    expect(writes).toHaveLength(2)
  } finally { view.dispose() }
})

it.each(['retry', 'edited'].flatMap(mode => [false, true].map(committed => ({ mode, committed }))))(
  '补充失败后可重试或改文，保留已保存原文且不陷入旧编号冲突（$mode，已保存：$committed）',
  async ({ mode, committed }) => {
    sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks', id: 'local-1' }, stack: [] }))
    const requests: { path: string; method: string; body?: unknown }[] = []
    serve('hmm', requests)
    const original = vi.mocked(fetch).getMockImplementation()!
    type Input = { requestId: string; text: string }
    const writes: Input[] = [], saved = new Map<string, string>()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://127.0.0.1').pathname
      if (path.endsWith('/inputs')) {
        const body = JSON.parse(String(init?.body)) as Input
        writes.push(body)
        if (writes.length === 1) {
          if (committed) { saved.set(body.requestId, body.text); throw new TypeError('模拟保存后响应丢失') }
          return Response.json({ error: '暂时无法保存' }, { status: 503 })
        }
        const previous = saved.get(body.requestId)
        if (previous !== undefined && previous !== body.text)
          return Response.json({ code: 'request_conflict', error: '请求编号已用于其他补充信息' }, { status: 409 })
        saved.set(body.requestId, body.text)
        return Response.json({ ticketId: 'local-1', inputId: `input-${body.requestId}`, created: previous === undefined })
      }
      const response = await original(url, init)
      if (!path.endsWith('/tasks/local-1')) return response
      const status = await response.json()
      return Response.json({ ...status, inputs: { total: 1 + saved.size, pendingDelivery: saved.size } })
    }))
    const { ctx, main } = fixture(['master']), view = await render(main, { t })
    const fill = async (text: string) => {
      const textarea = view.container.querySelector('textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const submit = async () => {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === zh['task.sendContext'])!
      await act(async () => { button.click(); button.click() })
      await flushPanel()
    }
    try {
      const disclosure = [...view.container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
        .find(row => row.textContent?.includes(zh['task.addContext']))!
      await act(async () => { disclosure.click() })
      await fill('先核对资料 A')
      await submit()
      expect(writes).toHaveLength(1)
      expect(view.container.querySelector('textarea')?.value).toBe('先核对资料 A')
      const next = mode === 'retry' ? '先核对资料 A' : '改为核对资料 B'
      await fill(mode === 'retry' ? '  先核对资料 A  ' : next)
      expect(writes).toHaveLength(1)
      await submit()
      expect(writes).toHaveLength(2)
      expect(writes[1]!.text).toBe(next)
      if (mode === 'retry') expect(writes[1]).toEqual(writes[0])
      else expect(writes[1]!.requestId).not.toBe(writes[0]!.requestId)
      const count = committed && mode === 'edited' ? 2 : 1
      expect(saved.size).toBe(count)
      expect([...saved.values()]).toEqual(committed && mode === 'edited' ? ['先核对资料 A', next] : [next])
      expect(view.container.querySelector('textarea')?.value).toBe('')
      expect(view.container.textContent).toContain(zh['task.inputCount'].replace('{count}', String(count)))
      // 成功后的再次明确提交属于新补充，不能永久按文字去重。
      await fill(next)
      await submit()
      expect(writes).toHaveLength(3)
      expect(writes[2]!.requestId).not.toBe(writes[1]!.requestId)
      expect(saved.size).toBe(count + 1)
      expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
      expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0)
    } finally { view.dispose() }
  })

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('状态回执能力绑定当前订阅，旧依赖和卸载后的接纳不能改变页面或启动读取', async () => {
  const calls: { id: number; done: (value: string) => void }[] = []
  let setId = (_id: number) => {}, accept = (_value: string, _expected: string) => false
  let reload = async () => {}
  let data: string | undefined
  function Harness() {
    const [id, update] = useState(1)
    setId = update
    const state = usePoll(() => new Promise<string>(done => { calls.push({ id, done }) }), [id])
    data = state.data; accept = state.accept; reload = state.reload
    return null
  }
  const container = document.createElement('div'), root = createRoot(container)
  let disposed = false
  try {
    await act(async () => { root.render(<Harness />) })
    await act(async () => { calls[0]!.done('first') })
    const oldAccept = accept
    await act(async () => { setId(2) })
    expect(oldAccept('old receipt', 'first')).toBe(false)
    await act(async () => { calls[1]!.done('second') })
    expect(accept('wrong receipt', 'first')).toBe(false)
    expect(data).toBe('second')
    await act(async () => { expect(accept('confirmed receipt', 'second')).toBe(true) })
    expect(data).toBe('confirmed receipt')
    let refreshing!: Promise<void>
    await act(async () => { refreshing = reload() })
    expect(calls).toHaveLength(3)
    await act(async () => { calls[2]!.done('fresh poll'); await refreshing })
    expect(data).toBe('fresh poll')
    act(() => { root.unmount() }); disposed = true
    expect(accept('unmounted receipt', 'fresh poll')).toBe(false)
    expect(calls).toHaveLength(3)
  } finally { if (!disposed) act(() => { root.unmount() }) }
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})
