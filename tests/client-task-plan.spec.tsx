// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { PanelProvider } from '../src/client/provider.tsx'
import { TaskPlan } from '../src/client/task-plan.tsx'
import { TasksPage } from '../src/client/tasks.tsx'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
type Definition = ApiResponse<'GET tickets/:id/hmm/plan'>
type Impact = ApiResponse<'POST tickets/:id/hmm/revisions'>
type Request = { path: string; method: string; body?: Record<string, unknown> }
const t = ((key: keyof typeof zh, values?: Record<string, unknown>) =>
  zh[key].replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)) as T
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
function initial(): Definition {
  const node = (id: string, parentId?: string, mode: 'task' | 'serial' | 'parallel' = 'task', dependsOn: string[] = []) => ({
    id, parentId, title: `Title ${id}`, mode, dependsOn, evidenceRequired: mode === 'task', claimsRequired: id === 'review',
    instruction: mode === 'task' ? `Check ${id}` : undefined,
  })
  return { revision: 3, planVersion: 1, limits: { nodes: 64 }, retiredNodeIds: [], prunedNodeIds: [], plan: {
    goal: 'Compare authorized sources', maxActive: 2, nodes: [
      node('root', undefined, 'parallel'), node('sequence', 'root', 'serial'),
      node('first', 'sequence'), node('second', 'sequence', 'task', ['first']),
      node('other', 'root'), node('review', 'root', 'task', ['sequence', 'other']),
    ],
  } }
}
function fixture() {
  const requests: Request[] = []
  const control = {
    definition: initial(),
    read: undefined as undefined | (() => Promise<Response>),
    identity: undefined as undefined | (() => Promise<Response>),
    inspect: undefined as undefined | (() => Promise<Response>),
    apply: undefined as undefined | (() => Promise<Response>),
  }
  const impact = (applied = false): Impact => ({
    ticketId: 'task-1', applied, revision: control.definition.revision + Number(applied),
    planVersion: control.definition.planVersion + Number(applied), candidatePlanVersion: control.definition.planVersion + 1,
    snapshotBytes: 2048, added: [], removed: [], changed: ['first'], invalidated: ['first', 'second', 'review'],
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname.replace('/orchestrator/api/', '')
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) as Request['body'] : undefined
    requests.push({ path, method, body })
    if (path === 'state') return Response.json({ load: { running: 0, queued: 0 } })
    if (path === 'tickets/task-1/hmm/plan') return control.read?.() ?? Response.json(control.definition)
    if (path === 'tickets/task-1/hmm/plan-identity') return control.identity?.() ?? Response.json({
      ticketId: 'task-1', revision: control.definition.revision, planVersion: control.definition.planVersion,
      fingerprint: control.definition.fingerprint,
    })
    if (path === 'tickets/task-1/hmm/revisions')
      return body?.preview ? control.inspect?.() ?? Response.json(impact()) : control.apply?.() ?? Response.json(impact(true))
    return Response.json({ error: 'Unexpected request' }, { status: 404 })
  }))
  return { control, requests, impact, reads: () => requests.filter(item => item.path.endsWith('/plan')),
    checks: () => requests.filter(item => item.path.endsWith('/plan-identity')),
    writes: () => requests.filter(item => item.method === 'POST') }
}
async function render(overrides: Partial<ComponentProps<typeof TaskPlan>> = {}) {
  const props = { id: 'task-1', revision: 3, planVersion: 1, editable: true,
    onChanged: vi.fn(async () => {}), onDiscuss: vi.fn(), discussDisabled: false, ...overrides }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let disposed = false
  const update = async (next: Partial<typeof props> = {}) => {
    Object.assign(props, next)
    await act(async () => { root.render(<PanelProvider t={t} interval={60_000}><TaskPlan {...props} /></PanelProvider>) })
    await flush()
  }
  const dispose = () => { if (!disposed) { act(() => root.unmount()); container.remove(); disposed = true } }
  cleanups.push(dispose)
  await update()
  const button = (label: string, scope: ParentNode = container) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  const history = (kind: 'undo' | 'redo') => container.querySelector<HTMLButtonElement>(`[aria-label="${zh[`task.plan.${kind}`]}"]`)!
  const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); await flush() }
  const open = () => click(container.querySelector<HTMLElement>('[data-disclosure-row]')!)
  const field = (label: string) => [...container.querySelectorAll('label')]
    .find(item => item.querySelector('span')?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')!
  const fill = async (label: string, text: string) => {
    const element = field(label), prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const draft = async () => {
    await open(); await click(button('Title first'))
    await fill(zh['task.plan.instruction'], 'Check the corrected source')
    await fill(zh['task.plan.reason'], 'Source scope clarified')
  }
  return { container, props, update, dispose, button, click, open, field, fill, draft,
    openChange: (title: string) => click([...container.querySelectorAll<HTMLElement>('.dt-task-plan-changes [data-disclosure-row]')]
      .find(row => row.querySelector('.dt-task-plan-change-name')?.textContent === title)!),
    history, undo: () => click(history('undo')), redo: () => click(history('redo')),
    selectParent: async (parentId: string) => {
      const element = field(zh['task.plan.parent'])
      await act(async () => { element.value = parentId; element.dispatchEvent(new Event('change', { bubbles: true })) })
    },
    preview: () => click(button(zh['task.plan.preview'])), apply: () => click(button(zh['task.plan.apply'])) }
}

it('用途修改参与预览与撤销，复制调查步骤保留用途及核验要求', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title first'))
  await view.click(view.button(zh['task.plan.survey']))
  await view.fill(zh['task.plan.reason'], 'Separate bounded source extraction')
  await view.preview()
  const edited = (run.writes()[0]!.body!.plan as Definition['plan']).nodes.find(node => node.id === 'first')!
  expect(edited).toMatchObject({ purpose: 'survey', evidenceRequired: true })
  await view.openChange('Title first')
  const comparison = view.container.querySelector('.dt-task-plan-comparison')!
  expect(comparison.textContent).toContain(zh['task.plan.purpose'])
  expect(comparison.textContent).toContain(zh['task.plan.reasoning'])
  expect(comparison.textContent).toContain(zh['task.plan.survey'])
  await view.undo()
  expect(view.button(zh['task.plan.reasoning']).getAttribute('aria-selected')).toBe('true')
  await view.redo()
  expect(view.button(zh['task.plan.survey']).getAttribute('aria-selected')).toBe('true')
  await view.click(view.button(zh['task.plan.copy']))
  await view.preview()
  const copied = (run.writes().at(-1)!.body!.plan as Definition['plan']).nodes
    .find(node => node.id !== 'first' && node.instruction === edited.instruction)!
  expect(copied).toMatchObject({ purpose: 'survey', evidenceRequired: true })
})

it('折叠时不读计划，展开只读一次；名称、说明、层级及原有核验要求保持完整', async () => {
  const run = fixture(), view = await render()
  expect(run.reads()).toHaveLength(0)
  await view.open()
  expect(run.reads()).toHaveLength(1)
  expect(view.container.querySelectorAll('.dt-task-plan-tree > li')).toHaveLength(6)
  await view.click(view.button('Title first'))
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check first')
  expect(view.container.textContent).not.toContain('task-1')
  await view.open(); await view.open()
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toEqual([])
})

it('编辑、预览、应用使用同一完整候选，成功后不派发且只刷新详情', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  expect(run.writes()).toHaveLength(1)
  const candidate = run.writes()[0]!.body!
  const plan = structuredClone(run.control.definition.plan)
  plan.nodes.find(node => node.id === 'first')!.instruction = 'Check the corrected source'
  expect(candidate).toEqual({ revision: 3, plan, reason: 'Source scope clarified', preview: true })
  expect(view.props.onChanged).not.toHaveBeenCalled()
  expect(view.container.querySelector('.dt-task-plan-affected')?.textContent).toContain('Title second')
  expect(view.container.textContent).toContain(zh['task.plan.consequences'])
  await view.apply()
  expect(run.writes().map(item => item.body)).toEqual([candidate, { ...candidate, preview: false }])
  expect(view.container.textContent).toContain(zh['task.plan.saved'])
  expect(view.props.onChanged).toHaveBeenCalledOnce()
  expect(run.requests.some(item => item.path.includes('commands') || item.path.includes('resume'))).toBe(false)
})

it('有效预览接续提交焦点到结果区域，保留候选且不自动应用或增加请求', async () => {
  const run = fixture(), pending = Promise.withResolvers<Response>(), view = await render()
  run.control.inspect = () => pending.promise
  await view.draft()
  const submit = view.button(zh['task.plan.preview'])
  submit.focus()
  await view.preview()
  expect(submit.disabled).toBe(true)
  expect(view.container.querySelector('.dt-task-plan-preview')).toBeNull()
  await act(async () => pending.resolve(Response.json(run.impact())))
  const result = view.container.querySelector('.dt-task-plan-preview')!
  expect(document.activeElement).toBe(result)
  expect(result.getAttribute('aria-label')).toBe(zh['task.plan.previewResult'])
  expect(result.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).not.toBe(view.button(zh['task.plan.apply']))
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.field(zh['task.plan.reason']).value).toBe('Source scope clarified')
  expect(run.writes()).toHaveLength(1)
  expect(run.writes()[0]!.body!.preview).toBe(true)
  expect(view.props.onChanged).not.toHaveBeenCalled()
  await view.apply()
  expect(run.writes()[1]!.body).toEqual({ ...run.writes()[0]!.body, preview: false })
})

it('等待预览时已移到其他控件，迟到的有效结果不抢焦点，编辑仍使原候选失效', async () => {
  const run = fixture(), pending = Promise.withResolvers<Response>(), view = await render()
  run.control.inspect = () => pending.promise
  await view.draft()
  view.button(zh['task.plan.preview']).focus()
  await view.preview()
  const elsewhere = document.createElement('button')
  elsewhere.textContent = 'Another action'
  document.body.append(elsewhere)
  cleanups.push(() => elsewhere.remove())
  elsewhere.focus()
  await act(async () => pending.resolve(Response.json(run.impact())))
  expect(view.container.querySelector('.dt-task-plan-preview')).not.toBeNull()
  expect(document.activeElement).toBe(elsewhere)
  const reason = view.field(zh['task.plan.reason'])
  reason.focus()
  await view.fill(zh['task.plan.reason'], 'Review the updated scope')
  expect(view.container.querySelector('.dt-task-plan-preview')).toBeNull()
  expect(document.activeElement).toBe(reason)
  expect(run.writes()).toHaveLength(1)
})

it.each(['revision', 'planVersion', 'readonly', 'collapsed'] as const)(
  '%s变化后到达的预览不触发定位，重新展开也不补做旧焦点动作', async condition => {
    const run = fixture(), pending = Promise.withResolvers<Response>(), view = await render()
    run.control.inspect = () => pending.promise
    await view.draft()
    view.button(zh['task.plan.preview']).focus()
    await view.preview()
    if (condition === 'readonly') await view.update({ editable: false })
    else if (condition === 'collapsed') {
      view.container.querySelector<HTMLElement>('[data-disclosure-row]')!.focus()
      await view.open()
    } else await view.update({ [condition]: view.props[condition] + 1 })
    const focus = document.activeElement
    await act(async () => pending.resolve(Response.json(run.impact())))
    expect(document.activeElement).toBe(focus)
    if (condition === 'readonly') expect(view.button(zh['task.plan.apply']).disabled).toBe(true)
    else expect(view.container.querySelector('.dt-task-plan-preview')).toBeNull()
    if (condition === 'collapsed') {
      await view.open()
      expect(view.container.querySelector('.dt-task-plan-preview')).not.toBeNull()
      expect(document.activeElement).toBe(focus)
      expect(run.reads()).toHaveLength(1)
    }
    expect(run.writes()).toHaveLength(1)
  })

