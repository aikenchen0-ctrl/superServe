import { describe, expect, it, vi } from 'vitest'
import { checkWireHistory, guardedLoopbackFetch, syntheticHistory } from '../scripts/hmm-provider-wire.ts'

const fixture = () => {
  const input = syntheticHistory(2, 3, true, true)
  const wire = {
    model: input.model,
    tools: input.tools.map(tool => ({ type: 'function', function: { name: tool.name, parameters: tool.parameters } })),
    messages: input.messages.map(message => message.role === 'assistant'
      ? { role: 'assistant', content: null, tool_calls: message.content.map(block =>
        ({ type: 'function', id: block.id, function: { name: block.name, arguments: block.arguments } })) }
      : { role: message.role, content: message.content.map(block => block.text ?? '').join(''),
        ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}) }),
  }
  return { input, wire }
}

describe('出站诊断不能把历史丢失误报为通过', () => {
  it('核对多轮、并行倒序、错误数据及 Unicode，不依赖固定任务或调用标识', () => {
    const { input, wire } = fixture()
    const result = checkWireHistory(input, wire)
    expect(result.toolResults).toBe(6)
    expect(result.toolTextUtf8Bytes).toBeGreaterThan(result.toolTextUtf16Units)
    expect(result.roles).toEqual({ system: 1, user: 1, assistant: 2, tool: 6 })
    expect(checkWireHistory(input, wire)).toEqual(result)
    const other = fixture()
    expect(checkWireHistory(other.input, other.wire).toolHistoryHash).not.toBe(result.toolHistoryHash)
  })

  it.each(['drop', 'truncate', 'wrong-id', 'duplicate', 'promote', 'reorder'] as const)('拒绝结果被修改：%s', change => {
    const { input, wire } = fixture()
    const index = wire.messages.findIndex(message => message.role === 'tool')
    const target = wire.messages[index]!
    if (change === 'drop') wire.messages.splice(index, 1)
    if (change === 'truncate') target.content = String(target.content).slice(0, 20)
    if (change === 'wrong-id') Object.assign(target, { tool_call_id: 'not_the_original_call' })
    if (change === 'duplicate') wire.messages.push(target)
    if (change === 'promote') target.role = 'user'
    if (change === 'reorder') [wire.messages[index], wire.messages[index + 1]] = [wire.messages[index + 1]!, target]
    expect(() => checkWireHistory(input, wire)).toThrow()
  })

  it('拒绝用户指令、工具集合和模型身份被静默替换', () => {
    for (const change of ['user', 'tools', 'model']) {
      const { input, wire } = fixture()
      if (change === 'user') wire.messages.find(message => message.role === 'user')!.content = 'changed'
      if (change === 'tools') wire.tools.pop()
      if (change === 'model') wire.model = 'other-model'
      expect(() => checkWireHistory(input, wire)).toThrow()
    }
  })

  it('错误角色不能凭工具调用内容正确而通过', () => {
    const { input, wire } = fixture()
    wire.messages.find(message => message.role === 'assistant')!.role = 'unknown'
    expect(() => checkWireHistory(input, wire)).toThrow()
  })
})

describe('诊断传输只允许本轮回环端点', () => {
  it('拒绝外部地址、其他端口、附加路径和凭据，不调用底层网络', () => {
    const fetcher = vi.fn<typeof fetch>()
    const guarded = guardedLoopbackFetch('http://127.0.0.1:12345/v1', fetcher)
    for (const target of [
      'https://example.invalid/v1/chat/completions',
      'http://127.0.0.1:54321/v1/chat/completions',
      'http://127.0.0.1:12345/v1/chat/completions?redirect=1',
      'http://user:password@127.0.0.1:12345/v1/chat/completions',
    ]) expect(() => guarded(target)).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    expect(() => guardedLoopbackFetch('https://example.invalid/v1', fetcher)).toThrow()
  })

  it('允许精确匹配的请求，并强制拒绝跟随重定向', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
    const guarded = guardedLoopbackFetch('http://127.0.0.1:12345/v1', fetcher)
    const request = new Request('http://127.0.0.1:12345/v1/chat/completions', { method: 'POST' })
    await guarded(request, { redirect: 'follow' })
    expect(fetcher).toHaveBeenCalledWith(request, { redirect: 'error' })
  })
})
