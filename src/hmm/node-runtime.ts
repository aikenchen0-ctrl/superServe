import type { z } from 'zod'
import type { HmmBinding } from './model.ts'

export interface HmmNodeTool {
  name: string
  description: string
  schema: z.ZodType
  execute(args: unknown, signal: AbortSignal): unknown | Promise<unknown>
  /** 仅在工具成功返回后结束回合，不把业务完成当成强制取消。 */
  endsRun?(args: unknown): boolean
}

export interface HmmNodeStart {
  binding: HmmBinding
  purpose?: 'reasoning' | 'survey'
  prompt: string
  input: unknown
  tools: readonly HmmNodeTool[]
  signal: AbortSignal
  /** 启动、异步准备后及实际投递前重验输入与授权；不用于在途回合的工具权限检查。 */
  authorize(): void
  isCurrent(): boolean
  onStep(): boolean
  onDelivered(): void
  onIdle(): void
  onError(error: unknown): void
  onLost(): void
}

export interface HmmNodeHandle {
  cancel(): void
  /** 有界等待已提交报告的回合结束；关停信号必须能立即中断等待。 */
  finish(signal: AbortSignal): Promise<void>
  dispose(): Promise<void>
}

/** 启动失败后移交已创建资源的回收权；原始原因只用于宿主的受限诊断。 */
export class HmmNodeStartError extends Error {
  constructor(cause: unknown, readonly handle: HmmNodeHandle) {
    super('节点启动失败，执行资源仍待回收', { cause })
  }
}

/** 业务调度器只依赖节点执行生命周期，不依赖特定 Agent 或 Session 类型。 */
export interface HmmNodeRuntime {
  install(onCapacityChanged: () => void): () => void
  /** 普通拒绝不得遗留资源；取得句柄后失败须以 HmmNodeStartError 移交回收，不隐式重放旧会话。 */
  start(request: HmmNodeStart): Promise<HmmNodeHandle>
}