it('未确认的预览回执不创建可定位结果，离页后的响应也不能移动其他页面的焦点', async () => {
  const run = fixture(), view = await render()
  await view.draft()
  run.control.inspect = async () => Response.json({ ...run.impact(), ticketId: 'another-task' })
  const submit = view.button(zh['task.plan.preview'])
  submit.focus()
  await view.preview()
  expect(view.container.querySelector('.dt-task-plan-preview')).toBeNull()
  expect(document.activeElement).toBe(submit)
  const pending = Promise.withResolvers<Response>()
  run.control.inspect = () => pending.promise
  await view.preview()
  view.dispose()
  const elsewhere = document.createElement('button')
  elsewhere.textContent = 'New page action'
  document.body.append(elsewhere)
  cleanups.push(() => elsewhere.remove())
  elsewhere.focus()
  await act(async () => pending.resolve(Response.json(run.impact())))
  expect(document.activeElement).toBe(elsewhere)
  expect(run.writes()).toHaveLength(2)
  expect(view.props.onChanged).not.toHaveBeenCalled()
})

it('同级顺序、分组方式与依赖均进入完整候选；再次编辑立即使旧预览失效', async () => {
  const run = fixture(), view = await render()
  await view.open()
  await view.click(view.button('Title root'))
  await view.click(view.button(zh['task.plan.serial']))
  await view.click(view.container.querySelector<HTMLButtonElement>('[aria-label="下移：Title sequence"]')!)
  await view.click(view.button('Title other'))
  const dependency = [...view.container.querySelectorAll('label')].find(label => label.textContent === 'Title sequence')!
  await view.click(dependency.querySelector('input')!)
  await view.fill(zh['task.plan.reason'], 'Change ordering')
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan']
  expect(plan.nodes[0]!.mode).toBe('serial')
  expect(plan.nodes.filter(node => node.parentId === 'root').map(node => node.id)).toEqual(['other', 'sequence', 'review'])
  expect(plan.nodes.find(node => node.id === 'other')!.dependsOn).toEqual(['sequence'])
  expect(plan.goal).toBe(run.control.definition.plan.goal)
  expect(plan.maxActive).toBe(2)
  await view.fill(zh['task.plan.name'], 'Revised title')
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
})

it.each(['revision', 'planVersion'] as const)('%s变化保留草稿但旧预览不能应用，也不自动读取或重放', async field => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  await view.update({ [field]: view.props[field] + 1 })
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.container.textContent).toContain(zh['task.plan.changed'])
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toHaveLength(1)
})

it('预览依赖环被拒绝后仍可修改，版本冲突则保留稿并禁止旧版重试', async () => {
  const run = fixture(), view = await render()
  await view.draft()
  run.control.inspect = async () => Response.json({ error: '依赖形成循环', code: 'invalid_plan' }, { status: 400 })
  await view.preview()
  expect(view.container.textContent).toContain('依赖形成循环')
  expect(view.field(zh['task.plan.instruction']).matches(':disabled')).toBe(false)
  run.control.inspect = async () => Response.json({ error: '版本冲突', code: 'revision_conflict' }, { status: 409 })
  await view.preview()
  expect(view.props.onChanged).toHaveBeenCalledOnce()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  expect(run.writes()).toHaveLength(2)
})

it.each(['network', 'wrong-ticket', 'incomplete-impact', 'wrong-version'] as const)(
  '应用结果为%s时不自动重试，保留稿并要求核对', async failure => {
    const run = fixture(), view = await render()
    await view.draft(); await view.preview()
    run.control.apply = async () => {
      if (failure === 'network') throw new Error('Connection lost')
      return Response.json({ ...run.impact(true), ...(failure === 'wrong-ticket' ? { ticketId: 'another' }
        : failure === 'wrong-version' ? { candidatePlanVersion: 99 } : { invalidated: undefined }) })
    }
    await view.apply()
    expect(view.container.textContent).toContain(zh['task.plan.unconfirmed'])
    expect(view.container.textContent).not.toContain(zh['task.plan.saved'])
    expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
    expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
    expect(run.writes()).toHaveLength(2)
  })

it('应用409保留草稿，只刷新详情，不换版本重放', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  run.control.apply = async () => Response.json({ error: '版本冲突', code: 'revision_conflict' }, { status: 409 })
  await view.apply()
  expect(view.container.textContent).toContain(zh['task.plan.changed'])
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.props.onChanged).toHaveBeenCalledOnce()
  expect(run.writes()).toHaveLength(2)
})

it('读取、预览和应用互斥；长按或重复提交不产生额外请求', async () => {
  const run = fixture(), view = await render(), pending = Promise.withResolvers<Response>()
  await view.draft()
  run.control.inspect = () => pending.promise
  await view.preview()
  expect(view.button(zh['task.plan.reload']).disabled).toBe(true)
  expect(view.field(zh['task.plan.instruction']).matches(':disabled')).toBe(true)
  await act(async () => {
    view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    view.button(zh['task.plan.reload']).click()
  })
  expect(run.writes()).toHaveLength(1)
  expect(run.reads()).toHaveLength(1)
  await act(async () => pending.resolve(Response.json(run.impact())))
  const applied = Promise.withResolvers<Response>()
  run.control.apply = () => applied.promise
  await act(async () => { view.button(zh['task.plan.apply']).click(); view.button(zh['task.plan.apply']).click() })
  expect(run.writes()).toHaveLength(2)
  expect(view.button(zh['task.plan.reload']).disabled).toBe(true)
  expect(view.history('undo').disabled).toBe(true)
  expect(view.history('redo').disabled).toBe(true)
  await act(async () => applied.resolve(Response.json(run.impact(true))))
  expect(view.container.textContent).toContain(zh['task.plan.saved'])
})

it('取消重读不丢草稿也不请求；确认重读失败保留稿，成功后才替换', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  await view.click(view.button(zh['task.plan.reload']))
  await view.click(view.button(zh.cancel, document.body))
  expect(run.reads()).toHaveLength(1)
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  run.control.read = async () => Response.json({ error: '读取暂时失败' }, { status: 503 })
  await view.click(view.button(zh['task.plan.reload']))
  await view.click(view.button(zh.confirm, document.body))
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  run.control.read = undefined
  await view.click(view.button(zh['task.plan.reload']))
  await view.click(view.button(zh.confirm, document.body))
  await view.click(view.button('Title first'))
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check first')
  expect(view.field(zh['task.plan.reason']).value).toBe('')
})

it.each(['inactive', 'pruned'] as const)('%s计划可查阅，但不能修改、预览或应用', async state => {
  const run = fixture()
  if (state === 'pruned') run.control.definition.prunedNodeIds = ['first']
  const view = await render({ editable: state !== 'inactive' })
  await view.open(); await view.click(view.button('Title first'))
  expect(view.field(zh['task.plan.instruction']).matches(':disabled')).toBe(true)
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  if (state === 'pruned') {
    await view.click(view.button(zh['task.openOrchestrator']))
    expect(view.props.onDiscuss).toHaveBeenCalledOnce()
  }
  expect(run.writes()).toEqual([])
})

it('预览后权限收回时不能应用；迟到预览不会在失效版本上开放应用', async () => {
  const run = fixture(), view = await render(), pending = Promise.withResolvers<Response>()
  await view.draft()
  run.control.inspect = () => pending.promise
  await view.preview(); await view.update({ revision: 4, editable: false })
  await act(async () => pending.resolve(Response.json(run.impact())))
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(run.writes()).toHaveLength(1)
})

it.each(['read', 'inspect', 'apply'] as const)('离页后迟到的%s回执不刷新旧任务或提示结果', async action => {
  const run = fixture(), view = await render(), pending = Promise.withResolvers<Response>()
  if (action === 'read') { run.control.read = () => pending.promise; await view.open() }
  else {
    await view.draft()
    if (action === 'inspect') { run.control.inspect = () => pending.promise; await view.preview() }
    else { await view.preview(); run.control.apply = () => pending.promise; await view.apply() }
  }
  view.dispose()
  await act(async () => pending.resolve(Response.json(action === 'read' ? run.control.definition : run.impact(action === 'apply'))))
  expect(view.props.onChanged).not.toHaveBeenCalled()
  expect(document.querySelector('[role="status"]')).toBeNull()
})

it('不完整预览回执不呈现可应用结果，无效读取不会崩溃', async () => {
  const run = fixture(), view = await render()
  run.control.read = async () => Response.json({})
  await view.open()
  expect(view.container.textContent).toContain(zh['task.plan.readUnconfirmed'])
  run.control.read = undefined
  await view.click(view.button(zh['task.plan.reload']))
  await view.click(view.button('Title first'))
  await view.fill(zh['task.plan.instruction'], 'Corrected')
  await view.fill(zh['task.plan.reason'], 'Correction')
  run.control.inspect = async () => Response.json({ ...run.impact(), invalidated: null })
  await view.preview()
  expect(view.container.textContent).toContain(zh['task.plan.unconfirmed'])
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(view.container.querySelector('.dt-task-plan-changes')).toBeNull()
})

it('预览按实际候选列出修改字段，展开前后说明不增加读取、写入或确认步骤', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  const details = view.container.querySelector('.dt-task-plan-changes')!
  expect(details.textContent).toContain('Title first')
  expect(details.textContent).toContain(zh['task.plan.instruction'])
  expect(details.querySelector('.dt-task-plan-comparison')).toBeNull()
  const row = details.querySelector<HTMLElement>('[data-disclosure-row]')!
  await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const comparison = details.querySelector('.dt-task-plan-comparison')!
  expect([...comparison.querySelectorAll('dt')].map(item => item.textContent)).toEqual([zh['task.plan.instruction']])
  expect([...comparison.querySelectorAll('dd p')].map(item => item.textContent))
    .toEqual(['Check first', 'Check the corrected source'])
  await view.openChange('Title first')
  expect(details.querySelector('.dt-task-plan-comparison')).toBeNull()
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toHaveLength(1)
  await view.apply()
  expect(run.writes()[1]!.body).toEqual({ ...run.writes()[0]!.body, preview: false })
})

