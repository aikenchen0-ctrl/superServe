import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyQualitySources } from '../src/development/quality-sources.ts'
import { verifyQualityTools } from '../src/development/quality-tools.ts'
import { DevelopmentQualityProfiles } from '../src/development/quality-profiles.ts'
import { DevelopmentChanges } from '../src/development/changes.ts'
import { inspectDevelopmentSource } from '../src/development/inspect.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'
import * as gitRead from '../src/development/git-read.ts'

vi.setConfig({ testTimeout: 20_000 })
const exec = promisify(execFile), roots: string[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const git = async (root: string, ...args: string[]) => (await exec('git', [
  '-c', 'user.name=Quality source test', '-c', 'user.email=quality-source@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', '-c', 'gc.auto=0',
  '-C', root, ...args,
], { env: gitEnv(), windowsHide: true })).stdout.trim()
async function fixture(format = 'sha1', configuration = 'settings/targets.json') {
  const root = await mkdtemp(join(tmpdir(), 'superserve-quality-sources-'))
  roots.push(root)
  await mkdir(join(root, 'settings'))
  await mkdir(join(root, 'quality/vendor'), { recursive: true })
  const content = '{"targets":["module-a"]}\n'
  await writeFile(join(root, configuration), content)
  await writeFile(join(root, 'quality', 'run.ps1'), 'Write-Output "recipe"\n')
  await writeFile(join(root, 'quality/vendor', 'helper.js'), 'export const value = 1\n')
  await writeFile(join(root, 'quality/vendor', 'copy.js'), 'export const value = 1\n')
  await writeFile(join(root, '.gitattributes'), '* -text\nsettings/targets.json filter=trap diff=trap\n')
  await git(root, 'init', `--object-format=${format}`, '--initial-branch=main')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'fixed inputs')
  const common = await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const repositoryId = sha(JSON.stringify(process.platform === 'win32' ? common.toLowerCase() : common))
  const commit = await git(root, 'rev-parse', 'HEAD'), tree = await git(root, 'rev-parse', 'HEAD:quality')
  return { root, content, request: {
    target: { repositoryPath: root, repositoryId, commit, configuration: { path: configuration, sha256: sha(content) } },
    recipe: { repositoryPath: root, repositoryId, commit, tree, path: 'quality' },
  } }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !target.split(sep).at(-1)!.startsWith('superserve-quality-sources-'))
      throw new Error('测试目录边界不符')
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

it.each(['sha1', 'sha256'])('固定 Git %s 内容匹配；覆盖完整目录且重复 blob 只读取一份', async format => {
  const { root, content, request } = await fixture(format)
  const before = { index: await readFile(join(root, '.git/index')), objects: await git(root, 'count-objects', '-v') }
  const result = await verifyQualitySources(request)
  expect(result).toMatchObject({ status: 'tracked_content_matched',
    configuration: { sha256: sha(content), bytes: Buffer.byteLength(content) },
    recipe: { tree: request.recipe.tree, entries: 4, uniqueObjects: 5, directoryObjects: 4, symlinks: 0, submodules: 0 },
    assurance: { configurationContentVerified: true, recipeTrackedContentVerified: true,
      configurationSemanticsVerified: false, dependencyClosureVerified: false, executionAuthorized: false } })
  expect(result.source.identity).toBe((await inspectDevelopmentSource({ repository: root, revision: request.target.commit })).source.identity)
  expect(await readFile(join(root, '.git/index'))).toEqual(before.index)
  expect(await git(root, 'count-objects', '-v')).toBe(before.objects)
  expect(JSON.stringify(result)).not.toContain('export const')
})

