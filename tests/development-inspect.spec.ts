import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectDevelopmentSource } from '../src/development/inspect.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, access: vi.fn(original.access) }
})

const exec = promisify(execFile)
const directories: string[] = []
const fixtureEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
async function git(repository: string, ...args: string[]) {
  const { stdout } = await exec('git', ['-c', 'user.name=Source inspection test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', '-c', 'core.autocrlf=false',
    '-C', repository, ...args], { env: fixtureEnv, windowsHide: true })
  return stdout.trim()
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'superserve-source-inspection-'))
  directories.push(root)
  return root
}
async function repository() {
  const root = await directory()
  await git(root, 'init', '--initial-branch=main')
  await writeFile(join(root, 'tracked.txt'), 'original\n')
  await writeFile(join(root, '.gitignore'), '.env*\nbuild/\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'initial fixture')
  return root
}
afterEach(async () => {
  vi.mocked(fs.access).mockReset()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})

it('检查期间索引变化会报告不稳定，不能将两次不同观测拼成冻结快照', async () => {
  const root = await repository()
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).access
  let changed = false
  vi.mocked(fs.access).mockImplementationOnce(async (...args) => {
    changed = true
    await writeFile(join(root, 'tracked.txt'), 'changed during inspection\n')
    await git(root, 'add', 'tracked.txt')
    return original(...args)
  })
  const result = await inspectDevelopmentSource({ repository: root })
  expect(changed).toBe(true)
  expect(result.workspace?.observedChange).toBe(true)
  expect(result.workspace?.status.stagedEntries).toBe(1)
  expect(result.assurance.currentProgressCaptured).toBe(false)
  expect(result.assurance.candidateAccepted).toBe(false)
})

it('固定提交身份不随工作区改动漂移，准确区分暂存、未暂存、新文件和忽略项，不泄露内容', async () => {
  const root = await repository()
  const commit = await git(root, 'rev-parse', 'HEAD')
  const tree = await git(root, 'rev-parse', 'HEAD^{tree}')
  await writeFile(join(root, 'tracked.txt'), 'staged\n')
  await git(root, 'add', 'tracked.txt')
  await writeFile(join(root, 'tracked.txt'), 'uncommitted\n')
  await writeFile(join(root, 'PRIVATE_FILENAME.txt'), 'PRIVATE_NEW_FILE_BODY')
  await writeFile(join(root, '.env.local'), 'PRIVATE_CREDENTIAL_MUST_NOT_LEAK')
  const indexPath = join(root, '.git', 'index')
  const before = { index: await readFile(indexPath), metadata: await stat(indexPath),
    head: await readFile(join(root, '.git', 'HEAD')), objects: await git(root, 'count-objects', '-v') }
  const dirty = await inspectDevelopmentSource({ repository: root })
  expect(dirty.source).toMatchObject({ commit, tree })
  expect(dirty.workspace).toMatchObject({
    head: commit, status: { trackedEntries: 1, stagedEntries: 1, unstagedEntries: 1,
      conflicts: 0, untrackedEntries: 1, ignoredEntries: 1 },
    currentProgress: 'unfrozen', ownership: 'unverified', executionReuse: 'not-authorized', observedChange: false,
    contentFilters: 'disabled', submoduleWorktrees: 'not-inspected',
  })
  expect(dirty.assurance).toEqual({ sourceScope: 'committed-tree-only', currentProgressCaptured: false,
    dependencyClosureVerified: false, secretsReviewed: false, candidateAccepted: false, publishAllowed: false })
  expect(JSON.stringify(dirty)).not.toContain('PRIVATE_')
  expect(await readFile(indexPath)).toEqual(before.index)
  expect((await stat(indexPath)).mtimeMs).toBe(before.metadata.mtimeMs)
  expect(await readFile(join(root, '.git', 'HEAD'))).toEqual(before.head)
  expect(await git(root, 'count-objects', '-v')).toBe(before.objects)
  expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('uncommitted\n')
})

it('相同提交在独立克隆和子目录中有相同身份', async () => {
  const root = await repository(), clone = await directory()
  const first = await inspectDevelopmentSource({ repository: root })
  await git(root, 'clone', '--no-hardlinks', root, clone)
  await mkdir(join(clone, 'nested'))
  expect((await inspectDevelopmentSource({ repository: join(clone, 'nested') })).source).toEqual(first.source)
})

it('裸仓库可以只读识别源码，不要求物化工作树', async () => {
  const root = await repository(), bare = await directory()
  const first = await inspectDevelopmentSource({ repository: root })
  await git(root, 'clone', '--bare', '--no-hardlinks', root, bare)
  const archived = await inspectDevelopmentSource({ repository: bare })
  expect(archived.source).toEqual(first.source)
  expect(archived.workspace).toBeNull()
  expect(archived.repository.bare).toBe(true)
})

