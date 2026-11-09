/*!
 * Copyright 2026 Fei2411 and the DS Bot contributors
 * SPDX-License-Identifier: Apache-2.0
 * writeCheckpoint 改编自 DS-Bot 固定提交 71d344bf 的 parts.js/writeCheckpoint。
 * 修改：仅服务当前 HMM 总管；复用 DSH 压缩事务和自动触发，不接管全局压缩方法；
 * 增加取消、输出预算、实例复核及受限原始历史读取。来源与许可见 NOTICE。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, type ContentBlock, type Message, type ToolSchema, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { CHECKPOINT_PROMPT, checkpointBody, checkpointCount, checkpointTail, checkpointText } from '../hmm/context-checkpoint.ts'
import { tool, type Tool } from '../app/tools/tool.ts'
import { until } from './background.ts'

interface SummaryInput { readonly messages: readonly Message[]; readonly tools?: readonly ToolSchema[] }
interface SummaryResult {
  summary: ContentBlock[]; rawOutput?: ContentBlock[]; llmStreamCall?: true
  provider: string; model: string; maxTokens?: number; usage?: TokenUsage
}
type Summarize = (input: SummaryInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>
interface SummaryEngine { summarize: Summarize }
interface Hook { original: Summarize; wrapper: Summarize; agents: Set<Agent> }
const HistorySchema = z.object({
  before_seq: z.number().int().nonnegative().optional(),
  seq: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().default(0),
}).strict().refine(args => args.seq === undefined ? args.offset === 0 : args.before_seq === undefined,
  '整页读取不接受文本偏移；单条读取不能同时指定翻页游标')
const SUMMARY_TIMEOUT_MS = 30_000
const SUMMARY_OUTPUT_TOKENS = 4096
const HISTORY_EVENTS = 128
const HISTORY_MESSAGES = 8

/** HMM 总管的 DSH 检查点适配器；原生引擎仍独占触发、配对校验、追加日志和压缩事务。 */
export class ControllerContext {
  private readonly hooks = new Map<SummaryEngine, Hook>()
  private readonly agents = new Set<Agent>()

  constructor(private readonly context: Context, private readonly lifetime: AbortSignal,
    private readonly current: (agent: Agent) => boolean) {}

  bind(agent: Agent): () => void {
    this.agents.add(agent)
    const presets = this.context.get('agentPresets') as { serviceFor?: (agent: Agent, name: string) => unknown } | undefined
    const candidate = presets?.serviceFor?.(agent, 'compaction') ?? agent.ctx.get('compaction')
    if (candidate && typeof (candidate as SummaryEngine).summarize === 'function') {
      const engine = candidate as SummaryEngine
      let hook = this.hooks.get(engine)
      if (!hook) {
        const original = engine.summarize
        const agents = new Set<Agent>()
        const owner = this
        const wrapper: Summarize = function (this: SummaryEngine, input, target, signal) {
          return agents.has(target) ? owner.summarize(input, target, signal) : original.call(this, input, target, signal)
        }
        hook = { original, wrapper, agents }
        this.hooks.set(engine, hook)
        engine.summarize = wrapper
      }
      hook.agents.add(agent)
    }
    return () => {
      this.agents.delete(agent)
      for (const [engine, hook] of this.hooks) {
        hook.agents.delete(agent)
        if (hook.agents.size) continue
        if (engine.summarize === hook.wrapper) engine.summarize = hook.original
        this.hooks.delete(engine)
      }
    }
  }