it('提交字节与工作区、暂存和过滤器分离，用户进度不被读取替换或改写', async () => {
  const { root, request } = await fixture()
  await writeFile(join(root, request.target.configuration.path), 'staged progress\n')
  await git(root, 'add', request.target.configuration.path)
  await writeFile(join(root, request.target.configuration.path), 'PRIVATE_WORKING_PROGRESS')
  await writeFile(join(root, '.env.local'), 'PRIVATE_CREDENTIAL')
  await git(root, 'config', 'filter.trap.smudge', 'PRIVATE_FILTER_MUST_NOT_RUN')
  await git(root, 'config', 'filter.trap.clean', 'PRIVATE_FILTER_MUST_NOT_RUN')
  await git(root, 'config', 'filter.trap.required', 'true')
  await git(root, 'config', 'diff.trap.textconv', 'PRIVATE_TEXTCONV_MUST_NOT_RUN')
  const index = await readFile(join(root, '.git/index'))
  const result = await verifyQualitySources(request)
  expect(result.status).toBe('tracked_content_matched')
  expect(await readFile(join(root, request.target.configuration.path), 'utf8')).toBe('PRIVATE_WORKING_PROGRESS')
  expect(await readFile(join(root, '.git/index'))).toEqual(index)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})

it.each(['sha1', 'sha256'])('完整 %s 代码输入包含配置外文件，固定树不因活动进度或空提交而变化', async format => {
  const { root, request } = await fixture(format)
  const input = { ...request, target: { ...request.target, scope: 'committed-tree' as const } }
  const first = await verifyQualitySources(input)
  expect(first.sourceInputs).toMatchObject({ scope: 'committed-tree', files: 5, symlinks: 0, submodules: 0,
    materialized: false, executionAttempted: false, dependencyClosureVerified: false, status: 'tracked_content_matched' })
  const expectedBytes = ['settings/targets.json', '.gitattributes', 'quality/run.ps1', 'quality/vendor/helper.js', 'quality/vendor/copy.js']
  let total = 0
  for (const file of expectedBytes) total += (await readFile(join(root, file))).length
  expect(first.sourceInputs!.logicalFileBytes).toBe(total)
  await writeFile(join(root, 'quality/vendor/helper.js'), 'PRIVATE_NEW_PROGRESS')
  await writeFile(join(root, 'untracked.env'), 'PRIVATE_CREDENTIAL')
  const index = await readFile(join(root, '.git/index'))
  expect((await verifyQualitySources(input)).sourceInputs).toEqual(first.sourceInputs)
  expect(await readFile(join(root, '.git/index'))).toEqual(index)
  await git(root, 'commit', '--allow-empty', '-m', 'metadata only')
  input.target.commit = await git(root, 'rev-parse', 'HEAD')
  expect((await verifyQualitySources(input)).sourceInputs).toEqual(first.sourceInputs)
  expect(JSON.stringify(first.sourceInputs)).not.toContain('helper.js')
  expect(JSON.stringify(first)).not.toContain('PRIVATE_')
})

it('配置和配方以外的对象丢失或损坏时，局部核验不能替代完整输入核验', async () => {
  const { root, request } = await fixture()
  await writeFile(join(root, 'module.bin'), Buffer.from([0, 9, 255, 22]))
  await git(root, 'add', 'module.bin'); await git(root, 'commit', '-m', 'module input')
  request.target.commit = await git(root, 'rev-parse', 'HEAD')
  const blob = await git(root, 'rev-parse', 'HEAD:module.bin')
  const location = join(root, '.git/objects', blob.slice(0, 2), blob.slice(2))
  const original = await readFile(location)
  expect((await verifyQualitySources({ ...request, target: { ...request.target, scope: 'committed-tree' } }))
    .sourceInputs!.files).toBe(6)
  await rm(location)
  expect((await verifyQualitySources(request)).status).toBe('tracked_content_matched')
  await expect(verifyQualitySources({ ...request, target: { ...request.target, scope: 'committed-tree' } }))
    .rejects.toMatchObject({ code: 'quality_object_missing' })
  await writeFile(location, original)
  const replacement = await git(root, 'rev-parse', 'HEAD:quality/run.ps1')
  await copyFile(join(root, '.git/objects', replacement.slice(0, 2), replacement.slice(2)), location)
  await expect(verifyQualitySources({ ...request, target: { ...request.target, scope: 'committed-tree' } }))
    .rejects.toMatchObject({ code: 'quality_object_invalid' })
})

