import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { HmmWorkflows } from '../src/hmm/workflow.ts'
import { HmmDevices } from '../src/hmm/devices.ts'
import { HttpDevicePort } from '../src/hmm/device-http.ts'
import { DEVICE_LIMITS, type DeviceDescriptor, type DeviceHit, type DevicePort } from '../src/hmm/device-contracts.ts'
import type { HmmActor, HmmCommand } from '../src/hmm/model.ts'
import type { Ticket } from '../src/core/model.ts'
import { KV } from '../src/kv.ts'

const actor: HmmActor = { role: 'controller' }
const text = 'Delivery is scheduled for November 8.'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const hit: DeviceHit = { sourceId: 'file:123', title: 'Schedule', domain: 'files', version: 'v1',
  contentHash: digest(text), observedAt: '2026-11-02T00:00:00.000Z', totalChars: text.length, sensitivity: 'personal' }
const descriptor: DeviceDescriptor = { id: 'phone', label: 'User phone', domains: ['files'], route: 'direct' }
const ticket = (id: string): Ticket => ({
  id, title: id, decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' },
    actor: { source: 'test', id: 'owner' }, scope: 'test' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'e1', triggerIds: ['e1'] },
})
let directory: string, store: Store, hmm: HmmWorkflows, devices: HmmDevices, lifetime: AbortController
let port: DevicePort, detach: () => void
const signal = () => new AbortController().signal
const view = () => hmm.view(actor, 't1')
const command = (input: HmmCommand) => hmm.apply(actor, 't1', view().revision, input)
const grant = (extra = {}) => hmm.grantDevice(actor, 't1', view().revision,
  { id: 'local', nodeId: 'a', deviceId: 'phone', domain: 'files', ...extra })
const query = () => devices.query(actor, 't1', 'a', { grantId: 'local' }, signal())
const read = (handle: string, extra = {}) => devices.read(actor, 't1', 'a', { handle, ...extra }, signal())
function services() {
  hmm = new HmmWorkflows(store, undefined, { changed: () => store.afterCommit(() => devices?.reconcile()) })
  devices = new HmmDevices(hmm, lifetime.signal)
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hmm-devices-'))
  store = new Store(join(directory, 'state.sqlite')); lifetime = new AbortController()
  services()
  for (const id of ['t1', 't2']) {
    store.tickets.save(ticket(id))
    hmm.create(actor, id, { goal: 'Verify evidence', nodes: [
      { id: 'root', title: 'Root', mode: 'parallel' },
      { id: 'a', parentId: 'root', title: 'Read', instruction: 'Read schedule', evidenceRequired: true },
      { id: 'b', parentId: 'root', title: 'Other', instruction: 'Independent task' },
    ] })
  }
  port = {
    query: vi.fn(async () => ({ hits: [hit], truncated: false })),
    read: vi.fn(async request => ({ version: hit.version, contentHash: hit.contentHash, offset: request.offset,
      text: text.slice(request.offset, request.offset + request.length), totalChars: text.length })),
  }
  detach = devices.attach(descriptor, port)
  grant(); command({ action: 'start', nodeId: 'a' })
})
afterEach(() => {
  lifetime.abort(); vi.useRealTimers(); store.close(); rmSync(directory, { recursive: true, force: true })
})

it('查询仅返回元数据，实际读取绑定来源、片段哈希与当前节点回执', async () => {
  const before = view().revision
  const result = await query()
  expect(result.hits).toHaveLength(1)
  expect(result.hits[0]).not.toHaveProperty('text')
  expect(view().revision).toBe(before)
  const evidence = await read(result.hits[0]!.handle, { offset: 3, length: 8 })
  expect(evidence).toMatchObject({ kind: 'device_snapshot', text: text.slice(3, 11), contentHash: digest(text.slice(3, 11)),
    source: { deviceId: 'phone', sourceId: hit.sourceId, version: 'v1', offset: 3, end: 11, contentHash: hit.contentHash } })
  expect(port.read).toHaveBeenCalledWith(expect.objectContaining({ sourceId: hit.sourceId, version: 'v1', offset: 3, length: 8 }),
    expect.any(AbortSignal))
  const lease = store.get(KV.hmm.workflow('t1'))!.nodes.find(node => node.id === 'a')!.lease!
  command({ action: 'complete', nodeId: 'a', lease, summary: 'Based on the read range', evidenceRefs: [evidence.ref] })
  expect(view().referenceIntegrity).toBe('valid')
})

