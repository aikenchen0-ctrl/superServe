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

async function flush() {
  for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function directory(language: 'zh' | 'en', detailError?: string) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: detailError ? { page: 'tasks', id: 'changed' } : { page: 'tasks', query: { filter: 'all' } }, stack: [],
  }))
  const dictionary = language === 'en' ? en : zh
  const t = ((key, values) => dictionary[key].replace(/\{(\w+)\}/g, (match, name) =>
    values && name in values ? String(values[name]) : match)) as T
  const state = { masterId: 'delivery-controller', paused: false, settings: SettingsSchema.parse({}),
    setup: { machine: { mode: 'hmm', stateDir: '/synthetic/delivery' }, problem: null },
    load: { running: 0, queued: 0 }, health: {}, revisions: { policy: 0, eval: 0, executor: 0 } }
  const base = { createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', needsAnswer: false }
  const ended = { outcome: 'completed', by: 'agent', at: '2026-11-06T00:00:00Z' }
  let resultAvailability: string | undefined = 'unavailable', failed = false
  let resultError = detailError
  const requests: { method: string; path: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    requests.push({ path, method: init?.method ?? 'GET' })
    if (path === 'state') return Response.json(state)
    if (path === 'tasks/changed') return Response.json({
      ticketId: 'changed', title: 'Changed result', activity: 'ended', ended, paused: false, question: null,
      result: null, resultError, inputs: { total: 0, pendingDelivery: 0 },
      workflow: { revision: 1, planVersion: 1, phase: 'validated', autoRun: false, awaitingValidation: false,
        progress: { total: 1, pending: 0, running: 0, completed: 1, suspended: 0, pruned: 0 },
        referenceIntegrity: 'valid', requiresOrchestrator: true, planReviewRequired: false,
        blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } },
    })
    if (path === 'tasks/changed/discuss') return Response.json({ sessionId: 'delivery-controller' })
    if (path === 'tasks') return failed ? Response.json({ error: 'Synthetic directory read failed' }, { status: 503 })
      : Response.json({ items: [
        { ...base, ticketId: 'changed', title: 'Changed result', activity: 'ended', ended, resultAvailability },
        { ...base, ticketId: 'unknown', title: 'Unknown result', activity: 'ended', ended, resultAvailability: 'unknown' },
        { ...base, ticketId: 'healthy', title: 'Healthy history', activity: 'ended', ended },
        { ...base, ticketId: 'stopped', title: 'Stopped history', activity: 'ended',
          ended: { ...ended, outcome: 'stopped' }, resultAvailability: 'unavailable' },
        { ...base, ticketId: 'active', title: 'Running work', activity: 'running', ended: null, resultAvailability: 'unavailable' },
        { ...base, ticketId: 'future', title: 'Future metadata', activity: 'ended', ended,
          resultAvailability: '<img src=x onerror=alert(1)>' },
      ], nextBefore: null })
    return Response.json({ error: 'Unexpected read' }, { status: 404 })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const openSession = vi.fn()
  await act(async () => { root.render(<App t={t} openSession={openSession} deploymentForm={undefined} />) })
  await flush()
  const row = (title: string) => [...container.querySelectorAll<HTMLLIElement>('.dt-list > li')]
    .find(item => item.querySelector('button')?.textContent === title)!
  return { container, dictionary, requests, row, openSession,
    change: (value: string | undefined) => { resultAvailability = value },
    changeError: (value: string) => { resultError = value },
    fail: (value: boolean) => { failed = value },
    refresh: async () => { await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await flush() },
    dispose: () => { act(() => root.unmount()); container.remove() },
  }
}

it.each(['zh', 'en'] as const)('%s目录保留历史完成并只显示已知的结果异常，旧宿主与其他任务不增提示', async language => {
  const view = await directory(language)
  try {
    const { dictionary: d, row } = view
    expect(row('Changed result').textContent).toContain(d['outcome.completed'])
    expect(row('Changed result').textContent).toContain(d['task.resultUnavailable'])
    expect(row('Unknown result').textContent).toContain(d['task.resultUnconfirmed'])
    expect(row('Unknown result').textContent).toContain(d['outcome.completed'])
    const description = row('Changed result').querySelector('button')!.getAttribute('aria-describedby')!
    expect(document.getElementById(description)?.textContent).toBe(d['task.resultUnavailable'])
    for (const title of ['Healthy history', 'Stopped history', 'Running work', 'Future metadata']) {
      expect(row(title).textContent).not.toContain(d['task.resultUnavailable'])
      expect(row(title).textContent).not.toContain(d['task.resultUnconfirmed'])
    }
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.textContent).not.toContain('<img')
    expect(view.requests.every(item => item.method === 'GET' && !item.path.startsWith('tasks/'))).toBe(true)
    expect(row('Changed result').querySelectorAll('button')).toHaveLength(1)
  } finally { view.dispose() }
})

