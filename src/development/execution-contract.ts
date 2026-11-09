import { z } from 'zod'
import { WorkspaceError } from './workspaces.ts'

const RequirementSchema = z.enum(['atomic_range_creation', 'no_containment_fallback', 'durable_range_identity'])
const RequirementsSchema = z.array(RequirementSchema).max(3).refine(items => new Set(items).size === items.length)
export type DevelopmentExecutionRequirement = z.infer<typeof RequirementSchema>

const labels: Record<DevelopmentExecutionRequirement, string> = {
  atomic_range_creation: '创建时绑定原生范围',
  no_containment_fallback: '禁止退化为较弱进程范围',
  durable_range_identity: '可跨宿主核验的持久范围身份',
}

/** 仅为可信适配器的调用契约；不是某次执行的范围证据，也不授权释放目录。 */
export function executionContract(guarantees?: readonly DevelopmentExecutionRequirement[]) {
  const parsed = RequirementsSchema.safeParse(guarantees ?? [])
  if (!parsed.success) throw new WorkspaceError('execution_contract_invalid', '执行提供方能力契约无效，不能启动')
  return { guarantees: parsed.data, evidenceScope: 'launch_contract_only' as const,
    workspaceReleaseAllowed: false as const, externalWritersCovered: false as const }
}

/** 不接受版本号、平台或实验成功替代保证；缺项时在登记和启动副作用前拒绝。 */
export function requireExecutionContract(input: unknown, guarantees?: readonly DevelopmentExecutionRequirement[]) {
  const parsed = RequirementsSchema.safeParse(input)
  if (!parsed.success) throw new WorkspaceError('execution_requirements_invalid', '执行保证要求无效，不能启动')
  const requirements = parsed.data
  const contract = executionContract(guarantees)
  const missing = requirements.filter(value => !contract.guarantees.includes(value))
  if (missing.length) throw new WorkspaceError('execution_guarantee_unavailable',
    `执行提供方未保证：${missing.map(value => labels[value]).join('、')}；未启动命令`)
  return Object.freeze(requirements)
}
