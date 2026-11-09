// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelProvider } from '../src/client/provider.tsx'
import { TaskQuality } from '../src/client/task-quality.tsx'
import { TaskCandidates } from '../src/client/task-candidates.tsx'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import { candidateCatalog, combinationReceipt, combinationInputs } from './fixtures/task-candidates.ts'
import { qualityCatalog, qualityReceipt } from './fixtures/task-quality.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh, args?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (match, name: string) => args && name in args ? String(args[name]) : match)) as T
const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const deferred = () => { let resolve!: (value: Response) => void; return { promise: new Promise<Response>(done => { resolve = done }), resolve } }
function fixture() {
  const requests: { path: string; method: string; body?: unknown; query: string }[] = []
  const control = { catalog: candidateCatalog(), load: undefined as undefined | (() => Promise<Response>),
    prepare: undefined as undefined | (() => Promise<Response>),
    verify: undefined as undefined | ((body: Record<string, unknown>) => Promise<Response>) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, 'http://localhost'), path = parsed.pathname.replace('/orchestrator/api/', '')
    requests.push({ path, method: init?.method ?? 'GET', query: parsed.search, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (path === 'state') return Response.json({ load: { running: 0, queued: 0 } })
    if (path.endsWith('/quality')) return Response.json(qualityCatalog())
    if (path.endsWith('/candidates')) return control.load?.() ?? Response.json(control.catalog)
    if (path === 'development/combinations') return control.prepare?.() ?? Response.json(combinationReceipt(control.catalog))
    if (path.endsWith('/quality/verify-combination')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (control.verify) return control.verify(body)
      const combined = combinationReceipt(control.catalog)
      const baseReceipt = qualityReceipt()
      const source = { ...baseReceipt.binding.source, ...combined.combination.source! }
      return Response.json({ ...baseReceipt, combinationId: body.combinationId, requestId: body.requestId, persisted: true,
        checkedAt: '2026-11-08T00:00:00Z',
        binding: { ...baseReceipt.binding, repositoryId: source.repositoryId, source },
        verification: { ...baseReceipt.verification, sourceInputs: combinationInputs(source.tree),
          source: { ...baseReceipt.verification.source, ...source } } })
    }
    return Response.json({ error: '未预期请求' }, { status: 404 })
  }))
  return { requests, control, writes: () => requests.filter(item => item.method === 'POST'),
    reads: () => requests.filter(item => item.path.endsWith('/candidates')) }
}
async function render(integrated = false) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (id = 'task-a') => {
    await act(async () => root.render(<PanelProvider t={t} interval={60_000}>
      {integrated ? <TaskQuality key={id} id={id} /> : <TaskCandidates key={id} id={id} />}
    </PanelProvider>))
    await flush()
  }
  disposals.push(() => { act(() => root.unmount()); container.remove() })
  await update()
  const button = (key: keyof typeof zh) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === zh[key] || item.getAttribute('aria-label') === zh[key])!
  const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); await flush() }
  const toggle = () => click(container.querySelector<HTMLElement>('[data-disclosure-row]')!)
  return { container, update, button, click, toggle }
}

it('工程区域折叠零读取，展开读取一次；一次操作使用完整固定计划且不发布', async () => {
  const run = fixture(), view = await render(true)
  expect(run.reads()).toHaveLength(0)
  await view.toggle()
  expect(run.reads()).toHaveLength(1)
  const pending = deferred(); run.control.prepare = () => pending.promise
  const button = view.button('task.candidates.prepare')
  button.focus()
  await act(async () => { button.click(); button.click() })
  expect(run.writes()).toHaveLength(1)
  const plan = run.control.catalog.items[0]!.plan
  if (plan.state !== 'ready') throw new Error('测试需要可准备计划')
  expect(run.writes()[0]!.body).toEqual(plan.request)
  expect(view.button('task.candidates.refresh').disabled).toBe(true)
  pending.resolve(Response.json(combinationReceipt())); await flush()
  expect(view.container.textContent).toContain(zh['task.candidates.prepared'])
  expect(document.activeElement?.getAttribute('role')).toBe('status')
  expect(run.reads()).toHaveLength(1)
  expect(run.writes().every(item => item.path === 'development/combinations')).toBe(true)
})

it.each(['read', 'write'])('切换任务后迟到的 %s 不更新新任务或再次请求', async kind => {
  const run = fixture(), pending = deferred()
  if (kind === 'read') run.control.load = () => pending.promise
  const view = await render()
  if (kind === 'write') { run.control.prepare = () => pending.promise; await view.click(view.button('task.candidates.prepare')) }
  run.control.load = undefined
  run.control.catalog = { ...candidateCatalog('task-b'), items: [], total: 0 }
  await view.update('task-b')
  pending.resolve(Response.json(kind === 'read' ? candidateCatalog() : combinationReceipt()))
  await flush()
  expect(view.container.textContent).toContain(zh['task.candidates.empty'])
  expect(view.container.textContent).not.toContain(zh['task.candidates.prepared'])
  expect(run.reads()).toHaveLength(2)
})

