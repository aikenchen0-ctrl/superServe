import { createHash, randomUUID } from 'node:crypto'
import { HmmError, type HmmActor } from './model.ts'
import type { HmmWorkflows } from './workflow.ts'
import { DEVICE_LIMITS, DeviceChunkSchema, DeviceDescriptorSchema, DeviceQuerySchema, DeviceReadSchema,
  DeviceReplySchema, type DeviceDescriptor, type DeviceHit, type DevicePort } from './device-contracts.ts'

interface Connection { descriptor: DeviceDescriptor; port: DevicePort; closed: AbortController }
interface Handle {
  owner: string; ticketId: string; nodeId: string; grantId: string; generation: string; fence: string
  connection: Connection; hit: DeviceHit; expires: number
}
interface Operation { connection: Connection; controller: AbortController; check(): void }
const deny = (code: string, message: string): never => { throw new HmmError(code, message, 409) }

/** 可信宿主绑定的设备访问端口；只缓存有界查询句柄，原始知识库仍由设备持有。 */
export class HmmDevices {
  private readonly connections = new Map<string, Connection>()
  private readonly handles = new Map<string, Handle>()
  private readonly active = new Set<Operation>()
  constructor(private readonly hmm: HmmWorkflows, private readonly lifetime: AbortSignal,
    private readonly now: () => number = () => Date.now()) {}

