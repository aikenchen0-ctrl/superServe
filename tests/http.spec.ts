import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { HmmError } from '../src/hmm/model.ts'
import { LocalTaskListSchema } from '../src/app/task-list.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('总管模型观察沿用同源管理限制，拒绝外部来源且不执行读取', async () => {
  let reads = 0
  const call = serve({ controllerModel: async () => { reads++; return { sessionId: 'master' } } })
  expect(await call('GET', 'models/controller', undefined, { origin: 'https://external.example' }))
    .toMatchObject({ status: 403 })
  expect(reads).toBe(0)
  expect(await call('GET', 'models/controller')).toMatchObject({ status: 200, body: { sessionId: 'master' } })
  expect(reads).toBe(1)
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('质量配置与输入预览沿用同源管理边界，越权请求不进入领域方法', async () => {
  const save = vi.fn(() => ({})), get = vi.fn(() => ({})), preview = vi.fn(async () => ({})), verifySources = vi.fn(async () => ({}))
  const verifyTools = vi.fn(async () => ({}))
  const forTask = vi.fn(() => ({})), verifyTaskSources = vi.fn(async () => ({}))
  const call = serve({ developmentQuality: { save, get, preview, verifySources, verifyTools, forTask, verifyTaskSources } })
  for (const [method, route] of [['POST', 'development/quality-profiles'],
    ['GET', `development/quality-profiles/${'a'.repeat(64)}`], ['POST', 'development/quality-bindings/preview'],
    ['POST', 'development/quality-bindings/verify-sources'], ['POST', 'development/quality-bindings/verify-tools'],
    ['GET', 'tasks/t1/quality'], ['POST', 'tasks/t1/quality/verify-sources']]) {
    const result = await call(method!, route!, {}, { origin: 'https://other.example' })
    expect(result.status).toBe(403)
  }
  expect(save).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
  expect(preview).not.toHaveBeenCalled()
  expect(verifySources).not.toHaveBeenCalled()
  expect(verifyTools).not.toHaveBeenCalled()
  expect(forTask).not.toHaveBeenCalled()
  expect(verifyTaskSources).not.toHaveBeenCalled()
})

