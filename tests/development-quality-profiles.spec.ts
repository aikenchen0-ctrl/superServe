import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DevelopmentChanges } from '../src/development/changes.ts'
import { DevelopmentQualityProfiles } from '../src/development/quality-profiles.ts'
import type { QualityProfileInput } from '../src/development/quality-contracts.ts'
import { inspectDevelopmentSource } from '../src/development/inspect.ts'
import { verifyQualitySources } from '../src/development/quality-sources.ts'
import { verifyQualityTools } from '../src/development/quality-tools.ts'
import { startRuntime } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let directory: string, root: string, separate: string, database: string, store: Store
let changes: DevelopmentChanges, profiles: DevelopmentQualityProfiles, available: boolean
let module: ReturnType<DevelopmentChanges['module']>
let source: Awaited<ReturnType<typeof inspectDevelopmentSource>>, other: typeof source
const inspect = vi.fn<typeof inspectDevelopmentSource>()
const sha = 'a'.repeat(64)
const git = async (path: string, ...args: string[]) => (await exec('git', [
  '-c', 'user.name=Quality configuration test', '-c', 'user.email=quality@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', '-C', path, ...args,
], { env: gitEnv(), windowsHide: true })).stdout.trim()

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'superserve-quality-profiles-'))
  root = join(directory, 'source'); separate = join(directory, 'separate')
  for (const path of [root, separate]) {
    await mkdir(join(path, 'messages'), { recursive: true })
    await mkdir(join(path, 'transport'))
    await writeFile(join(path, 'messages', 'source.txt'), 'committed source\n')
    await writeFile(join(path, 'transport', 'source.txt'), 'committed transport\n')
    await git(path, 'init', '--initial-branch=main')
    await git(path, 'add', '.')
    await git(path, 'commit', '-m', 'fixture')
  }
  source = await inspectDevelopmentSource({ repository: root })
  other = await inspectDevelopmentSource({ repository: separate })
})
function attach() {
  changes = new DevelopmentChanges(store, { available: () => available, inspect })
  profiles = new DevelopmentQualityProfiles(store, changes, { available: () => available, inspect,
    verifySources: verifyQualitySources, verifyTools: verifyQualityTools })
}
beforeEach(async () => {
  available = true
  database = join(await mkdtemp(join(directory, 'state-')), 'state.sqlite')
  store = new Store(database)
  inspect.mockReset()
  inspect.mockImplementation(async args => structuredClone(args.repository === separate ? other : source))
  attach()
  module = (await changes.saveModule({ requestId: 'module', revision: 0, repositoryPath: root, name: 'messages',
    paths: ['messages'], contracts: [{ name: 'messages', version: 'v1' }], acceptance: ['保留消息身份与内容'] })).module
})
afterEach(() => { vi.restoreAllMocks(); store.close() })
afterAll(async () => {
  const target = resolve(directory)
  if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !target.split(sep).at(-1)!.startsWith('superserve-quality-profiles-'))
    throw new Error('测试目录边界不符')
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
const definition = (overrides: Partial<QualityProfileInput> = {}): QualityProfileInput => ({
  requestId: 'profile', revision: 0, name: 'module-quality', module: { id: module.id, revision: module.revision },
  format: 'jvm-trial-v1',
  recipe: { repositoryId: module.repositoryId, commit: source.source.commit, tree: source.source.tree, path: '.' },
  configuration: { path: 'quality/targets.json', sha256: sha },
  tools: [{ name: 'java', version: '17.0.16', sha256: sha }, { name: 'pit', version: '1.30.0', sha256: 'b'.repeat(64) }],
  environment: { runtime: 'windows', architecture: 'x64' }, ...overrides,
})
const preview = (profile: ReturnType<DevelopmentQualityProfiles['save']>['profile']) =>
  profiles.preview({ profileId: profile.id, profileRevision: profile.revision, repositoryPath: root, commit: source.source.commit })
const savedCount = () => store.db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'development:quality-%'").get()!.n

it('两个模块独立绑定配置，工具与配方声明可复用，不创建任务或执行许可', async () => {
  const second = (await changes.saveModule({ requestId: 'transport', revision: 0, repositoryPath: root, name: 'transport',
    paths: ['transport'], contracts: [], acceptance: ['保持传输契约'] })).module
  const first = profiles.save(definition())
  const next = profiles.save(definition({ requestId: 'second', module: { id: second.id, revision: second.revision },
    format: 'native-crap-v1' }))
  expect(first.profile.id).not.toBe(next.profile.id)
  expect(first.profile.tools).toEqual(next.profile.tools)
  expect(first).toMatchObject({ created: true, currency: { moduleCurrent: true, profileCurrent: true },
    assurance: { toolsVerified: false, recipeVerified: false, configurationVerified: false,
      executionAuthorized: false, publishAllowed: false } })
  expect(store.db.prepare('SELECT count(*) AS n FROM ticket').get()!.n).toBe(0)
})

it('请求重放及工具顺序变化不产生新版本，不同内容不能复用请求编号', () => {
  const input = definition(), first = profiles.save(input), count = savedCount()
  const replay = profiles.save({ ...input, tools: [...input.tools].reverse() })
  expect(replay).toEqual({ ...first, created: false })
  expect(savedCount()).toBe(count)
  expect(() => profiles.save({ ...input, environment: { runtime: 'wsl', architecture: 'x64' } }))
    .toThrow(expect.objectContaining({ code: 'request_conflict' }))
})

const declaredChecks = (): NonNullable<QualityProfileInput['checks']> => [{
  id: 'contract', title: '身份与内容检查', requires: [],
  requirements: [{ scope: 'module', index: 0, text: '保留消息身份与内容' }],
  command: { tool: 'java', cwd: { root: 'source', path: '.' }, argv: ['-jar', { root: 'recipe', path: 'contract.jar' }] },
  result: { format: 'junit-xml', path: 'contract.xml', minimumTests: 2 }, timeoutMs: 60000,
}]
it('旧配置无检查字段仍保持原摘要；检查修改随新版本保存并保留旧历史', () => {
  const first = profiles.save(definition()).profile
  expect(first).not.toHaveProperty('checks')
  const second = profiles.save(definition({ revision: 1, requestId: 'checks-added', checks: declaredChecks() })).profile
  expect(second.digest).not.toBe(first.digest)
  store.close(); store = new Store(database); attach()
  expect(profiles.get(first.id, 1).profile).toEqual(first)
  expect(profiles.get(second.id).profile.checks).toEqual(declaredChecks())
  expect(profiles.save(definition({ revision: 1, requestId: 'checks-added', checks: declaredChecks() })).created).toBe(false)
  const updated = declaredChecks()
  updated[0]!.result.minimumTests = 3
  const third = profiles.save(definition({ revision: 2, requestId: 'checks-updated', checks: updated })).profile
  expect(third.digest).not.toBe(second.digest)
})
it.each(['tool', 'requirement'])('未登记 %s 不能借声明取得合法映射', kind => {
  const checks = declaredChecks()
  if (kind === 'tool') checks[0]!.command.tool = 'missing-tool'
  else checks[0]!.requirements[0]!.text = '删掉原要求'
  const count = savedCount()
  expect(() => profiles.save(definition({ checks }))).toThrow()
  expect(savedCount()).toBe(count)
})

it('并发更新同一配置时只有一个版本比较成功', async () => {
  const first = profiles.save(definition()).profile
  const results = await Promise.allSettled(['a', 'b'].map(requestId => Promise.resolve().then(() =>
    profiles.save(definition({ requestId, revision: first.revision, tools: [{ name: 'java', version: requestId, sha256: sha }] })))))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'revision_conflict' } })
  expect(profiles.get(first.id).profile.revision).toBe(2)
  expect(profiles.get(first.id, 1).profile).toEqual(first)
})