it.each(['explicit', 'serial', 'both'] as const)('%s闭环以名称解释约束，可定位并保留草稿，由操作者修正后重新预览', async kind => {
  const run = fixture()
  if (kind === 'explicit') run.control.definition.plan.nodes.find(node => node.id === 'sequence')!.mode = 'parallel'
  if (kind === 'serial') run.control.definition.plan.nodes.find(node => node.id === 'second')!.dependsOn = []
  run.control.inspect = async () => Response.json({ error: '显式依赖与串行顺序构成循环', code: 'dependency_cycle', cycle: [
    { nodeId: 'first', dependencyId: 'second', kind: 'explicit' }, { nodeId: 'second', dependencyId: 'first', kind },
  ] }, { status: 400 })
  const view = await render()
  await view.open(); await view.click(view.button('Title first'))
  await view.fill(zh['task.plan.instruction'], 'Compare the corrected scope')
  await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
  await view.fill(zh['task.plan.reason'], 'Reconsider prerequisites'); await view.preview()
  const help = view.container.querySelector('.dt-task-plan-cycle')!
  expect(document.activeElement).toBe(help)
  expect(help.textContent).toContain('Title first')
  expect(help.textContent).toContain('Title second')
  expect(help.querySelectorAll('li')).toHaveLength(2)
  expect([...help.querySelectorAll('p.dt-event-text')].map(item => item.textContent).at(-1))
    .toBe(t(kind === 'explicit' ? 'task.plan.cycleExplicit' : kind === 'serial' ? 'task.plan.cycleSerial' : 'task.plan.cycleBoth',
      { node: 'Title second', dependency: 'Title first' }))
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(view.field(zh['task.plan.reason']).value).toBe('Reconsider prerequisites')
  expect(view.props.onChanged).not.toHaveBeenCalled()
  if (kind !== 'explicit') {
    await view.click(view.button(zh['task.plan.inspectGroup'], help))
    expect(view.field(zh['task.plan.name']).value).toBe('Title sequence')
    expect(document.activeElement).toBe(view.field(zh['task.plan.name']))
    expect(view.container.querySelector('.dt-task-plan-cycle')).not.toBeNull()
  }
  await view.click(view.button(zh['task.plan.inspectStep'], help))
  expect(view.field(zh['task.plan.name']).value).toBe('Title first')
  expect(document.activeElement).toBe(view.field(zh['task.plan.name']))
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toHaveLength(1)
  await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
  expect(view.container.querySelector('.dt-task-plan-cycle')).toBeNull()
  run.control.inspect = undefined
  await view.preview(); await view.apply()
  expect(run.writes()).toHaveLength(3)
  expect((run.writes()[1]!.body!.plan as Definition['plan']).nodes.find(node => node.id === 'first')!.dependsOn).toEqual([])
})

it('同名步骤的闭环可区分身份，服务端编号和用户提供的HTML不作为界面代码显示', async () => {
  const run = fixture()
  const first = run.control.definition.plan.nodes.find(node => node.id === 'first')!
  const second = run.control.definition.plan.nodes.find(node => node.id === 'second')!
  first.id = 'private_a'; second.id = 'private_b'
  first.title = second.title = '<b>Duplicate</b>'
  first.dependsOn = []; second.dependsOn = ['private_a']
  run.control.inspect = async () => Response.json({ error: 'Cycle', code: 'dependency_cycle', cycle: [
    { nodeId: 'private_a', dependencyId: 'private_b', kind: 'explicit' },
    { nodeId: 'private_b', dependencyId: 'private_a', kind: 'both' },
  ] }, { status: 400 })
  const view = await render()
  await view.open(); await view.click(view.button('<b>Duplicate</b>（同名 1）'))
  await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
  await view.fill(zh['task.plan.instruction'], 'Clarify source scope')
  await view.fill(zh['task.plan.reason'], 'Review prerequisites'); await view.preview()
  const help = view.container.querySelector('.dt-task-plan-cycle')!
  expect(help.textContent).toContain('<b>Duplicate</b>（同名 1）')
  expect(help.textContent).toContain('<b>Duplicate</b>（同名 2）')
  expect(help.textContent).not.toContain('private_a')
  expect(help.querySelector('b')).toBeNull()
})

it('预览期间转到其他控件时，迟到的闭环提示不抢回焦点', async () => {
  const run = fixture(), pending = Promise.withResolvers<Response>()
  run.control.inspect = () => pending.promise
  const view = await render()
  await view.draft()
  await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
  await view.preview()
  const elsewhere = document.createElement('button')
  elsewhere.textContent = 'Another action'
  document.body.append(elsewhere)
  cleanups.push(() => elsewhere.remove())
  elsewhere.focus()
  await act(async () => pending.resolve(Response.json({ error: 'Cycle', code: 'dependency_cycle', cycle: [
    { nodeId: 'first', dependencyId: 'second', kind: 'explicit' }, { nodeId: 'second', dependencyId: 'first', kind: 'both' },
  ] }, { status: 400 })))
  expect(view.container.querySelector('.dt-task-plan-cycle')).not.toBeNull()
  expect(document.activeElement).toBe(elsewhere)
  expect(run.writes()).toHaveLength(1)
})

it.each(['missing', 'null', 'open-chain', 'duplicate', 'wrong-order', 'unknown-node', 'wrong-kind', 'incomplete-kind', 'excessive'] as const)(
  '%s闭环诊断不匹配当前候选时仅保留通用错误，不能产生定位动作', async condition => {
    const run = fixture()
    run.control.definition.plan.nodes.push({ id: 'third', parentId: 'sequence', title: 'Third',
      mode: 'task', instruction: 'Check third source', dependsOn: ['first'], evidenceRequired: false, claimsRequired: false })
    const valid = [
      { nodeId: 'first', dependencyId: 'second', kind: 'explicit' },
      { nodeId: 'second', dependencyId: 'first', kind: 'both' },
    ]
    let cycle: unknown = valid
    if (condition === 'missing') cycle = undefined
    else if (condition === 'null') cycle = [null]
    else if (condition === 'open-chain') cycle = [valid[0], { nodeId: 'third', dependencyId: 'first', kind: 'explicit' }]
    else if (condition === 'duplicate') cycle = [...valid, ...valid]
    else if (condition === 'wrong-order') cycle = [{ ...valid[0], kind: 'serial' }, valid[1]]
    else if (condition === 'unknown-node') cycle = [{ ...valid[0], dependencyId: 'unknown' }, valid[1]]
    else if (condition === 'wrong-kind') cycle = [{ ...valid[0], kind: 'guess' }, valid[1]]
    else if (condition === 'incomplete-kind') cycle = [valid[0], { ...valid[1], kind: 'explicit' }]
    else cycle = [...valid, ...valid, ...valid, ...valid]
    run.control.inspect = async () => Response.json({ error: 'Review prerequisites', code: 'dependency_cycle', cycle }, { status: 400 })
    const view = await render()
    await view.draft()
    await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
    await view.preview()
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('Review prerequisites')
    expect(view.container.querySelector('.dt-task-plan-cycle')).toBeNull()
    expect(view.button(zh['task.plan.apply'])).toBeUndefined()
    expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
    expect(run.writes()).toHaveLength(1)
  })

it.each(['revision', 'edit', 'undo'] as const)('%s使旧闭环提示失效，不自动修复依赖或重放预览', async condition => {
  const run = fixture()
  run.control.inspect = async () => Response.json({ error: 'Cycle', code: 'dependency_cycle', cycle: [
    { nodeId: 'first', dependencyId: 'second', kind: 'explicit' }, { nodeId: 'second', dependencyId: 'first', kind: 'both' },
  ] }, { status: 400 })
  const view = await render()
  await view.draft()
  await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
  await view.preview()
  expect(view.container.querySelector('.dt-task-plan-cycle')).not.toBeNull()
  if (condition === 'revision') await view.update({ revision: 4 })
  else if (condition === 'edit') await view.fill(zh['task.plan.instruction'], 'New explanation')
  else await view.undo()
  expect(view.container.querySelector('.dt-task-plan-cycle')).toBeNull()
  expect(run.writes()).toHaveLength(1)
  expect(run.reads()).toHaveLength(1)
})

it('分组方式、组内步骤顺序与显式依赖分别展示，原本相同的说明不重复展开', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title root'))
  await view.click(view.button(zh['task.plan.serial']))
  await view.click(view.container.querySelector<HTMLButtonElement>('[aria-label="下移：Title sequence"]')!)
  await view.click(view.button('Title second'))
  await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
  await view.fill(zh['task.plan.reason'], 'Change group order and explicit prerequisites')
  await view.preview(); await view.openChange('Title root')
  const comparison = view.container.querySelector('.dt-task-plan-comparison')!
  expect([...comparison.querySelectorAll('dt')].map(item => item.textContent))
    .toEqual([zh['task.plan.groupMode'], zh['task.plan.children']])
  expect([...comparison.querySelectorAll('dd p')].map(item => item.textContent))
    .toEqual([zh['task.plan.parallel'], zh['task.plan.serial'], 'Title sequence\nTitle other\nTitle review',
      'Title other\nTitle sequence\nTitle review'])
  await view.openChange('Title second')
  expect([...view.container.querySelectorAll('.dt-task-plan-comparison dt')].map(item => item.textContent))
    .toEqual([zh['task.plan.dependencies']])
  expect([...view.container.querySelectorAll('.dt-task-plan-comparison dd p')].map(item => item.textContent))
    .toEqual(['Title first', zh['task.plan.none']])
  expect(run.writes()).toHaveLength(1)
})

it('改名和跨组移动显示原名、新名、完整所属路径以及移除的显式前置步骤', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title second'))
  await view.fill(zh['task.plan.name'], 'Revised second check')
  await view.selectParent('root')
  const dependency = [...view.container.querySelectorAll('label')].find(label => label.textContent === 'Title first（其他分组）')!
  await view.click(dependency.querySelector('input')!)
  await view.fill(zh['task.plan.reason'], 'Move the revised check')
  await view.preview(); await view.openChange('Revised second check')
  expect([...view.container.querySelectorAll('.dt-task-plan-comparison dt')].map(item => item.textContent))
    .toEqual([zh['task.plan.name'], zh['task.plan.parent'], zh['task.plan.dependencies']])
  expect([...view.container.querySelectorAll('.dt-task-plan-comparison dd p')].map(item => item.textContent))
    .toEqual(['Title second', 'Revised second check', 'Title root / Title sequence', 'Title root',
      'Title first', zh['task.plan.none']])
  expect(run.writes()).toHaveLength(1)
})

it('同名步骤的依赖以稳定标签区分，不把内部编号当成人可读名称', async () => {
  const run = fixture()
  const [first, second] = run.control.definition.plan.nodes.slice(2, 4)
  first!.id = 'private_source_alpha'; first!.title = 'Duplicate'
  second!.id = 'private_source_beta'; second!.title = 'Duplicate'; second!.dependsOn = ['private_source_alpha']
  const view = await render()
  await view.open()
  await view.click(view.button('Duplicate（同名 2）'))
  await view.click(view.container.querySelector<HTMLInputElement>('.dt-task-plan-fields input[type="checkbox"]')!)
  await view.fill(zh['task.plan.reason'], 'Review the explicit dependency')
  await view.preview(); await view.openChange('Duplicate（同名 2）')
  const details = view.container.querySelector('.dt-task-plan-changes')!
  expect([...details.querySelectorAll('dd p')].map(item => item.textContent)).toEqual(['Duplicate（同名 1）', zh['task.plan.none']])
  expect(details.textContent).not.toContain('private_source_alpha')
  expect(details.textContent).not.toContain('private_source_beta')
})

it('同名步骤交换顺序仍能看出身份变化，不能只比较名称字符串判定没有修改', async () => {
  const run = fixture()
  const [first, second] = run.control.definition.plan.nodes.slice(2, 4)
  first!.title = 'Duplicate'; second!.title = 'Duplicate'; second!.dependsOn = []
  const view = await render()
  await view.open()
  await view.click([...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.getAttribute('aria-label') === '上移：Duplicate（同名 2）' && !button.disabled)!)
  await view.fill(zh['task.plan.reason'], 'Reorder distinct checks with the same title')
  await view.preview(); await view.openChange('Title sequence')
  expect([...view.container.querySelectorAll('.dt-task-plan-comparison dd p')].map(item => item.textContent))
    .toEqual(['Duplicate（同名 1）\nDuplicate（同名 2）', 'Duplicate（同名 2）\nDuplicate（同名 1）'])
})

