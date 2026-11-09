import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, statfs, type FileHandle } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { gitReader, repositoryIdentity } from './git-read.ts'
import { readCommittedTree, type SourceTreeSink } from './quality-sources.ts'

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'))
const Request = z.object({ repositoryPath: absolute, repositoryId: digest, commit: oid, tree: oid,
  manifestDigest: digest, parentDirectory: absolute }).strict()
export const PreparedExecutionInputSchema = z.object({
  materializationId: z.string().uuid(), sourceDirectory: absolute, outputDirectory: absolute,
  sourceIdentity: z.string().min(1).max(200), outputIdentity: z.string().min(1).max(200),
}).strict()
export type PreparedExecutionInput = z.output<typeof PreparedExecutionInputSchema>
/** 在启动副作用前复核固定输入和输出根；不提供沙箱，只拒绝已替换的目录。 */
export function verifyPreparedExecutionInput(input: PreparedExecutionInput) {
  const inspect = (path: string, expected: string) => {
    const canonical = realpathSync(path), info = statSync(canonical, { bigint: true })
    if (!info.isDirectory() || info.ino === 0n || canonical !== path || `${info.dev}:${info.ino}` !== expected)
      throw new Error('prepared input identity changed')
  }
  inspect(input.sourceDirectory, input.sourceIdentity)
  inspect(input.outputDirectory, input.outputIdentity)
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const unchanged = (a: BigIntStats, b: BigIntStats) =>
  same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const inside = (parent: string, path: string) => {
  const normalize = (v: string) => process.platform === 'win32' ? v.toLowerCase() : v
  const rel = relative(normalize(parent), normalize(path))
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
/** 准备失败不返回输入目录；只标识是否有需人工处置的私有残留，不回显源码或绝对路径。 */
export class SourceMaterializationError extends Error {
  constructor(readonly code: string, message: string, readonly retainedPartial = false) { super(message) }
}
const fail = (code: string, message: string): never => { throw new SourceMaterializationError(code, message) }
function filename(raw: Buffer) {
  let name: string
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { return fail('path_unrepresentable', '源码路径不能无损表示') }
  if (!name || name.length > 240 || !Buffer.from(name).equals(raw) || name.normalize('NFC') !== name
    || /[\\<>:"|?*\0-\x1f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || part.toLowerCase() === '.git'
      || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)))
    return fail('path_unrepresentable', '源码路径与可移植目录约束不符，未自动改名或缩小输入')
  return name
}

/** 可信宿主专用：固定对象落入新目录，读回核验后才发布路径；不是 OS 沙箱或执行授权。 */
export async function materializeCommittedSource(input: z.input<typeof Request>,
  options: { signal?: AbortSignal; beforePublish?: () => void } = {}) {
  const args = Request.parse(input)
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])])
  let staging: string | undefined, current: FileHandle | undefined
  const check = () => { if (signal.aborted) fail('cancelled', '源码准备已取消或超时') }
  try {
    check()
    const repository = await realpath(args.repositoryPath), parent = resolve(args.parentDirectory)
    const parentInfo = await lstat(parent, { bigint: true })
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || resolve(await realpath(parent)) !== parent)
      fail('parent_unsafe', '输入准备父目录必须是无别名的既有目录')
    const reader = gitReader({ repository }, () => repository, signal)
    const commonReported = await reader.scalar(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const common = await realpath(commonReported), commonInfo = await lstat(common, { bigint: true })
    if (repositoryIdentity(commonReported) !== args.repositoryId) fail('repository_mismatch', '固定输入仓库身份不一致')
    if (inside(repository, parent) || inside(common, parent) || inside(parent, repository) || inside(parent, common))
      fail('parent_overlaps_source', '输入准备目录不能位于源工作树或对象库内')
    const format = await reader.scalar(['rev-parse', '--show-object-format'])
    const hashFormat = format === 'sha1' ? 'sha1' : format === 'sha256' ? 'sha256'
      : fail('object_format', '对象格式不受支持')
    const commit = await reader.git(['cat-file', 'commit', args.commit], { outputBytes: 1024 * 1024 })
    const computed = createHash(hashFormat).update(`commit ${commit.length}\0`).update(commit).digest('hex')
    if (computed !== args.commit || commit.subarray(0, commit.indexOf(10)).toString('ascii') !== `tree ${args.tree}`)
      fail('commit_mismatch', '提交与固定树不一致')
    let stagingInfo: BigIntStats | undefined
    type File = { name: string; mode: string; oid: string; size: number }
    const files: File[] = [], directories: string[] = [], byObject = new Map<string, File[]>()
    const directoryIdentities = new Map<string, BigIntStats>()
    let logicalBytes = 0, currentFile: File | undefined
    const sink: SourceTreeSink = {
      async prepare(entries, metadata) {
        const names = new Set<string>()
        for (const entry of entries) {
          check()
          if (!['040000', '100644', '100755'].includes(entry.mode))
            fail('references_unresolved', '符号链接或子模块尚未闭合，未准备部分源码')
          const name = filename(entry.path), key = name.toLowerCase()
          if (names.has(key)) fail('path_collision', '源码路径在目标平台可能碰撞，未自动改名')
          names.add(key)
          if (entry.type === 'tree') directories.push(name)
          else {
            const size = metadata.get(entry.oid)!.size
            logicalBytes += size
            const file = { name, mode: entry.mode, oid: entry.oid, size }
            files.push(file)
            const group = byObject.get(file.oid) ?? []
            group.push(file); byObject.set(file.oid, group)
          }
        }
        if (logicalBytes > 512 * 1024 * 1024) fail('materialization_budget', '逻辑文件总量超过准备预算')
        const space = await statfs(parent, { bigint: true })
        const block = space.bsize > 0n ? space.bsize : 4096n
        const estimated = files.reduce((sum, file) => sum + ((BigInt(file.size) + block - 1n) / block) * block, 0n)
          + BigInt(directories.length + files.length) * block
        if (space.bavail * block < estimated + 64n * 1024n * 1024n)
          fail('insufficient_space', '输入准备空间不足，未尝试清理其他数据')
        staging = await mkdtemp(join(parent, '.source-preparing-'))
        stagingInfo = await lstat(staging, { bigint: true })
        await chmod(staging, 0o700)
        for (const directory of directories.sort((a, b) => a.split('/').length - b.split('/').length)) {
          check(); await mkdir(join(staging, directory), { mode: 0o700 })
          directoryIdentities.set(directory, await lstat(join(staging, directory), { bigint: true }))
        }
      },
      async consume(part) {
        check()
        if (part.kind === 'start') {
          currentFile = byObject.get(part.oid)?.[0]
          if (currentFile) current = await open(join(staging!, currentFile.name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        } else if (part.kind === 'data' && current) {
          for (let offset = 0; offset < part.data.length;) {
            check()
            const { bytesWritten } = await current.write(part.data, offset, part.data.length - offset)
            if (!bytesWritten) fail('write_incomplete', '源码落盘未完成')
            offset += bytesWritten
          }
        } else if (part.kind === 'end' && current) {
          await current.sync(); await current.close(); current = undefined
          for (const duplicate of byObject.get(part.oid)!.slice(1)) {
            check()
            await copyFile(join(staging!, currentFile!.name), join(staging!, duplicate.name), constants.COPYFILE_EXCL)
          }
          currentFile = undefined
        }
      },
    }
    const tree = await readCommittedTree({ ...reader, format: hashFormat, length: hashFormat === 'sha1' ? 40 : 64 }, args.tree, check, sink)
    if (tree.stats.manifestDigest !== args.manifestDigest) fail('manifest_mismatch', '准备内容与固定来源回执不一致')
    // 从磁盘回读，而不是把写入成功或对象摘要当成落盘内容已经一致。
    const inodes = new Set<string>(), verifiedFiles: { file: File; identity: BigIntStats }[] = []
    const contentManifest = createHash('sha256')
    for (const file of files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      check()
      const path = join(staging!, file.name)
      await chmod(path, file.mode === '100755' ? 0o755 : 0o644)
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = await handle.stat({ bigint: true })
        const identity = `${before.dev}:${before.ino}`
        if (!before.isFile() || before.ino === 0n || before.nlink !== 1n || before.size !== BigInt(file.size) || inodes.has(identity))
          fail('file_identity', '准备文件身份或长度异常')
        if (process.platform !== 'win32' && Number(before.mode & 0o777n) !== (file.mode === '100755' ? 0o755 : 0o644))
          fail('file_mode', '准备文件执行位与固定对象模式不一致')
        inodes.add(identity)
        const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
        let read = 0
        for (;;) {
          check()
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, read)
          if (!bytesRead) break
          read += bytesRead
          if (read > file.size) fail('content_changed', '准备内容在核对期间变化')
          hash.update(buffer.subarray(0, bytesRead))
        }
        const actual = hash.digest('hex')
        if (actual !== tree.hashes.get(file.oid) || !unchanged(before, await handle.stat({ bigint: true }))
          || !unchanged(before, await lstat(path, { bigint: true })) || resolve(await realpath(path)) !== path)
          fail('content_changed', '准备内容读回与固定对象不一致')
        contentManifest.update(file.name).update('\0').update(file.mode).update('\0').update(actual).update('\0')
        verifiedFiles.push({ file, identity: before })
      } finally { await handle.close() }
    }
    const expectedNames = new Set([...directories, ...files.map(file => file.name)])
    for (const [name, identity] of directoryIdentities) {
      check()
      const path = join(staging!, name), current = await lstat(path, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || !same(identity, current) || resolve(await realpath(path)) !== path)
        fail('identity_changed', '准备子目录身份发生变化')
    }
    const observedNames = await readdir(staging!, { recursive: true })
    if (observedNames.length !== expectedNames.size || observedNames.some(name => !expectedNames.has(name.replaceAll('\\', '/'))))
      fail('content_changed', '准备目录含未请求内容或缺少输入')
    for (const { file, identity } of verifiedFiles)
      if (!unchanged(identity, await lstat(join(staging!, file.name), { bigint: true }))) fail('content_changed', '准备内容已变化')
    check()
    if (!same(parentInfo, await lstat(parent, { bigint: true })) || resolve(await realpath(parent)) !== parent
      || !same(stagingInfo!, await lstat(staging!, { bigint: true })) || resolve(await realpath(staging!)) !== staging
      || !same(commonInfo, await lstat(common, { bigint: true }))
      || commonReported !== await reader.scalar(['rev-parse', '--path-format=absolute', '--git-common-dir']))
      fail('identity_changed', '准备期间目录或仓库身份发生变化')
    const container = await mkdtemp(join(parent, 'source-input-'))
    await chmod(container, 0o700)
    const destination = join(container, 'source')
    // 输入与结果按空间分离：结果根属于同一受控容器，但不进入固定源码清单。
    // 这里只创建空目录，不宣称提供方已启动、输出已可信或结果已可发布。
    const outputDirectory = join(container, 'output')
    await mkdir(outputDirectory, { mode: 0o700 })
    check()
    options.beforePublish?.()
    await rename(staging!, destination)
    check()
    options.beforePublish?.()
    staging = undefined
    return { schemaVersion: 1 as const, containerDirectory: container, directory: destination, outputDirectory, repositoryId: args.repositoryId,
      commit: args.commit, tree: args.tree, manifestDigest: args.manifestDigest,
      contentDigest: contentManifest.digest('hex'), files: files.length, logicalFileBytes: logicalBytes,
      materialized: true as const, contentReadBackVerified: true as const,
      immutable: false as const, executableBitsApplied: process.platform !== 'win32',
      executionAuthorized: false as const, preparedAt: new Date().toISOString() }
  } catch (error) {
    if (current) { await current.close().catch(() => {}); current = undefined }
    if (signal.aborted) throw new SourceMaterializationError('cancelled', '源码准备已取消或超时', !!staging)
    if (error instanceof SourceMaterializationError) throw new SourceMaterializationError(error.code, error.message, !!staging)
    throw new SourceMaterializationError('preparation_failed', '固定源码准备失败，未返回可用目录', !!staging)
  }
}