it('重启保留历史，旧请求重放不会把旧配置重新激活', () => {
  const first = profiles.save(definition()).profile
  const second = profiles.save(definition({ requestId: 'update', revision: 1,
    configuration: { path: 'quality/targets.json', sha256: 'b'.repeat(64) } })).profile
  store.close()
  store = new Store(database)
  attach()
  expect(profiles.get(first.id).profile).toEqual(second)
  expect(profiles.save(definition())).toMatchObject({ created: false, profile: first,
    currency: { profileCurrent: false, moduleCurrent: true } })
})

it('独立数据库连接看到相同版本边界，迟到更新不能覆盖已保存配置', () => {
  const first = profiles.save(definition()).profile
  const connection = new Store(database)
  try {
    const registry = new DevelopmentChanges(connection, { available: () => true, inspect })
    const peer = new DevelopmentQualityProfiles(connection, registry, { available: () => true, inspect,
      verifySources: verifyQualitySources, verifyTools: verifyQualityTools })
    const second = peer.save(definition({ requestId: 'peer', revision: 1,
      configuration: { path: 'quality/other.json', sha256: 'c'.repeat(64) } })).profile
    expect(() => profiles.save(definition({ requestId: 'late', revision: 1 })))
      .toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(profiles.get(first.id).profile).toEqual(second)
  } finally { connection.close() }
})

