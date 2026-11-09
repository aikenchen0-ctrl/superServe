import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { DevelopmentChanges } from '../src/development/changes.ts'
import { inspectDevelopmentSource, InspectionError } from '../src/development/inspect.ts'
import type { DevelopmentChangeInput, DevelopmentModuleInput } from '../src/development/change-contracts.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const exec = promisify(execFile)
let directory: string, root: string, peerRoot: string, separate: string, commit: string
let h: Host, changes: DevelopmentChanges
const reports = new Map<string, Awaited<ReturnType<typeof inspectDevelopmentSource>>>()
const inspect = vi.fn<typeof inspectDevelopmentSource>()
const controller = { role: 'controller' as const }
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
const git = async (...args: string[]) => (await exec('git', [
  '-c', 'user.name=Development changes test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', '-C', root, ...args,
], { env, windowsHide: true })).stdout.trim()
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'superagent-changes-'))
  root = join(directory, 'author-a'); peerRoot = join(directory, 'author-b'); separate = join(directory, 'separate')
  await mkdir(root)
  await git('init', '--initial-branch=main')
  for (const name of ['messages', 'storage', 'transport']) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, 'source.txt'), `fixture ${name}\n`)
  }
  await git('add', '.')
  await git('commit', '-m', 'fixed source')
  commit = await git('rev-parse', 'HEAD')
  await git('worktree', 'add', '--detach', peerRoot, commit)
  await git('clone', '--no-hardlinks', root, separate)
  // 仅在夹具建立时读取真实 Git；领域反例重用已核实报告，实际 HTTP 测试继续调用真实检查器。
  for (const repository of [root, peerRoot, separate])
    reports.set(repository, await inspectDevelopmentSource({ repository }))
}, 30_000)
beforeEach(async () => {
  h = await startRuntime(undefined, { mode: 'hmm' })
  inspect.mockReset().mockImplementation(async args => {
    const report = reports.get(args.repository)
    if (!report || (args.revision && args.revision !== commit))
      throw new InspectionError('git_failed', '提交或目录不可读取')
    return structuredClone(report)
  })
  changes = new DevelopmentChanges(h.runtime.store, { available: () => true, inspect })
})
afterEach(async () => { vi.restoreAllMocks(); await h.stop() })
afterAll(async () => {
  const target = resolve(directory), parent = resolve(tmpdir())
  if (!target.startsWith(`${parent}${sep}`) || !target.split(sep).at(-1)!.startsWith('superagent-changes-'))
    throw new Error('Unsafe fixture cleanup')
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
const definition = (overrides: Partial<DevelopmentModuleInput> = {}): DevelopmentModuleInput => ({
  requestId: 'messages', revision: 0, repositoryPath: root, name: 'messages', paths: ['messages'],
  contracts: [{ name: 'message-format', version: 'v1' }], acceptance: ['消息在保存与读取后保持内容和身份。'], ...overrides,
})
async function task(requestId = 'task') {
  const response = await h.api('POST', 'tasks', { requestId, goal: '在既有授权内改进消息功能', dispatch: false })
  expect(response.status).toBe(200)
  return response.body.ticketId as string
}
function intent(module: { id: string; revision: number }, overrides: Partial<DevelopmentChangeInput> = {}): DevelopmentChangeInput {
  return { requestId: 'intent', revision: 0, worktreePath: root, baseCommit: commit,
    owner: 'author', purpose: '改进消息编辑', modules: [{ id: module.id, revision: module.revision }],
    reads: ['messages/source.txt'], writes: ['messages/editor.ts'],
    contracts: [{ name: 'message-format', version: 'v1', access: 'read' }], acceptance: ['编辑后仍保留原消息标识。'],
    ...overrides }
}

it('同模块多任务及跨模块任务允许并行登记，不占目录、不修改目标、权限或调度', async () => {
  const a = await task('a'), b = await task('b')
  const m = (await changes.saveModule(definition())).module
  const storage = (await changes.saveModule(definition({ name: 'storage', requestId: 'storage', paths: ['storage'] }))).module
  const tickets = [a, b].map(id => h.runtime.store.tickets.get(id))
  const workflows = [a, b].map(id => h.runtime.store.get(KV.hmm.workflow(id)))
  await changes.save(a, intent(m, { modules: [m, storage].map(({ id, revision }) => ({ id, revision })),
    reads: ['storage/source.txt'], writes: ['messages/ui.ts'] }))
  await changes.save(b, intent(m, { worktreePath: peerRoot, writes: ['messages/reply.ts'] }))
  const related = changes.related(a)
  expect(related.items).toEqual([expect.objectContaining({ ticketId: b, compatibility: 'unassessed', reasons: ['same_module', 'shared_contract'] })])
  expect(changes.get(a).modules.map(ref => ref.id)).toEqual([m.id, storage.id])
  expect([a, b].map(id => h.runtime.store.tickets.get(id))).toEqual(tickets)
  expect([a, b].map(id => h.runtime.store.get(KV.hmm.workflow(id)))).toEqual(workflows)
  expect(h.runtime.workspaces.list().items).toHaveLength(0)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(related.dependencyAnalysisComplete).toBe(false)
})

it('不同路径模块共享契约仍可发现，同一模块提示不冒充写冲突；读写、写写关联分别保留', async () => {
  const a = await task('writer'), b = await task('reader'), c = await task('overlap')
  const m = (await changes.saveModule(definition())).module
  const transport = (await changes.saveModule(definition({ requestId: 'transport', name: 'transport', paths: ['transport'] }))).module
  await changes.save(a, intent(m, { writes: ['messages/source.txt'], contracts: [{ name: 'message-format', version: 'v1', access: 'write' }] }))
  await changes.save(b, intent(transport, { worktreePath: peerRoot, reads: ['transport/source.txt'], writes: ['transport/sender.ts'] }))
  await changes.save(c, intent(m, { worktreePath: peerRoot, writes: ['messages/source.txt'] }))
  const result = changes.related(a)
  expect(result.items.find(item => item.ticketId === b)?.reasons).toEqual(['shared_contract'])
  expect(result.items.find(item => item.ticketId === c)?.reasons)
    .toEqual(expect.arrayContaining(['same_module', 'write_overlap', 'read_write_overlap', 'shared_contract']))
  expect(result.items.every(item => item.compatibility === 'unassessed')).toBe(true)
})

it('模块版本更新后保留旧验收原文，旧绑定显式过期，不能自动套用新契约', async () => {
  const a = await task('a'), b = await task('b')
  const m = (await changes.saveModule(definition())).module
  await changes.save(a, intent(m))
  const updated = (await changes.saveModule(definition({ requestId: 'module-update', revision: 1,
    contracts: [{ name: 'message-format', version: 'v2' }], acceptance: ['新的版本化验收要求。'] }))).module
  expect(changes.get(a)).toMatchObject({ moduleDeclarationsChanged: true, modules: [{ revision: 1, currentRevision: 2 }] })
  expect(changes.read(a, { view: 'module', moduleId: m.id })).toEqual(m)
  await expect(changes.save(b, intent(m))).rejects.toMatchObject({ code: 'module_changed' })
  await changes.save(b, intent(updated, { contracts: [{ name: 'message-format', version: 'v2', access: 'write' }] }))
  expect(changes.related(a).items[0]!.reasons).toContain('contract_version_difference')
  expect(changes.module(m.id, 1).acceptance).toEqual(m.acceptance)
  expect(changes.read(a, {})).not.toHaveProperty('change.worktreePath')
})

it('同一版本并发修改仅接受一个，重复请求返回精确历史且重启后不重开已结束任务', async () => {
  const id = await task()
  const moduleInput = definition(), m = (await changes.saveModule(moduleInput)).module
  const firstInput = intent(m)
  const first = await changes.save(id, firstInput)
  expect(await changes.saveModule(moduleInput)).toEqual({ created: false, module: m })
  const candidates = [{ ...firstInput, requestId: 'r2-a', revision: 1, purpose: '改进 A' },
    { ...firstInput, requestId: 'r2-b', revision: 1, purpose: '改进 B' }]
  const updates = await Promise.allSettled(candidates.map(input => changes.save(id, input)))
  expect(updates.filter(update => update.status === 'fulfilled')).toHaveLength(1)
  const current = changes.get(id)
  expect(current.change.revision).toBe(2)
  expect(await changes.save(id, firstInput)).toEqual({ ...first, created: false })
  expect(changes.get(id)).toEqual(current)
  await expect(changes.save(id, { ...firstInput, purpose: '另一种内容' })).rejects.toMatchObject({ code: 'request_conflict' })
  await h.api('POST', `tasks/${id}/stop`)
  await h.restart()
  changes = new DevelopmentChanges(h.runtime.store, { available: () => true, inspect })
  expect(await changes.save(id, firstInput)).toEqual({ ...first, created: false })
  await expect(changes.save(id, { ...firstInput, requestId: 'after-stop', revision: 2 })).rejects.toMatchObject({ code: 'ticket_inactive' })
  expect(changes.get(id)).toMatchObject({ ended: true, change: { revision: 2 } })
})

it('事务保存失败不留下半份历史、请求回执或目录版本，原请求可重试', async () => {
  const id = await task(), m = (await changes.saveModule(definition())).module
  await changes.save(id, intent(m))
  const before = changes.related(id), initial = changes.get(id)
  const original = h.runtime.store.set.bind(h.runtime.store)
  const failing = vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => {
    original(key, value)
    if (String(key) === 'development:change-catalog-revision') throw new Error('simulated commit failure')
  })
  const revised = intent(m, { requestId: 'retry', revision: 1, writes: ['messages/new.ts'] })
  await expect(changes.save(id, revised)).rejects.toThrow('simulated commit failure')
  failing.mockRestore()
  expect(changes.get(id)).toEqual(initial)
  expect(changes.related(id)).toEqual(before)
  expect(() => changes.get(id, 2)).toThrow('开发声明不存在')
  expect((await changes.save(id, revised)).created).toBe(true)
})

it('分页带关系快照；新声明和任务终态变化均拒绝旧后续页，重复查询无副作用', async () => {
  const a = await task('a'), b = await task('b'), c = await task('c')
  const m = (await changes.saveModule(definition())).module
  for (const id of [a, b, c]) await changes.save(id, intent(m))
  const page = changes.related(a, { limit: 1 })
  expect(page.total).toBe(2); expect(page.nextOffset).toBe(1)
  const next = changes.related(a, { limit: 1, offset: 1, snapshot: page.snapshot })
  expect(next.items[0]!.ticketId).not.toBe(page.items[0]!.ticketId)
  expect(next.nextOffset).toBeNull()
  expect(changes.related(a, { limit: 1 })).toEqual(page)
  expect(() => changes.related(a, { offset: 1 })).toThrow()
  await h.api('POST', `tasks/${b}/stop`)
  expect(() => changes.related(a, { offset: 1, snapshot: page.snapshot })).toThrow('关联范围或任务状态已更新')
  const fresh = changes.related(a)
  expect(fresh.items.find(item => item.ticketId === b)?.ended).toBe(true)
  await changes.save(c, intent(m, { requestId: 'update', revision: 1, writes: ['messages/c.ts'] }))
  expect(() => changes.related(a, { offset: 1, snapshot: fresh.snapshot })).toThrow('关联范围或任务状态已更新')
})

it('范围、输入身份和本地任务边界不可通过调用方声明扩张', async () => {
  const id = await task(), m = (await changes.saveModule(definition())).module
  const invalid = [
    intent(m, { writes: ['../outside'] }), intent(m, { writes: ['C:/secret'] }),
    intent(m, { writes: ['messages/.git/config'] }), intent(m, { writes: ['storage/source.txt'] }),
    intent(m, { contracts: [{ name: 'undeclared', version: 'v1', access: 'write' }] }),
    intent(m, { baseCommit: 'main' }), { ...intent(m), dispatch: true },
  ]
  for (const input of invalid) await expect(changes.save(id, input)).rejects.toThrow()
  await expect(changes.save(id, intent(m, { baseCommit: '0'.repeat(40) }))).rejects.toMatchObject({ code: 'git_failed' })
  await expect(changes.save(id, intent(m, { worktreePath: separate }))).rejects.toMatchObject({ code: 'repository_mismatch' })
  const foreign = h.runtime.store.tickets.get(id)!
  h.runtime.store.tickets.save({ ...foreign, mandate: { ...foreign.mandate, actor: { ...foreign.mandate.actor, source: 'github' } } })
  await expect(changes.save(id, intent(m))).rejects.toMatchObject({ code: 'scope_denied' })
  expect(() => changes.get(id)).toThrow('本地 HMM')
  await expect(changes.save('missing', intent(m))).rejects.toMatchObject({ code: 'ticket_missing' })
  expect(h.runtime.workspaces.list().items).toHaveLength(0)
})

it('异步 Git 核验之后再次确认权限与终态，陈旧检查不能写入新声明', async () => {
  const id = await task(), m = (await changes.saveModule(definition())).module
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof inspectDevelopmentSource>>>()
  inspect.mockImplementationOnce(() => pending.promise)
  const saving = changes.save(id, intent(m))
  await h.api('POST', `tasks/${id}/stop`)
  pending.resolve(reports.get(root)!)
  await expect(saving).rejects.toMatchObject({ code: 'ticket_inactive' })
  expect(() => changes.get(id)).toThrow('开发声明不存在')
})

it('Git 检查等待期间模块被改版，旧声明不能被异步结果提交成新意图', async () => {
  const id = await task(), m = (await changes.saveModule(definition())).module
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof inspectDevelopmentSource>>>()
  inspect.mockImplementationOnce(() => pending.promise)
  const saving = changes.save(id, intent(m))
  await changes.saveModule(definition({ requestId: 'concurrent-module', revision: 1, paths: ['messages', 'storage'] }))
  pending.resolve(reports.get(root)!)
  await expect(saving).rejects.toMatchObject({ code: 'module_changed' })
  expect(() => changes.get(id)).toThrow('开发声明不存在')
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('相似路径前缀不误报写重叠，允许读写范围扩展到已登记的其他模块并保留旧意图', async () => {
  const a = await task('a'), b = await task('b')
  const broad = (await changes.saveModule(definition({ paths: ['.'] }))).module
  await changes.save(a, intent(broad, { reads: [], writes: ['src/message'], contracts: [] }))
  await changes.save(b, intent(broad, { reads: [], writes: ['src/messages'], contracts: [] }))
  expect(changes.related(a).items[0]!.reasons).toEqual(['same_module'])
  const updated = await changes.save(b, intent(broad, {
    revision: 1, requestId: 'move-into-message', reads: ['src/message/storage.ts'], writes: ['src/other.ts'], contracts: [],
  }))
  expect(updated.change.revision).toBe(2)
  expect(changes.related(a).items[0]!.reasons).toEqual(['same_module', 'read_write_overlap'])
  expect(changes.get(b, 1).change.writes).toEqual(['src/messages'])
})

it('无关系线索不证明独立，任务变为非本地后不泄露其登记摘要', async () => {
  const a = await task('a'), b = await task('b'), c = await task('c')
  const m = (await changes.saveModule(definition())).module
  const storage = (await changes.saveModule(definition({ name: 'storage', requestId: 'storage', paths: ['storage'], contracts: [] }))).module
  await changes.save(a, intent(m))
  await changes.save(b, intent(storage, { reads: [], writes: ['storage/a.ts'], contracts: [] }))
  await changes.save(c, intent(m))
  expect(changes.related(a)).toMatchObject({ dependencyAnalysisComplete: false, total: 1 })
  const ticket = h.runtime.store.tickets.get(c)!
  h.runtime.store.tickets.save({ ...ticket, mandate: { ...ticket.mandate, actor: { ...ticket.mandate.actor, source: 'github' } } })
  expect(changes.related(a)).toMatchObject({ total: 0, items: [], compatibility: 'unassessed' })
})

it('有界声明与页参数不能通过 Unicode、超量字段或重复模块绕过', async () => {
  const id = await task(), m = (await changes.saveModule(definition())).module
  await expect(changes.save(id, intent(m, { modules: [m, m] }))).rejects.toThrow()
  const paths = Array.from({ length: 32 }, (_, i) => `messages/${i}${'资'.repeat(480)}`)
  await expect(changes.save(id, intent(m, { reads: paths, writes: paths })))
    .rejects.toMatchObject({ code: 'declaration_budget' })
  await changes.save(id, intent(m))
  expect(() => changes.related(id, { limit: 21 })).toThrow()
  expect(() => changes.read(id, { view: 'module', moduleId: '0'.repeat(64) })).toThrow('只能读取')
  expect(() => changes.read(id, { offset: 0 })).toThrow('分页只适用于')
  expect(() => changes.read(id, { view: 'related', limit: 9 })).toThrow()
})

it('真实管理 API 核实 Git 并装配总管只读工具，读声明不复制进度、占目录或启动节点', async () => {
  const id = await task(), m = (await changes.saveModule(definition())).module
  const index = await readFile(join(root, '.git', 'index'))
  const response = await h.api('PUT', `development/changes/${id}`, intent(m, { worktreePath: peerRoot }))
  expect(response).toMatchObject({ status: 200, body: { created: true, candidateAccepted: false,
    executionAuthorized: false, progressCaptured: false, change: { source: { commit }, worktreePath: reports.get(peerRoot)!.workspace!.root } } })
  const read = await h.runTool(h.runtime.masterId, 'hmm_development_read', { ticket_id: id })
  expect(read).toMatchObject({ change: { source: { commit } }, compatibility: 'unassessed' })
  expect(read).not.toHaveProperty('change.worktreePath')
  expect(await h.runTool(h.runtime.masterId, 'hmm_development_read', { ticket_id: id, view: 'module', moduleId: m.id })).toEqual(m)
  expect(await h.api('GET', `development/changes/${id}/related`)).toMatchObject({ status: 200, body: { items: [] } })
  expect(await readFile(join(root, '.git', 'index'))).toEqual(index)
  expect(h.runtime.workspaces.list().items).toHaveLength(0)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  const workflow = h.runtime.hmm.view(controller, id)
  h.runtime.hmm.apply(controller, id, workflow.revision, { action: 'dispatch' })
  await h.runtime.idle()
  const node = h.runtime.hmm.view(controller, id).nodes.find(node => node.mode === 'task' && node.state === 'running')!
  expect(h.tools.get(node.sessionId!)?.has('hmm_development_read')).toBe(false)
  await expect(h.runTool(h.runtime.masterId, 'hmm_development_read', { ticket_id: id, path: 'private' })).rejects.toThrow()
})

it('模块管理 API 使用真实固定仓库，旧版本与额外查询字段拒绝，原历史可回读', async () => {
  const result = await h.api('POST', 'development/modules', definition())
  expect(result.status).toBe(200)
  const m = result.body.module as { id: string; revision: number }
  expect(await h.api('GET', `development/modules/${m.id}?revision=1`))
    .toMatchObject({ status: 200, body: { id: m.id, revision: 1 } })
  expect(await h.api('GET', `development/modules/${m.id}?revision=0`)).toMatchObject({ status: 400 })
  expect(await h.api('GET', `development/modules/${m.id}?path=secret`)).toMatchObject({ status: 400 })
  expect(await h.api('POST', 'development/modules', definition({ requestId: 'stale' })))
    .toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})
