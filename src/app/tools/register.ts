import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'

/** 只省略普通对象中未赋值的可选字段，其余值继续交由 DSH 原生契约校验。 */
function outputValue(value: unknown, copies = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return value
  if (copies.has(value)) return copies.get(value)
  const copy = array ? [] : Object.create(prototype)
  copies.set(value, copy)
  // 保留数组空位、访问器等结构，由宿主判断是否合法，不通过序列化悄悄改变含义。
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if ('value' in descriptor) {
      if (!array && typeof key === 'string' && descriptor.enumerable && descriptor.value === undefined) continue
      descriptor.value = outputValue(descriptor.value, copies)
    }
    Object.defineProperty(copy, key, descriptor)
  }
  return copy
}

/** 总管、执行器与独立节点共用的 DSH 工具输出边界，不修改领域对象或取消信号。 */
export function registerTool(tools: Pick<ToolRuntime, 'register'>, definition: ToolDefinition): () => void {
  return tools.register({ ...definition,
    execute: async (args, execution) => outputValue(await definition.execute(args, execution)),
  })
}
