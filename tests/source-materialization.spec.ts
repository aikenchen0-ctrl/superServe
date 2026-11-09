import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { materializeCommittedSource } from '../src/development/source-materialization.ts'
import { verifyQualitySources } from '../src/development/quality-sources.ts'
import { gitEnv } from './fixtures/git.ts'
import * as fs from 'node:fs/promises'

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open), copyFile: vi.fn(real.copyFile), statfs: vi.fn(real.statfs) }
})
vi.setConfig({ testTimeout: 20000 })
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
beforeEach(() => {
  vi.mocked(fs.open).mockImplementation(native.open)
  vi.mocked(fs.copyFile).mockImplementation(native.copyFile)
  vi.mocked(fs.statfs).mockImplementation(native.statfs)
})
const exec = promisify(execFile), roots: string[] = []
const sha = (content: Buffer | string) => createHash('sha256').update(content).digest('hex')
const git = async (repository: string, ...args: string[]) => (await exec('git', ['-C', repository,
  '-c', 'user.name=Materialization fixture', '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', '-c', 'core.autocrlf=false', ...args],
{ windowsHide: true, env: gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
async function fixture(format: 'sha1' | 'sha256' = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'source-materialization-')); roots.push(root)
  const repository = join(root, 'repo'), parent = join(root, 'prepared')
  await mkdir(repository); await mkdir(parent)
  await git(repository, 'init', '--initial-branch=main', `--object-format=${format}`)
  await mkdir(join(repository, 'recipe')); await mkdir(join(repository, 'Code Space'))
  await writeFile(join(repository, 'config.json'), '{}')
  await writeFile(join(repository, 'recipe', 'check.ps1'), 'Write-Output fixed\n')
  await writeFile(join(repository, 'Code Space', 'data.bin'), Buffer.from([0, 255, 10, 13, 42]))
  await writeFile(join(repository, 'copy.bin'), Buffer.from([0, 255, 10, 13, 42]))
  await writeFile(join(repository, 'empty.txt'), '')
  await writeFile(join(repository, '.gitattributes'), '* -text\n*.bin filter=trap\n')
  await git(repository, 'add', '.'); await git(repository, 'update-index', '--chmod=+x', 'recipe/check.ps1')
  await git(repository, 'commit', '-m', 'fixed input')
  const commit = await git(repository, 'rev-parse', 'HEAD'), tree = await git(repository, 'rev-parse', 'HEAD^{tree}')
  const common = await git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const repositoryId = sha(JSON.stringify(process.platform === 'win32' ? common.toLowerCase() : common))
  const verification = await verifyQualitySources({
    target: { repositoryPath: repository, repositoryId, commit, configuration: { path: 'config.json', sha256: sha('{}') },
      scope: 'committed-tree' },
    recipe: { repositoryPath: repository, repositoryId, commit, tree: await git(repository, 'rev-parse', 'HEAD:recipe'), path: 'recipe' },
  })
  const input = { repositoryPath: repository, repositoryId, commit, tree,
    manifestDigest: verification.sourceInputs!.manifestDigest, parentDirectory: parent }
  return { root, repository, parent, input, verification }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const path = resolve(root), parent = resolve(tmpdir())
    if (!path.startsWith(parent + sep) || !path.split(sep).at(-1)!.startsWith('source-materialization-'))
      throw new Error('临时准备目录归属异常')
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})
it.each(['sha1', 'sha256'] as const)('%s 固定字节落盘，不读取脏文件、不执行过滤器，独立文件无硬链接', async format => {
  const f = await fixture(format)
  const index = await readFile(join(f.repository, '.git', 'index')), head = await git(f.repository, 'rev-parse', 'HEAD')
  await writeFile(join(f.repository, 'Code Space', 'data.bin'), 'dirty-progress')
  await writeFile(join(f.repository, 'new-progress'), 'do-not-include')
  const trap = join(f.root, 'filter-ran')
  await git(f.repository, 'config', 'filter.trap.smudge', `echo fail > "${trap.replaceAll('\\', '/')}"`)
  await git(f.repository, 'config', 'filter.trap.required', 'true')
  const result = await materializeCommittedSource(f.input)
  expect(result).toMatchObject({ manifestDigest: f.verification.sourceInputs!.manifestDigest, files: 6,
    contentReadBackVerified: true, materialized: true, executionAuthorized: false, immutable: false })
  expect(await readFile(join(result.directory, 'Code Space', 'data.bin'))).toEqual(Buffer.from([0, 255, 10, 13, 42]))
  expect(await readFile(join(result.directory, 'empty.txt'))).toHaveLength(0)
  expect((await lstat(join(result.directory, 'copy.bin'))).ino)
    .not.toBe((await lstat(join(result.directory, 'Code Space', 'data.bin'))).ino)
  expect(await readdir(result.directory)).not.toContain('.git')
  expect(result.executableBitsApplied).toBe(process.platform !== 'win32')
  expect(await readdir(result.directory)).not.toContain('new-progress')
  expect(result.outputDirectory).not.toBe(result.directory)
  expect(await readdir(result.outputDirectory)).toEqual([])
  expect((await lstat(result.outputDirectory)).isDirectory()).toBe(true)
  expect(await readFile(join(f.repository, 'Code Space', 'data.bin'), 'utf8')).toBe('dirty-progress')
  expect(await readFile(join(f.repository, '.git', 'index'))).toEqual(index)
  expect(await git(f.repository, 'rev-parse', 'HEAD')).toBe(head)
  expect(await readdir(f.root)).not.toContain('filter-ran')
  // 重复准备不覆盖旧输出；后续修改一个副本不改变另一副本或源进度。
  const next = await materializeCommittedSource(f.input)
  expect(next.directory).not.toBe(result.directory)
  await writeFile(join(next.directory, 'copy.bin'), 'new-output')
  expect(await readFile(join(result.directory, 'copy.bin'))).toEqual(Buffer.from([0, 255, 10, 13, 42]))
})
it('来源身份、固定树或摘要错误不发布目录', async () => {
  const f = await fixture()
  for (const patch of [{ repositoryId: '0'.repeat(64) }, { tree: '0'.repeat(40) }]) {
    await expect(materializeCommittedSource({ ...f.input, ...patch })).rejects.toThrow()
    expect(await readdir(f.parent)).toEqual([])
  }
  await expect(materializeCommittedSource({ ...f.input, manifestDigest: '0'.repeat(64) }))
    .rejects.toMatchObject({ code: 'manifest_mismatch', retainedPartial: true })
  expect((await readdir(f.parent)).every(name => name.startsWith('.source-preparing-'))).toBe(true)
})
it('源工作树内部或对象库内部不能作输出父目录', async () => {
  const f = await fixture()
  await expect(materializeCommittedSource({ ...f.input, parentDirectory: f.repository }))
    .rejects.toMatchObject({ code: 'parent_overlaps_source' })
  await expect(materializeCommittedSource({ ...f.input, parentDirectory: f.root }))
    .rejects.toMatchObject({ code: 'parent_overlaps_source' })
  expect(await readdir(f.parent)).toEqual([])
})
async function addEntry(f: Awaited<ReturnType<typeof fixture>>, mode: string, path: string) {
  const blob = mode === '160000' ? f.input.commit : await git(f.repository, 'rev-parse', 'HEAD:copy.bin')
  // 树对象可来自其他平台；不依赖当前 Windows 索引接受非法本地文件名。
  const original = (await exec('git', ['-C', f.repository, 'ls-tree', '-z', f.input.tree],
    { env: gitEnv(), encoding: 'buffer' })).stdout
  const tree = await new Promise<string>((done, reject) => {
    const child = execFile('git', ['-C', f.repository, 'mktree', '-z'], { env: gitEnv(), windowsHide: true },
      (error, stdout) => error ? reject(error) : done(stdout.trim()))
    child.stdin!.on('error', reject)
    child.stdin!.end(Buffer.concat([original, Buffer.from(`${mode} ${mode === '160000' ? 'commit' : 'blob'} ${blob}\t${path}\0`)]))
  })
  const commit = await git(f.repository, 'commit-tree', tree, '-p', f.input.commit, '-m', 'path fixture')
  return { ...f.input, commit, tree }
}
it.each([['120000', 'link'], ['160000', 'dependency'], ['100644', 'COPY.bin'],
  ['100644', 'trailing.'], ['100644', 'NUL.txt'], ['100644', 'a\\b']])('拒绝未闭合/不可表达输入 %s %s，不改名或缩小范围', async (mode, path) => {
  const f = await fixture(), input = await addEntry(f, mode, path)
  await expect(materializeCommittedSource(input)).rejects.toThrow()
  expect(await readdir(f.parent)).toEqual([])
})
it('预取消和空间不足都不创建输出，也不清理现有数据', async () => {
  const f = await fixture()
  await expect(materializeCommittedSource(f.input, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' })
  vi.mocked(fs.statfs).mockResolvedValue({ bavail: 0n, bsize: 4096n } as never)
  await expect(materializeCommittedSource(f.input)).rejects.toMatchObject({ code: 'insufficient_space' })
  expect(await readdir(f.parent)).toEqual([])
})
it('落盘副本被篡改时读回拒绝，所有残留保持未发布', async () => {
  const f = await fixture()
  vi.mocked(fs.copyFile).mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
    await native.copyFile(...args)
    await writeFile(args[1], 'tampered')
  })
  await expect(materializeCommittedSource(f.input)).rejects.toMatchObject({ retainedPartial: true })
  expect((await readdir(f.parent)).every(name => name.startsWith('.source-preparing-'))).toBe(true)
})
it('写入失败或中途取消只能保留未发布目录，后续请求使用新目录', async () => {
  const f = await fixture(), controller = new AbortController()
  vi.mocked(fs.copyFile).mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
    await native.copyFile(...args); controller.abort()
  })
  await expect(materializeCommittedSource(f.input, { signal: controller.signal }))
    .rejects.toMatchObject({ code: 'cancelled', retainedPartial: true })
  expect((await readdir(f.parent)).every(name => name.startsWith('.source-preparing-'))).toBe(true)
  vi.mocked(fs.copyFile).mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
  await expect(materializeCommittedSource(f.input)).rejects.toMatchObject({ retainedPartial: true })
  vi.mocked(fs.copyFile).mockImplementation(native.copyFile)
  const result = await materializeCommittedSource(f.input)
  expect(await readFile(join(result.directory, 'copy.bin'))).toEqual(Buffer.from([0, 255, 10, 13, 42]))
})
it('输出父目录链接不能借准备过程越界', async () => {
  const f = await fixture(), alias = join(f.root, 'alias')
  await symlink(f.parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(materializeCommittedSource({ ...f.input, parentDirectory: alias })).rejects.toMatchObject({ code: 'parent_unsafe' })
  expect(await readdir(f.parent)).toEqual([])
})

it('相同对象多路径形成独立逻辑大小，不按去重对象数省略副本', async () => {
  const f = await fixture()
  const blob = await git(f.repository, 'rev-parse', 'HEAD:copy.bin')
  const input = await addEntry(f, '100644', 'another-copy.bin')
  const { readCommittedTree } = await import('../src/development/quality-sources.ts')
  const { gitReader } = await import('../src/development/git-read.ts')
  const reader = gitReader({ repository: f.repository }, () => f.repository, AbortSignal.timeout(10000))
  const tree = await readCommittedTree({ ...reader, format: 'sha1', length: 40 }, input.tree, () => {})
  const result = await materializeCommittedSource({ ...input, manifestDigest: tree.stats.manifestDigest })
  expect(result.files).toBe(f.verification.sourceInputs!.files + 1)
  expect(result.logicalFileBytes).toBe(f.verification.sourceInputs!.logicalFileBytes + 5)
  expect((await git(f.repository, 'rev-parse', `${input.commit}:another-copy.bin`))).toBe(blob)
})

it('异步写入遇到分块部分写成功也必须完成所有字节', async () => {
  const f = await fixture()
  let writes = 0
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await native.open(...args)
    if (String(args[0]).includes('.source-preparing-') && typeof args[1] === 'number' && (args[1] & 1)) {
      const write = handle.write.bind(handle)
      vi.spyOn(handle, 'write').mockImplementation(((buffer: Buffer, offset: number, length: number) => {
        writes++
        return write(buffer, offset, Math.min(length, 2))
      }) as typeof handle.write)
    }
    return handle
  })
  const result = await materializeCommittedSource(f.input)
  expect(writes).toBeGreaterThan(10)
  expect(await readFile(join(result.directory, 'copy.bin'))).toEqual(Buffer.from([0, 255, 10, 13, 42]))
})

