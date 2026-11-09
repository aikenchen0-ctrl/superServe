import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { gitReader, gitRecords, InspectionError, repositoryIdentity } from './git-read.ts'
import { QualityDefinitionSchema } from './quality-contracts.ts'
import { objectStream, type ObjectMetadata, type ObjectPart } from './git-object-stream.ts'

const CONFIG_BYTES = 4 * 1024 * 1024
const RECIPE_BYTES = 16 * 1024 * 1024
const INVENTORY_BYTES = 4 * 1024 * 1024
const ENTRY_LIMIT = 10_000
const SOURCE_BYTES = 512 * 1024 * 1024
const SOURCE_ENTRIES = 50_000
const id = z.string().regex(/^[a-f0-9]{64}$/)
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const path = z.string().min(1).max(4096)
const Request = z.object({
  target: z.object({ repositoryPath: path, repositoryId: id, commit: oid,
    configuration: QualityDefinitionSchema.shape.configuration,
    scope: z.literal('committed-tree').optional() }).strict(),
  recipe: QualityDefinitionSchema.shape.recipe.extend({ repositoryPath: path }).strict(),
}).strict()
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const objectHash = (format: string, type: string, value: Buffer) =>
  createHash(format).update(`${type} ${value.length}\0`).update(value).digest('hex')

/** 固定来源核验失败；不回显 Git 输出、文件正文或本机目录。 */
export class QualitySourceError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const fail = (code: string, message: string): never => { throw new QualitySourceError(code, message) }
interface Entry { mode: string; type: 'tree' | 'blob' | 'commit'; oid: string; bytes?: number; path: Buffer }
interface ObjectRequest { expression: string; type: 'tree' | 'blob'; oid?: string }
type ObjectSession = Pick<GitSession, 'git' | 'streamObjects' | 'format' | 'length'>
/** 只供可信宿主准备输入；外部请求不能提供回调或自选对象。 */
export interface SourceTreeSink {
  prepare(entries: readonly Entry[], metadata: ReadonlyMap<string, ObjectMetadata>): Promise<void>
  consume(part: ObjectPart): Promise<void>
}
interface GitSession extends ReturnType<typeof gitReader> {
  format: 'sha1' | 'sha256'
  length: number
  repositoryId: string
  finish(): Promise<void>
}
function entries(output: Buffer, length: number, limit = ENTRY_LIMIT): Entry[] {
  return gitRecords(output, limit).map(record => {
    const tab = record.indexOf(9), name = record.subarray(tab + 1)
    const match = /^([0-9]{6}) (tree|blob|commit) ([a-f0-9]+)(?: +(\d+|-))?$/.exec(record.subarray(0, tab).toString('ascii'))
    if (tab < 0 || !match || !name.length || match[3]!.length !== length)
      return fail('quality_object_invalid', 'Git 目录清单不完整或格式无效')
    const [, mode, type, objectId, size] = match
    const bytes = size && size !== '-' ? Number(size) : undefined
    if ((bytes !== undefined && !Number.isSafeInteger(bytes))
      || !(['040000:tree', '100644:blob', '100755:blob', '120000:blob', '160000:commit'].includes(`${mode}:${type}`)))
      return fail('quality_object_invalid', 'Git 目录类型或大小无效')
    return { mode: mode!, type: type as Entry['type'], oid: objectId!, bytes, path: name }
  })
}

