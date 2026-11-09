import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { DevelopmentChanges } from '../src/development/changes.ts'
import { inspectDevelopmentSource } from '../src/development/inspect.ts'
import { OptimizationSuggestions } from '../src/development/optimization-suggestions.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let directory: string, root: string, h: Host, taskId: string, declarations: DevelopmentChanges
let source: Awaited<ReturnType<typeof inspectDevelopmentSource>>, secondSource: typeof source
let module: ReturnType<DevelopmentChanges['module']>
let profile: ReturnType<Host['runtime']['developmentQuality']['save']>['profile']
const git = async (...args: string[]) => (await exec('git', ['-c', 'user.name=Suggestion test',
  '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks',
  '-C', root, ...args], { env: gitEnv(), windowsHide: true })).stdout.trim()
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'superserve-suggestions-'))
  root = join(directory, 'source')
  await mkdir(root)
  await writeFile(join(root, 'source.txt'), 'first\n')
  await git('init', '--initial-branch=main'); await git('add', '.'); await git('commit', '-m', 'first')
  source = await inspectDevelopmentSource({ repository: root })
  await writeFile(join(root, 'source.txt'), 'second\n')
  await git('add', '.'); await git('commit', '-m', 'second')
  secondSource = await inspectDevelopmentSource({ repository: root })
})
const moduleInput = (revision = 0) => ({ requestId: `module-${revision}`, revision, repositoryPath: root,
  name: 'module', paths: ['.'], contracts: [], acceptance: ['保持已有行为'] })
const intent = (revision = 0) => ({ requestId: `intent-${revision}`, revision, worktreePath: root,
  baseCommit: source.source.commit, owner: 'module-owner', purpose: '改进模块质量',
  modules: [{ id: module.id, revision: module.revision }], reads: ['source.txt'], writes: ['source.txt'],
  contracts: [], acceptance: ['保持已有行为'] })
const profileInput = (revision = 0) => ({ requestId: `profile-${revision}`, revision, name: 'quality',
  module: { id: module.id, revision: module.revision }, format: 'native-crap-v1',
  recipe: { repositoryId: module.repositoryId, commit: source.source.commit, tree: source.source.tree, path: '.' },
  configuration: { path: 'targets.json', sha256: 'a'.repeat(64) },
  tools: [{ name: 'crap', version: 'test', sha256: 'b'.repeat(64) }],
  environment: { runtime: 'windows', architecture: 'x64' } })
const input = () => ({ changeRevision: 1, profileId: profile.id, profileRevision: profile.revision,
  finding: '取消分支缺少反例覆盖，尚未验证是否为产品缺陷。',
  proposal: '先补取消场景，再决定是否简化嵌套逻辑。',
  validation: '保留原验收与统计范围，核对取消后的外部行为。' })
