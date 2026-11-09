// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/client/app.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import { SettingsSchema } from '../src/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })

type Failure = { status: number; code?: string; empty?: boolean }
async function flush() {
  for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function detail(language: 'zh' | 'en', failure?: Failure) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: { page: 'tasks', id: 'recover-task' }, stack: [],
  }))
  const dictionary = language === 'en' ? en : zh
  const t = ((key, values) => dictionary[key].replace(/\{(\w+)\}/g, (match, name) =>
    values && name in values ? String(values[name]) : match)) as T
  const state = { masterId: 'read-controller', paused: false, settings: SettingsSchema.parse({}),
    setup: { machine: { mode: 'hmm', stateDir: '/synthetic/read-recovery' }, problem: null },
    load: { running: 0, queued: 0 }, health: {}, revisions: { policy: 0, eval: 0, executor: 0 } }
  const status = { ticketId: 'recover-task', title: 'Historical comparison', paused: false, activity: 'ended', question: null,
    ended: { outcome: 'completed', by: 'agent', at: '2026-11-06T00:00:00Z' },
    result: { summary: 'Previously validated comparison', evidenceRefs: [], sourceCount: 0 }, resultError: null,
    inputs: { total: 0, pendingDelivery: 0 },
    workflow: { revision: 1, planVersion: 1, phase: 'validated', autoRun: false, awaitingValidation: false,
      progress: { total: 1, pending: 0, running: 0, completed: 1, suspended: 0, pruned: 0 },
      referenceIntegrity: 'valid', requiresOrchestrator: false, planReviewRequired: false,
      blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } } }
  const control = { failure, discussion: undefined as Promise<Response> | undefined,
    receipt: { sessionId: 'read-controller' } as unknown }
  const requests: { path: string; method: string }[] = [], discussions: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    requests.push({ path, method: init?.method ?? 'GET' })
    if (path === 'state') return Response.json(state)
    if (path === 'tasks/recover-task') {
      const current = control.failure
      if (current?.status === 0) throw new TypeError('Synthetic offline failure')
      return current ? current.empty ? new Response('', { status: current.status })
        : Response.json({ error: 'Synthetic plan read failure', ...(current.code ? { code: current.code } : {}) },
          { status: current.status }) : Response.json(status)
    }
    if (path === 'tasks/recover-task/discuss') {
      discussions.push(JSON.parse(String(init?.body)))
      const pending = control.discussion
      control.discussion = undefined
      return pending ?? Response.json(control.receipt)
    }
    return Response.json({ error: 'Unexpected request' }, { status: 404 })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), openSession = vi.fn()
  await act(async () => { root.render(<App t={t} openSession={openSession} deploymentForm={undefined} />) })
  await flush()
  const buttons = (key: keyof typeof dictionary) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.textContent === dictionary[key])
  return { container, dictionary, control, requests, discussions, openSession, buttons,
    refresh: async () => { await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await flush() },
    dispose: () => { act(() => root.unmount()); container.remove() },
  }
}

it.each(['zh', 'en'] as const)('%s首次读取缺计划或未来版本时说明保留事实，明确点击才讨论原任务', async language => {
  for (const [status, code, key] of [
    [404, 'workflow_missing', 'task.planMissing'], [409, 'schema_unsupported', 'task.planUnsupported'],
  ] as const) {
    const view = await detail(language, { status, code })
    try {
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(view.dictionary[key])
      expect(view.container.textContent).not.toContain('Synthetic')
      expect(view.buttons('task.openOrchestrator')).toHaveLength(1)
      expect(view.buttons('task.reload')).toHaveLength(1)
      expect(view.requests.every(item => item.method === 'GET')).toBe(true)
      expect(view.openSession).not.toHaveBeenCalled()
      await act(async () => { view.buttons('task.openOrchestrator')[0]!.click() })
      await flush()
      expect(view.requests.filter(item => item.method !== 'GET'))
        .toEqual([{ method: 'POST', path: 'tasks/recover-task/discuss' }])
      expect(view.openSession).toHaveBeenCalledExactlyOnceWith('read-controller')
    } finally { view.dispose() }
  }
})

it('任务缺失、越权、网络或未知错误不能推断当前任务可讨论，错配状态码也不启用', async () => {
  for (const failure of [
    { status: 404, code: 'ticket_missing' }, { status: 403, code: 'scope_denied' }, { status: 500 },
    { status: 0 }, { status: 404, empty: true }, { status: 409, code: 'other_error' },
    { status: 404, code: 'schema_unsupported' }, { status: 503, code: 'workflow_missing' },
  ]) {
    const view = await detail('zh', failure)
    try {
      expect(view.buttons('task.openOrchestrator')).toHaveLength(0)
      expect(view.buttons('task.reload')).toHaveLength(1)
      expect(view.requests.every(item => item.method === 'GET')).toBe(true)
      expect(view.openSession).not.toHaveBeenCalled()
    } finally { view.dispose() }
  }
})

