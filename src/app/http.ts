/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { WorkspaceError, type DevelopmentWorkspaces } from '../development/workspaces.ts'
import { DevelopmentChangeError, type DevelopmentChanges } from '../development/changes.ts'
import type { DevelopmentCandidates } from '../development/candidates.ts'
import type { CombinationChecks } from '../development/combination-checks.ts'
import type { AcceptanceBases } from '../development/acceptance-basis.ts'
import type { AcceptanceReports } from '../development/acceptance-reports.ts'
import { QualityProfileError, type DevelopmentQualityProfiles } from '../development/quality-profiles.ts'
import type { OptimizationSuggestions } from '../development/optimization-suggestions.ts'
import type { OptimizationReports } from '../development/optimization-reports.ts'
import type { DevelopmentExecutions } from '../development/executions.ts'
import { DevelopmentVersionSchema } from '../development/change-contracts.ts'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { CommandSchema, HMM_LIMITS, HmmError } from '../hmm/model.ts'
import { planHash, type HmmWorkflows } from '../hmm/workflow.ts'
import type { HmmDispatcher } from '../hmm/dispatcher.ts'
import { EvidenceInputSchema } from '../hmm/evidence.ts'
import { DeviceGrantSchema } from '../hmm/device-contracts.ts'
import type { HmmDevices } from '../hmm/devices.ts'
import { ClaimQuerySchema } from '../hmm/claims.ts'
import type { LocalTasks } from './local-tasks.ts'
import { buildInfo } from './build-info.ts'
import type { ControllerModelStatus } from './controller-model-status.ts'

