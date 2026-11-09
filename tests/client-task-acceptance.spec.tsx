// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PanelProvider } from '../src/client/provider.tsx'
import { TaskAcceptance } from '../src/client/task-acceptance.tsx'
import { acceptancePreview, acceptanceSource } from './fixtures/acceptance-basis.ts'
import { zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import type { AcceptanceDecision } from '../src/development/acceptance-basis.ts'
import { acceptanceMapping, type AcceptanceCheck } from '../src/development/acceptance-checks.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof zh) => zh[key]) as T
const dispose: (() => void)[] = []
afterEach(() => { dispose.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function fixture() {
  const receipt = acceptanceSource(), data = acceptancePreview(receipt), writes: AcceptanceDecision[] = []
  let reads = 0
  const controls = { post: undefined as undefined | ((body: AcceptanceDecision) => Promise<Response>),
    get: undefined as undefined | (() => Promise<Response>) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/state')) return Response.json({ load: { running: 0, queued: 0 } })
    if (init?.method !== 'POST') { reads++; return controls.get?.() ?? Response.json(data) }
    const body = JSON.parse(String(init.body)) as AcceptanceDecision
    writes.push(body)
    if (controls.post) return controls.post(body)
    data.events.push({ action: body.action, at: '2026-11-08T00:01:00Z', requestId: body.requestId,
      sourceCheckId: receipt.requestId, fingerprint: '8'.repeat(64), ...(body.action === 'confirm' ? { evidence: body.evidence } : {}) })
    data.revision++
    data.state = body.action === 'confirm' ? 'confirmed' : 'withdrawn'
    return Response.json({ ...data, changed: true, current: true })
  }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<PanelProvider t={t} interval={60000}><TaskAcceptance id="task-a" receipt={receipt} /></PanelProvider>))
  dispose.push(() => { act(() => root.unmount()); container.remove() })
  const click = async (key: keyof typeof zh) => {
    const button = [...container.querySelectorAll<HTMLElement>('button,[role="button"]')]
      .find(item => item.textContent === zh[key])!
    expect(button).toBeTruthy()
    await act(async () => button.click()); await flush()
  }
  const fill = async () => {
    const fields = [container.querySelector('input')!, container.querySelector('textarea')!]
    await act(async () => {
      fields.forEach((field, index) => {
        const prototype = index === 0 ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, index === 0 ? '需求合同 v1' : '覆盖顺序要求，设备验证待补')
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    })
  }
  return { container, writes, reads: () => reads, data, controls, click, fill }
}
it('按需读取规则，确认仅提交依据与版本；可撤回且历史保留', async () => {
  const view = await fixture()
  expect(view.reads()).toBe(0)
  await view.click('task.acceptance.title')
  expect(view.reads()).toBe(1)
  expect(view.container.textContent).toContain('不得丢失消息')
  expect(view.writes).toHaveLength(0)
  await view.fill()
  await view.click('task.acceptance.confirm')
  expect(view.container.textContent).toContain(zh['task.acceptance.confirmed'])
  const confirm = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === zh['task.acceptance.confirm'])!
  expect(confirm.disabled).toBe(true)
  expect(view.writes[0]).not.toHaveProperty('acceptance')
  expect(view.writes[0]).not.toHaveProperty('command')
  await view.click('task.acceptance.withdraw')
  expect(view.container.textContent).toContain(zh['task.acceptance.withdrawn'])
  expect(view.data.events.map(event => event.action)).toEqual(['confirm', 'withdraw'])
})
it('接口冲突不自动重发，不重新绑定新依据；重新核对后再决定', async () => {
  const view = await fixture()
  await view.click('task.acceptance.title'); await view.fill()
  view.controls.post = async () => Response.json({ error: '规则已变化' }, { status: 409 })
  await view.click('task.acceptance.confirm')
  expect(view.container.textContent).toContain('规则已变化')
  expect(view.writes).toHaveLength(1)
  expect(view.container.textContent).not.toContain(zh['task.acceptance.confirmed'])
  await view.click('task.acceptance.refresh')
  expect(view.reads()).toBe(2)
  expect(view.writes).toHaveLength(1)
})
it('离开后迟到确认不污染新访问，也不重复发出决定', async () => {
  const view = await fixture()
  let resolve!: (value: Response) => void
  view.controls.post = () => new Promise(done => { resolve = done })
  await view.click('task.acceptance.title'); await view.fill(); await view.click('task.acceptance.confirm')
  await view.click('task.acceptance.title')
  resolve(Response.json({ ...view.data, state: 'confirmed', revision: 1, current: true, changed: true }))
  await flush()
  await view.click('task.acceptance.title')
  expect(view.container.textContent).toContain(zh['task.acceptance.pending'])
  expect(view.writes).toHaveLength(1)
})
it.each(['wrong-source', 'old-host'])('%s 不显示可确认依据', async kind => {
  const view = await fixture()
  view.controls.get = async () => kind === 'old-host' ? Response.json({ error: '当前宿主没有此能力' }, { status: 404 })
    : Response.json({ ...view.data, source: { ...view.data.source, combinationId: 'f'.repeat(64) } })
  await view.click('task.acceptance.title')
  expect(view.container.querySelector('input')).toBeNull()
  expect(view.writes).toHaveLength(0)
})

it('点击期间去重；带发布授权或错依据的成功响应不显示确认', async () => {
  const view = await fixture()
  let resolve!: (value: Response) => void
  view.controls.post = () => new Promise(done => { resolve = done })
  await view.click('task.acceptance.title'); await view.fill()
  const button = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === zh['task.acceptance.confirm'])!
  await act(async () => { button.click(); button.click() })
  expect(view.writes).toHaveLength(1)
  resolve(Response.json({ ...view.data, state: 'confirmed', revision: 1, current: true,
    basisDigest: 'f'.repeat(64), assurance: { ...view.data.assurance, publishAllowed: true } }))
  await flush()
  expect(view.container.textContent).not.toContain(zh['task.acceptance.confirmed'])
  expect(view.container.textContent).toContain(zh['task.acceptance.unconfirmed'])
})

it.each(['declared', 'incomplete', 'legacy'] as const)('%s 映射只显示声明状态，不增加执行或提交请求', async state => {
  const view = await fixture()
  const check: AcceptanceCheck = { id: 'contract', title: '协议检查', requires: [],
    requirements: [{ scope: 'task', index: 0, text: '不得丢失消息' },
      { scope: 'task', index: 1, text: '不得改变消息顺序' }, { scope: 'module', index: 0, text: '兼容原协议' }],
    command: { tool: 'tool', cwd: { root: 'source', path: '.' }, argv: [{ root: 'recipe', path: 'contract checks.ps1' }] },
    result: { format: 'junit-xml', path: 'results.xml', minimumTests: 2 }, timeoutMs: 1000 }
  if (state === 'incomplete') check.requirements[0]!.text = '另一条要求'
  view.data.mapping = acceptanceMapping(view.data.basis.task.acceptance, view.data.basis.module.acceptance, [check])
  if (state === 'legacy') view.controls.get = async () => {
    const { mapping: _, ...old } = view.data
    return Response.json(old)
  }
  await view.click('task.acceptance.title')
  expect(view.container.textContent).toContain(zh[state === 'declared' ? 'task.acceptance.mappingDeclared'
    : state === 'incomplete' ? 'task.acceptance.mappingIncomplete' : 'task.acceptance.mappingMissing'])
  if (state === 'incomplete') expect(view.container.textContent).toContain(zh['task.acceptance.unmapped'])
  expect(view.writes).toHaveLength(0)
  expect(view.reads()).toBe(1)
})