function ancestorRequests(tree: string, path: string): ObjectRequest[] {
  const requests: ObjectRequest[] = [{ expression: tree, oid: tree, type: 'tree' }]
  const parts = path.split('/')
  for (let count = 1; count < parts.length; count++)
    requests.push({ expression: `${tree}:${parts.slice(0, count).join('/')}`, type: 'tree' })
  return requests
}
async function verifyObjects(session: ObjectSession, requests: ObjectRequest[], check: () => void, budget = RECIPE_BYTES,
  sink?: { prepare(metadata: ReadonlyMap<string, ObjectMetadata>): Promise<void>; consume(part: ObjectPart): Promise<void> }) {
  const input = Buffer.from(requests.map(value => `${value.expression}\n`).join(''), 'utf8')
  const metadata = (await session.git(['cat-file', '--batch-check'], { input, outputBytes: INVENTORY_BYTES }))
    .toString('ascii').split('\n')
  if (metadata.pop() !== '' || metadata.length !== requests.length)
    return fail('quality_object_invalid', '对象元数据不完整')
  const unique = new Map<string, ObjectMetadata>()
  let total = 0
  for (let index = 0; index < metadata.length; index++) {
    const line = metadata[index]!, match = /^([a-f0-9]+) (tree|blob) (\d+)$/.exec(line), expected = requests[index]!
    if (!match || match[1]!.length !== session.length || match[2] !== expected.type
      || (expected.oid && match[1] !== expected.oid))
      return fail('quality_object_missing', '来源包含不可读取的 Git 对象；未联网补取或缩小范围')
    const objectId = match[1]!, size = Number(match[3])
    if (unique.has(objectId)) {
      if (unique.get(objectId)!.header !== line) return fail('quality_object_invalid', '同一对象的元数据不一致')
      continue
    }
    total += Buffer.byteLength(line, 'ascii') + size + 2
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(total) || total > budget)
      return fail('quality_source_budget', `来源去重对象及批量帧超过 ${budget / 1024 / 1024} MiB 读取总量预算`)
    unique.set(objectId, { type: match[2]!, size, header: line })
  }
  const stream = objectStream(session.format, unique)
  await sink?.prepare(unique)
  try {
    await session.streamObjects(Buffer.from([...unique.keys()].map(value => `${value}\n`).join(''), 'ascii'), total,
      async chunk => {
        check()
        if (!sink) stream.push(chunk)
        else for (const part of stream.parts(chunk)) { check(); await sink.consume(part) }
      })
    const hashes = stream.finish()
    return { hashes, objectBytes: [...unique.values()].reduce((sum, value) => sum + value.size, 0),
      sizes: new Map([...unique].map(([oid, value]) => [oid, value.size])) }
  } catch (error) {
    if (error instanceof InspectionError && error.code === 'invalid_output')
      return fail('quality_object_invalid', '对象流内容或帧与预先核对的身份不一致')
    throw error
  }
}

/** 完整树的共同读取/摘要算法；正文接收者只能在全部核验后发布其准备结果。 */
export async function readCommittedTree(target: ObjectSession, tree: string, check: () => void, sink?: SourceTreeSink) {
  const listed = entries(await target.git(['ls-tree', '-r', '-t', '-z', '--full-tree', tree],
    { outputBytes: 16 * 1024 * 1024 }), target.length, SOURCE_ENTRIES)
  const objects = new Map<string, 'tree' | 'blob'>([[tree, 'tree']])
  for (const entry of listed) {
    if (entry.type === 'commit') continue
    if (objects.has(entry.oid) && objects.get(entry.oid) !== entry.type)
      return fail('quality_object_invalid', '代码输入对象类型互相矛盾')
    objects.set(entry.oid, entry.type)
  }
  const verified = await verifyObjects(target, [...objects].map(([oid, type]) => ({ expression: oid, oid, type })),
    check, SOURCE_BYTES, sink && { prepare: metadata => sink.prepare(listed, metadata), consume: part => sink.consume(part) })
  const manifest = createHash('sha256').update(tree).update('\0').update(verified.hashes.get(tree)!)
  for (const entry of [...listed].sort((a, b) => Buffer.compare(a.path, b.path)))
    manifest.update('\0').update(entry.mode).update('\0').update(entry.path).update('\0').update(entry.oid)
      .update('\0').update(verified.hashes.get(entry.oid) ?? 'unresolved-gitlink')
  const symlinks = listed.filter(entry => entry.mode === '120000').length
  const submodules = listed.filter(entry => entry.mode === '160000').length
  const files = listed.filter(entry => entry.mode === '100644' || entry.mode === '100755')
  return { stats: { scope: 'committed-tree' as const, tree, manifestDigest: manifest.digest('hex'),
    entries: listed.length, files: files.length,
    logicalFileBytes: files.reduce((sum, entry) => sum + verified.sizes.get(entry.oid)!, 0),
    uniqueObjects: verified.hashes.size, objectBytes: verified.objectBytes, symlinks, submodules,
    status: symlinks || submodules ? 'references_unresolved' as const : 'tracked_content_matched' as const,
    materialized: false as const, executionAttempted: false as const, dependencyClosureVerified: false as const },
    entries: listed, hashes: verified.hashes }
}

