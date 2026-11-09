import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'
import type { QualityProfileInput } from '../src/development/quality-contracts.ts'
import type { ApiResponse } from '../src/app/api.ts'

const exec = promisify(execFile), sha = (text: string) => createHash('sha256').update(text).digest('hex')
const configuration = '{"tests":["contract"]}\n'
let root: string, base: string, good: string, bad: string, recipeTree: string
let h: Host, taskId: string, definition: QualityProfileInput, preparationRoot: string
let profile: ReturnType<Host['runtime']['developmentQuality']['save']>['profile']
const git = async (...args: string[]) => (await exec('git', ['-C', root,
  '-c', 'user.name=Source checks', '-c', 'user.email=checks@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', ...args],
{ windowsHide: true, env: gitEnv() })).stdout.trim()
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'combination-checks-'))
  await mkdir(join(root, 'recipe'))
  await writeFile(join(root, 'recipe', 'run.txt'), 'independent recipe\n')
  await writeFile(join(root, 'targets.json'), configuration)
  await writeFile(join(root, 'module.txt'), 'before\n')
  await git('init', '--initial-branch=main'); await git('add', '.'); await git('commit', '-m', 'base')
  base = await git('rev-parse', 'HEAD'); recipeTree = await git('rev-parse', 'HEAD:recipe')
  await writeFile(join(root, 'module.txt'), 'after\n')
  await git('commit', '-am', 'completed'); good = await git('rev-parse', 'HEAD')
  await writeFile(join(root, 'targets.json'), '{"tests":[]}\n')
  await git('commit', '-am', 'changed-configuration'); bad = await git('rev-parse', 'HEAD')
  await git('checkout', '--detach', base)
  await writeFile(join(root, 'targets.json'), 'uncommitted configuration\n')
  await git('add', 'targets.json')
  await writeFile(join(root, 'module.txt'), 'newer progress\n')
  await writeFile(join(root, 'new.txt'), 'new progress\n')
}, 30_000)
beforeEach(async () => {
  h = await startRuntime(undefined, { mode: 'hmm' })
  preparationRoot = await mkdtemp(join(tmpdir(), 'combination-prepared-'))
  taskId = (await h.api('POST', 'tasks', { requestId: 'source-check', goal: '核对组合来源', dispatch: false })).body.ticketId as string
  const module = (await h.runtime.development.saveModule({ requestId: 'module', revision: 0, repositoryPath: root,
    name: 'module', paths: ['.'], contracts: [], acceptance: ['保持原契约'] })).module
  await h.runtime.development.save(taskId, { requestId: 'intent', revision: 0, worktreePath: root, baseCommit: base,
    owner: 'developer', purpose: '保持模块契约', modules: [{ id: module.id, revision: 1 }],
    reads: ['.'], writes: ['.'], contracts: [], acceptance: ['保持原契约'] })
  definition = { requestId: 'profile', revision: 0, name: 'sources', module: { id: module.id, revision: 1 },
    format: 'native-crap-v1', configuration: { path: 'targets.json', sha256: sha(configuration) },
    recipe: { repositoryId: module.repositoryId, commit: base, tree: recipeTree, path: 'recipe' },
    tools: [{ name: 'tool', version: 'fixture', sha256: sha('tool') }],
    environment: { runtime: 'windows', architecture: 'x64' } }
  profile = h.runtime.developmentQuality.save(definition).profile
})
afterEach(async () => { vi.restoreAllMocks(); await h?.stop(); await rm(preparationRoot, { recursive: true, force: true }) })
afterAll(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('combination-checks-'))
    throw new Error('测试目录归属异常')
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
const prepare = async (commit = good) => {
  const candidate = await h.runtime.developmentCandidates.register(taskId, { changeRevision: 1, commit, declaredComplete: true })
  const combo = await h.runtime.developmentCandidates.prepare({ baseCommit: base, candidates: [candidate.candidate.id] })
  return { combo, input: { requestId: randomUUID(), changeRevision: 1, combinationId: combo.combination.id,
    profileId: profile.id, profileRevision: 1 } }
}
const sourceState = async () => ({
  head: await git('rev-parse', 'HEAD'), index: (await readFile(join(root, '.git', 'index'))).toString('hex'),
  configuration: await readFile(join(root, 'targets.json'), 'utf8'), module: await readFile(join(root, 'module.txt'), 'utf8'),
  fresh: await readFile(join(root, 'new.txt'), 'utf8'),
})

