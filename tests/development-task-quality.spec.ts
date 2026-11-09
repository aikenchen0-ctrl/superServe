import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { DevelopmentChangeInput } from '../src/development/change-contracts.ts'
import type { QualityProfileInput } from '../src/development/quality-contracts.ts'
import { DevelopmentChanges } from '../src/development/changes.ts'
import { inspectDevelopmentSource } from '../src/development/inspect.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const configuration = '{"targets":["module"]}\n'
let directory: string, root: string, external: string
let source: Awaited<ReturnType<typeof inspectDevelopmentSource>>, other: typeof source
let h: Host, taskId: string
let module: ReturnType<Host['runtime']['development']['module']>
let profile: ReturnType<Host['runtime']['developmentQuality']['save']>['profile']
const git = async (path: string, ...args: string[]) => (await exec('git', [
  '-c', 'user.name=Quality task test', '-c', 'user.email=quality@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=disabled-hooks', '-C', path, ...args,
], { windowsHide: true, env: gitEnv() })).stdout.trim()
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'superserve-task-quality-'))
  root = join(directory, 'target'); external = join(directory, 'recipe')
  for (const path of [root, external]) {
    await mkdir(join(path, 'module'), { recursive: true })
    await writeFile(join(path, 'module', 'source.txt'), 'fixed\n')
    await writeFile(join(path, 'targets.json'), configuration)
    await git(path, 'init', '--initial-branch=main')
    await git(path, 'add', '.')
    await git(path, 'commit', '-m', 'fixture')
  }
  source = await inspectDevelopmentSource({ repository: root })
  other = await inspectDevelopmentSource({ repository: external })
})
const intent = (overrides: Partial<DevelopmentChangeInput> = {}): DevelopmentChangeInput => ({
  requestId: 'intent', revision: 0, worktreePath: root, baseCommit: source.source.commit,
  owner: 'module-agent', purpose: '保持模块行为并改进质量', modules: [{ id: module.id, revision: module.revision }],
  reads: ['module'], writes: ['module'], contracts: [], acceptance: ['保持外部行为'], ...overrides,
})
const definition = (overrides: Partial<QualityProfileInput> = {}): QualityProfileInput => ({
  requestId: 'profile', revision: 0, name: 'module-quality', module: { id: module.id, revision: module.revision },
  format: 'native-crap-v1',
  recipe: { repositoryId: module.repositoryId, commit: source.source.commit, tree: source.source.tree, path: '.' },
  configuration: { path: 'targets.json', sha256: sha(configuration) },
  tools: [{ name: 'crap', version: 'fixture', sha256: sha('tool') }],
  environment: { runtime: 'windows', architecture: 'x64' }, ...overrides,
})
const command = () => ({ changeRevision: 1, profileId: profile.id, profileRevision: profile.revision })
beforeEach(async () => {
  h = await startRuntime(undefined, { mode: 'hmm' })
  taskId = (await h.api('POST', 'tasks', { requestId: 'task', goal: '核对模块质量来源', dispatch: false })).body.ticketId as string
  module = (await h.runtime.development.saveModule({ requestId: 'module', revision: 0, repositoryPath: root,
    name: 'module', paths: ['module'], contracts: [], acceptance: ['保持外部行为'] })).module
  await h.runtime.development.save(taskId, intent())
  profile = h.runtime.developmentQuality.save(definition()).profile
})
afterEach(async () => { vi.restoreAllMocks(); await h.stop() })
afterAll(async () => {
  const target = resolve(directory)
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !target.split(sep).at(-1)!.startsWith('superserve-task-quality-'))
    throw new Error('测试目录边界不符')
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

it('任务查询给出有界关联配置；只读核验继承登记输入，不保存结果或污染开发进度', async () => {
  const before = h.runtime.store.db.prepare('SELECT count(*) AS n FROM kv').get()!.n
  const ticket = h.runtime.store.tickets.get(taskId)
  await writeFile(join(root, 'targets.json'), 'working progress\n')
  const listed = await h.api('GET', `tasks/${taskId}/quality`)
  expect(listed).toMatchObject({ status: 200, body: { state: 'registered', changeRevision: 1,
    source: { commit: source.source.commit }, total: 1, nextOffset: null,
    items: [{ id: profile.id, revision: 1, applicable: true, recipeRepositoryRequired: false }] } })
  expect(JSON.stringify(listed.body)).not.toContain(root)
  const checked = await h.api('POST', `tasks/${taskId}/quality/verify-sources`, command())
  expect(checked).toMatchObject({ status: 200, body: { ticketId: taskId, changeRevision: 1,
    persisted: false, currentProgressCaptured: false, assurance: { executionAuthorized: false, publishAllowed: false },
    binding: { source: { commit: source.source.commit } }, verification: { status: 'tracked_content_matched',
      configuration: { sha256: sha(configuration) } } } })
  expect(await readFile(join(root, 'targets.json'), 'utf8')).toBe('working progress\n')
  expect(h.runtime.store.db.prepare('SELECT count(*) AS n FROM kv').get()!.n).toBe(before)
  expect(h.runtime.store.tickets.get(taskId)).toEqual(ticket)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(h.runtime.workspaces.list().items).toEqual([])
})

it('尚未登记、未知任务与损坏的模块记录不能混成同一个空态', async () => {
  const id = (await h.api('POST', 'tasks', { requestId: 'new-task', goal: '尚未登记', dispatch: false })).body.ticketId
  expect(await h.api('GET', `tasks/${id}/quality`)).toMatchObject({ status: 200, body: { state: 'unregistered' } })
  expect(await h.api('GET', 'tasks/missing/quality')).toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  h.runtime.store.delete(`development:module:${module.id}`)
  expect(await h.api('GET', `tasks/${taskId}/quality`)).toMatchObject({ status: 404 })
})

it('不同模块配置不会混入任务；其他任务绑定同模块仍能复用配置', async () => {
  const second = (await h.runtime.development.saveModule({ requestId: 'other', revision: 0, repositoryPath: root,
    name: 'other', paths: ['module'], contracts: [], acceptance: ['其他模块验收'] })).module
  const unrelated = h.runtime.developmentQuality.save(definition({ requestId: 'unrelated',
    module: { id: second.id, revision: second.revision } })).profile
  const list = h.runtime.developmentQuality.forTask(taskId)
  expect(list).toMatchObject({ state: 'registered', total: 1, items: [{ id: profile.id }] })
  await expect(h.runtime.developmentQuality.verifyTaskSources(taskId, { ...command(), profileId: unrelated.id }))
    .rejects.toMatchObject({ code: 'quality_task_mismatch' })
  const peer = (await h.api('POST', 'tasks', { requestId: 'peer', goal: '同模块另一任务', dispatch: false })).body.ticketId as string
  await h.runtime.development.save(peer, intent({ requestId: 'peer-intent', owner: 'peer' }))
  expect(h.runtime.developmentQuality.forTask(peer)).toMatchObject({ total: 1, items: [{ id: profile.id }] })
})

it('同任务其他模块更新不阻止当前模块的独立来源核验', async () => {
  // 本用例改变登记关系，不改变 Git 输入；复用已核实输入，最终核验仍经真实 HTTP/Git。
  const declarations = new DevelopmentChanges(h.runtime.store, {
    available: () => true, inspect: async () => structuredClone(source),
  })
  const second = (await declarations.saveModule({ requestId: 'second', revision: 0, repositoryPath: root,
    name: 'second', paths: ['module'], contracts: [], acceptance: ['独立模块验收'] })).module
  await declarations.save(taskId, intent({ requestId: 'both', revision: 1,
    modules: [module, second].map(({ id, revision }) => ({ id, revision })) }))
  await declarations.saveModule({ requestId: 'second-updated', revision: 1, repositoryPath: root,
    name: 'second', paths: ['module'], contracts: [], acceptance: ['更新独立模块验收'] })
  expect(h.runtime.developmentQuality.forTask(taskId)).toMatchObject({ items: [{ applicable: true }] })
  expect(await h.api('POST', `tasks/${taskId}/quality/verify-sources`, { ...command(), changeRevision: 2 }))
    .toMatchObject({ status: 200, body: { verification: { status: 'tracked_content_matched' },
      assurance: { executionAuthorized: false, publishAllowed: false } } })
})

it('跨仓库配方只补充仓库位置，身份不匹配仍拒绝且路径不写入配置', async () => {
  const foreignModule = (await h.runtime.development.saveModule({ requestId: 'external', revision: 0, repositoryPath: external,
    name: 'recipe', paths: ['.'], contracts: [], acceptance: ['保持配方内容'] })).module
  profile = h.runtime.developmentQuality.save(definition({ requestId: 'external-profile', revision: 1,
    recipe: { repositoryId: foreignModule.repositoryId, commit: other.source.commit, tree: other.source.tree, path: '.' } })).profile
  expect(h.runtime.developmentQuality.forTask(taskId)).toMatchObject({ items: [{ recipeRepositoryRequired: true }] })
  expect(await h.api('POST', `tasks/${taskId}/quality/verify-sources`, command())).toMatchObject({ status: 400 })
  expect(await h.api('POST', `tasks/${taskId}/quality/verify-sources`, { ...command(), recipeRepositoryPath: root }))
    .toMatchObject({ status: 409, body: { code: 'quality_recipe_repository_mismatch' } })
  expect(await h.api('POST', `tasks/${taskId}/quality/verify-sources`, { ...command(), recipeRepositoryPath: external }))
    .toMatchObject({ status: 200, body: { verification: { status: 'tracked_content_matched' } } })
  expect(JSON.stringify(h.runtime.developmentQuality.get(profile.id))).not.toContain(external)
})

it('分页不丢配置，配置改版或任务起点变化使后续页失效', async () => {
  for (let i = 0; i < 9; i++)
    h.runtime.developmentQuality.save(definition({ requestId: `extra-${i}`, name: `extra-${i}` }))
  const first = h.runtime.developmentQuality.forTask(taskId)
  if (first.state !== 'registered') throw new Error('夹具未登记')
  expect(first.items).toHaveLength(8)
  const second = h.runtime.developmentQuality.forTask(taskId, { offset: first.nextOffset, snapshot: first.snapshot })
  expect(second).toMatchObject({ total: 10, nextOffset: null })
  if (second.state !== 'registered') throw new Error('夹具未登记')
  expect(new Set([...first.items, ...second.items].map(value => value.id)).size).toBe(10)
  h.runtime.developmentQuality.save(definition({ requestId: 'updated', revision: 1 }))
  expect(() => h.runtime.developmentQuality.forTask(taskId, { offset: 8, snapshot: first.snapshot }))
    .toThrow(expect.objectContaining({ code: 'quality_catalog_changed' }))
  expect(await h.api('GET', `tasks/${taskId}/quality?offset=8`)).toMatchObject({ status: 400 })
})

it.each(['change', 'profile', 'module'] as const)('核验结束前 %s 改版，丢弃旧绑定且不自动重试', async kind => {
  const quality = h.runtime.developmentQuality
  const original = quality.verifySources.bind(quality)
  const spy = vi.spyOn(quality, 'verifySources').mockImplementation(async input => {
    const result = await original(input)
    if (kind === 'change') await h.runtime.development.save(taskId, intent({ requestId: 'updated', revision: 1 }))
    else if (kind === 'profile') quality.save(definition({ requestId: 'updated', revision: 1 }))
    else await h.runtime.development.saveModule({ requestId: 'updated', revision: 1, repositoryPath: root,
      name: 'module', paths: ['module'], contracts: [], acceptance: ['修订验收依据'] })
    return result
  })
  expect(await h.api('POST', `tasks/${taskId}/quality/verify-sources`, command()))
    .toMatchObject({ status: 409, body: { code: kind === 'change' ? 'quality_change_changed'
      : kind === 'profile' ? 'quality_profile_changed' : 'quality_module_changed' } })
  expect(spy).toHaveBeenCalledOnce()
})

it('过时模块可见但不可核验；客户端不能替换任务提交或目标路径', async () => {
  await h.runtime.development.saveModule({ requestId: 'updated', revision: 1, repositoryPath: root,
    name: 'module', paths: ['module'], contracts: [], acceptance: ['修订验收依据'] })
  expect(h.runtime.developmentQuality.forTask(taskId)).toMatchObject({ items: [{ applicable: false }] })
  expect(await h.api('POST', `tasks/${taskId}/quality/verify-sources`, command())).toMatchObject({ status: 409 })
  for (const extra of [{ commit: other.source.commit }, { repositoryPath: external }, { changeRevision: 0 }])
    expect(await h.api('POST', `tasks/${taskId}/quality/verify-sources`, { ...command(), ...extra })).toMatchObject({ status: 400 })
})
