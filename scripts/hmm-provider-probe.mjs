import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { checkWireHistory, guardedLoopbackFetch, requireProbe, syntheticHistory, WireProbeError } from './hmm-provider-wire.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = join(root, '.artifacts', 'hmm-provider-probe.json')
const usage = '用法：node scripts/hmm-provider-probe.mjs --dsh-root DSH安装目录 [--synthetic-session 合成会话日志路径]\n只访问临时回环端点，不加载宿主配置或密钥；可重复指定已确认不含真实资料的合成会话。'

// 依据已安装依赖的公开导出定位协议入口，避免加载仓库中的旧开发依赖。
function piEntry(adapterEntry, subpath) {
  const paths = createRequire(realpathSync(adapterEntry)).resolve.paths('@earendil-works/pi-ai') ?? []
  const directory = paths.map(path => join(path, '@earendil-works/pi-ai')).find(path => existsSync(join(path, 'package.json')))
  requireProbe(directory, 'pi_package_missing')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const entry = manifest.exports['./api/*']?.import?.replace('*', subpath)
  requireProbe(typeof entry === 'string' && entry.startsWith('./'), 'pi_export_missing')
  const target = resolve(directory, entry)
  requireProbe(!relative(directory, target).startsWith('..') && !isAbsolute(relative(directory, target)), 'pi_export_boundary')
  return { target, version: manifest.version }
}

function sessionCases(path, surface) {
  requireProbe(statSync(path).size <= 8 * 1024 * 1024, 'session_file_budget')
  const bytes = readFileSync(path)
  const text = path.endsWith('.zstd') ? zstdDecompressSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8') : bytes.toString('utf8')
  const records = text.trim().split('\n').map(line => JSON.parse(line))
  const events = records.filter(event => Number.isInteger(event.seq))
  requireProbe(events.length < 10000, 'session_event_budget')
  const responses = events.filter(event => event.type === 'assistant/message')
  requireProbe(responses.length > 0 && responses.length <= 24, 'session_step_budget')
  const sourceHash = createHash('sha256').update(bytes).digest('hex')
  return responses.map(response => {
    const prefix = events.filter(event => event.seq < response.seq)
    const header = prefix.findLast(event => event.type === 'request/header')?.data.header
    requireProbe(header?.config?.provider && header.config.model, 'session_header_missing')
    const projected = surface.foldSurface(prefix)
    const bySeq = new Map(prefix.map(event => [event.seq, event]))
    const messages = projected.nodes.map(seq => surface.deriveEventMessage(bySeq.get(seq), projected.projectedMessages)).filter(Boolean)
    requireProbe(messages.every(message => message.content.every(block => ['text', 'reasoning', 'tool-call'].includes(block.type))), 'session_content_unsupported')
    return {
      name: `session-${sourceHash.slice(0, 12)}-step-${response.data.step}`,
      sourceHash,
      input: { provider: header.config.provider, model: header.config.model, messages, tools: header.tools ?? [], maxTokens: 4096 },
    }
  })
}

