import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { expect } from 'vitest'
import type { DeviceDescriptor, DeviceHit, DevicePort } from '../../src/hmm/device-contracts.ts'
import type { HmmActor, HmmCommand, PlanInput } from '../../src/hmm/model.ts'
import { KV } from '../../src/kv.ts'
import type { Host } from './host.ts'
import { SCENARIOS, type BaselineCase, type BaselineMetrics } from '../../scripts/hmm-baseline-report.ts'

export const CORPUS_VERSION = 'hmm-device-conflict-v1'
export { SCENARIOS, type BaselineCase }
export type Scenario = typeof SCENARIOS[number]
const controller: HmmActor = { role: 'controller' }
export const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
export const samples = [
  { nodeId: 'schedule', deviceId: 'client', domain: 'files' as const, route: 'direct' as const,
    sourceId: 'file:schedule', snippet: 'Project Atlas delivery date: 2026-11-08.\n', expected: '2026-11-08' },
  { nodeId: 'message', deviceId: 'root-phone', domain: 'wechat' as const, route: 'designated-hk' as const,
    sourceId: 'chat:confirmation', snippet: 'Project Atlas delivery date: 2026-11-09.\n', expected: '2026-11-09' },
].map(sample => ({ ...sample, text: sample.snippet + `UNREAD_${sample.nodeId}_PRIVATE_RECORD\n`.repeat(4096) }))
export const corpusHash = digest(JSON.stringify(samples))
export const plan = (): PlanInput => ({
  goal: 'Determine whether the two sources agree on the delivery date. Preserve conflicting evidence.',
  maxActive: 2,
  nodes: [
    { id: 'root', title: 'Source comparison', mode: 'parallel' },
    ...samples.map(sample => ({ id: sample.nodeId, parentId: 'root', title: sample.nodeId,
      instruction: `Read only the relevant delivery date from ${sample.sourceId}.`,
      evidenceRequired: true, claimsRequired: true })),
    { id: 'decision', parentId: 'root', title: 'Resolve evidence', dependsOn: ['schedule', 'message'],
      instruction: 'Compare the dated statements. An unresolved conflict must remain explicit.',
      evidenceRequired: true, claimsRequired: true },
  ],
})