/** 只核对提交内的原始字节和配方目录对象，不检出、不执行过滤器、不读取工作区文件。 */
export async function verifyQualitySources(input: z.input<typeof Request>,
  options: { signal?: AbortSignal; git?: string } = {}) {
  const parsed = Request.safeParse(input)
  if (!parsed.success) return fail('invalid_quality_source', '固定来源核验参数无效')
  const request = parsed.data
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])])
  const check = () => {
    if (signal.aborted) throw new InspectionError('cancelled', '来源核验已取消或超过时间预算')
  }
  const sessions = new Map<string, GitSession>()
  async function open(repository: string): Promise<GitSession> {
    check()
    let cwd: string
    try { cwd = await realpath(repository) }
    catch { throw new InspectionError('path_unavailable', '仓库目录不可读取') }
    const reused = sessions.get(cwd)
    if (reused) return reused
    const reader = gitReader({ repository, git: options.git }, () => cwd, signal)
    const format = await reader.scalar(['rev-parse', '--show-object-format'])
    if (format !== 'sha1' && format !== 'sha256') return fail('quality_object_invalid', 'Git 对象格式不受支持')
    const commonPath = () => reader.scalar(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    let common: string, reportedCommon: string, physical: Awaited<ReturnType<typeof stat>>
    try { reportedCommon = await commonPath(); common = await realpath(reportedCommon); physical = await stat(common) }
    catch (error) {
      if (error instanceof InspectionError) throw error
      throw new InspectionError('path_unavailable', 'Git 对象库身份不可读取')
    }
    const repositoryId = repositoryIdentity(reportedCommon)
    const session: GitSession = { ...reader, format, length: format === 'sha1' ? 40 : 64, repositoryId,
      async finish() {
        check()
        try {
          const reported = await commonPath(), current = await realpath(reported), now = await stat(current)
          if (repositoryIdentity(reported) !== repositoryId || await realpath(repository) !== cwd
            || current !== common || now.dev !== physical.dev || now.ino !== physical.ino)
            throw new Error('changed')
        } catch (error) {
          if (error instanceof InspectionError) throw error
          throw new InspectionError('repository_changed', '核验期间仓库归属变化，未生成来源结论')
        }
      },
    }
    sessions.set(cwd, session)
    return session
  }
  async function commit(session: Awaited<ReturnType<typeof open>>, expected: string) {
    if (expected.length !== session.length) return fail('quality_commit_mismatch', '提交标识与仓库对象格式不一致')
    const raw = await session.git(['cat-file', 'commit', expected], { outputBytes: 1024 * 1024 })
    const first = raw.subarray(0, raw.indexOf(10)).toString('ascii')
    const tree = new RegExp(`^tree ([a-f0-9]{${session.length}})$`).exec(first)?.[1]
    if (!tree || objectHash(session.format, 'commit', raw) !== expected)
      return fail('quality_object_invalid', '提交对象内容与标识不一致')
    const source = { kind: 'git-commit' as const, objectFormat: session.format, commit: expected, tree }
    return { ...source, identity: sha(JSON.stringify({ version: 1, ...source })) }
  }
  async function select(session: Awaited<ReturnType<typeof open>>, tree: string, file: string) {
    const found = entries(await session.git(['--literal-pathspecs', 'ls-tree', '--full-tree', '-z', '--long', tree, '--', file],
      { outputBytes: INVENTORY_BYTES }), session.length)
    if (found.length !== 1 || !found[0]!.path.equals(Buffer.from(file, 'utf8')))
      return fail('quality_path_missing', '固定提交内未找到精确匹配的配置文件或配方目录')
    return found[0]!
  }

  const target = await open(request.target.repositoryPath)
  if (target.repositoryId !== request.target.repositoryId) return fail('quality_repository_mismatch', '目标仓库与登记身份不一致')
  const source = await commit(target, request.target.commit)
  const config = await select(target, source.tree, request.target.configuration.path)
  if (!['100644', '100755'].includes(config.mode) || config.type !== 'blob' || config.bytes === undefined)
    return fail('quality_configuration_type', '目标配置必须是提交内的普通文件，不能跟随链接')
  if (config.bytes > CONFIG_BYTES) return fail('quality_source_budget', '配置原始字节超过 4 MiB 核验预算')
  const raw = await target.git(['cat-file', 'blob', config.oid], { outputBytes: CONFIG_BYTES })
  if (raw.length !== config.bytes || objectHash(target.format, 'blob', raw) !== config.oid)
    return fail('quality_object_invalid', '配置对象内容与标识不一致')
  const configurationSha256 = sha(raw)
  if (configurationSha256 !== request.target.configuration.sha256)
    return fail('quality_configuration_mismatch', '配置摘要与提交内原始字节不一致，不能使用工作区文件替代')
  // 文件内容正确还不够：同时核对从提交根目录到配置所在目录的对象链。
  const parentTrees = await verifyObjects(target, ancestorRequests(source.tree, request.target.configuration.path), check)

  const recipeRepository = await open(request.recipe.repositoryPath)
  if (recipeRepository.repositoryId !== request.recipe.repositoryId)
    return fail('quality_recipe_repository_mismatch', '配方仓库与登记身份不一致')
  const recipeSource = await commit(recipeRepository, request.recipe.commit)
  const selected = request.recipe.path === '.' ? { type: 'tree', oid: recipeSource.tree }
    : await select(recipeRepository, recipeSource.tree, request.recipe.path)
  if (selected.type !== 'tree' || selected.oid !== request.recipe.tree)
    return fail('quality_recipe_tree_mismatch', '配方目录类型或 tree 标识与声明不一致')
  const inventory = entries(await recipeRepository.git(['ls-tree', '-r', '-t', '-z', '--full-tree', selected.oid],
    { outputBytes: INVENTORY_BYTES }), recipeRepository.length)
  const objects = new Map<string, 'tree' | 'blob'>([[selected.oid, 'tree']])
  for (const entry of inventory) {
    if (entry.type === 'commit') continue
    if (objects.has(entry.oid) && objects.get(entry.oid) !== entry.type)
      return fail('quality_object_invalid', '配方对象类型互相矛盾')
    objects.set(entry.oid, entry.type)
  }
  const recipeAncestors = ancestorRequests(recipeSource.tree, request.recipe.path)
  const verifiedObjects = await verifyObjects(recipeRepository, [...recipeAncestors,
    ...[...objects.entries()].map(([objectId, type]) => ({ expression: objectId, oid: objectId, type }))], check)
  const verified = verifiedObjects.hashes
  const manifest = createHash('sha256').update(selected.oid).update('\0').update(verified.get(selected.oid)!)
  for (const entry of [...inventory].sort((a, b) => Buffer.compare(a.path, b.path)))
    manifest.update('\0').update(entry.mode).update('\0').update(entry.path).update('\0').update(entry.oid)
      .update('\0').update(verified.get(entry.oid) ?? 'unresolved-gitlink')
  // 组合的输入范围来自整个固定代码树，不能从所选质量配置猜测文件依赖。
  const sourceInputs = request.target.scope === 'committed-tree'
    ? (await readCommittedTree(target, source.tree, check)).stats : undefined
  for (const session of sessions.values()) await session.finish()
  check()
  const symlinks = inventory.filter(entry => entry.mode === '120000').length
  const submodules = inventory.filter(entry => entry.mode === '160000').length
  return { schemaVersion: 1 as const, source, ...(sourceInputs ? { sourceInputs } : {}),
    configuration: { path: request.target.configuration.path, blob: config.oid, bytes: config.bytes,
      sha256: configurationSha256, ancestorTreesVerified: parentTrees.hashes.size, ancestorObjectBytes: parentTrees.objectBytes },
    recipe: { repositoryId: recipeRepository.repositoryId, commit: recipeSource.commit, tree: selected.oid,
      path: request.recipe.path, manifestDigest: manifest.digest('hex'), entries: inventory.length,
      uniqueObjects: verifiedObjects.hashes.size, directoryObjects: objects.size,
      ancestorTreesVerified: recipeAncestors.length, objectBytes: verifiedObjects.objectBytes,
      symlinks, submodules },
    status: symlinks || submodules || sourceInputs?.status === 'references_unresolved'
      ? 'references_unresolved' as const : 'tracked_content_matched' as const,
    assurance: { configurationContentVerified: true as const, recipeTrackedContentVerified: true as const,
      configurationSemanticsVerified: false as const, dependencyClosureVerified: false as const,
      toolsVerified: false as const, executionAuthorized: false as const, publishAllowed: false as const } }
}