beforeEach(async () => {
  h = await startRuntime(undefined, { mode: 'hmm' })
  // 登记测试复用两份真实固定输入，避免为每次元数据变化重复启动 Git。
  declarations = new DevelopmentChanges(h.runtime.store, { available: () => true,
    inspect: async args => structuredClone(args.revision === secondSource.source.commit ? secondSource : source) })
  taskId = (await h.api('POST', 'tasks', { requestId: 'task', goal: '改进模块质量', dispatch: false })).body.ticketId as string
  module = (await declarations.saveModule(moduleInput())).module
  await declarations.save(taskId, intent())
  profile = h.runtime.developmentQuality.save(profileInput()).profile
})
afterEach(async () => { vi.restoreAllMocks(); await h.stop() })
afterAll(async () => {
  const target = resolve(directory)
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !target.split(sep).at(-1)!.startsWith('superserve-suggestions-'))
    throw new Error('测试目录边界不符')
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
const service = () => h.runtime.optimizationSuggestions

it('HTTP 登记只保存声明；任务、执行占用和源码不变，重启保留正文及依据', async () => {
  const task = h.runtime.store.tickets.get(taskId)
  const created = await h.api('POST', `tasks/${taskId}/quality/suggestions`, input())
  expect(created).toMatchObject({ status: 200, body: { created: true, revision: 1, disposition: 'open',
    applicability: { state: 'matches_registration', reasons: [] },
    assurance: { proposalOnly: true, evidenceVerified: false, executionAuthorized: false, publishAllowed: false } } })
  const listed = service().list(taskId)
  expect(listed.items).toHaveLength(1)
  expect(await h.api('GET', `tasks/${taskId}/quality/suggestions`)).toEqual({ status: 200, body: listed })
  expect(await h.api('POST', `tasks/${taskId}/quality/suggestions/${listed.items[0]!.suggestion.id}/decision`,
    { revision: 1, action: 'defer' })).toMatchObject({ status: 200, body: { changed: true, revision: 2, disposition: 'deferred' } })
  expect(JSON.stringify(listed)).not.toContain(root)
  expect(h.runtime.store.tickets.get(taskId)).toEqual(task)
  expect(h.runtime.workspaces.list().items).toEqual([])
  expect(h.nodeFactory).not.toHaveBeenCalled()
  const after = service().list(taskId)
  await h.restart()
  expect(service().list(taskId)).toEqual(after)
})

it('重复正文与必要输入只生成一个建议；新请求不恢复已暂缓项', () => {
  const first = service().save(taskId, input())
  const deferred = service().decide(taskId, first.suggestion.id, { revision: 1, action: 'defer' })
  const replay = service().save(taskId, { ...input(), finding: ` ${input().finding} ` })
  const { changed: _, ...view } = deferred
  expect(replay).toEqual({ created: false, ...view })
  expect(service().list(taskId).total).toBe(1)
})

it('负责人更换不会重复生成建议，也不会误判为过期', async () => {
  const first = service().save(taskId, input())
  await declarations.save(taskId, { ...intent(1), owner: 'next-owner' })
  const next = service().save(taskId, { ...input(), changeRevision: 2 })
  expect(next.suggestion.id).toBe(first.suggestion.id)
  expect(next.created).toBe(false)
  expect(next.applicability.state).toBe('matches_registration')
  expect(next.suggestion.binding.changeRevision).toBe(1)
})

it('等价的范围顺序不产生新建议；不相关模块改版不使所选模块建议过期', async () => {
  const other = (await declarations.saveModule({ ...moduleInput(), requestId: 'other-module', name: 'other' })).module
  const scoped = { ...intent(1), modules: [...intent().modules, { id: other.id, revision: other.revision }],
    reads: ['source.txt', 'other.txt'], acceptance: ['保持已有行为', '保持消费者契约'] }
  await declarations.save(taskId, scoped)
  const first = service().save(taskId, { ...input(), changeRevision: 2 })
  await declarations.save(taskId, { ...scoped, revision: 2, requestId: 'reordered',
    reads: [...scoped.reads].reverse(), acceptance: [...scoped.acceptance].reverse() })
  expect(service().save(taskId, { ...input(), changeRevision: 3 })).toMatchObject({
    created: false, suggestion: first.suggestion, applicability: { state: 'matches_registration' },
  })
  await declarations.saveModule({ ...moduleInput(1), requestId: 'other-updated', name: 'other', acceptance: ['其他模块新验收'] })
  expect(service().list(taskId).items[0]!.applicability).toEqual({ state: 'matches_registration', reasons: [] })
})

it.each(['source', 'scope', 'module', 'profile'] as const)('%s 变化使旧建议需重评；重放保留旧依据，不自动换版本', async kind => {
  const first = service().save(taskId, input()), originalInput = input()
  if (kind === 'source') await declarations.save(taskId, { ...intent(1), baseCommit: secondSource.source.commit })
  if (kind === 'scope') await declarations.save(taskId, { ...intent(1), acceptance: ['新增行为验收'] })
  if (kind === 'module') await declarations.saveModule({ ...moduleInput(1), acceptance: ['模块新验收'] })
  if (kind === 'profile') h.runtime.developmentQuality.save({ ...profileInput(1), tools: [{ name: 'crap', version: 'updated', sha256: 'c'.repeat(64) }] })
  const item = service().list(taskId).items[0]!
  expect(item.applicability).toEqual({ state: 'needs_reassessment', reasons: [`${kind}_changed`] })
  expect(item.suggestion).toEqual(first.suggestion)
  expect(service().save(taskId, originalInput)).toMatchObject({ created: false,
    suggestion: first.suggestion, applicability: { state: 'needs_reassessment' } })
  expect(() => service().save(taskId, { ...originalInput, proposal: '不同的新建议' }))
    .toThrow(expect.objectContaining({ code: 'optimization_basis_changed' }))
})

it('输入确已更新时可登记新的建议，旧建议和暂缓记录继续保留', async () => {
  const first = service().save(taskId, input())
  service().decide(taskId, first.suggestion.id, { revision: 1, action: 'defer' })
  await declarations.save(taskId, { ...intent(1), baseCommit: secondSource.source.commit })
  const next = service().save(taskId, { ...input(), changeRevision: 2 })
  expect(next.created).toBe(true)
  expect(next.suggestion.id).not.toBe(first.suggestion.id)
  expect(service().list(taskId).items.find(item => item.suggestion.id === first.suggestion.id))
    .toMatchObject({ disposition: 'deferred', applicability: { state: 'needs_reassessment' } })
})

it('处理回执丢失后的重复动作不产生第二条事件，也不撤销后续处理', () => {
  const saved = service().save(taskId, input()), id = saved.suggestion.id
  service().decide(taskId, id, { revision: 1, action: 'defer' })
  service().decide(taskId, id, { revision: 2, action: 'reopen' })
  const late = service().decide(taskId, id, { revision: 1, action: 'defer' })
  expect(late).toMatchObject({ changed: false, revision: 3, disposition: 'open' })
  expect(late.suggestion.decisions.map(event => event.action)).toEqual(['defer', 'reopen'])
  expect(() => service().decide(taskId, id, { revision: 1, action: 'reopen' }))
    .toThrow(expect.objectContaining({ code: 'optimization_revision_changed' }))
})

it('两个连接串行核对处理版本，迟到动作不会覆盖另一连接的处理', () => {
  const saved = service().save(taskId, input())
  const peer = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const other = new OptimizationSuggestions(peer, declarations, h.runtime.developmentQuality,
      { available: () => true, now: () => new Date().toISOString() })
    other.decide(taskId, saved.suggestion.id, { revision: 1, action: 'defer' })
    expect(() => service().decide(taskId, saved.suggestion.id, { revision: 1, action: 'reopen' }))
      .toThrow(expect.objectContaining({ code: 'optimization_revision_changed' }))
    expect(service().list(taskId).items[0]!.disposition).toBe('deferred')
  } finally { peer.close() }
})