it('可信宿主由完整组合回执准备独立源码，活动进度保持，不新增管理写入口', async () => {
  const { input } = await prepare(), before = await sourceState()
  await h.runtime.combinationChecks.verify(taskId, input)
  const parent = preparationRoot
  const output = await h.runtime.combinationChecks.prepareSource(taskId, { sourceCheckId: input.requestId, parentDirectory: parent })
  expect(output).toMatchObject({ materialized: true, executionAuthorized: false, contentReadBackVerified: true,
    outputDirectory: expect.any(String) })
  expect(await readdir(output.outputDirectory)).toEqual([])
  expect((await h.runtime.combinationChecks.preparedSource(taskId, input.requestId))?.current).toBe(true)
  await rm(output.outputDirectory, { recursive: true, force: true }); await mkdir(output.outputDirectory)
  expect((await h.runtime.combinationChecks.preparedSource(taskId, input.requestId))?.current).toBe(false)
  expect(await readFile(join(output.directory, 'module.txt'), 'utf8')).toBe('after\n')
  expect(await sourceState()).toEqual(before)
  expect((await h.api('POST', `tasks/${taskId}/quality/prepare-source`,
    { sourceCheckId: input.requestId, parentDirectory: parent })).status).toBe(404)
  expect(h.runtime.workspaces.list().items).toEqual([])
}, 20000)

it('准备期间配置改变拒绝发布；无匹配回执不能准备，关闭后拒绝新请求', async () => {
  const { input } = await prepare(), parent = preparationRoot
  await expect(h.runtime.combinationChecks.prepareSource(taskId, { sourceCheckId: input.requestId, parentDirectory: parent }))
    .rejects.toThrow()
  await h.runtime.combinationChecks.verify(taskId, input)
  const running = h.runtime.combinationChecks.prepareSource(taskId, { sourceCheckId: input.requestId, parentDirectory: parent })
  h.runtime.developmentQuality.save({ ...definition, revision: 1, requestId: 'prepare-change' })
  await expect(running).rejects.toThrow()
  await h.runtime.combinationChecks.shutdown()
  await expect(h.runtime.combinationChecks.prepareSource(taskId, { sourceCheckId: input.requestId, parentDirectory: parent }))
    .rejects.toThrow()
}, 20000)

it('核验精确组合而非登记起点或活动目录；只读保持暂存和新进度', async () => {
  const { combo, input } = await prepare(), before = await sourceState()
  const checked = await h.runtime.combinationChecks.verify(taskId, input)
  expect(checked.binding.source.commit).toBe(combo.combination.source!.commit)
  expect(checked.binding.source.commit).not.toBe(base)
  expect(checked.verification.sourceInputs).toMatchObject({ scope: 'committed-tree', tree: combo.combination.source!.tree,
    files: 3, materialized: false, executionAttempted: false })
  expect(checked.verification.configuration.sha256).toBe(sha(configuration))
  expect(checked.verification.recipe.commit).toBe(base)
  expect(checked).toMatchObject({ persisted: true, combinationId: combo.combination.id,
    verification: { status: 'tracked_content_matched', assurance: {
      dependencyClosureVerified: false, toolsVerified: false, executionAuthorized: false, publishAllowed: false,
    } } })
  expect(await sourceState()).toEqual(before)
  expect(h.runtime.combinationChecks.get(taskId, input.requestId)).toMatchObject({
    state: 'succeeded', current: true, validationRequired: true, publishAllowed: false,
  })
}, 20_000)

