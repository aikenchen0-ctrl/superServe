import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HmmError, type HmmNode, type HmmWorkflow } from './model.ts'
import type { DeviceSource } from './device-contracts.ts'
import { CLAIM_LIMITS, claimReference, type HmmClaim } from './claims.ts'

export const EVIDENCE_LIMITS = { documents: 16, receipts: 128, readChars: 8000, textChars: 16000 } as const
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
export const EvidenceInputSchema = z.object({
  id, title: z.string().trim().min(1).max(160),
  origin: z.string().trim().min(1).max(300),
  text: z.string().min(1).max(EVIDENCE_LIMITS.textChars).refine(value => value.isWellFormed(), '证据文本含无效 Unicode 字符'),
  nodeIds: z.array(id).min(1).max(64),
}).strict()
export const EvidenceQuerySchema = z.object({
  text: z.string().trim().min(1).max(300).optional(),
  limit: z.number().int().min(1).max(8).default(8),
}).strict()
export const EvidenceReadSchema = z.object({
  id, version: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().min(0).default(0),
  length: z.number().int().min(1).max(EVIDENCE_LIMITS.readChars).default(4000),
}).strict()
export const ResultReadSchema = z.object({
  ref: z.string().regex(/^result:[a-f0-9]{64}$/),
}).strict()
export type EvidenceInput = z.input<typeof EvidenceInputSchema>
export interface EvidenceDocument {
  id: string
  title: string
  origin: string
  text?: string
  nodeIds: string[]
  version: string
  contentHash: string
  observedAt: string
  revoked?: boolean
  source?: DeviceSource
}
export interface EvidenceReceipt {
  ref: string
  documentId: string
  version: string
  nodeId: string
  attempt: number
  offset: number
  end: number
  contentHash: string
  issuedAt: string
}
export interface EvidenceState { documents: EvidenceDocument[]; receipts: EvidenceReceipt[] }

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const reject = (message: string): never => { throw new HmmError('evidence_invalid', message, 409) }
export const inputReference = (workflow: HmmWorkflow, node: HmmNode) =>
  `input:${hash(JSON.stringify([workflow.ticketId, node.id, workflow.goal, node.instruction,
    ...(node.purpose === 'survey' ? [node.purpose] : [])]))}`
export const resultReference = (workflow: HmmWorkflow, node: HmmNode) =>
  `result:${hash(JSON.stringify([workflow.ticketId, node.id, node.attempt, node.result]))}`

/** 节点和祖先只继承显式数据依赖，串行顺序与可选发布不扩大必需输入。 */
export function explicitDependencies(workflow: HmmWorkflow, node: HmmNode): string[] {
  const dependencyIds = new Set(node.dependsOn)
  let parent = workflow.nodes.find(item => item.id === node.parentId)
  while (parent) {
    for (const id of parent.dependsOn) dependencyIds.add(id)
    parent = workflow.nodes.find(item => item.id === parent!.parentId)
  }
  return [...dependencyIds]
}

/** 根据显式依赖和发布记录取结果，串行先后关系本身不赋予兄弟结果可见性。 */
export function visibleResults(workflow: HmmWorkflow, node: HmmNode): HmmNode[] {
  const dependencyIds = new Set(explicitDependencies(workflow, node))
  return workflow.nodes.filter(item => {
    if (!item.result || item.state !== 'completed') return false
    if (workflow.published.includes(item.id) || dependencyIds.has(item.id)) return true
    let ancestor = workflow.nodes.find(candidate => candidate.id === item.parentId)
    while (ancestor) {
      if (dependencyIds.has(ancestor.id) && ancestor.state === 'completed') return true
      ancestor = workflow.nodes.find(candidate => candidate.id === ancestor!.parentId)
    }
    return false
  })
}

/** 元数据不携带正文；origin 是操作者声明的来源，不代表设备认证或真实性证明。 */
export function evidenceCatalog(workflow: HmmWorkflow, nodeId: string | undefined, input: unknown) {
  const query = EvidenceQuerySchema.parse(input)
  const needle = query.text?.toLocaleLowerCase()
  const matches = (workflow.evidence?.documents ?? []).filter(doc => !doc.revoked
    && (!nodeId || doc.nodeIds.includes(nodeId))
    && (!needle || `${doc.title}\n${doc.text}`.toLocaleLowerCase().includes(needle)))
  return { kind: 'evidence_catalog' as const, hits: matches.slice(0, query.limit).map(({ text: _, ...doc }) =>
    ({ ...doc, kind: doc.source ? 'device_snapshot' as const : 'operator_snapshot' as const })),
    truncated: matches.length > query.limit,
    // 固定提示不透露被过滤资料是否存在，也不在空匹配时自动扩大查询。
    ...(needle && !matches.length ? { hint: 'text 按不区分大小写的连续字面片段匹配，不是多关键词搜索。可省略 text 查看本节点获授权的有限目录，再按 id/version 读取所需片段。' } : {}) }
}

