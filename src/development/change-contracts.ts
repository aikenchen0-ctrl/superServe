import { z } from 'zod'

const text = (max: number) => z.string().trim().min(1).max(max)
const id = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const path = text(512).transform(value => value.replaceAll('\\', '/')).refine(value =>
  value === '.' || (!value.startsWith('/') && !/[<>:"|?*\0-\x1f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')),
'范围必须是仓库相对路径，不能含上级目录、Git 元数据或通配符')
const paths = z.array(path).max(32).refine(values => new Set(values).size === values.length, '路径不能重复')
const criteria = z.array(text(500)).min(1).max(12)
const contracts = z.array(z.object({ name, version: text(128) }).strict()).max(16)
  .refine(values => new Set(values.map(value => value.name)).size === values.length, '契约名称不能重复')

export const DevelopmentModuleSchema = z.object({
  requestId, revision,
  repositoryPath: text(4096),
  name,
  paths: paths.refine(values => values.length > 0, '模块至少声明一个路径'),
  contracts,
  acceptance: criteria,
}).strict()
export const DevelopmentChangeSchema = z.object({
  requestId, revision,
  worktreePath: text(4096),
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  owner: text(160),
  purpose: text(1000),
  modules: z.array(z.object({ id, revision: revision.refine(value => value > 0) }).strict()).min(1).max(16)
    .refine(values => new Set(values.map(value => value.id)).size === values.length, '模块不能重复'),
  reads: paths,
  writes: paths,
  contracts: z.array(z.object({ name, version: text(128), access: z.enum(['read', 'write']) }).strict()).max(16)
    .refine(values => new Set(values.map(value => value.name)).size === values.length, '契约名称不能重复'),
  acceptance: criteria,
}).strict()
export const DevelopmentRelatedSchema = z.object({
  revision: z.coerce.number().int().nonnegative().optional(),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(20).default(8),
}).strict().refine(value => value.offset === 0 || value.snapshot !== undefined, '后续页必须携带关联快照')
export const DevelopmentVersionSchema = z.object({
  revision: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
export const DevelopmentReadSchema = z.object({
  view: z.enum(['intent', 'related', 'module']).default('intent'),
  revision: z.number().int().positive().optional(),
  moduleId: id.optional(),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(8).optional(),
}).strict()
export type DevelopmentModuleInput = z.input<typeof DevelopmentModuleSchema>
export type DevelopmentChangeInput = z.input<typeof DevelopmentChangeSchema>
export type DevelopmentRelatedQuery = { revision?: number; snapshot?: string; offset?: number; limit?: number }
export type DevelopmentReadInput = z.input<typeof DevelopmentReadSchema>
