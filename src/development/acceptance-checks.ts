import { z } from 'zod'

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const text = z.string().trim().min(1).max(500).refine(value => value.isWellFormed(), '检查文本含无效字符')
const relative = z.string().min(1).max(512).refine(value =>
  value === '.' || (!/[\\<>:"|?*\0-\x1f]/.test(value) && !value.startsWith('/')
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')),
'检查路径必须是明确的相对路径，不能含上级目录、反斜线或 Git 元数据')
const requirement = z.object({
  scope: z.enum(['task', 'module']), index: z.number().int().nonnegative().max(11), text,
}).strict()
const location = z.object({ root: z.enum(['source', 'recipe', 'output']), path: relative }).strict()
export const AcceptanceResultSchema = z.object({
  format: z.enum(['junit-xml', 'ctest-xml']), path: relative.refine(value => value !== '.', '结果必须指定文件'),
  minimumTests: z.number().int().positive().max(1_000_000),
}).strict()
export const AcceptanceChecksSchema = z.array(z.object({
  id: name, title: text,
  requirements: z.array(requirement).max(24).refine(values =>
    new Set(values.map(value => `${value.scope}:${value.index}`)).size === values.length, '同一检查不能重复引用要求'),
  requires: z.array(name).max(31).refine(values => new Set(values).size === values.length, '检查依赖不能重复'),
  command: z.object({
    tool: name, cwd: location,
    argv: z.array(z.union([
      z.string().max(2000).refine(value => value.isWellFormed() && !value.includes('\0'), '参数含无效字符'),
      location,
    ])).max(64),
  }).strict(),
  result: AcceptanceResultSchema,
  timeoutMs: z.number().int().positive().max(3_600_000),
}).strict()).max(32).superRefine((checks, ctx) => {
  const ids = new Set(checks.map(check => check.id))
  if (ids.size !== checks.length) ctx.addIssue({ code: 'custom', message: '检查编号不能重复' })
  const resolved = new Set<string>()
  for (let pass = 0; pass < checks.length; pass++)
    for (const check of checks)
      if (check.requires.every(id => resolved.has(id))) resolved.add(check.id)
  if (checks.some(check => !resolved.has(check.id)))
    ctx.addIssue({ code: 'custom', message: '检查依赖缺失、自依赖或存在循环' })
})
export type AcceptanceCheck = z.infer<typeof AcceptanceChecksSchema>[number]

/** 只投影精确的要求映射；声明完整不等于覆盖充分、报告有效或执行通过。 */
export function acceptanceMapping(task: readonly string[], module: readonly string[], checks: readonly AcceptanceCheck[] = []) {
  const requirements = (['task', 'module'] as const).flatMap(scope => (scope === 'task' ? task : module)
    .map((text, index) => ({ scope, index, text,
      checks: checks.filter(check => check.requirements.some(ref =>
        ref.scope === scope && ref.index === index && ref.text === text)).map(check => check.id) })))
  const unmatched = checks.flatMap(check => check.requirements.filter(ref =>
    (ref.scope === 'task' ? task : module)[ref.index] !== ref.text).map(ref => ({ checkId: check.id, ...ref })))
  const executionOrder: string[] = []
  for (let pass = 0; pass < checks.length; pass++)
    for (const check of checks)
      if (!executionOrder.includes(check.id) && check.requires.every(id => executionOrder.includes(id))) executionOrder.push(check.id)
  return { requirements, checks: [...checks], unmatched, executionOrder,
    state: !checks.length ? 'unconfigured' as const : unmatched.length || requirements.some(ref => !ref.checks.length)
      ? 'incomplete' as const : 'declared' as const,
    executionAttempted: false as const, coverageVerified: false as const }
}
