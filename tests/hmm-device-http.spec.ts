import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { HttpDevicePort } from '../src/hmm/device-http.ts'

const content = 'A bounded device result.'
const hit = { sourceId: 'file:1', version: 'v1',
  contentHash: createHash('sha256').update(content).digest('hex'), title: 'File',
  domain: 'files' as const, observedAt: '2026-11-04T00:00:00.000Z', totalChars: content.length, sensitivity: 'personal' as const }
const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const signal = () => new AbortController().signal
const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地测试服务未绑定 TCP 端口')
  return address.port
}
const close = async (server: ReturnType<typeof createServer>): Promise<void> => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

it('通过 HTTPS 固定端点发送有界查询和读取请求', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ hits: [hit], truncated: false }))
    .mockResolvedValueOnce(response({ version: hit.version, contentHash: hit.contentHash, offset: 0, totalChars: content.length, text: content }))
  const port = new HttpDevicePort({ baseUrl: 'https://phone.example/bridge', token: 't'.repeat(16), fetcher })
  await expect(port.query({ domain: 'files', limit: 1, includeRestricted: false }, signal())).resolves.toEqual({ hits: [hit], truncated: false })
  await expect(port.read({ sourceId: hit.sourceId, version: hit.version, contentHash: hit.contentHash, offset: 0, length: content.length }, signal())).resolves.toMatchObject({ text: content })
  expect(fetcher).toHaveBeenNthCalledWith(1, new URL('https://phone.example/bridge/v1/knowledge/query'), expect.objectContaining({
    method: 'POST', redirect: 'error', cache: 'no-store', body: JSON.stringify({ domain: 'files', limit: 1, includeRestricted: false }),
  }))
  expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
    authorization: `Bearer ${'t'.repeat(16)}`, 'x-superserve-device-protocol': '1',
  })
})

it('拒绝非回环 HTTP、地址凭据和不安全路径', () => {
  expect(() => new HttpDevicePort({ baseUrl: 'http://phone.example', token: 't'.repeat(16) })).toThrow('HTTPS')
  expect(() => new HttpDevicePort({ baseUrl: 'https://u:p@phone.example', token: 't'.repeat(16) })).toThrow('用户名')
  expect(() => new HttpDevicePort({ baseUrl: 'https://phone.example', token: 't'.repeat(16), queryPath: '/v1/../query' })).toThrow('路径')
  expect(() => new HttpDevicePort({ baseUrl: 'https://phone.example', token: 't'.repeat(16), queryPath: '/v1/%2e%2e/query' })).toThrow('路径')
  expect(() => new HttpDevicePort({ baseUrl: 'https://phone.example?token=secret', token: 't'.repeat(16) })).toThrow('查询参数')
  expect(() => new HttpDevicePort({ baseUrl: 'http://127.0.0.1', token: 't'.repeat(16), allowInsecureLocalhost: true })).not.toThrow()
})

it('限制响应体、隐藏设备错误正文且保留调用者取消', async () => {
  const oversized = vi.fn<typeof fetch>().mockResolvedValue(response({ value: 'x'.repeat(2048) }))
  const port = new HttpDevicePort({ baseUrl: 'https://phone.example', token: 't'.repeat(16), maxResponseBytes: 1024, fetcher: oversized })
  await expect(port.query({ domain: 'files', limit: 1, includeRestricted: false }, signal())).rejects.toMatchObject({ code: 'device_response_too_large' })
  const failed = vi.fn<typeof fetch>().mockResolvedValue(response({ secret: 'do-not-leak' }, 401))
  const authPort = new HttpDevicePort({ baseUrl: 'https://phone.example', token: 't'.repeat(16), fetcher: failed })
  await expect(authPort.query({ domain: 'files', limit: 1, includeRestricted: false }, signal())).rejects.toMatchObject({ code: 'device_auth_failed' })
  await expect(authPort.query({ domain: 'files', limit: 1, includeRestricted: false }, signal())).rejects.not.toThrow('do-not-leak')
  const controller = new AbortController(), pending = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('transport aborted')
  })
  const pendingPort = new HttpDevicePort({ baseUrl: 'https://phone.example', token: 't'.repeat(16), fetcher: pending })
  const request = pendingPort.query({ domain: 'files', limit: 1, includeRestricted: false }, controller.signal)
  controller.abort(new Error('caller cancelled'))
  await expect(request).rejects.toThrow('caller cancelled')
})

