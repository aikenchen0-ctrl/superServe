import { expect, it } from 'vitest'
import { AcceptanceChecksSchema, acceptanceMapping, type AcceptanceCheck } from '../src/development/acceptance-checks.ts'

const check = (id = 'contract'): AcceptanceCheck => ({
  id, title: '契约黑盒检查', requirements: [{ scope: 'task', index: 0, text: '保持顺序' },
    { scope: 'module', index: 0, text: '保持身份' }], requires: [],
  command: { tool: 'pwsh', cwd: { root: 'source', path: '.' },
    argv: ['-File', { root: 'recipe', path: 'run.ps1' }, '-Target', { root: 'source', path: '.' }] },
  result: { format: 'junit-xml', path: 'contract.xml', minimumTests: 1 }, timeoutMs: 60_000,
})
it('没有检查时所有原始要求仍在，不能静默形成已覆盖', () => {
  const view = acceptanceMapping(['保持顺序'], ['保持身份'])
  expect(view.state).toBe('unconfigured')
  expect(view.requirements).toHaveLength(2)
  expect(view.requirements.every(item => item.checks.length === 0)).toBe(true)
})
it('一项检查可映射多项要求，多项检查可映射同一要求，仍非执行证明', () => {
  const checks = AcceptanceChecksSchema.parse([check(), check('second')])
  const view = acceptanceMapping(['保持顺序'], ['保持身份'], checks)
  expect(view.state).toBe('declared')
  expect(view.requirements.every(item => item.checks.length === 2)).toBe(true)
  expect(view).toMatchObject({ coverageVerified: false, executionAttempted: false })
})
it('要求原文或序号改变不能按相似文字或同一序号强行覆盖', () => {
  const view = acceptanceMapping(['保持新顺序', '保持顺序'], ['保持身份'], [check()])
  expect(view.state).toBe('incomplete')
  expect(view.unmatched).toEqual([{ checkId: 'contract', scope: 'task', index: 0, text: '保持顺序' }])
  expect(view.requirements.slice(0, 2).every(item => !item.checks.length)).toBe(true)
})
it('同文任务和模块要求仍有独立作用域', () => {
  const value = check()
  value.requirements = [{ scope: 'task', index: 0, text: '共同要求' }]
  const view = acceptanceMapping(['共同要求'], ['共同要求'], [value])
  expect(view.requirements[0]!.checks).toEqual(['contract'])
  expect(view.requirements[1]!.checks).toEqual([])
})
it('输入顺序不推断依赖；先执行显式前置检查', () => {
  const first = check('first'), last = { ...check('last'), requires: ['first'] }
  expect(acceptanceMapping(['保持顺序'], ['保持身份'], AcceptanceChecksSchema.parse([last, first])).executionOrder)
    .toEqual(['first', 'last'])
})
it.each(['missing', 'cycle', 'self', 'duplicate'])('%s 依赖不能形成可执行顺序', kind => {
  const first = check('first'), second = check('second')
  if (kind === 'missing') first.requires = ['absent']
  if (kind === 'cycle') { first.requires = ['second']; second.requires = ['first'] }
  if (kind === 'self') first.requires = ['first']
  if (kind === 'duplicate') second.id = first.id
  expect(AcceptanceChecksSchema.safeParse([first, second]).success).toBe(false)
})
it.each(['../outside', '/absolute', 'C:/host', '.git/config', 'a\\b', 'a//b'])('路径 %s 不能逃离声明根', path => {
  const value = check()
  value.command.argv = [{ root: 'recipe', path }]
  expect(AcceptanceChecksSchema.safeParse([value]).success).toBe(false)
})
it('合法空格、前导横线路径和零参数工具不能被样本限制误拒', () => {
  const value = check()
  value.command.argv = [{ root: 'recipe', path: '-checks/test entry.ps1' }]
  expect(AcceptanceChecksSchema.safeParse([value]).success).toBe(true)
  value.command.argv = []
  expect(AcceptanceChecksSchema.safeParse([value]).success).toBe(true)
})
it('结果必须有非零测试要求，不接受上传通过或跳过结果字段', () => {
  const value = check()
  expect(AcceptanceChecksSchema.safeParse([{ ...value, result: { ...value.result, minimumTests: 0 } }]).success).toBe(false)
  expect(AcceptanceChecksSchema.safeParse([{ ...value, result: { ...value.result, passed: true } }]).success).toBe(false)
})
it('不能省略工作目录或默认为宿主当前目录；外部位置不进入声明根', () => {
  const value = check()
  const { cwd: _, ...command } = value.command
  expect(AcceptanceChecksSchema.safeParse([{ ...value, command }]).success).toBe(false)
  expect(AcceptanceChecksSchema.safeParse([{ ...value, command: { ...value.command,
    cwd: { root: 'source', path: '../outside' } } }]).success).toBe(false)
})
it('没有需求引用的前置构建检查合法，但不凭命令存在补全任何要求', () => {
  const build = { ...check('build'), requirements: [] }
  const contract = { ...check(), requires: ['build'] }
  const view = acceptanceMapping(['保持顺序'], ['保持身份'], AcceptanceChecksSchema.parse([contract, build]))
  expect(view.state).toBe('declared')
  expect(view.executionOrder).toEqual(['build', 'contract'])
  expect(view.requirements.every(item => item.checks.join() === 'contract')).toBe(true)
})
it('增加新要求只增加未映射项，不删除原有正确映射', () => {
  const before = acceptanceMapping(['保持顺序'], ['保持身份'], [check()])
  const after = acceptanceMapping(['保持顺序', '新契约'], ['保持身份'], [check()])
  expect(after.requirements[0]).toEqual(before.requirements[0])
  expect(after.requirements[2]).toEqual(before.requirements[1])
  expect(after.requirements[1]).toMatchObject({ text: '新契约', checks: [] })
  expect(after.state).toBe('incomplete')
})