/** 固定脚本驱动真实状态服务；所有计量只覆盖声明的调用边界，不模拟模型质量。 */
export class HmmBaseline {
  readonly metrics: BaselineMetrics = {
    deviceQueryCalls: 0, deviceReadCalls: 0, deviceRequestJsonBytes: 0, deviceResponseJsonBytes: 0,
    transferredFragmentUtf8Bytes: 0, nodeToolCalls: 0, nodeToolFailures: 0,
    nodeToolRequestJsonBytes: 0, nodeToolSuccessJsonBytes: 0, contextJsonBytesMax: 0,
    nodeDeliveryUtf8Bytes: 0, nodeSessions: 0, activeSessionsSampledMax: 0,
    snapshotJsonBytesSampledMax: 0, snapshotJsonBytesFinal: 0,
    retainedSourceUtf8BytesSampledMax: 0, retainedSourceUtf8BytesFinal: 0, evidenceDocumentsFinal: 0, attemptsFinal: 0,
  }
  readonly checks: BaselineCase['checks'] = []
  readonly disconnect = new Map<string, () => void>()
  private readonly started = performance.now()
  private readonly rssStartBytes = process.memoryUsage().rss
  constructor(readonly host: Host, readonly ticketId: string) {}
  view() { return this.host.runtime.hmm.view(controller, this.ticketId) }
  snapshot() { return this.host.runtime.store.get(KV.hmm.workflow(this.ticketId))! }
  graph() { return this.host.runtime.hmm.claims(controller, this.ticketId, undefined, { limit: 8 }) }
  context(nodeId: string) { return this.host.runtime.hmm.context(controller, this.ticketId, nodeId) }
  session(nodeId: string) {
    const sessionId = this.view().nodes.find(node => node.id === nodeId)?.sessionId
    if (!sessionId) throw new Error(`基线节点尚未建立会话：${nodeId}`)
    return sessionId
  }
  check(name: string, passed: boolean) {
    this.checks.push({ name, passed })
    expect(passed, name).toBe(true)
  }
  command(command: HmmCommand) {
    const result = this.host.runtime.hmm.apply(controller, this.ticketId, this.view().revision, command)
    this.sample()
    return result
  }
  async settle() { await this.host.runtime.idle(); this.sample() }
  sample() {
    const state = this.snapshot()
    const bytes = jsonBytes(state)
    const sourceBytes = (state.evidence?.documents ?? []).reduce((sum, doc) => sum + Buffer.byteLength(doc.text ?? '', 'utf8'), 0)
    this.metrics.snapshotJsonBytesFinal = bytes
    this.metrics.snapshotJsonBytesSampledMax = Math.max(this.metrics.snapshotJsonBytesSampledMax, bytes)
    this.metrics.retainedSourceUtf8BytesFinal = sourceBytes
    this.metrics.retainedSourceUtf8BytesSampledMax = Math.max(this.metrics.retainedSourceUtf8BytesSampledMax, sourceBytes)
    this.metrics.activeSessionsSampledMax = Math.max(this.metrics.activeSessionsSampledMax, this.host.runtime.hmmDispatcher.activeCount())
    this.metrics.evidenceDocumentsFinal = state.evidence?.documents.length ?? 0
    this.metrics.attemptsFinal = state.nodes.reduce((sum, node) => sum + node.attempt, 0)
  }
  grant(nodeId: string) {
    const sample = samples.find(item => item.nodeId === nodeId)!
    this.host.runtime.hmm.grantDevice(controller, this.ticketId, this.view().revision,
      { id: nodeId, nodeId, deviceId: sample.deviceId, domain: sample.domain })
    this.sample()
  }
  async start(offline = false) {
    this.host.runtime.hmm.create(controller, this.ticketId, plan())
    for (const sample of samples) {
      const descriptor: DeviceDescriptor = { id: sample.deviceId, label: sample.deviceId, domains: [sample.domain], route: sample.route }
      const hit: DeviceHit = { sourceId: sample.sourceId, title: sample.nodeId, domain: sample.domain,
        version: 'v1', contentHash: digest(sample.text), observedAt: '2026-11-01T00:00:00.000Z',
        totalChars: sample.text.length, sensitivity: 'personal' }
      const port: DevicePort = {
        query: async (request, signal) => {
          signal.throwIfAborted()
          this.metrics.deviceQueryCalls++
          this.metrics.deviceRequestJsonBytes += jsonBytes(request)
          const reply = { hits: [hit], truncated: false }
          this.metrics.deviceResponseJsonBytes += jsonBytes(reply)
          return reply
        },
        read: async (request, signal) => {
          signal.throwIfAborted()
          this.metrics.deviceReadCalls++
          this.metrics.deviceRequestJsonBytes += jsonBytes(request)
          const text = sample.text.slice(request.offset, request.offset + request.length)
          const reply = { version: hit.version, contentHash: hit.contentHash, offset: request.offset, text, totalChars: hit.totalChars }
          this.metrics.deviceResponseJsonBytes += jsonBytes(reply)
          this.metrics.transferredFragmentUtf8Bytes += Buffer.byteLength(text, 'utf8')
          return reply
        },
      }
      this.disconnect.set(sample.nodeId, this.host.runtime.hmmDevices.attach(descriptor, port))
      this.grant(sample.nodeId)
    }
    if (offline) this.disconnect.get('message')!()
    this.command({ action: 'dispatch' })
    await this.settle()
  }
  async tool(nodeId: string, name: string, args: unknown) {
    this.metrics.nodeToolCalls++
    this.metrics.nodeToolRequestJsonBytes += jsonBytes({ name, arguments: args })
    try {
      const value = await this.host.runTool(this.session(nodeId), name, args)
      this.metrics.nodeToolSuccessJsonBytes += jsonBytes(value)
      if (name === 'hmm_node_context') this.metrics.contextJsonBytesMax = Math.max(this.metrics.contextJsonBytesMax, jsonBytes(value))
      return value
    } catch (error) {
      this.metrics.nodeToolFailures++
      throw error
    } finally { this.sample() }
  }
  async extract(nodeId: string, repeatRead = false) {
    const source = samples.find(item => item.nodeId === nodeId)!
    const context = await this.tool(nodeId, 'hmm_node_context', {})
    this.check(`${nodeId} 未获得其他节点授权`, (context.deviceGrants as { id: string }[]).every(grant => grant.id === nodeId))
    const query = await this.tool(nodeId, 'hmm_device_query', { grantId: nodeId, text: 'delivery date', limit: 1 })
    const hits = query.hits as { handle: string }[]
    this.check(`${nodeId} 查询只返回元数据`, hits.length === 1 && !JSON.stringify(query).includes(source.snippet.trim()))
    const args = { handle: hits[0]!.handle, offset: 0, length: source.snippet.length }
    const evidence = await this.tool(nodeId, 'hmm_device_read', args)
    this.check(`${nodeId} 读取对应原文片段`, evidence.text === source.snippet)
    if (repeatRead) {
      const before = this.snapshot()
      const repeated = await this.tool(nodeId, 'hmm_device_read', args)
      this.check('重复读取不复制正文或回执', repeated.ref === evidence.ref
        && this.snapshot().evidence?.documents.length === before.evidence?.documents.length
        && this.snapshot().evidence?.receipts.length === before.evidence?.receipts.length)
    }
    await this.tool(nodeId, 'hmm_node_report', { action: 'complete', summary: `${nodeId}: ${source.expected}`,
      evidenceRefs: [evidence.ref], claims: [{ id: 'delivery', subject: 'Project Atlas', predicate: 'delivery_date',
        object: source.expected, kind: 'extracted', evidenceRefs: [evidence.ref], counterEvidenceRefs: [] }] })
    await this.settle()
  }
  async decide() {
    const context = await this.tool('decision', 'hmm_node_context', {})
    this.check('合并节点未获得来源读取授权', (context.deviceGrants as unknown[]).length === 0)
    const graph = await this.tool('decision', 'hmm_claims', { limit: 8 }) as ReturnType<HmmBaseline['graph']>
    for (const source of samples) {
      const entry = graph.nodes.find(node => node.nodeId === source.nodeId)
      this.check(`${source.nodeId} 断言与固定预期一致`, entry?.subject === 'Project Atlas'
        && entry.predicate === 'delivery_date' && entry.object === source.expected && entry.referenceIntegrity === 'valid')
    }
    const support = graph.nodes.find(node => node.nodeId === 'schedule')!.ref
    const counter = graph.nodes.find(node => node.nodeId === 'message')!.ref
    await this.tool('decision', 'hmm_node_report', { action: 'complete', summary: 'The delivery date remains unresolved.',
      evidenceRefs: [support], claims: [{ id: 'conflict', subject: 'Project Atlas', predicate: 'delivery_status',
        object: 'unresolved', kind: 'inferred', evidenceRefs: [support], counterEvidenceRefs: [counter] }] })
    await this.settle()
    this.check('反证被保留在断言图', this.graph().edges.some(edge => edge.kind === 'contradicts' && edge.from === counter))
  }
  accept() {
    this.command({ action: 'review_claims', reviews: this.graph().nodes.map(node => ({
      ref: node.ref, verdict: 'accept' as const, reason: 'Fixed fixture oracle: the conflicting dates remain unresolved.',
    })) })
    this.command({ action: 'validate', summary: 'The fixed source comparison is complete; the conflict is unresolved.',
      evidenceRefs: [this.context('decision').resultRef!] })
    this.host.runtime.hmm.assertReady(this.ticketId)
    this.check('完成逐项复核和有效性验收', this.view().phase === 'validated' && this.view().referenceIntegrity === 'valid')
  }
  finish(scenario: Scenario, sample: number, completed: boolean): BaselineCase {
    this.sample()
    this.metrics.nodeSessions = this.host.nodeFactory.mock.calls.length
    const deliveries = this.host.deliveries.mock.calls.map(([item]) => item).filter(item => item.sessionId.startsWith('hmm-'))
    this.metrics.nodeDeliveryUtf8Bytes = deliveries.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0)
    const limits = {
      contextJsonBytesMax: 8 * 1024, snapshotJsonBytesSampledMax: 48 * 1024,
      retainedSourceUtf8BytesSampledMax: 256, activeSessionsSampledMax: 2,
      deviceRequestJsonBytes: 2 * 1024, deviceResponseJsonBytes: 4 * 1024,
      nodeToolRequestJsonBytes: 8 * 1024, nodeToolSuccessJsonBytes: 24 * 1024, nodeDeliveryUtf8Bytes: 16 * 1024,
    } as const
    for (const [name, limit] of Object.entries(limits))
      this.checks.push({ name: `${name} <= ${limit}`, passed: this.metrics[name as keyof typeof limits] <= limit })
    this.checks.push({ name: '未读取的原文不进入快照和节点投递', passed: !JSON.stringify([this.snapshot(), deliveries]).includes('UNREAD_') })
    return { scenario, sample, completed, passed: completed && this.checks.every(check => check.passed),
      checks: this.checks, metrics: { ...this.metrics },
      observed: { wallMs: Math.round((performance.now() - this.started) * 1000) / 1000,
        rssStartBytes: this.rssStartBytes, rssEndBytes: process.memoryUsage().rss } }
  }
}
