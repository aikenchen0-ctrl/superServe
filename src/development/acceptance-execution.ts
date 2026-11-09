import { resolve, sep } from 'node:path'
import { z } from 'zod'
import { DevelopmentChangeError } from './changes.ts'
import type { AcceptanceCheck } from './acceptance-checks.ts'
import type { PreparedExecutionInput } from './source-materialization.ts'

const fail = (code: string, message: string): never => { throw new DevelopmentChangeError(code, message) }

/** 只把固定检查声明编译成受控计划；计划不是启动许可，也不执行工具。 */
export interface AcceptanceExecutionPlan {
  schemaVersion: 1
  checkId: string
  tool: string
  cwd: string
  argv: string[]
  resultPath: string
  prerequisites: string[]
  materializationId: string
  outputRootBound: true
  executionAttempted: false
  executionAuthorized: false
  publishAllowed: false
}

const relative = z.string().min(1).max(512).refine(value =>
  value === '.' || (!value.startsWith('/') && !/[\\<>:"|?*\0-\x1f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')),
'检查引用必须是安全的相对路径')

function within(root: string, value: string) {
  const base = resolve(root), target = resolve(base, value)
  if (target !== base && !target.startsWith(`${base}${sep}`))
    return fail('acceptance_execution_path_escape', '检查路径不能离开固定输入或输出根')
  return target
}

function reference(root: string, path: string) {
  return within(root, relative.parse(path))
}

/**
 * 将检查的相对位置引用绑定到当前物化回执。
 * recipe 尚未由物化器准备，因此拒绝把它降级成活动工作树或用户目录。
 */
export function prepareAcceptanceExecution(check: AcceptanceCheck, prepared: PreparedExecutionInput): AcceptanceExecutionPlan {
  const cwd = check.command.cwd.root === 'source'
    ? reference(prepared.sourceDirectory, check.command.cwd.path)
    : check.command.cwd.root === 'output'
      ? reference(prepared.outputDirectory, check.command.cwd.path)
      : fail('acceptance_execution_recipe_unprepared', '配方目录尚未进入受控输入，不能生成执行计划')
  const argv = check.command.argv.map(value => {
    if (typeof value === 'string') return value
    return value.root === 'source'
      ? reference(prepared.sourceDirectory, value.path)
      : value.root === 'output'
        ? reference(prepared.outputDirectory, value.path)
        : fail('acceptance_execution_recipe_unprepared', '配方参数尚未进入受控输入，不能生成执行计划')
  })
  return {
    schemaVersion: 1, checkId: check.id, tool: check.command.tool, cwd,
    argv: [check.command.tool, ...argv], resultPath: reference(prepared.outputDirectory, check.result.path),
    prerequisites: [...check.requires], materializationId: prepared.materializationId, outputRootBound: true,
    executionAttempted: false, executionAuthorized: false, publishAllowed: false,
  }
}
