import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { candidateGit } from '../src/development/candidate-git.ts'
import { DevelopmentCandidates } from '../src/development/candidates.ts'
import type { ApiResponse } from '../src/app/api.ts'
import { repositoryIdentity } from '../src/development/git-read.ts'
import type { DevelopmentChanges } from '../src/development/changes.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'
import { Store } from '../src/app/store.ts'

const exec = promisify(execFile)
let root: string, repository: string, base: string, left: string, right: string, conflict: string, custom: string, repoId: string
let h: Host, service: DevelopmentCandidates
let testLifetime: AbortController
let changes: ReturnType<typeof vi.fn<DevelopmentChanges['get']>>
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const git = async (...args: string[]) => (await exec('git', ['-C', repository,
  '-c', 'user.name=Candidate test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', ...args],
{ env: gitEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }),
  windowsHide: true })).stdout.trim()
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'superagent-candidates-'))
  repository = join(root, 'source'); await mkdir(repository)
  await git('init', '--initial-branch=main')
  await writeFile(join(repository, 'source.txt'), 'base\n')
  await git('add', '.'); await git('commit', '-m', 'base')
  base = await git('rev-parse', 'HEAD')
  await writeFile(join(repository, 'source.txt'), 'left\n')
  await git('commit', '-am', 'left'); left = await git('rev-parse', 'HEAD')
  await git('checkout', '--detach', base)
  await writeFile(join(repository, 'other.txt'), 'right\n')
  await git('add', '.'); await git('commit', '-m', 'right'); right = await git('rev-parse', 'HEAD')
  await git('checkout', '--detach', base)
  await writeFile(join(repository, 'source.txt'), 'conflict\n')
  await git('commit', '-am', 'conflict'); conflict = await git('rev-parse', 'HEAD')
  await writeFile(join(repository, '.gitattributes'), '*.txt merge=untrusted\n')
  await git('add', '.'); await git('commit', '-m', 'custom-driver'); custom = await git('rev-parse', 'HEAD')
  await git('checkout', '--detach', base)
  await writeFile(join(repository, 'source.txt'), 'staged-progress\n')
  await git('add', 'source.txt')
  await writeFile(join(repository, 'source.txt'), 'unstaged-progress\n')
  await writeFile(join(repository, 'new-file.txt'), 'not-for-candidate\n')
  repoId = repositoryIdentity(await git('rev-parse', '--path-format=absolute', '--git-common-dir'))
}, 30_000)
beforeEach(async () => {
  h = await startRuntime(undefined, { mode: 'hmm' })
  testLifetime = new AbortController()
  changes = vi.fn(() => ({
    change: { schemaVersion: 1, ticketId: 'task', revision: 1, repositoryId: repoId,
      source: { identity: digest(base), commit: base, tree: 'fixture-tree', objectFormat: 'sha1' },
      worktreePath: repository, owner: 'developer', purpose: '组合两项修改',
      modules: [], reads: ['.'], writes: ['.'], contracts: [], acceptance: ['两项修改均保留'] },
    ended: false, moduleDeclarationsChanged: false, modules: [],
    compatibility: 'unassessed', executionAuthorized: false, progressCaptured: false, candidateAccepted: false,
  }))
  service = new DevelopmentCandidates(h.runtime.store, { get: changes }, {
    stateDir: h.runtime.machine.stateDir, signal: AbortSignal.any([h.runtime.lifetime, testLifetime.signal]), available: () => true,
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  // 测试失败也先取消未结束的 Git，再等待句柄和状态库收尾，避免污染下一例。
  testLifetime.abort()
  await service.shutdown()
  await h.stop()
})
afterAll(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('superagent-candidates-'))
    throw new Error('临时测试目录归属异常')
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
const register = (commit: string, requires: string[] = []) => service.register('task', {
  changeRevision: 1, commit, declaredComplete: true, requires,
})
const sourceState = async () => ({
  head: await git('rev-parse', 'HEAD'),
  index: (await readFile(join(repository, '.git', 'index'))).toString('hex'),
  tracked: await readFile(join(repository, 'source.txt'), 'utf8'),
  untracked: await readFile(join(repository, 'new-file.txt'), 'utf8'),
})

it('实际组合固定提交并保留后续暂存、未暂存和新文件，不创建源码工作树', async () => {
  const before = await sourceState(), a = await register(left), b = await register(right)
  const result = await service.prepare({ baseCommit: base, candidates: [a.candidate.id, b.candidate.id] })
  expect(result).toMatchObject({ combination: { phase: 'prepared' }, publishAllowed: false, validationRequired: true, worktreeChanged: false })
  const source = result.combination.source!
  expect(await git('show', `${source.commit}:source.txt`)).toBe('left')
  expect(await git('show', `${source.commit}:other.txt`)).toBe('right')
  expect(await git('ls-tree', '--name-only', source.commit)).not.toContain('new-file.txt')
  expect(await sourceState()).toEqual(before)
  expect(await readdir(join(h.runtime.machine.stateDir, 'candidate-operations'))).toEqual([])
  expect(await git('rev-parse', `refs/superserve/combinations/${result.combination.id}`)).toBe(source.commit)
  expect(h.nodeFactory).not.toHaveBeenCalled()
}, 15_000)

it('依赖缺项拒绝，配套候选按组合验证，不要求各半独立构建', async () => {
  const b = await register(right), a = await register(left, [b.candidate.id])
  await expect(service.prepare({ baseCommit: base, candidates: [a.candidate.id] })).rejects.toMatchObject({ code: 'combination_dependency' })
  const result = await service.prepare({ baseCommit: base, candidates: [a.candidate.id, b.candidate.id] })
  expect(result.combination.phase).toBe('prepared')
  expect(result.validationRequired).toBe(true)
}, 15_000)

it('冲突保留可读结果，不能当作全部候选失败；无关组合仍可继续', async () => {
  const a = await register(left), b = await register(conflict), c = await register(right)
  const failed = await service.prepare({ baseCommit: base, candidates: [a.candidate.id, b.candidate.id] })
  expect(failed.combination).toMatchObject({ phase: 'conflicted', conflictIndex: 1 })
  expect(failed.combination.source).toBeUndefined()
  expect((await service.prepare({ baseCommit: base, candidates: [a.candidate.id, c.candidate.id] })).combination.phase).toBe('prepared')
}, 20_000)

it('最终回执落库失败后重启状态库，对账同一精确对象，不重写作者分支', async () => {
  const a = await register(left), original = h.runtime.store.set.bind(h.runtime.store)
  const failReceipt = vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => {
    original(key, value)
    if (String(key).startsWith('development:combination:') && (value as { phase?: string }).phase === 'prepared')
      throw new Error('injected receipt failure')
  })
  await expect(service.prepare({ baseCommit: base, candidates: [a.candidate.id] })).rejects.toThrow('injected receipt failure')
  failReceipt.mockRestore()
  const refs = await git('for-each-ref', '--format=%(objectname)', 'refs/superserve/combinations')
  await service.shutdown()
  await h.restart()
  service = new DevelopmentCandidates(h.runtime.store, { get: changes }, {
    stateDir: h.runtime.machine.stateDir, signal: AbortSignal.any([h.runtime.lifetime, testLifetime.signal]), available: () => true,
  })
  const recovered = await service.prepare({ baseCommit: base, candidates: [a.candidate.id] })
  expect(refs.split('\n')).toContain(recovered.combination.source!.commit)
  expect((await service.prepare({ baseCommit: base, candidates: [a.candidate.id] })).combination).toEqual(recovered.combination)
}, 15_000)

it('基线和顺序属于组合身份，后来的声明变化使原组合需重评', async () => {
  const a = await register(left), b = await register(right)
  const first = await service.prepare({ baseCommit: base, candidates: [a.candidate.id, b.candidate.id] })
  const second = await service.prepare({ baseCommit: base, candidates: [b.candidate.id, a.candidate.id] })
  const third = await service.prepare({ baseCommit: right, candidates: [a.candidate.id, b.candidate.id] })
  expect(new Set([first.combination.id, second.combination.id, third.combination.id]).size).toBe(3)
  const next = changes('task')
  next.moduleDeclarationsChanged = true
  changes.mockReturnValue(next)
  expect(service.combination(first.combination.id).basisChanged).toBe(true)
  await expect(service.prepare({ baseCommit: base, candidates: [a.candidate.id] })).rejects.toMatchObject({ code: 'combination_basis_changed' })
}, 20_000)

it('没有明确完成声明、重复成员和未知依赖不能获得就绪候选', async () => {
  await expect(service.register('task', { changeRevision: 1, commit: left })).rejects.toThrow()
  await expect(register(left, [digest('missing')])).rejects.toMatchObject({ code: 'candidate_missing' })
  const a = await register(left)
  await expect(service.prepare({ baseCommit: base, candidates: [a.candidate.id, a.candidate.id] })).rejects.toThrow()
  expect(service.list('task').items).toHaveLength(1)
})

it('声明外路径和空候选被拒绝，不靠缩小需求或忽略改动通过', async () => {
  await expect(register(base)).rejects.toMatchObject({ code: 'candidate_empty' })
  const view = changes('task')
  view.change.writes = ['other.txt']
  changes.mockReturnValue(view)
  await expect(register(left)).rejects.toMatchObject({ code: 'candidate_scope' })
  expect(service.list('task').items).toEqual([])
})

it('同请求在途去重，其他计算不无限并发，关闭后拒绝新操作', async () => {
  const first = register(left), duplicate = register(left)
  await expect(register(right)).rejects.toMatchObject({ code: 'candidate_operation_busy' })
  expect(await first).toEqual(await duplicate)
  expect(service.list('task').items).toHaveLength(1)
  await service.shutdown()
  await expect(register(right)).rejects.toMatchObject({ code: 'runtime_unavailable' })
})

it('目录计划只展开显式依赖，先依赖后当前候选，读取不写 Git 或启动执行', async () => {
  const dependency = await register(right), selected = await register(left, [dependency.candidate.id])
  const unrelated = await register(conflict)
  const before = await git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/superserve')
  const catalog = service.list('task'), plan = catalog.items.find(item => item.candidate.id === selected.candidate.id)!.plan
  expect(plan).toMatchObject({ state: 'ready', request: {
    baseCommit: base, candidates: [dependency.candidate.id, selected.candidate.id],
  } })
  if (plan.state !== 'ready') throw new Error('计划应当就绪')
  expect(plan.members.map(member => member.commit)).toEqual([right, left])
  expect(plan.request.candidates).not.toContain(unrelated.candidate.id)
  expect(await git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/superserve')).toBe(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  const prepared = await service.prepare(plan.request)
  expect(prepared.combination.phase).toBe('prepared')
  expect(await git('show', `${prepared.combination.source!.commit}:other.txt`)).toBe('right')
}, 20_000)

it('分页固定目录身份，新增候选使旧目录失效；依据变化不可继续沿用计划', async () => {
  await register(left); await register(right)
  const first = service.list('task', { limit: 1 })
  expect(service.list('task', { limit: 1, offset: first.nextOffset, snapshot: first.snapshot }).items).toHaveLength(1)
  await register(conflict)
  expect(() => service.list('task', { offset: 1, snapshot: first.snapshot }))
    .toThrow('候选或任务依据已变化')
  const next = changes('task'); next.moduleDeclarationsChanged = true
  changes.mockReturnValue(next)
  expect(service.list('task').items.every(item => item.plan.state === 'blocked' && item.plan.reason === 'basis_changed')).toBe(true)
}, 15_000)

it('另一任务的依赖后来结束，旧计划执行被拒绝，目录不能继续显示可准备', async () => {
  const definition = changes('task')
  let dependencyEnded = false
  changes.mockImplementation(ticketId => ({
    ...structuredClone(definition), ended: ticketId === 'dependency' && dependencyEnded,
    change: { ...structuredClone(definition.change), ticketId, purpose: ticketId },
  }))
  const dependency = await service.register('dependency', { changeRevision: 1, commit: right, declaredComplete: true })
  const selected = await register(left, [dependency.candidate.id])
  const plan = service.list('task').items[0]!.plan
  if (plan.state !== 'ready') throw new Error('计划应当就绪')
  expect(plan.members.map(item => item.ticketId)).toEqual(['dependency', 'task'])
  dependencyEnded = true
  expect(service.list('task').items[0]).toMatchObject({
    candidate: { id: selected.candidate.id }, taskEnded: false,
    plan: { state: 'blocked', reason: 'basis_changed' },
  })
  await expect(service.prepare(plan.request)).rejects.toMatchObject({ code: 'combination_basis_changed' })
}, 15_000)

it('未完成登记意图在回执失败后保留，可按原请求继续核验', async () => {
  const original = h.runtime.store.set.bind(h.runtime.store)
  const failed = vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => {
    original(key, value)
    if (String(key).startsWith('development:candidate:') && (value as { phase?: string }).phase === 'ready')
      throw new Error('candidate receipt lost')
  })
  await expect(register(left)).rejects.toThrow('candidate receipt lost')
  failed.mockRestore()
  const before = service.list('task').items[0]!.candidate
  expect(before.phase).toBe('recording')
  const recovered = await register(left)
  expect(recovered.candidate).toMatchObject({ id: before.id, phase: 'ready', createdAt: before.createdAt })
})

it('隔离源仓库外部合并驱动，未知驱动需补授权而非静默降级', async () => {
  const directory = join(h.runtime.machine.stateDir, 'isolated')
  await mkdir(directory)
  const session = await candidateGit(repository, directory, new AbortController().signal)
  try {
    await expect(session.combine(base, [custom], digest('custom'))).rejects.toMatchObject({ code: 'candidate_custom_merge' })
  } finally { await session.close() }
  expect(await readdir(directory)).toEqual([])
})

it('真实进程在对象保留后与数据库提交前被强制结束，恢复核对原对象', async () => {
  const directory = join(root, 'crash-recovery'); await mkdir(directory)
  const view = changes('task'); view.change.ticketId = 'crash-task'
  const config = join(directory, 'config.json')
  await writeFile(config, JSON.stringify({ view, candidate: left, base }))
  let receipt: { id: string; commit: string } | undefined
  try {
    await exec(process.execPath, ['--experimental-transform-types',
      resolve('tests/fixtures/development-candidate-crash.ts'), directory, config],
    { windowsHide: true, timeout: 30_000 })
    throw new Error('预期控制进程强制退出')
  } catch (error) {
    const output = error as { stdout?: string; killed?: boolean }
    expect(output.killed).not.toBe(true)
    receipt = JSON.parse(output.stdout ?? '') as { id: string; commit: string }
  }
  expect(receipt?.commit).toMatch(/^[a-f0-9]{40}$/)
  expect(await git('rev-parse', `refs/superserve/combinations/${receipt!.id}`)).toBe(receipt!.commit)
  const store = new Store(join(directory, 'state.sqlite'))
  const recovered = new DevelopmentCandidates(store, { get: () => structuredClone(view) }, {
    stateDir: directory, signal: new AbortController().signal, available: () => true,
  })
  try {
    const pending = recovered.combination(receipt!.id)
    expect(pending.combination.phase).toBe('preparing')
    const done = await recovered.prepare({ baseCommit: base, candidates: pending.combination.candidates })
    expect(done.combination).toMatchObject({ id: receipt!.id, phase: 'prepared', source: { commit: receipt!.commit } })
    expect(done.publishAllowed).toBe(false)
  } finally { await recovered.shutdown(); store.close() }
}, 35_000)

it('保留引用出现异值时拒绝覆盖，即使数据库仍记为就绪', async () => {
  const candidate = await register(left)
  const ref = `refs/superserve/candidates/${candidate.candidate.id}`
  await git('update-ref', ref, right, left)
  try {
    await expect(service.prepare({ baseCommit: base, candidates: [candidate.candidate.id] }))
      .rejects.toMatchObject({ code: 'candidate_ref_conflict' })
    expect(await git('rev-parse', ref)).toBe(right)
  } finally { await git('update-ref', ref, left, right) }
})

it('保留引用即使解析到相同对象，也不能跟随可变分支', async () => {
  const candidate = await register(left)
  const ref = `refs/superserve/candidates/${candidate.candidate.id}`
  await git('symbolic-ref', ref, 'refs/heads/main')
  try {
    await expect(service.prepare({ baseCommit: base, candidates: [candidate.candidate.id] }))
      .rejects.toMatchObject({ code: 'candidate_ref_conflict' })
    expect(await git('symbolic-ref', ref)).toBe('refs/heads/main')
    expect(await git('rev-parse', 'refs/heads/main')).toBe(left)
  } finally { await git('update-ref', '--no-deref', ref, left) }
}, 15_000)

it('SHA-256 仓库生成并重用精确组合，不依赖 SHA-1 对象长度', async () => {
  const directory = join(root, 'sha256')
  await mkdir(directory)
  const shaGit = async (...args: string[]) => git('-C', directory, ...args)
  await shaGit('init', '--initial-branch=main', '--object-format=sha256', '--template=')
  await writeFile(join(directory, 'source.txt'), 'before\n')
  await shaGit('add', '.'); await shaGit('commit', '-m', 'base')
  const initial = await shaGit('rev-parse', 'HEAD')
  await writeFile(join(directory, 'source.txt'), 'after\n')
  await shaGit('add', '.'); await shaGit('commit', '-m', 'candidate')
  const completed = await shaGit('rev-parse', 'HEAD')
  const view = changes('task')
  view.change.repositoryId = repositoryIdentity(await shaGit('rev-parse', '--path-format=absolute', '--git-common-dir'))
  view.change.worktreePath = directory
  view.change.source = {
    commit: initial, tree: await shaGit('rev-parse', 'HEAD~1^{tree}'),
    objectFormat: 'sha256', identity: digest(initial),
  }
  changes.mockReturnValue(view)
  const candidate = await register(completed)
  const request = { baseCommit: initial, candidates: [candidate.candidate.id] }
  const first = await service.prepare(request)
  const second = await service.prepare(request)
  expect(first.combination.source).toMatchObject({ commit: expect.stringMatching(/^[a-f0-9]{64}$/), objectFormat: 'sha256' })
  expect(second.combination).toEqual(first.combination)
  expect(await shaGit('show', `${first.combination.source!.commit}:source.txt`)).toBe('after')
  expect(await shaGit('rev-parse', 'HEAD')).toBe(completed)
}, 20_000)

it('HTTP 入口使用真实任务权限，缺少请求头不能登记或计算组合', async () => {
  const created = await h.api('POST', 'tasks', { requestId: 'candidate-route', goal: '验证候选管理路由', dispatch: false })
  const id = created.body.ticketId
  const module = await h.api('POST', 'development/modules', {
    requestId: 'module', revision: 0, repositoryPath: repository, name: 'module', paths: ['.'], contracts: [], acceptance: ['保留内容'],
  })
  expect(module.status).toBe(200)
  const moduleBody = module.body as ApiResponse<'POST development/modules'>
  const declared = await h.api('PUT', `development/changes/${id}`, {
    requestId: 'change', revision: 0, worktreePath: repository, baseCommit: base, owner: 'operator', purpose: '验证提交候选',
    modules: [{ id: moduleBody.module.id, revision: 1 }], reads: ['.'], writes: ['.'], contracts: [], acceptance: ['保留内容'],
  })
  expect(declared.status).toBe(200)
  const candidate = await h.api('POST', `development/changes/${id}/candidates`, { changeRevision: 1, commit: left, declaredComplete: true })
  expect(candidate.status, JSON.stringify(candidate.body)).toBe(200)
  const candidateBody = candidate.body as ApiResponse<'POST development/changes/:id/candidates'>
  const request = { baseCommit: base, candidates: [candidateBody.candidate.id] }
  expect((await h.api('POST', 'development/combinations', request, { 'x-orchestrator-request': '' })).status).toBe(403)
  expect((await h.api('POST', 'development/combinations', request, { origin: 'https://example.invalid' })).status).toBe(403)
  const combined = await h.api('POST', 'development/combinations', request)
  expect(combined.status, JSON.stringify(combined.body)).toBe(200)
  const combinedBody = combined.body as ApiResponse<'POST development/combinations'>
  const read = await h.api('GET', `development/combinations/${combinedBody.combination.id}`)
  expect((read.body as ApiResponse<'GET development/combinations/:id'>).combination.phase).toBe('prepared')
  expect((await h.api('GET', `development/changes/${id}/candidates`)).body.items).toHaveLength(1)
  expect(h.nodeFactory).not.toHaveBeenCalled()
}, 20_000)