  /** 路由类型是宿主承诺，不是地域证明；香港通道适配器必须自行实施指定路径。 */
  attach(input: DeviceDescriptor, port: DevicePort): () => void {
    this.lifetime.throwIfAborted()
    const descriptor = DeviceDescriptorSchema.parse(input)
    if (descriptor.domains.includes('wechat') && descriptor.route !== 'designated-hk')
      deny('wechat_route_required', '微信数据须由宿主配置指定香港通道，普通直连不可注册')
    if (this.connections.has(descriptor.id)) deny('device_connected', '此设备已有连接，请先断开旧连接')
    if (this.connections.size >= DEVICE_LIMITS.devices) deny('device_limit', '已连接设备数达到上限')
    const connection: Connection = { descriptor, port, closed: new AbortController() }
    this.connections.set(descriptor.id, connection)
    return () => {
      if (this.connections.get(descriptor.id) !== connection) return
      this.connections.delete(descriptor.id)
      connection.closed.abort(new HmmError('device_offline', '设备连接已断开', 409))
      this.sweep()
    }
  }
  status() {
    this.sweep()
    return { devices: [...this.connections.values()].map(({ descriptor }) => ({ ...descriptor, connected: true })),
      active: this.active.size, handles: this.handles.size }
  }
  /** 在工作流事务提交后调用，让撤权或停止立即取消尚未结束的设备请求。 */
  reconcile(): void {
    for (const operation of this.active) {
      try { operation.check() }
      catch (error) { operation.controller.abort(error) }
    }
    this.sweep(true)
  }
  private sweep(verify = false): void {
    const checked = new Map<string, string | null>()
    for (const [id, handle] of this.handles) {
      if (handle.expires <= this.now() || handle.connection.closed.signal.aborted) this.handles.delete(id)
      else if (verify) {
        // 同一事务通知中的同一授权只读一次，避免每个句柄都反序列化整份任务快照。
        const key = JSON.stringify([handle.owner, handle.ticketId, handle.nodeId, handle.grantId])
        if (!checked.has(key)) {
          try {
            const current = this.hmm.deviceAccess(JSON.parse(handle.owner) as HmmActor, handle.ticketId, handle.nodeId, handle.grantId)
            checked.set(key, JSON.stringify([current.fence, current.grant.generation]))
          } catch { checked.set(key, null) }
        }
        if (checked.get(key) !== JSON.stringify([handle.fence, handle.generation])) this.handles.delete(id)
      }
    }
  }
  private access(actor: HmmActor, ticketId: string, nodeId: string, grantId: string) {
    this.lifetime.throwIfAborted()
    const access = this.hmm.deviceAccess(actor, ticketId, nodeId, grantId)
    const connection = this.connections.get(access.grant.deviceId)
    if (!connection) return deny('device_offline', '授权设备当前未连接，请等待设备上线')
    if (!connection.descriptor.domains.includes(access.grant.domain))
      return deny('device_capability_missing', '设备连接未提供授权的数据域')
    if (access.grant.domain === 'wechat' && connection.descriptor.route !== 'designated-hk')
      return deny('wechat_route_required', '微信指定香港通道尚未配置')
    const check = () => {
      this.lifetime.throwIfAborted()
      const current = this.hmm.deviceAccess(actor, ticketId, nodeId, grantId)
      if (this.connections.get(connection.descriptor.id) !== connection) deny('device_offline', '设备连接已更换或断开')
      if (current.grant.generation !== access.grant.generation || current.fence !== access.fence)
        deny('device_access_stale', '设备读取期间节点或授权已变化')
    }
    return { ...access, connection, check }
  }
  private async call(connection: Connection, check: () => void, caller: AbortSignal,
    work: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    caller.throwIfAborted(); check()
    if (this.active.size >= DEVICE_LIMITS.active
      || [...this.active].filter(item => item.connection.descriptor.id === connection.descriptor.id).length >= DEVICE_LIMITS.perDevice)
      return deny('device_busy', '设备请求达到并发上限，请稍后重试')
    const controller = new AbortController(), operation = { connection, check, controller }
    const signal = AbortSignal.any([caller, controller.signal, this.lifetime, connection.closed.signal])
    const timer = setTimeout(() => controller.abort(new HmmError('device_timeout', '设备请求超时，请稍后重新查询', 409)),
      DEVICE_LIMITS.timeoutMs)
    this.active.add(operation)
    // 即使适配器忽略取消，未结束调用仍占用槽位，避免超时重试无限积累后台任务。
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal) })
    void pending.then(() => this.active.delete(operation), () => this.active.delete(operation))
    let abort: (() => void) | undefined
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      const value = await Promise.race([pending, cancelled])
      signal.throwIfAborted(); check()
      if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > DEVICE_LIMITS.responseBytes)
        deny('device_response_large', '设备响应超过接入预算')
      return value
    } finally {
      clearTimeout(timer)
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
  async query(actor: HmmActor, ticketId: string, nodeId: string, input: unknown, signal: AbortSignal) {
    const request = DeviceQuerySchema.parse(input)
    this.sweep()
    const { grant, fence, connection, check } = this.access(actor, ticketId, nodeId, request.grantId)
    if (this.handles.size + request.limit > DEVICE_LIMITS.handles)
      deny('device_handle_limit', '查询句柄达到上限，请等待旧句柄过期或减少查询数量')
    const reply = DeviceReplySchema.parse(await this.call(connection, check, signal, s => connection.port.query({
      domain: grant.domain, text: request.text, limit: request.limit, includeRestricted: grant.includeRestricted,
    }, s)))
    signal.throwIfAborted(); check()
    const hits = reply.hits.filter(hit => hit.domain === grant.domain
      && (grant.includeRestricted || hit.sensitivity !== 'restricted')).slice(0, request.limit)
    if (this.handles.size + hits.length > DEVICE_LIMITS.handles) deny('device_handle_limit', '查询句柄达到上限，请等待旧句柄过期')
    const expires = this.now() + DEVICE_LIMITS.handleTtlMs
    return { hits: hits.map(hit => {
      const handle = randomUUID()
      this.handles.set(handle, { owner: JSON.stringify(actor), ticketId, nodeId, grantId: grant.id,
        generation: grant.generation, fence, connection, hit, expires })
      return { handle, ...hit, deviceId: grant.deviceId, expiresAt: new Date(expires).toISOString() }
    }), truncated: reply.truncated || reply.hits.length > hits.length }
  }
  async read(actor: HmmActor, ticketId: string, nodeId: string, input: unknown, signal: AbortSignal) {
    const request = DeviceReadSchema.parse(input)
    this.sweep()
    const handle = this.handles.get(request.handle)
    if (!handle || handle.owner !== JSON.stringify(actor) || handle.ticketId !== ticketId || handle.nodeId !== nodeId)
      return deny('device_handle_stale', '查询句柄无效、已过期或不属于当前节点，请重新查询')
    const { connection, check, fence, grant } = this.access(actor, ticketId, nodeId, handle.grantId)
    if (connection !== handle.connection || fence !== handle.fence || grant.generation !== handle.generation)
      return deny('device_handle_stale', '查询期间设备或节点已变化，请重新查询')
    const hit = handle.hit
    if (request.offset >= hit.totalChars) return deny('device_range_invalid', '读取起点超出来源范围')
    const chunk = DeviceChunkSchema.parse(await this.call(connection, check, signal, s => connection.port.read({
      sourceId: hit.sourceId, version: hit.version, contentHash: hit.contentHash, offset: request.offset, length: request.length,
    }, s)))
    signal.throwIfAborted(); check()
    if (chunk.version !== hit.version || chunk.contentHash !== hit.contentHash || chunk.totalChars !== hit.totalChars)
      return deny('device_version_stale', '来源版本已改变，请重新查询后读取')
    if (chunk.offset !== request.offset || chunk.text.length !== Math.min(request.length, hit.totalChars - request.offset))
      return deny('device_range_invalid', '设备返回片段与请求范围不一致')
    if (chunk.offset === 0 && chunk.text.length === hit.totalChars
      && createHash('sha256').update(chunk.text, 'utf8').digest('hex') !== hit.contentHash)
      return deny('device_hash_invalid', '设备全文与声明的内容哈希不一致')
    return this.hmm.captureDevice(actor, ticketId, nodeId, fence, { ...hit, deviceId: grant.deviceId,
      grantId: grant.id, grantGeneration: grant.generation, route: connection.descriptor.route,
      offset: chunk.offset, end: chunk.offset + chunk.text.length }, chunk.text)
  }
}