it('组合改掉配置时拒绝，即使原登记起点的相同核验通过；失败保留原记录', async () => {
  const { input } = await prepare(bad)
  expect((await h.runtime.developmentQuality.verifyTaskSources(taskId, {
    changeRevision: 1, profileId: profile.id, profileRevision: 1,
  })).verification.status).toBe('tracked_content_matched')
  await expect(h.runtime.combinationChecks.verify(taskId, input)).rejects.toThrow()
  const failed = h.runtime.combinationChecks.get(taskId, input.requestId)
  expect(failed.state).toBe('failed')
  expect(failed.record.receipt).toBeUndefined()
  expect(failed.record.failureCode).toBeTruthy()
  await expect(h.runtime.combinationChecks.verify(taskId, input)).rejects.toMatchObject({ code: 'combination_check_failed' })
}, 20_000)

it('响应丢失后重启可读回执，同请求不重复读取；配置升级令旧证据失效', async () => {
  const { input } = await prepare()
  const checked = await h.runtime.combinationChecks.verify(taskId, input)
  await h.restart()
  const inspect = vi.spyOn(h.runtime.developmentQuality, 'verifySources')
  expect(await h.runtime.combinationChecks.verify(taskId, input)).toEqual(checked)
  expect(inspect).not.toHaveBeenCalled()
  h.runtime.developmentQuality.save({ ...definition, revision: 1, requestId: 'next-profile' })
  expect(h.runtime.combinationChecks.get(taskId, input.requestId)).toMatchObject({ state: 'succeeded', current: false })
  await expect(h.runtime.combinationChecks.verify(taskId, input)).rejects.toMatchObject({ code: 'combination_check_stale' })
}, 20_000)

it('核验中配置升级不能保存成功；并发相同请求去重，其他请求明确拒绝', async () => {
  const { input } = await prepare()
  const original = h.runtime.developmentQuality.verifySources.bind(h.runtime.developmentQuality)
  let release!: () => void, observed!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { observed = resolve })
  const inspect = vi.spyOn(h.runtime.developmentQuality, 'verifySources').mockImplementation(async (args, scope) => {
    const result = await original(args, scope); observed(); await gate; return result
  })
  const first = h.runtime.combinationChecks.verify(taskId, input)
  const duplicate = h.runtime.combinationChecks.verify(taskId, input)
  const outcome = Promise.allSettled([first, duplicate])
  try {
    await ready
    await expect(h.runtime.combinationChecks.verify(taskId, { ...input, requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'combination_check_busy' })
    h.runtime.developmentQuality.save({ ...definition, revision: 1, requestId: 'during-check' })
  } finally { release() }
  expect((await outcome).every(result => result.status === 'rejected')).toBe(true)
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(h.runtime.combinationChecks.get(taskId, input.requestId)).toMatchObject({ state: 'failed', current: false })
}, 20_000)

it('重启后未完成意图为未确认，可重新执行只读核验而不是猜测成功', async () => {
  const { input } = await prepare()
  const checked = await h.runtime.combinationChecks.verify(taskId, input)
  const saved = h.runtime.combinationChecks.get(taskId, input.requestId).record
  // 注入崩溃前已持久化的意图状态；本例不声称执行了真实进程强制退出。
  const { receipt: _, receiptHash: __, finishedAt: ___, ...intent } = saved
  h.runtime.store.set(`development:combination-source-check:${taskId}:${input.requestId}`, { ...intent, state: 'running' })
  await h.restart()
  expect(h.runtime.combinationChecks.get(taskId, input.requestId).state).toBe('interrupted')
  const recovered = await h.runtime.combinationChecks.verify(taskId, input)
  expect(recovered.binding).toEqual(checked.binding)
  expect(h.runtime.combinationChecks.get(taskId, input.requestId).state).toBe('succeeded')
}, 20_000)

it('请求身份不能换输入，已保存回执被修改不能继续当作证据', async () => {
  const { input } = await prepare()
  await h.runtime.combinationChecks.verify(taskId, input)
  await expect(h.runtime.combinationChecks.verify(taskId, { ...input, recipeRepositoryPath: root }))
    .rejects.toMatchObject({ code: 'combination_check_reused' })
  const saved = h.runtime.combinationChecks.get(taskId, input.requestId).record
  h.runtime.store.set(`development:combination-source-check:${taskId}:${input.requestId}`, {
    ...saved, receipt: { ...saved.receipt!, bindingDigest: '0'.repeat(64) },
  })
  expect(() => h.runtime.combinationChecks.get(taskId, input.requestId)).toThrow('核验记录不完整')
}, 20_000)

