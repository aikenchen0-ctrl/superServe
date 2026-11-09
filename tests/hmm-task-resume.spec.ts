import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HMM_LIMITS, type HmmCommand } from '../src/hmm/model.ts'
import type { ApiResponse } from '../src/app/api.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const controller = { role: 'controller' as const }
beforeEach(async () => { h = await startRuntime(undefined, { mode: 'hmm' }) })
afterEach(async () => { await h.stop() })

async function task(selectedTitle = '选中步骤', extra = 0) {
  const extraIds = Array.from({ length: extra }, (_, index) => `extra_${index}`)
  const response = await h.api('POST', 'tasks', { requestId: 'resume-task', goal: '核对限定资料后再执行', dispatch: false,
    plan: { maxActive: 1, nodes: [
      { id: 'root', title: '主线', mode: 'parallel' },
      { id: 'selected', parentId: 'root', title: selectedTitle, instruction: '只核对已授权的资料' },
      { id: 'other', parentId: 'root', title: '其他步骤', instruction: '等待其他条件后再做' },
      ...extraIds.map(id => ({ id, parentId: 'root', title: `其他步骤 ${id}`, instruction: '独立核对对应来源' })),
      { id: 'review', parentId: 'root', title: '核验', instruction: '检查选中步骤的结果', dependsOn: ['selected'] },
    ] } })
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const id = response.body.ticketId as string
  const view = () => h.runtime.hmm.view(controller, id)
  const command = (command: HmmCommand) => h.runtime.hmm.apply(controller, id, view().revision, command)
  for (const nodeId of ['selected', 'other', ...extraIds])
    command({ action: 'suspend', nodeId, reason: '先检查对应条件，再由操作者继续' })
  await h.runtime.idle()
  const resume = (revision = view().revision, nodeId = 'selected') =>
    h.api('POST', `tasks/${id}/resume`, { revision, nodeId })
  const snapshot = () => h.runtime.store.get(KV.hmm.workflow(id))
  return { id, view, command, resume, snapshot }
}