it.each(['base', 'members', 'authority'])('不相符的 %s 回执不得显示已生成', async kind => {
  const run = fixture(), receipt = combinationReceipt(), view = await render()
  if (kind === 'base') receipt.combination.base.commit = '9'.repeat(40)
  if (kind === 'members') receipt.combination.candidates = ['9'.repeat(64)]
  const body = kind === 'authority' ? { ...receipt, publishAllowed: true } : receipt
  run.control.prepare = async () => Response.json(body)
  await view.click(view.button('task.candidates.prepare'))
  expect(view.container.textContent).toContain(zh['task.candidates.unconfirmed'])
  expect(view.container.textContent).not.toContain(zh['task.candidates.prepared'])
})

it.each(['conflicted', 'changed'])('组合 %s 不宣称验收通过，并保持结果可读', async kind => {
  const run = fixture(), receipt = combinationReceipt(), view = await render()
  if (kind === 'conflicted') { receipt.combination.phase = 'conflicted'; delete receipt.combination.source }
  else receipt.basisChanged = true
  run.control.prepare = async () => Response.json(receipt)
  await view.click(view.button('task.candidates.prepare'))
  expect(view.container.textContent).toContain(zh[kind === 'conflicted' ? 'task.candidates.conflicted' : 'task.candidates.changed'])
  expect(view.container.textContent).not.toContain(zh['task.candidates.prepared'])
})

it('失败不隐式重试，重新操作仍使用相同固定输入', async () => {
  const run = fixture(), view = await render()
  run.control.prepare = async () => Response.json({ error: 'candidate_operation_busy', message: '计算槽忙' }, { status: 409 })
  await view.click(view.button('task.candidates.prepare'))
  expect(run.writes()).toHaveLength(1)
  run.control.prepare = undefined
  await view.click(view.button('task.candidates.prepare'))
  expect(run.writes()).toHaveLength(2)
  expect(run.writes()[1]!.body).toEqual(run.writes()[0]!.body)
  expect(view.container.textContent).toContain(zh['task.candidates.prepared'])
})

it('分页携带目录快照，失败后重新读取回到首页', async () => {
  const run = fixture(); run.control.catalog.nextOffset = 8
  const view = await render()
  run.control.load = async () => Response.json({ error: 'candidate_catalog_changed', message: '目录已变化' }, { status: 409 })
  await view.click(view.button('task.candidates.next'))
  expect(new URLSearchParams(run.reads()[1]!.query).get('snapshot')).toBe(run.control.catalog.snapshot)
  expect(new URLSearchParams(run.reads()[1]!.query).get('offset')).toBe('8')
  run.control.load = undefined
  await view.click(view.button('task.candidates.refresh'))
  expect(run.reads()[2]!.query).toBe('')
})

it('旧后端无此能力时局部显示不可用，质量来源不受影响', async () => {
  const run = fixture(); run.control.load = async () => Response.json({ error: 'not_found' }, { status: 404 })
  const view = await render(true)
  await view.toggle()
  expect(view.container.textContent).toContain(zh['task.candidates.unavailable'])
  expect(view.container.textContent).toContain('module-quality')
  expect(view.button('task.quality.verify')).toBeTruthy()
  expect(run.writes()).toHaveLength(0)
})

it('未就绪依赖只给出当前阻塞，不提供可执行按钮', async () => {
  const run = fixture()
  run.control.catalog.items[0]!.plan = { state: 'blocked', reason: 'dependency_unavailable' }
  const view = await render()
  expect(view.container.textContent).toContain(zh['task.candidates.dependency'])
  expect(view.button('task.candidates.prepare')).toBeUndefined()
  expect(run.writes()).toHaveLength(0)
})

it('准备组合后原核验按钮改用组合入口，不发送目录或提交；旧起点优化建议不混用', async () => {
  const run = fixture(), view = await render(true)
  await view.toggle()
  await view.click(view.button('task.candidates.prepare'))
  expect(view.container.textContent).toContain(zh['task.quality.combinationBase'])
  await view.click(view.button('task.quality.verify'))
  const request = run.writes()[1]!
  expect(request.path).toBe('tasks/task-a/quality/verify-combination')
  expect(request.body).toMatchObject({ combinationId: 'e'.repeat(64), changeRevision: 1, profileRevision: 1 })
  expect(request.body).not.toHaveProperty('commit')
  expect(request.body).not.toHaveProperty('repositoryPath')
  expect(view.container.textContent).toContain(zh['task.quality.recorded'])
  expect(view.container.textContent).toContain('1200')
  expect(view.container.textContent).not.toContain(zh['task.optimization.title'])
})