it('重复读取复用快照和回执，不按调用次数复制片段', async () => {
  const handle = (await query()).hits[0]!.handle
  const first = await read(handle), second = await read(handle)
  expect(second.ref).toBe(first.ref)
  expect(second.revision).toBe(first.revision)
  const state = store.get(KV.hmm.workflow('t1'))!
  expect(state.evidence!.documents).toHaveLength(1)
  expect(state.evidence!.receipts).toHaveLength(1)
})

it('节点、工单和调用者不能借用查询句柄或自行扩权', async () => {
  const handle = (await query()).hits[0]!.handle
  await expect(devices.query(actor, 't1', 'b', { grantId: 'local' }, signal())).rejects.toMatchObject({ code: 'device_access_denied' })
  await expect(devices.read(actor, 't1', 'b', { handle }, signal())).rejects.toMatchObject({ code: 'device_handle_stale' })
  await expect(devices.read(actor, 't2', 'a', { handle }, signal())).rejects.toMatchObject({ code: 'device_handle_stale' })
  await expect(devices.read({ role: 'worker', ticketId: 't2' }, 't1', 'a', { handle }, signal())).rejects.toThrow()
  await expect(devices.query(actor, 't1', 'a', { grantId: 'local', includeRestricted: true }, signal())).rejects.toThrow()
  expect(() => hmm.grantDevice({ role: 'worker', ticketId: 't1' }, 't1', view().revision, {})).toThrow('总管')
})

it('查询数据域和敏感级别固定于授权，越界返回不暴露内容', async () => {
  port.query = vi.fn(async () => ({ hits: [hit, { ...hit, domain: 'wechat', title: 'SECRET' },
    { ...hit, sensitivity: 'restricted', title: 'PRIVATE' }], truncated: false }))
  const result = await query()
  expect(result.hits.map(item => item.title)).toEqual(['Schedule'])
  expect(result.truncated).toBe(true)
  expect(port.query).toHaveBeenCalledWith({ domain: 'files', limit: 8, text: undefined, includeRestricted: false }, expect.any(AbortSignal))
})

it('离线和缺少能力分别报错，不伪装成成功的空查询', async () => {
  detach()
  await expect(query()).rejects.toMatchObject({ code: 'device_offline' })
  devices.attach({ ...descriptor, domains: ['photos'] }, port)
  await expect(query()).rejects.toMatchObject({ code: 'device_capability_missing' })
  expect(port.query).not.toHaveBeenCalled()
})

it('微信数据拒绝普通连接，宿主专用路由仍受节点授权约束', async () => {
  expect(() => devices.attach({ id: 'root', label: 'Root', domains: ['wechat'], route: 'direct' }, port)).toThrow('香港')
  grant({ deviceId: 'root', domain: 'wechat' })
  await expect(query()).rejects.toMatchObject({ code: 'device_offline' })
  devices.attach({ id: 'root', label: 'Root', domains: ['wechat'], route: 'designated-hk' }, port)
  port.query = vi.fn(async () => ({ hits: [{ ...hit, domain: 'wechat' }], truncated: false }))
  expect((await query()).hits[0]).toMatchObject({ deviceId: 'root', domain: 'wechat' })
})

