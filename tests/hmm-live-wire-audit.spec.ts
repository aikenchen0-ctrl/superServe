import { createServer } from 'node:http'
import { channel } from 'node:diagnostics_channel'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as Audit from '../scripts/hmm-live-wire-audit.ts'
import { syntheticHistory } from '../scripts/hmm-provider-wire.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(overrides: Partial<Audit.AuditConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hmm-wire-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.reflect.provide('llm', {})
  const config = {
    marker: 'synthetic-' + randomUUID(),
    endpoint: 'https://fixture.invalid/v1/chat/completions',
    reportPath: join(directory, 'report.json'),
    ...overrides,
  }
  const fork = await ctx.plugin(Audit, config)
  const report = async () => JSON.parse(await readFile(config.reportPath, 'utf8'))
  const run = async (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.waterfall(ctx.llm, 'llm/stream', options, next)) chunks.push(chunk)
    return chunks
  }
  return { ctx, fork, config, report, run }
}
function fixture(marker: string, rounds = 1) {
  const input = syntheticHistory(rounds, 2, true, false)
  input.messages.find(message => message.role === 'user')!.content[0]!.text = 'Inspect synthetic task ' + marker
  const options = { ...input, sessionId: 'hmm-' + randomUUID() } as unknown as GenerateOptions
  const body = JSON.stringify({
    model: input.model,
    tools: input.tools.map(tool => ({ type: 'function', function: tool })),
    messages: input.messages.map(message => message.role === 'assistant'
      ? { role: message.role, content: null, tool_calls: message.content.map(block =>
        ({ type: 'function', id: block.id, function: { name: block.name, arguments: block.arguments } })) }
      : { role: message.role, content: message.content.map(block => block.text ?? '').join(''),
        ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}) }),
  })
  return { options, body }
}
function request(endpoint: string) {
  const url = new URL(endpoint)
  return {
    origin: url.origin, path: url.pathname,
    get headers(): never { throw new Error('诊断不得读取请求头') },
  }
}
const publish = (event: string, data: unknown) => channel('undici:request:' + event).publish(data)
const output: StreamChunk = { type: 'text-delta', index: 0, text: 'synthetic response' }