it('当前指针缺失时不把历史当作新配置覆盖，也不擅自恢复指针', () => {
  const first = profiles.save(definition()).profile
  store.delete(`development:quality-profile:${first.id}`)
  expect(() => profiles.save(definition({ requestId: 'new-request' })))
    .toThrow(expect.objectContaining({ code: 'quality_profile_corrupt' }))
  expect(store.get(`development:quality-profile-version:${first.id}:1`)).toEqual(first)
  expect(store.get(`development:quality-profile:${first.id}`)).toBeUndefined()
})

it('模块验收变更使旧配置失效；旧声明可读且新配置需显式跟随模块版本', async () => {
  const first = profiles.save(definition()).profile
  module = (await changes.saveModule({ requestId: 'new-contract', revision: module.revision, repositoryPath: root,
    name: 'messages', paths: ['messages'], contracts: [{ name: 'messages', version: 'v2' }],
    acceptance: ['保留身份并维持顺序'] })).module
  expect(profiles.get(first.id)).toMatchObject({ currency: { moduleCurrent: false }, profile: first })
  inspect.mockClear()
  await expect(preview(first)).rejects.toMatchObject({ code: 'quality_module_changed' })
  expect(inspect).not.toHaveBeenCalled()
  expect(() => profiles.save(definition({ requestId: 'stale', revision: 1, module: first.module })))
    .toThrow(expect.objectContaining({ code: 'quality_module_changed' }))
  const next = profiles.save(definition({ requestId: 'updated', revision: 1 }))
  expect(next.currency.moduleCurrent).toBe(true)
  expect(next.profile.module.revision).toBe(2)
})

it('固定提交预览可重复，既不落库也不改写未提交进度', async () => {
  const profile = profiles.save(definition()).profile, count = savedCount()
  const file = join(root, 'messages', 'source.txt')
  await writeFile(file, 'uncommitted progress\n')
  await writeFile(join(root, 'private-untracked.txt'), 'PRIVATE_LOCAL_CONTENT')
  inspect.mockImplementation(inspectDevelopmentSource)
  const first = await preview(profile), again = await preview(profile)
  expect(again).toEqual(first)
  expect(first).toMatchObject({ persisted: false, currentProgressCaptured: false, sourceScope: 'committed-tree-only',
    binding: { profile: { id: profile.id, revision: 1 }, source: { commit: source.source.commit } },
    assurance: { configurationVerified: false, inputClosureVerified: false, executionAuthorized: false } })
  expect(savedCount()).toBe(count)
  expect(await readFile(file, 'utf8')).toBe('uncommitted progress\n')
  expect(JSON.stringify(first)).not.toContain('PRIVATE_LOCAL_CONTENT')
})

it('不同仓库即使有合法固定提交，也不能借用目标模块身份', async () => {
  const profile = profiles.save(definition()).profile
  await expect(profiles.preview({ profileId: profile.id, profileRevision: 1,
    repositoryPath: separate, commit: other.source.commit })).rejects.toMatchObject({ code: 'quality_repository_mismatch' })
})

