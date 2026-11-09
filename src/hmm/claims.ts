import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HmmError, type HmmNode, type HmmResult, type HmmWorkflow } from './model.ts'

export const CLAIM_LIMITS = { perNode: 8, perWorkflow: 64, page: 8, reviews: 16 } as const
const ref = z.string().trim().min(1).max(300)
export const ClaimSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  subject: z.string().trim().min(1).max(120),
  predicate: z.string().trim().min(1).max(80),
  object: z.string().trim().min(1).max(400),
  kind: z.enum(['extracted', 'inferred']),
  evidenceRefs: z.array(ref).min(1).max(8),
  counterEvidenceRefs: z.array(ref).max(8).default([]),
}).strict()
export const ClaimsSchema = z.array(ClaimSchema).min(1).max(CLAIM_LIMITS.perNode)
export const ClaimReviewSchema = z.object({
  ref, verdict: z.enum(['accept', 'reject', 'needs_evidence']),
  reason: z.string().trim().min(1).max(500),
}).strict()
export const ClaimReviewsSchema = z.array(ClaimReviewSchema).min(1).max(CLAIM_LIMITS.reviews)
export const ClaimQuerySchema = z.object({
  offset: z.number().int().min(0).max(CLAIM_LIMITS.perWorkflow).default(0),
  limit: z.number().int().min(1).max(CLAIM_LIMITS.page).default(CLAIM_LIMITS.page),
  revision: z.number().int().positive().optional(),
}).strict()
export type HmmClaim = z.infer<typeof ClaimSchema>
export type HmmClaimReview = z.infer<typeof ClaimReviewSchema> & { reviewedAt: string; actor: 'controller' }
export const claimReference = (workflow: HmmWorkflow, node: HmmNode, claim: HmmClaim) =>
  `claim:${createHash('sha256').update(JSON.stringify([workflow.ticketId, node.id, node.attempt, claim])).digest('hex')}`
export const claimEntries = (workflow: HmmWorkflow) => workflow.nodes
  .filter(node => node.state === 'completed' && node.result)
  .flatMap(node => (node.result!.claims ?? []).map(claim => ({ node, claim, ref: claimReference(workflow, node, claim) })))
export const resultReferences = (result: HmmResult) =>
  [...result.evidenceRefs, ...(result.claims ?? []).flatMap(claim => [...claim.evidenceRefs, ...claim.counterEvidenceRefs])]

/** 当前结果替换或剪枝后不保留失去目标的复核，避免旧结论借用既有认可。 */
export function pruneClaimReviews(workflow: HmmWorkflow): void {
  if (!workflow.claimReviews) return
  const refs = new Set(claimEntries(workflow).map(item => item.ref))
  workflow.claimReviews = workflow.claimReviews.filter(review => refs.has(review.ref))
}
export function reviewClaims(workflow: HmmWorkflow, input: unknown, now: string): void {
  const reviews = ClaimReviewsSchema.parse(input)
  const refs = new Set(claimEntries(workflow).map(item => item.ref))
  if (new Set(reviews.map(review => review.ref)).size !== reviews.length)
    throw new HmmError('claim_review_duplicate', '同一批复核不能重复处理相同断言')
  if (reviews.some(review => !refs.has(review.ref)))
    throw new HmmError('claim_stale', '断言不存在、已被替换或不属于本工单', 409)
  pruneClaimReviews(workflow)
  const current = workflow.claimReviews ??= []
  for (const review of reviews) {
    const value: HmmClaimReview = { ...review, reviewedAt: now, actor: 'controller' }
    const index = current.findIndex(item => item.ref === review.ref)
    if (index < 0) current.push(value); else current[index] = value
  }
}
export function claimReviewStatus(workflow: HmmWorkflow) {
  const result = { total: 0, accepted: 0, pending: 0, blocked: 0 }
  for (const entry of claimEntries(workflow)) {
    result.total++
    const review = workflow.claimReviews?.find(item => item.ref === entry.ref)
    if (!review) result.pending++
    else if (review.verdict === 'accept') result.accepted++
    else result.blocked++
  }
  return result
}
export function assertClaimsReviewed(workflow: HmmWorkflow): void {
  const status = claimReviewStatus(workflow)
  if (status.pending || status.blocked)
    throw new HmmError('claims_unreviewed', '存在未复核、被否决或需补证的断言，不能验收或交付', 409)
}

/** 分页投影只含允许共享的断言和引用边，不授予原文权限，也不自动把推断升级为事实。 */
export function claimGraph(workflow: HmmWorkflow, nodeIds: ReadonlySet<string>, input: unknown,
  valid: (node: HmmNode, claim: HmmClaim) => boolean) {
  const query = ClaimQuerySchema.parse(input)
  if ((query.offset > 0 && query.revision === undefined)
    || (query.revision !== undefined && query.revision !== workflow.revision))
    throw new HmmError('revision_conflict', '断言分页需要相同计划版本，请从第一页重新读取', 409)
  const entries = claimEntries(workflow).filter(entry => nodeIds.has(entry.node.id))
  const page = entries.slice(query.offset, query.offset + query.limit)
  return {
    revision: workflow.revision, total: entries.length,
    nextOffset: query.offset + page.length < entries.length ? query.offset + page.length : null,
    nodes: page.map(({ node, claim, ref }) => ({
      ref, nodeId: node.id, id: claim.id, subject: claim.subject, predicate: claim.predicate, object: claim.object, kind: claim.kind,
      referenceIntegrity: valid(node, claim) ? 'valid' as const : 'invalid' as const,
      review: workflow.claimReviews?.find(review => review.ref === ref) ?? null,
    })),
    edges: page.flatMap(({ claim, ref }) => [
      ...claim.evidenceRefs.map(from => ({ from, to: ref, kind: 'supports' as const })),
      ...claim.counterEvidenceRefs.map(from => ({ from, to: ref, kind: 'contradicts' as const })),
    ]),
  }
}
