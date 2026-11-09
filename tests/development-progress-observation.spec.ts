import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptionsWithBufferEncoding } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { observeDevelopmentProgress } from '../src/development/inspect.ts'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFile: vi.fn(original.execFile) }
})

const native = await vi.importActual<typeof import('node:child_process')>('node:child_process')
const exec = promisify(native.execFile)
const roots: string[] = []
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' }
async function git(root: string, ...args: string[]) {
  return (await exec('git', ['-c', 'user.name=Observation test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', '-c', 'core.autocrlf=false',
    '-C', root, ...args], { env, windowsHide: true })).stdout.trim()
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'superagent-progress-observation-'))
  roots.push(root)
  return root
}
async function repository() {
  const root = await directory()
  await git(root, 'init', '--initial-branch=main')
  await writeFile(join(root, 'tracked.txt'), 'original\n')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-m', 'baseline')
  return root
}
type GitCallback = (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void
function onCommandClose(action: (args: readonly string[]) => void) {
  const run = (file: string, args: readonly string[], options: ExecFileOptionsWithBufferEncoding,
    callback: GitCallback) => {
    const child = native.execFile(file, args, options, callback)
    // 只注入真实文件变化；命令、退出状态及输出仍来自真实 Git。
    child.prependOnceListener('close', () => action(args))
    return child
  }
  vi.mocked(execFile).mockImplementation(run as typeof execFile)
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(execFile).mockImplementation(native.execFile)
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`))
      throw new Error('进度观测测试只能清理自身临时目录')
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

it('分开观测暂存和未暂存差异，新文件仅记录名称摘要，不保存正文或凭据值', async () => {
  const root = await repository()
  await writeFile(join(root, 'tracked.txt'), 'staged PRIVATE_BODY\n')
  await git(root, 'add', 'tracked.txt')
  await writeFile(join(root, 'tracked.txt'), 'unstaged PRIVATE_BODY\n')
  await writeFile(join(root, 'new.txt'), 'new PRIVATE_BODY\n')
  await writeFile(join(root, '.env'), 'PRIVATE_TOKEN=do-not-return\n')
  const result = await observeDevelopmentProgress({ repository: root, context: 'goal-context' })
  expect(result).toMatchObject({
    sampledConsistent: true, observedChange: false, writerFrozen: false, progressCaptured: false,
    secretsReviewed: false, submoduleWorktreesInspected: false, candidateEligible: false, publishAllowed: false,
    status: { stagedEntries: 1, unstagedEntries: 1, untrackedEntries: 2 },
    changes: { untracked: { entries: 2, namesDigest: expect.stringMatching(/^[0-9a-f]{64}$/), contentRead: false } },
  })
  expect(result.source.commit).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  expect(result.source.tree).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  expect(result.changes.staged.bytes).toBeGreaterThan(0)
  expect(result.changes.unstaged.bytes).toBeGreaterThan(0)
  expect(result.changes.staged.digest).not.toBe(result.changes.unstaged.digest)
  expect(result.contextDigest).toMatch(/^[0-9a-f]{64}$/)
  for (const value of ['PRIVATE_BODY', 'PRIVATE_TOKEN', 'goal-context', 'new.txt', '.env', root])
    expect(JSON.stringify(result)).not.toContain(value)
})

it('根目录和子目录观测同一工作区；身份摘要不暴露路径', async () => {
  const root = await repository()
  await mkdir(join(root, 'nested'))
  const [first, second] = await Promise.all([
    observeDevelopmentProgress({ repository: root }),
    observeDevelopmentProgress({ repository: join(root, 'nested') }),
  ])
  expect(second).toEqual(first)
  expect(first.repository).toMatch(/^[0-9a-f]{64}$/)
  expect(first.source.index).toMatch(/^[0-9a-f]{64}$/)
  expect(first.observationDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(first)).not.toContain(root)
})

it('只读观测不写索引、HEAD、Git 对象或工作树文件', async () => {
  const root = await repository(), index = join(root, '.git', 'index')
  const before = { index: await readFile(index), time: (await stat(index)).mtimeMs,
    objects: await git(root, 'count-objects', '-v'), head: await readFile(join(root, '.git', 'HEAD')) }
  const result = await observeDevelopmentProgress({ repository: root })
  expect(await readFile(index)).toEqual(before.index)
  expect((await stat(index)).mtimeMs).toBe(before.time)
  expect(await git(root, 'count-objects', '-v')).toBe(before.objects)
  expect(await readFile(join(root, '.git', 'HEAD'))).toEqual(before.head)
  expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('original\n')
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(result.source.commit)
})

it('未跟踪文件正文变化不会变成内容捕获或稳定性证明', async () => {
  const root = await repository()
  await writeFile(join(root, 'new.txt'), 'PRIVATE_FIRST')
  let mutations = 0
  onCommandClose(args => {
    if (args.includes('--others') && mutations++ === 0)
      writeFileSync(join(root, 'new.txt'), 'PRIVATE_OTHER')
  })
  const result = await observeDevelopmentProgress({ repository: root })
  expect(mutations).toBe(2)
  expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('PRIVATE_OTHER')
  expect(result).toMatchObject({
    sampledConsistent: true, progressCaptured: false, writerFrozen: false, candidateEligible: false,
    changes: { untracked: { entries: 1, contentRead: false } },
  })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})

it('真实文件在两次差异采样之间变化时明确报告，不返回一致结论', async () => {
  const root = await repository()
  await writeFile(join(root, 'tracked.txt'), 'first edit\n')
  let mutations = 0
  onCommandClose(args => {
    if (args.includes('diff') && !args.includes('--cached') && mutations++ === 0)
      writeFileSync(join(root, 'tracked.txt'), 'second longer edit\n')
  })
  const result = await observeDevelopmentProgress({ repository: root })
  expect(mutations).toBe(2)
  expect(result).toMatchObject({ sampledConsistent: false, observedChange: true, progressCaptured: false,
    candidateEligible: false, publishAllowed: false })
})

it('索引损坏必须报错，不能以空索引摘要冒充可用结果', async () => {
  const root = await repository()
  await writeFile(join(root, '.git', 'index'), 'PRIVATE_CORRUPT_INDEX')
  await expect(observeDevelopmentProgress({ repository: root })).rejects.toMatchObject({
    code: 'git_failed', message: expect.not.stringContaining('PRIVATE_'),
  })
  expect(await readFile(join(root, '.git', 'index'), 'utf8')).toBe('PRIVATE_CORRUPT_INDEX')
})

it('链接工作树读取自己的语义索引，不假定索引位于工作目录的 .git 下', async () => {
  const root = await repository(), linked = await directory()
  await git(root, 'worktree', 'add', '--detach', linked, 'HEAD')
  const originalIndex = await readFile(join(root, '.git', 'index'))
  await writeFile(join(linked, 'tracked.txt'), 'linked staged edit\n')
  await git(linked, 'add', 'tracked.txt')
  const result = await observeDevelopmentProgress({ repository: linked })
  expect(result.status).toMatchObject({ stagedEntries: 1, unstagedEntries: 0 })
  expect(result.changes.staged.bytes).toBeGreaterThan(0)
  expect(result.source.commit).toBe(await git(root, 'rev-parse', 'HEAD'))
  expect(await readFile(join(root, '.git', 'index'))).toEqual(originalIndex)
  expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('original\n')
})

it('二进制已跟踪文件保留两层差异，不把非文本修改遗漏为干净状态', async () => {
  const root = await repository()
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
  await git(root, 'add', 'binary.dat')
  await git(root, 'commit', '-m', 'binary baseline')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 3, 4]))
  await git(root, 'add', 'binary.dat')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 5, 6]))
  const result = await observeDevelopmentProgress({ repository: root })
  expect(result.status).toMatchObject({ stagedEntries: 1, unstagedEntries: 1 })
  expect(result.changes.staged.bytes).toBeGreaterThan(0)
  expect(result.changes.unstaged.bytes).toBeGreaterThan(0)
  expect(result.changes.staged.digest).not.toBe(result.changes.unstaged.digest)
  expect(result.progressCaptured).toBe(false)
})

it('禁用已配置的过滤器、外部差异命令及监控钩子', async () => {
  const root = await repository()
  await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=unsafe diff=unsafe\n')
  await git(root, 'add', '.gitattributes')
  await git(root, 'commit', '-m', 'attributes')
  for (const [key, marker] of [
    ['filter.unsafe.clean', 'clean-ran'], ['filter.unsafe.process', 'process-ran'],
    ['diff.unsafe.command', 'diff-ran'], ['diff.unsafe.textconv', 'textconv-ran'],
    ['core.fsmonitor', 'monitor-ran'],
  ] as const) await git(root, 'config', key, `echo UNEXPECTED > ${marker}; cat`)
  await git(root, 'config', 'filter.unsafe.required', 'true')
  await writeFile(join(root, 'tracked.txt'), 'local edit\n')
  const result = await observeDevelopmentProgress({ repository: root })
  expect(result.changes.unstaged.bytes).toBeGreaterThan(0)
  for (const marker of ['clean-ran', 'process-ran', 'diff-ran', 'textconv-ran', 'monitor-ran'])
    await expect(stat(join(root, marker))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('索引跳过标志显式保留，继承的 Git 环境不能改换观测对象', async () => {
  const root = await repository()
  await git(root, 'update-index', '--skip-worktree', 'tracked.txt')
  vi.stubEnv('GIT_INDEX_FILE', join(root, 'wrong-index'))
  vi.stubEnv('GIT_WORK_TREE', join(root, 'wrong-tree'))
  const result = await observeDevelopmentProgress({ repository: root })
  expect(result.indexFlags).toEqual({ skipWorktreeEntries: 1, assumeUnchangedEntries: 0 })
  expect(result.progressCaptured).toBe(false)
  await expect(stat(join(root, 'wrong-index'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('取消回调早于句柄关闭时，不允许调用方提前完成清理', async () => {
  const root = await repository()
  const abort = new AbortController(), child = new EventEmitter()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const run = (_file: string, _args: readonly string[], options: ExecFileOptionsWithBufferEncoding,
    callback: GitCallback) => {
    options.signal!.addEventListener('abort', () => {
      callback(Object.assign(new Error('PRIVATE_ABORT'), { code: 'ABORT_ERR' }), Buffer.alloc(0), Buffer.alloc(0))
    }, { once: true })
    started()
    return child as ChildProcess
  }
  vi.mocked(execFile).mockImplementationOnce(run as typeof execFile)
  let settled = false
  const result = observeDevelopmentProgress({ repository: root, signal: abort.signal })
    .then(value => { settled = true; return value }, error => { settled = true; return error })
  await ready
  abort.abort()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  child.emit('close', null, 'SIGTERM')
  expect(await result).toMatchObject({ code: 'cancelled', message: expect.not.stringContaining('PRIVATE_') })
})

it('输入超限、非当前引用、路径失效、执行程序缺失或预取消时不返回部分结果', async () => {
  const root = await repository()
  await expect(observeDevelopmentProgress({ repository: root, context: 'x'.repeat(64 * 1024 + 1) }))
    .rejects.toMatchObject({ code: 'invalid_request' })
  await expect(observeDevelopmentProgress({ repository: root, revision: 'HEAD~1' }))
    .rejects.toMatchObject({ code: 'invalid_request' })
  const abort = new AbortController()
  abort.abort()
  await expect(observeDevelopmentProgress({ repository: root, signal: abort.signal }))
    .rejects.toMatchObject({ code: 'cancelled' })
  await expect(observeDevelopmentProgress({ repository: join(root, 'missing') }))
    .rejects.toMatchObject({ code: 'path_unavailable' })
  await expect(observeDevelopmentProgress({ repository: root, git: join(root, 'missing-executable') }))
    .rejects.toMatchObject({ code: 'git_unavailable' })
})
