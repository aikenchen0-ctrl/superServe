import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { AgentDelivery } from '../app/delivery.ts'
import type { Store } from '../app/store.ts'
import { resolveRoleModel } from '../app/role-models.ts'
import { registerTool } from '../app/tools/register.ts'
import { until } from '../executor/background.ts'
import { HmmNodeStartError, type HmmNodeHandle, type HmmNodeRuntime, type HmmNodeStart, type HmmNodeTool } from '../hmm/node-runtime.ts'

export const HMM_PRESET = 'dsh-superagent-hmm'
export const HMM_FINISH_TIMEOUT_MS = 2000

interface RuntimeHost {
  context: Context
  store: Pick<Store, 'settings'>
  stateDir: string
}

interface ActiveExecution {
  request: HmmNodeStart
  agent?: Agent
}

/** DSH 专用节点执行适配器；Session 可丢弃重建，节点状态不保存在此处。 */
export class DshHmmNodeRuntime implements HmmNodeRuntime {
  private readonly executions = new Map<string, ActiveExecution>()
  private readonly delivery: AgentDelivery

  constructor(private readonly host: RuntimeHost) {
    this.delivery = new AgentDelivery(host.context)
  }

  install(onCapacityChanged: () => void): () => void {
    const { context } = this.host
    const disposers = [
      context.on('agent/status', ({ agent, status }) => {
        const execution = this.executions.get(agent.id)
        if (execution?.agent === agent && status === 'idle') execution.request.onIdle()
        onCapacityChanged()
      }),
      context.on('agent/error', ({ agent, error }) => {
        const execution = this.executions.get(agent.id)
        if (execution?.agent === agent) execution.request.onError(error)
      }),
      context.on('agent/disposed', ({ agent }) => {
        const execution = this.executions.get(agent.id)
        if (execution?.agent !== agent) return
        this.executions.delete(agent.id)
        execution.request.onLost()
        onCapacityChanged()
      }),
      context.on('agent/created', ({ agent }) => {
        if (!agent.id.startsWith('hmm-') || this.executions.get(agent.id)?.agent === agent) return
        agent.ctx.tools.restrict({ allow: [] })
        agent.ctx.tools.guard(() => '此节点会话已结束，请从计划创建新的执行')
        agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  async start(request: HmmNodeStart): Promise<HmmNodeHandle> {
    const { context } = this.host
    request.authorize()
    if (this.executions.has(request.binding.sessionId)) throw new Error('节点执行编号已被占用')
    const execution: ActiveExecution = { request }
    this.executions.set(request.binding.sessionId, execution)
    let handle: HmmNodeHandle | undefined
    try {
      const { executor } = this.host.store.settings()
      const configured = (request.purpose === 'survey' ? executor.surveyModel : null) ?? executor.model
        ?? (context.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined)?.currentSelection()
      if (!configured) throw new Error('未配置节点模型')
      const model = await until(resolveRoleModel(context, configured), request.signal)
      request.authorize()
      if (!model) throw new Error('模型解析已中止')
      const { input, binding } = request
      const allowed = new Set(request.tools.map(tool => tool.name))
      const owned = await context.agents.create({
        sessionId: binding.sessionId as SessionId,
        meta: { cwd: this.host.stateDir, agentPreset: HMM_PRESET },
        agentOptions: { ...model, maxTokens: 4096 },
        signal: request.signal,
        setup: async (scope, agent) => {
          request.authorize()
          execution.agent = agent
          const presets = context.get('agentPresets') as { mount(scope: Context, id: string): Promise<void> } | undefined
          if (!presets) throw new Error('DSH 未提供 Agent 预设服务')
          await until(presets.mount(scope, HMM_PRESET), request.signal)
          request.authorize()
          scope.effect(() => installModelSelection(scope, { current: model, assembled: undefined }))
          scope.tools.restrict({ allow: [] })
          scope.tools.guard(call => !allowed.has(call.name) ? '节点仅能读取上下文或提交结果'
            : !this.isCurrent(request) ? '节点执行凭据已失效' : undefined)
          scope.systemPrompt.section({ name: 'superserve-hmm-node', order: 9999, interpolate: false, complete: true,
            text: request.prompt })
          scope.on('agent/pre-step', async (_payload, next) => {
            if (!this.isCurrent(request)) return { kind: 'reject' }
            return request.onStep() ? next() : { kind: 'reject' }
          })
          for (const tool of request.tools) this.registerTool(agent, tool)
          return { commit: () => request.authorize() }
        },
      })
      // 创建后的失败也交回同一句柄，不在异常路径中丢弃回收权或另行重试。
      handle = {
        cancel: () => owned.agent.cancel({ kind: 'user' }),
        finish: async signal => {
          await until(owned.agent.whenIdle(), signal, HMM_FINISH_TIMEOUT_MS)
        },
        dispose: async () => {
          await owned.dispose()
          if (this.executions.get(binding.sessionId) === execution) this.executions.delete(binding.sessionId)
        },
      }
      request.authorize()
      owned.agent.session.append('model/selection', model)
      // 元数据与持久化等待不能阻塞撤销；取得句柄后仍由调度器确认释放，再归还额度。
      await until(context.sessionController.rename({ sessionId: binding.sessionId as SessionId, title: `HMM ${binding.nodeId}` }), request.signal)
      request.signal.throwIfAborted()
      await until(this.delivery.send(owned.agent, binding.sessionId, JSON.stringify(input), 'queue',
        request.signal, request.authorize, request.onDelivered), request.signal)
      request.signal.throwIfAborted()
      execution.agent = owned.agent
      return handle
    } catch (error) {
      if (handle) throw new HmmNodeStartError(error, handle)
      if (this.executions.get(request.binding.sessionId) === execution) this.executions.delete(request.binding.sessionId)
      throw error
    }
  }

  private isCurrent(request: HmmNodeStart): boolean {
    return !request.signal.aborted && request.isCurrent()
  }

  private registerTool(agent: Agent, definition: HmmNodeTool): void {
    const output = {
      schema: { type: 'object' as const, additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    }
    registerTool(agent.ctx.tools, {
      name: definition.name,
      description: definition.description,
      parameters: z.toJSONSchema(definition.schema),
      output,
      execute: async (args, execution) => {
        const result = await definition.execute(args, execution.signal)
        if (definition.endsRun?.(args)) execution.concludeTurn()
        return result
      },
    })
  }
}