it('列表按任务和配置隔离，后续页携带快照；变化后不能拼接旧页', async () => {
  for (let i = 0; i < 10; i++) service().save(taskId, { ...input(), finding: `问题 ${i}` })
  const first = service().list(taskId), second = service().list(taskId, { offset: 8, snapshot: first.snapshot })
  expect(first.items).toHaveLength(8); expect(second.items).toHaveLength(2)
  expect(new Set([...first.items, ...second.items].map(item => item.suggestion.id)).size).toBe(10)
  expect(service().list(taskId, { profileId: 'f'.repeat(64) }).total).toBe(0)
  service().decide(taskId, first.items[0]!.suggestion.id, { revision: 1, action: 'defer' })
  expect(() => service().list(taskId, { offset: 8, snapshot: first.snapshot }))
    .toThrow(expect.objectContaining({ code: 'optimization_catalog_changed' }))
  expect(() => service().list(taskId, { offset: 8 })).toThrow()
  const peer = (await h.api('POST', 'tasks', { requestId: 'peer', goal: '独立任务', dispatch: false })).body.ticketId as string
  await declarations.save(peer, intent())
  expect(service().list(peer).total).toBe(0)
  expect(() => service().decide(peer, first.items[0]!.suggestion.id, { revision: 1, action: 'defer' }))
    .toThrow(expect.objectContaining({ code: 'optimization_missing' }))
})

