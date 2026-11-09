import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

const FILE_LIMIT = 256 * 1024 * 1024
const TOTAL_LIMIT = 512 * 1024 * 1024
const TEXT_LIMIT = 1024 * 1024
const TEXT_TOTAL = 16 * 1024 * 1024
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const missing = (error: unknown) => error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
export interface ToolFileProof { sha256: string; bytes: number }

/** 工具文件读取错误仅含固定说明，不回显系统异常、路径或元数据正文。 */
export class QualityToolError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const fail = (code: string, message: string): never => { throw new QualityToolError(code, message) }

/** 本机显式指定的文件与安装目录读取；流式摘要有界，不执行工具，也不是 OS 沙箱。 */
export function toolFiles(signal: AbortSignal) {
  const files = new Map<string, { info?: BigIntStats; proof?: ToolFileProof }>()
  const directories = new Map<string, BigIntStats>()
  let bytesRead = 0, textBytes = 0, filesRead = 0
  const check = () => {
    if (signal.aborted) fail('cancelled', '工具核验已取消或超时，未返回部分结论')
  }
  const pathOf = (value: string) => {
    if (!isAbsolute(value) || value.includes('\0')) return fail('invalid_tool_path', '工具位置必须是明确的绝对路径')
    return resolve(value)
  }
  async function info(path: string) {
    const value = await lstat(path, { bigint: true })
    if (value.isSymbolicLink() || !samePath(resolve(await realpath(path)), path))
      return fail('unsafe_tool_path', '工具位置不能经过符号链接或重解析别名')
    return value
  }
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try { check(); return await action() }
    catch (error) {
      if (error instanceof QualityToolError) throw error
      return fail('tool_unreadable', '工具文件或安装目录不可读取，未返回部分结论')
    }
  }
  async function read(value: string, capture = false, optional = false) {
    return run(async () => {
      const path = pathOf(value), cached = files.get(path)
      if (cached && !capture) {
        if (!cached.proof && !optional) return fail('tool_unreadable', '必需工具文件不存在，不能复用可选元数据的缺失记录')
        return { proof: cached.proof, content: undefined }
      }
      if (!files.has(path) && files.size >= 256) return fail('tool_read_budget', '工具核验超过 256 个文件预算')
      let before: BigIntStats
      try { before = await info(path) }
      catch (error) {
        if (optional && missing(error)) {
          if (cached?.info) return fail('tool_changed', '先前已读取的安装元数据消失')
          files.set(path, {})
          return { proof: undefined, content: undefined }
        }
        throw error
      }
      if (!before.isFile()) return fail('unsafe_tool_path', '工具输入必须是普通文件')
      if (cached && (!cached.info || !same(cached.info, before))) return fail('tool_changed', '工具文件在核验期间变化')
      // 操作者已显式指定文件；允许共享硬链接，但每个路径仍须在结束时复核。
      const shared = !capture && [...files.values()].find(value => value.info && value.proof && same(value.info, before))
      if (shared) {
        files.set(path, { info: before, proof: shared.proof })
        return { proof: shared.proof, content: undefined }
      }
      const size = Number(before.size)
      if (size > FILE_LIMIT || bytesRead + size > TOTAL_LIMIT
        || (capture && (size > TEXT_LIMIT || textBytes + size > TEXT_TOTAL)))
        return fail('tool_read_budget', '工具或元数据超过本轮读取预算，不能缩小范围后视为完整')
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024), chunks: Buffer[] = []
      let used = 0
      try {
        if (!same(before, await handle.stat({ bigint: true }))) return fail('tool_changed', '打开期间工具文件变化')
        while (used <= size) {
          check()
          const { bytesRead: count } = await handle.read(buffer, 0, Math.min(buffer.length, size - used + 1), used)
          if (!count) break
          used += count
          bytesRead += count
          if (capture) textBytes += count
          if (used > size || bytesRead > TOTAL_LIMIT) return fail('tool_changed', '读取期间工具大小变化')
          hash.update(buffer.subarray(0, count))
          if (capture) chunks.push(Buffer.from(buffer.subarray(0, count)))
        }
        if (used !== size || !same(before, await handle.stat({ bigint: true })) || !same(before, await info(path)))
          return fail('tool_changed', '读取期间工具内容或身份变化')
      } finally { await handle.close() }
      const proof = { sha256: hash.digest('hex'), bytes: used }
      filesRead++
      files.set(path, { info: before, proof })
      return { proof, content: capture ? Buffer.concat(chunks, used) : undefined }
    })
  }
  return {
    read,
    async startupFiles(value: string) {
      return run(async () => {
        const path = pathOf(value), before = await info(path)
        if (!before.isDirectory()) return fail('invalid_tool_path', 'Python 安装位置必须是目录')
        const prior = directories.get(path)
        if (prior && !same(prior, before)) return fail('tool_changed', '安装目录在核验期间变化')
        directories.set(path, before)
        const directory = await opendir(path), names: string[] = []
        let count = 0
        for await (const entry of directory) {
          check()
          if (++count > 2048) return fail('tool_read_budget', '安装目录超过 2048 个顶层条目预算')
          if (entry.name.toLowerCase().endsWith('.pth') || ['sitecustomize.py', 'usercustomize.py'].includes(entry.name.toLowerCase())) {
            if (names.length >= 64) return fail('tool_read_budget', 'Python 启动扩展超过 64 项预算')
            names.push(entry.name)
          }
        }
        if (!same(before, await info(path))) return fail('tool_changed', '扫描期间安装目录变化')
        return names.sort()
      })
    },
    async finish() {
      return run(async () => {
        for (const [path, before] of directories) {
          check()
          if (!same(before, await info(path))) return fail('tool_changed', '核验结束前安装目录变化')
        }
        for (const [path, before] of files) {
          check()
          if (before.info) {
            if (!same(before.info, await info(path))) return fail('tool_changed', '核验结束前工具文件变化')
          } else {
            try { await lstat(path); return fail('tool_changed', '核验期间出现原先缺失的安装元数据') }
            catch (error) { if (!missing(error)) throw error }
          }
        }
        return { bytesRead, filesRead, pathsObserved: files.size }
      })
    },
  }
}
