import { z } from 'zod'
import type { EvidenceState } from './evidence.ts'
import type { DeviceGrant } from './device-contracts.ts'
import { ClaimsSchema, ClaimReviewsSchema, type HmmClaim, type HmmClaimReview } from './claims.ts'
import type { ModelFailureCode } from './model-failure.ts'

export const HMM_LIMITS = { nodes: 64, depth: 8, history: 64, bytes: 256 * 1024,
  attempts: 8, planVersions: 16, nodeSteps: 12, nodeTimeoutMs: 120_000, resultInlineBytes: 4096 } as const
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const text = (max: number) => z.string().trim().min(1).max(max)

export const PlanSchema = z.object({
  goal: text(2000),
  maxActive: z.number().int().min(1).max(8).default(3),
  nodes: z.array(z.object({
    id,
    parentId: id.optional(),
    title: text(160),
    mode: z.enum(['task', 'serial', 'parallel']).default('task'),
    purpose: z.enum(['reasoning', 'survey']).optional(),
    instruction: text(4000).optional(),
    evidenceRequired: z.boolean().default(false),
    claimsRequired: z.boolean().default(false),
    dependsOn: z.array(id).max(HMM_LIMITS.nodes).default([]),
  }).strict()).min(2).max(HMM_LIMITS.nodes),
}).strict()

export const RunModeSchema = z.enum(['single', 'multi'])
export const RunSchema = z.object({
  goal: text(2000),
  mode: RunModeSchema.default('multi'),
}).strict()

export const PlanRevisionSchema = z.object({
  revision: z.number().int().positive(), plan: PlanSchema,
  reason: text(500), preview: z.boolean().default(false),
}).strict()

export const CommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dispatch') }).strict(),
  z.object({ action: z.literal('hold') }).strict(),
  z.object({ action: z.literal('start'), nodeId: id }).strict(),
  z.object({ action: z.literal('checkpoint'), nodeId: id, lease: text(64), frame: z.string().max(4000) }).strict(),
  z.object({ action: z.literal('complete'), nodeId: id, lease: text(64), summary: text(2000),
    evidenceRefs: z.array(text(300)).min(1).max(16), claims: ClaimsSchema.optional() }).strict(),
  z.object({ action: z.literal('review_claims'), reviews: ClaimReviewsSchema }).strict(),
  z.object({ action: z.literal('suspend'), nodeId: id, reason: text(500) }).strict(),
  z.object({ action: z.literal('resume'), nodeId: id }).strict(),
  z.object({ action: z.literal('recheck'), nodeId: id, reason: text(500) }).strict(),
  z.object({ action: z.literal('prune'), nodeId: id, reason: text(500), reconsiderWhen: text(500) }).strict(),
  z.object({ action: z.literal('publish'), nodeId: id }).strict(),
  z.object({ action: z.literal('validate'), summary: text(2000), evidenceRefs: z.array(text(300)).min(1).max(16),
    inputVersion: text(64).optional() }).strict(),
])
export type PlanInput = z.input<typeof PlanSchema>
export type RunInput = z.input<typeof RunSchema>
export type PlanSpec = z.output<typeof PlanSchema>
export type HmmCommand = z.output<typeof CommandSchema>
export interface HmmBinding { ticketId: string; nodeId: string; lease: string; sessionId: string }
export type HmmActor = { role: 'controller' | 'scheduler' } | { role: 'worker'; ticketId: string }
  | ({ role: 'node' } & HmmBinding)
export type NodeState = 'pending' | 'running' | 'suspended' | 'completed' | 'pruned'
export interface HmmResult { summary: string; evidenceRefs: string[]; claims?: HmmClaim[] }
export type HmmNode = PlanSpec['nodes'][number] & {
  state: NodeState
  frame: string
  attempt: number
  lease?: string
  sessionId?: string
  result?: HmmResult
  reason?: string
  modelFailureCode?: ModelFailureCode
  reconsiderWhen?: string
  generation?: string
}
export interface HmmWorkflow {
  schemaVersion: 1
  ticketId: string
  initialMode?: z.output<typeof RunModeSchema> | 'custom'
  initialPlanHash?: string
  initialDispatch?: boolean
  revision: number
  phase: 'active' | 'validated'
  goal: string
  maxActive: number
  planVersion?: number
  retiredNodeIds?: string[]
  lastPlanRevision?: {
    reason: string; at: string; beforeHash: string; afterHash: string
    added: string[]; removed: string[]; changed: string[]; invalidated: string[]
  }
  autoRun?: boolean
  skeleton: string
  nodes: HmmNode[]
  published: string[]
  validation?: HmmResult & { inputVersion?: string }
  evidence?: EvidenceState
  deviceGrants?: DeviceGrant[]
  claimReviews?: HmmClaimReview[]
  history: { revision: number; action: string; nodeId?: string; actor: string; at: string }[]
}

/** 闭环中的一条等待边，区分显式数据前置与分组串行顺序。 */
export interface DependencyCycleLink { nodeId: string; dependencyId: string; kind: 'explicit' | 'serial' | 'both' }
/** 将领域错误与 HTTP 状态绑定，模型和客户端可据此重新读取或修正请求。 */
export class HmmError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 400,
    readonly cycle?: DependencyCycleLink[]) { super(message) }
}