it('持久写失败回滚，不留下正文或处理半状态', () => {
  const original = h.runtime.store.set.bind(h.runtime.store)
  const spy = vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => {
    original(key, value)
    if (key.startsWith('development:optimization:')) throw new Error('模拟保存失败')
  })
  expect(() => service().save(taskId, input())).toThrow('模拟保存失败')
  expect(service().list(taskId).total).toBe(0)
  spy.mockRestore()
  const saved = service().save(taskId, input())
  vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => { original(key, value); throw new Error('模拟保存失败') })
  expect(() => service().decide(taskId, saved.suggestion.id, { revision: 1, action: 'defer' })).toThrow('模拟保存失败')
  const { created: _, ...view } = saved
  expect(service().list(taskId).items[0]).toEqual(view)
})

it('保存预算耗尽不删除旧建议，历史内容损坏不能作为有效意见返回', () => {
  for (let i = 0; i < 64; i++) service().save(taskId, { ...input(), finding: `问题 ${i}` })
  const before = service().list(taskId)
  expect(() => service().save(taskId, { ...input(), finding: '超过容量' }))
    .toThrow(expect.objectContaining({ code: 'optimization_budget' }))
  expect(service().list(taskId)).toEqual(before)
  const key = h.runtime.store.keys('development:optimization:')[0]!
  const value = h.runtime.store.get(key) as { finding: string }
  h.runtime.store.set(key, { ...value, finding: '被篡改的正文' })
  expect(() => service().list(taskId)).toThrow(expect.objectContaining({ code: 'optimization_corrupt' }))
})

it('字节与处理历史分别受限，耗尽后原内容与幂等回执仍可读取', () => {
  const first = service().save(taskId, input()), id = first.suggestion.id
  for (let revision = 1; revision <= 64; revision++)
    service().decide(taskId, id, { revision, action: revision % 2 ? 'defer' : 'reopen' })
  const before = service().list(taskId)
  expect(() => service().decide(taskId, id, { revision: 65, action: 'defer' }))
    .toThrow(expect.objectContaining({ code: 'optimization_budget' }))
  expect(service().decide(taskId, id, { revision: 64, action: 'reopen' })).toMatchObject({ changed: false, revision: 65 })
  expect(service().list(taskId)).toEqual(before)
  let accepted = 0
  for (let i = 0; i < 64; i++) {
    try {
      service().save(taskId, { ...input(), finding: `${i}${'测'.repeat(1900)}`,
        proposal: '改'.repeat(2000), validation: '验'.repeat(2000) })
      accepted++
    } catch (error) {
      expect(error).toMatchObject({ code: 'optimization_budget' })
      break
    }
  }
  expect(accepted).toBeGreaterThan(0)
  expect(accepted).toBeLessThan(63)
  expect(service().save(taskId, input()).suggestion).toEqual(before.items[0]!.suggestion)
})

it('未知或已结束任务不接受新建议，权限和输入字段不允许声明执行许可', async () => {
  expect(() => service().save('unknown', input())).toThrow(expect.objectContaining({ code: 'ticket_missing' }))
  expect(await h.api('POST', `tasks/${taskId}/quality/suggestions`, { ...input(), publishAllowed: true }))
    .toMatchObject({ status: 400 })
  const saved = service().save(taskId, input())
  await h.api('POST', `tasks/${taskId}/stop`)
  expect(service().save(taskId, input())).toMatchObject({ created: false, taskEnded: true, suggestion: saved.suggestion })
  expect(() => service().save(taskId, { ...input(), finding: '新的问题' }))
    .toThrow(expect.objectContaining({ code: 'ticket_inactive' }))
})