export interface HttpHost {
  readonly developmentExecutions: Pick<DevelopmentExecutions, 'get' | 'contract'>
  readonly development: Pick<DevelopmentChanges, 'saveModule' | 'module' | 'save' | 'get' | 'related'>
  readonly developmentCandidates: Pick<DevelopmentCandidates, 'register' | 'get' | 'list' | 'prepare' | 'combination'>
  readonly combinationChecks: Pick<CombinationChecks, 'verify' | 'get'>
  readonly acceptanceBases: Pick<AcceptanceBases, 'preview' | 'decide' | 'get'>
  readonly acceptanceReports: Pick<AcceptanceReports, 'inspect'>
  readonly developmentQuality: Pick<DevelopmentQualityProfiles, 'save' | 'get' | 'preview' | 'verifySources' | 'verifyTools' | 'forTask' | 'verifyTaskSources'>
  readonly optimizationSuggestions: Pick<OptimizationSuggestions, 'save' | 'list' | 'decide'>
  readonly optimizationReports: Pick<OptimizationReports, 'list' | 'capture' | 'file'>
  readonly workspaces: Pick<DevelopmentWorkspaces, 'get' | 'list' | 'reserve' | 'command'>
  readonly tasks: Pick<LocalTasks, 'create' | 'input' | 'status' | 'list' | 'goal' | 'planChange' | 'resume' | 'blockers' | 'resultSources' | 'stop' | 'discuss'>
  readonly hmm: HmmWorkflows
  readonly hmmDispatcher?: Pick<HmmDispatcher, 'activeCount'>
  readonly hmmDevices: HmmDevices
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery' | 'controllerFailure'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'> & Partial<Pick<DshExecutor, 'slotUsage'>>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
  controllerModel(): Promise<ControllerModelStatus>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof HmmError && error.code === 'dependency_cycle' && error.cycle)
    return [error.status, { error: error.message, code: error.code, cycle: error.cycle }]
  if (error instanceof HmmError || error instanceof WorkspaceError || error instanceof DevelopmentChangeError
    || error instanceof QualityProfileError)
    return [error.status, { error: error.message, code: error.code }]
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, mode = 'repository', promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, mode, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  const usage = runtime.executor.slotUsage?.()
  return { build: buildInfo, setup: setupView(runtime), load: { ...executorLoad(runtime.store, usage?.running ?? runtime.executor.activeCount()),
    ...(usage ? { occupied: usage.occupied + (runtime.hmmDispatcher?.activeCount() ?? 0) } : {}),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health,
    controllerFailure: runtime.sessions.controllerFailure() }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; headers: IncomingMessage['headers']
  body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    // 展示偏好可被旧宿主忽略；显式查询保留原值与严格校验，不能借此扩大选择范围。
    'GET tasks': ({ query, headers }) => runtime.tasks.list({
      ...(headers['x-orchestrator-task-view'] === 'questions'
        ? { attention: 'questions', ...(query.state === 'needs_answer' ? { preview: 'question' } : {}) } : {}),
      ...query,
    }),
    'POST tasks': async ({ body }) => { await runtime.ready; return runtime.tasks.create(await body()) },
    'GET tasks/:id': ({ params }) => runtime.tasks.status(params.id),
    'GET tasks/:id/goal': ({ params, query }) => runtime.tasks.goal(params.id, query),
    'GET tasks/:id/plan-change': ({ params, query }) => runtime.tasks.planChange(params.id, query),
    'GET tasks/:id/blockers': ({ params, query }) => runtime.tasks.blockers(params.id, query),
    'GET tasks/:id/result-sources': ({ params, query }) => runtime.tasks.resultSources(params.id, query),
    'POST tasks/:id/inputs': async ({ params, body, headers }) => {
      await runtime.ready
      const input = await body()
      if (headers['x-orchestrator-task-view'] !== 'state') return runtime.tasks.input(params.id, input)
      return store.atomic(() => {
        const receipt = runtime.tasks.input(params.id, input)
        try { return { ...receipt, task: runtime.tasks.status(params.id) } }
        catch {
          // 保存与显示是不同事实；投影不可用明确返回空值，不因显示失败撤销输入。
          return { ...receipt, task: null }
        }
      })
    },
    'POST tasks/:id/resume': async ({ params, body }) => { await runtime.ready; return runtime.tasks.resume(params.id, await body()) },
    'POST tasks/:id/stop': ({ params }) => runtime.tasks.stop(params.id),
    'GET development/workspaces': ({ query }) => runtime.workspaces.list(query),
    'GET tasks/:id/quality': ({ params, query }) => runtime.developmentQuality.forTask(params.id, query),
    'GET tasks/:id/quality/suggestions': ({ params, query }) => runtime.optimizationSuggestions.list(params.id, query),
    'POST tasks/:id/quality/suggestions': async ({ params, body }) => {
      await runtime.ready
      return runtime.optimizationSuggestions.save(params.id, await body())
    },
    'POST tasks/:id/quality/suggestions/:suggestionId/decision': async ({ params, body }) => {
      await runtime.ready
      return runtime.optimizationSuggestions.decide(params.id, params.suggestionId, await body())
    },
    'GET tasks/:id/quality/suggestions/:suggestionId/reports': ({ params, query }) =>
      runtime.optimizationReports.list(params.id, params.suggestionId, query),
    'POST tasks/:id/quality/suggestions/:suggestionId/reports': async ({ params, body }) => {
      await runtime.ready
      return runtime.optimizationReports.capture(params.id, params.suggestionId, await body())
    },
    'GET tasks/:id/quality/suggestions/:suggestionId/reports/:reportId/file': ({ params, query }) =>
      runtime.optimizationReports.file(params.id, params.suggestionId, params.reportId, query),
    'POST tasks/:id/quality/verify-sources': async ({ params, body }) => {
      await runtime.ready
      return runtime.developmentQuality.verifyTaskSources(params.id, await body())
    },
    'POST tasks/:id/quality/verify-combination': async ({ params, body }) => {
      await runtime.ready
      return runtime.combinationChecks.verify(params.id, await body())
    },
    'GET tasks/:id/quality/combination-checks/:requestId': ({ params }) => runtime.combinationChecks.get(params.id, params.requestId),
    'GET tasks/:id/quality/acceptance': ({ params, query }) => runtime.acceptanceBases.preview(params.id, query),
    'POST tasks/:id/quality/acceptance': async ({ params, body }) => {
      await runtime.ready
      return runtime.acceptanceBases.decide(params.id, await body())
    },
    'GET tasks/:id/quality/acceptance/:basisId': ({ params }) => runtime.acceptanceBases.get(params.id, params.basisId),
    'POST tasks/:id/quality/check-report': async ({ params, body }) => {
      await runtime.ready
      return runtime.acceptanceReports.inspect(params.id, await body())
    },
    'GET development/execution-contract': () => runtime.developmentExecutions.contract(),
    'POST development/quality-profiles': async ({ body }) => { await runtime.ready; return runtime.developmentQuality.save(await body()) },
    'GET development/quality-profiles/:id': ({ params, query }) =>
      runtime.developmentQuality.get(params.id, DevelopmentVersionSchema.parse(query).revision),
    'POST development/quality-bindings/preview': async ({ body }) => { await runtime.ready; return runtime.developmentQuality.preview(await body()) },
    'POST development/quality-bindings/verify-sources': async ({ body }) => { await runtime.ready; return runtime.developmentQuality.verifySources(await body()) },
    'POST development/quality-bindings/verify-tools': async ({ body }) => { await runtime.ready; return runtime.developmentQuality.verifyTools(await body()) },
    'GET development/workspaces/:id': ({ params }) => runtime.workspaces.get(params.id),
    'GET development/workspaces/:id/execution': ({ params }) => ({ execution: runtime.developmentExecutions.get(params.id) }),
    'POST development/workspaces': async ({ body }) => { await runtime.ready; return runtime.workspaces.reserve(await body()) },
    'POST development/workspace-command': async ({ body }) => runtime.workspaces.command(await body()),
    'POST development/modules': async ({ body }) => { await runtime.ready; return runtime.development.saveModule(await body()) },
    'GET development/modules/:id': ({ params, query }) => runtime.development.module(params.id, DevelopmentVersionSchema.parse(query).revision),
    'PUT development/changes/:id': async ({ params, body }) => { await runtime.ready; return runtime.development.save(params.id, await body()) },
    'GET development/changes/:id': ({ params, query }) => runtime.development.get(params.id, DevelopmentVersionSchema.parse(query).revision),
    'GET development/changes/:id/related': ({ params, query }) => runtime.development.related(params.id, query),
    'POST development/changes/:id/candidates': async ({ params, body }) => {
      await runtime.ready
      return runtime.developmentCandidates.register(params.id, await body())
    },
    'GET development/changes/:id/candidates': ({ params, query }) => runtime.developmentCandidates.list(params.id, query),
    'GET development/candidates/:id': ({ params }) => runtime.developmentCandidates.get(params.id),
    'POST development/combinations': async ({ body }) => {
      await runtime.ready
      return runtime.developmentCandidates.prepare(await body())
    },
    'GET development/combinations/:id': ({ params }) => runtime.developmentCandidates.combination(params.id),
    'POST tasks/:id/discuss': async ({ params, body }) => { await runtime.ready; return runtime.tasks.discuss(params.id, await body()) },
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST tickets/:id/hmm': async ({ params, body }) => runtime.hmm.create({ role: 'controller' }, params.id, await body()),
    'POST tickets/:id/hmm/run': async ({ params, body }) => runtime.hmm.run({ role: 'controller' }, params.id, await body()),
    'GET tickets/:id/hmm': ({ params }) => runtime.hmm.view({ role: 'controller' }, params.id),
    'GET tickets/:id/hmm/plan': ({ params }) => {
      const definition = runtime.hmm.definition({ role: 'controller' }, params.id)
      return { ...definition, fingerprint: planHash(definition.plan), limits: { nodes: HMM_LIMITS.nodes } }
    },
    'GET tickets/:id/hmm/plan-identity': ({ params }) => runtime.hmm.planIdentity({ role: 'controller' }, params.id),
    'POST tickets/:id/hmm/revisions': async ({ params, body }) => runtime.hmm.revise({ role: 'controller' }, params.id, await body()),
    'GET tickets/:id/hmm/claims': ({ params, query }) => {
      const { nodeId, ...page } = z.object({ nodeId: z.string().min(1).max(64).optional(),
        offset: z.coerce.number().int().min(0).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(8).optional(),
        revision: z.coerce.number().int().positive().optional(),
      }).strict().parse(query)
      return runtime.hmm.claims({ role: 'controller' }, params.id, nodeId, ClaimQuerySchema.parse(page))
    },
    'GET hmm/devices': () => runtime.hmmDevices.status(),
    'POST tickets/:id/hmm/device-grants': async ({ params, body }) => {
      const request = z.object({ revision: z.number().int().positive(), grant: DeviceGrantSchema }).strict().parse(await body())
      return runtime.hmm.grantDevice({ role: 'controller' }, params.id, request.revision, request.grant)
    },
    'POST tickets/:id/hmm/device-grants/:grantId/revoke': async ({ params, body }) => {
      const request = z.object({ revision: z.number().int().positive() }).strict().parse(await body())
      return runtime.hmm.revokeDevice({ role: 'controller' }, params.id, request.revision, params.grantId)
    },
    'POST tickets/:id/hmm/evidence': async ({ params, body }) => {
      const request = z.object({ revision: z.number().int().positive(), document: EvidenceInputSchema }).strict().parse(await body())
      return runtime.hmm.importEvidence({ role: 'controller' }, params.id, request.revision, request.document)
    },
    'POST tickets/:id/hmm/evidence/:evidenceId/revoke': async ({ params, body }) => {
      const request = z.object({ revision: z.number().int().positive() }).strict().parse(await body())
      return runtime.hmm.revokeEvidence({ role: 'controller' }, params.id, request.revision, params.evidenceId)
    },
    'GET tickets/:id/hmm/nodes/:nodeId': ({ params }) => runtime.hmm.context({ role: 'controller' }, params.id, params.nodeId),
    'POST tickets/:id/hmm/commands': async ({ params, body }) => {
      const request = z.object({ revision: z.number().int().positive(), command: CommandSchema }).strict().parse(await body())
      return store.atomic(() => {
        const receipt = runtime.hmm.apply({ role: 'controller' }, params.id, request.revision, request.command)
        if (request.command.action === 'dispatch' || request.command.action === 'hold') {
          try {
            const ticket = store.tickets.get(params.id)
            if (ticket?.executionMode === 'hmm' && ticket.mandate.actor.source === 'local' && ticket.mandate.basis.via === 'operator')
              return { ...receipt, task: runtime.tasks.status(params.id) }
          } catch {
            // 可选的显示投影失败不阻止控制动作提交，尤其不能因此撤销暂停；客户端沿用原重读路径。
          }
        }
        return receipt
      })
    },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET models/controller': () => runtime.controllerModel(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, headers: req.headers,
          body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
