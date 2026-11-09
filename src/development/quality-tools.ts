import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { QualityDefinitionSchema, QualityToolLocationSchema } from './quality-contracts.ts'
import { QualityToolError, toolFiles } from './tool-files.ts'

export { QualityToolError } from './tool-files.ts'
const Request = z.object({
  tools: QualityDefinitionSchema.shape.tools,
  locations: z.array(QualityToolLocationSchema).min(1).max(32),
}).strict()
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const canonicalName = (value: string) => value.toLowerCase().replace(/[-_.]+/g, '-')
const DirectUrl = z.object({
  url: z.string().max(4096),
  dir_info: z.object({ editable: z.boolean().optional() }).optional(),
})
function headers(content: string) {
  const section = content.split(/\r?\n\r?\n/, 1)[0]!
  const lines = section.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)
  const values = new Map<string, string[]>()
  if (lines.length > 512) return undefined
  for (const line of lines) {
    const field = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line)
    if (!field) return undefined
    const key = field[1]!.toLowerCase()
    values.set(key, [...values.get(key) ?? [], field[2]!])
  }
  return values
}

/** 核对显式工具文件及 Python 安装声明；元数据和启动器匹配不代表完整工具链或执行能力。 */
export async function verifyQualityTools(input: z.input<typeof Request>, options: { signal?: AbortSignal } = {}) {
  const parsed = Request.safeParse(input)
  if (!parsed.success) throw new QualityToolError('invalid_tool_request', '工具声明或安装位置格式无效')
  const { tools, locations } = parsed.data
  const names = new Set(locations.map(value => value.name))
  if (names.size !== locations.length || tools.length !== locations.length || tools.some(value => !names.has(value.name)))
    throw new QualityToolError('tool_scope_mismatch', '必须明确提供所有已登记工具的位置，不能漏项或混入其他工具')
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])])
  const reader = toolFiles(signal)
  const observations = []
  for (const tool of tools) {
    const location = locations.find(value => value.name === tool.name)!
    const artifact = (await reader.read(location.path)).proof!
    const issues: { code: string; action: string }[] = []
    const artifacts: { role: string; sha256?: string; bytes?: number; present: boolean }[] = []
    let incomplete = false, metadataMismatch = false
    const issue = (code: string, action: string) => { issues.push({ code, action }) }
    if (artifact.sha256 !== tool.sha256) issue('tool_content_mismatch', '核对实际工具文件及声明版本，禁止原地更新后沿用旧证据')
    const metadata = async (file: string, role: string, optional = false, capture = true) => {
      const result = await reader.read(file, capture, optional)
      artifacts.push({ role, present: !!result.proof, ...result.proof })
      if (!result.proof) { if (!optional) incomplete = true; return undefined }
      if (!capture) return undefined
      try { return new TextDecoder('utf-8', { fatal: true }).decode(result.content).replace(/^\uFEFF/, '') }
      catch { incomplete = true; issue('metadata_encoding_unknown', '保留原始元数据并补充对应编码解析'); return undefined }
    }
    let python: { metadataNameMatched: boolean; metadataVersionMatched: boolean;
      editable: boolean | 'unknown'; dependencies: { name?: string; declarationDigest: string }[];
      startup: { pathLines: number; executableLines: number; customizers: number }; recordPresent: boolean } | undefined
    if (location.python) {
      const selected = location.python, directory = join(selected.sitePackagesPath, selected.distribution)
      const data = await metadata(join(directory, 'METADATA'), 'python-metadata', true)
      const fields = data === undefined ? undefined : headers(data)
      const packageNames = fields?.get('name') ?? [], versions = fields?.get('version') ?? []
      const metadataNameMatched = packageNames.length === 1 && canonicalName(packageNames[0]!) === canonicalName(selected.packageName)
      const metadataVersionMatched = versions.length === 1 && versions[0] === tool.version
      if (!fields || packageNames.length !== 1 || versions.length !== 1 || fields.get('metadata-version')?.length !== 1) {
        incomplete = true
        issue('python_metadata_incomplete', '补齐单一发行包的完整安装元数据')
      } else if (!metadataNameMatched || !metadataVersionMatched) {
        metadataMismatch = true
        issue('python_metadata_mismatch', '安装包名称或声明版本与目标配置不一致')
      }
      const requirements = fields?.get('requires-dist') ?? []
      const dependencies = requirements.map(value => {
        const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(value)?.[1]
        return { name: name && name.length <= 128 ? name : undefined, declarationDigest: sha(value) }
      })
      if (dependencies.length) issue('python_dependencies_unverified', '依赖名称只是声明；补实际包内容、条件依赖及版本解析证据')
      let editable: boolean | 'unknown' = 'unknown'
      const origin = await metadata(join(directory, 'direct_url.json'), 'python-origin', true)
      if (origin !== undefined) {
        try {
          const value = DirectUrl.parse(JSON.parse(origin))
          editable = value.dir_info?.editable ?? false
        } catch { incomplete = true; issue('python_origin_invalid', '安装来源记录损坏或格式未知，不能推断为普通安装') }
      } else issue('python_origin_unknown', '没有可用直接来源记录；不能据此认定源码已冻结')
      if (editable === true) issue('python_editable_source_unverified', '可编辑安装会加载外部源码；显式绑定并核验实际加载源码及其依赖')
      await metadata(join(directory, 'RECORD'), 'python-record', true, false)
      const recordPresent = artifacts.find(value => value.role === 'python-record')?.present === true
      if (!recordPresent) { incomplete = true; issue('python_record_missing', '缺少安装清单，补齐发行包文件归属证据') }
      else issue('python_record_not_verified', '安装清单仅留摘要，尚未逐项验证清单或包内容')
      const startup = { pathLines: 0, executableLines: 0, customizers: 0 }
      const extensions = await reader.startupFiles(selected.sitePackagesPath)
      for (const [index, name] of extensions.entries()) {
        const body = await metadata(join(selected.sitePackagesPath, name), `python-startup-${index}`)
        if (body === undefined) continue
        if (!name.toLowerCase().endsWith('.pth')) { startup.customizers++; continue }
        for (const line of body.split(/\r?\n/).map(value => value.trimEnd()).filter(value => value && !value.startsWith('#'))) {
          if (/^import[ \t]/.test(line)) startup.executableLines++
          else startup.pathLines++
        }
      }
      if (startup.pathLines || startup.executableLines || startup.customizers)
        issue('python_startup_unresolved', '启动扩展或外部路径未求值；不得执行元数据来补证，也不得沿其路径自动读取')
      python = { metadataNameMatched, metadataVersionMatched, editable, dependencies, startup, recordPresent }
    }
    issue('tool_runtime_unverified', '尚未证明解释器、运行时搜索路径、外部库及目标兼容性，不构成执行许可')
    observations.push({ name: tool.name, declaredVersion: tool.version, artifact,
      contentMatched: artifact.sha256 === tool.sha256,
      status: artifact.sha256 !== tool.sha256 || metadataMismatch ? 'mismatch' as const
        : incomplete ? 'evidence_incomplete' as const : 'selected_content_matched' as const,
      artifacts, python, issues })
  }
  const read = await reader.finish()
  const status = observations.some(value => value.status === 'mismatch') ? 'mismatch' as const
    : observations.some(value => value.status === 'evidence_incomplete') ? 'evidence_incomplete' as const : 'selected_content_matched' as const
  return { schemaVersion: 1 as const, status, observations, observationDigest: sha(JSON.stringify(observations)), read,
    assurance: { readOnly: true as const, persisted: false as const, toolExecutionAttempted: false as const,
      dependencyClosureVerified: false as const, toolsVerified: false as const,
      executionAuthorized: false as const, publishAllowed: false as const } }
}