it('对象读取后缺失/损坏不能用源活动文件补救', async () => {
  const f = await fixture(), blob = await git(f.repository, 'rev-parse', 'HEAD:copy.bin')
  const object = join(f.repository, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
  await chmod(object, 0o600)
  await writeFile(object, 'invalid-object')
  await expect(materializeCommittedSource(f.input)).rejects.toThrow()
  expect((await readdir(f.parent)).every(name => name.startsWith('.source-preparing-'))).toBe(true)
  expect(await readFile(join(f.repository, 'copy.bin'))).toEqual(Buffer.from([0, 255, 10, 13, 42]))
})

it('大于旧单批缓冲的对象仍分块落盘，非 ASCII 和前导横线路径不按样本误拒', async () => {
  const f = await fixture()
  const content = Buffer.alloc(17 * 1024 * 1024, 73)
  await writeFile(join(f.repository, '-合法 空格.bin'), content)
  await git(f.repository, 'add', '--', '-合法 空格.bin')
  await git(f.repository, 'commit', '-m', 'large and unicode')
  const commit = await git(f.repository, 'rev-parse', 'HEAD'), treeId = await git(f.repository, 'rev-parse', 'HEAD^{tree}')
  const { readCommittedTree } = await import('../src/development/quality-sources.ts')
  const { gitReader } = await import('../src/development/git-read.ts')
  const reader = gitReader({ repository: f.repository }, () => f.repository, AbortSignal.timeout(15000))
  const tree = await readCommittedTree({ ...reader, format: 'sha1', length: 40 }, treeId, () => {})
  const output = await materializeCommittedSource({ ...f.input, commit, tree: treeId, manifestDigest: tree.stats.manifestDigest })
  expect(sha(await readFile(join(output.directory, '-合法 空格.bin')))).toBe(sha(content))
  expect(output.logicalFileBytes).toBe(f.verification.sourceInputs!.logicalFileBytes + content.length)
}, 25000)
