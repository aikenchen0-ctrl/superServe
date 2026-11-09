import { createHash } from 'node:crypto'
import { access, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gitReader, gitRecords as records, InspectionError, type InspectionRequest } from './git-read.ts'
export { InspectionError, type InspectionRequest } from './git-read.ts'

const DEADLINE_MS = 30_000
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

interface StatusCounts {
  trackedEntries: number
  stagedEntries: number
  unstagedEntries: number
  conflicts: number
  untrackedEntries: number
  ignoredEntries: number
}

const invalidOutput = () => new InspectionError('invalid_output', 'Git 输出不完整或格式不受支持，未生成检查结果')
function statusCounts(output: Buffer): StatusCounts {
  const counts: StatusCounts = { trackedEntries: 0, stagedEntries: 0, unstagedEntries: 0,
    conflicts: 0, untrackedEntries: 0, ignoredEntries: 0 }
  for (const record of records(output)) {
    const kind = record.subarray(0, 2).toString('ascii')
    if (kind === '# ') continue
    if (kind === '? ') { counts.untrackedEntries++; continue }
    if (kind === '! ') { counts.ignoredEntries++; continue }
    if (kind === 'u ') { counts.conflicts++; continue }
    if (kind !== '1 ' || record.length < 5) throw invalidOutput()
    counts.trackedEntries++
    if (record[2] !== 46) counts.stagedEntries++
    if (record[3] !== 46) counts.unstagedEntries++
  }
  return counts
}

export interface DevelopmentProgressObservation {
  schemaVersion: 1
  repository: string
  source: { commit: string; tree: string; index: string }
  changes: {
    staged: { bytes: number; digest: string }
    unstaged: { bytes: number; digest: string }
    untracked: { entries: number; namesDigest: string; contentRead: false }
  }
  indexFlags: ReturnType<typeof indexFlags>
  status: StatusCounts
  observedChange: boolean
  sampledConsistent: boolean
  writerFrozen: false
  progressCaptured: false
  secretsReviewed: false
  submoduleWorktreesInspected: false
  candidateEligible: false
  publishAllowed: false
  contextDigest?: string
  observationDigest: string
}

function indexFlags(output: Buffer) {
  let skipWorktreeEntries = 0, assumeUnchangedEntries = 0
  for (const record of records(output)) {
    if (record.length < 3 || record[1] !== 32) throw invalidOutput()
    const flag = String.fromCharCode(record[0]!)
    if (!/^[HSMRCK?hsmrck]$/.test(flag)) throw invalidOutput()
    if (flag === 'S' || flag === 's') skipWorktreeEntries++
    if (/[a-z]/.test(flag)) assumeUnchangedEntries++
  }
  return { skipWorktreeEntries, assumeUnchangedEntries }
}
function treeSummary(output: Buffer, oidLength: number) {
  const result = { regularFiles: 0, symlinks: 0, submodules: 0, blobBytes: 0 }
  for (const record of records(output)) {
    const tab = record.indexOf(9)
    if (tab < 0) throw invalidOutput()
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]+) +(\d+|-)$/.exec(record.subarray(0, tab).toString('ascii'))
    if (!match || match[3]!.length !== oidLength) throw invalidOutput()
    const [, mode, type, , size] = match
    if (mode === '160000' && type === 'commit' && size === '-') { result.submodules++; continue }
    if (type !== 'blob' || size === '-') throw invalidOutput()
    if (mode === '100644' || mode === '100755') result.regularFiles++
    else if (mode === '120000') result.symlinks++
    else throw invalidOutput()
    result.blobBytes += Number(size)
    if (!Number.isSafeInteger(result.blobBytes)) throw invalidOutput()
  }
  return result
}

