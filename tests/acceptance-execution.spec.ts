import { expect, it } from 'vitest'
import { prepareAcceptanceExecution } from '../src/development/acceptance-execution.ts'
import type { AcceptanceCheck } from '../src/development/acceptance-checks.ts'
import type { PreparedExecutionInput } from '../src/development/source-materialization.ts'

const prepared: PreparedExecutionInput = {
  materializationId: '00000000-0000-4000-8000-000000000001',
  sourceDirectory: 'O:/input/source', outputDirectory: 'O:/input/output',
  sourceIdentity: 'source-id', outputIdentity: 'output-id',
}
const check = (overrides: Partial<AcceptanceCheck> = {}): AcceptanceCheck => ({
  id: 'contract', title: '契约', requirements: [], requires: ['build'],
  command: { tool: 'pwsh', cwd: { root: 'source', path: 'module' }, argv: [
    '-File', { root: 'source', path: 'scripts/check.ps1' }, { root: 'output', path: 'input.xml' },
  ] }, result: { format: 'junit-xml', path: 'Reports/result.xml', minimumTests: 1 }, timeoutMs: 1000, ...overrides,
})
const slash = (value: string) => value.replaceAll('\\', '/')

it('绑定物化输入、输出和前置检查，不启动工具', () => {
  const plan = prepareAcceptanceExecution(check(), prepared)
  expect({ ...plan, cwd: slash(plan.cwd), argv: plan.argv.map(slash), resultPath: slash(plan.resultPath) }).toEqual({
    schemaVersion: 1, checkId: 'contract', tool: 'pwsh',
    cwd: 'O:/input/source/module',
    argv: ['pwsh', '-File', 'O:/input/source/scripts/check.ps1', 'O:/input/output/input.xml'],
    resultPath: 'O:/input/output/Reports/result.xml', prerequisites: ['build'],
    materializationId: prepared.materializationId, outputRootBound: true,
    executionAttempted: false, executionAuthorized: false, publishAllowed: false,
  })
})

it('配方路径未物化时拒绝，不把活动目录作为退化输入', () => {
  expect(() => prepareAcceptanceExecution(check({ command: { ...check().command, cwd: { root: 'recipe', path: '.' } } }), prepared))
    .toThrow('配方目录尚未进入受控输入')
})

it('路径越过固定根时拒绝', () => {
  expect(() => prepareAcceptanceExecution(check({ result: { ...check().result, path: '../outside.xml' } }), prepared))
    .toThrow('检查引用必须是安全的相对路径')
})