it('系统区分标签避开用户原有名称，不因生成后缀而出现新的同名选择', async () => {
  const run = fixture()
  for (const node of run.control.definition.plan.nodes)
    if (node.id === 'first' || node.id === 'second') node.title = 'Duplicate'
  run.control.definition.plan.nodes.find(node => node.id === 'other')!.title = 'Duplicate（同名 1）'
  const view = await render()
  await view.open()
  const names = [...view.container.querySelectorAll('.dt-task-plan-title')].map(node => node.textContent)
  expect(names.filter(name => name?.startsWith('Duplicate')))
    .toEqual(['Duplicate（同名 2）', 'Duplicate（同名 3）', 'Duplicate（同名 1）'])
  await view.click(view.button('Duplicate（同名 3）'))
  const dependency = [...view.container.querySelectorAll('label')].find(item => item.textContent === 'Duplicate（同名 2）')!
  expect(dependency.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  await view.click(dependency.querySelector('input')!)
  await view.fill(zh['task.plan.reason'], 'Distinguish generated labels from source names'); await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  expect(candidate.nodes.find(node => node.id === 'first')!.title).toBe('Duplicate')
  expect(candidate.nodes.find(node => node.id === 'second')).toMatchObject({ title: 'Duplicate', dependsOn: [] })
  expect(candidate.nodes.find(node => node.id === 'other')!.title).toBe('Duplicate（同名 1）')
})

it('长说明按需显示完整前后值，用户提供的HTML仅作为文本，不丢换行或截断', async () => {
  const run = fixture()
  const original = 'OriginalScope'.repeat(300).slice(0, 3960) + '\n<b>original</b>'
  const revised = 'RevisedScope'.repeat(300).slice(0, 3960) + '\n<b>revised</b>'
  run.control.definition.plan.nodes.find(node => node.id === 'first')!.instruction = original
  const view = await render()
  await view.open(); await view.click(view.button('Title first'))
  await view.fill(zh['task.plan.instruction'], revised)
  await view.fill(zh['task.plan.reason'], 'Update permitted scope')
  await view.preview()
  expect(view.container.querySelector('.dt-task-plan-changes .dt-task-plan-comparison')).toBeNull()
  await view.openChange('Title first')
  const comparison = view.container.querySelector('.dt-task-plan-comparison')!
  expect([...comparison.querySelectorAll('dd p')].map(item => item.textContent)).toEqual([original, revised])
  expect(comparison.querySelector('b')).toBeNull()
  expect(run.reads()).toHaveLength(1)
})

it('比较使用文本规范化后的同一提交候选，首尾空白不使修订后内容与应用正文分离', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title first'))
  await view.fill(zh['task.plan.name'], '  Revised source check  ')
  await view.fill(zh['task.plan.instruction'], '  Compare current scope\nKeep the permitted source unchanged.\n  ')
  await view.fill(zh['task.plan.reason'], '  Clarify source scope  ')
  await view.preview(); await view.openChange('Revised source check')
  const values = [...view.container.querySelectorAll('.dt-task-plan-comparison dd p')].map(item => item.textContent)
  expect(values).toEqual(['Title first', 'Revised source check', 'Check first',
    'Compare current scope\nKeep the permitted source unchanged.'])
  const candidate = run.writes()[0]!.body!
  expect((candidate.plan as Definition['plan']).nodes.find(node => node.id === 'first')).toMatchObject({
    title: 'Revised source check', instruction: 'Compare current scope\nKeep the permitted source unchanged.',
  })
  expect(candidate.reason).toBe('Clarify source scope')
  await view.apply()
  expect(run.writes()[1]!.body).toEqual({ ...candidate, preview: false })
})

it.each(['edit', 'undo', 'revision'] as const)('%s使旧字段比较一同失效，不生成额外预览或保存请求', async action => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview(); await view.openChange('Title first')
  if (action === 'edit') await view.fill(zh['task.plan.instruction'], 'A different current draft')
  else if (action === 'undo') await view.undo()
  else await view.update({ revision: 4 })
  expect(view.container.querySelector('.dt-task-plan-changes')).toBeNull()
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(run.writes()).toHaveLength(1)
})

it('新增步骤说明必须由操作者填写，候选不重用编号、不改变目标或已有核验要求', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title root')); await view.click(view.button(zh['task.plan.addStep']))
  expect(run.writes()).toHaveLength(0)
  expect(view.field(zh['task.plan.instruction']).value).toBe('')
  await view.fill(zh['task.plan.reason'], 'Add a missing check')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  await view.fill(zh['task.plan.name'], 'Check latest version')
  await view.fill(zh['task.plan.instruction'], 'Compare the two latest authorized source versions')
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan'], added = plan.nodes.at(-1)!
  expect(added).toMatchObject({ parentId: 'root', title: 'Check latest version', mode: 'task',
    instruction: 'Compare the two latest authorized source versions', dependsOn: [] })
  expect(added.id).toMatch(/^[a-z][a-z0-9_-]{0,63}$/)
  expect(run.control.definition.plan.nodes.some(node => node.id === added.id)).toBe(false)
  expect(plan.nodes.slice(0, -1)).toEqual(JSON.parse(JSON.stringify(run.control.definition.plan.nodes)))
  expect(plan.goal).toBe(run.control.definition.plan.goal)
  expect(plan.maxActive).toBe(run.control.definition.plan.maxActive)
})

it('复制串行分组为同级新分支，内部编号及依赖重映射，外部消费者仍引用原分支', async () => {
  const run = fixture(), view = await render()
  run.control.inspect = async () => {
    const candidate = run.writes().at(-1)!.body!.plan as Definition['plan']
    return Response.json({ ...run.impact(), added: candidate.nodes.filter(node =>
      !run.control.definition.plan.nodes.some(original => original.id === node.id)).map(node => node.id) })
  }
  const before = JSON.parse(JSON.stringify(run.control.definition.plan)) as Definition['plan']
  await view.open(); await view.click(view.button('Title sequence'))
  await view.click(view.button(zh['task.plan.copy']))
  expect(run.requests.filter(request => request.method === 'POST')).toEqual([])
  expect(view.field(zh['task.plan.name']).value).toBe(`Title sequence${zh['task.plan.copySuffix']}`)
  expect(view.field(zh['task.plan.parent']).value).toBe('root')
  await view.fill(zh['task.plan.reason'], 'Compare a second source approach')
  await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  const added = candidate.nodes.filter(node => !before.nodes.some(original => original.id === node.id))
  const group = added.find(node => node.mode === 'serial')!, children = added.filter(node => node.parentId === group.id)
  expect(added).toHaveLength(3)
  expect(new Set(added.map(node => node.id)).size).toBe(3)
  expect(added.every(node => /^[a-z][a-z0-9_-]{0,63}$/.test(node.id))).toBe(true)
  expect(candidate.nodes.filter(node => before.nodes.some(original => original.id === node.id))).toEqual(before.nodes)
  expect(candidate.nodes.filter(node => node.parentId === 'root').map(node => node.id)).toEqual(['sequence', group.id, 'other', 'review'])
  expect(children.map(node => node.title)).toEqual(['Title first', 'Title second'])
  expect(children[1]).toMatchObject({ dependsOn: [children[0]!.id], evidenceRequired: true })
  expect(candidate.nodes.find(node => node.id === 'review')!.dependsOn).toEqual(['sequence', 'other'])
  expect(candidate.goal).toBe(before.goal)
  expect(candidate.maxActive).toBe(before.maxActive)
  expect(view.container.querySelector(`[aria-label="${zh['task.planChange.added']}"]`)?.textContent)
    .toContain(`Title sequence${zh['task.plan.copySuffix']}`)
  await view.apply()
  expect(run.writes()[1]!.body).toEqual({ ...run.writes()[0]!.body, preview: false })
})

it('复制独立步骤保留原外部前置、说明及核验要求，不把消费者改接副本', async () => {
  const run = fixture()
  run.control.definition.plan.nodes.find(node => node.id === 'review')!.dependsOn = ['sequence', 'other']
  const view = await render()
  await view.open(); await view.click(view.button('Title review')); await view.click(view.button(zh['task.plan.copy']))
  await view.fill(zh['task.plan.reason'], 'Compare a second review approach'); await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  const copy = candidate.nodes.find(node => !run.control.definition.plan.nodes.some(original => original.id === node.id))!
  expect(copy).toMatchObject({ parentId: 'root', mode: 'task', instruction: 'Check review',
    evidenceRequired: true, claimsRequired: true, dependsOn: ['sequence', 'other'] })
  expect(copy.id).not.toBe('review')
  expect(candidate.nodes.find(node => node.id === 'review')).toMatchObject({ dependsOn: ['sequence', 'other'] })
  expect(run.reads()).toHaveLength(1)
})

