import { z } from 'zod'
import { KNOWLEDGE_DOMAINS } from '../knowledge/contracts.ts'

export const DEVICE_LIMITS = { devices: 32, grants: 64, handles: 128, active: 8, perDevice: 2,
  timeoutMs: 10_000, handleTtlMs: 60_000, readChars: 8000, responseBytes: 48 * 1024 } as const
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const domain = z.enum(KNOWLEDGE_DOMAINS)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const DeviceDescriptorSchema = z.object({
  id, label: z.string().trim().min(1).max(160), domains: z.array(domain).min(1).max(6),
  route: z.enum(['direct', 'designated-hk']),
}).strict()
export const DeviceGrantSchema = z.object({
  id, nodeId: id, deviceId: id, domain,
  includeRestricted: z.boolean().default(false),
}).strict()
export const DeviceQuerySchema = z.object({
  grantId: id, text: z.string().trim().min(1).max(300).optional(),
  limit: z.number().int().min(1).max(8).default(8),
}).strict()
export const DeviceReadSchema = z.object({
  handle: z.string().uuid(), offset: z.number().int().min(0).max(100_000_000).default(0),
  length: z.number().int().min(1).max(DEVICE_LIMITS.readChars).default(4000),
}).strict()
export const DeviceHitSchema = z.object({
  // contentHash 对完整、规范化后的 UTF-8 文本计算；局部读取另算片段哈希。
  sourceId: z.string().min(1).max(300), version: z.string().min(1).max(160), contentHash: hash,
  title: z.string().min(1).max(160), domain, observedAt: z.iso.datetime(),
  totalChars: z.number().int().positive().max(100_000_000),
  sensitivity: z.enum(['personal', 'restricted']),
}).strict()
export const DeviceReplySchema = z.object({
  hits: z.array(DeviceHitSchema).max(8), truncated: z.boolean(),
}).strict()
export const DeviceChunkSchema = z.object({
  version: DeviceHitSchema.shape.version, contentHash: hash,
  offset: DeviceReadSchema.shape.offset, totalChars: DeviceHitSchema.shape.totalChars,
  text: z.string().min(1).max(DEVICE_LIMITS.readChars).refine(value => value.isWellFormed(), '设备片段含无效 Unicode 字符'),
}).strict()
export type DeviceDescriptor = z.infer<typeof DeviceDescriptorSchema>
export type DeviceGrant = z.infer<typeof DeviceGrantSchema> & { generation: string; revoked?: boolean }
export type DeviceHit = z.infer<typeof DeviceHitSchema>
export interface DeviceSource extends DeviceHit {
  deviceId: string
  grantId: string
  grantGeneration: string
  route: DeviceDescriptor['route']
  offset: number
  end: number
}
/** 宿主负责连接认证、传输限额和实际路由；此端口不接受模型指定的地址或凭据。 */
export interface DevicePort {
  query(request: { domain: DeviceGrant['domain']; text?: string; limit: number; includeRestricted: boolean },
    signal: AbortSignal): Promise<unknown>
  read(request: { sourceId: string; version: string; contentHash: string; offset: number; length: number },
    signal: AbortSignal): Promise<unknown>
}