it('管理 API 不接收目标替换或成功报告；其他任务不能读取本任务回执', async () => {
  const { input } = await prepare()
  const route = `tasks/${taskId}/quality/verify-combination`
  expect((await h.api('POST', route, input, { 'x-orchestrator-request': '' })).status).toBe(403)
  expect((await h.api('POST', route, { ...input, commit: base, status: 'passed' })).status).toBe(400)
  const response = await h.api('POST', route, input)
  expect(response.status).toBe(200)
  const result = response.body as ApiResponse<'POST tasks/:id/quality/verify-combination'>
  expect(result.persisted).toBe(true)
  expect((await h.api('GET', `tasks/${taskId}/quality/combination-checks/${input.requestId}`)).status).toBe(200)
  const another = (await h.api('POST', 'tasks', { requestId: 'another', goal: '另一任务', dispatch: false })).body.ticketId as string
  const original = h.runtime.development.get(taskId).change
  await h.runtime.development.save(another, { requestId: 'other-intent', revision: 0, worktreePath: root,
    baseCommit: base, owner: 'other', purpose: '无关已登记任务', modules: original.modules, reads: ['.'],
    writes: ['.'], contracts: [], acceptance: ['保持原契约'] })
  expect((await h.api('POST', `tasks/${another}/quality/verify-combination`, input)).status).toBe(403)
  expect((await h.api('GET', `tasks/${another}/quality/combination-checks/${input.requestId}`)).status).not.toBe(200)
}, 20_000)

it('旧范围的历史回执仍可读取，但不能因输入策略升级而被提升为完整代码输入证据', async () => {
  const { input } = await prepare()
  const receipt = await h.runtime.combinationChecks.verify(taskId, input)
  const record = h.runtime.combinationChecks.get(taskId, input.requestId).record
  const { inputPolicy: _, ...oldRecord } = record
  const { sourceInputs: __, ...verification } = receipt.verification
  const legacy = { ...receipt, verification }
  h.runtime.store.set(`development:combination-source-check:${taskId}:${input.requestId}`,
    { ...oldRecord, receipt: legacy, receiptHash: sha(JSON.stringify(legacy)) })
  await h.restart()
  const inspect = vi.spyOn(h.runtime.developmentQuality, 'verifySources')
  expect(h.runtime.combinationChecks.get(taskId, input.requestId)).toMatchObject({ current: false, state: 'succeeded' })
  await expect(h.runtime.combinationChecks.verify(taskId, input))
    .rejects.toMatchObject({ code: 'combination_check_policy_changed' })
  expect(inspect).not.toHaveBeenCalled()
  expect((await h.runtime.combinationChecks.verify(taskId, { ...input, requestId: randomUUID() }))
    .verification.sourceInputs?.scope).toBe('committed-tree')
}, 20_000)