it('本地任务入口沿用同源保护，跨源请求不得创建、列出或翻页读取任务', async () => {
  const inputs: unknown[] = [], reads: unknown[] = []
  const call = serve({ tasks: {
    create: (input: unknown) => { inputs.push(input); return { ticketId: 't1' } },
    list: (query: unknown) => { reads.push(query); return { items: [], nextBefore: null } },
    resume: (id: string, input: unknown) => { inputs.push({ id, input }); return { ticketId: id } },
    blockers: (id: string, query: unknown) => { reads.push({ id, query }); return { items: [], nextOffset: null } },
  } })
  const body = { requestId: 'request-1', goal: '检查目标' }
  expect(await call('POST', 'tasks', body, { origin: 'https://other.example' })).toMatchObject({ status: 403 })
  expect(await call('POST', 'tasks', body, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(await call('GET', 'tasks', undefined, { origin: 'https://other.example' })).toMatchObject({ status: 403 })
  expect(await call('GET', 'tasks', undefined, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  for (const headers of [{ origin: 'https://other.example' }, { 'x-orchestrator-request': undefined }]) {
    expect(await call('POST', 'tasks/t1/resume', { revision: 1, nodeId: 'step' }, headers)).toMatchObject({ status: 403 })
    expect(await call('GET', 'tasks/t1/blockers?revision=1&offset=4', undefined, headers)).toMatchObject({ status: 403 })
  }
  expect(inputs).toEqual([])
  expect(reads).toEqual([])
  expect(await call('POST', 'tasks', body)).toMatchObject({ status: 200, body: { ticketId: 't1' } })
  expect(inputs).toEqual([body])
  expect(await call('GET', 'tasks')).toMatchObject({ status: 200, body: { items: [], nextBefore: null } })
  expect(reads).toEqual([{}])
  expect(await call('GET', 'tasks/t1/blockers?revision=1&offset=4'))
    .toMatchObject({ status: 200, body: { items: [], nextOffset: null } })
  expect(reads.at(-1)).toEqual({ id: 't1', query: { revision: '1', offset: '4' } })
})

it.each(['open', 'needs_answer', 'ended', 'all'])('可选目录展示保留%s选择范围，仅待答范围附带节选', async state => {
  const call = serve({ tasks: { list: (query: unknown) => LocalTaskListSchema.parse(query) } })
  const q = 'module %_\\ review', before = 'scope/older+1'
  const route = `tasks?state=${state}&q=${encodeURIComponent(q)}&before=${encodeURIComponent(before)}&limit=7`
  const selected = { state, q, before, limit: 7 }
  expect(await call('GET', route)).toEqual({ status: 200, body: selected })
  expect(await call('GET', route, undefined, { 'x-orchestrator-task-view': 'questions' })).toEqual({
    status: 200, body: { ...selected, attention: 'questions', ...(state === 'needs_answer' ? { preview: 'question' } : {}) },
  })
  expect(await call('GET', route, undefined, { 'x-orchestrator-task-view': 'unknown' })).toEqual({ status: 200, body: selected })
})

it('目录展示偏好不能放宽参数或权限，原查询展示契约保持有效', async () => {
  const list = vi.fn((query: unknown) => LocalTaskListSchema.parse(query)), call = serve({ tasks: { list } })
  const headers = { 'x-orchestrator-task-view': 'questions' }
  for (const query of ['state=invalid', 'limit=0', 'before=', `q=${'a'.repeat(101)}`, 'attention=all', 'preview=all', 'unexpected=1']) {
    expect(await call('GET', `tasks?${query}`, undefined, headers)).toMatchObject({ status: 400 })
  }
  list.mockClear()
  for (const denied of [{ origin: 'https://external.example' }, { 'x-orchestrator-request': undefined }])
    expect(await call('GET', 'tasks', undefined, { ...headers, ...denied })).toMatchObject({ status: 403 })
  expect(list).not.toHaveBeenCalled()
  expect(await call('GET', 'tasks?attention=questions&preview=question')).toMatchObject({
    status: 200, body: { attention: 'questions', preview: 'question' },
  })
})

it('输入状态投影仅在保存成功且显式请求时读取，同源和保存拒绝不能被展示偏好绕过', async () => {
  const input = vi.fn(() => ({ ticketId: 't1', inputId: 'input-1', created: true }))
  const status = vi.fn(() => ({ ticketId: 't1' }))
  const call = serve({ store: { atomic: (work: () => unknown) => work() }, tasks: { input, status } })
  const headers = { 'x-orchestrator-task-view': 'state' }
  for (const denied of [{ origin: 'https://external.example' }, { 'x-orchestrator-request': undefined }])
    expect(await call('POST', 'tasks/t1/inputs', {}, { ...headers, ...denied })).toMatchObject({ status: 403 })
  expect(input).not.toHaveBeenCalled()
  expect(status).not.toHaveBeenCalled()
  for (const preference of [undefined, 'unknown'])
    expect(await call('POST', 'tasks/t1/inputs', {}, { 'x-orchestrator-task-view': preference }))
      .toEqual({ status: 200, body: { ticketId: 't1', inputId: 'input-1', created: true } })
  expect(status).not.toHaveBeenCalled()
  input.mockImplementationOnce(() => { throw new HmmError('scope_denied', 'Permission denied', 403) })
  expect(await call('POST', 'tasks/t1/inputs', {}, headers)).toMatchObject({ status: 403 })
  expect(status).not.toHaveBeenCalled()
  expect(await call('POST', 'tasks/t1/inputs', {}, headers))
    .toEqual({ status: 200, body: { ticketId: 't1', inputId: 'input-1', created: true, task: { ticketId: 't1' } } })
  expect(status).toHaveBeenCalledExactlyOnceWith('t1')
})

it('优化建议沿用同源管理边界，拒绝请求不得读取或处理建议', async () => {
  const save = vi.fn(() => ({})), list = vi.fn(() => ({})), decide = vi.fn(() => ({}))
  const call = serve({ optimizationSuggestions: { save, list, decide } })
  for (const [method, route] of [['POST', 'tasks/t1/quality/suggestions'],
    ['GET', 'tasks/t1/quality/suggestions'], ['POST', `tasks/t1/quality/suggestions/${'a'.repeat(64)}/decision`]]) {
    for (const headers of [{ origin: 'https://other.example' }, { 'x-orchestrator-request': undefined }])
      expect(await call(method!, route!, {}, headers)).toMatchObject({ status: 403 })
  }
  expect(save).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
  expect(decide).not.toHaveBeenCalled()
})

it('报告核对沿用同源边界，拒绝请求不得读取目录或保存记录', async () => {
  const list = vi.fn(() => ({})), capture = vi.fn(async () => ({})), file = vi.fn(() => ({}))
  const call = serve({ optimizationReports: { list, capture, file } })
  for (const method of ['GET', 'POST']) {
    for (const headers of [{ origin: 'https://other.example' }, { 'x-orchestrator-request': undefined }])
      expect(await call(method, `tasks/t1/quality/suggestions/${'a'.repeat(64)}/reports`,
        { directory: 'O:/reports' }, headers)).toMatchObject({ status: 403 })
  }
  expect(list).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
  for (const headers of [{ origin: 'https://other.example' }, { 'x-orchestrator-request': undefined }])
    expect(await call('GET', `tasks/t1/quality/suggestions/${'a'.repeat(64)}/reports/${'b'.repeat(64)}/file?name=summary.json`,
      undefined, headers)).toMatchObject({ status: 403 })
  expect(file).not.toHaveBeenCalled()
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('计划身份核对沿用同源与面板标记保护，拒绝请求不触发领域读取', async () => {
  const reads: string[] = []
  const call = serve({ hmm: { planIdentity: (_actor: unknown, id: string) => {
    reads.push(id)
    return { ticketId: id, revision: 3, planVersion: 1, fingerprint: 'a'.repeat(64) }
  } } })
  for (const headers of [{ origin: 'https://other.example' }, { 'x-orchestrator-request': undefined }])
    expect(await call('GET', 'tickets/t1/hmm/plan-identity', undefined, headers)).toMatchObject({ status: 403 })
  expect(reads).toEqual([])
  expect(await call('GET', 'tickets/t1/hmm/plan-identity')).toMatchObject({
    status: 200, body: { ticketId: 't1', revision: 3, planVersion: 1, fingerprint: 'a'.repeat(64) },
  })
  expect(reads).toEqual(['t1'])
})

it('非闭环错误保持原返回结构，不附带未确认的诊断字段', async () => {
  const call = serve({ hmm: { revise: () => {
    throw new HmmError('revision_conflict', '计划已经更新', 409, [
      { nodeId: 'a', dependencyId: 'b', kind: 'explicit' }, { nodeId: 'b', dependencyId: 'a', kind: 'serial' },
    ])
  } } })
  expect(await call('POST', 'tickets/t1/hmm/revisions', {})).toEqual({
    status: 409, body: { error: '计划已经更新', code: 'revision_conflict' },
  })
})