it('对无长度声明的分块超限响应及时取消读取', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(2048))
    },
    cancel() {
      cancelled = true
    },
  })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
  const port = new HttpDevicePort({
    baseUrl: 'https://phone.example',
    token: 't'.repeat(16),
    maxResponseBytes: 1024,
    fetcher,
  })
  await expect(port.query({ domain: 'files', limit: 1, includeRestricted: false }, signal()))
    .rejects.toMatchObject({ code: 'device_response_too_large' })
  expect(cancelled).toBe(true)
})

it('响应读取期间取消时保留调用方原因并取消底层流', async () => {
  const controller = new AbortController()
  let notifyPull: () => void = () => {}
  let pulled: Promise<void> = new Promise(resolve => { notifyPull = resolve })
  let sentPrefix = false
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(streamController) {
      if (!sentPrefix) {
        sentPrefix = true
        streamController.enqueue(new TextEncoder().encode('{"hits":['))
        return
      }
      notifyPull()
    },
    cancel() {
      cancelled = true
    },
  })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
  const port = new HttpDevicePort({ baseUrl: 'https://phone.example', token: 't'.repeat(16), fetcher })
  const request = port.query({ domain: 'files', limit: 1, includeRestricted: false }, controller.signal)
  await pulled
  const reason = new Error('caller cancelled during body read')
  controller.abort(reason)
  await expect(request).rejects.toBe(reason)
  expect(cancelled).toBe(true)
})

it('通过真实回环 HTTP 服务完成查询和读取并携带协议凭据', async () => {
  const received: Array<{ path: string | undefined, authorization: string | undefined, protocol: string | undefined, body: string }> = []
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      received.push({
        path: request.url,
        authorization: request.headers.authorization,
        protocol: Array.isArray(request.headers['x-superserve-device-protocol'])
          ? request.headers['x-superserve-device-protocol'].join(',')
          : request.headers['x-superserve-device-protocol'],
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const payload = Buffer.from(request.url?.endsWith('/query')
        ? JSON.stringify({ hits: [hit], truncated: false })
        : JSON.stringify({
          version: hit.version,
          contentHash: hit.contentHash,
          offset: 0,
          totalChars: '知识内容'.length,
          text: '知识内容',
        }))
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.write(payload.subarray(0, 3))
      setTimeout(() => reply.end(payload.subarray(3)), 1)
    })
  })
  const portNumber = await listen(server)
  try {
    const port = new HttpDevicePort({
      baseUrl: `http://127.0.0.1:${portNumber}/bridge`,
      token: 't'.repeat(16),
      allowInsecureLocalhost: true,
    })
    const request = { domain: 'files' as const, limit: 1, includeRestricted: false }
    await expect(port.query(request, signal())).resolves.toEqual({ hits: [hit], truncated: false })
    await expect(port.read({
      sourceId: hit.sourceId,
      version: hit.version,
      contentHash: hit.contentHash,
      offset: 0,
      length: '知识内容'.length,
    }, signal())).resolves.toMatchObject({ text: '知识内容' })
    expect(received).toEqual([
      {
        path: '/bridge/v1/knowledge/query',
        authorization: `Bearer ${'t'.repeat(16)}`,
        protocol: '1',
        body: JSON.stringify(request),
      },
      {
        path: '/bridge/v1/knowledge/read',
        authorization: `Bearer ${'t'.repeat(16)}`,
        protocol: '1',
        body: JSON.stringify({
          sourceId: hit.sourceId,
          version: hit.version,
          contentHash: hit.contentHash,
          offset: 0,
          length: '知识内容'.length,
        }),
      },
    ])
  } finally {
    await close(server)
  }
})

it('真实 HTTP 重定向失败且不向目标主机转发设备凭据', async () => {
  let leakedRequests = 0
  const destination = createServer((_request, reply) => {
    leakedRequests++
    reply.end('{}')
  })
  const destinationPort = await listen(destination)
  const source = createServer((_request, reply) => {
    reply.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/collect` })
    reply.end()
  })
  const sourcePort = await listen(source)
  try {
    const port = new HttpDevicePort({
      baseUrl: `http://127.0.0.1:${sourcePort}`,
      token: 't'.repeat(16),
      allowInsecureLocalhost: true,
    })
    await expect(port.query({ domain: 'files', limit: 1, includeRestricted: false }, signal()))
      .rejects.toMatchObject({ code: 'device_unavailable' })
    expect(leakedRequests).toBe(0)
  } finally {
    await Promise.all([close(source), close(destination)])
  }
})
