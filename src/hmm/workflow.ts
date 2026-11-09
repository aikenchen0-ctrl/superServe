import { createHash, randomUUID } from 'node:crypto'
import { liveTicket, waitsForPerson, type Ticket } from '../core/model.ts'
import { key } from '../core/ids.ts'
import type { Family, Key } from '../kv-key.ts'
import { HMM_KEYS } from './keys.ts'
import { CommandSchema, HMM_LIMITS, HmmError, PlanRevisionSchema, PlanSchema, RunSchema, type DependencyCycleLink, type HmmActor, type HmmBinding, type HmmNode, type HmmResult, type HmmWorkflow, type PlanSpec } from './model.ts'
import { assertEvidenceReady, assertReferences, assertResultClaims, claimReferenceStatus, evidenceCatalog, explicitDependencies, inputReference, invalidResultNodes, putEvidence, readEvidence, readResult,
  resultReference, visibleResults } from './evidence.ts'
import { DEVICE_LIMITS, DeviceGrantSchema, type DeviceSource } from './device-contracts.ts'
import { assertClaimsReviewed, claimGraph, claimReference, claimReviewStatus, pruneClaimReviews, resultReferences,
  reviewClaims, type HmmClaim } from './claims.ts'
import { ModelFailureCodeSchema, type ModelFailureCode } from './model-failure.ts'
import { recentMessages } from './handoff.ts'

/** 只声明领域实际使用的存储能力；宿主现有 Store 直接满足此接口。 */
interface Storage {
  /** 同步原子操作；嵌套调用失败时回滚对应写入。 */
  atomic<T>(operation: () => T): T
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  keys<V>(family: Family<V, never>): Key<V>[]
  tickets: {
    get(id: string): Ticket | undefined
    /** 返回未结束工单，按新到旧排序。 */
    open(): Ticket[]
  }
  settings(): { paused: boolean }
}
const terminal = (node: HmmNode) => node.state === 'completed' || node.state === 'pruned'
/** 派发、恢复和只读投影共用同一条件，避免把手动执行误认为自动会话。 */
export function hasManualRunningNode(nodes: readonly Pick<HmmNode, 'mode' | 'state' | 'sessionId'>[]) {
  return nodes.some(node => node.mode === 'task' && node.state === 'running' && !node.sessionId)
}
const sharedResult = (result: HmmResult | undefined) => {
  if (!result) return undefined
  const { claims, ...summary } = result
  return { ...summary, ...(claims ? { claimCount: claims.length } : {}) }
}
const children = (workflow: HmmWorkflow, id: string) => workflow.nodes.filter(node => node.parentId === id)
const fail = (code: string, message: string, status: HmmError['status'] = 400): never => { throw new HmmError(code, message, status) }
const nodeOf = (workflow: HmmWorkflow, id: string) => workflow.nodes.find(node => node.id === id)
  ?? fail('node_missing', '计划节点不存在', 404)
function ancestors(workflow: HmmWorkflow, node: HmmNode): HmmNode[] {
  const result: HmmNode[] = []
  while (node.parentId) { node = nodeOf(workflow, node.parentId); result.push(node) }
  return result
}
const subtree = (workflow: HmmWorkflow, id: string) =>
  workflow.nodes.filter(node => node.id === id || ancestors(workflow, node).some(parent => parent.id === id))
const planNode = (node: PlanSpec['nodes'][number]) => ({
  id: node.id, parentId: node.parentId, title: node.title, mode: node.mode, instruction: node.instruction,
  evidenceRequired: node.evidenceRequired ?? false, claimsRequired: node.claimsRequired ?? false, dependsOn: node.dependsOn,
  // 省略默认用途，保持旧计划与显式推理计划的身份一致。
  ...(node.purpose === 'survey' ? { purpose: node.purpose } : {}),
})
const planSnapshot = (workflow: PlanSpec) => ({
  goal: workflow.goal, maxActive: workflow.maxActive, nodes: workflow.nodes.map(planNode),
})
const skeletonOf = (spec: PlanSpec) => JSON.stringify({
  goal: spec.goal, nodes: spec.nodes.map(({ instruction: _, ...node }) => node),
})
export const planHash = (workflow: PlanSpec) => createHash('sha256').update(JSON.stringify(planSnapshot(workflow))).digest('hex')

/** 只支持同级显式依赖；串行组按声明顺序增加前置条件，连同显式依赖一起查环。 */
function checkTree(workflow: HmmWorkflow): void {
  const ids = new Set(workflow.nodes.map(node => node.id))
  if (ids.size !== workflow.nodes.length) fail('duplicate_node', '节点编号不能重复')
  const roots = workflow.nodes.filter(node => !node.parentId)
  if (roots.length !== 1 || roots[0]!.mode === 'task') fail('root_invalid', '计划必须有且只有一个分组根节点')
  for (const node of workflow.nodes) {
    const seen = new Set([node.id])
    let current = node
    while (current.parentId) {
      const parent = nodeOf(workflow, current.parentId)
      if (parent.mode === 'task' || seen.has(parent.id)) fail('parent_invalid', '父节点必须是分组，且嵌套关系不能成环')
      seen.add(parent.id); current = parent
      if (seen.size > HMM_LIMITS.depth) fail('depth_exceeded', '计划嵌套深度超出上限')
    }
    if (node.mode !== 'task' && !children(workflow, node.id).length) fail('empty_group', '分组必须至少包含一个节点')
    if (node.mode === 'task' && !node.instruction) fail('instruction_missing', '任务节点必须包含独立执行说明')
    if (node.mode !== 'task' && node.purpose === 'survey') fail('purpose_invalid', '调查用途只能设置在任务节点上')
    if (new Set(node.dependsOn).size !== node.dependsOn.length) fail('duplicate_dependency', '依赖编号不能重复')
    for (const id of node.dependsOn) {
      const dependency = nodeOf(workflow, id)
      if (id === node.id || !node.parentId || dependency.parentId !== node.parentId)
        fail('dependency_invalid', '显式依赖必须指向同级的其他节点')
    }
  }
  const done = new Set<string>(), visiting = new Map<string, number>(), links: DependencyCycleLink[] = []
  const visit = (node: HmmNode): void => {
    if (done.has(node.id)) return
    if (visiting.has(node.id))
      throw new HmmError('dependency_cycle', '显式依赖与串行顺序构成循环', 400, links.slice(visiting.get(node.id)!))
    visiting.set(node.id, links.length)
    const dependencies = new Map<string, { node: HmmNode; kind: DependencyCycleLink['kind'] }>()
    for (const dependency of prerequisites(workflow, node)) {
      const previous = dependencies.get(dependency.node.id)
      if (previous) previous.kind = 'both'
      else dependencies.set(dependency.node.id, { node: dependency.node, kind: dependency.explicit ? 'explicit' : 'serial' })
    }
    for (const dependency of dependencies.values()) {
      links.push({ nodeId: node.id, dependencyId: dependency.node.id, kind: dependency.kind })
      visit(dependency.node)
      links.pop()
    }
    visiting.delete(node.id); done.add(node.id)
  }
  workflow.nodes.forEach(visit)
}

function prerequisites(workflow: HmmWorkflow, node: HmmNode) {
  const result = node.dependsOn.map(id => ({ node: nodeOf(workflow, id), explicit: true }))
  if (node.parentId && nodeOf(workflow, node.parentId).mode === 'serial') {
    const siblings = children(workflow, node.parentId)
    result.push(...siblings.slice(0, siblings.findIndex(item => item.id === node.id)).map(node => ({ node, explicit: false })))
  }
  return result
}