it('验收依据由既有要求与固定配置生成；确认可重启重放，不启动或改写源码', async () => {
  const { input } = await prepare(), before = await sourceState()
  await h.runtime.combinationChecks.verify(taskId, input)
  const endpoint = `tasks/${taskId}/quality/acceptance`
  const previewResponse = await h.api('GET', `${endpoint}?sourceCheckId=${input.requestId}`)
  expect(previewResponse.status).toBe(200)
  const preview = previewResponse.body as ApiResponse<'GET tasks/:id/quality/acceptance'>
  expect(preview.basis.task.acceptance).toEqual(['保持原契约'])
  expect(preview.basis.module.acceptance).toEqual(['保持原契约'])
  expect(JSON.stringify(preview)).not.toContain(root)
  const decision = { requestId: randomUUID(), sourceCheckId: input.requestId, basisDigest: preview.basisDigest,
    revision: 0, action: 'confirm' as const, evidence: { source: '产品合同 v1', rationale: '覆盖顺序要求；还需设备验证' } }
  expect((await h.api('POST', endpoint, decision, { 'x-orchestrator-request': '' })).status).toBe(403)
  expect((await h.api('POST', endpoint, { ...decision, acceptance: ['删掉旧要求'] })).status).toBe(400)
  expect((await h.api('POST', endpoint, decision))).toMatchObject({ status: 200, body: {
    changed: true, state: 'confirmed', revision: 1, current: true,
    assurance: { independentReviewerAuthenticated: false, coverageVerified: false, executionAuthorized: false, publishAllowed: false },
  } })
  await h.restart()
  expect((await h.api('POST', endpoint, decision)).body).toMatchObject({ changed: false, revision: 1, state: 'confirmed' })
  const next = await h.runtime.combinationChecks.verify(taskId, { ...input, requestId: randomUUID() })
  expect(h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: next.requestId }))
    .toMatchObject({ basisDigest: preview.basisDigest, state: 'confirmed', revision: 1 })
  expect(h.runtime.workspaces.list().items).toEqual([])
  expect(await sourceState()).toEqual(before)
}, 25_000)

it('配置过期仍可撤回历史确认；旧确认重放不能覆盖撤回，也不能换正文', async () => {
  const { input } = await prepare()
  await h.runtime.combinationChecks.verify(taskId, input)
  const preview = h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })
  const decision = { requestId: randomUUID(), sourceCheckId: input.requestId, basisDigest: preview.basisDigest,
    revision: 0, action: 'confirm', evidence: { source: '原需求', rationale: '原规则说明' } }
  h.runtime.acceptanceBases.decide(taskId, decision)
  h.runtime.developmentQuality.save({ ...definition, revision: 1, requestId: 'acceptance-profile-update' })
  expect(() => h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })).toThrow()
  const withdrawn = h.runtime.acceptanceBases.decide(taskId, { requestId: randomUUID(), action: 'withdraw',
    basisDigest: preview.basisDigest, revision: 1 })
  expect(withdrawn).toMatchObject({ revision: 2, state: 'withdrawn', current: false })
  expect(h.runtime.acceptanceBases.decide(taskId, decision)).toMatchObject({
    changed: false, revision: 2, state: 'withdrawn', current: false,
  })
  expect(() => h.runtime.acceptanceBases.decide(taskId, { ...decision, evidence: { ...decision.evidence, source: '另一来源' } }))
    .toThrow(expect.objectContaining({ code: 'acceptance_request_conflict' }))
  await h.restart()
  expect(h.runtime.acceptanceBases.get(taskId, preview.basisDigest).events.map(event => event.action)).toEqual(['confirm', 'withdraw'])
}, 20_000)

it('不能用旧决定版本覆盖新说明；丢失事务回执不会留下半份确认', async () => {
  const { input } = await prepare()
  await h.runtime.combinationChecks.verify(taskId, input)
  const preview = h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })
  const args = { requestId: randomUUID(), sourceCheckId: input.requestId, basisDigest: preview.basisDigest,
    revision: 0, action: 'confirm', evidence: { source: '契约测试', rationale: '需求逐项映射' } }
  const set = h.runtime.store.set.bind(h.runtime.store)
  const saving = vi.spyOn(h.runtime.store, 'set').mockImplementation((key, value) => {
    if (key.startsWith('development:acceptance-request:')) throw new Error('模拟回执落库失败')
    return set(key, value)
  })
  expect(() => h.runtime.acceptanceBases.decide(taskId, args)).toThrow('模拟回执')
  saving.mockRestore()
  expect(h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })).toMatchObject({ revision: 0, state: 'unconfirmed' })
  h.runtime.acceptanceBases.decide(taskId, args)
  expect(() => h.runtime.acceptanceBases.decide(taskId, { ...args, requestId: randomUUID(), evidence: { source: '换来源', rationale: '换说明' } }))
    .toThrow(expect.objectContaining({ code: 'acceptance_changed' }))
}, 20_000)