it.each(['profile', 'module'])('异步检查期间 %s 更新后不返回过时绑定', async change => {
  const first = profiles.save(definition()).profile
  inspect.mockImplementationOnce(async () => {
    if (change === 'profile') profiles.save(definition({ requestId: 'racing', revision: 1 }))
    else await changes.saveModule({ requestId: 'racing-module', revision: 1, repositoryPath: root, name: 'messages',
      paths: ['messages'], contracts: [], acceptance: ['新增验收'] })
    return structuredClone(source)
  })
  await expect(preview(first)).rejects.toMatchObject({
    code: change === 'profile' ? 'quality_profile_changed' : 'quality_module_changed',
  })
})

it('输入检查期间关闭或引用变化时不发出绑定', async () => {
  const first = profiles.save(definition()).profile
  inspect.mockResolvedValueOnce({ ...source, observation: { ...source.observation, referenceChanged: true } })
  await expect(preview(first)).rejects.toMatchObject({ code: 'quality_source_changed' })
  inspect.mockImplementationOnce(async () => { available = false; return source })
  await expect(preview(first)).rejects.toMatchObject({ code: 'runtime_unavailable' })
  expect(() => profiles.save(definition())).toThrow(expect.objectContaining({ code: 'runtime_unavailable' }))
})

it('任一写入失败回滚历史和幂等回执，重试不会被半成品阻塞', () => {
  const original = store.set.bind(store)
  vi.spyOn(store, 'set').mockImplementation((key, value) => {
    if (key.startsWith('development:quality-profile:')) throw new Error('写入故障注入')
    return original(key, value)
  })
  expect(() => profiles.save(definition())).toThrow('写入故障注入')
  expect(savedCount()).toBe(0)
  vi.mocked(store.set).mockRestore()
  expect(profiles.save(definition()).created).toBe(true)
})

it('未知持久版本不被默默迁移或覆盖', () => {
  const first = profiles.save(definition()).profile
  store.set(`development:quality-profile:${first.id}`, { ...first, schemaVersion: 99 })
  expect(() => profiles.get(first.id)).toThrow(expect.objectContaining({ code: 'quality_profile_unsupported' }))
  expect(() => profiles.save(definition({ requestId: 'update', revision: 1 })))
    .toThrow(expect.objectContaining({ code: 'quality_profile_unsupported' }))
})

it.each(['../targets.json', '.git/config', 'C:/private/targets.json', '/etc/passwd'])('目标配置路径拒绝越界：%s', path => {
  expect(() => profiles.save(definition({ configuration: { path, sha256: sha } })))
    .toThrow(expect.objectContaining({ code: 'invalid_quality_profile' }))
  expect(savedCount()).toBe(0)
})

it('重复工具、执行命令和另设验收不能混进纯配置登记', () => {
  const input = definition()
  for (const malformed of [{ ...input, tools: [input.tools[0], input.tools[0]] },
    { ...input, command: 'PRIVATE_EXECUTION' }, { ...input, acceptance: ['放宽验收'] }]) {
    expect(() => profiles.save(malformed)).toThrow(expect.objectContaining({ code: 'invalid_quality_profile' }))
  }
  expect(savedCount()).toBe(0)
})

it('本机 HTTP 完成模块登记、配置登记、历史读取和预览，重启后仍有效', async () => {
  const h = await startRuntime(undefined, { mode: 'hmm' })
  try {
    const registration = await h.api('POST', 'development/modules', { requestId: 'module', revision: 0,
      repositoryPath: root, name: 'transport', paths: ['transport'], contracts: [], acceptance: ['传输保持有效'] })
    expect(registration.status).toBe(200)
    const registered = registration.body.module as typeof module
    const response = await h.api('POST', 'development/quality-profiles',
      definition({ module: { id: registered.id, revision: registered.revision } }))
    expect(response.status).toBe(200)
    const profile = response.body.profile as ReturnType<DevelopmentQualityProfiles['save']>['profile']
    const bound = await h.api('POST', 'development/quality-bindings/preview',
      { profileId: profile.id, profileRevision: profile.revision, repositoryPath: root, commit: source.source.commit })
    expect(bound.status).toBe(200)
    expect(bound.body).toMatchObject({ persisted: false, assurance: { executionAuthorized: false } })
    await h.restart()
    const read = await h.api('GET', `development/quality-profiles/${profile.id}?revision=1`)
    expect(read.status).toBe(200)
    expect(read.body.profile).toEqual(profile)
  } finally { await h.stop() }
})