it('组合核验迟到后不写入刷新后的登记起点，组合身份不符不显示成功', async () => {
  const run = fixture(), view = await render(true), pending = deferred()
  run.control.verify = () => pending.promise
  await view.toggle()
  await view.click(view.button('task.candidates.prepare'))
  await view.click(view.button('task.quality.verify'))
  await view.click(view.button('task.candidates.refresh'))
  pending.resolve(Response.json({ ...qualityReceipt(), combinationId: 'e'.repeat(64), requestId: 'stale', persisted: true }))
  await flush()
  expect(view.container.textContent).not.toContain(zh['task.quality.recorded'])
  expect(view.container.textContent).toContain(zh['task.quality.base'])
})

it.each(['wrong-combination', 'old-host'])('组合核验的 %s 不能退回旧起点核验或显示已保存', async scenario => {
  const run = fixture(), view = await render(true)
  run.control.verify = async body => {
    if (scenario === 'old-host') return Response.json({ error: 'not_found' }, { status: 404 })
    const receipt = qualityReceipt(), combo = combinationReceipt()
    return Response.json({ ...receipt, persisted: true, requestId: body.requestId, combinationId: 'f'.repeat(64),
      binding: { ...receipt.binding, repositoryId: combo.combination.source!.repositoryId,
        source: { ...receipt.binding.source, ...combo.combination.source } } })
  }
  await view.toggle()
  await view.click(view.button('task.candidates.prepare'))
  await view.click(view.button('task.quality.verify'))
  expect(view.container.textContent).not.toContain(zh['task.quality.recorded'])
  expect(run.writes().filter(item => item.path.endsWith('/verify-combination'))).toHaveLength(1)
  expect(run.writes().filter(item => item.path.endsWith('/verify-sources'))).toHaveLength(0)
})

it.each(['missing-inputs', 'wrong-tree'])('组合回执 %s 不能把局部来源核验显示为完整代码输入已核对', async scenario => {
  const run = fixture(), view = await render(true)
  run.control.verify = async body => {
    const receipt = qualityReceipt(), source = { ...receipt.binding.source, ...combinationReceipt().combination.source! }
    return Response.json({ ...receipt, persisted: true, requestId: body.requestId, combinationId: 'e'.repeat(64),
      binding: { ...receipt.binding, repositoryId: source.repositoryId, source },
      verification: { ...receipt.verification, source: { ...receipt.verification.source, ...source },
        ...(scenario === 'wrong-tree' ? { sourceInputs: combinationInputs('9'.repeat(40)) } : {}) } })
  }
  await view.toggle()
  await view.click(view.button('task.candidates.prepare'))
  await view.click(view.button('task.quality.verify'))
  expect(view.container.textContent).not.toContain(zh['task.quality.recorded'])
  expect(view.container.textContent).toContain(zh['task.quality.unconfirmed'])
  expect(run.writes()).toHaveLength(2)
})

it('代码树和配方的未闭合引用分别呈现，不相加造成重复计数', async () => {
  const run = fixture(), view = await render(true)
  run.control.verify = async body => {
    const receipt = qualityReceipt(), source = { ...receipt.binding.source, ...combinationReceipt().combination.source! }
    return Response.json({ ...receipt, persisted: true, requestId: body.requestId, combinationId: 'e'.repeat(64),
      binding: { ...receipt.binding, repositoryId: source.repositoryId, source },
      verification: { ...receipt.verification, source: { ...receipt.verification.source, ...source },
        status: 'references_unresolved', recipe: { ...receipt.verification.recipe, symlinks: 1 },
        sourceInputs: { ...combinationInputs(source.tree), status: 'references_unresolved', symlinks: 2 } } })
  }
  await view.toggle()
  await view.click(view.button('task.candidates.prepare'))
  await view.click(view.button('task.quality.verify'))
  expect(view.container.textContent).toContain(t('task.quality.inputReferences', { symlinks: 2, submodules: 0 }))
  expect(view.container.textContent).toContain(t('task.quality.references', { symlinks: 1, submodules: 0 }))
  expect(view.container.textContent).toContain(zh['task.quality.unresolved'])
})

it('刷新质量配置保留组合目标；关闭工程区域后才清除该访问的选择', async () => {
  const run = fixture(), view = await render(true)
  await view.toggle()
  await view.click(view.button('task.candidates.prepare'))
  await view.click(view.button('task.quality.refresh'))
  expect(view.container.textContent).toContain(zh['task.quality.combinationBase'])
  await view.click(view.button('task.quality.verify'))
  expect(run.writes().at(-1)!.path).toBe('tasks/task-a/quality/verify-combination')
  await view.toggle(); await view.toggle()
  expect(view.container.textContent).not.toContain(zh['task.quality.combinationBase'])
  expect(view.container.textContent).toContain(zh['task.quality.base'])
})