/** 一个快照只核验一次；失效子结果同时使其所属分组不能作为有效前置产物。 */
function dependencyValidity(workflow: HmmWorkflow) {
  const invalidResults = new Set(invalidResultNodes(workflow))
  const unavailableDependencies = new Set([...invalidResults].flatMap(id =>
    [id, ...ancestors(workflow, nodeOf(workflow, id)).map(node => node.id)]))
  // 剪枝只阻断该节点；部分剪枝的分组仍可由剩余分支提供结果。
  for (const node of workflow.nodes) if (node.state === 'pruned') unavailableDependencies.add(node.id)
  return { invalidResults, unavailableDependencies }
}

function blockedBy(workflow: HmmWorkflow, node: HmmNode, unavailableDependencies: ReadonlySet<string>): string[] {
  if (node.mode !== 'task' || (node.state !== 'pending' && node.state !== 'running')) return []
  return explicitDependencies(workflow, node).filter(id => unavailableDependencies.has(id))
}

/** 暂不考虑已知的依赖阻断，检查其余执行条件；通知不能把普通等待当成新故障。 */
function readyExceptBlocked(workflow: HmmWorkflow, node: HmmNode, unavailableDependencies: ReadonlySet<string>): boolean {
  if (workflow.phase !== 'active' || node.mode !== 'task' || node.state !== 'pending') return false
  return [node, ...ancestors(workflow, node)].every(item =>
    item.state !== 'suspended' && item.state !== 'pruned' && prerequisites(workflow, item)
      .every(dependency => dependency.explicit
        ? dependency.node.state === 'completed' || unavailableDependencies.has(dependency.node.id)
        : terminal(dependency.node)))
}

function runnable(workflow: HmmWorkflow, node: HmmNode, unavailableDependencies: ReadonlySet<string>): boolean {
  return !blockedBy(workflow, node, unavailableDependencies).length && readyExceptBlocked(workflow, node, unavailableDependencies)
}

/** 待启动任务须满足其余条件；已运行任务即使耗尽启动额度，仍须报告提交依赖失效。 */
function dependencyBlocks(workflow: HmmWorkflow): Set<string> {
  if (!workflow.autoRun || workflow.phase !== 'active') return new Set()
  const { unavailableDependencies } = dependencyValidity(workflow)
  if (!unavailableDependencies.size) return new Set()
  return new Set(workflow.nodes.flatMap(node =>
    (node.state === 'running' || (node.attempt < HMM_LIMITS.attempts && readyExceptBlocked(workflow, node, unavailableDependencies)))
      ? blockedBy(workflow, node, unavailableDependencies).map(id => JSON.stringify([node.id, id])) : []))
}

function refresh(workflow: HmmWorkflow): void {
  const groups = workflow.nodes.filter(node => node.mode !== 'task')
    .sort((a, b) => ancestors(workflow, b).length - ancestors(workflow, a).length)
  for (const group of groups) {
    if (group.state === 'pruned' || group.state === 'suspended') continue
    const items = children(workflow, group.id)
    group.state = items.every(terminal) ? items.some(item => item.state === 'completed') ? 'completed' : 'pruned'
      : items.some(item => item.state === 'running') ? 'running' : 'pending'
  }
}
/** 重新核验撤销受影响结果及其依赖；已发布的结果可能被任意分支看到，采用保守失效范围。 */
function recheck(workflow: HmmWorkflow, nodeId: string, reason: string): string[] {
  const selected = nodeOf(workflow, nodeId)
  if (selected.state === 'pruned') fail('node_terminal', '剪枝节点不能重新核验，请建立新的计划', 409)
  const affected = new Set(subtree(workflow, nodeId).filter(node => node.state !== 'pruned').map(node => node.id))
  let changed = true
  while (changed) {
    changed = false
    const boundaries = new Set([...affected].flatMap(id => [id, ...ancestors(workflow, nodeOf(workflow, id)).map(node => node.id)]))
    const results = new Set(workflow.nodes.filter(node => affected.has(node.id) && node.result)
      .flatMap(node => [resultReference(workflow, node), ...(node.result!.claims ?? []).map(claim => claimReference(workflow, node, claim))]))
    const shared = workflow.published.some(id => affected.has(id))
    for (const node of workflow.nodes.filter(node => node.mode === 'task' && node.state !== 'pruned' && !affected.has(node.id))) {
      if (shared || (node.result && resultReferences(node.result).some(ref => results.has(ref)))
        || [node, ...ancestors(workflow, node)].some(item => prerequisites(workflow, item).some(dependency => boundaries.has(dependency.node.id)))) {
        affected.add(node.id); changed = true
      }
    }
  }
  if (workflow.nodes.some(node => affected.has(node.id) && node.mode === 'task' && node.attempt >= HMM_LIMITS.attempts))
    fail('attempts_exhausted', '受影响节点已达到执行次数上限，请建立新的计划', 409)
  for (const node of workflow.nodes.filter(node => affected.has(node.id))) {
    node.state = 'pending'; node.frame = ''; node.reason = reason; node.generation = randomUUID()
    delete node.result; delete node.lease; delete node.sessionId; delete node.modelFailureCode
  }
  workflow.published = workflow.published.filter(id => !affected.has(id))
  if (workflow.evidence) workflow.evidence.receipts = workflow.evidence.receipts.filter(receipt => !affected.has(receipt.nodeId))
  workflow.phase = 'active'; workflow.autoRun = false; delete workflow.validation
  return [...affected].filter(id => nodeOf(workflow, id).mode === 'task')
}
const reviewReady = (workflow: HmmWorkflow) => workflow.phase === 'active' && workflow.nodes.every(terminal)
  && workflow.nodes.some(node => node.mode === 'task' && node.state === 'completed')

/** 比较执行条件，并沿新旧依赖及实际引用传播失效；仅有顺序调整也可能改变就绪条件。 */
function revisionImpact(previous: HmmWorkflow, next: HmmWorkflow) {
  const before = new Map(previous.nodes.map(node => [node.id, node]))
  const after = new Map(next.nodes.map(node => [node.id, node]))
  const added = next.nodes.filter(node => !before.has(node.id)).map(node => node.id)
  const removed = previous.nodes.filter(node => !after.has(node.id)).map(node => node.id)
  const changed = next.nodes.filter(node => {
    const old = before.get(node.id)
    return old && (JSON.stringify(planNode(old)) !== JSON.stringify(planNode(node))
      || JSON.stringify(children(previous, node.id).map(item => item.id)) !== JSON.stringify(children(next, node.id).map(item => item.id)))
  }).map(node => node.id)
  const affected = new Set([...added, ...removed, ...changed])
  const contract = (workflow: HmmWorkflow, node: HmmNode) => JSON.stringify(
    [node, ...ancestors(workflow, node)].map(item => [planNode(item),
      prerequisites(workflow, item).map(dependency => [dependency.node.id, dependency.explicit])]))
  for (const node of next.nodes.filter(node => node.mode === 'task')) {
    const old = before.get(node.id)
    if (!old || contract(previous, old) !== contract(next, node)) affected.add(node.id)
  }
  // 运行中的会话已见过旧骨架，即使本节点说明未改，也不能继续写入新计划。
  for (const node of previous.nodes) {
    if (node.state === 'running' && node.mode === 'task') affected.add(node.id)
    if (previous.goal !== next.goal) affected.add(node.id)
  }
  let expanded = true
  while (expanded) {
    expanded = false
    const refs = new Set(previous.nodes.filter(node => affected.has(node.id) && node.result)
      .flatMap(node => [resultReference(previous, node), ...(node.result!.claims ?? []).map(claim => claimReference(previous, node, claim))]))
    const shared = previous.published.some(id => affected.has(id))
    for (const workflow of [previous, next]) {
      const boundaries = new Set(workflow.nodes.filter(node => affected.has(node.id))
        .flatMap(node => [node.id, ...ancestors(workflow, node).map(parent => parent.id)]))
      for (const node of workflow.nodes.filter(node => node.mode === 'task' && node.state !== 'pruned' && !affected.has(node.id))) {
        if (shared || (node.result && resultReferences(node.result).some(ref => refs.has(ref)))
          || [node, ...ancestors(workflow, node)].some(item => prerequisites(workflow, item)
            .some(dependency => boundaries.has(dependency.node.id)))) {
          affected.add(node.id); expanded = true
        }
      }
    }
  }
  return { added, removed, changed, affected,
    invalidated: next.nodes.filter(node => node.mode === 'task' && affected.has(node.id)).map(node => node.id) }
}

