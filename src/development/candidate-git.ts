import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { devNull } from 'node:os'
import { join, relative, isAbsolute, sep } from 'node:path'
import { gitReader, gitRecords, repositoryIdentity } from './git-read.ts'
import { DevelopmentChangeError } from './changes.ts'

const fail = (code: string, message: string): never => { throw new DevelopmentChangeError(code, message) }
const objectHash = (format: string, type: string, body: Buffer) =>
  createHash(format).update(`${type} ${body.length}\0`).update(body).digest('hex')
export const COMBINATION_POLICY = 'builtin-ort-v1'
export interface CandidateSource {
  repositoryId: string
  commit: string
  tree: string
  objectFormat: 'sha1' | 'sha256'
}

/**
 * 临时裸元数据隔离源仓库配置；只复用对象库，不创建源码目录或修改作者索引。
 * 新对象及专用引用仍有存储成本，且此处不是对同账户恶意写者的权限边界。
 */
export async function candidateGit(repository: string, parent: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const cwd = await realpath(repository)
  const reader = gitReader({ repository }, () => cwd, signal)
  const format = await reader.scalar(['rev-parse', '--show-object-format'])
  if (format !== 'sha1' && format !== 'sha256') return fail('candidate_format', '仓库对象格式不受支持')
  if (await reader.scalar(['rev-parse', '--is-shallow-repository']) !== 'false')
    return fail('candidate_shallow', '浅仓库缺少完整祖先关系，暂不能构造候选组合')
  const reported = await reader.scalar(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = await realpath(reported), identity = await stat(common, { bigint: true })
  const objects = await realpath(join(common, 'objects')), objectIdentity = await stat(objects, { bigint: true })
  const temporary = await mkdtemp(join(parent, 'candidate-git-'))
  // Git for Windows 的配置空文件使用 NUL；Node 的设备路径 \\.\nul 不被其配置读取器接受。
  const nullFile = process.platform === 'win32' ? 'NUL' : devNull
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_CONFIG_SYSTEM: nullFile,
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' })
  const run = async (args: string[], input?: Buffer, allowed = [0]) => {
    signal.throwIfAborted()
    return new Promise<{ output: Buffer; code: number }>((resolve, reject) => {
      let closed = false, result: { output: Buffer; code: number; error?: unknown } | undefined, inputError: unknown
      const finish = () => {
        if (!closed || !result) return
        if (signal.aborted) return reject(new DevelopmentChangeError('candidate_cancelled', '候选操作已中止，保留持久意图供后续核验'))
        if (inputError || result.error) {
          const operation = args.find(value => ['init', 'cat-file', 'merge-base', 'show-ref', 'symbolic-ref', 'update-ref',
            'ls-tree', 'check-attr', 'merge-tree', 'hash-object', '--version'].includes(value)) ?? 'unknown'
          return reject(new DevelopmentChangeError('candidate_git_failed',
            `候选 Git 操作失败（${operation}，退出码 ${result.code}${inputError ? '，输入未确认' : ''}），未发布或改动源码`))
        }
        resolve(result)
      }
      const child = execFile('git', ['--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch',
        '-c', `core.hooksPath=${nullFile}`, '-c', `core.attributesFile=${nullFile}`, '-c', 'gc.auto=0',
        '-c', 'maintenance.auto=false', ...args], {
        cwd: temporary, env, windowsHide: true, signal, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
      }, (error, output) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? -1 : 0
        result = { output, code, ...(!allowed.includes(code) ? { error } : {}) }
        finish()
      })
      child.once('close', () => { closed = true; finish() })
      child.stdin?.on('error', error => { inputError = error })
      child.stdin?.end(input)
    })
  }
  const clean = async () => {
    const rel = relative(parent, temporary)
    if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || !/^candidate-git-[^/\\]+$/.test(rel))
      return fail('candidate_cleanup', '临时元数据目录归属异常，未清理')
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
  try {
    await run(['init', '--bare', `--object-format=${format}`, '--template=', '.'])
    env.GIT_OBJECT_DIRECTORY = objects
    const length = format === 'sha1' ? 40 : 64
    const oid = (value: string) => {
      if (!new RegExp(`^[a-f0-9]{${length}}$`).test(value)) return fail('candidate_object', '对象身份格式或类型不匹配')
      return value
    }
    const repositoryId = repositoryIdentity(reported)
    const check = async () => {
      signal.throwIfAborted()
      const current = await realpath(await reader.scalar(['rev-parse', '--path-format=absolute', '--git-common-dir']))
      const next = await stat(current, { bigint: true }), nextObjects = await stat(objects, { bigint: true })
      if (current !== common || next.dev !== identity.dev || next.ino !== identity.ino
        || nextObjects.dev !== objectIdentity.dev || nextObjects.ino !== objectIdentity.ino || await realpath(repository) !== cwd)
        fail('candidate_repository_changed', '操作期间仓库身份变化，不能确认候选')
    }
    const commit = async (value: string): Promise<CandidateSource> => {
      oid(value)
      const raw = (await run(['cat-file', 'commit', value])).output
      const tree = /^tree ([a-f0-9]+)\n/.exec(raw.toString('utf8'))?.[1]
      if (!tree || objectHash(format, 'commit', raw) !== value) return fail('candidate_object', '提交内容与对象身份不一致')
      oid(tree)
      return { repositoryId, commit: value, tree, objectFormat: format }
    }
    const ancestor = async (base: string, next: string) =>
      (await run(['merge-base', '--is-ancestor', oid(base), oid(next)], undefined, [0, 1])).code === 0
    const keep = async (ref: string, value: string) => {
      if (!/^refs\/superserve\/(?:candidates|combinations|combination-bases)\/[a-f0-9]{64}$/.test(ref))
        return fail('candidate_ref', '候选保留引用不在专用范围内')
      await check()
      // 原子创建专用引用；已有相同值可恢复，其他值不得覆盖。
      const symbolic = await run([`--git-dir=${common}`, 'symbolic-ref', '--quiet', ref], undefined, [0, 1])
      if (symbolic.code === 0) return fail('candidate_ref_conflict', '候选保留引用不能跟随可变引用')
      const found = await run([`--git-dir=${common}`, 'show-ref', '--verify', '--hash', ref], undefined, [0, 1, 128])
      if (found.code === 0) {
        if (found.output.toString('ascii').trim() !== value) return fail('candidate_ref_conflict', '候选保留引用已指向其他对象')
        return
      }
      const written = await run([`--git-dir=${common}`, 'update-ref', '--no-deref', ref, oid(value), '0'.repeat(length)], undefined, [0, 128])
      if (written.code !== 0) {
        const current = (await run([`--git-dir=${common}`, 'show-ref', '--verify', '--hash', ref])).output.toString('ascii').trim()
        if (current !== value) return fail('candidate_ref_conflict', '候选保留引用竞争失败，未覆盖其他对象')
      }
    }
    const attributes = async (value: string) => {
      const names = (await run(['ls-tree', '-r', '--name-only', '-z', oid(value)])).output
      const records = gitRecords(names, 50_000)
      if (!records.length) return
      const result = gitRecords((await run(['check-attr', `--source=${value}`, '-z', '--stdin', 'merge'], names)).output, 150_000)
      if (result.length !== records.length * 3) return fail('candidate_attributes', '合并属性清单不完整')
      for (let index = 0; index < result.length; index += 3) {
        if (!result[index]!.equals(records[index / 3]!) || result[index + 1]!.toString() !== 'merge')
          return fail('candidate_attributes', '合并属性与固定路径不匹配')
        if (!['unspecified', 'set', 'unset', 'text', 'binary', 'union'].includes(result[index + 2]!.toString()))
          return fail('candidate_custom_merge', '候选要求自定义合并驱动，需要单独授权和固定实现；未执行源仓库命令')
      }
    }
    return { repositoryId, commit, ancestor, keep, check, close: clean,
      async changedPaths(base: string, next: string) {
        const output = await run(['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames',
          '--no-ext-diff', oid(base), oid(next), '--'])
        const decode = new TextDecoder('utf-8', { fatal: true })
        try { return gitRecords(output.output, 10_000).map(value => decode.decode(value)) }
        catch { return fail('candidate_paths', '候选改动路径不可完整解析，不能判断声明范围') }
      },
      version: (await run(['--version'])).output.toString('utf8').trim(),
      async combine(base: string, candidates: string[], combinationId: string) {
        await attributes(base)
        for (const candidate of candidates) await attributes(candidate)
        let current = base
        const steps: { candidate: string; tree: string; commit: string }[] = []
        for (const [index, candidate] of candidates.entries()) {
          const result = await run(['merge-tree', '--write-tree', '--name-only', '-z', current, candidate], undefined, [0, 1])
          if (result.code === 1) return { state: 'conflicted' as const, conflictIndex: index, steps }
          const tree = oid(result.output.subarray(0, result.output.indexOf(0)).toString('ascii'))
          const raw = Buffer.from(`tree ${tree}\nparent ${current}\nparent ${candidate}\nauthor SuperServe <integration@localhost> 0 +0000\ncommitter SuperServe <integration@localhost> 0 +0000\n\nCombination ${combinationId} step ${index + 1}\n`)
          const expected = objectHash(format, 'commit', raw)
          const created = (await run(['hash-object', '-t', 'commit', '-w', '--stdin'], raw)).output.toString('ascii').trim()
          if (created !== expected) return fail('candidate_object', '组合提交内容与写入身份不一致')
          current = created
          steps.push({ candidate, tree, commit: current })
        }
        return { state: 'prepared' as const, source: await commit(current), steps }
      } }
  } catch (error) { await clean(); throw error }
}