it('来源版本变化或范围错配不能保存为可引用证据', async () => {
  const handle = (await query()).hits[0]!.handle
  port.read = vi.fn(async () => ({ version: 'v2', contentHash: hit.contentHash, offset: 0, totalChars: text.length, text }))
  await expect(read(handle)).rejects.toMatchObject({ code: 'device_version_stale' })
  port.read = vi.fn(async () => ({ version: 'v1', contentHash: hit.contentHash, offset: 2, totalChars: text.length, text }))
  await expect(read(handle)).rejects.toMatchObject({ code: 'device_range_invalid' })
  expect(store.get(KV.hmm.workflow('t1'))!.evidence).toBeUndefined()
})

it('完整读取验证全文哈希，局部读取保存独立片段哈希', async () => {
  const handle = (await query()).hits[0]!.handle
  port.read = vi.fn(async () => ({ version: 'v1', contentHash: hit.contentHash, offset: 0,
    totalChars: text.length, text: 'x'.repeat(text.length) }))
  await expect(read(handle)).rejects.toMatchObject({ code: 'device_hash_invalid' })
  expect(store.get(KV.hmm.workflow('t1'))!.evidence).toBeUndefined()
})

it('来源更新覆盖同范围快照，旧回执不能继续证明新的内容', async () => {
  const first = await read((await query()).hits[0]!.handle)
  const changed = 'Delivery is scheduled for November 9.'
  port.query = vi.fn(async () => ({ hits: [{ ...hit, version: 'v2', contentHash: digest(changed) }], truncated: false }))
  port.read = vi.fn(async () => ({ version: 'v2', contentHash: digest(changed), offset: 0, totalChars: changed.length, text: changed }))
  const second = await read((await query()).hits[0]!.handle)
  expect(second.documentId).toBe(first.documentId)
  expect(second.version).not.toBe(first.version)
  expect(store.get(KV.hmm.workflow('t1'))!.evidence!.documents).toHaveLength(1)
  const lease = store.get(KV.hmm.workflow('t1'))!.nodes.find(node => node.id === 'a')!.lease!
  expect(() => command({ action: 'complete', nodeId: 'a', lease, summary: 'Old', evidenceRefs: [first.ref] })).toThrow('更新')
  command({ action: 'complete', nodeId: 'a', lease, summary: 'Current', evidenceRefs: [second.ref] })
})

it('拒绝超量、非法字符和带额外正文的适配器响应', async () => {
  port.query = vi.fn(async () => ({ hits: [{ ...hit, text: 'UNREQUESTED' }], truncated: false }))
  await expect(query()).rejects.toThrow()
  port.query = vi.fn(async () => ({ hits: [hit], truncated: false }))
  const handle = (await query()).hits[0]!.handle
  port.read = vi.fn(async () => ({ version: 'v1', contentHash: hit.contentHash, offset: 0,
    totalChars: text.length, text: '\uD800' }))
  await expect(read(handle)).rejects.toThrow('Unicode')
  port.query = vi.fn(async () => ({ hits: [], truncated: false, extra: 'x'.repeat(DEVICE_LIMITS.responseBytes) }))
  await expect(query()).rejects.toMatchObject({ code: 'device_response_large' })
  await expect(read(handle, { length: 8001 })).rejects.toThrow()
})

