// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession } from '../src/navigation.ts'
import { initialLocation, parseRoute, remember, setupPage } from '../src/client/route.ts'
const id = 'orchestrator-test' as SessionId
function fixture(ready = false) {
  const pending = Promise.withResolvers<void>()
  const state = { phase: ready ? 'ready' : 'pending', byId: ready ? { [id]: {} } : {} as Record<string, object> }
  const refresh = vi.fn(async () => { await pending.promise })
  // Navigation reads only catalog readiness and membership, not summary fields.
  const sessions = { list: { getSnapshot: () => state }, refresh } as unknown as Pick<ISessions, 'list' | 'refresh'>
  return { sessions, pending, state, refresh }
}
it('waits for initial catalog hydration before opening the linked master', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  expect(open).not.toHaveBeenCalled()
  state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
})
it('opens known Sessions without another network refresh', async () => {
  const { sessions, refresh } = fixture(true); const open = vi.fn()
  await expect(openKnownSession(sessions, id, open, new AbortController().signal)).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id); expect(refresh).not.toHaveBeenCalled()
})
it('reports unavailable targets without calling the throwing Session selector', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  state.phase = 'ready'; pending.resolve()
  await expect(navigation).rejects.toMatchObject({ code: 'not-listed' })
  expect(open).not.toHaveBeenCalled()
})
it('does not navigate after the panel unmounts or a newer request supersedes it', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn(); const controller = new AbortController()
  const navigation = openKnownSession(sessions, id, open, controller.signal)
  controller.abort(); state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(false); expect(open).not.toHaveBeenCalled()
})
it('reopens the page this tab showed last, and the overview for a route that no longer exists', () => {
  remember({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  // The Eval tab was previously named Policy; a route saved under the old name falls back to overview.
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'policy' }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' }, stack: [{ page: 'policy' }, { page: 'trigger' }] }))
  expect(initialLocation().stack).toEqual([{ page: 'trigger' }])
  sessionStorage.setItem('dsh-superagent/route', '{')
  expect(initialLocation().route).toEqual({ page: 'overview' })
})

it.each(['open', 'needs_answer', 'ended', 'all'] as const)('任务目录的 %s 筛选随导航历史恢复，只记范围不记分页内容', filter => {
  const route = { page: 'tasks' as const, query: { filter } }
  expect(parseRoute({ ...route, query: { filter, before: 'stale-cursor', offset: 50, dispatch: true } })).toEqual(route)
  remember({ route: { page: 'tasks', id: 'local-1' }, stack: [route] })
  expect(initialLocation()).toEqual({ route: { page: 'tasks', id: 'local-1' }, stack: [route] })
  remember({ route, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route, stack: [{ page: 'overview' }] })
})

it.each([undefined, null, 'question', 'running', '<script>', 1, ['needs_answer']].map(filter => ({ filter })))(
  '任务列表未知或旧筛选安全回到默认，不将查询值传入详情：$filter', ({ filter }) => {
    expect(parseRoute({ page: 'tasks', query: { filter } })).toEqual({ page: 'tasks' })
    expect(parseRoute({ page: 'tasks', id: 'local-1', query: { filter: 'needs_answer', before: 'stale' } }))
      .toEqual({ page: 'tasks', id: 'local-1' })
  })
it('reads each page a tab remembered with the parameters it takes, and leaves out what it does not know', () => {
  expect(parseRoute({ page: 'trigger', query: { filter: 'nope', trigger: 'e1' } })).toEqual({ page: 'trigger' })
  expect(parseRoute({ page: 'trigger', id: 'github:1', query: { trigger: 'e1', filter: 'recent' } }))
    .toEqual({ page: 'trigger', id: 'github:1', query: { trigger: 'e1' } })
  expect(parseRoute({ page: 'eval', query: { filter: 'stop', window: '7d' } })).toEqual({ page: 'eval', query: { filter: 'stop' } })
  expect(parseRoute({ page: 'execution', id: 5, query: { filter: 'idle' } })).toEqual({ page: 'execution', query: { filter: 'idle' } })
  expect(parseRoute({ page: 'tasks', id: 'local-1', query: { filter: 'ignored' } })).toEqual({ page: 'tasks', id: 'local-1' })
  expect(parseRoute({ page: 'tasks', query: { filter: 'ignored' } })).toEqual({ page: 'tasks' })
  expect(parseRoute({ page: 'settings', query: { group: 'policy', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'source', source: 'feishu' } })
  expect([parseRoute('overview'), parseRoute(null)]).toEqual([undefined, undefined])
})
it('opens the settings that fix each setup problem: the Deployment group, or the card of the Source it names', () => {
  expect(setupPage('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  for (const place of ['github', 'feishu'] as const) expect(setupPage(place)).toEqual({ page: 'settings', query: { group: 'source', source: place } })
})