it('代码树引用保留未闭合；重复内容按对象去重，文件逻辑大小仍逐路径统计', async () => {
  const { root, request } = await fixture()
  const binary = Buffer.alloc(64 * 1024, 17)
  await writeFile(join(root, 'first.bin'), binary)
  await writeFile(join(root, 'second.bin'), binary)
  await git(root, 'add', 'first.bin', 'second.bin')
  const blob = await git(root, 'rev-parse', ':first.bin')
  await git(root, 'update-index', '--add', '--cacheinfo', `120000,${blob},source-link`)
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${'9'.repeat(40)},source-submodule`)
  await git(root, 'commit', '-m', 'shared content and references')
  request.target.commit = await git(root, 'rev-parse', 'HEAD')
  const result = await verifyQualitySources({ ...request, target: { ...request.target, scope: 'committed-tree' } })
  expect(result.status).toBe('references_unresolved')
  expect(result.recipe).toMatchObject({ symlinks: 0, submodules: 0 })
  expect(result.sourceInputs).toMatchObject({ files: 7, symlinks: 1, submodules: 1, status: 'references_unresolved' })
  expect(result.sourceInputs!.logicalFileBytes).toBeGreaterThan(2 * binary.length)
  expect(result.sourceInputs!.objectBytes).toBeLessThan(result.sourceInputs!.logicalFileBytes)
})

it('完整代码输入超过旧单批缓冲预算仍可核验，不缩小文件范围或物化大文件', async () => {
  const { root, request } = await fixture()
  await writeFile(join(root, 'large-module.bin'), Buffer.alloc(16 * 1024 * 1024 + 1, 7))
  await git(root, 'add', 'large-module.bin'); await git(root, 'commit', '-m', 'large module')
  request.target.commit = await git(root, 'rev-parse', 'HEAD')
  expect((await verifyQualitySources(request)).status).toBe('tracked_content_matched')
  const result = await verifyQualitySources({ ...request, target: { ...request.target, scope: 'committed-tree' } })
  expect(result.sourceInputs).toMatchObject({ files: 6, materialized: false, executionAttempted: false })
  expect(result.sourceInputs!.objectBytes).toBeGreaterThan(16 * 1024 * 1024)
})

it('代码清单超过旧条数仍完整核验；复用 blob 不缩小文件数', async () => {
  const { root, request } = await fixture(), blob = await git(root, 'rev-parse', 'HEAD:quality/run.ps1')
  await new Promise<void>((done, reject) => {
    const child = execFile('git', ['-C', root, 'update-index', '--index-info'],
      { env: gitEnv(), windowsHide: true }, error => error ? reject(error) : done())
    child.stdin!.on('error', reject)
    child.stdin!.end(Array.from({ length: 10_001 }, (_, i) => `100644 ${blob}\tgenerated-${i}.txt\n`).join(''))
  })
  await git(root, 'commit', '-m', 'large tracked inventory')
  request.target.commit = await git(root, 'rev-parse', 'HEAD')
  const result = await verifyQualitySources({ ...request, target: { ...request.target, scope: 'committed-tree' } })
  expect(result.sourceInputs!.files).toBe(10_006)
  expect(result.sourceInputs!.uniqueObjects).toBeLessThan(20)
})

it('元数据超出代码输入总量预算时先拒绝，不启动正文读取或返回部分成功', async () => {
  const { root, request } = await fixture()
  const original = gitRead.gitReader
  let oversizedReadAttempted = false
  const blob = await git(root, 'rev-parse', 'HEAD:.gitattributes')
  vi.spyOn(gitRead, 'gitReader').mockImplementation((...args) => {
    const reader = original(...args)
    return { ...reader, git: async (argv, options) => {
      const result = await reader.git(argv, options)
      if (argv[0] !== 'cat-file' || argv[1] !== '--batch-check') return result
      return Buffer.from(result.toString('ascii').split('\n').map(line => line.startsWith(`${blob} blob `)
        ? `${blob} blob ${513 * 1024 * 1024}` : line).join('\n'))
    }, streamObjects: async (input, limit, consume) => {
      if (input.toString().includes(blob)) oversizedReadAttempted = true
      return reader.streamObjects(input, limit, consume)
    } }
  })
  await expect(verifyQualitySources({ ...request, target: { ...request.target, scope: 'committed-tree' } }))
    .rejects.toMatchObject({ code: 'quality_source_budget' })
  expect(oversizedReadAttempted).toBe(false)
})

it('对象流开始后取消不能返回输入回执；结束前不会留下继续回调', async () => {
  const { root, request } = await fixture(), controller = new AbortController()
  await writeFile(join(root, 'large-module.bin'), Buffer.alloc(2 * 1024 * 1024, 19))
  await git(root, 'add', 'large-module.bin'); await git(root, 'commit', '-m', 'cancellable input')
  request.target.commit = await git(root, 'rev-parse', 'HEAD')
  const reader = gitRead.gitReader({ repository: root }, () => root, controller.signal)
  const blob = await git(root, 'rev-parse', 'HEAD:large-module.bin')
  let chunks = 0
  await expect(reader.streamObjects(Buffer.from(blob + '\n'), 3 * 1024 * 1024, () => {
    chunks++; controller.abort()
  })).rejects.toMatchObject({ code: 'cancelled' })
  const final = chunks
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(chunks).toBe(final)
  expect(chunks).toBeGreaterThan(0)
})

it('对象流超出已核对长度或消费失败时关闭读取；下一次独立读取仍完整', async () => {
  const { root } = await fixture(), blob = await git(root, 'rev-parse', 'HEAD:quality/run.ps1')
  const reader = gitRead.gitReader({ repository: root }, () => root, AbortSignal.timeout(10_000))
  const input = Buffer.from(blob + '\n')
  await expect(reader.streamObjects(input, 1, () => {})).rejects.toMatchObject({ code: 'output_limit' })
  const original = new Error('消费方拒绝')
  await expect(reader.streamObjects(input, 4096, () => { throw original })).rejects.toBe(original)
  let bytes = 0
  await reader.streamObjects(input, 4096, chunk => { bytes += chunk.length })
  expect(bytes).toBeGreaterThan(40)
})

it('对象流执行程序不存在时明确失败，不把空输出当成功或挂起', async () => {
  const { root } = await fixture()
  const reader = gitRead.gitReader({ repository: root, git: join(root, 'missing-git.exe') },
    () => root, AbortSignal.timeout(10_000))
  await expect(reader.streamObjects(Buffer.from('0'.repeat(40) + '\n'), 4096, () => {}))
    .rejects.toMatchObject({ code: 'git_unavailable' })
})

it('异步消费有背压，读取返回前必须等待最后一块消费，消费拒绝后不继续回调', async () => {
  const { root } = await fixture()
  await writeFile(join(root, 'stream.bin'), Buffer.alloc(1024 * 1024, 37))
  await git(root, 'add', 'stream.bin'); await git(root, 'commit', '-m', 'backpressure')
  const blob = await git(root, 'rev-parse', 'HEAD:stream.bin')
  const reader = gitRead.gitReader({ repository: root }, () => root, AbortSignal.timeout(10_000))
  let inflight = 0, max = 0, calls = 0, complete = 0
  await reader.streamObjects(Buffer.from(blob + '\n'), 2 * 1024 * 1024, async () => {
    calls++; inflight++; max = Math.max(max, inflight)
    await new Promise(resolve => setTimeout(resolve, 1))
    complete++; inflight--
  })
  expect(max).toBe(1); expect(complete).toBe(calls); expect(inflight).toBe(0)
  let failedCalls = 0
  const rejected = new Error('异步消费失败')
  await expect(reader.streamObjects(Buffer.from(blob + '\n'), 2 * 1024 * 1024, async () => {
    failedCalls++; await Promise.resolve(); throw rejected
  })).rejects.toBe(rejected)
  expect(failedCalls).toBe(1)
})

it('完整配方变化不能被入口未变隐藏；仍可读取明确选择的旧提交', async () => {
  const { root, request } = await fixture()
  const first = await verifyQualitySources(request)
  await writeFile(join(root, 'quality/vendor/helper.js'), 'export const value = 2\n')
  await git(root, 'add', 'quality/vendor/helper.js')
  await git(root, 'commit', '-m', 'vendor changed')
  expect((await verifyQualitySources(request)).recipe.manifestDigest).toBe(first.recipe.manifestDigest)
  request.recipe.commit = await git(root, 'rev-parse', 'HEAD')
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_recipe_tree_mismatch' })
  request.recipe.tree = await git(root, 'rev-parse', 'HEAD:quality')
  expect((await verifyQualitySources(request)).recipe.manifestDigest).not.toBe(first.recipe.manifestDigest)
})

it('配方可位于其他登记仓库，错误身份不能借用相同文件内容', async () => {
  const target = await fixture(), recipe = await fixture()
  target.request.recipe = recipe.request.recipe
  expect((await verifyQualitySources(target.request)).recipe.repositoryId).toBe(recipe.request.recipe.repositoryId)
  target.request.recipe.repositoryId = target.request.target.repositoryId
  await expect(verifyQualitySources(target.request)).rejects.toMatchObject({ code: 'quality_recipe_repository_mismatch' })
})

it('根目录配方以及带空格和前导横线的配置路径按精确字面量处理', async () => {
  const value = await fixture('sha1', '-settings file.json')
  value.request.recipe.path = '.'
  value.request.recipe.tree = await git(value.root, 'rev-parse', 'HEAD^{tree}')
  expect((await verifyQualitySources(value.request)).configuration.path).toBe('-settings file.json')
})

it('配置必须在固定提交中存在且内容匹配，不回退到当前文件', async () => {
  const { root, request } = await fixture()
  request.target.configuration.sha256 = '0'.repeat(64)
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_configuration_mismatch' })
  await writeFile(join(root, 'only-local.json'), 'local')
  request.target.configuration = { path: 'only-local.json', sha256: sha('local') }
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_path_missing' })
})

it('配置符号链接不跟随；配方链接和 Gitlink 保留未闭合状态', async () => {
  const { root, request } = await fixture()
  await writeFile(join(root, 'link-body.txt'), '../PRIVATE_OUTSIDE')
  await git(root, 'add', 'link-body.txt')
  const link = await git(root, 'rev-parse', ':link-body.txt')
  await git(root, 'update-index', '--add', '--cacheinfo', `120000,${link},settings/link.json`)
  await git(root, 'update-index', '--add', '--cacheinfo', `120000,${link},quality/link`)
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${'9'.repeat(40)},quality/submodule`)
  await git(root, 'commit', '-m', 'references')
  request.target.commit = request.recipe.commit = await git(root, 'rev-parse', 'HEAD')
  request.recipe.tree = await git(root, 'rev-parse', 'HEAD:quality')
  const result = await verifyQualitySources(request)
  expect(result).toMatchObject({ status: 'references_unresolved', recipe: { symlinks: 1, submodules: 1 },
    assurance: { dependencyClosureVerified: false } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTSIDE')
  request.target.configuration = { path: 'settings/link.json', sha256: sha('../PRIVATE_OUTSIDE') }
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_configuration_type' })
})

it('本地 replace 引用不能改写所选提交内容', async () => {
  const { root, request } = await fixture()
  await writeFile(join(root, request.target.configuration.path), 'different')
  await git(root, 'add', request.target.configuration.path)
  await git(root, 'commit', '-m', 'replacement')
  await git(root, 'replace', request.target.commit, await git(root, 'rev-parse', 'HEAD'))
  expect((await verifyQualitySources(request)).configuration.sha256).toBe(request.target.configuration.sha256)
})

it('缺失配方 blob 明确缺证，不静默跳过或联网补取', async () => {
  const { root, request } = await fixture()
  const blob = await git(root, 'rev-parse', 'HEAD:quality/vendor/helper.js')
  await git(root, 'config', 'extensions.partialClone', 'origin')
  await git(root, 'config', 'remote.origin.promisor', 'true')
  await git(root, 'config', 'remote.origin.url', join(root, 'unavailable-remote'))
  await rm(join(root, '.git/objects', blob.slice(0, 2), blob.slice(2)))
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_object_missing' })
})

it('对象路径下放入其他合法压缩对象也不能伪装为原对象', async () => {
  const { root, request } = await fixture()
  const original = await git(root, 'rev-parse', 'HEAD:quality/vendor/helper.js')
  const replacement = await git(root, 'rev-parse', 'HEAD:quality/run.ps1')
  const location = (value: string) => join(root, '.git/objects', value.slice(0, 2), value.slice(2))
  await chmod(location(original), 0o600)
  await copyFile(location(replacement), location(original))
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_object_invalid' })
})

it('配置 blob 正确但父目录对象被替换时，不宣称文件属于所选提交', async () => {
  const { root, content, request } = await fixture()
  await mkdir(join(root, 'alternative'))
  await writeFile(join(root, 'alternative/targets.json'), content)
  await writeFile(join(root, 'alternative/extra.txt'), 'different directory')
  await git(root, 'add', 'alternative')
  await git(root, 'commit', '-m', 'alternative tree')
  request.target.commit = await git(root, 'rev-parse', 'HEAD')
  const original = await git(root, 'rev-parse', 'HEAD:settings')
  const replacement = await git(root, 'rev-parse', 'HEAD:alternative')
  const location = (value: string) => join(root, '.git/objects', value.slice(0, 2), value.slice(2))
  await chmod(location(original), 0o600)
  await copyFile(location(replacement), location(original))
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_object_invalid' })
})

it('独立配方的目录内容正确但提交根目录被替换时，不能认定来源匹配', async () => {
  const target = await fixture(), recipe = await fixture()
  const original = await git(recipe.root, 'rev-parse', 'HEAD^{tree}')
  await writeFile(join(recipe.root, 'extra.txt'), 'outside recipe')
  await git(recipe.root, 'add', 'extra.txt')
  await git(recipe.root, 'commit', '-m', 'different parent')
  const replacement = await git(recipe.root, 'rev-parse', 'HEAD^{tree}')
  const location = (value: string) => join(recipe.root, '.git/objects', value.slice(0, 2), value.slice(2))
  target.request.recipe = recipe.request.recipe
  expect((await verifyQualitySources(target.request)).status).toBe('tracked_content_matched')
  await chmod(location(original), 0o600)
  await copyFile(location(replacement), location(original))
  // Git 也可能先拒绝坏 tree；验收要求是拒绝来源结论，不限定发现错误的层次。
  await expect(verifyQualitySources(target.request)).rejects.toMatchObject({
    code: expect.stringMatching(/^(quality_object_invalid|git_failed)$/),
  })
})

it.each(['configuration', 'recipe'])('超过 %s 核验预算时不缩小范围返回通过', async part => {
  const { root, request } = await fixture()
  const name = part === 'configuration' ? request.target.configuration.path : 'quality/vendor/large.bin'
  await writeFile(join(root, name), Buffer.alloc((part === 'configuration' ? 4 : 16) * 1024 * 1024 + 1, 120))
  await git(root, 'add', name)
  await git(root, 'commit', '-m', 'large input')
  request.target.commit = request.recipe.commit = await git(root, 'rev-parse', 'HEAD')
  request.recipe.tree = await git(root, 'rev-parse', 'HEAD:quality')
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'quality_source_budget' })
})

