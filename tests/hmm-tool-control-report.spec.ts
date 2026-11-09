import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { evaluateToolControl } from '../scripts/hmm-tool-control-report.ts'

function fixture() {
  const hashes = [0, 1].map(() => createHash('sha256').update(randomBytes(16)).digest('hex'))
  const calls = (['A', 'B'] as const).map((variant, index) => ({
    variant,
    at: `2026-11-04T00:00:0${index * 3}.000Z`,
    endedAt: `2026-11-04T00:00:0${index * 3 + 2}.000Z`,
    expectedHash: hashes[index]!, outputHash: hashes[index]!,
    outputChars: 32, finish: 'stop', toolCalls: 0, matchesExpected: true,
  }))
  const run = { marker: randomBytes(16).toString('hex'), state: 'finished', onlyToolResultChanged: true, toolsExecuted: 0, calls }
  const wire = {
    marker: run.marker, active: false, observationErrors: 0, droppedCalls: 0,
    records: calls.map(call => ({
      sessionId: 'hmm-' + run.marker, at: call.at, endedAt: call.endedAt, finish: 'stop',
      requests: [{ checksPassed: true, bodyBytes: 1000, toolResults: 1, status: 200, transportError: false }],
    })),
  }
  return { run, wire }
}

describe('工具结果对照必须区分流程结束与验证通过', () => {
  it('两份不同随机结果都完成传输并正确回答才通过', () => {
    const { run, wire } = fixture()
    expect(evaluateToolControl(run, wire)).toMatchObject({
      verdict: 'passed', reason: 'both_values_matched', completedCalls: 2, matchedCalls: 2,
    })
  })

  it.each(['error', 'max-tokens', 'tool-calls', 'aborted'])('正常结束迭代但终态为 %s 时，不构成完整对照', finish => {
    const { run, wire } = fixture()
    run.calls[0]!.finish = finish
    wire.records[0]!.finish = finish
    expect(evaluateToolControl(run, wire)).toMatchObject({ verdict: 'inconclusive', completedCalls: 1 })
  })

  it('一方502另一方回答正确，不把整组判为通过或模型失败', () => {
    const { run, wire } = fixture()
    run.calls[0]!.finish = 'error'
    wire.records[0]!.finish = 'error'
    wire.records[0]!.requests[0]!.status = 502
    expect(evaluateToolControl(run, wire)).toMatchObject({
      verdict: 'inconclusive', reason: 'call_or_wire_incomplete', completedCalls: 1, matchedCalls: 1,
    })
  })

  it('不信任预计算匹配标记，实际答案哈希不符即失败', () => {
    const { run, wire } = fixture()
    run.calls[0]!.outputHash = run.calls[1]!.expectedHash
    expect(evaluateToolControl(run, wire)).toMatchObject({ verdict: 'failed', reason: 'answer_mismatch' })
  })

  it.each(['outputHash', 'outputChars'])('缺少答案证据 %s 时不能误判为答案错误', field => {
    const { run, wire } = fixture()
    const calls = run.calls.map((call, index) => index === 0
      ? Object.fromEntries(Object.entries(call).filter(([key]) => key !== field)) : call)
    expect(evaluateToolControl({ ...run, calls }, wire)).toMatchObject({
      verdict: 'inconclusive', reason: 'answer_evidence_missing',
    })
  })

  it('答案相同也不能掩盖额外工具调用', () => {
    const { run, wire } = fixture()
    run.calls[1]!.toolCalls = 1
    expect(evaluateToolControl(run, wire)).toMatchObject({ verdict: 'failed', reason: 'unexpected_tool_call' })
  })

  it.each(['status', 'history', 'empty-body', 'wrong-results', 'finish-disagreement'])('拒绝缺少传输依据：%s', change => {
    const { run, wire } = fixture()
    const record = wire.records[0]!, request = record.requests[0]!
    if (change === 'status') request.status = 401
    if (change === 'history') request.checksPassed = false
    if (change === 'empty-body') request.bodyBytes = 0
    if (change === 'wrong-results') request.toolResults = 0
    if (change === 'finish-disagreement') record.finish = 'error'
    expect(evaluateToolControl(run, wire).verdict).toBe('inconclusive')
  })

  it.each(['missing', 'duplicate', 'same-value', 'wrong-session', 'wrong-marker', 'uncontrolled', 'executed', 'active', 'dropped', 'observer-error', 'time', 'extra-request'])('拒绝不完整或未受控证据：%s', change => {
    const { run, wire } = fixture()
    if (change === 'missing') run.calls.pop()
    if (change === 'duplicate') run.calls[1]!.variant = 'A'
    if (change === 'same-value') run.calls[1]!.expectedHash = run.calls[0]!.expectedHash
    if (change === 'wrong-session') wire.records[1]!.sessionId = 'different'
    if (change === 'wrong-marker') wire.marker = 'different'
    if (change === 'uncontrolled') run.onlyToolResultChanged = false
    if (change === 'executed') run.toolsExecuted = 1
    if (change === 'active') wire.active = true
    if (change === 'dropped') wire.droppedCalls = 1
    if (change === 'observer-error') wire.observationErrors = 1
    if (change === 'time') wire.records[0]!.at = '2026-11-03T00:00:00.000Z'
    if (change === 'extra-request') wire.records[0]!.requests.push({ ...wire.records[0]!.requests[0]! })
    expect(evaluateToolControl(run, wire).verdict).toBe('inconclusive')
  })

  it('保留底层传输信号，但不以该信号覆盖已确认的应用终态', () => {
    const { run, wire } = fixture()
    wire.records[1]!.requests[0]!.transportError = true
    const result = evaluateToolControl(run, wire)
    expect(result.verdict).toBe('passed')
    expect(result.samples[1]!.transportSignal).toBe(true)
  })

  it('不能用同一条请求记录同时证明两个对照完成', () => {
    const { run, wire } = fixture()
    run.calls[0]!.endedAt = run.calls[1]!.endedAt
    run.calls[1]!.at = run.calls[0]!.at
    wire.records[1]!.endedAt = '2026-11-04T00:00:09.000Z'
    expect(evaluateToolControl(run, wire)).toMatchObject({
      verdict: 'inconclusive', reason: 'request_correlation_failed', samples: [],
    })
  })

  it('结构无效时只返回固定原因，不回显原始错误或内容', () => {
    const result = evaluateToolControl({ marker: 'private-secret' }, { text: 'private-content' })
    expect(result).toMatchObject({ verdict: 'inconclusive', reason: 'invalid_report' })
    expect(JSON.stringify(result)).not.toContain('private-')
  })

  it('未知结束原因不能混入摘要，即使其他字段都有效', () => {
    const { run, wire } = fixture()
    run.calls[0]!.finish = 'private-provider-error'
    const result = evaluateToolControl(run, wire)
    expect(result).toMatchObject({ verdict: 'inconclusive', reason: 'invalid_report' })
    expect(JSON.stringify(result)).not.toContain('private-')
  })
})
