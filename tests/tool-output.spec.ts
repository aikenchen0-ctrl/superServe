import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { registerTool } from '../src/app/tools/register.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const schema = { type: 'object' as const, additionalProperties: true }
function tool(value: unknown): ToolDefinition {
  return { name: 'output_probe', description: '检查宿主输出契约', parameters: schema,
    output: { schema, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async () => value,
  }
}
async function output(value: unknown) {
  const register = vi.fn()
  registerTool({ register }, tool(value))
  return register.mock.calls[0]![0].execute({}, { signal: new AbortController().signal })
}

it('省略嵌套可选字段，保留 null、零、空串、布尔值与数组顺序，且不修改原对象', async () => {
  const original = Object.freeze({ omitted: undefined, zero: 0, no: false, empty: '', nil: null,
    nested: Object.freeze({ missing: undefined, list: [{ absent: undefined, value: 2 }, 0, null] }) })
  expect(validateJsonSchemaValue(schema, original).length).toBeGreaterThan(0)
  const result = await output(original)
  expect(result).toEqual({ zero: 0, no: false, empty: '', nil: null, nested: { list: [{ value: 2 }, 0, null] } })
  expect(validateJsonSchemaValue(schema, result)).toEqual([])
  expect(Object.hasOwn(original, 'omitted')).toBe(true)
  expect(Object.hasOwn(original.nested, 'missing')).toBe(true)
})

it.each([
  ['数组未赋值项', { values: [undefined] }],
  ['数组空位', { values: new Array(1) }],
  ['非有限数', { value: NaN }],
  ['无穷大', { value: Infinity }],
  ['负零', { value: -0 }],
  ['大整数', { value: 1n }],
  ['函数', { value: () => 1 }],
  ['日期实例', { value: new Date(0) }],
  ['自定义序列化', { value: { toJSON: () => 'hidden' } }],
  ['数组附加字段', { value: Object.assign([1], { extra: undefined }) }],
  ['符号字段', { [Symbol('hidden')]: undefined }],
  ['不可枚举字段', Object.defineProperty({}, 'hidden', { value: undefined })],
])('不会把%s转换成看似有效的 JSON', async (_name, value) => {
  expect(validateJsonSchemaValue(schema, await output(value)).length).toBeGreaterThan(0)
})

it('循环引用仍被拒绝，共用对象引用可以正常输出', async () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(validateJsonSchemaValue(schema, await output(cyclic)).length).toBeGreaterThan(0)
  const shared = { optional: undefined, value: 3 }
  const result = await output({ first: shared, second: shared })
  expect(result).toEqual({ first: { value: 3 }, second: { value: 3 } })
  expect(validateJsonSchemaValue(schema, result)).toEqual([])
})

it('注册保留原生渲染、释放、异常与取消信号', async () => {
  const signal = new AbortController().signal
  const failure = new Error('执行失败')
  const execute = vi.fn(async () => { throw failure })
  const definition = { ...tool({}), execute }
  const dispose = vi.fn(), register = vi.fn((_definition: ToolDefinition) => dispose)
  expect(registerTool({ register }, definition)).toBe(dispose)
  const registered = register.mock.calls[0]![0]
  expect(registered.output).toBe(definition.output)
  const execution = { signal } as Parameters<ToolDefinition['execute']>[1]
  await expect(registered.execute({}, execution)).rejects.toBe(failure)
  expect(execute).toHaveBeenCalledWith({}, execution)
})

it('真实 DSH 工具运行时接受规范化输出，并原样返回拒绝非法输出的错误码', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const definition = tool({ optional: undefined, child: { value: 1, optional: undefined } })
    const dispose = registerTool(ctx.tools, definition)
    const result = await ctx.tools.execute({ callId: 'valid-output' as ToolCallId, name: definition.name, arguments: {},
      signal: new AbortController().signal })
    expect(result).toMatchObject({ isError: false, value: { child: { value: 1 } } })
    dispose()
    registerTool(ctx.tools, tool({ value: NaN }))
    const invalid = await ctx.tools.execute({ callId: 'invalid-output' as ToolCallId, name: definition.name, arguments: {},
      signal: new AbortController().signal })
    expect(invalid).toMatchObject({ isError: true, error: { info: { code: 'INVALID_TOOL_OUTPUT' } } })
  } finally { await ctx.fiber.dispose() }
})

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
it('真实领域与注册路径的总管读取、节点上下文、报告和验收均满足宿主契约', async () => {
  h = await startRuntime(undefined, { mode: 'hmm' })
  const created = await h.api('POST', 'tasks', {
    requestId: 'native-output-contract', mode: 'single', goal: '仅检查已提供输入的执行契约',
  })
  expect(created.status).toBe(200)
  await h.runtime.idle()
  const id = created.body.ticketId as string
  await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${id}` })
  await h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: id, view: 'plan' })
  const view = await h.runTool(h.runtime.masterId, 'hmm_read', { ticket_id: id })
  const node = (view.nodes as { mode: string; sessionId: string }[]).find(item => item.mode === 'task')!
  const context = await h.runTool(node.sessionId, 'hmm_node_context', {})
  await h.runTool(node.sessionId, 'hmm_node_report', {
    action: 'complete', summary: '输入范围检查完毕', evidenceRefs: [context.inputRef],
  })
  await h.runtime.idle()
  const current = h.runtime.hmm.view({ role: 'controller' }, id)
  const result = current.nodes.find(item => item.mode === 'task')!
  for (const refs of [[context.inputRef], [result.resultRef, context.inputRef], ['unknown-result']]) {
    await expect(h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: id, revision: current.revision,
      command: { action: 'validate', summary: '无效引用不得验收', evidenceRefs: refs } })).rejects.toThrow('验收必须引用')
  }
  expect(h.runtime.hmm.view({ role: 'controller' }, id).revision).toBe(current.revision)
  await h.runTool(h.runtime.masterId, 'hmm_apply', { ticket_id: id, revision: current.revision,
    command: { action: 'validate', summary: '契约闭环完成', evidenceRefs: [result.resultRef] } })
  expect(h.runtime.store.tickets.get(id)?.ended?.outcome).toBe('completed')
})