/** 按版本读取有界片段，回执绑定工单内节点及执行轮次；重复读取复用回执。 */
export function readEvidence(workflow: HmmWorkflow, node: HmmNode, input: unknown, now: string) {
  const request = EvidenceReadSchema.parse(input)
  const evidence = workflow.evidence ??= { documents: [], receipts: [] }
  const document = evidence.documents.find(doc => doc.id === request.id && doc.nodeIds.includes(node.id) && !doc.revoked)
  if (!document || document.text === undefined) throw new HmmError('evidence_unavailable', '证据不存在、已撤回或不在节点范围内', 404)
  if (document.version !== request.version) reject('证据版本已改变，请重新查询')
  if (request.offset >= document.text.length) reject('读取起点超出证据片段')
  const end = Math.min(document.text.length, request.offset + request.length)
  // 偏移使用 UTF-16 单元；拒绝截断代理对，避免同一片段在传输时改变内容。
  const splitPair = (offset: number) => offset > 0 && offset < document.text!.length
    && /[\uD800-\uDBFF]/.test(document.text![offset - 1]!) && /[\uDC00-\uDFFF]/.test(document.text![offset]!)
  if (splitPair(request.offset) || splitPair(end)) reject('读取边界截断字符，请调整起点或长度')
  const text = document.text.slice(request.offset, end)
  let receipt = evidence.receipts.find(item => item.documentId === document.id && item.version === document.version
    && item.nodeId === node.id && item.attempt === node.attempt && item.offset === request.offset && item.end === end)
  const created = !receipt
  if (!receipt) {
    if (evidence.receipts.length >= EVIDENCE_LIMITS.receipts) reject('证据读取回执达到本工单上限')
    receipt = { ref: `evidence:${randomUUID()}`, documentId: document.id, version: document.version, nodeId: node.id,
      attempt: node.attempt, offset: request.offset, end, contentHash: hash(text), issuedAt: now }
    evidence.receipts.push(receipt)
  }
  return { created, value: { kind: document.source ? 'device_snapshot' as const : 'operator_snapshot' as const,
    ...receipt, title: document.title, origin: document.origin, ...(document.source ? { source: document.source } : {}),
    text, truncated: request.offset > 0 || end < document.text.length, totalChars: document.text.length } }
}

export function putEvidence(workflow: HmmWorkflow, input: unknown, now: string) {
  const document = EvidenceInputSchema.parse(input)
  if (document.nodeIds.some(id => !workflow.nodes.some(node => node.id === id && node.mode === 'task' && node.state !== 'pruned')))
    reject('证据只能分配给本计划中未剪枝的任务节点')
  const evidence = workflow.evidence ??= { documents: [], receipts: [] }
  const previous = evidence.documents.findIndex(item => item.id === document.id)
  if (previous < 0 && evidence.documents.length >= EVIDENCE_LIMITS.documents) reject('证据片段数量达到本工单上限')
  // 内容、来源声明和授权范围共同决定版本，撤回后重新导入也会产生新版本。
  const nodeIds = [...new Set(document.nodeIds)].sort()
  const value: EvidenceDocument = { ...document, nodeIds, observedAt: now,
    contentHash: hash(document.text),
    version: hash(JSON.stringify([document, nodeIds, previous < 0 ? null : evidence.documents[previous]!.version, randomUUID()])) }
  if (previous < 0) evidence.documents.push(value)
  else evidence.documents[previous] = value
  const { text: _, ...metadata } = value
  return metadata
}

function checkClaimShape(workflow: HmmWorkflow, node: HmmNode, claims: readonly HmmClaim[]): void {
  if (node.claimsRequired && claims.length === 0) reject('本节点必须提交逐条断言，不能仅提交总结')
  if (claims.length > CLAIM_LIMITS.perNode || new Set(claims.map(claim => claim.id)).size !== claims.length)
    reject('断言数量超限或节点内编号重复')
  const existing = workflow.nodes.filter(item => item.id !== node.id).reduce((sum, item) => sum + (item.result?.claims?.length ?? 0), 0)
  if (existing + claims.length > CLAIM_LIMITS.perWorkflow) reject('断言总数达到本工单上限')
}