it('复制整组后树、前置选择及影响预览使用同一标签，修改副本依赖不改原步骤', async () => {
  const run = fixture()
  run.control.inspect = async () => {
    const candidate = run.writes().at(-1)!.body!.plan as Definition['plan']
    const added = candidate.nodes.filter(node => !run.control.definition.plan.nodes.some(original => original.id === node.id))
    return Response.json({ ...run.impact(), added: added.map(node => node.id),
      invalidated: ['first', 'second', ...added.filter(node => node.mode === 'task').map(node => node.id)] })
  }
  const view = await render()
  await view.open(); await view.click(view.button('Title sequence')); await view.click(view.button(zh['task.plan.copy']))
  await view.click(view.button('Title second（同名 2）'))
  expect(view.field(zh['task.plan.name']).value).toBe('Title second')
  const dependency = [...view.container.querySelectorAll('label')].find(item => item.textContent === 'Title first（同名 2）')!
  expect(dependency.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  await view.click(dependency.querySelector('input')!)
  await view.fill(zh['task.plan.reason'], 'Review only the copied branch prerequisite'); await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  const added = candidate.nodes.filter(node => !run.control.definition.plan.nodes.some(original => original.id === node.id))
  expect(candidate.nodes.find(node => node.id === 'second')!.dependsOn).toEqual(['first'])
  expect(added.find(node => node.title === 'Title second')!.dependsOn).toEqual([])
  expect(view.container.querySelector(`[aria-label="${zh['task.planChange.added']}"]`)?.textContent)
    .toContain('Title first（同名 2）')
  expect([...view.container.querySelectorAll('.dt-task-plan-affected li')].map(item => item.textContent))
    .toEqual(['Title first（同名 1）', 'Title second（同名 1）', 'Title first（同名 2）', 'Title second（同名 2）'])
  expect(added.every(node => !view.container.textContent!.includes(node.id))).toBe(true)
  await view.apply()
  expect(run.writes()[1]!.body).toEqual({ ...run.writes()[0]!.body, preview: false })
})

it('连续复制出的同名项按首次创建区分，重排和撤销重做不把标签换给另一个副本', async () => {
  const run = fixture(), view = await render(), title = `Title other${zh['task.plan.copySuffix']}`
  await view.open()
  for (let index = 0; index < 2; index++) {
    await view.click(view.button('Title other')); await view.click(view.button(zh['task.plan.copy']))
  }
  const names = () => [...view.container.querySelectorAll('.dt-task-plan-title')]
    .map(item => item.textContent).filter(name => name?.startsWith(title))
  expect(names()).toEqual([`${title}（同名 2）`, `${title}（同名 1）`])
  await view.click(view.button(`${title}（同名 1）`))
  await view.fill(zh['task.plan.instruction'], 'Check the first alternative')
  await view.click(view.container.querySelector<HTMLButtonElement>(`[aria-label="上移：${title}（同名 1）"]`)!)
  expect(names()).toEqual([`${title}（同名 1）`, `${title}（同名 2）`])
  await view.undo()
  expect(names()).toEqual([`${title}（同名 2）`, `${title}（同名 1）`])
  await view.redo()
  expect(names()).toEqual([`${title}（同名 1）`, `${title}（同名 2）`])
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the first alternative')
  await view.fill(zh['task.plan.reason'], 'Compare distinct copied alternatives'); await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  const copies = candidate.nodes.filter(node => node.title === title)
  expect(copies).toHaveLength(2)
  expect(copies[0]!.instruction).toBe('Check the first alternative')
  expect(copies[1]!.instruction).toBe('Check other')
  expect(run.reads()).toHaveLength(1)
})

it('移除同名步骤时确认、待修复项和前后预览保留对应关系，原名称不写入区分后缀', async () => {
  const run = fixture()
  run.control.definition.plan.nodes.find(node => node.id === 'first')!.title = 'Duplicate'
  run.control.definition.plan.nodes.find(node => node.id === 'second')!.title = ' Duplicate '
  run.control.inspect = async () => Response.json({ ...run.impact(), removed: ['first'], invalidated: ['second'] })
  const view = await render()
  await view.open(); await view.click(view.button('Duplicate（同名 1）'))
  await view.click(view.button(zh['task.plan.remove']))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Duplicate（同名 1）')
  await view.click(view.button(zh.confirm, document.body))
  expect(view.container.querySelector('.dt-task-plan-issues')?.textContent)
    .toBe(t('task.plan.issue', { title: 'Duplicate（同名 2）', reason: zh['task.plan.issue.dependencies'] }))
  await view.click(view.button('Duplicate（同名 2）'))
  const dependency = [...view.container.querySelectorAll('label')].find(item => item.textContent === 'Duplicate（同名 1）（已移除）')!
  expect(dependency.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  await view.click(dependency.querySelector('input')!)
  await view.fill(zh['task.plan.reason'], 'Remove only the obsolete duplicate'); await view.preview()
  expect(view.container.querySelector(`[aria-label="${zh['task.planChange.removed']}"]`)?.textContent)
    .toBe('Duplicate（同名 1）')
  expect(view.container.querySelector('.dt-task-plan-affected')?.textContent).toBe('Duplicate（同名 2）')
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  expect(candidate.nodes.find(node => node.id === 'second')).toMatchObject({ title: 'Duplicate', dependsOn: [] })
  expect(candidate.nodes.some(node => node.title.includes('（同名'))).toBe(false)
})

it('复制最近移动到数组末尾的整组仍保留内部声明顺序与依赖，不依赖父节点在数组中先出现', async () => {
  const run = fixture()
  const group = run.control.definition.plan.nodes.find(node => node.id === 'sequence')!
  run.control.definition.plan.nodes = [...run.control.definition.plan.nodes.filter(node => node !== group), group]
  const view = await render()
  await view.open(); await view.click(view.button('Title sequence')); await view.click(view.button(zh['task.plan.copy']))
  await view.fill(zh['task.plan.reason'], 'Reuse the moved source group'); await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  const added = candidate.nodes.filter(node => !run.control.definition.plan.nodes.some(original => original.id === node.id))
  const copiedGroup = added.find(node => node.mode === 'serial')!
  const children = candidate.nodes.filter(node => node.parentId === copiedGroup.id)
  expect(children.map(node => node.instruction)).toEqual(['Check first', 'Check second'])
  expect(children[1]!.dependsOn).toEqual([children[0]!.id])
  expect(copiedGroup.parentId).toBe('root')
})

it('复制是单次可撤销操作，重做使用原编号，复制后旧预览失效且不发生额外写入', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  await view.click(view.button('Title sequence')); await view.click(view.button(zh['task.plan.copy']))
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  await view.preview()
  const copied = run.writes()[1]!.body!
  await view.undo()
  expect(view.button(`Title sequence${zh['task.plan.copySuffix']}`)).toBeUndefined()
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  await view.redo()
  expect(view.field(zh['task.plan.name']).value).toBe(`Title sequence${zh['task.plan.copySuffix']}`)
  await view.preview()
  expect(run.writes()[2]!.body).toEqual(copied)
  expect(run.reads()).toHaveLength(1)
})

it('编号分配避开已有节点、墓碑和同一批副本编号', async () => {
  const run = fixture()
  const existing = '0'.repeat(32), retired = '1'.repeat(32), first = '2'.repeat(32), second = '3'.repeat(32), third = '4'.repeat(32)
  run.control.definition.plan.nodes.push({ id: `node_${existing}`, parentId: 'root', title: 'Existing allocated node',
    instruction: 'Keep existing work', mode: 'task', dependsOn: [], evidenceRequired: false, claimsRequired: false })
  run.control.definition.retiredNodeIds = [`node_${retired}`]
  const random = vi.spyOn(crypto, 'randomUUID')
  for (const value of [existing, retired, first, first, second, third]) random.mockReturnValueOnce(value as ReturnType<Crypto['randomUUID']>)
  const view = await render()
  await view.open(); await view.click(view.button('Title sequence')); await view.click(view.button(zh['task.plan.copy']))
  await view.fill(zh['task.plan.reason'], 'Reuse a complete source group'); await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  const added = candidate.nodes.filter(node => !run.control.definition.plan.nodes.some(original => original.id === node.id))
  expect(added.map(node => node.id)).toEqual([first, second, third].map(value => `node_${value}`))
  expect(new Set(candidate.nodes.map(node => node.id)).size).toBe(candidate.nodes.length)
})

it.each([8, 9])('按服务端提供的%d节点预算控制整组复制，不使用客户端写死上限', async limit => {
  const run = fixture()
  run.control.definition.limits = { nodes: limit }
  const view = await render()
  await view.open(); await view.click(view.button('Title sequence'))
  expect(view.button(zh['task.plan.copy']).disabled).toBe(limit === 8)
  await view.click(view.button(zh['task.plan.copy']))
  if (limit === 8) expect(view.field(zh['task.plan.name']).value).toBe('Title sequence')
  else {
    await view.fill(zh['task.plan.reason'], 'Fill the remaining plan budget'); await view.preview()
    expect((run.writes()[0]!.body!.plan as Definition['plan']).nodes).toHaveLength(9)
    expect(view.button(zh['task.plan.copy']).disabled).toBe(true)
  }
})

it.each(['retired', 'removed-in-draft'] as const)('%s节点仍占生命周期编号预算，不能通过删旧复制绕过上限', async condition => {
  const run = fixture()
  run.control.definition.limits = { nodes: condition === 'retired' ? 9 : 8 }
  if (condition === 'retired') run.control.definition.retiredNodeIds = ['retired_node']
  const view = await render()
  await view.open()
  if (condition === 'removed-in-draft') {
    await view.click(view.button('Title other')); await view.click(view.button(zh['task.plan.remove']))
    await view.click(view.button(zh.confirm, document.body))
  }
  await view.click(view.button('Title sequence'))
  expect(view.button(zh['task.plan.copy']).disabled).toBe(true)
  await view.click(view.button(zh['task.plan.copy']))
  expect(view.field(zh['task.plan.name']).value).toBe('Title sequence')
  expect(run.writes()).toEqual([])
})

it('同一帧重复复制仍以最新草稿计算预算，不能因事件批处理突破服务端额度', async () => {
  const run = fixture()
  run.control.definition.limits = { nodes: 9 }
  const view = await render()
  await view.open(); await view.click(view.button('Title sequence'))
  const copy = view.button(zh['task.plan.copy'])
  await act(async () => { copy.click(); copy.click() })
  await view.fill(zh['task.plan.reason'], 'Copy one complete source branch')
  await view.preview()
  expect((run.writes()[0]!.body!.plan as Definition['plan']).nodes).toHaveLength(9)
  expect(view.button(zh['task.plan.copy']).disabled).toBe(true)
})

it.each(['missing', 'fractional', 'invalid'] as const)('%s节点预算不开放复制；旧宿主仍可查看原计划', async condition => {
  const run = fixture()
  run.control.definition.limits = condition === 'missing' ? undefined : { nodes: condition === 'fractional' ? 8.5 : 0 }
  const view = await render()
  await view.open(); await view.click(view.button('Title sequence'))
  expect(view.button(zh['task.plan.copy'])).toBeUndefined()
  expect(view.field(zh['task.plan.name']).value).toBe('Title sequence')
  expect(run.writes()).toEqual([])
})

it('根节点不提供复制，长名称副本保留可识别后缀且不超出后端名称长度', async () => {
  const run = fixture()
  run.control.definition.plan.nodes.find(node => node.id === 'other')!.title = 'A'.repeat(160)
  const view = await render()
  await view.open(); await view.click(view.button('Title root'))
  expect(view.button(zh['task.plan.copy'])).toBeUndefined()
  await view.click(view.button('A'.repeat(160))); await view.click(view.button(zh['task.plan.copy']))
  const title = view.field(zh['task.plan.name']).value
  expect(title).toHaveLength(160)
  expect(title.endsWith(zh['task.plan.copySuffix'])).toBe(true)
  expect(run.writes()).toEqual([])
})

it.each(['stale', 'readonly', 'pruned'] as const)('%s计划不能复制，禁用动作不修改草稿或请求状态', async condition => {
  const run = fixture()
  if (condition === 'pruned') run.control.definition.prunedNodeIds = ['first']
  const view = await render()
  await view.open(); await view.click(view.button('Title sequence'))
  if (condition === 'stale') await view.update({ revision: 4 })
  else if (condition === 'readonly') await view.update({ editable: false })
  expect(view.button(zh['task.plan.copy']).disabled).toBe(true)
  await view.click(view.button(zh['task.plan.copy']))
  expect(view.field(zh['task.plan.name']).value).toBe('Title sequence')
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toEqual([])
})

it('新增分组先保留为空，加入独立步骤并补齐说明后才允许预览，影响区显示新增名称', async () => {
  const run = fixture(), view = await render()
  run.control.inspect = async () => {
    const candidate = run.writes().at(-1)!.body!.plan as Definition['plan']
    return Response.json({ ...run.impact(), added: candidate.nodes.slice(6).map(node => node.id) })
  }
  await view.open(); await view.click(view.button('Title root')); await view.click(view.button(zh['task.plan.addGroup']))
  await view.fill(zh['task.plan.name'], 'Source comparison')
  await view.fill(zh['task.plan.reason'], 'Group an independent comparison')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  await view.click(view.button(zh['task.plan.addStep']))
  await view.fill(zh['task.plan.name'], 'Compare source versions')
  await view.fill(zh['task.plan.instruction'], 'Compare only the permitted versions')
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan'], [group, child] = plan.nodes.slice(6)
  expect(group).toMatchObject({ mode: 'parallel', parentId: 'root', title: 'Source comparison' })
  expect(child).toMatchObject({ parentId: group!.id, title: 'Compare source versions' })
  const added = view.container.querySelector(`[aria-label="${zh['task.planChange.added']}"]`)!
  expect(added.textContent).toContain('Source comparison')
  expect(added.textContent).toContain('Compare source versions')
})

it('同一步骤缺少名称与说明时分别说明原因，定位已展开字段不改稿，补齐后才允许预览', async () => {
  const run = fixture(), view = await render()
  await view.draft()
  await view.fill(zh['task.plan.name'], ' \t')
  await view.fill(zh['task.plan.instruction'], '\n ')
  const issue = (field: 'title' | 'instruction') => view.button(t('task.plan.issue', {
    title: zh['task.plan.newStep'], reason: zh[`task.plan.issue.${field}`],
  }))
  expect(view.container.querySelectorAll('.dt-task-plan-issues li')).toHaveLength(2)
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  await view.click(issue('instruction'))
  expect(document.activeElement).toBe(view.field(zh['task.plan.instruction']))
  expect(view.field(zh['task.plan.instruction']).value).toBe('\n ')
  await view.click(issue('title'))
  expect(document.activeElement).toBe(view.field(zh['task.plan.name']))
  expect(view.field(zh['task.plan.name']).getAttribute('aria-invalid')).toBe('true')
  expect(run.writes()).toEqual([])
  expect(run.reads()).toHaveLength(1)
  await view.fill(zh['task.plan.name'], 'Check the authorized source')
  expect(view.container.querySelectorAll('.dt-task-plan-issues li')).toHaveLength(1)
  expect(document.activeElement).toBe(view.field(zh['task.plan.name']))
  expect(view.field(zh['task.plan.reason']).value).toBe('Source scope clarified')
  await view.fill(zh['task.plan.instruction'], 'Compare only the permitted source version')
  expect(view.container.querySelector('.dt-task-plan-issues')).toBeNull()
  await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  expect(candidate.nodes.find(node => node.id === 'first')).toMatchObject({
    title: 'Check the authorized source', instruction: 'Compare only the permitted source version',
  })
})

it('空分组提示只定位新增步骤按钮，不自动填充节点；用户新增并补说明后才能预览', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title root')); await view.click(view.button(zh['task.plan.addGroup']))
  await view.fill(zh['task.plan.name'], 'Alternative checks')
  await view.fill(zh['task.plan.reason'], 'Compare another authorized approach')
  await view.click(view.button('Title other'))
  const count = view.container.querySelectorAll('.dt-task-plan-title').length
  await view.click(view.button(t('task.plan.issue', {
    title: 'Alternative checks', reason: zh['task.plan.issue.children'],
  })))
  expect(document.activeElement).toBe(view.button(zh['task.plan.addStep']))
  expect(view.field(zh['task.plan.name']).value).toBe('Alternative checks')
  expect(view.container.querySelectorAll('.dt-task-plan-title')).toHaveLength(count)
  expect(run.writes()).toEqual([])
  await view.click(view.button(zh['task.plan.addStep']))
  expect(view.container.querySelector('.dt-task-plan-issues')?.textContent).not.toContain(zh['task.plan.issue.children'])
  expect(view.container.querySelector('.dt-task-plan-issues')?.textContent).toContain(zh['task.plan.issue.instruction'])
  await view.fill(zh['task.plan.instruction'], 'Check the alternative authorized source')
  await view.preview()
  const added = (run.writes()[0]!.body!.plan as Definition['plan']).nodes.slice(6)
  expect(added).toHaveLength(2)
  expect(added[1]!.parentId).toBe(added[0]!.id)
})

