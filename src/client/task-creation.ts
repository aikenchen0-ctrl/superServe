/** 任务创建的标签页恢复记录；只保存原提交，不保存执行权限或自动重放指令。 */
export type TaskMode = 'single' | 'multi'
export type TaskCreation = { requestId: string; goal: string; title?: string; mode: TaskMode }
export type PendingTaskCreation = ({ status: 'ready' } | { status: 'invalid'; raw: string } | { status: 'unavailable' })
  & { submission?: TaskCreation }

export const taskCreationKey = (masterId: string, stateDir?: string) =>
  `dsh-superagent/task-creation/${JSON.stringify([masterId, stateDir ?? null])}`
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && value === value.trim()
export const sameTaskCreation = (left: TaskCreation | undefined, right: TaskCreation | undefined): boolean =>
  left?.requestId === right?.requestId && left?.goal === right?.goal && left?.title === right?.title && left?.mode === right?.mode
const serialize = (submission: TaskCreation) => JSON.stringify({ version: 1, submission })

export function readTaskCreation(key: string): PendingTaskCreation {
  let raw: string | null
  try { raw = sessionStorage.getItem(key) } catch { return { status: 'unavailable' } }
  if (raw === null) return { status: 'ready' }
  try {
    // 长度覆盖字段转义后的上界；未知字段不能变成计划、派发参数或授权。
    if (raw.length > 16_384) return { status: 'invalid', raw }
    const saved: unknown = JSON.parse(raw)
    const value = record(saved) ? saved.submission : undefined
    if (!record(saved) || saved.version !== 1 || Object.keys(saved).some(name => !['version', 'submission'].includes(name))
      || !record(value) || Object.keys(value).some(name => !['requestId', 'goal', 'title', 'mode'].includes(name))
      || typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.requestId)
      || !text(value.goal, 2000) || (value.title !== undefined && !text(value.title, 160))
      || (value.mode !== 'single' && value.mode !== 'multi')) return { status: 'invalid', raw }
    return { status: 'ready', submission: { requestId: value.requestId, goal: value.goal,
      ...(value.title === undefined ? {} : { title: value.title }), mode: value.mode } }
  } catch { return { status: 'invalid', raw } }
}

/** 先确认恢复身份已保存，再允许发送；不覆盖另一份待确认提交。 */
export function saveTaskCreation(key: string, submission: TaskCreation): boolean {
  try {
    const current = readTaskCreation(key)
    if (current.status !== 'ready') return false
    if (current.submission) return sameTaskCreation(current.submission, submission)
    sessionStorage.setItem(key, serialize(submission))
    const saved = readTaskCreation(key)
    return saved.status === 'ready' && sameTaskCreation(saved.submission, submission)
  } catch { return false }
}

/** 迟到回执只能清理自己的记录；损坏记录须由用户明确清除且仍与所见原文一致。 */
export function clearTaskCreation(key: string, expected: TaskCreation | string): boolean {
  try {
    const current = readTaskCreation(key)
    if (current.status === 'ready' && !current.submission) return true
    const matches = typeof expected === 'string' ? current.status === 'invalid' && current.raw === expected
      : current.status === 'ready' && sameTaskCreation(current.submission, expected)
    if (!matches) return false
    sessionStorage.removeItem(key)
    return sessionStorage.getItem(key) === null
  } catch { return false }
}
