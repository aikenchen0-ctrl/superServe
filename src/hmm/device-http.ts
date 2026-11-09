import { HmmError } from './model.ts'
import { DEVICE_LIMITS, DeviceChunkSchema, DeviceReplySchema, type DevicePort } from './device-contracts.ts'

export interface HttpDevicePortOptions {
  baseUrl: string
  token: string
  /** 仅允许开发环境回环 HTTP；真实设备连接必须使用 HTTPS。 */
  allowInsecureLocalhost?: boolean
  queryPath?: string
  readPath?: string
  maxResponseBytes?: number
  fetcher?: typeof fetch
}

const protocolVersion = '1'
const pathPart = (value: string, name: string): string => {
  const path = value.trim()
  if (!/^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/.test(path)
    || path.split('/').some(part => part === '.' || part === '..'))
    throw new Error(`${name} 必须由普通路径段组成，不能包含转义、跳转或查询参数`)
  return path
}

function endpoint(baseUrl: string, path: string, allowInsecureLocalhost: boolean): URL {
  const url = new URL(baseUrl)
  const localhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash)
    throw new Error('设备地址不能包含用户名、密码、查询参数或片段')
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && url.protocol === 'http:' && localhost))
    throw new Error('设备连接必须使用 HTTPS；仅允许回环开发地址使用 HTTP')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  const resolved = new URL(path.slice(1), url)
  if (resolved.origin !== url.origin || !resolved.pathname.startsWith(url.pathname))
    throw new Error('设备路径不能离开配置的地址')
  return resolved
}

/** 通过固定 HTTPS 协议访问设备知识端口；不负责设备发现、授权发放或自动重试。 */
export class HttpDevicePort implements DevicePort {
  private readonly queryUrl: URL
  private readonly readUrl: URL
  private readonly fetcher: typeof fetch
  private readonly maxResponseBytes: number
  constructor(private readonly options: HttpDevicePortOptions) {
    if (!/^\S{16,4096}$/.test(options.token)) throw new Error('设备凭据长度不符合要求')
    const allowInsecureLocalhost = options.allowInsecureLocalhost === true
    this.queryUrl = endpoint(options.baseUrl, pathPart(options.queryPath ?? '/v1/knowledge/query', '查询路径'), allowInsecureLocalhost)
    this.readUrl = endpoint(options.baseUrl, pathPart(options.readPath ?? '/v1/knowledge/read', '读取路径'), allowInsecureLocalhost)
    this.fetcher = options.fetcher ?? fetch
    this.maxResponseBytes = options.maxResponseBytes ?? DEVICE_LIMITS.responseBytes
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > DEVICE_LIMITS.responseBytes)
      throw new Error('设备响应上限超出允许范围')
  }

  async query(request: Parameters<DevicePort['query']>[0], signal: AbortSignal): Promise<unknown> {
    return this.post(this.queryUrl, request, signal, value => DeviceReplySchema.parse(value))
  }

  async read(request: Parameters<DevicePort['read']>[0], signal: AbortSignal): Promise<unknown> {
    return this.post(this.readUrl, request, signal, value => DeviceChunkSchema.parse(value))
  }

  private async post<T>(url: URL, body: unknown, signal: AbortSignal, parse: (value: unknown) => T): Promise<T> {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          'x-superserve-device-protocol': protocolVersion,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        signal,
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new HmmError('device_unavailable', '设备连接不可用，请稍后重试', 409)
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let completed = false
    let cancellation: Promise<void> | undefined
    // 取消回调与 finally 必须等待同一次清理，防止重复取消提前释放宿主的在途槽位。
    const cancel = () => cancellation ??= (async () => {
      try {
        if (reader) await reader.cancel()
        else await response.body?.cancel()
      } catch {
        // 清理失败不能覆盖原始错误；调用方取消由宿主独立返回。
      }
    })()
    try {
      signal.throwIfAborted()
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'device_auth_failed'
          : response.status === 429 ? 'device_busy' : 'device_unavailable'
        throw new HmmError(code, code === 'device_auth_failed' ? '设备凭据无效或已过期' : '设备暂不可用，请稍后重试', 409)
      }
      const declared = response.headers.get('content-length')
      if (declared && Number(declared) > this.maxResponseBytes)
        throw new HmmError('device_response_too_large', '设备响应超过传输上限', 409)
      if (!response.body)
        throw new HmmError('device_protocol_invalid', '设备响应缺少 JSON 内容', 409)
      reader = response.body.getReader()
      signal.addEventListener('abort', cancel, { once: true })
      signal.throwIfAborted()
      // 只保留限额内的字节；网络层缓冲和当前收到的分块不计入此应用缓冲区。
      const bytes = new Uint8Array(this.maxResponseBytes)
      let length = 0
      for (;;) {
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) {
          completed = true
          break
        }
        if (chunk.value.byteLength > this.maxResponseBytes - length)
          throw new HmmError('device_response_too_large', '设备响应超过传输上限', 409)
        bytes.set(chunk.value, length)
        length += chunk.value.byteLength
      }
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
      } catch {
        throw new HmmError('device_protocol_invalid', '设备响应不是有效 UTF-8 JSON', 409)
      }
      try {
        return parse(value)
      } catch {
        throw new HmmError('device_protocol_invalid', '设备响应不符合知识端口协议', 409)
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof HmmError) throw error
      throw new HmmError('device_unavailable', '设备响应读取失败，请稍后重试', 409)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (!completed) await cancel()
      reader?.releaseLock()
    }
  }
}