  private active(agent: Agent): boolean {
    return !this.lifetime.aborted && this.agents.has(agent) && this.current(agent)
      && this.context.agents.get(agent.id) === agent
  }
  private authorize(agent: Agent, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!this.active(agent)) throw new Error('总管上下文实例已失效')
  }
  private async summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const combined = AbortSignal.any([this.lifetime, AbortSignal.timeout(SUMMARY_TIMEOUT_MS), ...(signal ? [signal] : [])])
    this.authorize(agent, combined)
    const result = await until(this.writeCheckpoint(input, agent, combined), combined)
    this.authorize(agent, combined)
    if (!result) throw new Error('检查点生成已取消')
    return result
  }

  private async writeCheckpoint(input: SummaryInput, agent: Agent, signal: AbortSignal): Promise<SummaryResult> {
    const session = agent.session, route = session.requestHeader()?.config
    if (!route?.provider || !route.model) throw new Error('总管尚无可用于检查点的模型路由')
    const tail = checkpointTail(input.messages, session.deriveMessages())
    const prompt = tail.length ? `${CHECKPOINT_PROMPT}\n后面 ${tail.length} 条消息由宿主逐字保留。核对其已有回答，只摘要前面的区域，不复制这些消息。`
      : CHECKPOINT_PROMPT
    const maxTokens = Math.min(route.maxTokens ?? SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const assembler = new BlockAssembler()
    let receivedBytes = 0
    for await (const chunk of this.context.llm.stream({
      provider: route.provider, model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      messages: [...input.messages, ...tail, { role: 'user', content: [{ type: 'text', text: prompt }] }],
      toolHistory: session.toolHistory(), ...(input.tools ? { tools: [...input.tools] } : {}),
      maxTokens, sessionId: session.id, purpose: 'compaction', signal,
    })) {
      signal.throwIfAborted()
      receivedBytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8')
      if (receivedBytes > 128 * 1024) throw new Error('检查点响应超过接收预算')
      assembler.push(chunk)
    }
    this.authorize(agent, signal)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted' || finish.kind === 'max-tokens')
      throw new Error('检查点生成失败、取消或超过输出上限')
    const rawOutput = assembler.blocks()
    if (rawOutput.some(block => block.type === 'tool-call')) throw new Error('检查点不能包含待执行工具调用')
    const summary = rawOutput.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (!summary) throw new Error('检查点正文为空')
    return {
      summary: [{ type: 'text', text: checkpointText(checkpointCount(input.messages) + 1, summary, input.messages) }],
      rawOutput, llmStreamCall: true, provider: route.provider, model: route.model, maxTokens,
      ...(assembler.usage ? { usage: assembler.usage } : {}),
    }
  }

  /** 只读当前总管自己的原始用户和助手消息；不开放任意 Session、工具结果或请求头。 */
  historyTool(agent: Agent): Tool {
    return tool({
      name: 'hmm_history',
      description: '按需读取本总管保留的原始对话，包括被压缩的内容。默认每页最多 8 条节选；按 next_before_seq 向前翻页，null 表示结束。用 message_id 定位检查点 ref，再带 seq 和可选 offset 分页读取单条原文。不授予其他会话、工具结果或文件读取权限，不用于轮询。',
      schema: HistorySchema,
      execute: async (args, callerSignal) => {
        const signal = AbortSignal.any([callerSignal, this.lifetime, AbortSignal.timeout(15_000)])
        this.authorize(agent, signal)
        const end = agent.session.seq
        const before = args.seq === undefined ? args.before_seq ?? end : args.seq + 1
        if (before > end || (args.seq !== undefined && args.seq >= end)) throw new Error('历史位置超出当前总管日志范围')
        const start = args.seq ?? Math.max(0, before - HISTORY_EVENTS)
        await until(this.context.sessionPersistence.flush(), signal)
        this.authorize(agent, signal)
        const opening = this.context.sessionPersistence.open(agent.id, 'read')
        const opened = await until(opening, signal)
        if (!opened) {
          void opening.then(handle => handle[Symbol.asyncDispose]()).catch(() => {})
          this.authorize(agent, signal)
          throw new Error('历史打开已取消')
        }
        await using handle = opened
        const page = await until(handle.read(start, before - start, { signal }), signal)
        this.authorize(agent, signal)
        if (!page) throw new Error('历史读取已取消')
        if (page.events.length !== before - start || page.events.some((event, index) => event.seq !== start + index))
          throw new Error('历史日志返回不完整，请重新读取')
        const messages = page.events.filter(event => event.seq >= start && event.seq < before)
          .flatMap(event => {
            if ((event.type !== 'user/message' && event.type !== 'assistant/message') || event.surfaceOp !== 'append') return []
            const message = deriveEventMessage(event as SessionEvent)
            return message ? [{ event, message }] : []
          })
        if (args.seq !== undefined) {
          const seq = args.seq
          const selected = messages.find(item => item.event.seq === SessionSeq(seq))
          if (!selected) throw new Error('此历史位置不是可读取的原始对话消息')
          const text = checkpointBody(selected.message)
          if (args.offset > text.length) throw new Error('文本偏移超出原始消息范围')
          return { seq: args.seq, message_id: selected.message.id, role: selected.message.role,
            text: text.slice(args.offset, args.offset + 4000), chars: text.length,
            next_offset: args.offset + 4000 < text.length ? args.offset + 4000 : null,
            attachments: selected.message.content.filter(block => block.type === 'image' || block.type === 'file').map(block => block.type) }
        }
        const shown = messages.slice(-HISTORY_MESSAGES).reverse()
        const oldest = shown.at(-1)?.event.seq ?? start
        return { items: shown.map(({ event, message }) => ({
          seq: event.seq, message_id: message.id, role: message.role,
          text: checkpointBody(message).slice(0, 500), chars: checkpointBody(message).length,
        })), next_before_seq: oldest > 0 ? oldest : null }
      },
    })
  }
}
