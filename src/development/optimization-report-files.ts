import { createHash } from 'node:crypto'
import { z } from 'zod'
import { family, type Family, type Key } from '../kv-key.ts'
import { QualityProfileError } from './quality-profiles.ts'
import type { QualityFileReference } from './quality-files.ts'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const fileName = z.string().regex(/^[a-z0-9][a-z0-9./-]*$/).max(128)
const bytes = z.number().int().nonnegative().max(4 * 1024 * 1024)
const FileSchema = z.object({ name: fileName, sha256: digest, bytes }).strict()
const BlobSchema = z.object({ schemaVersion: z.literal(1), sha256: digest, bytes,
  base64: z.string().max(4 * Math.ceil(4 * 1024 * 1024 / 3)) }).strict()
type BlobRecord = z.infer<typeof BlobSchema>
const ManifestSchema = z.object({ schemaVersion: z.literal(1), ticketId: z.string().min(1), reportId: digest,
  retainedAt: z.string().datetime(), files: z.array(FileSchema).max(32), digest }).strict()
type Manifest = z.infer<typeof ManifestSchema>
interface Storage {
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V): void
  keys<V>(key: Family<V, never>): Key<V>[]
}
const blobs = family<BlobRecord>('development:quality-file:')
const manifests = (ticketId: string) => family<Manifest>(`development:quality-files:${hash(ticketId)}:`)
const corrupt = (): never => { throw new QualityProfileError('optimization_archive_corrupt', '保留原件的记录、大小或摘要不一致，不能返回文件') }
const identity = ({ digest: _, ...value }: Manifest) => hash(JSON.stringify(value))
const expectedFiles = (artifacts: readonly QualityFileReference[]) => artifacts
  .filter((file): file is QualityFileReference & { sha256: string; bytes: number } => file.sha256 !== undefined && file.bytes !== undefined)
  .map(({ name, sha256, bytes }) => ({ name, sha256, bytes })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** 仅在宿主事务与任务授权内调用；共享不可变字节，不提供绕过报告归属的全局读取入口。 */
export class OptimizationReportFiles {
  constructor(private readonly store: Storage) {}
  describe(ticketId: string, reportId: string, artifacts: readonly QualityFileReference[]) {
    const raw = this.store.get(manifests(ticketId)(reportId))
    if (raw === undefined) return null
    const parsed = ManifestSchema.safeParse(raw)
    if (!parsed.success || parsed.data.ticketId !== ticketId || parsed.data.reportId !== reportId
      || identity(parsed.data) !== parsed.data.digest
      || JSON.stringify(parsed.data.files) !== JSON.stringify(expectedFiles(artifacts))) return corrupt()
    return { ...parsed.data, retainedBytes: parsed.data.files.reduce((sum, file) => sum + file.bytes, 0),
      scope: 'observed_bytes_only' as const, integrity: 'checked_when_read' as const }
  }
  private blob(sha256: string) {
    const parsed = BlobSchema.safeParse(this.store.get(blobs(sha256)))
    if (!parsed.success || parsed.data.sha256 !== sha256) return corrupt()
    const data = Buffer.from(parsed.data.base64, 'base64')
    if (data.length !== parsed.data.bytes || data.toString('base64') !== parsed.data.base64 || hash(data) !== sha256)
      return corrupt()
    return parsed.data
  }
  /** 保留链接与新字节随外层记录一起提交；预算按实际序列化体积计，未计 SQLite 页和 WAL。 */
  retain(ticketId: string, reportId: string, artifacts: readonly QualityFileReference[], collected: Map<string, Buffer>, at: string) {
    const files = expectedFiles(artifacts)
    if (collected.size !== files.length) return corrupt()
    const previous = this.describe(ticketId, reportId, artifacts)
    const fresh = new Map<string, BlobRecord>()
    for (const file of files) {
      const data = collected.get(file.name)
      if (!data || data.length !== file.bytes || hash(data) !== file.sha256) return corrupt()
      if (previous || this.store.get(blobs(file.sha256)) !== undefined) this.blob(file.sha256)
      else fresh.set(file.sha256, BlobSchema.parse({ schemaVersion: 1, sha256: file.sha256,
        bytes: data.length, base64: data.toString('base64') }))
    }
    if (previous) return previous
    if (!files.length) return null
    const keys = this.store.keys(blobs)
    let occupied = 0
    for (const key of keys) {
      const parsed = BlobSchema.safeParse(this.store.get(key))
      if (!parsed.success || blobs(parsed.data.sha256) !== key) return corrupt()
      occupied += Buffer.byteLength(JSON.stringify(parsed.data), 'utf8')
    }
    const added = [...fresh.values()].reduce((sum, file) => sum + Buffer.byteLength(JSON.stringify(file), 'utf8'), 0)
    if (keys.length + fresh.size > 4096 || occupied + added > 64 * 1024 * 1024)
      throw new QualityProfileError('optimization_archive_budget', '原件保留容量已满，未保存新原件或部分记录；可改为仅记录摘要')
    const value = { schemaVersion: 1 as const, ticketId, reportId, retainedAt: at, files }
    const manifest = ManifestSchema.parse({ ...value, digest: hash(JSON.stringify(value)) })
    for (const file of fresh.values()) this.store.set(blobs(file.sha256), file)
    this.store.set(manifests(ticketId)(reportId), manifest)
    return this.describe(ticketId, reportId, artifacts)
  }
  read(ticketId: string, reportId: string, artifacts: readonly QualityFileReference[], name: string) {
    if (!fileName.safeParse(name).success)
      throw new QualityProfileError('invalid_archive_file', '原件名称无效', 400)
    const manifest = this.describe(ticketId, reportId, artifacts), file = manifest?.files.find(file => file.name === name)
    if (!file) throw new QualityProfileError('archive_file_missing', '该核对记录没有保留此文件', 404)
    const blob = this.blob(file.sha256)
    if (blob.bytes !== file.bytes) return corrupt()
    return { ticketId, reportId, name: file.name, sha256: blob.sha256, bytes: blob.bytes, base64: blob.base64 }
  }
}