/** 同一验证过程复用已核验上游结果；断言的支持与反证分别检查，反证不能充当支持。 */
class ReferenceVerifier {
  private readonly checked = new Map<string, boolean>()
  private readonly failed = new Map<string, HmmError>()
  private readonly checkedClaims = new Map<HmmClaim, boolean>()
  constructor(private readonly workflow: HmmWorkflow) {}
  dependencies(node: HmmNode, stack: ReadonlySet<string>): void {
    const visit = (id: string): void => {
      const dependency = this.workflow.nodes.find(item => item.id === id)
      if (!dependency || dependency.state !== 'completed') return reject('必需上游成果已失效，请重新核验')
      if (dependency.mode === 'task') {
        if (!dependency.result) reject('必需上游结果缺失，请重新核验')
        this.result(dependency, stack)
      } else {
        for (const child of this.workflow.nodes.filter(item => item.parentId === id && item.state !== 'pruned'))
          visit(child.id)
      }
    }
    for (const id of explicitDependencies(this.workflow, node)) visit(id)
  }
  references(node: HmmNode, refs: readonly string[], completed: boolean, stack: ReadonlySet<string>): boolean {
    const workflow = this.workflow
    const candidates = completed ? workflow.nodes.filter(item => item.state === 'completed' && item.result) : visibleResults(workflow, node)
    let hasSource = false
    for (const ref of refs) {
      if (ref === inputReference(workflow, node)) continue
      const receipt = workflow.evidence?.receipts.find(item => item.ref === ref && item.nodeId === node.id && item.attempt === node.attempt)
      if (receipt) {
        const document = workflow.evidence!.documents.find(item => item.id === receipt.documentId)
        if (!document || document.revoked || document.text === undefined || document.version !== receipt.version
          || !document.nodeIds.includes(node.id)
          || hash(document.text.slice(receipt.offset, receipt.end)) !== receipt.contentHash) return reject('证据已撤回、更新或不再允许读取')
        if (document.source) {
          const source = document.source, grant = workflow.deviceGrants?.find(item => item.id === source.grantId)
          if (!grant || grant.revoked || grant.nodeId !== node.id || grant.generation !== source.grantGeneration
            || grant.deviceId !== source.deviceId || grant.domain !== source.domain
            || (!grant.includeRestricted && source.sensitivity === 'restricted')) reject('设备证据授权已失效')
        }
        hasSource = true
        continue
      }
      const dependency = candidates.find(item => resultReference(workflow, item) === ref
        || item.result!.claims?.some(claim => claimReference(workflow, item, claim) === ref))
      if (!dependency) return reject('引用未由宿主提供给该节点，请读取证据或可见的上游结果')
      const source = this.result(dependency, stack)
      const claim = dependency.result!.claims?.find(item => claimReference(workflow, dependency, item) === ref)
      hasSource = (claim ? this.claim(dependency, claim, true, new Set([...stack, dependency.id])) : source) || hasSource
    }
    return hasSource
  }
  claim(node: HmmNode, claim: HmmClaim, completed: boolean, stack: ReadonlySet<string>): boolean {
    if (this.checkedClaims.has(claim)) return this.checkedClaims.get(claim)!
    if (new Set(claim.evidenceRefs).size !== claim.evidenceRefs.length
      || new Set(claim.counterEvidenceRefs).size !== claim.counterEvidenceRefs.length
      || claim.counterEvidenceRefs.some(ref => claim.evidenceRefs.includes(ref))) reject('支持与反证引用不能重复或相互混用')
    const supported = this.references(node, claim.evidenceRefs, completed, stack)
    if (claim.kind === 'extracted' && claim.evidenceRefs.some(ref =>
      !this.workflow.evidence?.receipts.some(receipt => receipt.ref === ref && receipt.nodeId === node.id && receipt.attempt === node.attempt)))
      reject('资料摘取必须引用本节点实际读取的原文回执；上游推断不能改标为摘取')
    if (node.evidenceRequired && !supported) reject('断言缺少原文支持，任务要求或反证不能替代支持证据')
    for (const ref of claim.counterEvidenceRefs) {
      if (!this.references(node, [ref], completed, stack)) reject('反证必须具有原文来源，不能只引用任务要求')
    }
    this.checkedClaims.set(claim, supported)
    return supported
  }
  result(node: HmmNode, stack: ReadonlySet<string>): boolean {
    if (stack.has(node.id)) return reject('证据结果引用构成循环')
    if (this.checked.has(node.id)) return this.checked.get(node.id)!
    if (this.failed.has(node.id)) throw this.failed.get(node.id)!
    try {
      const next = new Set([...stack, node.id]), result = node.result!
      // 必需依赖决定成果可用性，但不代替显式证据，不能让任务输入获得原文支持。
      this.dependencies(node, next)
      checkClaimShape(this.workflow, node, result.claims ?? [])
      const supported = this.references(node, result.evidenceRefs, true, next)
      if (node.evidenceRequired && !supported) reject('本节点要求原文证据，任务输入引用不能替代取证')
      for (const claim of result.claims ?? []) this.claim(node, claim, true, next)
      this.checked.set(node.id, supported)
      return supported
    } catch (error) {
      // 同一次快照核验复用失败，避免多个下游反复遍历同一失效链；不跨写入缓存。
      if (error instanceof HmmError) this.failed.set(node.id, error)
      throw error
    }
  }
}