/** 识别已提交源码和未冻结的工作区；不提交、不检出、不返回文件正文，也不判断完整构建输入。 */
export async function inspectDevelopmentSource(request: InspectionRequest) {
  const revision = request.revision ?? 'HEAD'
  if (!request.repository || !revision || revision.length > 1024 || /[\0\r\n]/.test(revision))
    throw new InspectionError('invalid_request', '必须提供仓库目录及有效的提交引用')
  const signal = AbortSignal.any([AbortSignal.timeout(DEADLINE_MS), ...(request.signal ? [request.signal] : [])])
  const startedAt = new Date().toISOString()
  let cwd: string
  try { cwd = await realpath(request.repository) }
  catch { throw new InspectionError('path_unavailable', '仓库目录不可读取') }
  const { git, scalar, disableFilters } = gitReader(request, () => cwd, signal)
  const objectFormat = await scalar(['rev-parse', '--show-object-format'])
  if (!['sha1', 'sha256'].includes(objectFormat)) throw invalidOutput()
  const oidLength = objectFormat === 'sha1' ? 40 : 64
  const oid = async (value: string) => {
    const result = await scalar(['rev-parse', '--verify', '--end-of-options', value])
    if (!new RegExp(`^[0-9a-f]{${oidLength}}$`).test(result)) throw invalidOutput()
    return result
  }
  const commit = await oid(`${revision}^{commit}`)
  const tree = await oid(`${commit}^{tree}`)
  const entries = treeSummary(await git(['ls-tree', '-r', '-z', '--full-tree', '--long', tree]), oidLength)
  const source = { kind: 'git-commit' as const, objectFormat, commit, tree }
  const bare = await scalar(['rev-parse', '--is-bare-repository'])
  if (bare !== 'true' && bare !== 'false') throw invalidOutput()
  const commonDirectory = await scalar(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const gitDirectory = await scalar(['rev-parse', '--absolute-git-dir'])
  let workspace = null
  if (bare === 'false') {
    const root = await realpath(await scalar(['rev-parse', '--show-toplevel']))
    cwd = root
    // status 可能调用 clean/process 过滤器；禁用可执行过滤器，接受保守的“可能有修改”，不运行仓库代码。
    await disableFilters()
    const sample = async () => {
      const status = await git(['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z', '--untracked-files=all',
        '--ignored=matching', '--ignore-submodules=all', '--no-renames'])
      const headRecord = records(status).find(record => record.subarray(0, 13).toString('ascii') === '# branch.oid ')
      const head = headRecord?.subarray(13).toString('ascii')
      if (!head || !new RegExp(`^[0-9a-f]{${oidLength}}$`).test(head)) throw invalidOutput()
      const index = await git(['ls-files', '--stage', '-v', '-z'])
      return { head, status, index }
    }
    const first = await sample()
    const operations: string[] = []
    for (const name of ['index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
      'rebase-merge', 'rebase-apply', 'sequencer']) {
      try { await access(join(gitDirectory, name)); operations.push(name) }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
          throw new InspectionError('path_unavailable', '无法核对 Git 操作状态，未生成可复用结论')
      }
    }
    const last = await sample()
    workspace = {
      root, head: last.head,
      status: statusCounts(last.status),
      index: { identity: digest(last.index), ...indexFlags(last.index) },
      observedChange: first.head !== last.head || !first.status.equals(last.status)
        || !first.index.equals(last.index),
      operations,
      contentFilters: 'disabled' as const,
      submoduleWorktrees: 'not-inspected' as const,
      currentProgress: 'unfrozen' as const,
      ownership: 'unverified' as const,
      executionReuse: 'not-authorized' as const,
    }
  }
  // 固定对象可持续读取，但开始和结束时同名引用不同必须对调用者明确报告。
  const referenceChanged = (await oid(`${revision}^{commit}`)) !== commit
  if (resolve(commonDirectory) !== resolve(await scalar(['rev-parse', '--path-format=absolute', '--git-common-dir'])))
    throw new InspectionError('repository_changed', '检查期间仓库归属变化，请重新检查')
  return {
    schemaVersion: 1 as const,
    source: { ...source, identity: digest(JSON.stringify({ version: 1, ...source })), entries },
    repository: { commonDirectory, gitDirectory, bare: bare === 'true' },
    observation: { startedAt, finishedAt: new Date().toISOString(), referenceChanged },
    workspace,
    assurance: {
      sourceScope: 'committed-tree-only' as const,
      currentProgressCaptured: false,
      dependencyClosureVerified: false,
      secretsReviewed: false,
      candidateAccepted: false,
      publishAllowed: false,
    },
  }
}

/**
 * 观测两次 HEAD、语义索引和差异，不保存内容、不读取未跟踪文件正文。
 * 两次相同不能排除中间变化；结果不是一致快照、权限冻结或恢复检查点。
 */