it.each(['removed', 'moved'] as const)('%s前置提示定位真正失效的勾选框，保留有效前置且不自动修复', async condition => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title other'))
  await view.fill(zh['task.plan.instruction'], 'Keep the independent source scope')
  await view.fill(zh['task.plan.reason'], 'Review the changed source relationship')
  if (condition === 'removed') {
    await view.click(view.button(zh['task.plan.remove']))
    await view.click(view.button(zh.confirm, document.body))
  } else await view.selectParent('sequence')
  const issue = () => view.button(t('task.plan.issue', {
    title: 'Title review', reason: zh['task.plan.issue.dependencies'],
  }))
  await view.click(issue())
  const inputs = [...view.container.querySelectorAll<HTMLInputElement>('.dt-question-choices input')]
  expect(inputs[0]!.checked).toBe(true)
  expect(inputs[0]!.getAttribute('aria-invalid')).toBeNull()
  const invalid = inputs.find(input => input.getAttribute('aria-invalid') === 'true')!
  expect(document.activeElement).toBe(invalid)
  expect(invalid.checked).toBe(true)
  expect(invalid.closest('label')?.textContent).toBe(t(condition === 'removed'
    ? 'task.plan.removedDependency' : 'task.plan.otherGroup', { title: 'Title other' }))
  expect(run.writes()).toEqual([])
  view.field(zh['task.plan.reason']).focus()
  await view.click(issue())
  expect(document.activeElement).toBe(invalid)
  await view.click(invalid)
  expect(view.container.querySelector('.dt-task-plan-issues')).toBeNull()
  expect(view.field(zh['task.plan.reason']).value).toBe('Review the changed source relationship')
  await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  expect(candidate.nodes.find(node => node.id === 'review')!.dependsOn).toEqual(['sequence'])
  if (condition === 'moved')
    expect(candidate.nodes.find(node => node.id === 'other')!.instruction).toBe('Keep the independent source scope')
  expect(run.reads()).toHaveLength(1)
})

it.each(['readonly', 'stale'] as const)('%s草稿仍可查看问题位置，但定位不能编辑、保存或延迟补发', async condition => {
  const run = fixture(), view = await render()
  await view.draft(); await view.fill(zh['task.plan.instruction'], ' ')
  if (condition === 'readonly') await view.update({ editable: false })
  else await view.update({ revision: 4 })
  await view.click(view.button('Title other'))
  await view.click(view.button(t('task.plan.issue', {
    title: 'Title first', reason: zh['task.plan.issue.instruction'],
  })))
  expect(view.field(zh['task.plan.name']).value).toBe('Title first')
  expect(view.field(zh['task.plan.instruction']).value).toBe(' ')
  expect(view.field(zh['task.plan.instruction']).matches(':disabled')).toBe(true)
  expect(document.activeElement).toBe(view.button('Title first'))
  expect(view.field(zh['task.plan.reason']).value).toBe('Source scope clarified')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  expect(run.writes()).toEqual([])
  expect(run.reads()).toHaveLength(1)
})

it('撤销、重做及修复后列表更新不主动转移焦点，用户可以留在调整原因中继续输入', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.fill(zh['task.plan.instruction'], ' ')
  await view.click(view.button(t('task.plan.issue', {
    title: 'Title first', reason: zh['task.plan.issue.instruction'],
  })))
  const reason = view.field(zh['task.plan.reason'])
  reason.focus()
  await view.undo()
  expect(view.container.querySelector('.dt-task-plan-issues')).toBeNull()
  expect(document.activeElement).toBe(reason)
  await view.redo()
  expect(view.container.querySelector('.dt-task-plan-issues')?.textContent).toContain(zh['task.plan.issue.instruction'])
  expect(document.activeElement).toBe(reason)
  await view.fill(zh['task.plan.instruction'], 'Keep the restored source scope')
  expect(view.container.querySelector('.dt-task-plan-issues')).toBeNull()
  expect(document.activeElement).toBe(reason)
  expect(run.writes()).toEqual([])
})

it('跨组移动保留原显式依赖，失配引用必须明确移除后才能预览，步骤排入目标组末尾', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title second'))
  await view.selectParent('root')
  await view.fill(zh['task.plan.reason'], 'Move the check to the main group')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  const dependency = [...view.container.querySelectorAll('label')].find(label => label.textContent === 'Title first（其他分组）')!
  expect(dependency.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  expect(run.writes()).toHaveLength(0)
  await view.click(dependency.querySelector('input')!)
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan']
  expect(plan.nodes.at(-1)).toMatchObject({ id: 'second', parentId: 'root', dependsOn: [], evidenceRequired: true })
  expect(plan.nodes.filter(node => node.parentId === 'root').map(node => node.id)).toEqual(['sequence', 'other', 'review', 'second'])
  expect(plan.nodes.find(node => node.id === 'first')).toMatchObject({ parentId: 'sequence' })
})

it('移动前置步骤后，其消费者的旧引用继续可见；移动不替消费者重写依赖', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title first')); await view.selectParent('root')
  await view.fill(zh['task.plan.reason'], 'Regroup the source')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  expect(view.container.querySelector('.dt-task-plan-issues')?.textContent).toContain('Title second')
  await view.click(view.button('Title second'))
  const dependency = [...view.container.querySelectorAll('label')].find(label => label.textContent === 'Title first（其他分组）')!
  expect(dependency.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  await view.click(dependency.querySelector('input')!)
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan']
  expect(plan.nodes.find(node => node.id === 'second')).toMatchObject({ dependsOn: [] })
  expect(plan.nodes.find(node => node.id === 'review')).toMatchObject({ dependsOn: ['sequence', 'other'] })
})

it('删除子树先确认范围，取消不改稿；确认后保留消费者引用，修复后预览列出移除名称', async () => {
  const run = fixture(), view = await render()
  run.control.inspect = async () => Response.json({ ...run.impact(),
    removed: ['sequence', 'first', 'second'], changed: ['root', 'review'], invalidated: ['review'] })
  await view.open(); await view.click(view.button('Title sequence'))
  await view.click(view.button(zh['task.plan.remove']))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('2 个子项')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('1 条前置依赖')
  await view.click(view.button(zh.cancel, document.body))
  expect(view.button('Title first')).toBeTruthy()
  await view.click(view.button(zh['task.plan.remove']))
  await view.click(view.button(zh.confirm, document.body))
  expect(view.button('Title first')).toBeUndefined()
  expect(run.writes()).toHaveLength(0)
  await view.fill(zh['task.plan.reason'], 'Remove the obsolete comparison')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  await view.click(view.button('Title review'))
  const dependency = [...view.container.querySelectorAll('label')].find(label => label.textContent === 'Title sequence（已移除）')!
  expect(dependency.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  await view.click(dependency.querySelector('input')!)
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan']
  expect(plan.nodes.map(node => node.id)).toEqual(['root', 'other', 'review'])
  expect(plan.nodes.find(node => node.id === 'review')).toMatchObject({ dependsOn: ['other'], claimsRequired: true })
  expect(view.container.querySelector(`[aria-label="${zh['task.planChange.removed']}"]`)?.textContent)
    .toBe('Title sequenceTitle firstTitle second')
  expect([...view.container.querySelectorAll('.dt-task-plan-change-name')].map(item => item.textContent)).toEqual(['Title root', 'Title review'])
  await view.openChange('Title root')
  expect([...view.container.querySelectorAll('.dt-task-plan-comparison dd p')].map(item => item.textContent))
    .toEqual(['Title sequence\nTitle other\nTitle review', 'Title other\nTitle review'])
})

it('移动最后一个子节点不自动删除空分组，候选必须补齐该分组或明确移除', async () => {
  const run = fixture()
  run.control.definition.plan.nodes.find(node => node.id === 'second')!.parentId = 'root'
  run.control.definition.plan.nodes.find(node => node.id === 'second')!.dependsOn = []
  const view = await render()
  await view.open(); await view.click(view.button('Title first')); await view.selectParent('root')
  await view.fill(zh['task.plan.reason'], 'Change source grouping')
  expect(view.button('Title sequence')).toBeTruthy()
  expect(view.container.querySelector('.dt-task-plan-issues')?.textContent).toContain('Title sequence')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  await view.click(view.button('Title sequence')); await view.click(view.button(zh['task.plan.addStep']))
  await view.fill(zh['task.plan.instruction'], 'Check the new independent source')
  await view.preview()
  expect((run.writes()[0]!.body!.plan as Definition['plan']).nodes.find(node => node.id === 'sequence')).toBeTruthy()
})

it('根分组不可删除，所属分组选项排除当前子树，移动整组不改变内部引用', async () => {
  const run = fixture()
  run.control.definition.plan.nodes.push({ id: 'inner', parentId: 'sequence', title: 'Inner group',
    mode: 'parallel', instruction: undefined, evidenceRequired: false, claimsRequired: false, dependsOn: [] },
  { id: 'inner_task', parentId: 'inner', title: 'Inner task', mode: 'task',
    instruction: 'Check inner source', evidenceRequired: true, claimsRequired: true, dependsOn: [] },
  { id: 'target', parentId: 'root', title: 'Target group', mode: 'parallel',
    instruction: undefined, evidenceRequired: false, claimsRequired: false, dependsOn: [] },
  { id: 'target_task', parentId: 'target', title: 'Target task', mode: 'task',
    instruction: 'Check target source', evidenceRequired: false, claimsRequired: false, dependsOn: [] })
  const view = await render()
  await view.open(); await view.click(view.button('Title root'))
  expect(view.button(zh['task.plan.remove'])).toBeUndefined()
  expect(view.container.querySelector('select')).toBeNull()
  await view.click(view.button('Title sequence'))
  expect([...view.container.querySelectorAll<HTMLOptionElement>('select option')].map(option => option.value)).toEqual(['root', 'target'])
  await view.selectParent('target')
  expect(run.writes()).toHaveLength(0)
  await view.click(view.button('Title review'))
  const dependency = [...view.container.querySelectorAll('label')].find(label => label.textContent === 'Title sequence（其他分组）')!
  await view.click(dependency.querySelector('input')!)
  const replacement = [...view.container.querySelectorAll('label')].find(label => label.textContent === 'Target group')!
  await view.click(replacement.querySelector('input')!)
  await view.fill(zh['task.plan.reason'], 'Regroup checks under a shared parent')
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan']
  expect(plan.nodes.find(node => node.id === 'sequence')).toMatchObject({ parentId: 'target' })
  expect(plan.nodes.find(node => node.id === 'second')).toMatchObject({ parentId: 'sequence', dependsOn: ['first'] })
  expect(plan.nodes.find(node => node.id === 'inner_task')).toMatchObject({ parentId: 'inner',
    evidenceRequired: true, claimsRequired: true })
})

it('删除确认期间版本变化不落入旧草稿，旧预览不会被结构编辑继续应用', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  await view.click(view.button('Title root')); await view.click(view.button(zh['task.plan.addGroup']))
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  await view.click(view.button(zh['task.plan.remove']))
  await view.update({ revision: 4 })
  await view.click(view.button(zh.confirm, document.body))
  expect(view.button(zh['task.plan.newGroup'])).toBeTruthy()
  expect(run.writes()).toHaveLength(1)
})

