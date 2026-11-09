import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachKnowledgeDevice } from '../src/index.ts'
import type { DevicePort } from '../src/hmm/device-contracts.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const controller = { role: 'controller' as const }
const nodeId = 'source_review'
const deviceId = 'handset-blue'
const grantId = 'allowed-files'
const text = 'The source records a delivery date of November 8.'
const contentHash = createHash('sha256').update(text).digest('hex')
const hit = { sourceId: 'schedule/contract-7', version: 'rev-3', contentHash, title: 'Delivery schedule',
  domain: 'files' as const, observedAt: '2026-11-03T00:00:00.000Z', totalChars: text.length, sensitivity: 'personal' as const }
const reply = { hits: [hit], truncated: false }
const plan = { goal: 'Check the permitted source', nodes: [
  { id: 'scope', title: 'Source checks', mode: 'parallel' as const },
  { id: nodeId, parentId: 'scope', title: 'Inspect source', instruction: 'Read the permitted source', evidenceRequired: true },
  { id: 'independent', parentId: 'scope', title: 'Separate check', instruction: 'Check the stated constraints' },
] }

describe.each(['repository', 'hmm'] as const)('%s 模式的知识工具', mode => {
  let h: Host, ticketId: string, port: DevicePort, detach: () => void
  const view = () => h.runtime.hmm.view(controller, ticketId)
  const request = () => ({ ticket_id: ticketId, node_id: nodeId, grantId })
  const query = (extra = {}) => h.runTool(h.runtime.masterId, 'knowledge_query', { ...request(), ...extra })
  const read = (handle: string, extra: Record<string, unknown> = {}) => h.runTool(h.runtime.masterId, 'hmm_evidence',
    { ticket_id: ticketId, node_id: nodeId, request: { action: 'device_read', handle }, ...extra })
  const snapshot = () => h.runtime.store.get(KV.hmm.workflow(ticketId))
  const grant = (id = ticketId) => h.runtime.hmm.grantDevice(controller, id,
    h.runtime.hmm.view(controller, id).revision, { id: grantId, nodeId, deviceId, domain: 'files' })
  const create = (id: string) => {
    const ticket = h.runtime.engine.createLocalTask({ requestId: id, title: 'Source review', goal: plan.goal })
    h.runtime.hmm.create(controller, ticket.id, plan)
    return ticket.id
  }
  const handleOf = (value: Record<string, unknown>) => (value.hits as { handle: string }[])[0]!.handle

  beforeEach(async () => {
    h = await startRuntime(undefined, { mode })
    ticketId = create('knowledge-tools')
    port = {
      query: vi.fn(async () => reply),
      read: vi.fn(async request => ({ version: hit.version, contentHash, offset: request.offset,
        totalChars: text.length, text: text.slice(request.offset, request.offset + request.length) })),
    }
    detach = attachKnowledgeDevice(h.ctx, { id: deviceId, label: 'Personal handset', domains: ['files'], route: 'direct' }, port)
    grant()
    await h.runtime.idle()
  })
  afterEach(async () => { await h.stop() })

  it('查询仅返回授权来源，原文读取复用原句柄与证据链，不保存查询正文', async () => {
    const before = snapshot()
    const result = await query({ text: 'delivery', limit: 1 })
    expect(result).toMatchObject({ hits: [{ ...hit, deviceId, handle: expect.any(String) }], truncated: false })
    expect(JSON.stringify(result)).not.toContain(text)
    expect(snapshot()).toEqual(before)
    expect(port.query).toHaveBeenCalledWith({ domain: 'files', text: 'delivery', limit: 1, includeRestricted: false },
      expect.any(AbortSignal))
    expect(port.read).not.toHaveBeenCalled()
    const evidence = await read(handleOf(result))
    expect(evidence).toMatchObject({ kind: 'device_snapshot', text, source: { deviceId, sourceId: hit.sourceId, version: hit.version },
      ref: expect.stringMatching(/^evidence:/) })
    const repeated = await read(handleOf(result))
    expect(repeated.ref).toBe(evidence.ref)
    expect(snapshot()!.evidence!.documents).toHaveLength(1)
    expect(snapshot()!.evidence!.receipts).toHaveLength(1)
  })

  it('注册设备不授予查询权，缺失范围和模型提供的权限字段在调用设备前被拒绝', async () => {
    for (const invalid of [
      {}, { node_id: nodeId, grantId }, { ticket_id: ticketId, grantId },
      { ticket_id: ticketId, node_id: nodeId }, { ...request(), limit: 9 },
      { ...request(), devices: [deviceId] }, { ...request(), domain: 'wechat' },
      { ...request(), includeRestricted: true }, { ...request(), actor: { role: 'controller' } },
    ]) {
      await expect(h.runTool(h.runtime.masterId, 'knowledge_query', invalid)).rejects.toThrow()
    }
    await expect(query({ node_id: 'independent' })).rejects.toMatchObject({ code: 'device_access_denied' })
    const otherId = create('ungranted')
    await expect(query({ ticket_id: otherId })).rejects.toMatchObject({ code: 'device_access_denied' })
    expect(port.query).not.toHaveBeenCalled()
  })

  it('越域和受限元数据不会出现在调用方结果中，也不会触发原文读取', async () => {
    port.query = vi.fn(async () => ({ hits: [hit, { ...hit, domain: 'wechat', title: 'Hidden message' },
      { ...hit, sensitivity: 'restricted', title: 'Hidden private file' }], truncated: false }))
    const result = await query()
    expect(result).toMatchObject({ hits: [{ title: hit.title }], truncated: true })
    expect(result.hits).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('Hidden')
    expect(port.read).not.toHaveBeenCalled()
  })

  it('来源编号、内容哈希和查询句柄均不能替代实际读取回执', async () => {
    const started = h.runtime.hmm.apply(controller, ticketId, view().revision, { action: 'start', nodeId })
    const handle = handleOf(await query())
    for (const ref of [hit.sourceId, hit.contentHash, handle]) {
      expect(() => h.runtime.hmm.apply(controller, ticketId, view().revision, {
        action: 'complete', nodeId, lease: started.lease!, summary: 'Metadata is not source evidence', evidenceRefs: [ref],
      })).toThrow()
    }
    expect(view().nodes.find(node => node.id === nodeId)?.state).toBe('running')
    expect(snapshot()!.evidence?.documents ?? []).toEqual([])
    expect(port.read).not.toHaveBeenCalled()
  })

  it('查询句柄不能在其他节点或工单复用，即使两者各有授权', async () => {
    const otherId = create('other-scope')
    grant(otherId)
    const handle = handleOf(await query())
    await expect(read(handle, { ticket_id: otherId })).rejects.toMatchObject({ code: 'device_handle_stale' })
    await expect(read(handle, { node_id: 'independent' })).rejects.toMatchObject({ code: 'device_handle_stale' })
    expect(port.read).not.toHaveBeenCalled()
    expect(await read(handle)).toMatchObject({ text })
  })

  it('撤权使旧句柄和新查询共同失效，离线不会伪装成空结果', async () => {
    const handle = handleOf(await query())
    h.runtime.hmm.revokeDevice(controller, ticketId, view().revision, grantId)
    await expect(query()).rejects.toMatchObject({ code: 'device_access_denied' })
    await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
    expect(port.read).not.toHaveBeenCalled()
    grant()
    detach()
    await expect(query()).rejects.toMatchObject({ code: 'device_offline' })
  })

  it('查询中撤权立即取消请求，迟到结果不签发句柄或写入快照', async () => {
    const waiting = Promise.withResolvers<unknown>()
    port.query = vi.fn((_request, _signal) => waiting.promise)
    const pending = query()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'device_access_denied' })
    await vi.waitFor(() => expect(port.query).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(port.query).mock.calls[0]![1]
    h.runtime.hmm.revokeDevice(controller, ticketId, view().revision, grantId)
    await rejected
    expect(signal.aborted).toBe(true)
    waiting.resolve(reply)
    await h.runtime.idle()
    expect(h.runtime.hmmDevices.status()).toMatchObject({ handles: 0, active: 0 })
    expect(snapshot()!.evidence?.documents ?? []).toEqual([])
  })

  it('调用者取消透传到设备，不创建另一套请求队列或保留迟到句柄', async () => {
    const waiting = Promise.withResolvers<unknown>()
    port.query = vi.fn((_request, _signal) => waiting.promise)
    const caller = new AbortController()
    const pending = h.tools.get(h.runtime.masterId)!.get('knowledge_query')!.execute(request(), { signal: caller.signal })
    const cancelled = new Error('caller cancelled')
    const rejected = expect(pending).rejects.toBe(cancelled)
    await vi.waitFor(() => expect(port.query).toHaveBeenCalledTimes(1))
    caller.abort(cancelled)
    await rejected
    expect(vi.mocked(port.query).mock.calls[0]![1].aborted).toBe(true)
    waiting.resolve(reply)
    await h.runtime.idle()
    expect(h.runtime.hmmDevices.status()).toMatchObject({ handles: 0, active: 0 })
  })

  if (mode === 'repository') it('仓库执行器固定当前工单，查询与读取保持调用者身份一致', async () => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot Inspect the assigned source'))
    h.runtime.hmm.create(controller, ticket.id, plan)
    grant(ticket.id)
    const result = await h.runTool(sessionId, 'knowledge_query', { node_id: nodeId, grantId })
    const handle = handleOf(result)
    await expect(h.runTool(sessionId, 'knowledge_query', request())).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(read(handle, { ticket_id: ticket.id })).rejects.toMatchObject({ code: 'device_handle_stale' })
    expect(port.read).not.toHaveBeenCalled()
    const evidence = await h.runTool(sessionId, 'hmm_evidence',
      { node_id: nodeId, request: { action: 'device_read', handle } })
    expect(evidence).toMatchObject({ text, source: { deviceId } })
  })
})