it('另一任务和伪造依据不能获取或确认原任务的验收记录', async () => {
  const { input } = await prepare()
  await h.runtime.combinationChecks.verify(taskId, input)
  const preview = h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })
  const decision = { requestId: randomUUID(), sourceCheckId: input.requestId, basisDigest: preview.basisDigest,
    revision: 0, action: 'confirm', evidence: { source: '需求', rationale: '说明' } }
  expect(() => h.runtime.acceptanceBases.decide(taskId, { ...decision, basisDigest: '0'.repeat(64) }))
    .toThrow(expect.objectContaining({ code: 'acceptance_changed' }))
  h.runtime.acceptanceBases.decide(taskId, decision)
  const other = (await h.api('POST', 'tasks', { requestId: 'acceptance-other', goal: '另一任务', dispatch: false })).body.ticketId as string
  expect((await h.api('GET', `tasks/${other}/quality/acceptance/${preview.basisDigest}`)).status).not.toBe(200)
  expect((await h.api('POST', `tasks/${other}/quality/acceptance`, decision)).status).not.toBe(200)
  const key = `development:acceptance:${sha(JSON.stringify(taskId))}:${preview.basisDigest}`
  const record = h.runtime.store.get(key) as { events: unknown[] }
  expect(record.events).toHaveLength(1)
  h.runtime.store.set(key, { ...record, events: [] })
  expect(() => h.runtime.acceptanceBases.get(taskId, preview.basisDigest))
    .toThrow(expect.objectContaining({ code: 'acceptance_corrupt' }))
}, 20_000)

it('两个不同固定组合复用同一已确认依据；不将确认当作任一组合通过', async () => {
  const { input } = await prepare()
  await h.runtime.combinationChecks.verify(taskId, input)
  const preview = h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })
  h.runtime.acceptanceBases.decide(taskId, { action: 'confirm', requestId: randomUUID(), sourceCheckId: input.requestId,
    basisDigest: preview.basisDigest, revision: 0, evidence: { source: '外部协议', rationale: '固定配方与协议要求的映射' } })
  // 创建第二个提交对象，不切换源分支、索引或活动文件。
  const tree = await git('rev-parse', `${good}^{tree}`)
  const second = await git('commit-tree', tree, '-p', good, '-m', 'follow-up candidate')
  const next = await prepare(second)
  expect(next.input.combinationId).not.toBe(input.combinationId)
  await h.runtime.combinationChecks.verify(taskId, next.input)
  expect(h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: next.input.requestId })).toMatchObject({
    basisDigest: preview.basisDigest, state: 'confirmed', revision: 1,
    source: { combinationId: next.input.combinationId }, assurance: { executionAuthorized: false, publishAllowed: false },
  })
}, 25_000)

it('任务验收要求变化使历史确认失效，新来源未核对前不能重新确认', async () => {
  const { input } = await prepare()
  await h.runtime.combinationChecks.verify(taskId, input)
  const preview = h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })
  const decision = { action: 'confirm', requestId: randomUUID(), sourceCheckId: input.requestId,
    basisDigest: preview.basisDigest, revision: 0, evidence: { source: '原需求', rationale: '原覆盖说明' } }
  h.runtime.acceptanceBases.decide(taskId, decision)
  const { change } = h.runtime.development.get(taskId)
  await h.runtime.development.save(taskId, { requestId: 'new-acceptance', revision: 1,
    worktreePath: root, baseCommit: base, owner: change.owner, purpose: change.purpose,
    modules: change.modules, reads: change.reads, writes: change.writes, contracts: change.contracts,
    acceptance: ['保持原契约', '增加恢复验证'] })
  expect(h.runtime.acceptanceBases.get(taskId, preview.basisDigest)).toMatchObject({ current: false, state: 'confirmed' })
  expect(() => h.runtime.acceptanceBases.decide(taskId, { ...decision, requestId: randomUUID(), revision: 1 }))
    .toThrow(expect.objectContaining({ code: 'acceptance_source_unconfirmed' }))
}, 20_000)