it('撤销删除恢复完整子树和依赖，保留此前说明与调整原因，重做仍要求核对消费者引用', async () => {
  const run = fixture(), view = await render()
  await view.open()
  expect(view.history('undo').disabled).toBe(true)
  expect(view.history('redo').disabled).toBe(true)
  await view.click(view.button('Title other'))
  await view.fill(zh['task.plan.instruction'], 'Keep the independent check already edited')
  await view.fill(zh['task.plan.reason'], 'Reconsider grouping')
  await view.click(view.button('Title sequence'))
  await view.click(view.button(zh['task.plan.remove']))
  await view.click(view.button(zh.confirm, document.body))
  expect(view.button('Title first')).toBeUndefined()
  await view.undo()
  expect(view.button('Title first')).toBeTruthy()
  expect(view.button('Title second')).toBeTruthy()
  expect(view.field(zh['task.plan.name']).value).toBe('Title sequence')
  expect(view.field(zh['task.plan.reason']).value).toBe('Reconsider grouping')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(false)
  await view.redo()
  expect(view.button('Title first')).toBeUndefined()
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  expect(run.writes()).toEqual([])
  await view.undo(); await view.preview()
  const candidate = run.writes()[0]!.body!.plan as Definition['plan']
  const expected = JSON.parse(JSON.stringify(run.control.definition.plan)) as Definition['plan']
  expected.nodes.find(node => node.id === 'other')!.instruction = 'Keep the independent check already edited'
  expect(candidate).toEqual(expected)
})

it('撤销跨组移动恢复原顺序和原依赖，重做保留节点身份且不暗改消费者', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title second')); await view.selectParent('root')
  await view.fill(zh['task.plan.reason'], 'Reconsider moving the check')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  await view.undo()
  expect(view.field(zh['task.plan.parent']).value).toBe('sequence')
  expect(view.container.querySelector('.dt-task-plan-issues')).toBeNull()
  await view.redo()
  expect(view.field(zh['task.plan.parent']).value).toBe('root')
  expect(view.container.querySelector('.dt-task-plan-issues')?.textContent).toContain('Title second')
  expect(run.writes()).toEqual([])
  await view.undo()
  await view.fill(zh['task.plan.instruction'], 'Review the updated source without moving')
  await view.preview()
  const plan = run.writes()[0]!.body!.plan as Definition['plan']
  expect(plan.nodes.map(node => node.id)).toEqual(run.control.definition.plan.nodes.map(node => node.id))
  expect(plan.nodes.find(node => node.id === 'second')).toMatchObject({ parentId: 'sequence', dependsOn: ['first'] })
  expect(plan.nodes.find(node => node.id === 'review')).toMatchObject({ dependsOn: ['sequence', 'other'] })
})

it('撤销或重做使已有预览失效，必须重新预览后才能应用相同候选', async () => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  const first = run.writes()[0]!.body!
  await view.undo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check first')
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  await view.redo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(run.writes()).toHaveLength(1)
  await view.preview(); await view.apply()
  expect(run.writes().map(request => request.body)).toEqual([first, first, { ...first, preview: false }])
  expect(view.container.textContent).toContain(zh['task.plan.saved'])
  expect(view.history('undo')).toBeNull()
})

it('连续文本输入合为一次撤销，离开字段后形成新编辑；新修改清除重做分支', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title first'))
  await view.fill(zh['task.plan.instruction'], 'Check')
  await view.fill(zh['task.plan.instruction'], 'Check the latest')
  await view.fill(zh['task.plan.instruction'], 'Check the latest source')
  await act(async () => view.field(zh['task.plan.instruction']).dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  await view.fill(zh['task.plan.instruction'], 'Check the latest permitted source')
  await view.undo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the latest source')
  await view.undo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check first')
  expect(view.history('undo').disabled).toBe(true)
  await view.redo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the latest source')
  await view.redo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the latest permitted source')
  await view.undo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the latest source')
  await view.fill(zh['task.plan.name'], 'Reframed source check')
  expect(view.history('redo').disabled).toBe(true)
  expect(run.writes()).toEqual([])
})

it('撤销新增后重做使用原编号，后续说明与分组顺序仍可逐项恢复', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title root')); await view.click(view.button(zh['task.plan.addStep']))
  await view.fill(zh['task.plan.name'], 'New version check')
  await view.fill(zh['task.plan.instruction'], 'Compare current permitted versions')
  await view.fill(zh['task.plan.reason'], 'Check before regrouping')
  await view.preview()
  const first = run.writes()[0]!.body!
  await view.undo(); await view.undo(); await view.undo()
  expect(view.button(zh['task.plan.newStep'])).toBeUndefined()
  expect(view.field(zh['task.plan.name']).value).toBe('Title root')
  await view.redo(); await view.redo(); await view.redo()
  expect(view.field(zh['task.plan.name']).value).toBe('New version check')
  await view.preview()
  expect(run.writes()[1]!.body).toEqual(first)
  expect(run.reads()).toHaveLength(1)
})

it('编辑历史有二十次上限，反复撤销和重做不读计划、不提交或启动执行', async () => {
  const run = fixture(), view = await render()
  await view.open(); await view.click(view.button('Title first'))
  for (let index = 0; index < 40; index++) {
    await view.fill(zh['task.plan.instruction'], `Check scope ${index}`)
    await act(async () => view.field(zh['task.plan.instruction']).dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  }
  let undone = 0, redone = 0
  while (!view.history('undo').disabled && undone < 50) { await view.undo(); undone++ }
  expect(undone).toBe(20)
  expect(view.field(zh['task.plan.instruction']).value).not.toBe('Check first')
  while (!view.history('redo').disabled && redone < 50) { await view.redo(); redone++ }
  expect(redone).toBe(20)
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check scope 39')
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toEqual([])
})

it.each(['readonly', 'stale', 'conflict', 'uncertain'] as const)('%s时不能用本地历史绕过核对与应用边界', async state => {
  const run = fixture(), view = await render()
  await view.draft(); await view.preview()
  if (state === 'readonly') await view.update({ editable: false })
  else if (state === 'stale') await view.update({ revision: 4 })
  else if (state === 'conflict') {
    run.control.inspect = async () => Response.json({ error: '版本已更新', code: 'revision_conflict' }, { status: 409 })
    await view.preview()
  } else {
    run.control.apply = async () => { throw new Error('Response lost') }
    await view.apply()
  }
  const requests = run.writes().length
  expect(view.history('undo').disabled).toBe(true)
  await view.undo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(run.writes()).toHaveLength(requests)
})

it('在途预览期间历史操作禁用，取消重读保留历史，重读成功才清除', async () => {
  const run = fixture(), view = await render(), pending = Promise.withResolvers<Response>()
  await view.draft()
  run.control.inspect = () => pending.promise
  await view.preview()
  expect(view.history('undo').disabled).toBe(true)
  await view.undo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  await act(async () => pending.resolve(Response.json(run.impact())))
  expect(view.history('undo').disabled).toBe(false)
  await view.click(view.button(zh['task.plan.reload']))
  await view.click(view.button(zh.cancel, document.body))
  expect(view.history('undo').disabled).toBe(false)
  await view.click(view.button(zh['task.plan.reload']))
  await view.click(view.button(zh.confirm, document.body))
  expect(view.history('undo').disabled).toBe(true)
  expect(view.history('redo').disabled).toBe(true)
  expect(view.field(zh['task.plan.reason']).value).toBe('')
  expect(run.writes()).toHaveLength(1)
})

it('只更新执行状态时轻量核对保留草稿、原因和历史，仍需按新版本明确预览再应用', async () => {
  const run = fixture()
  run.control.definition.fingerprint = 'a'.repeat(64)
  const view = await render()
  await view.draft(); await view.preview()
  const first = run.writes()[0]!.body!
  run.control.definition.revision = 4
  await view.update({ revision: 4 })
  expect(view.container.textContent).toContain(zh['task.plan.executionChanged'])
  await view.click(view.button(zh['task.plan.checkKeepingDraft']))
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.field(zh['task.plan.reason']).value).toBe('Source scope clarified')
  expect(view.history('undo').disabled).toBe(false)
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(run.reads()).toHaveLength(1)
  expect(run.checks()).toHaveLength(1)
  expect(run.writes()).toHaveLength(1)
  expect(view.props.onChanged).toHaveBeenCalledOnce()
  await view.undo()
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check first')
  await view.redo(); await view.preview()
  expect(run.writes()[1]!.body).toEqual({ ...first, revision: 4 })
  await view.apply()
  expect(run.writes()[2]!.body).toEqual({ ...first, revision: 4, preview: false })
})

