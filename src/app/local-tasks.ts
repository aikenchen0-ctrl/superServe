import { createHash } from 'node:crypto'
import { z } from 'zod'
import { key, latestAssignment, liveTicket, runningAssignment, type Assignment, type Engine, type Ticket } from '../core/index.ts'
import { HMM_LIMITS, HmmError, PlanSchema, RunSchema } from '../hmm/model.ts'
import { hasManualRunningNode, planHash, type HmmWorkflows } from '../hmm/workflow.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'
import type { Sessions } from './sessions.ts'
import { LocalTaskListSchema } from './task-list.ts'
import { LocalTaskQuestionSchema } from './task-question.ts'
export { LocalTaskListSchema, type LocalTaskListQuery } from './task-list.ts'

const identity = {
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  title: z.string().trim().min(1).max(160).optional(),
}
const creation = { ...identity, dispatch: z.boolean().default(true) }
export const LocalTaskSchema = z.union([
  z.object({ ...creation, goal: RunSchema.shape.goal, plan: PlanSchema.omit({ goal: true }) }).strict(),
  RunSchema.extend(creation).strict(),
])
export type LocalTaskInput = z.input<typeof LocalTaskSchema>
export const LOCAL_TASK_INPUT_LIMITS = { messages: 64, chars: 4000, bytes: 256 * 1024 } as const
export const LocalTaskContextSchema = z.object({
  requestId: identity.requestId,
  text: z.string().trim().min(1).max(LOCAL_TASK_INPUT_LIMITS.chars),
  questionId: z.string().min(1).max(128).optional(),
}).strict()
export type LocalTaskContextInput = z.input<typeof LocalTaskContextSchema>
export const LocalTaskDiscussionSchema = z.object({ requestId: identity.requestId }).strict()
export type LocalTaskDiscussionInput = z.input<typeof LocalTaskDiscussionSchema>
export const LocalTaskResumeSchema = z.object({
  revision: z.number().int().positive(),
  nodeId: PlanSchema.shape.nodes.element.shape.id,
}).strict()
export type LocalTaskResumeInput = z.input<typeof LocalTaskResumeSchema>
export const LocalTaskBlockersSchema = z.object({
  revision: z.coerce.number().int().positive(),
  offset: z.coerce.number().int().min(0).max(HMM_LIMITS.nodes),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type LocalTaskBlockersQuery = z.output<typeof LocalTaskBlockersSchema>
export const LocalTaskResultSourcesSchema = LocalTaskBlockersSchema.omit({ snapshot: true })
export type LocalTaskResultSourcesQuery = z.output<typeof LocalTaskResultSourcesSchema>
export const LocalTaskPlanVersionSchema = z.object({ planVersion: z.coerce.number().int().positive() }).strict()
export type LocalTaskPlanVersionQuery = z.output<typeof LocalTaskPlanVersionSchema>
/** 管理端只读显示状态，不是新的计划或节点状态，也不控制执行。 */
export type LocalTaskActivity = 'ended' | 'running' | 'paused' | 'held' | 'review' | 'attention' | 'waiting'
type LocalTaskAttentionReason = 'reference_invalid' | 'dependency_blocked' | 'suspended' | 'plan_review'
const blockerLimit = 4
const resumeProblems = {
  parent_suspended: '所属分组仍挂起，请在总管对话核对后恢复分组',
  attempts_exhausted: '节点执行次数达到上限，请重新评估计划',
  manual_running: '请先结束或挂起手动执行的节点',
} as const
type WorkflowView = ReturnType<HmmWorkflows['view']>
type ActivityFacts = ReturnType<HmmWorkflows['activity']>

/** 列表与详情共用同一判定；暂停派发不抹去仍在运行的事实，终态不等于结果仍有效。 */
function taskActivity(facts: ActivityFacts, ended: boolean, paused: boolean, needsAnswer: boolean): LocalTaskActivity {
  if (ended) return 'ended'
  if (facts.running) return 'running'
  if (paused) return 'paused'
  if (needsAnswer || facts.referenceInvalid) return 'attention'
  if (facts.awaitingValidation) return 'review'
  if (facts.terminal) return 'attention'
  if (!facts.autoRun) return 'held'
  if (facts.suspended || facts.dependencyBlocked) return 'attention'
  return 'waiting'
}

/** 查询与本地恢复入口共用条件；派发仍须通过领域检查，不保证恢复后立即执行。 */
function resumeBlocker(workflow: WorkflowView, node: WorkflowView['nodes'][number]): keyof typeof resumeProblems | null {
  for (let parentId = node.parentId; parentId; ) {
    const parent = workflow.nodes.find(item => item.id === parentId)!
    if (parent.state === 'suspended') return 'parent_suspended'
    parentId = parent.parentId
  }
  if (node.attempt >= HMM_LIMITS.attempts) return 'attempts_exhausted'
  if (hasManualRunningNode(workflow.nodes)) return 'manual_running'
  return null
}

/** 仅向可信本地面板补充有界步骤名称；不携带指令或上下文正文。 */
function stepTitle(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim())
  return chars.length > 48 ? chars.slice(0, 47).join('') + '…' : chars.join('')
}

/** 回执只是有界显示投影，截断不改变已保存原话，且不拆分 Unicode 码点。 */
function receiptText(text: string, limit: number) {
  const chars = Array.from(text)
  const truncated = chars.length > limit
  return { text: truncated ? chars.slice(0, limit - 1).join('') + '…' : text, truncated }
}

/** 摘要、分页与恢复回执共用投影，不复制指令、工作帧或授权。 */
function blockerItems(workflow: WorkflowView) {
  return workflow.nodes.filter(node => node.mode === 'task' && node.state === 'suspended').map(node => ({ nodeId: node.id, title: stepTitle(node.title),
    resume: resumeBlocker(workflow, node) ?? 'available',
    ...(node.modelFailureCode ? { modelFailureCode: node.modelFailureCode } : {}),
    reason: Array.from((node.reason ?? '暂停原因未记录').replace(/\s+/g, ' ')).slice(0, 160).join('') }))
}

/** 只读标识覆盖完整有序投影及计划、输入边界；不作为权限或执行版本，也不持久化。 */
function blockerSnapshot(workflow: WorkflowView, items: ReturnType<typeof blockerItems>) {
  return createHash('sha256')
    .update(JSON.stringify([workflow.ticketId, workflow.planVersion, workflow.inputVersion, items])).digest('hex')
}

/** 每页固定预算；首屏与后续页绑定完整投影。 */
function blockerPage(workflow: WorkflowView, offset: number) {
  const all = blockerItems(workflow), snapshot = blockerSnapshot(workflow, all)
  const items = all.slice(offset, offset + blockerLimit)
  return { revision: workflow.revision, snapshot, total: all.length,
    requiresOrchestrator: all.some(item => item.resume !== 'available'), items,
    nextOffset: offset + items.length < all.length ? offset + items.length : null }
}
const inputPrefix = 'local-input:'
interface Host {
  store: Store
  engine: Pick<Engine, 'createLocalTask' | 'assignmentStarted' | 'inputsDelivered' | 'report' | 'note' | 'stopTicket'>
  hmm: HmmWorkflows
  effects: Pick<Effects, 'enqueue'>
  sessions: Pick<Sessions, 'taskContext'>
  available(): boolean
  hasExecutionCapacity(ticketId: string, maxActive: number): boolean
}
const controller = { role: 'controller' as const }

/** 将可信本地目标接入既有工单和 HMM，不创建仓库目录或额外执行会话。 */
export class LocalTasks {
  constructor(private readonly host: Host) {}

  private requireLocal(ticketId: string): Ticket {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) throw new HmmError('ticket_missing', '工单不存在', 404)
    if (ticket.executionMode !== 'hmm' || ticket.mandate.actor.source !== 'local' || ticket.mandate.basis.via !== 'operator')
      throw new HmmError('scope_denied', '此入口仅适用于本地 HMM 任务', 403)
    return ticket
  }

  /** 游标只定位历史边界，不赋予访问其他来源工单的权限，也不冻结后续状态。 */
  list(input: unknown = {}) {
    const { state, before, limit, q, preview, attention } = LocalTaskListSchema.parse(input)
    const { store, hmm } = this.host
    return store.atomic(() => {
      if (before) this.requireLocal(before)
      const rows = store.read.localTasks(state, before, limit + 1, q, preview)
      const paused = store.settings().paused
      const items = rows.slice(0, limit).map(row => {
        let activity: LocalTaskActivity | 'unknown'
        let attentionReason: LocalTaskAttentionReason | undefined
        let resultAvailability: 'unavailable' | 'unknown' | undefined
        if (row.ended) {
          activity = 'ended'
          if (row.ended.outcome === 'completed') {
            try { hmm.assertResultAvailable(controller, row.ticketId) }
            catch (error) {
              if (!(error instanceof HmmError)) throw error
              resultAvailability = ['workflow_missing', 'schema_unsupported'].includes(error.code) ? 'unknown' : 'unavailable'
            }
          }
        }
        else {
          try {
            const facts = hmm.activity(controller, row.ticketId)
            activity = taskActivity(facts, false, paused, row.needsAnswer)
            // 仅解释已有的需要处理状态；展示一个已知事实，不推断唯一根因或执行许可。
            if (activity === 'attention' && !row.needsAnswer)
              attentionReason = facts.referenceInvalid ? 'reference_invalid' : facts.terminal ? 'plan_review'
                : facts.dependencyBlocked ? 'dependency_blocked' : facts.suspended ? 'suspended' : undefined
          }
          catch (error) {
            // 缺计划或跨版本数据仍须能被用户发现；数据库故障等其他错误继续报告。
            if (!(error instanceof HmmError) || !['workflow_missing', 'schema_unsupported'].includes(error.code)) throw error
            activity = 'unknown'
          }
        }
        return { ...row, activity, ...(attentionReason ? { attentionReason } : {}),
          ...(resultAvailability ? { resultAvailability } : {}) }
      })
      return { items, nextBefore: rows.length > limit ? items.at(-1)!.ticketId : null,
        ...(attention === 'questions' ? { hasQuestions: store.read.localQuestionsAvailable(q) } : {}) }
    })
  }

  /** 页码绑定只读快照；旧客户端继续按任务版本检查，任何读取都不授予执行许可。 */
  blockers(ticketId: string, input: unknown) {
    const { revision, offset, snapshot } = LocalTaskBlockersSchema.parse(input)
    return this.host.store.atomic(() => {
      this.requireLocal(ticketId)
      const workflow = this.host.hmm.view(controller, ticketId)
      const page = blockerPage(workflow, offset)
      if (snapshot ? snapshot !== page.snapshot : workflow.revision !== revision)
        throw new HmmError('revision_conflict', '计划已更新，请重新读取后查看挂起步骤', 409)
      return page
    })
  }

  /** 完整目标仅按需读取；绑定定义版本，不因无关节点推进而失效，也不返回计划正文。 */
  goal(ticketId: string, input: unknown) {
    const { planVersion } = LocalTaskPlanVersionSchema.parse(input)
    return this.host.store.atomic(() => {
      this.requireLocal(ticketId)
      const workflow = this.host.hmm.view(controller, ticketId)
      if (workflow.planVersion !== planVersion)
        throw new HmmError('revision_conflict', '任务目标所属计划已更新，请重新读取后核对', 409)
      return { ticketId, planVersion: workflow.planVersion, text: workflow.goal }
    })
  }

  /** 最近修订是已发生的定义变更；仅取有界名称，不返回完整节点、执行指令或授权。 */
  planChange(ticketId: string, input: unknown) {
    const { planVersion } = LocalTaskPlanVersionSchema.parse(input)
    return this.host.store.atomic(() => {
      this.requireLocal(ticketId)
      const workflow = this.host.hmm.view(controller, ticketId)
      if (workflow.planVersion !== planVersion)
        throw new HmmError('revision_conflict', '计划已再次调整，请重新读取后核对', 409)
      const change = workflow.lastPlanRevision
      if (!change) throw new HmmError('plan_change_unavailable', '当前计划没有修订记录', 409)
      const items = change.invalidated.flatMap(id => {
        const node = workflow.nodes.find(node => node.id === id)
        return node ? [stepTitle(node.title)] : []
      }).slice(0, blockerLimit)
      const summary = { ticketId, planVersion: workflow.planVersion, at: change.at, reason: change.reason,
        added: change.added.length, removed: change.removed.length,
        changed: change.changed.length, affected: change.invalidated.length,
        affectedSteps: { items, omitted: change.invalidated.length - items.length } }
      // 保留完整修订原因和既有字节预算，极端转义名称只减少列出数量，不截断 JSON。
      while (items.length && Buffer.byteLength(JSON.stringify(summary), 'utf8') >= 4096) {
        items.pop()
        summary.affectedSteps.omitted++
      }
      return summary
    })
  }

  /** 只读返回当前验收直接采用的步骤成果节选；不展开指令、原文或完整引用图。 */
  resultSources(ticketId: string, input: unknown) {
    const { revision, offset } = LocalTaskResultSourcesSchema.parse(input)
    const { store, hmm } = this.host
    return store.atomic(() => {
      const ticket = this.requireLocal(ticketId), workflow = hmm.view(controller, ticketId)
      if (workflow.revision !== revision)
        throw new HmmError('revision_conflict', '结果已更新，请重新读取后核对验收依据', 409)
      if (ticket.ended?.outcome !== 'completed' || workflow.phase !== 'validated' || !workflow.validation)
        throw new HmmError('result_unavailable', '当前没有可核对的验收结果', 409)
      hmm.assertReady(ticketId)
      const refs = [...new Set(workflow.validation.evidenceRefs)]
      const items = refs.slice(offset, offset + blockerLimit).map(ref => {
        const node = workflow.nodes.find(item => item.resultRef === ref)!
        const result = hmm.context(controller, ticketId, node.id).result!
        return { nodeId: node.id, title: stepTitle(node.title), summary: receiptText(result.summary, 160) }
      })
      return { ticketId, revision: workflow.revision, offset, total: refs.length, items,
        nextOffset: offset + items.length < refs.length ? offset + items.length : null }
    })
  }

  /** 状态、结果和最近回答及补充节选读取同一快照；不携带计划指令、会话或知识授权。 */
  status(ticketId: string) {
    const { store, hmm } = this.host
    return store.atomic(() => {
      const ticket = this.requireLocal(ticketId)
      const workflow = hmm.view(controller, ticketId)
      const progress = { total: 0, pending: 0, running: 0, completed: 0, suspended: 0, pruned: 0 }
      const runningSteps: { nodeId: string; title: string }[] = []
      for (const node of workflow.nodes) {
        if (node.mode !== 'task') continue
        progress.total++; progress[node.state]++
        // 摘要与计数来自同一快照；分组和执行会话不成为额外的业务步骤。
        if (node.state === 'running' && runningSteps.length < blockerLimit)
          runningSteps.push({ nodeId: node.id, title: stepTitle(node.title) })
      }
      const blockers = blockerPage(workflow, 0)
      const dispatchBlocker = hasManualRunningNode(workflow.nodes) ? 'manual_running' as const : undefined
      const dependencyBlocked = workflow.nodes.filter(node => node.blockedBy?.length)
      const ended = ticket.ended
      const paused = store.settings().paused
      const answered = ticket.inputs.findLast(input => input.kind === 'note' && input.id.startsWith(inputPrefix) && input.answerTo)
      const lastAnswer = answered?.kind === 'note' && answered.answerTo ? {
        inputId: answered.id, at: answered.at,
        question: receiptText(answered.answerTo.question, 80), answer: receiptText(answered.text, 160),
      } : undefined
      const supplemented = ticket.inputs.findLast(input =>
        input.kind === 'note' && input.id.startsWith(inputPrefix) && !input.answerTo)
      const lastContext = supplemented?.kind === 'note' ? {
        inputId: supplemented.id, at: supplemented.at, ...receiptText(supplemented.text, 160),
      } : undefined
      let result: { summary: string; evidenceRefs: string[]; sourceCount?: number } | null = null
      let resultError: string | null = null
      if (ended?.outcome === 'completed') {
        try {
          // 与目录复用当前交付检查；缺少验收也须显式说明，不能静默保留历史完成。
          hmm.assertResultAvailable(controller, ticketId)
          const validation = workflow.validation!
          result = { summary: validation.summary, evidenceRefs: validation.evidenceRefs,
            sourceCount: new Set(validation.evidenceRefs).size }
        } catch (error) {
          if (!(error instanceof HmmError)) throw error
          resultError = error.code
        }
      }
      const activity = taskActivity({
        running: progress.running > 0, terminal: progress.completed + progress.pruned === progress.total,
        suspended: blockers.total > 0, autoRun: workflow.autoRun, awaitingValidation: workflow.awaitingValidation,
        referenceInvalid: workflow.referenceIntegrity === 'invalid', dependencyBlocked: dependencyBlocked.length > 0,
      }, !!ended, paused, !!ticket.attention)
      const requiresOrchestrator = workflow.awaitingValidation || workflow.referenceIntegrity === 'invalid'
        || !!resultError || !!dispatchBlocker || blockers.requiresOrchestrator || dependencyBlocked.length > 0
        || ticket.undelivered.length > 0
        || !!ticket.attention
        || (!ended && progress.total > 0 && progress.completed + progress.pruned === progress.total && !result)
      const planReviewRequired = !ended && progress.total > 0 && progress.pruned === progress.total
      // 只解释健康的自动等待，不以容量覆盖待回答、依赖或成果问题，也不把读取变成派工。
      const waitingFor = activity === 'waiting' && !requiresOrchestrator && this.host.available()
        && workflow.runnable.some(nodeId => workflow.nodes.some(node => node.id === nodeId && node.attempt < HMM_LIMITS.attempts))
        && !this.host.hasExecutionCapacity(ticketId, workflow.maxActive) ? 'capacity' as const : undefined
      return {
        ticketId, title: ticket.title, paused, activity,
        goalAvailable: workflow.goal !== ticket.title,
        question: ticket.attention ? { id: ticket.attention.id, text: ticket.attention.question,
          ...(ticket.attention.choices ? { choices: ticket.attention.choices } : {}) } : null,
        ended: ended ? { at: ended.at, by: ended.by, outcome: ended.outcome } : null,
        workflow: { revision: workflow.revision, planVersion: workflow.planVersion, phase: workflow.phase,
          planChangeAvailable: !!workflow.lastPlanRevision,
          initialMode: workflow.initialMode ?? 'multi',
          autoRun: workflow.autoRun, awaitingValidation: workflow.awaitingValidation, progress,
          ...(dispatchBlocker ? { dispatchBlocker } : {}),
          runningSteps: { total: progress.running, omitted: progress.running - runningSteps.length, items: runningSteps },
          referenceIntegrity: workflow.referenceIntegrity, requiresOrchestrator, planReviewRequired,
          ...(waitingFor ? { waitingFor } : {}),
          blockers: { snapshot: blockers.snapshot, total: blockers.total, requiresOrchestrator: blockers.requiresOrchestrator,
            omitted: Math.max(0, blockers.total - blockers.items.length), items: blockers.items },
          dependencyBlockers: { total: dependencyBlocked.length, omitted: Math.max(0, dependencyBlocked.length - blockerLimit),
            items: dependencyBlocked.slice(0, blockerLimit).map(node => ({ nodeId: node.id, title: stepTitle(node.title),
              blockedBy: node.blockedBy!.slice(0, blockerLimit),
              omittedDependencies: Math.max(0, node.blockedBy!.length - blockerLimit) })) } },
        inputs: { total: ticket.inputs.length, pendingDelivery: ticket.undelivered.length },
        ...(lastAnswer ? { lastAnswer } : {}),
        ...(lastContext ? { lastContext } : {}),
        result, resultError,
      }
    })
  }

  /** 请求编号按本地部署去重；工单、计划和可选调度效果共同提交或回滚。 */
  create(input: unknown) {
    const args = LocalTaskSchema.parse(input)
    const title = args.title ?? args.goal.slice(0, 160)
    const { store, engine, hmm } = this.host
    return store.atomic(() => {
      const previous = store.tickets.get(key('local-task', args.requestId))
      if (previous && (previous.executionMode !== 'hmm' || previous.title !== title || previous.mandate.scope !== args.goal))
        throw new HmmError('request_conflict', '请求编号已用于其他目标或标题', 409)
      if (previous) {
        const initial = hmm.view(controller, previous.id)
        const matches = 'plan' in args
          ? initial.initialMode === 'custom' && initial.initialPlanHash === planHash({ goal: args.goal, ...args.plan })
          : (initial.initialMode ?? 'multi') === args.mode
        if (!matches || (initial.initialDispatch ?? true) !== args.dispatch)
          throw new HmmError('request_conflict', '请求编号已用于其他初始派发方式、执行路径或计划', 409)
      }
      if (!previous) {
        if (!this.host.available()) throw new HmmError('runtime_unavailable', '运行环境尚未就绪或正在关闭', 409)
        if (store.settings().paused) throw new HmmError('paused', '处理已暂停，请恢复后提交目标', 409)
        const ticket = engine.createLocalTask({ requestId: args.requestId, title, goal: args.goal })
        const options = { dispatch: args.dispatch }
        if ('plan' in args) hmm.runPlan(controller, ticket.id, { goal: args.goal, ...args.plan }, options)
        else hmm.run(controller, ticket.id, { goal: args.goal, mode: args.mode }, options)
      }
      const ticket = store.tickets.get(key('local-task', args.requestId))!
      return { ticketId: ticket.id, created: !previous, ended: ticket.ended ?? null, workflow: hmm.view(controller, ticket.id) }
    })
  }

  /** 补充信息只作为上下文；输入与通知共用事务，重复请求不追加正文或重复通知。 */
  input(ticketId: string, input: unknown) {
    const args = LocalTaskContextSchema.parse(input)
    const { store, engine } = this.host
    const inputId = inputPrefix + key(ticketId, args.requestId)
    return store.atomic(() => {
      const ticket = this.requireLocal(ticketId)
      const previous = ticket.inputs.find(item => item.id === inputId)
      if (previous) {
        if (previous.kind !== 'note' || previous.text !== args.text || previous.answerTo?.id !== args.questionId)
          throw new HmmError('request_conflict', '请求编号已用于其他补充信息', 409)
        return { ticketId, inputId, created: false }
      }
      if (!liveTicket(ticket)) throw new HmmError('ticket_inactive', '任务已结束，请创建新任务', 409)
      if (!this.host.available()) throw new HmmError('runtime_unavailable', '运行环境尚未就绪或正在关闭', 409)
      if (args.questionId && ticket.attention?.id !== args.questionId) {
        const answered = ticket.inputs.some(item => item.kind === 'note' && item.answerTo?.id === args.questionId)
        if (answered) throw new HmmError('question_conflict',
          '此问题已保存过回答，本次修改未保存；请核对当前任务，需要补充时使用补充上下文', 409)
        throw new HmmError('question_conflict', '问题已更新，请核对当前问题后重新回答', 409)
      }
      const notes = ticket.inputs.flatMap(item => item.kind === 'note' && item.id.startsWith(inputPrefix) ? [item] : [])
      const bytes = notes.reduce((total, input) => total + Buffer.byteLength(input.text, 'utf8')
        + Buffer.byteLength(input.answerTo ? JSON.stringify(input.answerTo) : '', 'utf8'),
      Buffer.byteLength(args.text, 'utf8') + Buffer.byteLength(args.questionId ? JSON.stringify(ticket.attention) : '', 'utf8'))
      if (notes.length >= LOCAL_TASK_INPUT_LIMITS.messages || bytes > LOCAL_TASK_INPUT_LIMITS.bytes)
        throw new HmmError('input_budget_exceeded', '任务补充信息超过存储预算，请创建新任务', 409)
      // 全局暂停时仍可保存上下文，派发与权限由原状态机控制。
      const answerTo = args.questionId ? ticket.attention : undefined
      if (answerTo) engine.report(ticketId, { state: 'progress', summary: '已收到问题回答，等待总管核对', question: null })
      engine.note(ticketId, args.text, inputId, answerTo)
      return { ticketId, inputId, created: true }
    })
  }

  /** 一个任务只保留一个当前问题；暂停和提问共用事务，回答不等于恢复或验收。 */
  ask(ticketId: string, input: unknown) {
    const args = LocalTaskQuestionSchema.parse(input)
    if (args.question === null && args.choices !== undefined)
      throw new HmmError('question_invalid', '撤回问题时不能提供选项', 400)
    const { store, engine, hmm } = this.host
    return store.atomic(() => {
      const ticket = this.requireLocal(ticketId)
      if (!liveTicket(ticket)) throw new HmmError('ticket_inactive', '任务已结束，不能继续提问', 409)
      if (!this.host.available()) throw new HmmError('runtime_unavailable', '运行环境尚未就绪或正在关闭', 409)
      const view = hmm.view(controller, ticketId)
      if (view.revision !== args.revision) throw new HmmError('revision_conflict', '计划已更新，请重新读取后提问', 409)
      const choicesChanged = JSON.stringify(ticket.attention?.choices) !== JSON.stringify(args.choices)
      const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
      // 同一个待答问题已停止执行时，重复读取式提问不再推进修订或重复报告。
      // 仍先核对任务、运行环境和修订；若尚有执行，必须走原 hold 路径。
      if (args.question !== null && ticket.attention?.question === args.question && !choicesChanged
        && assignment && assignment.state !== 'ended'
        && view.phase === 'active' && !view.autoRun && !view.nodes.some(node => node.mode === 'task' && node.state === 'running'))
        return { ticketId, revision: view.revision, question: { id: ticket.attention.id, text: ticket.attention.question,
          ...(ticket.attention.choices ? { choices: [...ticket.attention.choices] } : {}) } }
      if (args.question !== null) hmm.apply(controller, ticketId, args.revision, { action: 'hold' })
      const updated = engine.report(ticketId, { state: 'progress', summary: args.question ? '等待用户回答' : '问题已撤回',
        question: args.question })
      if (updated.attention && (updated.attention.id !== ticket.attention?.id || choicesChanged)) {
        // 文字或选项变化都建立新身份，旧答案不能投向新版问题。
        updated.attention.id = key('hmm-question', ticketId, String(hmm.view(controller, ticketId).revision))
        if (args.choices) updated.attention.choices = [...args.choices]
        else delete updated.attention.choices
        store.tickets.save(updated)
      }
      return { ticketId, revision: hmm.view(controller, ticketId).revision,
        question: updated.attention ? { id: updated.attention.id, text: updated.attention.question,
          ...(updated.attention.choices ? { choices: updated.attention.choices } : {}) } : null }
    })
  }

  /** 人工选定的步骤恢复与派发共同提交；不恢复兄弟或分组，不修改依赖、权限及尝试预算。 */
  resume(ticketId: string, input: unknown) {
    const args = LocalTaskResumeSchema.parse(input)
    const { store, hmm } = this.host
    return store.atomic(() => {
      const ticket = this.requireLocal(ticketId)
      if (!liveTicket(ticket)) throw new HmmError('ticket_inactive', '任务已结束，请创建新任务', 409)
      if (!this.host.available()) throw new HmmError('runtime_unavailable', '运行环境尚未就绪或正在关闭', 409)
      if (store.settings().paused) throw new HmmError('paused', '全局处理已暂停，请恢复后继续任务', 409)
      const view = hmm.view(controller, ticketId)
      if (view.revision !== args.revision) throw new HmmError('revision_conflict', '计划已更新，请重新读取后决定是否继续', 409)
      const node = view.nodes.find(node => node.id === args.nodeId)
      if (!node) throw new HmmError('node_missing', '计划节点不存在', 404)
      if (node.mode !== 'task') throw new HmmError('task_node_required', '只能恢复明确选中的任务步骤')
      if (node.state !== 'suspended') throw new HmmError('not_suspended', '只有挂起节点可以恢复', 409)
      const blocker = resumeBlocker(view, node)
      if (blocker) throw new HmmError(blocker, resumeProblems[blocker], 409)
      const before = blockerItems(view)
      const resumed = hmm.apply(controller, ticketId, args.revision, { action: 'resume', nodeId: args.nodeId })
      hmm.apply(controller, ticketId, resumed.revision, { action: 'dispatch' })
      const status = this.status(ticketId)
      // 仅当删除选中项后的完整投影与实际结果一致，才允许面板沿用旧页；仍须校验执行版本。
      const continuedFrom = blockerSnapshot(view, before.filter(item => item.nodeId !== args.nodeId)) === status.workflow.blockers.snapshot
        ? blockerSnapshot(view, before) : undefined
      return { ...status, workflow: { ...status.workflow, blockers: { ...status.workflow.blockers,
        ...(continuedFrom ? { continuedFrom } : {}) } } }
    })
  }

  /** 只传递当前讨论的任务身份；不把打开会话解释成恢复、派发或新的任务请求。 */
  async discuss(ticketId: string, input: unknown) {
    const { requestId } = LocalTaskDiscussionSchema.parse(input)
    const authorize = () => {
      this.requireLocal(ticketId)
      if (!this.host.available()) throw new HmmError('runtime_unavailable', '运行环境尚未就绪或正在关闭', 409)
    }
    authorize()
    const target = await this.host.sessions.taskContext(ticketId, requestId, authorize)
    return { ticketId, sessionId: target.sessionId }
  }

  /** 停止整个任务，不绑定节点版本；暂停或启动未就绪不阻止撤销，重复请求保留既有终态。 */
  stop(ticketId: string) {
    return this.host.store.atomic(() => {
      this.requireLocal(ticketId)
      this.host.engine.stopTicket(ticketId)
      return this.status(ticketId)
    })
  }

  /** 逻辑派工只记录状态，实际会话由 HMM 调度器创建。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }

  /** 后续信息交给总管处理，不能静默改写运行中节点的目标或权限。 */
  deliver(ticket: Ticket, assignment: Assignment): void {
    if (!ticket.undelivered.length) return
    this.host.effects.enqueue('relay', key('local-task-inputs', assignment.id, ...ticket.undelivered), {
      text: JSON.stringify({ kind: 'hmm_task_inputs', ticket_id: ticket.id, input_ids: ticket.undelivered,
        read: `ticket/${ticket.id}/inputs`,
        instruction: '先读取新增上下文，再决定是否暂停或修订计划；信息送达不代表节点已读取，也不构成新增授权。' }),
    })
    this.host.engine.inputsDelivered(ticket.id, assignment.id, ticket.undelivered)
  }

  /** 验收结果就是本地任务的最终报告，不再等待不存在的仓库执行器。 */
  validated(ticketId: string): void {
    const workflow = this.host.hmm.view(controller, ticketId)
    if (workflow.phase !== 'validated' || !workflow.validation) throw new HmmError('not_validated', '任务尚未验收', 409)
    this.host.engine.report(ticketId, { state: 'ready', summary: workflow.validation.summary })
  }
}