export async function observeDevelopmentProgress(request: InspectionRequest & { context?: string })
  : Promise<DevelopmentProgressObservation> {
  if (!request.repository || (request.revision !== undefined && request.revision !== 'HEAD'))
    throw new InspectionError('invalid_request', '进度观测只能针对工作区当前 HEAD')
  if (request.context !== undefined && (typeof request.context !== 'string'
    || Buffer.byteLength(request.context, 'utf8') > 64 * 1024))
    throw new InspectionError('invalid_request', '观测上下文超出 64 KiB 限制')
  const signal = AbortSignal.any([AbortSignal.timeout(DEADLINE_MS), ...(request.signal ? [request.signal] : [])])
  let cwd = await realpath(request.repository).catch(() => {
    throw new InspectionError('path_unavailable', '仓库目录不可读取')
  })
  const { git, scalar, disableFilters } = gitReader(request, () => cwd, signal)
  const lines = async (args: string[], count: number) => {
    const output = (await git(args)).toString('utf8').split(/\r?\n/)
    if (output.pop() !== '' || output.length !== count || output.some(value => !value))
      throw invalidOutput()
    return output
  }
  // 一次查询目录身份；含换行的路径无法无歧义解析时直接拒绝。
  const [bare, root, gitDirectory] = await lines([
    'rev-parse', '--is-bare-repository', '--show-toplevel', '--absolute-git-dir',
  ], 3)
  if (bare !== 'false')
    throw new InspectionError('invalid_request', '进度观测需要已有非裸工作区')
  cwd = await realpath(root!).catch(() => { throw new InspectionError('path_unavailable', '工作区根目录不可读取') })
  const oid = async (ref: string) => {
    const value = await scalar(['rev-parse', '--verify', '--end-of-options', ref])
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
      throw invalidOutput()
    return value
  }
  const status = () => git(['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z',
    '--untracked-files=all', '--ignored=no', '--ignore-submodules=all', '--no-renames'])
  const diff = async (args: string[]) => {
    const value = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary',
      '--no-color', '--no-relative', '--ignore-submodules=all', '--submodule=short',
      '--src-prefix=a/', '--dst-prefix=b/', ...args, '--'])
    return { bytes: value.length, digest: digest(value) }
  }
  const capture = async () => {
    await disableFilters()
    const commit = await oid('HEAD^{commit}'), tree = await oid(`${commit}^{tree}`)
    const indexBytes = await git(['ls-files', '--stage', '-v', '-z', '--full-name'])
    const flags = indexFlags(indexBytes)
    const statusBytes = await status()
    const staged = await diff(['--cached', commit])
    const unstaged = await diff([])
    const names = await git(['ls-files', '--others', '--exclude-standard', '-z', '--full-name'])
    const lastIndex = await git(['ls-files', '--stage', '-v', '-z', '--full-name'])
    const [repository, lastCommit] = await lines([
      'rev-parse', '--absolute-git-dir', '--verify', '--end-of-options', 'HEAD^{commit}',
    ], 2)
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(lastCommit!)) throw invalidOutput()
    return { source: { commit, tree, index: digest(indexBytes) }, flags,
      status: statusCounts(statusBytes), statusDigest: digest(statusBytes), staged, unstaged,
      untracked: { entries: records(names).length, namesDigest: digest(names), contentRead: false as const },
      changed: commit !== lastCommit || !indexBytes.equals(lastIndex) || repository !== gitDirectory }
  }
  const before = await capture()
  const after = await capture()
  const sampledConsistent = !before.changed && !after.changed && JSON.stringify(before) === JSON.stringify(after)
  const value: Omit<DevelopmentProgressObservation, 'observationDigest'> = {
    schemaVersion: 1,
    repository: digest(gitDirectory!),
    source: after.source,
    changes: {
      staged: after.staged, unstaged: after.unstaged, untracked: after.untracked,
    },
    indexFlags: after.flags,
    status: after.status,
    observedChange: !sampledConsistent,
    sampledConsistent,
    writerFrozen: false,
    progressCaptured: false,
    secretsReviewed: false,
    submoduleWorktreesInspected: false,
    candidateEligible: false,
    publishAllowed: false,
    ...(request.context === undefined ? {} : { contextDigest: digest(request.context) }),
  }
  return { ...value, observationDigest: digest(JSON.stringify(value)) }
}
