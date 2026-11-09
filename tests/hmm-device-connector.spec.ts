import type { Fiber } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as DeviceHttp from '../src/connectors/device-http.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const controller = { role: 'controller' as const }
const deviceId = 'handset-silver'
const nodeId = 'inspect_record'
const grantId = 'source-files'
const tokenEnv = 'SUPERSERVE_TEST_DEVICE_TOKEN'
const token = 'synthetic-device-credential-32-bytes'
const text = 'The permitted record names a delivery date of November 12.'
const hit = { sourceId: 'records/delivery-18', version: 'revision-4',
  contentHash: createHash('sha256').update(text).digest('hex'), title: 'Delivery record',
  domain: 'files' as const, observedAt: '2026-11-04T00:00:00.000Z', totalChars: text.length, sensitivity: 'personal' as const }
const plan = { goal: 'Check the permitted delivery record', nodes: [
  { id: 'checks', title: 'Checks', mode: 'parallel' as const },
  { id: nodeId, parentId: 'checks', title: 'Inspect record', instruction: 'Read the source', evidenceRequired: true },
  { id: 'constraint_check', parentId: 'checks', title: 'Check constraints', instruction: 'Check the constraints' },
] }

describe('宿主 HTTP 设备连接器', () => {
  let h: Host, ticketId: string, baseUrl: string
  let server: ReturnType<typeof createServer>
  let stall: 'query' | 'read' | undefined
  let closed: number
  const forks: Fiber[] = []
  const received: Array<{ path: string; body: Record<string, unknown>; authorization?: string; protocol?: string | string[] }> = []
  const view = () => h.runtime.hmm.view(controller, ticketId)
  const snapshot = () => h.runtime.store.get(KV.hmm.workflow(ticketId))!
  const config = (): DeviceHttp.DeviceHttpConfig => ({
    id: deviceId, label: 'Personal handset', domains: ['files'], baseUrl, tokenEnv, allowInsecureLocalhost: true,
  })
  const load = (input: DeviceHttp.DeviceHttpConfig = config()) => {
    const fork = h.ctx.plugin(DeviceHttp, input)
    forks.push(fork)
    return fork
  }
  const grant = () => h.runtime.hmm.grantDevice(controller, ticketId, view().revision,
    { id: grantId, nodeId, deviceId, domain: 'files' })
  const query = () => h.runTool(h.runtime.masterId, 'knowledge_query',
    { ticket_id: ticketId, node_id: nodeId, grantId, text: 'delivery', limit: 1 })
  const handleOf = (result: Record<string, unknown>) => (result.hits as { handle: string }[])[0]!.handle
  const read = (handle: string) => h.runTool(h.runtime.masterId, 'hmm_evidence',
    { ticket_id: ticketId, node_id: nodeId, request: { action: 'device_read', handle } })

  beforeEach(async () => {
    received.length = 0
    closed = 0
    stall = undefined
    vi.stubEnv(tokenEnv, token)
    h = await startRuntime(undefined, { mode: 'hmm' })
    const ticket = h.runtime.engine.createLocalTask({ requestId: 'connector-record', title: 'Source check', goal: plan.goal })
    ticketId = ticket.id
    h.runtime.hmm.create(controller, ticketId, plan)
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        received.push({ path: request.url!, body, authorization: request.headers.authorization,
          protocol: request.headers['x-superserve-device-protocol'] })
        if (request.url?.endsWith(`/${stall}`)) {
          // 已收请求并发送部分正文，验证取消覆盖等待响应体的阶段。
          response.on('close', () => { closed++ })
          response.writeHead(200, { 'content-type': 'application/json' })
          response.write('{')
          return
        }
        const offset = body.offset as number, length = body.length as number
        const value = request.url?.endsWith('/query') ? { hits: [hit], truncated: false }
          : { version: hit.version, contentHash: hit.contentHash, offset, totalChars: text.length,
            text: text.slice(offset, offset + length) }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('本地测试桥接服务未绑定端口')
    baseUrl = `http://127.0.0.1:${address.port}/bridge`
  })

  afterEach(async () => {
    try {
      for (const fork of forks.splice(0)) await fork.dispose()
    } finally {
      try { await h?.stop() }
      finally {
        server?.closeAllConnections()
        if (server?.listening) await new Promise<void>((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve()))
        vi.unstubAllEnvs()
      }
    }
  })

  it('注册不发网络请求或授予读取权，授权后的查询与取证沿用真实工具和存储', async () => {
    await load()
    expect(h.runtime.hmmDevices.status()).toMatchObject({ devices: [{ id: deviceId, route: 'direct' }], handles: 0, active: 0 })
    expect(received).toEqual([])
    await expect(query()).rejects.toMatchObject({ code: 'device_access_denied' })
    expect(received).toEqual([])
    grant()
    const before = snapshot()
    const result = await query()
    expect(result).toMatchObject({ hits: [{ ...hit, deviceId, handle: expect.any(String) }] })
    expect(snapshot()).toEqual(before)
    expect(JSON.stringify(result)).not.toContain(text)
    const evidence = await read(handleOf(result))
    expect(evidence).toMatchObject({ kind: 'device_snapshot', text, source: { deviceId, sourceId: hit.sourceId },
      ref: expect.stringMatching(/^evidence:/) })
    expect((await read(handleOf(result))).ref).toBe(evidence.ref)
    expect(snapshot().evidence!.documents).toHaveLength(1)
    expect(snapshot().evidence!.receipts).toHaveLength(1)
    expect(received.map(item => item.path)).toEqual([
      '/bridge/v1/knowledge/query', '/bridge/v1/knowledge/read', '/bridge/v1/knowledge/read',
    ])
    expect(received[0]!.body).toEqual({ domain: 'files', text: 'delivery', limit: 1, includeRestricted: false })
    expect(received.every(item => item.authorization === `Bearer ${token}` && item.protocol === '1')).toBe(true)
    expect(JSON.stringify(snapshot())).not.toContain(token)
  })

  it('公开入口先建计划和授权，再由节点经 HTTP 取证、提交断言、复核及交付，撤权后交付失效', async () => {
    await load()
    const permit = 'record-permission', step = 'verify_delivery'
    const created = await h.api('POST', 'tasks', {
      requestId: 'http-source-lifecycle', goal: 'Verify the permitted delivery date', dispatch: false,
      plan: { maxActive: 1, nodes: [
        { id: 'source_checks', title: 'Source checks', mode: 'serial' },
        { id: step, parentId: 'source_checks', title: 'Verify delivery', instruction: 'Read the permitted record and report its date',
          evidenceRequired: true, claimsRequired: true },
      ] },
    })
    expect(created.status).toBe(200)
    const id = created.body.ticketId as string
    const current = () => h.runtime.hmm.view(controller, id)
    const command = (command: Record<string, unknown>) => h.api('POST', `tickets/${id}/hmm/commands`,
      { revision: current().revision, command })
    await h.runtime.idle()
    expect(h.nodeFactory).not.toHaveBeenCalled()
    expect(current()).toMatchObject({ initialDispatch: false, autoRun: false, deviceGrants: [] })
    expect(await h.api('GET', 'hmm/devices')).toMatchObject({
      status: 200, body: { devices: [{ id: deviceId, connected: true }], active: 0, handles: 0 },
    })
    expect(await h.api('POST', `tickets/${id}/hmm/device-grants`, {
      revision: current().revision, grant: { id: permit, nodeId: step, deviceId, domain: 'files' },
    })).toMatchObject({ status: 200 })
    await h.runtime.idle()
    expect(h.nodeFactory).not.toHaveBeenCalled()
    expect(received).toEqual([])
    expect(await command({ action: 'dispatch' })).toMatchObject({ status: 200 })
    await h.runtime.idle()
    const session = current().nodes.find(node => node.id === step)!.sessionId!
    expect(await h.runTool(session, 'hmm_node_context', {})).toMatchObject({
      deviceGrants: [{ id: permit, deviceId, domain: 'files' }],
    })
    await expect(h.runTool(session, 'hmm_device_query', { grantId: 'not-permitted' }))
      .rejects.toMatchObject({ code: 'device_access_denied' })
    expect(received).toEqual([])
    const result = await h.runTool(session, 'hmm_device_query', { grantId: permit, text: 'delivery', limit: 1 })
    const evidence = await h.runTool(session, 'hmm_device_read', { handle: handleOf(result) })
    expect(evidence).toMatchObject({ kind: 'device_snapshot', text })
    await h.runTool(session, 'hmm_node_report', {
      action: 'complete', summary: 'The record names November 12.', evidenceRefs: [evidence.ref],
      claims: [{ id: 'delivery-date', subject: 'Delivery', predicate: 'scheduled_date', object: 'November 12',
        kind: 'extracted', evidenceRefs: [evidence.ref] }],
    })
    await h.runtime.idle()
    const resultRef = current().nodes.find(node => node.id === step)!.resultRef!
    expect(await h.api('GET', `tasks/${id}`)).toMatchObject({
      status: 200, body: { ended: null, result: null, workflow: { awaitingValidation: true, progress: { completed: 1 } } },
    })
    const validation = { action: 'validate', summary: 'The permitted record was checked.', evidenceRefs: [resultRef] }
    expect(await command(validation)).toMatchObject({ status: 409, body: { code: 'claims_unreviewed' } })
    const graph = await h.api('GET', `tickets/${id}/hmm/claims`)
    expect(graph).toMatchObject({
      status: 200, body: { total: 1, nodes: [{ kind: 'extracted', referenceIntegrity: 'valid', review: null }] },
    })
    const claimRef = (graph.body.nodes as { ref: string }[])[0]!.ref
    expect(await command({ action: 'review_claims',
      reviews: [{ ref: claimRef, verdict: 'accept', reason: 'The claim matches the retrieved record.' }] }))
      .toMatchObject({ status: 200 })
    expect(await command(validation)).toMatchObject({ status: 200 })
    expect(await h.api('GET', `tasks/${id}`)).toMatchObject({
      status: 200, body: { ended: { outcome: 'completed' }, result: { summary: validation.summary, evidenceRefs: [resultRef] },
        resultError: null },
    })
    expect(received.map(item => item.path)).toEqual(['/bridge/v1/knowledge/query', '/bridge/v1/knowledge/read'])
    expect(await h.api('POST', `tickets/${id}/hmm/device-grants/${permit}/revoke`, { revision: current().revision }))
      .toMatchObject({ status: 200 })
    expect(await h.api('GET', `tasks/${id}`)).toMatchObject({
      status: 200, body: { ended: { outcome: 'completed' }, result: null, resultError: 'evidence_invalid' },
    })
    expect(h.runtime.store.get(KV.hmm.workflow(id))!.evidence!.documents[0]!.text).toBeUndefined()
  })

  it('读取后撤权清除当前正文并使证据和旧句柄失效，不能继续验收', async () => {
    await load()
    grant()
    const started = h.runtime.hmm.apply(controller, ticketId, view().revision, { action: 'start', nodeId })
    const handle = handleOf(await query())
    const evidence = await read(handle)
    h.runtime.hmm.apply(controller, ticketId, view().revision,
      { action: 'complete', nodeId, lease: started.lease!, summary: 'Source inspected', evidenceRefs: [evidence.ref as string] })
    const check = h.runtime.hmm.apply(controller, ticketId, view().revision, { action: 'start', nodeId: 'constraint_check' })
    h.runtime.hmm.apply(controller, ticketId, view().revision, {
      action: 'complete', nodeId: 'constraint_check', lease: check.lease!, summary: 'Constraints checked',
      evidenceRefs: [h.runtime.hmm.context(controller, ticketId, 'constraint_check').inputRef],
    })
    const resultRef = h.runtime.hmm.context(controller, ticketId, nodeId).resultRef!
    expect(view().referenceIntegrity).toBe('valid')
    expect(view().nodes.every(node => node.state === 'completed')).toBe(true)
    h.runtime.hmm.revokeDevice(controller, ticketId, view().revision, grantId)
    expect(view().referenceIntegrity).toBe('invalid')
    expect(snapshot().evidence!.documents[0]).toMatchObject({ revoked: true })
    expect(snapshot().evidence!.documents[0]!.text).toBeUndefined()
    await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
    await expect(query()).rejects.toMatchObject({ code: 'node_inactive' })
    expect(() => h.runtime.hmm.apply(controller, ticketId, view().revision,
      { action: 'validate', summary: 'Check completed records', evidenceRefs: [resultRef] }))
      .toThrow(expect.objectContaining({ code: 'evidence_invalid' }))
    expect(received).toHaveLength(2)
  })

  it('在途读取遇到撤权会关闭实际 HTTP 响应，不保存半截正文或回执', async () => {
    await load()
    grant()
    const handle = handleOf(await query())
    stall = 'read'
    const rejected = expect(read(handle)).rejects.toMatchObject({ code: 'device_access_denied' })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    h.runtime.hmm.revokeDevice(controller, ticketId, view().revision, grantId)
    await rejected
    await vi.waitFor(() => {
      expect(closed).toBe(1)
      expect(h.runtime.hmmDevices.status()).toMatchObject({ active: 0, handles: 0 })
    })
    expect(snapshot().evidence?.documents ?? []).toEqual([])
    expect(snapshot().evidence?.receipts ?? []).toEqual([])
  })

  it('插件卸载取消在途请求并清除句柄，重载不复用旧连接的句柄', async () => {
    const fork = await load()
    grant()
    const handle = handleOf(await query())
    stall = 'query'
    const rejected = expect(query()).rejects.toMatchObject({ code: 'device_offline' })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    await fork.dispose()
    await rejected
    await vi.waitFor(() => {
      expect(closed).toBe(1)
      expect(h.runtime.hmmDevices.status()).toEqual({ devices: [], active: 0, handles: 0 })
    })
    await expect(query()).rejects.toMatchObject({ code: 'device_offline' })
    stall = undefined
    await load()
    await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
    expect((await query()).hits).toHaveLength(1)
  })

  it('重启保留计划和授权，但连接和句柄必须重新建立', async () => {
    const fork = await load()
    grant()
    const handle = handleOf(await query())
    const before = snapshot()
    await fork.dispose()
    await h.restart()
    expect(snapshot()).toEqual(before)
    expect(h.runtime.hmmDevices.status()).toEqual({ devices: [], active: 0, handles: 0 })
    await expect(query()).rejects.toMatchObject({ code: 'device_offline' })
    await load()
    await expect(read(handle)).rejects.toMatchObject({ code: 'device_handle_stale' })
    expect(await read(handleOf(await query()))).toMatchObject({ text })
  })

  it('多个插件实例各自持有连接，重复设备启动失败不覆盖或卸载已有连接', async () => {
    const first = await load()
    const second = await load({ ...config(), id: 'handset-green' })
    const duplicate = load()
    await expect(duplicate).rejects.toMatchObject({ code: 'device_connected' })
    await duplicate.dispose()
    expect(h.runtime.hmmDevices.status().devices.map(device => device.id).sort()).toEqual([deviceId, 'handset-green'].sort())
    grant()
    expect((await query()).hits).toHaveLength(1)
    await second.dispose()
    expect(h.runtime.hmmDevices.status().devices.map(device => device.id)).toEqual([deviceId])
    expect((await query()).hits).toHaveLength(1)
    await first.dispose()
    expect(h.runtime.hmmDevices.status().devices).toEqual([])
  })

  it.each([
    ['缺少凭据变量', {}, undefined],
    ['凭据长度不足', {}, 'short-secret'],
    ['凭据包含空白', {}, 'invalid secret credential'],
    ['地址包含凭据', { baseUrl: 'https://user:private-secret@phone.example' }, token],
    ['地址包含查询参数', { baseUrl: 'https://phone.example?token=private-secret' }, token],
    ['非回环 HTTP', { baseUrl: 'http://phone.example' }, token],
    ['未允许回环 HTTP', { allowInsecureLocalhost: false }, token],
    ['直接配置凭据', { token: 'private-secret' }, token],
    ['无效环境变量名称', { tokenEnv: 'private-secret?' }, token],
  ] as const)('%s 时启动失败且不发请求或泄漏凭据', async (_label, overrides, value) => {
    vi.stubEnv(tokenEnv, value)
    const logged = vi.spyOn(h.ctx.logger, 'error').mockImplementation(() => {})
    const fork = load({ ...config(), ...overrides })
    const error = await fork.await().then(() => undefined, error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toMatch(/设备/)
    expect(error!.message).not.toMatch(/private-secret|short-secret|invalid secret/)
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private-secret|short-secret|invalid secret/)
    expect(h.runtime.hmmDevices.status().devices).toEqual([])
    expect(received).toEqual([])
  })

  it('微信端口拒绝默认直连，只接受宿主显式声明的指定香港路径', async () => {
    const direct = load({ ...config(), domains: ['wechat'] })
    await expect(direct).rejects.toMatchObject({ code: 'wechat_route_required' })
    await direct.dispose()
    expect(h.runtime.hmmDevices.status().devices).toEqual([])
    await load({ ...config(), domains: ['wechat'], route: 'designated-hk' })
    expect(h.runtime.hmmDevices.status().devices).toMatchObject([{ id: deviceId, route: 'designated-hk' }])
    expect(received).toEqual([])
    expect(view().deviceGrants).toEqual([])
  })
})