interface Signals {
  review?(ticketId: string, revision: number): void
  validated?(ticketId: string, revision: number): void
  changed?(): void
  dispatched?(ticketId: string): void
  dependencyBlocked?(ticketId: string, revision: number): void
  recoveryRequired?(ticketId: string, revision: number): void
  attention?(ticketId: string, nodeId: string, reason: string, revision: number, modelFailureCode?: ModelFailureCode): void
}

/** 工单内的确定性状态服务：当前快照有界持久化，修改与工单检查共用 SQLite 事务。 */
export class HmmWorkflows {
  constructor(private readonly store: Storage, private readonly now = () => new Date().toISOString(), private readonly signals: Signals = {}) {}

  private authorize(actor: HmmActor, ticketId: string, write = false, pausedStop = false): void {
    if ((actor.role === 'worker' || actor.role === 'node') && actor.ticketId !== ticketId) fail('scope_denied', '不能访问其他工单的计划', 403)
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return fail('ticket_missing', '工单不存在', 404)
    if (write && (!liveTicket(ticket) || (this.store.settings().paused && actor.role !== 'node' && !pausedStop)))
      fail('ticket_inactive', '工单已结束或调度已暂停', 409)
  }
  private load(ticketId: string): HmmWorkflow {
    const workflow = this.store.get(HMM_KEYS.workflow(ticketId))
    if (!workflow) return fail('workflow_missing', '工单尚未创建 HMM 计划', 404)
    if (workflow.schemaVersion !== 1) return fail('schema_unsupported', '不支持此 HMM 状态版本', 409)
    return workflow
  }
  private inputVersion(ticketId: string): string | undefined {
    const ticket = this.store.tickets.get(ticketId)
    // 输入只追加且编号去重；末条补充编号即可检测新增，绑定工单以防跨任务代用。
    const input = ticket?.executionMode === 'hmm' ? ticket.inputs.findLast(input => input.kind === 'note') : undefined
    return input ? key(ticketId, input.id) : undefined
  }
  private assertInputVersion(ticketId: string, version: string | undefined): void {
    if (version !== this.inputVersion(ticketId))
      fail('input_conflict', '补充信息已更新，请读取相关正文及最新输入版本后重新验收', 409)
  }
  private save(workflow: HmmWorkflow, action: string, actor: string, nodeId?: string): void {
    pruneClaimReviews(workflow)
    workflow.revision++
    workflow.history.push({ revision: workflow.revision, action, actor, at: this.now(), ...(nodeId ? { nodeId } : {}) })
    workflow.history = workflow.history.slice(-HMM_LIMITS.history)
    // 为停止和恢复事件预留空间，避免工作帧填满预算后反而阻塞取消。
    const budget = actor === 'host' ? HMM_LIMITS.bytes : HMM_LIMITS.bytes - 4096
    if (Buffer.byteLength(JSON.stringify(workflow), 'utf8') > budget) fail('state_too_large', '计划状态超过存储预算')
    let newlyBlocked = false
    if (this.signals.dependencyBlocked) {
      const blocks = dependencyBlocks(workflow)
      if (blocks.size) {
        // 在同一事务内比较持久快照，不跨写入缓存；重复派发或无关工作帧更新不会再次唤醒总管。
        const previous = this.store.get(HMM_KEYS.workflow(workflow.ticketId))
        const before = previous ? dependencyBlocks(previous) : new Set<string>()
        newlyBlocked = [...blocks].some(block => !before.has(block))
      }
    }
    this.store.set(HMM_KEYS.workflow(workflow.ticketId), workflow)
    this.signals.changed?.()
    if (newlyBlocked) this.signals.dependencyBlocked?.(workflow.ticketId, workflow.revision)
  }
  private controller(actor: HmmActor): void {
    if (actor.role !== 'controller') fail('controller_required', '此操作需要总管或本地管理端执行', 403)
  }
  create(actor: HmmActor, ticketId: string, input: unknown) {
    this.controller(actor)
    const spec = PlanSchema.parse(input)
    return this.store.atomic(() => {
      this.authorize(actor, ticketId, true)
      if (this.store.get(HMM_KEYS.workflow(ticketId))) fail('workflow_exists', '工单已有计划，请读取当前版本', 409)
      const workflow: HmmWorkflow = {
        schemaVersion: 1, ticketId, revision: 0, phase: 'active', goal: spec.goal, maxActive: spec.maxActive,
        planVersion: 1, retiredNodeIds: [],
        // 骨架只含结构和标题；各节点的执行说明、结果和工作记忆不进入共享前缀。
        skeleton: skeletonOf(spec),
        nodes: spec.nodes.map(node => ({ ...node, state: 'pending', frame: '', attempt: 0 })),
        published: [], history: [],
      }
      checkTree(workflow)
      this.save(workflow, 'create', actor.role)
      return this.view(actor, ticketId)
    })
  }
  /** 创建与可选派发共同提交；不派发时沿用待执行节点，供管理端先配置授权。 */
  run(actor: HmmActor, ticketId: string, input: unknown, options: { dispatch?: boolean } = {}) {
    this.controller(actor)
    const { goal, mode } = RunSchema.parse(input)
    return this.store.atomic(() => {
      const nodes = mode === 'single'
        ? [
            { id: 'root', title: '目标求解', mode: 'serial' as const },
            { id: 'solve', parentId: 'root', title: '直接处理',
              instruction: '直接完成目标，先区分事实、假设与未知，再给出结论或可执行结果。只使用已授权资料和工具；缺少必要条件时挂起并说明，不把假设当事实。提交结果及其依据，供总管验收。' },
          ]
        : [
            { id: 'root', title: '目标求解', mode: 'serial' as const },
            { id: 'analyze', parentId: 'root', title: '分析',
              instruction: '明确目标、现状、约束、验收标准和必要信息，区分事实、假设与未知。按需读取已授权资料，缺少必要信息时挂起并说明。提交可供下一步执行的简短任务说明。' },
            { id: 'execute', parentId: 'root', title: '执行', dependsOn: ['analyze'],
              instruction: '依据目标和分析结果完成当前可执行任务，只使用已授权工具与资料。提交成果和依据，不把假设当事实；若缺资料、权限或需要未提供的外部操作，挂起并说明，不声称已经完成。' },
            { id: 'evaluate', parentId: 'root', title: '评价', dependsOn: ['analyze', 'execute'],
              instruction: '按目标和分析中的验收标准检查执行成果，重点寻找遗漏、矛盾及无依据结论。提交是否达标、剩余问题与建议重做的最早步骤，并引用上游结果；评价完成不代表工单验收，最终由总管决定完成、暂停或重核。' },
          ]
      const created = this.create(actor, ticketId, {
        goal, maxActive: 1,
        nodes,
      })
      // 首次路径只用于重试一致性，后续修订不改写原请求语义。
      const workflow = this.load(ticketId)
      workflow.initialMode = mode
      if (options.dispatch === false) workflow.initialDispatch = false
      this.store.set(HMM_KEYS.workflow(ticketId), workflow)
      if (options.dispatch !== false) this.apply(actor, ticketId, created.revision, { action: 'dispatch' })
      return this.view(actor, ticketId)
    })
  }
  /** 完整计划与首次请求摘要在同一事务提交，不派发时不占节点执行槽。 */
  runPlan(actor: HmmActor, ticketId: string, input: unknown, options: { dispatch?: boolean } = {}) {
    this.controller(actor)
    const spec = PlanSchema.parse(input)
    return this.store.atomic(() => {
      const created = this.create(actor, ticketId, spec)
      const workflow = this.load(ticketId)
      workflow.initialMode = 'custom'
      workflow.initialPlanHash = planHash(spec)
      if (options.dispatch === false) workflow.initialDispatch = false
      this.store.set(HMM_KEYS.workflow(ticketId), workflow)
      if (options.dispatch !== false) this.apply(actor, ticketId, created.revision, { action: 'dispatch' })
      return this.view(actor, ticketId)
    })
  }
  /** 管理端读取可编辑定义；剪枝任务的说明已删除，修订时必须移除该节点。 */
  definition(actor: HmmActor, ticketId: string) {
    this.controller(actor); this.authorize(actor, ticketId)
    const workflow = this.load(ticketId)
    return { revision: workflow.revision, planVersion: workflow.planVersion ?? 1, plan: planSnapshot(workflow),
      retiredNodeIds: workflow.retiredNodeIds ?? [], prunedNodeIds: workflow.nodes.filter(node => node.state === 'pruned').map(node => node.id) }
  }
  /** 仅核对计划身份与当前执行版本，不返回指令、成果、会话或知识授权。 */
  planIdentity(actor: HmmActor, ticketId: string) {
    this.controller(actor); this.authorize(actor, ticketId)
    const workflow = this.load(ticketId)
    return { ticketId, revision: workflow.revision, planVersion: workflow.planVersion ?? 1, fingerprint: planHash(workflow) }
  }
  /** 先完整校验候选结构再原子替换；预览不写库、不取消执行，也不扩大模型工具权限。 */
  revise(actor: HmmActor, ticketId: string, input: unknown) {
    this.controller(actor)
    const request = PlanRevisionSchema.parse(input)
    return this.store.atomic(() => {
      this.authorize(actor, ticketId, true)
      const previous = this.load(ticketId)
      if (request.revision !== previous.revision) fail('revision_conflict', '计划已更新，请重新读取后修订', 409)
      const planVersion = (previous.planVersion ?? 1) + 1
      if (planVersion > HMM_LIMITS.planVersions) fail('plan_versions_exhausted', '计划修订次数达到上限，请重新评估任务范围', 409)
      const before = new Map(previous.nodes.map(node => [node.id, node]))
      const retired = new Set(previous.retiredNodeIds ?? [])
      const candidate: HmmWorkflow = {
        ...structuredClone(previous), goal: request.plan.goal, maxActive: request.plan.maxActive,
        skeleton: skeletonOf(request.plan), planVersion,
        nodes: request.plan.nodes.map(spec => {
          if (retired.has(spec.id)) fail('node_retired', '已删除的节点编号不能复用', 409)
          const old = before.get(spec.id)
          if (old?.state === 'pruned') fail('node_pruned', '修订计划必须移除已剪枝节点；新探索使用新编号', 409)
          if (old && (old.mode === 'task') !== (spec.mode === 'task'))
            fail('node_kind_changed', '任务与分组不能复用同一编号互换，请使用新编号', 409)
          return old ? { ...structuredClone(old), ...spec, parentId: spec.parentId, instruction: spec.instruction }
            : { ...spec, state: 'pending', frame: '', attempt: 0 }
        }),
      }
      checkTree(candidate)
      const beforeHash = planHash(previous), afterHash = planHash(candidate)
      if (beforeHash === afterHash) fail('plan_unchanged', '计划定义没有变化，无需修订', 409)
      const { affected, ...diff } = revisionImpact(previous, candidate)
      for (const id of diff.removed) retired.add(id)
      if (candidate.nodes.length + retired.size > HMM_LIMITS.nodes)
        fail('node_lifetime_limit', '工单生命周期内节点编号总量达到上限，不能通过删除重建绕过预算', 409)
      for (const node of candidate.nodes.filter(node => node.mode === 'task' && affected.has(node.id))) {
        if (node.attempt >= HMM_LIMITS.attempts) fail('attempts_exhausted', '受影响节点已用尽执行次数，修订不能重置重试预算', 409)
        node.state = 'pending'; node.frame = ''; node.reason = request.reason; node.generation = randomUUID()
        delete node.result; delete node.lease; delete node.sessionId; delete node.reconsiderWhen; delete node.modelFailureCode
      }
      candidate.retiredNodeIds = [...retired]
      candidate.published = candidate.published.filter(id => !affected.has(id))
      if (candidate.evidence) {
        candidate.evidence.receipts = candidate.evidence.receipts.filter(receipt => !affected.has(receipt.nodeId))
        for (const document of candidate.evidence.documents) {
          document.nodeIds = document.nodeIds.filter(id => !affected.has(id))
          if (!document.nodeIds.length) { delete document.text; document.revoked = true }
        }
      }
      for (const grant of candidate.deviceGrants ?? []) {
        if (!affected.has(grant.nodeId)) continue
        grant.revoked = true
        this.invalidateGrant(candidate, grant.id)
      }
      candidate.phase = 'active'; candidate.autoRun = false; delete candidate.validation
      candidate.lastPlanRevision = { ...diff, reason: request.reason, at: this.now(), beforeHash, afterHash }
      refresh(candidate); pruneClaimReviews(candidate)
      const history = [...candidate.history, { revision: candidate.revision + 1, action: 'revise', actor: actor.role, at: this.now() }]
        .slice(-HMM_LIMITS.history)
      const snapshotBytes = Buffer.byteLength(JSON.stringify({ ...candidate, revision: candidate.revision + 1, history }), 'utf8')
      if (snapshotBytes > HMM_LIMITS.bytes - 4096) fail('state_too_large', '修订后计划状态超过存储预算')
      if (!request.preview) {
        this.save(candidate, 'revise', actor.role)
        if (reviewReady(candidate)) this.signals.review?.(ticketId, candidate.revision)
      }
      return { ticketId, applied: !request.preview, revision: request.preview ? previous.revision : candidate.revision,
        planVersion: request.preview ? previous.planVersion ?? 1 : planVersion,
        candidatePlanVersion: planVersion, snapshotBytes, ...diff }
    })
  }
  /** 目录只取状态事实，不组装会话、工作帧、问题正文或产物目录；不修改领域状态。 */
  activity(actor: HmmActor, ticketId: string) {
    if (actor.role === 'node') fail('node_scope', '节点会话只能读取自己的工作上下文', 403)
    this.authorize(actor, ticketId)
    const workflow = this.load(ticketId)
    const validity = dependencyValidity(workflow)
    const tasks = workflow.nodes.filter(node => node.mode === 'task')
    return {
      running: tasks.some(node => node.state === 'running'),
      terminal: tasks.every(terminal),
      suspended: tasks.some(node => node.state === 'suspended'),
      autoRun: workflow.autoRun ?? false,
      awaitingValidation: reviewReady(workflow),
      referenceInvalid: validity.invalidResults.size > 0,
      dependencyBlocked: workflow.nodes.some(node => blockedBy(workflow, node, validity.unavailableDependencies).length > 0),
    }
  }
  view(actor: HmmActor, ticketId: string) {
    if (actor.role === 'node') fail('node_scope', '节点会话只能读取自己的工作上下文', 403)
    this.authorize(actor, ticketId)
    const workflow = this.load(ticketId)
    const attention = this.store.tickets.get(ticketId)?.attention
    const validity = dependencyValidity(workflow)
    return { ticketId, revision: workflow.revision, phase: workflow.phase, goal: workflow.goal, maxActive: workflow.maxActive,
      question: attention ? { id: attention.id, text: attention.question,
        ...(attention.choices ? { choices: attention.choices } : {}) } : null,
      initialMode: workflow.initialMode, initialPlanHash: workflow.initialPlanHash, initialDispatch: workflow.initialDispatch,
      inputVersion: this.inputVersion(ticketId),
      planVersion: workflow.planVersion ?? 1, lastPlanRevision: workflow.lastPlanRevision,
      autoRun: workflow.autoRun ?? false,
      referenceIntegrity: validity.invalidResults.size ? 'invalid' as const : 'valid' as const,
      claimReviews: claimReviewStatus(workflow),
      awaitingValidation: reviewReady(workflow),
      nodes: workflow.nodes.map(node => {
        const { id, parentId, title, mode, dependsOn, state, attempt, reason, modelFailureCode, reconsiderWhen, sessionId, evidenceRequired, claimsRequired } = node
        const blocked = blockedBy(workflow, node, validity.unavailableDependencies)
        return { id, parentId, title, mode, dependsOn, state, attempt, reason, reconsiderWhen, sessionId,
          ...(node.purpose === 'survey' ? { purpose: node.purpose } : {}),
          ...(blocked.length ? { blockedBy: blocked } : {}),
          ...(validity.invalidResults.has(id) ? { referenceIntegrity: 'invalid' as const } : {}),
          ...(modelFailureCode ? { modelFailureCode } : {}),
          evidenceRequired: evidenceRequired ?? false, claimsRequired: claimsRequired ?? false,
          ...(node.result ? { resultRef: resultReference(workflow, node) } : {}) }
      }),
      runnable: workflow.nodes.filter(node => runnable(workflow, node, validity.unavailableDependencies)).map(node => node.id),
      published: workflow.published, validation: workflow.validation, history: workflow.history,
      deviceGrants: workflow.deviceGrants ?? [] }
  }
  /** 总管按需重建交接视图；业务快照与近期原话共读，不把旧对话或兄弟工作帧注入节点。 */
  handoff(actor: HmmActor, ticketId: string) {
    this.controller(actor)
    return this.store.atomic(() => {
      const view = this.view(actor, ticketId), workflow = this.load(ticketId)
      const ticket = this.store.tickets.get(ticketId)!
      return { ticketId, revision: view.revision, planVersion: view.planVersion, goal: view.goal,
        phase: view.phase, autoRun: view.autoRun, paused: this.store.settings().paused,
        ended: ticket.ended ? { at: ticket.ended.at, by: ticket.ended.by, outcome: ticket.ended.outcome } : null,
        inputVersion: view.inputVersion, awaitingValidation: view.awaitingValidation, question: view.question,
        referenceIntegrity: view.referenceIntegrity,
        nodes: view.nodes.filter(node => node.mode === 'task').map(node => ({
          nodeId: node.id, state: node.state, attempt: node.attempt, resultRef: node.resultRef,
          checkpointAvailable: !!nodeOf(workflow, node.id).frame,
          ...(node.reason ? { reason: node.reason } : {}),
          ...(node.modelFailureCode ? { modelFailureCode: node.modelFailureCode } : {}),
          ...(node.blockedBy ? { blockedBy: node.blockedBy } : {}),
          ...(node.referenceIntegrity ? { referenceIntegrity: node.referenceIntegrity } : {}),
        })),
        inputs: recentMessages(ticket.inputs.flatMap(input => input.kind === 'note'
          ? [{ ref: `ticket/${ticketId}/input/${input.id}`, text: input.text }] : [])),
        inputsRead: `ticket/${ticketId}/inputs`,
      }
    })
  }
  context(actor: HmmActor, ticketId: string, nodeId: string) {
    this.authorize(actor, ticketId)
    if (actor.role === 'node') {
      if (actor.nodeId !== nodeId) fail('node_scope', '不能读取兄弟节点的工作帧', 403)
      this.requireBinding(actor)
    }
    const workflow = this.load(ticketId)
    return this.contextOf(workflow, nodeOf(workflow, nodeId))
  }
  private contextOf(workflow: HmmWorkflow, node: HmmNode) {
    const { ticketId } = workflow, nodeId = node.id
    // 只有显式依赖的已完成结果和主动发布的产物可跨节点读取。
    const dependencies = [...new Set([node, ...ancestors(workflow, node)].flatMap(item => item.dependsOn))]
      .map(id => nodeOf(workflow, id)).filter(item => item.state === 'completed')
      .map(item => item.mode === 'task' ? { nodeId: item.id, result: sharedResult(item.result) }
        : { nodeId: item.id, results: subtree(workflow, item.id).filter(child => child.mode === 'task' && child.state === 'completed')
          .map(child => ({ nodeId: child.id, result: sharedResult(child.result) })) })
    return { ticketId, nodeId, revision: workflow.revision, planVersion: workflow.planVersion ?? 1, skeleton: workflow.skeleton, state: node.state,
      claimsRequired: node.claimsRequired ?? false, purpose: node.purpose ?? 'reasoning',
      deviceGrants: (workflow.deviceGrants ?? []).filter(grant => !grant.revoked && grant.nodeId === nodeId),
      inputRef: node.mode === 'task' && node.state !== 'pruned' ? inputReference(workflow, node) : undefined,
      inputMeaning: '任务输入引用仅代表要求与假设，不证明外部事实',
      evidenceRequired: node.evidenceRequired ?? false,
      resultRef: node.result ? resultReference(workflow, node) : undefined,
      sourceResults: visibleResults(workflow, node).map(item => ({ nodeId: item.id, ref: resultReference(workflow, item) })),
      instruction: node.state === 'pruned' ? undefined : node.instruction, frame: node.frame, result: node.result,
      reason: node.reason, reconsiderWhen: node.reconsiderWhen, dependencies,
      ...(node.modelFailureCode ? { modelFailureCode: node.modelFailureCode } : {}),
      blackboard: workflow.published.map(id => ({ nodeId: id, result: sharedResult(nodeOf(workflow, id).result) })) }
  }
  /** 节点投递与上下文工具共用引用投影；管理端继续读取原有完整上下文。 */
  executionContext(binding: HmmBinding) {
    const { workflow, node } = this.evidenceNode({ role: 'node', ...binding }, binding.ticketId, binding.nodeId)
    const { result: _, dependencies, blackboard, ...context } = this.contextOf(workflow, node)
    const references = new Map(context.sourceResults.map(item => [item.nodeId, item.ref]))
    const required = new Map(dependencies.flatMap(item => 'results' in item
      ? item.results!.map(child => [child.nodeId, child.result] as const)
      : [[item.nodeId, item.result] as const]))
    let remaining = HMM_LIMITS.resultInlineBytes as number
    return { ...context,
      // 短必需结果只附带一次，避免额外模型往返；大结果及可选黑板按引用读取。
      sourceResults: context.sourceResults.map(item => {
        const result = required.get(item.nodeId)
        const bytes = Buffer.byteLength(JSON.stringify({ ...item, result }), 'utf8')
        if (!result || bytes > remaining) return { ...item, result: undefined }
        try {
          const verified = readResult(workflow, node, { ref: item.ref })
          remaining -= bytes
          return { ...item, result: verified.result }
        } catch (error) {
          if (!(error instanceof HmmError)) throw error
          return { ...item, result: undefined }
        }
      }),
      dependencies: dependencies.map(item => ({ nodeId: item.nodeId,
        resultRefs: 'results' in item
          ? item.results!.map(child => references.get(child.nodeId)!)
          : [references.get(item.nodeId)!] })),
      blackboard: blackboard.map(item => ({ nodeId: item.nodeId, ref: references.get(item.nodeId)! })) }
  }
  apply(actor: HmmActor, ticketId: string, revision: number, input: unknown) {
    const command = CommandSchema.parse(input)
    if (!Number.isSafeInteger(revision) || revision < 1) fail('revision_invalid', '必须提供读取到的计划版本')
    if (['dispatch', 'hold', 'resume', 'recheck', 'prune', 'publish', 'validate', 'review_claims'].includes(command.action)) this.controller(actor)
    return this.store.atomic(() => {
      // hold 只收缩执行范围；全局暂停时仍可停止在途节点，其他写入沿用原检查。
      this.authorize(actor, ticketId, true, command.action === 'hold')
      const workflow = this.load(ticketId)
      if (actor.role === 'node') {
        this.requireBinding(actor)
        if (!['checkpoint', 'complete', 'suspend'].includes(command.action) || !('nodeId' in command) || command.nodeId !== actor.nodeId)
          fail('node_scope', '节点会话不能操作其他节点或调度计划', 403)
        if ('lease' in command && command.lease !== actor.lease) fail('lease_stale', '节点执行凭据不匹配', 409)
      }
      if (workflow.revision !== revision) fail('revision_conflict', '计划已更新，请重新读取后提交', 409)
      const ticket = this.store.tickets.get(ticketId)
      if (ticket?.executionMode === 'hmm' && ticket.attention
        && ['dispatch', 'start', 'resume', 'validate'].includes(command.action))
        fail('question_pending', '当前问题尚未回答或撤回，不能恢复执行或验收', 409)
      if (workflow.phase === 'validated' && !['recheck', 'review_claims'].includes(command.action)) fail('workflow_validated', '计划已验收，本轮不再接受写入', 409)
      const previouslyReady = reviewReady(workflow)
      const wasAutomatic = workflow.autoRun ?? false
      let lease: string | undefined
      let rechecked: string[] | undefined
      if (command.action === 'review_claims') {
        reviewClaims(workflow, command.reviews, this.now())
        if (workflow.phase === 'validated') {
          workflow.phase = 'active'; workflow.autoRun = false; delete workflow.validation
        }
      } else if (command.action === 'dispatch') {
        if (hasManualRunningNode(workflow.nodes))
          fail('manual_running', '请先结束或挂起手动执行的节点', 409)
        workflow.autoRun = true
      } else if (command.action === 'hold') {
        workflow.autoRun = false
        for (const node of workflow.nodes.filter(node => node.mode === 'task' && node.state === 'running')) {
          node.state = 'suspended'; node.reason = '自动执行已停止'; delete node.lease; delete node.modelFailureCode
        }
      } else if (command.action === 'recheck') {
        rechecked = recheck(workflow, command.nodeId, command.reason)
      } else if (command.action === 'validate') {
        this.assertInputVersion(ticketId, command.inputVersion)
        const tasks = workflow.nodes.filter(node => node.mode === 'task')
        if (!workflow.nodes.every(terminal) || !tasks.some(node => node.state === 'completed'))
          fail('unfinished_nodes', '仍有未完成节点，或所有任务都被剪枝，不能验收', 409)
        assertEvidenceReady(workflow, command.evidenceRefs)
        assertClaimsReviewed(workflow)
        workflow.validation = { summary: command.summary, evidenceRefs: command.evidenceRefs, inputVersion: command.inputVersion }
        workflow.phase = 'validated'; workflow.autoRun = false
      } else {
        const node = nodeOf(workflow, command.nodeId)
        switch (command.action) {
          case 'start':
            if (workflow.autoRun && actor.role !== 'scheduler') fail('scheduler_owns_start', '自动计划由调度器启动节点', 409)
            if (!runnable(workflow, node, dependencyValidity(workflow).unavailableDependencies))
              fail('node_not_ready', '节点未就绪，请检查依赖、依据有效性及挂起状态', 409)
            if (node.attempt >= HMM_LIMITS.attempts) fail('attempts_exhausted', '节点执行次数达到上限，请重新评估计划', 409)
            if (workflow.nodes.filter(item => item.mode === 'task' && item.state === 'running').length >= workflow.maxActive)
              fail('capacity_reached', '活跃节点数已达到本计划上限', 409)
            node.state = 'running'; node.attempt++; node.lease = lease = randomUUID()
            delete node.modelFailureCode
            if (actor.role === 'scheduler') node.sessionId = `hmm-${key(ticketId, node.id, lease)}`
            else delete node.sessionId
            break
          case 'checkpoint':
          case 'complete':
            if (node.mode !== 'task' || node.state !== 'running' || node.lease !== command.lease)
              fail('lease_stale', '节点执行凭据已失效，不能写入迟到结果', 409)
            if (command.action === 'checkpoint') node.frame = command.frame
            else {
              // 启动后的资料撤回或换版也会失效；提交不能靠省略上游引用绕过必需依赖。
              const required = explicitDependencies(workflow, node)
              if (required.length) {
                const { unavailableDependencies } = dependencyValidity(workflow)
                if (required.some(id => unavailableDependencies.has(id)))
                  fail('evidence_invalid', '必需上游成果已失效，请重新核验后完成', 409)
              }
              assertReferences(workflow, node, command.evidenceRefs)
              assertResultClaims(workflow, node, command.claims ?? [])
              node.result = { summary: command.summary, evidenceRefs: command.evidenceRefs, ...(command.claims ? { claims: command.claims } : {}) }
              node.frame = ''; node.state = 'completed'; delete node.lease; delete node.modelFailureCode
            }
            break
          case 'suspend':
          case 'prune':
            if (terminal(node)) fail('node_terminal', '节点已经结束', 409)
            for (const item of subtree(workflow, node.id)) {
              if (command.action === 'suspend' && terminal(item)) continue
              item.state = command.action === 'prune' ? 'pruned' : 'suspended'
              item.reason = command.reason; delete item.lease; delete item.modelFailureCode
              if (command.action === 'prune') {
                item.frame = ''; delete item.result; delete item.instruction
                item.reconsiderWhen = command.reconsiderWhen
                workflow.published = workflow.published.filter(id => id !== item.id)
              }
            }
            break
          case 'resume':
            if (node.state !== 'suspended') fail('not_suspended', '只有挂起节点可以恢复', 409)
            if (subtree(workflow, node.id).some(item => item.mode === 'task' && item.state === 'suspended' && item.attempt >= HMM_LIMITS.attempts))
              fail('attempts_exhausted', '节点执行次数达到上限，请重新评估计划', 409)
            for (const item of subtree(workflow, node.id).filter(item => item.state === 'suspended')) {
              item.state = 'pending'; delete item.reason; delete item.modelFailureCode
            }
            break
          case 'publish':
            if (node.state !== 'completed' || !node.result) fail('result_missing', '只能发布已完成任务的结果', 409)
            // 与读取和验收共用依据链判断，仅拒绝当前目标，不冻结其他有效成果。
            if (invalidResultNodes(workflow).includes(node.id)) fail('evidence_invalid', '结果依据已失效，请重新核验后发布', 409)
            if (!workflow.published.includes(node.id)) workflow.published.push(node.id)
            break
        }
      }
      refresh(workflow)
      this.save(workflow, command.action, actor.role === 'worker' ? `worker:${actor.ticketId}` : actor.role === 'node' ? `node:${actor.nodeId}` : actor.role,
        'nodeId' in command ? command.nodeId : undefined)
      if (!previouslyReady && reviewReady(workflow)) this.signals.review?.(ticketId, workflow.revision)
      if (command.action === 'validate') this.signals.validated?.(ticketId, workflow.revision)
      if (command.action === 'dispatch' && !wasAutomatic) this.signals.dispatched?.(ticketId)
      if (command.action === 'suspend' && actor.role === 'node')
        this.signals.attention?.(ticketId, actor.nodeId, command.reason, workflow.revision)
      // 写入回执不重复携带整棵树和历史；只有调用方显式读取时才返回上下文。
      return { ticketId, revision: workflow.revision, phase: workflow.phase, awaitingValidation: reviewReady(workflow),
        ...('nodeId' in command ? { nodeId: command.nodeId, state: nodeOf(workflow, command.nodeId).state } : {}),
        ...(lease ? { lease } : {}), ...(rechecked ? { rechecked } : {}) }
    })
  }
  /** 查询和读取共用节点范围；自动节点不能通过参数选择其他节点。 */
  private evidenceNode(actor: HmmActor, ticketId: string, nodeId: string) {
    this.authorize(actor, ticketId)
    if (actor.role === 'node') {
      if (actor.nodeId !== nodeId) fail('node_scope', '不能访问兄弟节点的证据', 403)
      this.requireBinding(actor)
    }
    const workflow = this.load(ticketId), node = nodeOf(workflow, nodeId)
    if (node.mode !== 'task' || node.state === 'pruned') fail('node_scope', '该节点不可读取证据', 403)
    return { workflow, node }
  }
  queryEvidence(actor: HmmActor, ticketId: string, nodeId: string, input: unknown) {
    const { workflow } = this.evidenceNode(actor, ticketId, nodeId)
    return evidenceCatalog(workflow, nodeId, input)
  }
  readResult(binding: HmmBinding, input: unknown) {
    const { workflow, node } = this.evidenceNode({ role: 'node', ...binding }, binding.ticketId, binding.nodeId)
    return readResult(workflow, node, input)
  }
  /** 异步启动后重验已捕获的必需结果；共用当前快照，不按计划版本整体拒绝。 */
  requireExecutionInputs(binding: HmmBinding, refs: readonly string[]): void {
    const { workflow, node } = this.evidenceNode({ role: 'node', ...binding }, binding.ticketId, binding.nodeId)
    for (const ref of refs) readResult(workflow, node, { ref })
  }
  /** 自动节点只读自身及可见上游断言；总管与绑定工单执行器可检查本工单。 */
  claims(actor: HmmActor, ticketId: string, nodeId: string | undefined, input: unknown) {
    this.authorize(actor, ticketId)
    if (actor.role === 'node') {
      if (nodeId && nodeId !== actor.nodeId) fail('node_scope', '不能读取兄弟节点的断言', 403)
      this.requireBinding(actor); nodeId = actor.nodeId
    }
    const workflow = this.load(ticketId)
    const node = nodeId ? nodeOf(workflow, nodeId) : undefined
    const allowed = new Set(node ? [node.id, ...visibleResults(workflow, node).map(item => item.id)] : workflow.nodes.map(item => item.id))
    return claimGraph(workflow, allowed, input, (owner, claim) => claimReferenceStatus(workflow, owner, claim))
  }
  /** 设备授权由本地管理端写入；更新代次同时撤回旧授权产生的快照。 */
  grantDevice(actor: HmmActor, ticketId: string, revision: number, input: unknown) {
    this.controller(actor)
    const grant = DeviceGrantSchema.parse(input)
    return this.store.atomic(() => {
      this.authorize(actor, ticketId, true)
      const { workflow } = this.evidenceNode(actor, ticketId, grant.nodeId)
      if (revision !== workflow.revision) fail('revision_conflict', '计划版本已变化，请重新读取', 409)
      const grants = workflow.deviceGrants ??= []
      const index = grants.findIndex(item => item.id === grant.id)
      if (index < 0 && grants.length >= DEVICE_LIMITS.grants) fail('grant_limit', '设备授权数量达到本工单上限', 409)
      this.invalidateGrant(workflow, grant.id)
      const value = { ...grant, generation: randomUUID() }
      if (index < 0) grants.push(value); else grants[index] = value
      this.save(workflow, 'device_grant', actor.role, grant.nodeId)
      return { revision: workflow.revision, grant: value }
    })
  }
  revokeDevice(actor: HmmActor, ticketId: string, revision: number, grantId: string) {
    this.controller(actor)
    return this.store.atomic(() => {
      this.authorize(actor, ticketId)
      const workflow = this.load(ticketId)
      if (revision !== workflow.revision) fail('revision_conflict', '计划版本已变化，请重新读取', 409)
      const grant = workflow.deviceGrants?.find(item => item.id === grantId)
      if (!grant) fail('grant_missing', '设备授权不存在', 404)
      grant!.revoked = true
      this.invalidateGrant(workflow, grantId)
      this.save(workflow, 'device_revoke', 'host')
      return { revision: workflow.revision }
    })
  }
  private invalidateGrant(workflow: HmmWorkflow, grantId: string): void {
    for (const doc of workflow.evidence?.documents ?? []) {
      if (doc.source?.grantId !== grantId) continue
      delete doc.text; doc.revoked = true
    }
  }
  /** 异步调用前后都核验授权与节点代次，防止撤权、重查或停单后的迟到写入。 */
  deviceAccess(actor: HmmActor, ticketId: string, nodeId: string, grantId: string) {
    this.authorize(actor, ticketId, true)
    const { workflow, node } = this.evidenceNode(actor, ticketId, nodeId)
    if (workflow.phase !== 'active' || !['pending', 'running'].includes(node.state))
      fail('node_inactive', '当前节点不可发起设备读取', 409)
    const grant = workflow.deviceGrants?.find(item => item.id === grantId && item.nodeId === nodeId && !item.revoked)
    if (!grant) fail('device_access_denied', '节点未获此设备数据授权或授权已撤回', 403)
    return { grant: grant!, fence: JSON.stringify([node.attempt, node.lease, node.generation, node.state]) }
  }
  captureDevice(actor: HmmActor, ticketId: string, nodeId: string, fence: string, source: DeviceSource, text: string) {
    return this.store.atomic(() => {
      const current = this.deviceAccess(actor, ticketId, nodeId, source.grantId)
      if (current.fence !== fence || current.grant.generation !== source.grantGeneration
        || current.grant.deviceId !== source.deviceId || current.grant.domain !== source.domain
        || (!current.grant.includeRestricted && source.sensitivity === 'restricted'))
        fail('device_access_stale', '设备读取期间节点或授权已变化', 409)
      const { workflow, node } = this.evidenceNode(actor, ticketId, nodeId)
      const digest = createHash('sha256').update(JSON.stringify([nodeId, source.grantId, source.deviceId,
        source.sourceId, source.offset, source.end])).digest('hex').slice(0, 48)
      const id = `device_${digest}`
      const existing = workflow.evidence?.documents.find(doc => doc.id === id)
      const same = existing && !existing.revoked && existing.text === text
        && JSON.stringify(existing.source) === JSON.stringify(source)
      const document = same ? existing : putEvidence(workflow, {
        id, title: source.title, origin: `device:${source.deviceId}`, text, nodeIds: [nodeId],
      }, this.now())
      const stored = workflow.evidence!.documents.find(doc => doc.id === document.id)!
      stored.source = source
      const result = readEvidence(workflow, node, { id, version: document.version, length: text.length }, this.now())
      if (!same || result.created) this.save(workflow, 'device_read', actor.role, nodeId)
      return { ...result.value, revision: workflow.revision }
    })
  }
  readEvidence(actor: HmmActor, ticketId: string, nodeId: string, input: unknown) {
    return this.store.atomic(() => {
      const { workflow, node } = this.evidenceNode(actor, ticketId, nodeId)
      const result = readEvidence(workflow, node, input, this.now())
      if (result.created) this.save(workflow, 'evidence_read', actor.role, nodeId)
      return { ...result.value, revision: workflow.revision }
    })
  }
  /** 仅本地管理 API 暴露此写入口；模型工具不能导入自述并将其标为证据。 */
  importEvidence(actor: HmmActor, ticketId: string, revision: number, input: unknown) {
    this.controller(actor)
    return this.store.atomic(() => {
      this.authorize(actor, ticketId, true)
      const workflow = this.load(ticketId)
      if (revision !== workflow.revision) fail('revision_conflict', '计划版本已变化，请重新读取', 409)
      const document = putEvidence(workflow, input, this.now())
      this.save(workflow, 'evidence_import', actor.role)
      return { revision: workflow.revision, document }
    })
  }
  /** 撤回删除当前快照正文并使旧回执失效；不删除 DSH 历史或 SQLite 备份。 */
  revokeEvidence(actor: HmmActor, ticketId: string, revision: number, evidenceId: string) {
    this.controller(actor)
    return this.store.atomic(() => {
      this.authorize(actor, ticketId)
      const workflow = this.load(ticketId)
      if (revision !== workflow.revision) fail('revision_conflict', '计划版本已变化，请重新读取', 409)
      const document = workflow.evidence?.documents.find(item => item.id === evidenceId)
        ?? fail('evidence_missing', '证据不存在', 404)
      if (!document.revoked) {
        delete document.text; document.revoked = true
        this.save(workflow, 'evidence_revoke', 'host')
      }
      return { revision: workflow.revision, revoked: true }
    })
  }
  /** 只扫描未结束工单；状态与派工分离，启动前仍须在事务内再次检查。 */
  dispatchable() {
    return this.store.tickets.open().reverse().flatMap(ticket => {
      const workflow = this.store.get(HMM_KEYS.workflow(ticket.id))
      if (!workflow?.autoRun || workflow.phase !== 'active' || waitsForPerson(ticket)
        || (ticket.executionMode === 'hmm' && ticket.attention)) return []
      const { unavailableDependencies } = dependencyValidity(workflow)
      const room = workflow.maxActive - workflow.nodes.filter(node => node.mode === 'task' && node.state === 'running').length
      return [{ ticketId: ticket.id, maxActive: workflow.maxActive, nodes: workflow.nodes.filter(node => runnable(workflow, node, unavailableDependencies) && node.attempt < HMM_LIMITS.attempts)
        .slice(0, Math.max(0, room)).map(node => node.id) }]
    })
  }
  /** 原子占用节点并记录新会话编号；不会复用上一次执行的聊天历史。 */
  claim(ticketId: string, nodeId: string): HmmBinding {
    return this.store.atomic(() => {
      const workflow = this.load(ticketId)
      const ticket = this.store.tickets.get(ticketId)
      if (!workflow.autoRun || !ticket || waitsForPerson(ticket) || (ticket.executionMode === 'hmm' && ticket.attention))
        return fail('dispatch_disabled', '计划尚未允许自动执行', 409)
      const result = this.apply({ role: 'scheduler' }, ticketId, workflow.revision, { action: 'start', nodeId })
      const node = nodeOf(this.load(ticketId), nodeId)
      return { ticketId, nodeId, lease: result.lease!, sessionId: node.sessionId! }
    })
  }
  current(binding: HmmBinding): boolean {
    const ticket = this.store.tickets.get(binding.ticketId)
    const workflow = this.store.get(HMM_KEYS.workflow(binding.ticketId))
    const node = workflow?.nodes.find(item => item.id === binding.nodeId)
    return !!ticket && liveTicket(ticket) && workflow?.phase === 'active' && node?.state === 'running'
      && node.lease === binding.lease && node.sessionId === binding.sessionId
  }
  /** 只用于回收已报告的执行，不恢复工具权限；停单、剪枝和新执行均不允许继续等待。 */
  settled(binding: HmmBinding): boolean {
    const ticket = this.store.tickets.get(binding.ticketId)
    const workflow = this.store.get(HMM_KEYS.workflow(binding.ticketId))
    const node = workflow?.nodes.find(item => item.id === binding.nodeId)
    return !!ticket && (liveTicket(ticket) || ticket.ended?.outcome === 'completed')
      && node?.sessionId === binding.sessionId && (node.state === 'completed' || node.state === 'suspended')
  }
  requireBinding(binding: HmmBinding): void {
    if (!this.current(binding)) fail('lease_stale', '节点会话已失效，不能继续执行', 409)
  }
  /** 宿主超时或故障可使用预留空间撤销节点，工作帧填满时也不能阻塞停止。 */
  suspendRun(binding: HmmBinding, reason: string, modelFailureCode?: ModelFailureCode): void {
    this.store.atomic(() => {
      if (!this.current(binding)) return
      const workflow = this.load(binding.ticketId), node = nodeOf(workflow, binding.nodeId)
      node.state = 'suspended'; node.reason = reason.slice(0, 80); delete node.lease
      if (modelFailureCode) node.modelFailureCode = ModelFailureCodeSchema.parse(modelFailureCode)
      else delete node.modelFailureCode
      refresh(workflow)
      this.save(workflow, 'suspend', 'host', node.id)
      this.signals.attention?.(binding.ticketId, node.id, node.reason, workflow.revision, node.modelFailureCode)
    })
  }
  /** 节点调用不接受客户端版本或身份；在同一事务中读当前版本并校验执行凭据。 */
  report(binding: HmmBinding, input: { action: 'checkpoint'; frame: string }
    | { action: 'complete'; summary: string; evidenceRefs: string[]; claims?: HmmClaim[] } | { action: 'suspend'; reason: string }) {
    return this.store.atomic(() => {
      this.requireBinding(binding)
      const command = { ...input, nodeId: binding.nodeId, ...(input.action === 'suspend' ? {} : { lease: binding.lease }) }
      return this.apply({ role: 'node', ...binding }, binding.ticketId, this.load(binding.ticketId).revision, command)
    })
  }
  private assertValidation(ticketId: string, workflow: HmmWorkflow): void {
    if (workflow.phase !== 'validated') fail('workflow_unverified', 'HMM 计划尚未验收，不能报告完成', 409)
    this.assertInputVersion(ticketId, workflow.validation?.inputVersion)
    assertEvidenceReady(workflow, workflow.validation?.evidenceRefs)
    assertClaimsReviewed(workflow)
  }
  /** 目录只核对当前结果是否仍可交付，不返回成果正文，也不将历史完成记录改为执行状态。 */
  assertResultAvailable(actor: HmmActor, ticketId: string): void {
    this.controller(actor); this.authorize(actor, ticketId)
    const workflow = this.load(ticketId)
    if (!workflow.validation) fail('workflow_unverified', '当前计划没有验收结果', 409)
    this.assertValidation(ticketId, workflow)
  }
  /** 工单准备报告结果时，HMM 计划必须已通过显式验收；普通上游工单不受影响。 */
  assertReady(ticketId: string): void {
    const workflow = this.store.get(HMM_KEYS.workflow(ticketId))
    if (workflow) this.assertValidation(ticketId, workflow)
  }
  /** 派工结束或工单停止时撤销执行凭据；即使同一工单后来恢复，旧结果也不能回写。 */
  interrupt(ticketId: string, reason = '派工已结束，恢复前核对外部动作'): number | undefined {
    return this.store.atomic(() => {
      const workflow = this.store.get(HMM_KEYS.workflow(ticketId))
      if (!workflow || (!workflow.autoRun && !workflow.nodes.some(node => node.mode === 'task' && node.state === 'running'))) return
      workflow.autoRun = false
      for (const node of workflow.nodes.filter(node => node.mode === 'task' && node.state === 'running')) {
        node.state = 'suspended'; node.reason = reason; delete node.lease; delete node.modelFailureCode
      }
      refresh(workflow); this.save(workflow, 'interrupt', 'host')
      return workflow.revision
    })
  }
  /** 重启后不重放外部动作，撤销运行凭据并保留待人工或总管恢复的工作帧。 */
  recover(): void {
    this.store.atomic(() => {
      for (const key of this.store.keys(HMM_KEYS.workflow)) {
        const workflow = this.store.get(key)!
        if (workflow.schemaVersion !== 1) fail('schema_unsupported', '不支持此 HMM 状态版本', 409)
        const revision = this.interrupt(workflow.ticketId, '宿主重启，恢复前核对外部动作是否已经完成')
        const ticket = this.store.tickets.get(workflow.ticketId)
        // 只通知本次实际中断的未完成工单；主动暂停与待验收成果不重复唤醒总管。
        if (revision !== undefined && ticket && liveTicket(ticket)
          && workflow.nodes.some(node => node.mode === 'task' && !terminal(node)))
          this.signals.recoveryRequired?.(workflow.ticketId, revision)
      }
    })
  }
}