/** 检查初次提交的可见范围；只有支持引用可以满足原文要求。 */
export function assertReferences(workflow: HmmWorkflow, node: HmmNode, refs: readonly string[]): boolean {
  const hasSource = new ReferenceVerifier(workflow).references(node, refs, false, new Set([node.id]))
  if (node.evidenceRequired && !hasSource) reject('本节点要求原文证据，任务输入引用不能替代取证')
  return hasSource
}
/** 结果按当前可见范围和完整依据链读取；目录引用不授予原文或历史版本读取权限。 */
export function readResult(workflow: HmmWorkflow, node: HmmNode, input: unknown) {
  const { ref } = ResultReadSchema.parse(input)
  const source = visibleResults(workflow, node).find(item => resultReference(workflow, item) === ref)
    ?? reject('结果引用不存在、已失效或不在本节点可见范围内')
  new ReferenceVerifier(workflow).result(source, new Set())
  const { claims, ...result } = source.result!
  return { nodeId: source.id, ref, revision: workflow.revision,
    planVersion: workflow.planVersion ?? 1, result: { ...result, ...(claims ? { claimCount: claims.length } : {}) } }
}
export function assertResultClaims(workflow: HmmWorkflow, node: HmmNode, claims: readonly HmmClaim[]): void {
  checkClaimShape(workflow, node, claims)
  const verifier = new ReferenceVerifier(workflow)
  for (const claim of claims) verifier.claim(node, claim, false, new Set([node.id]))
}
export function claimReferenceStatus(workflow: HmmWorkflow, node: HmmNode, claim: HmmClaim): boolean {
  try {
    const verifier = new ReferenceVerifier(workflow), stack = new Set([node.id])
    verifier.dependencies(node, stack)
    verifier.claim(node, claim, true, stack)
    return true
  }
  catch (error) { if (error instanceof HmmError) return false; throw error }
}

/** 验收前逐个核对已完成结果，避免仅验证总管挑选的一条引用。 */
export function assertEvidenceReady(workflow: HmmWorkflow, validationRefs?: readonly string[]): void {
  const completed = workflow.nodes.filter(node => node.state === 'completed' && node.result)
  const verifier = new ReferenceVerifier(workflow)
  for (const node of completed) verifier.result(node, new Set())
  if (validationRefs?.some(ref => !completed.some(node => ref === resultReference(workflow, node))))
    reject('验收必须引用本计划已完成节点的结果引用')
}

export function referenceStatus(workflow: HmmWorkflow): 'valid' | 'invalid' {
  try { assertEvidenceReady(workflow); return 'valid' }
  catch (error) { if (error instanceof HmmError) return 'invalid'; throw error }
}

/** 派发与概览共用既有引用校验；只派生失效集合，不删除历史结果或改变节点状态。 */
export function invalidResultNodes(workflow: HmmWorkflow): string[] {
  const verifier = new ReferenceVerifier(workflow)
  return workflow.nodes.filter(node => node.state === 'completed' && node.result).flatMap(node => {
    try { verifier.result(node, new Set()); return [] }
    catch (error) { if (error instanceof HmmError) return [node.id]; throw error }
  })
}