it.each(['plan-version', 'fingerprint'] as const)('核对发现%s变化时不替换草稿、不重新绑定旧预览', async condition => {
  const run = fixture()
  run.control.definition.fingerprint = 'a'.repeat(64)
  run.control.identity = async () => Response.json({ ticketId: 'task-1', revision: 4,
    planVersion: condition === 'plan-version' ? 2 : 1,
    fingerprint: condition === 'fingerprint' ? 'b'.repeat(64) : 'a'.repeat(64) })
  const view = await render()
  await view.draft(); await view.preview(); await view.update({ revision: 4 })
  await view.click(view.button(zh['task.plan.checkKeepingDraft']))
  expect(view.container.textContent).toContain(zh['task.plan.definitionChanged'])
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.field(zh['task.plan.reason']).value).toBe('Source scope clarified')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  expect(view.button(zh['task.plan.checkKeepingDraft'])).toBeUndefined()
  expect(view.button(zh['task.plan.apply'])).toBeUndefined()
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toHaveLength(1)
})

it('核对在途期间进度再次变化时保留草稿，用户再次核对前不自动重试', async () => {
  const run = fixture(), pending = Promise.withResolvers<Response>()
  run.control.definition.fingerprint = 'a'.repeat(64)
  run.control.identity = () => pending.promise
  const view = await render()
  await view.draft(); await view.update({ revision: 4 })
  await act(async () => {
    view.button(zh['task.plan.checkKeepingDraft']).click()
    view.button(zh['task.plan.checkKeepingDraft']).click()
  })
  expect(run.checks()).toHaveLength(1)
  expect(view.button(zh['task.plan.reload']).disabled).toBe(true)
  await view.update({ revision: 5 })
  await act(async () => pending.resolve(Response.json({ ticketId: 'task-1', revision: 4, planVersion: 1, fingerprint: 'a'.repeat(64) })))
  expect(view.container.textContent).toContain(zh['task.plan.checkAdvanced'])
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
  expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  expect(run.checks()).toHaveLength(1)
  expect(view.props.onChanged).not.toHaveBeenCalled()
  run.control.identity = undefined; run.control.definition.revision = 5
  await view.click(view.button(zh['task.plan.checkKeepingDraft']))
  expect(run.checks()).toHaveLength(2)
  expect(view.button(zh['task.plan.preview']).disabled).toBe(false)
  expect(run.writes()).toEqual([])
})

it.each(['wrong-ticket', 'older-revision', 'fractional-revision', 'invalid-hash'] as const)(
  '核对回执为%s时不能解锁旧草稿，修复后仍可由用户重试', async condition => {
    const run = fixture()
    run.control.definition.fingerprint = 'a'.repeat(64)
    run.control.identity = async () => Response.json({
      ticketId: condition === 'wrong-ticket' ? 'another-task' : 'task-1',
      revision: condition === 'older-revision' ? 2 : condition === 'fractional-revision' ? 4.5 : 4,
      planVersion: 1, fingerprint: condition === 'invalid-hash' ? 'invalid' : 'a'.repeat(64),
    })
    const view = await render()
    await view.draft(); await view.update({ revision: 4 })
    await view.click(view.button(zh['task.plan.checkKeepingDraft']))
    expect(view.container.textContent).toContain(zh['task.plan.checkUnconfirmed'])
    expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
    expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
    expect(view.props.onChanged).not.toHaveBeenCalled()
    run.control.identity = undefined; run.control.definition.revision = 4
    await view.click(view.button(zh['task.plan.checkKeepingDraft']))
    expect(view.button(zh['task.plan.preview']).disabled).toBe(false)
    expect(run.reads()).toHaveLength(1)
    expect(run.writes()).toEqual([])
  })

it('轻量核对网络失败不把读取当作未知写入，重试后原草稿与历史可用', async () => {
  const run = fixture()
  run.control.definition.fingerprint = 'a'.repeat(64)
  run.control.identity = async () => { throw new Error('Connection interrupted') }
  const view = await render()
  await view.draft(); await view.update({ revision: 4 })
  await view.click(view.button(zh['task.plan.checkKeepingDraft']))
  expect(view.button(zh['task.plan.checkKeepingDraft']).disabled).toBe(false)
  expect(view.container.textContent).not.toContain(zh['task.plan.unconfirmed'])
  expect(view.field(zh['task.plan.reason']).value).toBe('Source scope clarified')
  run.control.identity = undefined; run.control.definition.revision = 4
  await view.click(view.button(zh['task.plan.checkKeepingDraft']))
  expect(view.history('undo').disabled).toBe(false)
  expect(run.checks()).toHaveLength(2)
  expect(run.writes()).toEqual([])
})

it.each(['plan-changed', 'readonly', 'unmounted'] as const)('核对期间页面变为%s时不让迟到结果解锁或重读旧任务', async condition => {
  const run = fixture(), pending = Promise.withResolvers<Response>()
  run.control.definition.fingerprint = 'a'.repeat(64)
  run.control.identity = () => pending.promise
  const view = await render()
  await view.draft(); await view.update({ revision: 4 })
  await view.click(view.button(zh['task.plan.checkKeepingDraft']))
  if (condition === 'plan-changed') await view.update({ revision: 5, planVersion: 2 })
  else if (condition === 'readonly') await view.update({ editable: false })
  else view.dispose()
  await act(async () => pending.resolve(Response.json({ ticketId: 'task-1', revision: 4, planVersion: 1, fingerprint: 'a'.repeat(64) })))
  if (condition !== 'unmounted') {
    expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
    expect(view.button(zh['task.plan.preview']).disabled).toBe(true)
  }
  if (condition === 'plan-changed') expect(view.container.textContent).toContain(zh['task.plan.definitionChanged'])
  else expect(view.props.onChanged).not.toHaveBeenCalled()
  expect(run.reads()).toHaveLength(1)
  expect(run.writes()).toEqual([])
})

it.each(['legacy', 'invalid-capability', 'uncertain'] as const)('%s不开放保留草稿核对，也不后台探测新接口', async condition => {
  const run = fixture()
  if (condition === 'invalid-capability') run.control.definition.fingerprint = 'not-a-plan-hash'
  if (condition === 'uncertain') run.control.definition.fingerprint = 'a'.repeat(64)
  const view = await render()
  await view.draft(); await view.preview()
  if (condition === 'uncertain') {
    run.control.apply = async () => { throw new Error('Response lost') }
    await view.apply()
  }
  await view.update({ revision: 4 })
  expect(view.button(zh['task.plan.checkKeepingDraft'])).toBeUndefined()
  expect(run.checks()).toEqual([])
  expect(view.field(zh['task.plan.instruction']).value).toBe('Check the corrected source')
})

it('任务详情轮询读到新进度后可保留草稿核对，成功重读状态并用当前执行版本预览', async () => {
  const run = fixture(), original = vi.mocked(fetch).getMockImplementation()!
  run.control.definition.fingerprint = 'a'.repeat(64)
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  let revision = 3, detailReads = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!new URL(url, 'http://localhost').pathname.endsWith('/tasks/task-1')) return original(url, init)
    detailReads++
    return Response.json({ ticketId: 'task-1', title: 'Task', paused: false, ended: null, activity: 'held',
      inputs: { total: 0, pendingDelivery: 0 }, result: null, resultError: null,
      workflow: { revision, planVersion: 1, initialMode: 'custom', phase: 'active', autoRun: false,
        awaitingValidation: false, referenceIntegrity: 'valid', requiresOrchestrator: false, planReviewRequired: false,
        progress: { total: 4, pending: 4, running: 0, completed: 0, suspended: 0, pruned: 0 },
        blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
        dependencyBlockers: { total: 0, omitted: 0, items: [] } } })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  cleanups.push(() => { act(() => root.unmount()); container.remove(); visible.mockRestore() })
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  await act(async () => root.render(<PanelProvider t={t} interval={60_000}><TasksPage id="task-1" /></PanelProvider>))
  await flush()
  const disclosure = [...container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
    .find(row => row.textContent === zh['task.plan.title'])!
  await act(async () => disclosure.click()); await flush()
  await act(async () => button('Title first').click())
  const instruction = container.querySelector<HTMLTextAreaElement>('.dt-task-plan-fields textarea')!
  const reason = [...container.querySelectorAll<HTMLTextAreaElement>('.dt-task-plan textarea')].at(-1)!
  await act(async () => {
    for (const [element, value] of [[instruction, 'Keep the operator draft'], [reason, 'Clarify source purpose']] as const) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  revision = 4; run.control.definition.revision = 4
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await flush()
  expect(button(zh['task.plan.preview']).disabled).toBe(true)
  const beforeCheck = detailReads
  await act(async () => button(zh['task.plan.checkKeepingDraft']).click()); await flush()
  expect(detailReads).toBeGreaterThan(beforeCheck)
  expect(instruction.value).toBe('Keep the operator draft')
  expect(reason.value).toBe('Clarify source purpose')
  expect(button(zh['task.plan.preview']).disabled).toBe(false)
  expect(run.reads()).toHaveLength(1)
  expect(run.checks()).toHaveLength(1)
  expect(run.writes()).toEqual([])
  await act(async () => button(zh['task.plan.preview']).click()); await flush()
  expect(run.writes()[0]!.body).toMatchObject({ revision: 4, reason: 'Clarify source purpose', preview: true })
})

it.each(['paused', 'ended', 'unreadable'] as const)('任务详情更新为%s时保留计划草稿并撤回应用权限', async condition => {
  const run = fixture(), original = vi.mocked(fetch).getMockImplementation()!
  let changed = false
  const visible = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname
    if (!path.endsWith('/tasks/task-1')) return original(url, init)
    if (changed && condition === 'unreadable') return Response.json({ error: '任务状态暂时不可读取' }, { status: 503 })
    return Response.json({
      ticketId: 'task-1', title: 'Task', paused: changed && condition === 'paused',
      ended: changed && condition === 'ended' ? { outcome: 'stopped', by: 'human', at: '2026-11-07T00:00:00Z' } : null,
      activity: 'held', inputs: { total: 0, pendingDelivery: 0 }, result: null, resultError: null,
      workflow: { revision: 3, planVersion: 1, initialMode: 'custom', phase: 'active', autoRun: false,
        awaitingValidation: false, referenceIntegrity: 'valid', requiresOrchestrator: false, planReviewRequired: false,
        progress: { total: 4, pending: 4, running: 0, suspended: 0, completed: 0, pruned: 0 },
        blockers: { total: 0, omitted: 0, requiresOrchestrator: false, items: [] },
        dependencyBlockers: { total: 0, omitted: 0, items: [] } },
    })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  cleanups.push(() => { act(() => root.unmount()); container.remove(); visible.mockRestore() })
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  await act(async () => root.render(<PanelProvider t={t} interval={60_000}><TasksPage id="task-1" /></PanelProvider>))
  await flush()
  expect(run.reads()).toHaveLength(0)
  const disclosure = [...container.querySelectorAll<HTMLElement>('[data-disclosure-row]')]
    .find(item => item.textContent === zh['task.plan.title'])!
  await act(async () => disclosure.click()); await flush()
  await act(async () => button('Title first').click())
  const instruction = container.querySelector<HTMLTextAreaElement>('.dt-task-plan-fields textarea')!
  const reason = [...container.querySelectorAll<HTMLTextAreaElement>('.dt-task-plan textarea')].at(-1)!
  await act(async () => {
    for (const [element, value] of [[instruction, 'Keep the corrected draft'], [reason, 'Scope changed']] as const) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await act(async () => button(zh['task.plan.preview']).click()); await flush()
  expect(button(zh['task.plan.apply']).disabled).toBe(false)
  changed = true
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await flush()
  expect(instruction.value).toBe('Keep the corrected draft')
  expect(instruction.matches(':disabled')).toBe(true)
  expect(button(zh['task.plan.apply']).disabled).toBe(true)
  await act(async () => button(zh['task.plan.apply']).click())
  expect(run.writes()).toHaveLength(1)
})