it('预取消与非完整提交拒绝返回部分来源证明', async () => {
  const { request } = await fixture(), controller = new AbortController()
  controller.abort()
  await expect(verifyQualitySources(request, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
  request.target.commit = 'HEAD'
  await expect(verifyQualitySources(request)).rejects.toMatchObject({ code: 'invalid_quality_source' })
})

const profileInput = (module: { id: string; revision: number }, request: Awaited<ReturnType<typeof fixture>>['request']) => ({
  requestId: 'quality', revision: 0, name: 'quality', module,
  format: 'jvm-trial-v1' as const,
  configuration: request.target.configuration,
  recipe: { repositoryId: request.recipe.repositoryId, commit: request.recipe.commit, tree: request.recipe.tree, path: request.recipe.path },
  tools: [{ name: 'java', version: '17', sha256: 'a'.repeat(64) }],
  environment: { runtime: 'windows' as const, architecture: 'x64' as const },
})
const moduleInput = (root: string) => ({ requestId: 'module', revision: 0, repositoryPath: root,
  name: 'module', paths: ['settings'], contracts: [], acceptance: ['保持完整验收要求'] })

it.each(['profile', 'module', 'shutdown'])('内容匹配后 %s 改变也不能返回过时绑定', async change => {
  const { root, request } = await fixture(), store = new Store(join(root, 'state.sqlite'))
  let available = true
  try {
    const modules = new DevelopmentChanges(store, { available: () => available, inspect: inspectDevelopmentSource })
    const module = (await modules.saveModule(moduleInput(root))).module
    const input = profileInput({ id: module.id, revision: module.revision }, request)
    const profiles = new DevelopmentQualityProfiles(store, modules, { available: () => available, inspect: inspectDevelopmentSource,
      verifyTools: verifyQualityTools,
      verifySources: async value => {
        const result = await verifyQualitySources(value)
        if (change === 'profile') profiles.save({ ...input, requestId: 'update', revision: 1 })
        else if (change === 'module') await modules.saveModule({ ...moduleInput(root), requestId: 'new-module', revision: 1 })
        else available = false
        return result
      } })
    const saved = profiles.save(input).profile
    await expect(profiles.verifySources({ profileId: saved.id, profileRevision: saved.revision,
      repositoryPath: root, commit: request.target.commit })).rejects.toMatchObject({
      code: change === 'profile' ? 'quality_profile_changed' : change === 'module' ? 'quality_module_changed' : 'runtime_unavailable',
    })
  } finally { store.close() }
})

it('真实 Runtime/HTTP 核验绑定当前配置，不保存运行、不授予执行资格', async () => {
  const { root, request } = await fixture(), h = await startRuntime(undefined, { mode: 'hmm' })
  try {
    const registration = await h.api('POST', 'development/modules', moduleInput(root))
    const module = registration.body.module as { id: string; revision: number }
    const saved = await h.api('POST', 'development/quality-profiles', profileInput({ id: module.id, revision: module.revision }, request))
    expect(saved.status).toBe(200)
    const profile = saved.body.profile as { id: string; revision: number }
    const count = () => h.runtime.store.db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'development:quality-%'").get()!.n
    const before = count()
    const result = await h.api('POST', 'development/quality-bindings/verify-sources', {
      profileId: profile.id, profileRevision: profile.revision, repositoryPath: root, commit: request.target.commit,
    })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ persisted: false, assurance: { executionAuthorized: false, toolsVerified: false },
      verification: { status: 'tracked_content_matched', assurance: { configurationContentVerified: true } } })
    expect(count()).toBe(before)
  } finally { await h.stop() }
})
