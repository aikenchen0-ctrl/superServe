import { z } from 'zod'
import type { Repositories } from '../../core/index.ts'
import { HmmError, PlanRevisionSchema, PlanSchema } from '../../hmm/model.ts'
import { promptFile } from '../skill-files.ts'
import { LocalTaskListSchema } from '../task-list.ts'
import { LocalTaskQuestionSchema, type LocalTaskQuestionInput } from '../task-question.ts'
import { DevelopmentReadSchema, type DevelopmentReadInput } from '../../development/change-contracts.ts'
import { hmmTools, type HmmToolHost } from './hmm.ts'
import { knowledgeTool } from './knowledge.ts'
import { tool, type Tool } from './tool.ts'

export const HMM_CONTROLLER_PROMPT = promptFile('hmm-orchestrator')
const TaskListSchema = LocalTaskListSchema.omit({ preview: true, attention: true }).extend({ limit: z.number().int().min(1).max(8).default(8) })

export interface HmmControllerHost extends HmmToolHost {
  readonly store: { readonly tickets: Pick<Repositories['tickets'], 'get'> }
  /** 只接收本工具已通过范围检查的资源；会话及来源服务由组合根绑定。 */
  readResource(resource: string, offset: number, limit: number | undefined, signal: AbortSignal): Promise<unknown>
  readDevelopment(ticketId: string, query: DevelopmentReadInput): unknown
}

/** 本地总管只读取 HMM 工单及其有界输入，不继承仓库资源或设置修改工具。 */
export function hmmControllerTools(host: HmmControllerHost, tasks: {
  list(input: z.output<typeof TaskListSchema>): unknown
  ask(ticketId: string, input: LocalTaskQuestionInput): unknown
}): Tool[] {
  return [
    // 本地工单在接收目标时已建计划；总管只修订，不再暴露可重设目标和并发的创建入口。
    ...hmmTools(host).filter(tool => tool.name !== 'hmm_plan_create'),
    tool({
      name: 'hmm_development_read',
      description: '读取本地任务登记的开发意图。view=intent 查看固定起点、模块版本与验收；module 配 moduleId 读该意图绑定的模块原文；related 每页最多8条潜在关联，按 snapshot/nextOffset 翻页。revision 在 intent/module 指意图版本，在 related 指目录版本。关联不是冲突或兼容结论；声明不是授权，未捕获当前进度，不自动派发、合并或改验收。',
      schema: DevelopmentReadSchema.extend({ ticket_id: z.string().min(1).max(200) }),
      execute: async ({ ticket_id, ...query }, signal) => {
        signal.throwIfAborted()
        const ticket = host.store.tickets.get(ticket_id)
        if (!ticket || ticket.executionMode !== 'hmm' || ticket.mandate.actor.source !== 'local' || ticket.mandate.basis.via !== 'operator')
          throw new HmmError('scope_denied', '只能读取本地 HMM 任务的开发声明', 403)
        return host.readDevelopment(ticket_id, query)
      },
    }),
    tool({
      name: 'hmm_question',
      description: '需要用户补充时一次问一个具体问题，可带 2 至 4 个短 choices，用户仍可自由回答。ticket_id、revision 与 hmm_read 一致；提问原子暂停派发和在途节点。question=null 撤回且不带 choices，不恢复执行。回答由任务页保存并通知总管，须读取原话判断后显式继续；不是授权或验收。',
      schema: LocalTaskQuestionSchema.extend({ ticket_id: z.string().min(1).max(200) }),
      execute: async ({ ticket_id, ...input }, signal) => {
        signal.throwIfAborted()
        return tasks.ask(ticket_id, input)
      },
    }),
    tool({
      name: 'hmm_tasks',
      description: '按需发现本地 HMM 任务，默认列未结束任务，每页最多 8 条摘要。q 按名称字面子串搜索，最多 100 字符，不搜索正文。state 可选 open/needs_answer/ended/all；needsAnswer 只表示等待用户回答。将 nextBefore 原样作为 before 翻页，null 表示结束，翻页保留 q 与 state。取得 ticketId 后用 hmm_read 核对；目录不授予执行权限，不用于轮询。',
      schema: TaskListSchema,
      execute: async (args, signal) => {
        signal.throwIfAborted()
        return tasks.list(TaskListSchema.parse(args))
      },
    }),
    tool({
      name: 'hmm_plan_revise',
      description: '修订已有步骤：先 hmm_read(view=plan)，保留原目标、并发与必需核验。nodes 是完整候选树，可拆分、串并行分组或调整依赖。preview 默认 true，只返回影响；明确 preview=false 应用同一 revision，随后 dispatch。变更会撤销受影响结果和知识授权，不自动扩权或派发。',
      schema: z.object({
        ticket_id: z.string().min(1).max(200), revision: PlanRevisionSchema.shape.revision,
        nodes: PlanSchema.shape.nodes, reason: PlanRevisionSchema.shape.reason, preview: z.boolean().default(true),
      }).strict(),
      execute: async ({ ticket_id, revision, nodes, reason, preview }, signal) => {
        signal.throwIfAborted()
        const actor = { role: 'controller' as const }
        const current = host.hmm.definition(actor, ticket_id)
        if (current.revision !== revision) throw new HmmError('revision_conflict', '计划已更新，请重新读取后修订', 409)
        // 核验要求来自既有计划，不能通过删除节点或省略字段静默降级。
        const proposed = new Map(nodes.map(node => [node.id, node]))
        for (const node of current.plan.nodes) {
          const next = proposed.get(node.id)
          if ((node.evidenceRequired && !next?.evidenceRequired) || (node.claimsRequired && !next?.claimsRequired))
            throw new HmmError('verification_required', '模型修订不能删除或降低既有核验要求；需要本地操作者调整', 403)
        }
        return host.hmm.revise(actor, ticket_id, {
          revision, plan: { ...current.plan, nodes }, reason, preview,
        })
      },
    }),
    knowledgeTool(host),
    tool({
      name: 'orchestrator_read',
      description: '读取本地 HMM 工单：ticket/<id>、ticket/<id>/inputs、ticket/<id>/input/<input_id>、ticket/<id>/result。分页按 next_offset 继续，不提供文件、仓库或设置资源。',
      schema: z.object({ resource: z.string().min(1).max(500), offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(8000).optional() }).strict(),
      execute: async ({ resource, offset, limit }, signal) => {
        signal.throwIfAborted()
        const match = /^ticket\/([^/]+)(?:\/(?:inputs|result|input\/[^/]+))?$/.exec(resource)
        const ticket = match && host.store.tickets.get(match[1]!)
        if (!ticket || ticket.executionMode !== 'hmm') throw new HmmError('scope_denied', '只能读取本地 HMM 工单资源', 403)
        return host.readResource(resource, offset, limit, signal)
      },
    }),
  ]
}