async function main() {
  const { values } = parseArgs({ options: {
    'dsh-root': { type: 'string' }, 'synthetic-session': { type: 'string', multiple: true }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log(usage); return }
  requireProbe(values['dsh-root'], 'dsh_root_required')
  requireProbe(Number(process.versions.node.split('.')[0]) >= 24, 'node_version')
  const hostRequire = createRequire(join(resolve(values['dsh-root']), 'package.json'))
  const adapterEntry = hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')
  const { PiAiAdapter } = await import(pathToFileURL(adapterEntry).href)
  const protocolEntry = piEntry(adapterEntry, 'openai-completions.lazy')
  const { openAICompletionsApi } = await import(pathToFileURL(protocolEntry.target).href)
  const surface = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session/surface')).href)
  const adapterVersion = JSON.parse(readFileSync(hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'), 'utf8')).version
  const cases = [
    { name: 'empty-history', input: syntheticHistory(0, 1) },
    { name: 'foreign-single-tool', input: syntheticHistory(1, 1, false) },
    { name: 'parallel-native-replay', input: syntheticHistory(11, 4) },
    { name: 'error-results', input: syntheticHistory(2, 3, true, true) },
    ...(values['synthetic-session'] ?? []).flatMap(path => sessionCases(resolve(path), surface)),
  ]
  requireProbe(cases.length <= 80, 'case_budget')
  const captured = []
  let captureError
  const server = createServer(async (request, response) => {
    try {
      requireProbe(request.method === 'POST' && request.url === '/v1/chat/completions', 'request_route')
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        requireProbe(size <= 2 * 1024 * 1024, 'request_size')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      captured.push({ body, bytes: size })
      // 返回固定合成响应，只检查传输与解码，不伪装成模型推理验证。
      const event = (delta, finish_reason) => `data: ${JSON.stringify({
        id: 'chatcmpl-local-wire-probe', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(event({ role: 'assistant', content: 'probe-ok' }, null) + event({}, 'stop') + 'data: [DONE]\n\n')
    } catch (error) {
      captureError = error instanceof WireProbeError ? error : new WireProbeError('capture_failed')
      response.writeHead(400).end()
    }
  })
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), mode: 'loopback-http-capture',
    adapterVersion, piAiVersion: protocolEntry.version, expectedCases: cases.length, passed: false, cases: [],
    probeSourceHash: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url)))
      .update(readFileSync(join(root, 'scripts/hmm-provider-wire.ts'))).digest('hex'),
    adapterSourceHash: createHash('sha256').update(readFileSync(adapterEntry)).digest('hex'),
    protocolSourceHash: createHash('sha256').update(readFileSync(piEntry(adapterEntry, 'openai-completions').target)).digest('hex'),
    realCredentialsUsed: false, rawMessagesSaved: false, externalRequestsAllowed: false,
    limitations: [
      '使用已安装的公开适配器和协议入口，但不加载运行中进程的配置；不是历史线上请求的抓包。',
      '只验证文本与工具调用的 OpenAI Chat Completions 序列化；不证明网关处理、真实模型理解或任务复核成功。',
      '响应由本地服务固定生成，字节数不能作为生产模型成本或网络性能指标。',
    ],
  }
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`
    const placeholder = 'local-wire-probe-placeholder'
    const guardedFetch = guardedLoopbackFetch(baseURL)
    for (const item of cases) {
      const { provider, model } = item.input
      const descriptor = {
        id: model, name: model, provider, api: 'openai-completions', baseUrl: baseURL,
        reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      const protocol = openAICompletionsApi()
      // 仅注入协议公开的传输函数，消息构造和序列化仍由已安装适配器负责。
      const piProvider = {
        id: provider, name: provider, baseUrl: baseURL, getModels: () => [descriptor],
        auth: { apiKey: { name: 'Local probe', resolve: async () => ({ auth: { apiKey: placeholder }, source: 'local-probe' }) } },
        stream: (model, context, options) => protocol.stream(model, context, { ...options, fetch: guardedFetch, maxRetries: 0 }),
        streamSimple: (model, context, options) => protocol.streamSimple(model, context, { ...options, fetch: guardedFetch, maxRetries: 0 }),
      }
      const profiles = new Map([[provider, {
        provider, displayName: provider, piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(),
        streamIdleTimeoutMs: 5000, maxRequestImageBytes: 1024, requestImagePixelBudget: 1024, requestImageMaxBytes: 1024,
      }]])
      let degraded = 0
      const adapter = new PiAiAdapter({
        profiles: () => profiles, resolveApiKey: async () => placeholder,
        auth: {
          credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new WireProbeError('credential_write_denied') }, delete: async () => { throw new WireProbeError('credential_write_denied') } },
          authContext: { env: async () => undefined, fileExists: async () => false },
        },
        onReplayDegrade: () => { degraded++ },
      })
      let finish
      for await (const chunk of adapter.stream({ ...item.input, signal: AbortSignal.timeout(10000) })) {
        if (chunk.type === 'finish') finish = chunk.reason.kind
      }
      if (captureError) throw captureError
      requireProbe(finish === 'stop', 'response_decode')
      requireProbe(captured.length === 1, 'request_count')
      requireProbe(degraded === 0, 'replay_degraded')
      const request = captured.shift()
      const checked = checkWireHistory(item.input, request.body)
      report.cases.push({ name: item.name, ...(item.sourceHash ? { sourceHash: item.sourceHash } : {}),
        passed: true, requestBytes: request.bytes, replayDegradations: degraded, ...checked })
    }
    report.passed = report.cases.length === cases.length
  } catch (error) {
    report.failure = error instanceof WireProbeError ? error.code : 'adapter_probe_failed'
    process.exitCode = 1
  } finally {
    server.closeAllConnections()
    await new Promise((done, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done()))
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(`出站验证${report.passed ? '通过' : '失败'}：${report.cases.length}/${cases.length}。报告：${reportPath}`)
  if (report.failure) console.error(`诊断代码：${report.failure}`)
}

main().catch(error => {
  console.error(`诊断未启动：${error instanceof WireProbeError ? error.code : 'probe_setup_failed'}。${usage}`)
  process.exitCode = 1
})