it('同一历史任务的结果观察随轮询更新；读取失败不把旧警告当作当前核验，焦点和草稿保留', async () => {
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const view = await directory('zh')
  try {
    const goal = view.container.querySelector('textarea')!
    goal.focus()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, 'Keep this unsent goal')
      goal.dispatchEvent(new Event('input', { bubbles: true }))
    })
    view.change(undefined)
    await view.refresh()
    expect(view.row('Changed result').textContent).not.toContain(zh['task.resultUnavailable'])
    expect(view.row('Changed result').querySelector('button')!.getAttribute('aria-describedby')).toBeNull()
    view.change('unavailable')
    await view.refresh()
    expect(view.row('Changed result').textContent).toContain(zh['task.resultUnavailable'])
    view.fail(true)
    await view.refresh()
    expect(view.row('Changed result').textContent).not.toContain(zh['task.resultUnavailable'])
    expect(view.row('Unknown result').textContent).not.toContain(zh['task.resultUnconfirmed'])
    expect(view.container.textContent).toContain(zh['task.staleStatus'])
    view.fail(false)
    await view.refresh()
    expect(view.row('Changed result').textContent).toContain(zh['task.resultUnavailable'])
    expect(view.row('Unknown result').textContent).toContain(zh['task.resultUnconfirmed'])
    expect(document.activeElement).toBe(goal)
    expect(goal.value).toBe('Keep this unsent goal')
    expect(view.requests.every(item => item.method === 'GET' && !item.path.startsWith('tasks/'))).toBe(true)
  } finally { view.dispose(); visible.mockRestore() }
})

it.each(['zh', 'en'] as const)('%s详情按实际验收原因说明，不将输入或复核问题误报为引用失效', async language => {
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const view = await directory(language, 'evidence_invalid')
  try {
    const cases = [
      ['evidence_invalid', 'task.resultInvalid'],
      ['input_conflict', 'task.resultInputsChanged'],
      ['claims_unreviewed', 'task.resultClaimsUnreviewed'],
      ['workflow_unverified', 'task.resultUnverified'],
      ['future_error', 'task.resultUnavailable'],
      ['toString', 'task.resultUnavailable'],
    ] as const
    for (const [code, key] of cases) {
      view.changeError(code)
      await view.refresh()
      expect(view.container.querySelector('.dt-banner.dt-danger')?.textContent).toBe(view.dictionary[key])
      expect(view.container.textContent).toContain(view.dictionary['outcome.completed'])
      expect(view.container.textContent).not.toContain(code)
      expect(view.container.textContent).not.toContain('PRIVATE_')
      expect([...view.container.querySelectorAll('button')]
        .filter(button => button.textContent === view.dictionary['task.openOrchestrator'])).toHaveLength(1)
    }
    expect(view.requests.every(item => item.method === 'GET' && !item.path.endsWith('/result-sources'))).toBe(true)
    expect(view.openSession).not.toHaveBeenCalled()
  } finally { view.dispose(); visible.mockRestore() }
})

it('验收问题复用原总管入口，只有明确点击才写入讨论背景，不发起重新执行', async () => {
  const view = await directory('zh', 'input_conflict')
  try {
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
    const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === view.dictionary['task.openOrchestrator'])!
    await act(async () => { button.click() })
    await flush()
    expect(view.requests.filter(item => item.method !== 'GET'))
      .toEqual([{ method: 'POST', path: 'tasks/changed/discuss' }])
    expect(view.openSession).toHaveBeenCalledExactlyOnceWith('delivery-controller')
    expect(view.container.textContent).toContain(view.dictionary['task.resultInputsChanged'])
  } finally { view.dispose() }
})