it('撤回授权删除当前片段，阻止既有结果发布、验收及依赖它的新执行', async () => {
  const evidence = await read((await query()).hits[0]!.handle)
  const lease = store.get(KV.hmm.workflow('t1'))!.nodes.find(node => node.id === 'a')!.lease!
  command({ action: 'complete', nodeId: 'a', lease, summary: 'Verified', evidenceRefs: [evidence.ref] })
  const definition = hmm.definition(actor, 't1')
  hmm.revise(actor, 't1', { revision: view().revision, reason: '增加依赖核验', plan: { ...definition.plan, nodes: [
    ...definition.plan.nodes,
    { id: 'followup', parentId: 'root', title: '后续核验', instruction: '核对设备来源结果', dependsOn: ['a'] },
  ] } })
  expect(view().runnable).toContain('followup')
  hmm.revokeDevice(actor, 't1', view().revision, 'local')
  expect(view().referenceIntegrity).toBe('invalid')
  expect(view().runnable).toEqual(['b'])
  expect(view().nodes.find(node => node.id === 'followup')).toMatchObject({ blockedBy: ['a'], attempt: 0 })
  expect(() => command({ action: 'start', nodeId: 'followup' })).toThrow('未就绪')
  const before = view()
  expect(() => command({ action: 'publish', nodeId: 'a' })).toThrow('失效')
  expect(view()).toEqual(before)
  expect(store.get(KV.hmm.workflow('t1'))!.evidence!.documents[0]).toMatchObject({ revoked: true })
  expect(store.get(KV.hmm.workflow('t1'))!.evidence!.documents[0]!.text).toBeUndefined()
})

it('撤权取消在途调用，迟到响应不能产生证据或自动恢复授权', async () => {
  const handle = (await query()).hits[0]!.handle
  let resolve!: (value: unknown) => void, observed!: AbortSignal
  port.read = async (_, s) => { observed = s; return new Promise(r => { resolve = r }) }
  const pending = read(handle)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'device_access_denied' })
  await Promise.resolve()
  hmm.revokeDevice(actor, 't1', view().revision, 'local')
  await rejected
  expect(observed.aborted).toBe(true)
  resolve({ version: 'v1', contentHash: hit.contentHash, offset: 0, totalChars: text.length, text })
  await Promise.resolve()
  expect(store.get(KV.hmm.workflow('t1'))!.evidence).toBeUndefined()
  grant()
  await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
})

it('重查会改变节点代次，使旧句柄及在途查询立即失效', async () => {
  const handle = (await query()).hits[0]!.handle
  let resolve!: (value: unknown) => void
  port.query = async () => new Promise(r => { resolve = r })
  const pending = query()
  const rejected = expect(pending).rejects.toThrow()
  await Promise.resolve()
  command({ action: 'recheck', nodeId: 'a', reason: 'New evidence' })
  await rejected
  resolve({ hits: [hit], truncated: false })
  await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
  expect(store.get(KV.hmm.workflow('t1'))!.evidence).toBeUndefined()
})

it('计划修订撤销在途设备读取，迟到片段不能进入新任务定义', async () => {
  const handle = (await query()).hits[0]!.handle
  let resolve!: (value: unknown) => void, observed!: AbortSignal
  port.read = async (_, s) => { observed = s; return new Promise(r => { resolve = r }) }
  const pending = read(handle), rejected = expect(pending).rejects.toThrow()
  await Promise.resolve()
  const definition = hmm.definition(actor, 't1')
  definition.plan.nodes[1]!.instruction = 'Read for a revised purpose'
  hmm.revise(actor, 't1', { revision: definition.revision, plan: definition.plan, reason: 'Purpose changed' })
  await rejected
  expect(observed.aborted).toBe(true)
  resolve({ version: 'v1', contentHash: hit.contentHash, offset: 0, totalChars: text.length, text })
  await Promise.resolve()
  expect(store.get(KV.hmm.workflow('t1'))!.evidence).toBeUndefined()
  expect(view().deviceGrants[0]!.revoked).toBe(true)
  grant()
  await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
})

it('取消和超时及时返回，忽略取消的适配器仍占并发槽，防止重试堆积', async () => {
  vi.useFakeTimers()
  const releases: (() => void)[] = []
  port.query = async () => new Promise(resolve => { releases.push(() => resolve({ hits: [], truncated: false })) })
  const first = query(), checkFirst = expect(first).rejects.toMatchObject({ code: 'device_timeout' })
  await vi.advanceTimersByTimeAsync(DEVICE_LIMITS.timeoutMs)
  await checkFirst
  const second = query(), checkSecond = expect(second).rejects.toMatchObject({ code: 'device_timeout' })
  await vi.advanceTimersByTimeAsync(DEVICE_LIMITS.timeoutMs)
  await checkSecond
  await expect(query()).rejects.toMatchObject({ code: 'device_busy' })
  expect(devices.status().active).toBe(2)
  for (const release of releases) release()
  await vi.advanceTimersByTimeAsync(0)
  expect(devices.status().active).toBe(0)
})

