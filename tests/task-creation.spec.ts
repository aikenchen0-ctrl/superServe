// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { clearTaskCreation, readTaskCreation, saveTaskCreation, taskCreationKey, type TaskCreation } from '../src/client/task-creation.ts'

const scope = taskCreationKey('master', '/srv/state')
const submission: TaskCreation = { requestId: 'task-1', goal: 'Check authorized sources', title: 'Source check', mode: 'single' }
const stored = (value: unknown) => JSON.stringify({ version: 1, submission: value })
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear() })

it('只恢复白名单内的原始提交，不消费记录；再次确认和明确清理沿用同一身份', () => {
  expect(readTaskCreation(scope)).toEqual({ status: 'ready' })
  expect(saveTaskCreation(scope, submission)).toBe(true)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission })
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission })
  expect(saveTaskCreation(scope, submission)).toBe(true)
  expect(saveTaskCreation(scope, { ...submission, requestId: 'task-2' })).toBe(false)
  expect(saveTaskCreation(scope, { ...submission, goal: 'Other goal' })).toBe(false)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission })
  expect(clearTaskCreation(scope, submission)).toBe(true)
  expect(sessionStorage.getItem(scope)).toBeNull()
})

it('控制器和状态目录分别隔离，范围标识中的特殊字符不产生碰撞', () => {
  saveTaskCreation(scope, submission)
  for (const key of [taskCreationKey('other', '/srv/state'), taskCreationKey('master', '/srv/other'),
    taskCreationKey('master'), taskCreationKey('master,/srv', 'state')])
    expect(readTaskCreation(key)).toEqual({ status: 'ready' })
  expect(taskCreationKey('a/b', 'c')).not.toBe(taskCreationKey('a', 'b/c'))
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission })
})

it.each([
  null, [], { ...submission, requestId: '../task' }, { ...submission, requestId: 'x'.repeat(129) },
  { ...submission, goal: '' }, { ...submission, goal: ' padded ' }, { ...submission, goal: 'x'.repeat(2001) },
  { ...submission, title: null }, { ...submission, title: '' }, { ...submission, title: 'x'.repeat(161) },
  { ...submission, mode: 'custom' }, { ...submission, plan: { nodes: [] } },
  { ...submission, dispatch: false }, { ...submission, grants: ['all'] },
])('拒绝损坏、越界或带执行字段的提交，不清除原记录：%j', value => {
  const raw = stored(value)
  sessionStorage.setItem(scope, raw)
  expect(readTaskCreation(scope)).toEqual({ status: 'invalid', raw })
  expect(saveTaskCreation(scope, submission)).toBe(false)
  expect(clearTaskCreation(scope, submission)).toBe(false)
  expect(sessionStorage.getItem(scope)).toBe(raw)
})

it.each(['{', 'null', '[]', JSON.stringify({ version: 2, submission }),
  JSON.stringify({ version: 1, submission, dispatch: true }), 'x'.repeat(16_385)])(
  '拒绝不兼容的记录封装且不自动覆盖：%s', raw => {
    sessionStorage.setItem(scope, raw)
    expect(readTaskCreation(scope)).toEqual({ status: 'invalid', raw })
    expect(saveTaskCreation(scope, submission)).toBe(false)
  })

it('接受字段长度边界及转义内容，不以过小的序列化预算误拒合法目标', () => {
  const edge: TaskCreation = { requestId: 'a'.repeat(128), goal: `a${'\u0000'.repeat(1999)}`, title: 'x'.repeat(160), mode: 'multi' }
  expect(saveTaskCreation(scope, edge)).toBe(true)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission: edge })
})

it('存储不可读、写入失败或未真实保存均不能宣称已保存恢复身份', () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
  expect(readTaskCreation(scope)).toEqual({ status: 'unavailable' })
  expect(saveTaskCreation(scope, submission)).toBe(false)
  expect(clearTaskCreation(scope, submission)).toBe(false)
  get.mockRestore()
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
  expect(saveTaskCreation(scope, submission)).toBe(false)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready' })
  set.mockImplementation(() => {})
  expect(saveTaskCreation(scope, submission)).toBe(false)
})

it('清理失败保留原提交，迟到回执不能删除更新后的记录', () => {
  saveTaskCreation(scope, submission)
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage blocked') })
  expect(clearTaskCreation(scope, submission)).toBe(false)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission })
  remove.mockRestore()
  const next = { ...submission, requestId: 'task-2' }
  sessionStorage.setItem(scope, stored(next))
  expect(clearTaskCreation(scope, submission)).toBe(false)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission: next })
})

it('明确清除损坏记录也必须匹配当前内容，不能删除其后恢复的有效提交', () => {
  sessionStorage.setItem(scope, '{')
  expect(clearTaskCreation(scope, 'other')).toBe(false)
  expect(clearTaskCreation(scope, '{')).toBe(true)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready' })
  saveTaskCreation(scope, submission)
  expect(clearTaskCreation(scope, '{')).toBe(false)
  expect(readTaskCreation(scope)).toEqual({ status: 'ready', submission })
})
