/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ControllerModelStatus } from './controller-model-status.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { HmmCommand, PlanInput, RunInput } from '../hmm/model.ts'
import type { HmmWorkflows } from '../hmm/workflow.ts'
import type { EvidenceInput } from '../hmm/evidence.ts'
import type { DeviceGrant } from '../hmm/device-contracts.ts'
import type { HmmDevices } from '../hmm/devices.ts'
import type { LocalTaskInput, LocalTaskContextInput, LocalTaskDiscussionInput, LocalTaskResumeInput, LocalTaskListQuery, LocalTaskBlockersQuery, LocalTaskResultSourcesQuery, LocalTaskPlanVersionQuery, LocalTasks } from './local-tasks.ts'
import type { DevelopmentWorkspaces, WorkspaceRequest, WorkspaceCommand } from '../development/workspaces.ts'
import type { DevelopmentChanges } from '../development/changes.ts'
import type { DevelopmentCandidates, CandidateInput, CombinationInput } from '../development/candidates.ts'
import type { CombinationChecks, CombinationCheckInput } from '../development/combination-checks.ts'
import type { AcceptanceBases, AcceptanceDecision } from '../development/acceptance-basis.ts'
import type { AcceptanceReports, AcceptanceReportInput } from '../development/acceptance-reports.ts'
import type { DevelopmentQualityProfiles } from '../development/quality-profiles.ts'
import type { OptimizationSuggestions, OptimizationInput, OptimizationDecision, OptimizationQuery } from '../development/optimization-suggestions.ts'
import type { OptimizationReports, OptimizationReportInput, OptimizationReportFileQuery } from '../development/optimization-reports.ts'
import type { QualityProfileInput, QualityBindingInput, QualitySourceInput, QualityToolInput, TaskQualityQuery, TaskQualitySourceInput } from '../development/quality-contracts.ts'
import type { DevelopmentExecutions } from '../development/executions.ts'
import type { DevelopmentModuleInput, DevelopmentChangeInput, DevelopmentRelatedQuery } from '../development/change-contracts.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'POST development/modules': { body: DevelopmentModuleInput; response: Awaited<ReturnType<DevelopmentChanges['saveModule']>> }
  'GET development/modules/:id': { query?: { revision?: number }; response: ReturnType<DevelopmentChanges['module']> }
  'POST development/quality-profiles': { body: QualityProfileInput; response: ReturnType<DevelopmentQualityProfiles['save']> }
  'GET development/quality-profiles/:id': { query?: { revision?: number }; response: ReturnType<DevelopmentQualityProfiles['get']> }
  'POST development/quality-bindings/preview': { body: QualityBindingInput; response: Awaited<ReturnType<DevelopmentQualityProfiles['preview']>> }
  'POST development/quality-bindings/verify-sources': { body: QualitySourceInput; response: Awaited<ReturnType<DevelopmentQualityProfiles['verifySources']>> }
  'POST development/quality-bindings/verify-tools': { body: QualityToolInput; response: Awaited<ReturnType<DevelopmentQualityProfiles['verifyTools']>> }
  'PUT development/changes/:id': { body: DevelopmentChangeInput; response: Awaited<ReturnType<DevelopmentChanges['save']>> }
  'GET development/changes/:id': { query?: { revision?: number }; response: ReturnType<DevelopmentChanges['get']> }
  'GET development/changes/:id/related': { query?: DevelopmentRelatedQuery; response: ReturnType<DevelopmentChanges['related']> }
  'POST development/changes/:id/candidates': { body: CandidateInput; response: Awaited<ReturnType<DevelopmentCandidates['register']>> }
  'GET development/changes/:id/candidates': { query?: Paged & { snapshot?: string }; response: ReturnType<DevelopmentCandidates['list']> }
  'GET development/candidates/:id': { response: ReturnType<DevelopmentCandidates['get']> }
  'POST development/combinations': { body: CombinationInput; response: Awaited<ReturnType<DevelopmentCandidates['prepare']>> }
  'GET development/combinations/:id': { response: ReturnType<DevelopmentCandidates['combination']> }
  'GET development/workspaces': { query?: { offset?: number; limit?: number }; response: ReturnType<DevelopmentWorkspaces['list']> }
  'GET development/execution-contract': { response: ReturnType<DevelopmentExecutions['contract']> }
  'GET development/workspaces/:id': { response: ReturnType<DevelopmentWorkspaces['get']> }
  'GET development/workspaces/:id/execution': { response: { execution: ReturnType<DevelopmentExecutions['get']> } }
  'POST development/workspaces': { body: WorkspaceRequest; response: Awaited<ReturnType<DevelopmentWorkspaces['reserve']>> }
  'POST development/workspace-command': { body: WorkspaceCommand; response: ReturnType<DevelopmentWorkspaces['command']> }
  'GET tasks': { query?: LocalTaskListQuery; headers?: { 'x-orchestrator-task-view': 'questions' };
    response: ReturnType<LocalTasks['list']> }
  'POST tasks': { body: LocalTaskInput; response: ReturnType<LocalTasks['create']> }
  'GET tasks/:id': { response: ReturnType<LocalTasks['status']> }
  'GET tasks/:id/quality': { query?: TaskQualityQuery; response: ReturnType<DevelopmentQualityProfiles['forTask']> }
  'GET tasks/:id/quality/suggestions': { query?: OptimizationQuery; response: ReturnType<OptimizationSuggestions['list']> }
  'POST tasks/:id/quality/suggestions': { body: OptimizationInput; response: ReturnType<OptimizationSuggestions['save']> }
  'POST tasks/:id/quality/suggestions/:suggestionId/decision': { body: OptimizationDecision; response: ReturnType<OptimizationSuggestions['decide']> }
    'GET tasks/:id/quality/suggestions/:suggestionId/reports': { query?: TaskQualityQuery; response: ReturnType<OptimizationReports['list']> }
    'POST tasks/:id/quality/suggestions/:suggestionId/reports': { body: OptimizationReportInput; response: Awaited<ReturnType<OptimizationReports['capture']>> }
    'GET tasks/:id/quality/suggestions/:suggestionId/reports/:reportId/file': { query: OptimizationReportFileQuery; response: ReturnType<OptimizationReports['file']> }
  'POST tasks/:id/quality/verify-sources': { body: TaskQualitySourceInput; response: Awaited<ReturnType<DevelopmentQualityProfiles['verifyTaskSources']>> }
  'POST tasks/:id/quality/verify-combination': { body: CombinationCheckInput; response: Awaited<ReturnType<CombinationChecks['verify']>> }
  'GET tasks/:id/quality/combination-checks/:requestId': { response: ReturnType<CombinationChecks['get']> }
  'GET tasks/:id/quality/acceptance': { query: { sourceCheckId: string }; response: ReturnType<AcceptanceBases['preview']> }
  'POST tasks/:id/quality/acceptance': { body: AcceptanceDecision; response: ReturnType<AcceptanceBases['decide']> }
  'GET tasks/:id/quality/acceptance/:basisId': { response: ReturnType<AcceptanceBases['get']> }
  'POST tasks/:id/quality/check-report': { body: AcceptanceReportInput; response: Awaited<ReturnType<AcceptanceReports['inspect']>> }
  'GET tasks/:id/goal': { query: LocalTaskPlanVersionQuery; response: ReturnType<LocalTasks['goal']> }
  'GET tasks/:id/plan-change': { query: LocalTaskPlanVersionQuery; response: ReturnType<LocalTasks['planChange']> }
  'GET tasks/:id/blockers': { query: LocalTaskBlockersQuery; response: ReturnType<LocalTasks['blockers']> }
  'GET tasks/:id/result-sources': { query: LocalTaskResultSourcesQuery; response: ReturnType<LocalTasks['resultSources']> }
  'POST tasks/:id/inputs': { body: LocalTaskContextInput; headers?: { 'x-orchestrator-task-view': 'state' };
    response: ReturnType<LocalTasks['input']> & { task?: ReturnType<LocalTasks['status']> | null } }
  'POST tasks/:id/resume': { body: LocalTaskResumeInput; response: ReturnType<LocalTasks['resume']> }
  'POST tasks/:id/stop': { response: ReturnType<LocalTasks['stop']> }
  'POST tasks/:id/discuss': { body: LocalTaskDiscussionInput; response: Awaited<ReturnType<LocalTasks['discuss']>> }
  'GET hmm/devices': { response: ReturnType<HmmDevices['status']> }
  'POST tickets/:id/hmm/device-grants': {
    body: { revision: number; grant: Omit<DeviceGrant, 'generation' | 'revoked' | 'includeRestricted'> & { includeRestricted?: boolean } }
    response: ReturnType<HmmWorkflows['grantDevice']>
  }
  'POST tickets/:id/hmm/device-grants/:grantId/revoke': {
    body: { revision: number }; response: ReturnType<HmmWorkflows['revokeDevice']>
  }
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST tickets/:id/hmm': { body: PlanInput; response: ReturnType<HmmWorkflows['create']> }
  'POST tickets/:id/hmm/run': { body: RunInput; response: ReturnType<HmmWorkflows['run']> }
  'GET tickets/:id/hmm': { response: ReturnType<HmmWorkflows['view']> }
  'GET tickets/:id/hmm/claims': {
    query?: { nodeId?: string; offset?: number; limit?: number; revision?: number }
    response: ReturnType<HmmWorkflows['claims']>
  }
  'GET tickets/:id/hmm/plan': {
    response: ReturnType<HmmWorkflows['definition']> & { fingerprint?: string; limits?: { nodes: number } }
  }
  'GET tickets/:id/hmm/plan-identity': { response: ReturnType<HmmWorkflows['planIdentity']> }
  'POST tickets/:id/hmm/revisions': {
    body: { revision: number; plan: PlanInput; reason: string; preview?: boolean }
    response: ReturnType<HmmWorkflows['revise']>
  }
  'GET tickets/:id/hmm/nodes/:nodeId': { response: ReturnType<HmmWorkflows['context']> }
  'POST tickets/:id/hmm/commands': {
    body: { revision: number; command: HmmCommand }
    response: ReturnType<HmmWorkflows['apply']> & { task?: ReturnType<LocalTasks['status']> }
  }
  'POST tickets/:id/hmm/evidence': { body: { revision: number; document: EvidenceInput }; response: ReturnType<HmmWorkflows['importEvidence']> }
  'POST tickets/:id/hmm/evidence/:evidenceId/revoke': { body: { revision: number }; response: ReturnType<HmmWorkflows['revokeEvidence']> }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET models/controller': { response: ControllerModelStatus }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
