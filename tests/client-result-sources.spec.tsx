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

async function panel(language: 'zh' | 'en' = 'zh') {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({
    route: { page: 'tasks', id: 'sources-task' }, stack: [],
  }))
  const dictionary = language === 'en' ? en : zh
  const t = ((key, values) => dictionary[key].replace(/\{(\w+)\}/g, (match, name) =>
    values && name in values ? String(values[name]) : match)) as T
  const state = { masterId: 'sources-controller', paused: false, settings: SettingsSchema.parse({}),
    setup: { machine: { mode: 'hmm', stateDir: '/synthetic/result-sources' }, problem: null },
    load: { running: 0, queued: 0 }, health: {}, revisions: { policy: 0, eval: 0, executor: 0 } }
  const items = Array.from({ length: 7 }, (_, index) => ({
    nodeId: `source-${index}`, title: `Checked source ${index + 1}`,
    summary: { text: `Confirmed criterion ${index + 1}`, truncated: false },
  }))
  const control = { response: undefined as unknown, override: false, pageSize: 4 }
  const requests: { path: string; method: string }[] = []
  const sourcePage = (offset = 0) => {
    const page = items.slice(offset, offset + control.pageSize), end = offset + page.length
    return { ticketId: 'sources-task', revision: 12, offset, total: items.length, items: page,
      nextOffset: end < items.length ? end : null }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const address = new URL(url, 'http://127.0.0.1'), path = address.pathname.replace('/orchestrator/api/', '')
    requests.push({ path: path + address.search, method: init?.method ?? 'GET' })
    if (path === 'state') return Response.json(state)
    if (path === 'tasks/sources-task') return Response.json({
      ticketId: 'sources-task', title: 'Review authorized comparisons', activity: 'ended', paused: false, question: null,
      ended: { outcome: 'completed', by: 'agent', at: '2026-11-06T00:00:00Z' },
      result: { summary: 'Conclusion within the authorized scope',
        evidenceRefs: items.map(item => `result:${item.nodeId}`), sourceCount: items.length },
      resultError: null, inputs: { total: 0, pendingDelivery: 0 },
      workflow: { revision: 12, planVersion: 1, phase: 'validated', autoRun: false, awaitingValidation: false,
        progress: { total: items.length, pending: 0, running: 0, completed: items.length, suspended: 0, pruned: 0 },
        referenceIntegrity: 'valid', requiresOrchestrator: false, planReviewRequired: false,
        blockers: { total: 0, omitted: 0, items: [] }, dependencyBlockers: { total: 0, omitted: 0, items: [] } },
    })
    if (path === 'tasks/sources-task/result-sources') {
      if (control.override) return control.response instanceof Promise ? control.response
        : Response.json(control.response)
      return Response.json(sourcePage(Number(address.searchParams.get('offset'))))
    }
    return Response.json({ error: 'Unexpected request' }, { status: 404 })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<App t={t} openSession={vi.fn()} deploymentForm={undefined} />) })
  await flush()
  const button = (label: string) => [...container.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find(button => button.textContent?.startsWith(label))!
  const click = async (label: string) => { await act(async () => { button(label).click() }); await flush() }
  return { container, control, requests, items, sourcePage, click, dictionary,
    open: () => click(dictionary['task.resultSources']),
    sourceReads: () => requests.filter(item => item.path.startsWith('tasks/sources-task/result-sources?')),
    rows: () => [...container.querySelectorAll('.dt-task-result-sources > li')],
    dispose: () => { act(() => root.unmount()); container.remove() },
  }
}

it('异任务的成功响应不能成为当前结果依据，拒绝后原样重试且不增加状态读取', async () => {
  const view = await panel()
  try {
    view.control.override = true
    const original = view.sourcePage()
    view.control.response = { ...original, ticketId: 'other-task', items: original.items.map((item, index) => index ? item : {
      ...item, title: 'FOREIGN_TITLE', summary: { text: 'FOREIGN_RESULT_BODY', truncated: false },
    }) }
    const reads = view.requests.length
    await view.open()
    expect(view.rows()).toHaveLength(0)
    expect(view.container.textContent).not.toContain('FOREIGN_')
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('尚未确认验收依据，请重新读取。')
    view.control.override = false
    await view.click(view.dictionary['task.reload'])
    expect(view.rows()).toHaveLength(4)
    expect(view.sourceReads().map(item => item.path))
      .toEqual(Array(2).fill('tasks/sources-task/result-sources?revision=12&offset=0'))
    expect(view.requests.slice(reads)).toHaveLength(2)
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it.each(['zh', 'en'] as const)('%s后续页不匹配时保留已读依据与游标，重试只接纳连续且不重复的页', async language => {
  const view = await panel(language)
  try {
    await view.open()
    const accepted = view.rows().map(row => row.textContent)
    const original = view.sourcePage(4)
    const invalid = [
      { ...original, revision: 11 }, { ...original, total: 8 }, { ...original, nextOffset: 4 },
      { ...original, offset: 0 }, { ...original, offset: null },
      { ...original, nextOffset: 6 }, { ...original, items: [] },
      { ...original, items: [view.items[0], ...original.items.slice(1)] },
      { ...original, items: [original.items[0], original.items[0], original.items[2]] },
      { ...original, items: [{ ...original.items[0], summary: null }, ...original.items.slice(1)] },
      { ...original, items: [{ ...original.items[0], summary: { text: 42, truncated: false } }, ...original.items.slice(1)] },
      null, [], {},
    ]
    for (const [index, response] of invalid.entries()) {
      view.control.override = true; view.control.response = response
      await view.click(index === 0 ? view.dictionary['task.moreResultSources'].split('（')[0]!.split('(')[0]!
        : view.dictionary['task.reload'])
      expect(view.rows().map(row => row.textContent)).toEqual(accepted)
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(language === 'en'
        ? 'The validation sources are unconfirmed. Reload to confirm them.' : '尚未确认验收依据，请重新读取。')
    }
    view.control.override = false
    await view.click(view.dictionary['task.reload'])
    expect(view.rows()).toHaveLength(7)
    expect(new Set(view.rows().map(row => row.textContent)).size).toBe(7)
    expect(view.sourceReads().slice(1).every(item => item.path.endsWith('offset=4'))).toBe(true)
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
  } finally { view.dispose() }
})

it.each([1, 2, 4])('合法分页每页 %i 项均能连续合并，不把固定页长当契约', async pageSize => {
  const view = await panel()
  try {
    view.control.pageSize = pageSize
    expect(view.sourceReads()).toHaveLength(0)
    await view.open()
    while (view.rows().length < view.items.length)
      await view.click(view.dictionary['task.moreResultSources'].split('（')[0]!)
    expect(view.rows().map(row => row.querySelector('.dt-row-title')?.textContent))
      .toEqual(view.items.map(item => item.title))
    expect(view.sourceReads()).toHaveLength(Math.ceil(view.items.length / pageSize))
    expect(view.requests.every(item => item.method === 'GET')).toBe(true)
  } finally { view.dispose() }
})

it('旧宿主没有偏移回显仍可读取，节点标题相同也不错误判为重复', async () => {
  const view = await panel()
  try {
    const first = view.sourcePage()
    view.control.override = true
    view.control.response = { ticketId: first.ticketId, revision: first.revision, total: first.total,
      items: first.items.map(item => ({ ...item, title: 'Same title' })), nextOffset: first.nextOffset }
    await view.open()
    expect(view.rows()).toHaveLength(4)
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
  } finally { view.dispose() }
})
