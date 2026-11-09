import { z } from 'zod'
import { AcceptanceChecksSchema } from './acceptance-checks.ts'

const id = z.string().regex(/^[a-f0-9]{64}$/)
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1)
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const text = (max: number) => z.string().trim().min(1).max(max)
const path = text(512).transform(value => value.replaceAll('\\', '/')).refine(value =>
  !value.startsWith('/') && !/[<>:"|?*\0-\x1f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'),
'必须是仓库内的相对路径，不能含上级目录或 Git 元数据')

export const QualityFormatSchema = z.enum(['jvm-trial-v1', 'native-crap-v1'])
export const QualityDefinitionSchema = z.object({
  name,
  module: z.object({ id, revision }).strict(),
  format: QualityFormatSchema,
  recipe: z.object({
    repositoryId: id, commit: oid, tree: oid,
    path: z.union([z.literal('.'), path]),
  }).strict(),
  configuration: z.object({ path, sha256: id }).strict(),
  tools: z.array(z.object({ name, version: text(128), sha256: id }).strict()).min(1).max(32)
    .refine(values => new Set(values.map(value => value.name)).size === values.length, '工具标识不能重复')
    .transform(values => [...values].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  environment: z.object({
    runtime: z.enum(['windows', 'linux', 'wsl', 'macos']),
    architecture: z.enum(['x64', 'arm64']),
  }).strict(),
  checks: AcceptanceChecksSchema.optional(),
}).strict()
export const QualityProfileInputSchema = QualityDefinitionSchema.extend({
  requestId: name,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 2),
}).strict()
export const QualityBindingInputSchema = z.object({
  profileId: id, profileRevision: revision,
  repositoryPath: text(4096), commit: oid,
}).strict()
export const QualitySourceInputSchema = QualityBindingInputSchema.extend({
  recipeRepositoryPath: text(4096).optional(),
}).strict()
export const QualityToolLocationSchema = z.object({
  name, path: text(4096),
  python: z.object({
    sitePackagesPath: text(4096),
    distribution: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.dist-info$/),
    packageName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  }).strict().optional(),
}).strict()
export const QualityToolInputSchema = z.object({
  profileId: id, profileRevision: revision,
  locations: z.array(QualityToolLocationSchema).min(1).max(32)
    .refine(values => new Set(values.map(value => value.name)).size === values.length, '工具位置不能重复'),
}).strict()
export const TaskQualityQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  snapshot: id.optional(),
}).strict().refine(value => value.offset === 0 || value.snapshot !== undefined, '后续页必须携带质量目录快照')
export const TaskQualitySourceSchema = z.object({
  changeRevision: revision, profileId: id, profileRevision: revision,
  recipeRepositoryPath: text(4096).optional(),
}).strict()
export type TaskQualityQuery = { offset?: number; limit?: number; snapshot?: string }
export type TaskQualitySourceInput = z.input<typeof TaskQualitySourceSchema>
export type QualityProfileInput = z.input<typeof QualityProfileInputSchema>
export type QualityBindingInput = z.input<typeof QualityBindingInputSchema>
export type QualitySourceInput = z.input<typeof QualitySourceInputSchema>
export type QualityToolInput = z.input<typeof QualityToolInputSchema>