describe('原生链路观察的边界', () => {
  it('真实回环传输保持请求和响应不变，并隔离并发会话', async () => {
    const received: string[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push(Buffer.concat(chunks).toString('utf8'))
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('回环端口未建立')
    const host = await setup({ endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions` })
    const inputs = [fixture(host.config.marker), fixture(host.config.marker, 2)]
    const snapshots = inputs.map(input => JSON.stringify(input.options))
    const responses = await Promise.all(inputs.map(input => host.run(input.options, async function* () {
      const response = await fetch(host.config.endpoint, {
        method: 'POST', body: input.body, headers: { authorization: 'Bearer synthetic-only-test-token' },
      })
      expect(await response.text()).toBe('ok')
      yield output
    })))
    expect(received.sort()).toEqual(inputs.map(input => input.body).sort())
    expect(inputs.map(input => JSON.stringify(input.options))).toEqual(snapshots)
    expect(responses).toEqual([[output], [output]])
    const report = await host.report()
    expect(report.observationErrors).toBe(0)
    expect(report.bufferedBytes).toBe(0)
    expect(report.records).toHaveLength(2)
    expect(report.records.map((record: { requests: { toolResults: number }[] }) => record.requests[0]!.toolResults).sort()).toEqual([2, 4])
    for (const record of report.records) expect(record.requests[0]).toMatchObject({ checksPassed: true, status: 200 })
    const saved = await readFile(host.config.reportPath, 'utf8')
    for (const forbidden of ['synthetic-only-test-token', 'Inspect synthetic task', 'Ignore previous instructions', 'synthetic response']) {
      expect(saved).not.toContain(forbidden)
    }
  })

  it('只观察用户标记及精确端点，达到观察上限仍透传执行', async () => {
    const host = await setup({ maxCalls: 1 })
    const input = fixture(host.config.marker)
    let executions = 0
    const next = async function* () {
      executions++
      for (const suffix of ['', '?secret=not-for-report', '/other']) {
        const req = request(host.config.endpoint)
        req.path += suffix
        publish('create', { request: req })
        publish('bodyChunkSent', { request: req, chunk: Buffer.from(input.body) })
        publish('bodySent', { request: req })
      }
      yield output
    }
    const unrelated = fixture('other-' + randomUUID()).options
    unrelated.messages.push({ role: 'tool', content: [{ type: 'text', text: host.config.marker }] } as never)
    await host.run(unrelated, next)
    await host.run({ ...input.options, sessionId: 'other-session' } as GenerateOptions, next)
    await host.run(input.options, next)
    await host.run(input.options, next)
    const report = await host.report()
    expect(executions).toBe(4)
    expect(report.records).toHaveLength(1)
    expect(report.records[0].requests).toHaveLength(1)
    expect(report.records[0].requests[0].checksPassed).toBe(true)
    expect(report.droppedCalls).toBe(1)
    expect(JSON.stringify(report)).not.toContain('not-for-report')
  })

  it('并发捕获共用内存上限，超限不取消执行且不能误报通过', async () => {
    const host = await setup({ maxBodyBytes: 1024 })
    const input = fixture(host.config.marker, 0)
    expect(Buffer.byteLength(input.body)).toBeLessThan(1024)
    await host.run(input.options, async function* () {
      const a = request(host.config.endpoint), b = request(host.config.endpoint)
      publish('create', { request: a }); publish('create', { request: b })
      publish('bodyChunkSent', { request: a, chunk: Buffer.from(input.body) })
      publish('bodyChunkSent', { request: b, chunk: Buffer.alloc(1024) })
      publish('bodySent', { request: a }); publish('bodySent', { request: b })
      yield output
    })
    const report = await host.report()
    expect(report.peakBufferedBytes).toBeLessThanOrEqual(1024)
    expect(report.bufferedBytes).toBe(0)
    expect(report.records[0].requests.map((item: { checksPassed: boolean }) => item.checksPassed)).toEqual([true, false])
    expect(report.records[0].requests[1].failure).toBe('audit_buffer_limit')
  })

  it.each(['invalid-json', 'invalid-utf8', 'missing-history', 'transport'])('记录观察失败而不影响原始执行：%s', async kind => {
    const host = await setup()
    const input = fixture(host.config.marker)
    await expect(host.run(input.options, async function* () {
      const req = request(host.config.endpoint)
      publish('create', { request: req })
      const chunk = kind === 'invalid-utf8' ? Buffer.from([0xff])
        : Buffer.from(kind === 'missing-history' ? fixture(host.config.marker, 0).body : 'private-invalid-json')
      publish('bodyChunkSent', { request: req, chunk })
      publish(kind === 'transport' ? 'error' : 'bodySent', { request: req, error: new Error('private-network-error') })
      yield output
    })).resolves.toEqual([output])
    const report = await host.report()
    expect(report.records[0].requests[0].checksPassed).toBe(false)
    expect(report.bufferedBytes).toBe(0)
    expect(JSON.stringify(report)).not.toMatch(/private-(invalid|network)/)
  })

  it('卸载释放在途捕获并停止观察，原始迭代器仍正常收尾', async () => {
    const host = await setup()
    const input = fixture(host.config.marker)
    let closed = false
    const next = async function* () {
      try {
        const req = request(host.config.endpoint)
        publish('create', { request: req })
        publish('bodyChunkSent', { request: req, chunk: Buffer.from(input.body) })
        yield output
      } finally { closed = true }
    }
    const iterator = host.ctx.waterfall(host.ctx.llm, 'llm/stream', input.options, next)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(output)
    await host.fork.dispose()
    const snapshot = await readFile(host.config.reportPath, 'utf8')
    await iterator.return!()
    expect(closed).toBe(true)
    expect(await host.report()).toMatchObject({ active: false, bufferedBytes: 0 })
    await host.run(input.options, next)
    expect(await readFile(host.config.reportPath, 'utf8')).toBe(snapshot)
  })

  it('原始执行中断时释放未完成捕获，并原样抛出错误', async () => {
    const host = await setup()
    const input = fixture(host.config.marker)
    const error = new Error('private-provider-error')
    await expect(host.run(input.options, async function* () {
      const req = request(host.config.endpoint)
      publish('create', { request: req })
      publish('bodyChunkSent', { request: req, chunk: Buffer.from(input.body) })
      yield output
      throw error
    })).rejects.toBe(error)
    await expect(host.run(input.options, () => { throw error })).rejects.toBe(error)
    const report = await host.report()
    expect(report.bufferedBytes).toBe(0)
    expect(report.records[0].requests[0]).toMatchObject({ checksPassed: false, failure: 'audit_incomplete' })
    expect(report.records.every((record: { endedAt?: string }) => record.endedAt)).toBe(true)
    expect(report.records[1].requests).toHaveLength(0)
    expect(JSON.stringify(report)).not.toContain(error.message)
  })

  it('错误配置与持久化失败不泄漏输入，也不阻断模型流', async () => {
    const host = await setup()
    for (const invalid of [
      { marker: '' }, { endpoint: 'https://user:private-token@fixture.invalid/v1' },
      { endpoint: 'https://fixture.invalid/v1?token=private-token' },
      { endpoint: 'http://remote.invalid/v1' }, { token: 'private-token' }, { reportPath: 'relative.json' },
    ]) {
      expect(() => Audit.apply(host.ctx, { ...host.config, ...invalid })).toThrow('诊断配置无效')
    }
    const broken = await setup({ reportPath: join(tmpdir(), randomUUID(), 'missing', 'report.json') })
    await expect(broken.run(fixture(broken.config.marker).options, async function* () { yield output })).resolves.toEqual([output])
  })
})