it('确认历史达到容量边界仍保留一次撤回，不删除旧事件换取空间', async () => {
  const { input } = await prepare()
  await h.runtime.combinationChecks.verify(taskId, input)
  const preview = h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })
  const decision = { action: 'confirm', sourceCheckId: input.requestId, basisDigest: preview.basisDigest,
    evidence: { source: '需求', rationale: '已核对范围，缺口保留' } }
  for (let revision = 0; revision < 63; revision++)
    h.runtime.acceptanceBases.decide(taskId, { ...decision, revision, requestId: randomUUID() })
  expect(() => h.runtime.acceptanceBases.decide(taskId, { ...decision, revision: 63, requestId: randomUUID() }))
    .toThrow(expect.objectContaining({ code: 'acceptance_budget' }))
  const withdrawn = h.runtime.acceptanceBases.decide(taskId, {
    action: 'withdraw', basisDigest: preview.basisDigest, revision: 63, requestId: randomUUID(),
  })
  expect(withdrawn).toMatchObject({ state: 'withdrawn', revision: 64 })
  expect(withdrawn.events).toHaveLength(64)
}, 20_000)

it('检查映射经配置版本绑定到来源和确认；更新检查不能沿用旧确认', async () => {
  const checks: NonNullable<QualityProfileInput['checks']> = [{
    id: 'contract', title: '原契约检查', requires: [],
    requirements: [{ scope: 'task', index: 0, text: '保持原契约' }, { scope: 'module', index: 0, text: '保持原契约' }],
    command: { tool: 'tool', cwd: { root: 'source', path: '.' }, argv: [{ root: 'recipe', path: 'run.txt' }] },
    result: { format: 'junit-xml', path: 'test-results.xml', minimumTests: 1 }, timeoutMs: 60000,
  }]
  profile = h.runtime.developmentQuality.save({ ...definition, revision: 1, requestId: 'checks', checks }).profile
  const prepared = await prepare()
  const input = { ...prepared.input, profileRevision: 2 }
  await h.runtime.combinationChecks.verify(taskId, input)
  const preview = h.runtime.acceptanceBases.preview(taskId, { sourceCheckId: input.requestId })
  expect(preview.mapping).toMatchObject({ state: 'declared', executionAttempted: false, coverageVerified: false })
  expect(preview.mapping.requirements.every(ref => ref.checks.includes('contract'))).toBe(true)
  const reportDirectory = join(root, 'report-observation')
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(join(reportDirectory, 'test-results.xml'), '<testsuite tests="1"><testcase name="contract"/></testsuite>')
  const reportInput = { sourceCheckId: input.requestId, basisDigest: preview.basisDigest,
    revision: preview.revision, checkId: 'contract', directory: reportDirectory }
  const reportRoute = `tasks/${taskId}/quality/check-report`
  expect((await h.api('POST', reportRoute, reportInput, { 'x-orchestrator-request': '' })).status).toBe(403)
  expect((await h.api('POST', reportRoute, { ...reportInput, minimumTests: 0 })).status).toBe(400)
  const beforeReport = h.runtime.store.db.prepare('SELECT count(*) AS n FROM kv').get()!.n
  expect(await h.api('POST', reportRoute, reportInput)).toMatchObject({ status: 200,
    body: { persisted: false, report: { state: 'content_consistent', counts: { tests: 1 } },
      assurance: { executionAuthenticated: false, reportMatchesSource: false, publishAllowed: false } } })
  expect(h.runtime.store.db.prepare('SELECT count(*) AS n FROM kv').get()!.n).toBe(beforeReport)
  h.runtime.acceptanceBases.decide(taskId, { action: 'confirm', requestId: randomUUID(), sourceCheckId: input.requestId,
    basisDigest: preview.basisDigest, revision: 0, evidence: { source: '独立协议', rationale: '等待真实运行结果' } })
  h.runtime.developmentQuality.save({ ...definition, revision: 2, requestId: 'changed-check', checks: [{
    ...checks[0]!, timeoutMs: 70000,
  }] })
  expect(h.runtime.acceptanceBases.get(taskId, preview.basisDigest)).toMatchObject({ current: false, state: 'confirmed' })
  expect(h.runtime.workspaces.list().items).toEqual([])
}, 25_000)