it.each(['resolve', 'reject'] as const)('HTTP 清理 %s 前取消及时返回，但重连不能提前释放并发槽', async outcome => {
  detach()
  const fetcher = vi.fn<typeof fetch>(), cancel = vi.fn()
  port = new HttpDevicePort({ baseUrl: 'https://phone.example', token: 't'.repeat(16), fetcher })
  detach = devices.attach(descriptor, port)
  const cleanups: Array<(error?: Error) => void> = []
  const bodies: ReadableStream<Uint8Array>[] = []
  try {
    for (let index = 0; index < DEVICE_LIMITS.perDevice; index++) {
      const reading = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>()
      cleanups.push(error => error ? cleanup.reject(error) : cleanup.resolve())
      const body = new ReadableStream<Uint8Array>({
        pull() { reading.resolve() },
        cancel() { cancel(); return cleanup.promise },
      }, { highWaterMark: 0 })
      bodies.push(body)
      fetcher.mockResolvedValueOnce(new Response(body))
      const caller = new AbortController(), reason = new Error(`cancel request ${index}`)
      const request = devices.query(actor, 't1', 'a', { grantId: 'local' }, caller.signal).catch(error => error)
      await reading.promise
      caller.abort(reason)
      expect(await request).toBe(reason)
    }
    // 排空已排队的微任务；不能把适配器尚未返回前的短暂占槽误当成通过。
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(devices.status()).toMatchObject({ active: DEVICE_LIMITS.perDevice, handles: 0 })
    expect(cancel).toHaveBeenCalledTimes(DEVICE_LIMITS.perDevice)
    detach()
    detach = devices.attach(descriptor, port)
    await expect(query()).rejects.toMatchObject({ code: 'device_busy' })
    expect(fetcher).toHaveBeenCalledTimes(DEVICE_LIMITS.perDevice)
  } finally {
    for (const finish of cleanups) finish(outcome === 'reject' ? new Error('private cleanup failure') : undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  expect(devices.status().active).toBe(0)
  expect(bodies.every(body => !body.locked)).toBe(true)
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ hits: [], truncated: false })))
  await expect(query()).resolves.toMatchObject({ hits: [], truncated: false })
  expect(devices.status().active).toBe(0)
})

it('多设备请求共享宿主并发限额，释放后可继续查询', async () => {
  const releases: (() => void)[] = [], pending: Promise<unknown>[] = []
  port.query = async () => new Promise(resolve => { releases.push(() => resolve({ hits: [], truncated: false })) })
  for (let i = 0; i <= DEVICE_LIMITS.active; i++) {
    const id = `device_${i}`
    devices.attach({ ...descriptor, id }, port)
    grant({ id, deviceId: id })
    const work = devices.query(actor, 't1', 'a', { grantId: id }, signal())
    if (i < DEVICE_LIMITS.active) pending.push(work)
    else await expect(work).rejects.toMatchObject({ code: 'device_busy' })
  }
  expect(devices.status().active).toBe(DEVICE_LIMITS.active)
  for (const release of releases) release()
  await Promise.all(pending)
  expect(devices.status().active).toBe(0)
})

