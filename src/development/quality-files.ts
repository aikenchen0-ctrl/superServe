import { constants, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const FILE_LIMIT = 4 * 1024 * 1024
const TOTAL_LIMIT = 24 * 1024 * 1024
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const missing = (error: unknown) => error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

/** 只读质量入口的固定错误，不回显原始路径、文件正文或系统错误。 */
export class QualityImportError extends Error {
  constructor(readonly code: 'invalid_request' | 'path_unavailable' | 'unsafe_path' | 'bundle_changed' | 'cancelled',
    message: string) { super(message) }
}

export interface QualityFileReference {
  name: string
  status: 'read' | 'missing' | 'oversized' | 'unreadable' | 'invalid_json'
  bytes?: number
  sha256?: string
}
export interface QualityFiles {
  json(name: string): Promise<unknown | undefined>
  text(name: string): Promise<string | undefined>
  raw(name: string): Promise<QualityFileReference>
  references: QualityFileReference[]
  finish(): Promise<void>
}

/** 仅供本机显式授权的目录读取；拒绝链接，不是对恶意并发写者的 OS 沙箱。 */
export async function qualityFiles(directory: string, signal?: AbortSignal, collected?: Map<string, Buffer>): Promise<QualityFiles> {
  if (typeof directory !== 'string' || !directory || directory.length > 4096 || directory.includes('\0'))
    throw new QualityImportError('invalid_request', '请指定有效证据目录')
  const check = () => {
    if (signal?.aborted) throw new QualityImportError('cancelled', '证据导入已取消，未返回部分结论')
  }
  check()
  const root = resolve(directory)
  let identity: BigIntStats
  try {
    identity = await lstat(root, { bigint: true })
    if (!identity.isDirectory() || identity.isSymbolicLink() || resolve(await realpath(root)) !== root)
      throw new QualityImportError('unsafe_path', '证据目录不能经过符号链接或重解析别名')
  } catch (error) {
    if (error instanceof QualityImportError) throw error
    throw new QualityImportError('path_unavailable', '证据目录不可读取')
  }
  const references: QualityFileReference[] = []
  const seen = new Map<string, { reference: QualityFileReference; info?: BigIntStats }>()
  let total = 0
  const read = async (name: string) => {
    check()
    if (!name || name.length > 512 || !name.isWellFormed() || /[\\<>:"|?*\0-\x1f]/.test(name)
      || name.split('/').some(part => part === '..' || part === '.' || !part || part.toLowerCase() === '.git'))
      throw new QualityImportError('invalid_request', '证据文件必须是固定的目录内相对路径')
    if (seen.has(name)) throw new QualityImportError('invalid_request', '同一证据文件不能重复采集')
    const file = join(root, name), inside = relative(root, file)
    if (isAbsolute(inside) || inside.startsWith(`..${sep}`))
      throw new QualityImportError('unsafe_path', '证据文件超出授权目录')
    let info: BigIntStats | undefined
    const reference: QualityFileReference = { name, status: 'unreadable' }
    try {
      let parent = root
      for (const segment of name.split('/').slice(0, -1)) {
        parent = join(parent, segment)
        const entry = await lstat(parent, { bigint: true })
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new QualityImportError('unsafe_path', '证据路径不能经过链接或非目录对象')
      }
      info = await lstat(file, { bigint: true })
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || resolve(await realpath(file)) !== file)
        throw new QualityImportError('unsafe_path', '证据文件必须是目录内的普通文件')
      if (info.size > BigInt(FILE_LIMIT) || total + Number(info.size) > TOTAL_LIMIT) {
        reference.status = 'oversized'
      } else {
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let value: Buffer
        try {
          if (!same(info, await handle.stat({ bigint: true })))
            throw new QualityImportError('bundle_changed', '打开期间证据文件发生变化，请使用封存副本')
          // 固定大小缓冲和一次额外字节检测，增长中的文件不会无限读入内存。
          const data = Buffer.alloc(Number(info.size) + 1)
          let used = 0
          while (used < data.length) {
            check()
            const { bytesRead } = await handle.read(data, used, data.length - used, used)
            if (!bytesRead) break
            used += bytesRead
          }
          if (used !== Number(info.size) || !same(info, await handle.stat({ bigint: true }))
            || !same(info, await lstat(file, { bigint: true })) || resolve(await realpath(file)) !== file)
            throw new QualityImportError('bundle_changed', '读取期间证据文件发生变化，请重新核对')
          value = data.subarray(0, used)
        } finally { await handle.close() }
        total += value.length
        // 仅在调用方显式要求保留时保存同次读取字节；不再次打开路径采集。
        collected?.set(name, value)
        Object.assign(reference, { status: 'read', bytes: value.length, sha256: hash(value) })
        seen.set(name, { reference, info })
        references.push(reference)
        return { reference, value }
      }
    } catch (error) {
      if (error instanceof QualityImportError) throw error
      reference.status = missing(error) ? 'missing' : 'unreadable'
    }
    seen.set(name, { reference, info })
    references.push(reference)
    return { reference, value: undefined }
  }
  return {
    references,
    async raw(name) { return (await read(name)).reference },
    async text(name) {
      const { reference, value } = await read(name)
      if (!value) return undefined
      try { return new TextDecoder('utf-8', { fatal: true }).decode(value).replace(/^\uFEFF/, '') }
      catch { reference.status = 'unreadable'; return undefined }
    },
    async json(name) {
      const { reference, value } = await read(name)
      if (!value) return undefined
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(value).replace(/^\uFEFF/, '')
        return JSON.parse(text) as unknown
      } catch { reference.status = 'invalid_json'; return undefined }
    },
    async finish() {
      check()
      try {
        if (!same(identity, await lstat(root, { bigint: true })) || resolve(await realpath(root)) !== root)
          throw new Error('changed')
        for (const [name, { info, reference }] of seen) {
          check()
          const file = join(root, name)
          if (reference.status === 'missing') {
            try { await lstat(file); throw new Error('appeared') }
            catch (error) { if (!missing(error)) throw error }
          } else if (info && (!same(info, await lstat(file, { bigint: true }))
            || resolve(await realpath(file)) !== file)) throw new Error('changed')
        }
      } catch (error) {
        if (error instanceof QualityImportError) throw error
        throw new QualityImportError('bundle_changed', '导入期间证据目录或文件发生变化，未生成结论')
      }
    },
  }
}