it('空提交可能影响生成版本，身份不能只看相同代码树', async () => {
  const root = await repository()
  const first = await inspectDevelopmentSource({ repository: root })
  await git(root, 'commit', '--allow-empty', '-m', 'metadata changes may affect generated version')
  const second = await inspectDevelopmentSource({ repository: root })
  expect(second.source.tree).toBe(first.source.tree)
  expect(second.source.identity).not.toBe(first.source.identity)
})

it('skip-worktree 和 assume-unchanged 不能被干净状态掩盖，外部索引环境不能改变被检查对象', async () => {
  const root = await repository()
  await writeFile(join(root, 'other.txt'), 'other\n')
  await git(root, 'add', 'other.txt')
  await git(root, 'commit', '-m', 'add file')
  await git(root, 'update-index', '--skip-worktree', 'tracked.txt')
  await git(root, 'update-index', '--assume-unchanged', 'other.txt')
  vi.stubEnv('GIT_INDEX_FILE', join(root, 'must-not-create-index'))
  vi.stubEnv('GIT_WORK_TREE', join(root, 'must-not-read'))
  const result = await inspectDevelopmentSource({ repository: root })
  expect(result.workspace?.index).toMatchObject({ skipWorktreeEntries: 1, assumeUnchangedEntries: 1 })
  expect(result.workspace?.executionReuse).toBe('not-authorized')
  await expect(stat(join(root, 'must-not-create-index'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('不触发仓库配置的 fsmonitor 或内容过滤器', async () => {
  const root = await repository()
  await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=unsafe\n')
  await git(root, 'add', '.gitattributes')
  await git(root, 'commit', '-m', 'filter declaration')
  await git(root, 'config', 'filter.unsafe.clean', 'echo UNEXPECTED > filter-ran; cat')
  await git(root, 'config', 'filter.unsafe.process', 'echo UNEXPECTED > process-ran; exit 1')
  await git(root, 'config', 'filter.unsafe.required', 'true')
  await git(root, 'config', 'core.fsmonitor', 'echo UNEXPECTED > monitor-ran')
  await writeFile(join(root, 'tracked.txt'), 'modified enough to refresh status\n')
  const result = await inspectDevelopmentSource({ repository: root })
  expect(result.workspace?.status.unstagedEntries).toBe(1)
  for (const path of ['filter-ran', 'process-ran', 'monitor-ran'])
    await expect(stat(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('报告未解决合并及锁文件，仅观测而不清理或重置', async () => {
  const root = await repository()
  await git(root, 'switch', '-c', 'side')
  await writeFile(join(root, 'tracked.txt'), 'side\n')
  await git(root, 'commit', '-am', 'side change')
  await git(root, 'switch', 'main')
  await writeFile(join(root, 'tracked.txt'), 'main\n')
  await git(root, 'commit', '-am', 'main change')
  await expect(git(root, 'merge', '--no-edit', 'side')).rejects.toThrow()
  await writeFile(join(root, '.git', 'index.lock'), 'external writer')
  const result = await inspectDevelopmentSource({ repository: root })
  expect(result.workspace?.status.conflicts).toBe(1)
  expect(result.workspace?.operations).toEqual(expect.arrayContaining(['index.lock', 'MERGE_HEAD']))
  expect(await readFile(join(root, '.git', 'index.lock'), 'utf8')).toBe('external writer')
})

it('子模块只记录 gitlink，符号链接只计入代码树，不冒充完整依赖闭包或读取目标', async () => {
  const root = await repository()
  const commit = await git(root, 'rev-parse', 'HEAD')
  const blob = await git(root, 'rev-parse', 'HEAD:tracked.txt')
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},external-component`)
  await git(root, 'update-index', '--add', '--cacheinfo', `120000,${blob},symbolic-link`)
  await git(root, 'commit', '-m', 'gitlink fixture')
  const result = await inspectDevelopmentSource({ repository: root })
  expect(result.source.entries.submodules).toBe(1)
  expect(result.source.entries.symlinks).toBe(1)
  expect(result.assurance.dependencyClosureVerified).toBe(false)
})

it('选中的提交存在但引用失效、路径错误或取消时明确失败，不返回部分结果或原始错误内容', async () => {
  const root = await repository()
  await expect(inspectDevelopmentSource({ repository: root, revision: 'PRIVATE_INVALID_REF' }))
    .rejects.toMatchObject({ code: 'git_failed', message: expect.not.stringContaining('PRIVATE_') })
  await expect(inspectDevelopmentSource({ repository: root, revision: '--output=unsafe' }))
    .rejects.toMatchObject({ code: 'git_failed' })
  await expect(inspectDevelopmentSource({ repository: root, revision: 'bad\nref' }))
    .rejects.toMatchObject({ code: 'invalid_request' })
  await expect(inspectDevelopmentSource({ repository: join(root, 'missing') }))
    .rejects.toMatchObject({ code: 'path_unavailable' })
  const abort = new AbortController()
  abort.abort()
  await expect(inspectDevelopmentSource({ repository: root, signal: abort.signal }))
    .rejects.toMatchObject({ code: 'cancelled' })
})