it('设备连接和工单授权均有固定数量上限', () => {
  for (let i = 1; i < DEVICE_LIMITS.devices; i++) devices.attach({ ...descriptor, id: `device_${i}` }, port)
  expect(() => devices.attach({ ...descriptor, id: 'overflow' }, port)).toThrow('上限')
  for (let i = 1; i < DEVICE_LIMITS.grants; i++) grant({ id: `grant_${i}` })
  expect(() => grant({ id: 'overflow' })).toThrow('上限')
  expect(view().deviceGrants).toHaveLength(DEVICE_LIMITS.grants)
})

it('调用方取消后不保存回执，宿主退出也不等待无响应设备', async () => {
  let release!: (value: unknown) => void
  port.query = async () => new Promise(resolve => { release = resolve })
  const caller = new AbortController()
  const pending = devices.query(actor, 't1', 'a', { grantId: 'local' }, caller.signal)
  const rejected = expect(pending).rejects.toThrow('STOP')
  await Promise.resolve()
  caller.abort(new Error('STOP'))
  await rejected
  release({ hits: [hit], truncated: false })
  lifetime.abort()
  await expect(query()).rejects.toThrow()
  expect(devices.status().handles).toBe(0)
})

it('断开与重连不能继承旧连接签发的句柄', async () => {
  const handle = (await query()).hits[0]!.handle
  detach(); devices.attach(descriptor, port)
  await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
  expect(port.read).not.toHaveBeenCalled()
})

it('设备断开取消在途读取，即使随后重连也不能接受旧响应', async () => {
  const handle = (await query()).hits[0]!.handle
  let release!: (value: unknown) => void
  port.read = async () => new Promise(resolve => { release = resolve })
  const pending = read(handle), rejected = expect(pending).rejects.toMatchObject({ code: 'device_offline' })
  await Promise.resolve()
  detach(); devices.attach(descriptor, port)
  await rejected
  release({ version: 'v1', contentHash: hit.contentHash, offset: 0, totalChars: text.length, text })
  await Promise.resolve()
  expect(store.get(KV.hmm.workflow('t1'))!.evidence).toBeUndefined()
})

it('存储超限回滚取证，不留下半个片段或可用回执', async () => {
  const state = store.get(KV.hmm.workflow('t1'))!
  state.nodes.find(node => node.id === 'b')!.frame = 'x'.repeat(256 * 1024)
  store.set(KV.hmm.workflow('t1'), state)
  const handle = (await query()).hits[0]!.handle
  await expect(read(handle)).rejects.toMatchObject({ code: 'state_too_large' })
  expect(store.get(KV.hmm.workflow('t1'))!.evidence).toBeUndefined()
})

it('查询句柄有数量和时间上限，过期后释放空间', async () => {
  vi.useFakeTimers()
  port.query = vi.fn(async () => ({ hits: Array.from({ length: 8 }, (_, i) => ({ ...hit, sourceId: `file:${i}` })), truncated: false }))
  const first = await query()
  for (let i = 1; i < DEVICE_LIMITS.handles / 8; i++) await query()
  await expect(query()).rejects.toMatchObject({ code: 'device_handle_limit' })
  await vi.advanceTimersByTimeAsync(DEVICE_LIMITS.handleTtlMs)
  await expect(read(first.hits[0]!.handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
  expect((await query()).hits).toHaveLength(8)
})

it('设备授权随 SQLite 持久化，重启不会假定设备仍在线', async () => {
  const generation = view().deviceGrants[0]!.generation
  store.close(); store = new Store(join(directory, 'state.sqlite')); services()
  expect(view().deviceGrants[0]!.generation).toBe(generation)
  expect(devices.status().devices).toEqual([])
  await expect(query()).rejects.toMatchObject({ code: 'device_offline' })
})

it('授权写入使用版本检查，不能隐式扩大范围', () => {
  const old = view().revision
  grant({ domain: 'photos' })
  expect(() => hmm.grantDevice(actor, 't1', old, {
    id: 'local', nodeId: 'a', deviceId: 'phone', domain: 'files',
  })).toThrow('版本')
  expect(view().deviceGrants[0]!.domain).toBe('photos')
})