it('未读到计划也沿用原讨论身份，合并连点且导航失败后可以原样重试', async () => {
  const view = await detail('zh', { status: 404, code: 'workflow_missing' })
  const pending = Promise.withResolvers<Response>()
  view.control.discussion = pending.promise
  view.openSession.mockRejectedValueOnce(new Error('Synthetic navigation failure'))
  try {
    const reads = view.requests.filter(item => item.method === 'GET').length
    await act(async () => {
      view.buttons('task.openOrchestrator')[0]!.click()
      view.buttons('task.openOrchestrator')[0]!.click()
    })
    expect(view.buttons('task.openOrchestrator')[0]!.disabled).toBe(true)
    expect(view.discussions).toHaveLength(1)
    await act(async () => { pending.resolve(Response.json({ sessionId: 'read-controller' })) })
    await flush()
    expect(view.buttons('task.openOrchestrator')[0]!.disabled).toBe(false)
    await act(async () => { view.buttons('task.openOrchestrator')[0]!.click() })
    await flush()
    expect(view.discussions).toHaveLength(2)
    expect(view.discussions[1]).toEqual(view.discussions[0])
    expect(view.openSession).toHaveBeenCalledTimes(2)
    expect(view.requests.filter(item => item.method === 'GET')).toHaveLength(reads)
    expect(view.requests.filter(item => item.method !== 'GET').every(item => item.path.endsWith('/discuss'))).toBe(true)
  } finally { pending.resolve(Response.json({ sessionId: 'read-controller' })); view.dispose() }
})

it('已读到健康结果后计划变得不可读时仍能讨论，重读恢复后去除异常且不抢焦点', async () => {
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const view = await detail('zh')
  try {
    expect(view.container.textContent).toContain('Previously validated comparison')
    expect(view.buttons('task.openOrchestrator')).toHaveLength(0)
    const focus = view.container.querySelector<HTMLButtonElement>('button')!
    focus.focus()
    view.control.failure = { status: 409, code: 'schema_unsupported' }
    await view.refresh()
    expect(view.container.textContent).toContain(view.dictionary['task.planUnsupported'])
    expect(view.container.textContent).toContain(view.dictionary['task.staleStatus'])
    expect(view.container.textContent).toContain('Previously validated comparison')
    expect(view.buttons('task.openOrchestrator')).toHaveLength(1)
    view.control.failure = undefined
    await act(async () => { view.buttons('task.reload')[0]!.click() })
    await flush()
    expect(view.buttons('task.openOrchestrator')).toHaveLength(0)
    expect(view.container.textContent).not.toContain(view.dictionary['task.planUnsupported'])
    expect(document.activeElement).toBe(focus)
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
  } finally { view.dispose(); visible.mockRestore() }
})

it('任务讨论回执必须匹配当前总管和任务，拒绝后仍原样重试且不重读或执行', async () => {
  for (const receipt of [
    { sessionId: 'unrelated-controller' }, { sessionId: 'read-controller', ticketId: 'other-task' },
    { sessionId: 'read-controller', ticketId: null }, null, {}, [], { sessionId: 0 },
    { sessionId: '' }, { sessionId: ' read-controller ' },
  ]) {
    const view = await detail('zh', { status: 404, code: 'workflow_missing' })
    try {
      view.control.receipt = receipt
      const reads = view.requests.filter(item => item.method === 'GET').length
      await act(async () => { view.buttons('task.openOrchestrator')[0]!.click() })
      await flush()
      expect(view.openSession).not.toHaveBeenCalled()
      expect(document.querySelector('.dt-toast')?.textContent).toBe('尚未确认任务讨论会话，请原样重试。')
      expect(view.buttons('task.openOrchestrator')[0]!.disabled).toBe(false)
      view.control.receipt = { ticketId: 'recover-task', sessionId: 'read-controller' }
      await act(async () => { view.buttons('task.openOrchestrator')[0]!.click() })
      await flush()
      expect(view.openSession).toHaveBeenCalledExactlyOnceWith('read-controller')
      expect(view.discussions).toHaveLength(2)
      expect(view.discussions[1]).toEqual(view.discussions[0])
      expect(view.requests.filter(item => item.method === 'GET')).toHaveLength(reads)
      expect(view.requests.filter(item => item.method !== 'GET').every(item => item.path.endsWith('/discuss'))).toBe(true)
    } finally { view.dispose() }
  }
})

it.each(['zh', 'en'] as const)('%s旧版同总管回执与带任务身份的新版回执均可打开讨论', async language => {
  for (const receipt of [
    { sessionId: 'read-controller' }, { ticketId: 'recover-task', sessionId: 'read-controller' },
  ]) {
    const view = await detail(language, { status: 409, code: 'schema_unsupported' })
    try {
      view.control.receipt = receipt
      await act(async () => { view.buttons('task.openOrchestrator')[0]!.click() })
      await flush()
      expect(view.openSession).toHaveBeenCalledExactlyOnceWith('read-controller')
      expect(view.discussions).toHaveLength(1)
    } finally { view.dispose() }
  }
})