it('一次请求恢复选中步骤并继续派发，其他挂起步骤、授权和原目标保持独立', async () => {
  const run = await task(), before = run.snapshot()!
  const blockers = ((await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>).workflow.blockers
  const response = await run.resume()
  const status = response.body as ApiResponse<'POST tasks/:id/resume'>
  expect(response).toMatchObject({ status: 200, body: { ticketId: run.id, workflow: { autoRun: true,
    blockers: { continuedFrom: blockers.snapshot, items: blockers.items.filter(item => item.nodeId !== 'selected') },
  } } })
  expect(response.body).not.toHaveProperty('nodes')
  expect(status.workflow.blockers.snapshot).not.toBe(blockers.snapshot)
  expect(((await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>).workflow.blockers).not.toHaveProperty('continuedFrom')
  expect(run.snapshot()).not.toHaveProperty('continuedFrom')
  await h.runtime.idle()
  expect(run.view().nodes.find(node => node.id === 'selected')).toMatchObject({ state: 'running', attempt: 1 })
  expect(run.view().nodes.find(node => node.id === 'other')).toMatchObject({ state: 'suspended', attempt: 0 })
  expect(run.view().nodes.find(node => node.id === 'review')).toMatchObject({ state: 'pending', attempt: 0 })
  expect(run.view().goal).toBe(before.goal)
  expect(run.snapshot()!.deviceGrants).toEqual(before.deviceGrants)
  expect(run.snapshot()!.evidence).toEqual(before.evidence)
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it.each(['reason', 'additional'] as const)('恢复事务中%s投影也发生变化时不证明旧挂起页可以延续', async change => {
  const run = await task('选中步骤', 6)
  const before = ((await h.api('GET', `tasks/${run.id}`)).body as ApiResponse<'GET tasks/:id'>).workflow.blockers
  const original = h.runtime.hmm.apply.bind(h.runtime.hmm)
  // 模拟同次派发还改变其他挂起项，验证延续判断不能只检查被恢复的编号。
  const injected = vi.spyOn(h.runtime.hmm, 'apply').mockImplementation((...args) => {
    const result = original(...args)
    if ((args[3] as HmmCommand).action === 'dispatch')
      original(controller, run.id, run.view().revision, { action: 'suspend',
        nodeId: change === 'reason' ? 'extra_5' : 'review', reason: '执行条件已变化，需要重新核对' })
    return result
  })
  try {
    const response = await run.resume()
    const status = response.body as ApiResponse<'POST tasks/:id/resume'>
    expect(response.status).toBe(200)
    expect(status.workflow.blockers).not.toHaveProperty('continuedFrom')
    expect(status.workflow.blockers.snapshot).not.toBe(before.snapshot)
    const tail = await h.api('GET', `tasks/${run.id}/blockers?revision=${status.workflow.revision}&offset=4&snapshot=${status.workflow.blockers.snapshot}`)
    expect(tail).toMatchObject({ status: 200, body: { items: expect.arrayContaining([expect.objectContaining({
      nodeId: change === 'reason' ? 'extra_5' : 'review', reason: '执行条件已变化，需要重新核对',
    })]) } })
  } finally { injected.mockRestore() }
})

it.each(['resume', 'stop'] as const)('%s原子回执可独立驱动任务详情，去除延续元数据后与当前查询一致', async action => {
  const run = await task()
  const receipt = action === 'resume'
    ? h.runtime.tasks.resume(run.id, { revision: run.view().revision, nodeId: 'selected' })
    : h.runtime.tasks.stop(run.id)
  const { continuedFrom: _continuedFrom, ...blockers } = receipt.workflow.blockers as ApiResponse<'POST tasks/:id/resume'>['workflow']['blockers']
  const status = { ...receipt, workflow: { ...receipt.workflow, blockers } }
  expect(status).toEqual(h.runtime.tasks.status(run.id))
  expect(status.workflow.progress.suspended).toBe(action === 'resume' ? 1 : 2)
  expect(status.ended?.outcome).toBe(action === 'stop' ? 'stopped' : undefined)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('旧版本、重复点击和跨重启重放不能重复启动；检查点随新实例恢复', async () => {
  const run = await task()
  const revision = run.view().revision
  const results = await Promise.all([run.resume(revision), run.resume(revision)])
  expect(results.map(result => result.status).sort()).toEqual([200, 409])
  await h.runtime.idle()
  const old = run.view().nodes.find(node => node.id === 'selected')!.sessionId!
  await h.runTool(old, 'hmm_node_report', { action: 'checkpoint', frame: '已完成部分核查，尚未执行外部动作' })
  run.command({ action: 'hold' })
  await h.runtime.idle()
  const before = run.snapshot()
  await h.restart()
  expect(await run.resume(revision)).toMatchObject({ status: 409, body: { code: 'revision_conflict' } })
  expect(run.snapshot()).toEqual(before)
  expect(h.nodeFactory).toHaveBeenCalledOnce()
  expect(await run.resume()).toMatchObject({ status: 200 })
  await h.runtime.idle()
  const fresh = run.view().nodes.find(node => node.id === 'selected')!.sessionId!
  expect(fresh).not.toBe(old)
  expect(await h.runTool(fresh, 'hmm_node_context', {})).toMatchObject({ frame: '已完成部分核查，尚未执行外部动作' })
  expect(h.nodeFactory).toHaveBeenCalledTimes(2)
})

it.each(['paused', 'stopped', 'pending', 'group', 'ancestor', 'missing', 'exhausted', 'manual'] as const)(
  '%s 条件拒绝恢复，不改变节点、派发状态或执行次数', async state => {
    const run = await task()
    if (state === 'paused') await h.api('POST', 'executor/pause', { paused: true })
    if (state === 'stopped') await h.api('POST', `tickets/${run.id}/stop`)
    if (state === 'pending') run.command({ action: 'resume', nodeId: 'selected' })
    if (state === 'group' || state === 'ancestor') run.command({ action: 'suspend', nodeId: 'root', reason: '整组等待' })
    if (state === 'exhausted') {
      const snapshot = run.snapshot()!
      snapshot.nodes.find(node => node.id === 'selected')!.attempt = HMM_LIMITS.attempts
      h.runtime.store.set(KV.hmm.workflow(run.id), snapshot)
    }
    if (state === 'manual') {
      run.command({ action: 'resume', nodeId: 'other' })
      run.command({ action: 'start', nodeId: 'other' })
    }
    await h.runtime.idle()
    const before = run.snapshot()
    const read = await h.api('GET', `tasks/${run.id}`)
    if (state === 'ancestor' || state === 'exhausted' || state === 'manual') {
      const code = state === 'ancestor' ? 'parent_suspended' : state === 'exhausted' ? 'attempts_exhausted' : 'manual_running'
      expect(read).toMatchObject({ status: 200, body: { workflow: { blockers: { items: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'selected', title: '选中步骤', resume: code }),
      ]) } } } })
      expect(run.snapshot()).toEqual(before)
    }
    const response = await run.resume(run.view().revision, state === 'group' ? 'root' : state === 'missing' ? 'absent' : 'selected')
    expect(response.status).toBe(state === 'group' ? 400 : state === 'missing' ? 404 : 409)
    if (state === 'ancestor') expect(response.body).toMatchObject({ code: 'parent_suspended' })
    if (state === 'exhausted') expect(response.body).toMatchObject({ code: 'attempts_exhausted' })
    if (state === 'manual') expect(response.body).toMatchObject({ code: 'manual_running' })
    await h.runtime.idle()
    expect(run.snapshot()).toEqual(before)
    expect(h.nodeFactory).not.toHaveBeenCalled()
  },
)

it('挂起摘要只返回有界名称和当前恢复条件，重复读取不派发且不改变计划', async () => {
  const title = '核'.repeat(46) + '\u{20000}' + '尾'.repeat(32)
  const run = await task(' \n' + title + '\t ')
  const before = run.snapshot()
  const first = await h.api('GET', `tasks/${run.id}`)
  expect(first).toMatchObject({ status: 200, body: { workflow: { blockers: { items: [
    { nodeId: 'selected', title: '核'.repeat(46) + '\u{20000}…', resume: 'available' },
    { nodeId: 'other', title: '其他步骤', resume: 'available' },
  ] } } } })
  expect(JSON.stringify(first.body)).not.toContain('只核对已授权的资料')
  expect(JSON.stringify(first.body)).not.toContain(title)
  expect(await h.api('GET', `tasks/${run.id}`)).toEqual(first)
  expect(run.snapshot()).toEqual(before)
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('手动步骤结束后重新投影恢复条件，选中挂起步骤可经原事务继续执行', async () => {
  const run = await task()
  run.command({ action: 'resume', nodeId: 'other' })
  const { lease } = run.command({ action: 'start', nodeId: 'other' })
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ body: {
    workflow: { blockers: { items: [{ nodeId: 'selected', resume: 'manual_running' }] } },
  } })
  expect(await run.resume()).toMatchObject({ status: 409, body: { code: 'manual_running' } })
  run.command({ action: 'complete', nodeId: 'other', lease: lease!, summary: '手动核查已结束',
    evidenceRefs: [h.runtime.hmm.context(controller, run.id, 'other').inputRef!] })
  expect(await h.api('GET', `tasks/${run.id}`)).toMatchObject({ body: {
    workflow: { blockers: { items: [{ nodeId: 'selected', resume: 'available' }] } },
  } })
  expect(await run.resume()).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(run.view().nodes.find(node => node.id === 'selected')).toMatchObject({ state: 'running', attempt: 1 })
  expect(run.view().nodes.find(node => node.id === 'other')).toMatchObject({ state: 'completed', attempt: 1 })
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it('派发阶段失败时一起回滚恢复和效果队列，修复后可用原版本重试', async () => {
  const run = await task(), before = run.snapshot()
  const original = h.runtime.hmm.apply.bind(h.runtime.hmm)
  const injected = vi.spyOn(h.runtime.hmm, 'apply').mockImplementation((...args) => {
    const result = original(...args)
    if ((args[3] as HmmCommand).action === 'dispatch') throw new Error('模拟派发提交失败')
    return result
  })
  expect(await run.resume()).toMatchObject({ status: 500 })
  injected.mockRestore()
  await h.runtime.idle()
  expect(run.snapshot()).toEqual(before)
  expect(h.runtime.effects.pending('hmmDispatch', 'ready')).toBe(false)
  expect(h.nodeFactory).not.toHaveBeenCalled()
  expect(await run.resume()).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(h.nodeFactory).toHaveBeenCalledOnce()
})

it('恢复不改变依赖和证据规则，必需来源已剪枝时不启动下游', async () => {
  const run = await task()
  run.command({ action: 'suspend', nodeId: 'review', reason: '等待来源核验' })
  run.command({ action: 'prune', nodeId: 'selected', reason: '来源不可用', reconsiderWhen: '存在替代依据时' })
  await h.runtime.idle()
  expect(await run.resume(run.view().revision, 'review')).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(run.view().nodes.find(node => node.id === 'review')).toMatchObject({ state: 'pending', attempt: 0, blockedBy: ['selected'] })
  expect(h.nodeFactory).not.toHaveBeenCalled()
})

it('入口严格限制本地工单及参数，不接受分组恢复、伪造身份或扩权', async () => {
  const run = await task(), before = run.snapshot()
  for (const body of [{}, { revision: 0, nodeId: 'selected' }, { revision: run.view().revision, nodeId: '../other' },
    { revision: run.view().revision, nodeId: 'selected', actor: 'scheduler' },
    { revision: run.view().revision, nodeId: 'selected', grants: ['all'] }])
    expect(await h.api('POST', `tasks/${run.id}/resume`, body)).toMatchObject({ status: 400 })
  expect(run.snapshot()).toEqual(before)
  expect(await h.api('POST', 'tasks/missing/resume', { revision: 1, nodeId: 'selected' }))
    .toMatchObject({ status: 404, body: { code: 'ticket_missing' } })
  await h.stop()
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('resume-scope', '@bot 检查仓库'))
  expect(await h.api('POST', `tasks/${ticket.id}/resume`, { revision: 1, nodeId: 'selected' }))
    .toMatchObject({ status: 403, body: { code: 'scope_denied' } })
})
