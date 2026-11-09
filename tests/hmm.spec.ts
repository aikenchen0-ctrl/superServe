import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { HMM_LIMITS, type HmmActor, type HmmCommand, type PlanInput } from '../src/hmm/model.ts'
import { HmmWorkflows } from '../src/hmm/workflow.ts'
import { HMM_KEYS } from '../src/hmm/keys.ts'
import { KV } from '../src/kv.ts'

const controller: HmmActor = { role: 'controller' }
const worker: HmmActor = { role: 'worker', ticketId: 't1' }
const plan = (): PlanInput => ({
  goal: '比较可行路径并生成有依据的结论',
  nodes: [
    { id: 'root', title: '总体计划', mode: 'parallel' },
    { id: 'a', parentId: 'root', title: '路径甲', instruction: '独立核对条件甲' },
    { id: 'b', parentId: 'root', title: '路径乙', instruction: '独立核对条件乙' },
    { id: 'c', parentId: 'root', title: '核验甲', instruction: '根据甲的结果核验', dependsOn: ['a'] },
  ],
})
const ticket = (id: string): Ticket => ({
  id, title: id, decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' }, actor: { source: 'test', id: 'owner' }, scope: 'test' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'e1', triggerIds: ['e1'] },
})
let directory: string, store: Store, service: HmmWorkflows
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superserve-hmm-'))
  store = new Store(join(directory, 'state.sqlite'))
  store.tickets.save(ticket('t1')); store.tickets.save(ticket('t2'))
  service = new HmmWorkflows(store)
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
const read = () => service.view(controller, 't1')
const apply = (command: HmmCommand, actor: HmmActor = controller) => service.apply(actor, 't1', read().revision, command)
const inputRef = (nodeId: string) => service.context(controller, 't1', nodeId).inputRef!
const resultRef = (nodeId: string) => service.context(controller, 't1', nodeId).resultRef!
const complete = (nodeId: string, summary = `${nodeId} 已核验`) => {
  const { lease } = apply({ action: 'start', nodeId })
  return apply({ action: 'complete', nodeId, lease: lease!, summary, evidenceRefs: [inputRef(nodeId)] })
}

it('目标启动复用总管权限与事务，派发失败时不留下半启动计划', () => {
  expect(() => service.run(worker, 't1', { goal: '无权创建' })).toThrow('总管')
  const broken = new HmmWorkflows(store, undefined, { dispatched: () => { throw new Error('派发通知失败') } })
  expect(() => broken.run(controller, 't1', { goal: '创建后派发' })).toThrow('派发通知失败')
  expect(store.get(KV.hmm.workflow('t1'))).toBeUndefined()
  store.saveSettings({ ...store.settings(), paused: true })
  expect(() => service.run(controller, 't1', { goal: '暂停时禁止启动' })).toThrow('暂停')
  expect(store.get(KV.hmm.workflow('t1'))).toBeUndefined()
})

it('显式依赖必须完成，兄弟工作帧和未发布结果不进入其他分支上下文', () => {
  service.create(controller, 't1', plan())
  expect(read().runnable).toEqual(['a', 'b'])
  expect(() => apply({ action: 'start', nodeId: 'c' })).toThrow('未就绪')
  const skeleton = service.context(worker, 't1', 'b').skeleton
  const { lease } = apply({ action: 'start', nodeId: 'a' }, worker)
  apply({ action: 'checkpoint', nodeId: 'a', lease: lease!, frame: 'A_PRIVATE_FRAME' }, worker)
  expect(JSON.stringify(service.context(worker, 't1', 'b'))).not.toContain('A_PRIVATE_FRAME')
  apply({ action: 'complete', nodeId: 'a', lease: lease!, summary: 'A_RESULT', evidenceRefs: [inputRef('a')] }, worker)
  expect(JSON.stringify(service.context(worker, 't1', 'b'))).not.toContain('A_RESULT')
  expect(service.context(worker, 't1', 'c').dependencies).toEqual([{ nodeId: 'a', result: { summary: 'A_RESULT', evidenceRefs: [inputRef('a')] } }])
  apply({ action: 'publish', nodeId: 'a' })
  expect(service.context(worker, 't1', 'b').blackboard[0]?.result?.summary).toBe('A_RESULT')
  expect(service.context(worker, 't1', 'b').skeleton).toBe(skeleton)
  expect(store.get(KV.hmm.workflow('t1'))?.nodes.find(node => node.id === 'a')?.frame).toBe('')
})

it('串行分组和嵌套并行分组共同决定就绪节点', () => {
  service.create(controller, 't1', {
    goal: '先建模再探索再核验',
    nodes: [
      { id: 'root', mode: 'serial', title: '主线' },
      { id: 'model', parentId: 'root', title: '建模', instruction: '确定约束' },
      { id: 'explore', parentId: 'root', mode: 'parallel', title: '探索' },
      { id: 'x', parentId: 'explore', title: '甲', instruction: '探索甲' },
      { id: 'y', parentId: 'explore', title: '乙', instruction: '探索乙' },
      { id: 'verify', parentId: 'root', title: '核验', instruction: '检验结果', dependsOn: ['explore'] },
    ],
  })
  expect(read().runnable).toEqual(['model'])
  complete('model')
  expect(read().runnable).toEqual(['x', 'y'])
  complete('x')
  expect(read().runnable).toEqual(['y'])
  complete('y')
  expect(read().runnable).toEqual(['verify'])
  expect(service.context(worker, 't1', 'verify').dependencies).toEqual([{
    nodeId: 'explore', results: [
      { nodeId: 'x', result: { summary: 'x 已核验', evidenceRefs: [inputRef('x')] } },
      { nodeId: 'y', result: { summary: 'y 已核验', evidenceRefs: [inputRef('y')] } },
    ],
  }])
})

it('完全剪枝的分组不能满足下游显式依赖', () => {
  service.create(controller, 't1', {
    goal: '核验分组依赖',
    nodes: [
      { id: 'root', mode: 'serial', title: '主线' },
      { id: 'explore', parentId: 'root', mode: 'parallel', title: '探索' },
      { id: 'x', parentId: 'explore', title: '候选', instruction: '探索候选' },
      { id: 'verify', parentId: 'root', title: '核验', instruction: '核验输出', dependsOn: ['explore'] },
    ],
  })
  apply({ action: 'prune', nodeId: 'x', reason: '不可行', reconsiderWhen: '新增资源' })
  expect(read().nodes.find(node => node.id === 'explore')?.state).toBe('pruned')
  expect(read().nodes.find(node => node.id === 'verify')).toMatchObject({ state: 'pending', attempt: 0, blockedBy: ['explore'] })
  expect(read().referenceIntegrity).toBe('valid')
  expect(read().runnable).toEqual([])
  expect(() => apply({ action: 'start', nodeId: 'verify' })).toThrow('未就绪')
})

it('部分剪枝不让整个分组失效，仍等待剩余分支产出后满足显式依赖', () => {
  service.create(controller, 't1', {
    goal: '核验剩余分支',
    nodes: [
      { id: 'root', mode: 'serial', title: '主线' },
      { id: 'explore', parentId: 'root', mode: 'parallel', title: '探索' },
      { id: 'x', parentId: 'explore', title: '候选甲', instruction: '探索甲' },
      { id: 'y', parentId: 'explore', title: '候选乙', instruction: '探索乙' },
      { id: 'verify', parentId: 'root', title: '核验', instruction: '核验输出', dependsOn: ['explore'] },
    ],
  })
  apply({ action: 'prune', nodeId: 'x', reason: '不可行', reconsiderWhen: '新增资源' })
  expect(read().nodes.find(node => node.id === 'verify')).not.toHaveProperty('blockedBy')
  expect(read().runnable).toEqual(['y'])
  complete('y')
  expect(read().nodes.find(node => node.id === 'explore')?.state).toBe('completed')
  expect(read().nodes.find(node => node.id === 'verify')).not.toHaveProperty('blockedBy')
  expect(read().runnable).toEqual(['verify'])
})

it('嵌套分组挂起后只恢复未完成后代，兄弟分支维持原状态', () => {
  service.create(controller, 't1', {
    goal: '测试分组控制',
    nodes: [
      { id: 'root', mode: 'parallel', title: '主线' },
      { id: 'group', parentId: 'root', mode: 'parallel', title: '分组' },
      { id: 'x', parentId: 'group', title: '已完成项', instruction: '完成甲' },
      { id: 'y', parentId: 'group', title: '在途项', instruction: '完成乙' },
      { id: 'other', parentId: 'root', title: '外部兄弟', instruction: '独立任务' },
    ],
  })
  complete('x')
  const { lease } = apply({ action: 'start', nodeId: 'y' })
  apply({ action: 'start', nodeId: 'other' })
  apply({ action: 'suspend', nodeId: 'group', reason: '等待资源' })
  expect(read().nodes.find(node => node.id === 'other')?.state).toBe('running')
  apply({ action: 'resume', nodeId: 'group' })
  expect(read().nodes.find(node => node.id === 'x')?.state).toBe('completed')
  expect(read().runnable).toContain('y')
  expect(() => apply({ action: 'complete', nodeId: 'y', lease: lease!, summary: '旧执行', evidenceRefs: ['x'] })).toThrow('失效')
})

it('同版本并发写只允许一次成功，过期写入不产生部分修改', () => {
  service.create(controller, 't1', plan())
  const revision = read().revision
  service.apply(worker, 't1', revision, { action: 'start', nodeId: 'a' })
  const after = store.get(KV.hmm.workflow('t1'))
  expect(() => service.apply(worker, 't1', revision, { action: 'start', nodeId: 'b' })).toThrow('已更新')
  expect(store.get(KV.hmm.workflow('t1'))).toEqual(after)
})

it('活跃上限限制开始执行，不限制待办数量', () => {
  service.create(controller, 't1', { ...plan(), maxActive: 1 })
  apply({ action: 'start', nodeId: 'a' })
  expect(() => apply({ action: 'start', nodeId: 'b' })).toThrow('上限')
  apply({ action: 'suspend', nodeId: 'a', reason: '待补充证据' })
  expect(apply({ action: 'start', nodeId: 'b' }).lease).toBeTruthy()
})

it('剪枝替换当前记忆和结果，保留原因，兄弟不受影响且迟到结果被拒绝', () => {
  service.create(controller, 't1', plan())
  const a = apply({ action: 'start', nodeId: 'a' })
  apply({ action: 'checkpoint', nodeId: 'a', lease: a.lease!, frame: 'OLD_EXPLORATION' })
  const b = apply({ action: 'start', nodeId: 'b' })
  apply({ action: 'prune', nodeId: 'a', reason: '现有证据不支持甲', reconsiderWhen: '增加新证据后在后续计划重试' })
  expect(JSON.stringify(store.get(KV.hmm.workflow('t1')))).not.toContain('OLD_EXPLORATION')
  expect(service.context(worker, 't1', 'a')).toMatchObject({ state: 'pruned', frame: '', reason: '现有证据不支持甲' })
  expect(() => apply({ action: 'complete', nodeId: 'a', lease: a.lease!, summary: '迟到', evidenceRefs: ['x'] })).toThrow('失效')
  expect(() => apply({ action: 'start', nodeId: 'c' })).toThrow('未就绪')
  apply({ action: 'complete', nodeId: 'b', lease: b.lease!, summary: '乙成立', evidenceRefs: [inputRef('b')] })
  expect(read().nodes.find(node => node.id === 'b')?.state).toBe('completed')
})

it('SQLite 重开后挂起在途工作，保留检查点，旧凭据即使取到新版本也不能复用', () => {
  expect(KV.hmm).toBe(HMM_KEYS)
  expect(HMM_KEYS.workflow('t1')).toBe('hmm-workflow:t1')
  service.create(controller, 't1', plan())
  const { lease } = apply({ action: 'start', nodeId: 'a' })
  apply({ action: 'checkpoint', nodeId: 'a', lease: lease!, frame: 'CHECKPOINT' })
  const persisted = store.get('hmm-workflow:t1')
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  expect(store.keys(HMM_KEYS.workflow)).toEqual(['hmm-workflow:t1'])
  expect(store.get(HMM_KEYS.workflow('t1'))).toEqual(persisted)
  service = new HmmWorkflows(store)
  service.recover()
  expect(service.context(worker, 't1', 'a')).toMatchObject({ state: 'suspended', frame: 'CHECKPOINT' })
  const revision = read().revision
  service.recover()
  expect(read().revision).toBe(revision)
  apply({ action: 'resume', nodeId: 'a' })
  const next = apply({ action: 'start', nodeId: 'a' })
  expect(next.lease).not.toBe(lease)
  expect(() => apply({ action: 'checkpoint', nodeId: 'a', lease: lease!, frame: '迟到' })).toThrow('失效')
})

it('未完成和全部剪枝均不能验收；执行器不能替代总管发布或验收', () => {
  service.create(controller, 't1', plan())
  const validate: HmmCommand = { action: 'validate', summary: '验收完成', evidenceRefs: ['test:passed'] }
  expect(() => apply(validate)).toThrow('未完成')
  expect(() => apply(validate, worker)).toThrow('总管')
  expect(() => apply({ action: 'publish', nodeId: 'a' }, worker)).toThrow('总管')
  expect(() => service.assertReady('t1')).toThrow('尚未验收')
  complete('a'); complete('c')
  apply({ action: 'prune', nodeId: 'b', reason: '条件不成立', reconsiderWhen: '条件改变后' })
  apply({ ...validate, evidenceRefs: [resultRef('a'), resultRef('c')] })
  expect(() => service.assertReady('t1')).not.toThrow()
  expect(() => apply({ action: 'start', nodeId: 'a' })).toThrow('已验收')
  service.create(controller, 't2', plan())
  service.apply(controller, 't2', 1, { action: 'prune', nodeId: 'root', reason: '整体不可行', reconsiderWhen: '重新建模' })
  expect(() => service.apply(controller, 't2', 2, validate)).toThrow('所有任务')
})

it.each([false, true])('验收关闭调度且中断和重启不改写结果，自动执行=%s', automatic => {
  service.create(controller, 't1', plan())
  if (automatic) apply({ action: 'dispatch' })
  for (const id of ['b', 'a', 'c']) {
    if (automatic) {
      const binding = service.claim('t1', id)
      service.report(binding, { action: 'complete', summary: `${id} 已核验`, evidenceRefs: [inputRef(id)] })
    } else complete(id)
  }
  const receipt = apply({ action: 'validate', summary: '主线已核验', evidenceRefs: [resultRef('c')] })
  const snapshot = store.get(KV.hmm.workflow('t1'))
  expect(read()).toMatchObject({ phase: 'validated', autoRun: false, revision: receipt.revision })
  expect(service.dispatchable()).toEqual([])
  service.interrupt('t1')
  expect(store.get(KV.hmm.workflow('t1'))).toEqual(snapshot)
  store.close()
  store = new Store(join(directory, 'state.sqlite'))
  service = new HmmWorkflows(store)
  service.recover()
  expect(store.get(KV.hmm.workflow('t1'))).toEqual(snapshot)
  expect(() => service.assertReady('t1')).not.toThrow()
  apply({ action: 'recheck', nodeId: 'a', reason: '目标条件变化' })
  expect(read()).toMatchObject({ phase: 'active', autoRun: false, runnable: ['a'] })
  expect(() => service.assertReady('t1')).toThrow('尚未验收')
})

it('跨工单访问、暂停和已结束工单写入均被拒绝', () => {
  service.create(controller, 't1', plan())
  service.create(controller, 't2', plan())
  expect(() => service.view(worker, 't2')).toThrow('其他工单')
  expect(() => service.create(worker, 't2', plan())).toThrow('总管')
  store.saveSettings({ ...store.settings(), paused: true })
  expect(() => apply({ action: 'start', nodeId: 'a' })).toThrow('暂停')
  store.saveSettings({ ...store.settings(), paused: false })
  store.tickets.save({ ...ticket('t1'), ended: { at: '', by: 'human', outcome: 'stopped' } })
  expect(() => apply({ action: 'start', nodeId: 'a' })).toThrow('已结束')
})

it.each([
  ['编号重复', (p: PlanInput) => { p.nodes.push(p.nodes[1]!) }],
  ['父节点不存在', (p: PlanInput) => { p.nodes[1]!.parentId = 'missing' }],
  ['父节点循环', (p: PlanInput) => { p.nodes[1]!.mode = 'parallel'; p.nodes[1]!.parentId = 'b'; p.nodes[2]!.mode = 'parallel'; p.nodes[2]!.parentId = 'a' }],
  ['依赖循环', (p: PlanInput) => { p.nodes[1]!.dependsOn = ['b']; p.nodes[2]!.dependsOn = ['a'] }],
  ['串行逆向依赖', (p: PlanInput) => { p.nodes[0]!.mode = 'serial'; p.nodes[1]!.dependsOn = ['b'] }],
  ['跨层依赖', (p: PlanInput) => { p.nodes[1]!.dependsOn = ['root'] }],
  ['任务没有操作说明', (p: PlanInput) => { delete p.nodes[1]!.instruction }],
])('拒绝非法计划：%s，且不写入状态', (_name, change) => {
  const input = plan(); change(input)
  expect(() => service.create(controller, 't1', input)).toThrow()
  expect(store.get(KV.hmm.workflow('t1'))).toBeUndefined()
})

it('操作记录有界，超预算写入回滚，拒绝无穷追加历史', () => {
  service.create(controller, 't1', plan())
  const { lease } = apply({ action: 'start', nodeId: 'a' })
  for (let i = 0; i < HMM_LIMITS.history + 5; i++) apply({ action: 'checkpoint', nodeId: 'a', lease: lease!, frame: `step-${i}` })
  expect(store.get(KV.hmm.workflow('t1'))?.history).toHaveLength(HMM_LIMITS.history)
  const input = plan()
  input.nodes = [input.nodes[0]!, ...Array.from({ length: 63 }, (_, i) =>
    ({ id: `n${i}`, parentId: 'root', title: '大节点', instruction: '长'.repeat(4000) }))]
  expect(() => service.create(controller, 't2', input)).toThrow('存储预算')
  expect(store.get(KV.hmm.workflow('t2'))).toBeUndefined()
})

it('样例计划可走完整主线并交付待验收结果', () => {
  const sample = JSON.parse(readFileSync(new URL('../examples/hmm-plan.json', import.meta.url), 'utf8'))
  service.create(controller, 't1', sample)
  complete('clarify'); complete('model')
  expect(read().runnable).toEqual(['local', 'cache'])
  complete('local'); complete('cache'); complete('evaluate')
  expect(read().awaitingValidation).toBe(true)
  expect(() => service.assertReady('t1')).toThrow('尚未验收')
})

it('通知持久化失败时，节点完成与版本变化一并回滚', () => {
  service = new HmmWorkflows(store, () => '2026-11-02T00:00:00.000Z', { review: () => { throw new Error('queue unavailable') } })
  service.create(controller, 't1', { goal: '验证事务', nodes: [
    { id: 'root', mode: 'serial', title: '根' },
    { id: 'check', parentId: 'root', title: '检查', instruction: '检查结果' },
  ] })
  const started = apply({ action: 'start', nodeId: 'check' })
  const before = store.get(KV.hmm.workflow('t1'))
  expect(() => apply({ action: 'complete', nodeId: 'check', lease: started.lease!, summary: '完成', evidenceRefs: [inputRef('check')] }))
    .toThrow('queue unavailable')
  expect(store.get(KV.hmm.workflow('t1'))).toEqual(before)
})

it('领域层拒绝缺少必填参数或夹带无关参数的命令', () => {
  service.create(controller, 't1', plan())
  const before = store.get(KV.hmm.workflow('t1'))
  expect(() => service.apply(worker, 't1', 1, { action: 'start', nodeId: 'a', frame: '不能越过检查点写入' })).toThrow()
  expect(() => service.apply(worker, 't1', 1, { action: 'complete', nodeId: 'a', summary: '没有凭据' })).toThrow()
  expect(store.get(KV.hmm.workflow('t1'))).toEqual(before)
})

it('独立节点的宿主绑定不能读取或报告兄弟节点，执行次数不能无限增长', () => {
  service.create(controller, 't1', plan())
  apply({ action: 'dispatch' })
  for (let attempt = 0; attempt < HMM_LIMITS.attempts; attempt++) {
    const binding = service.claim('t1', 'a')
    expect(() => service.context({ role: 'node', ...binding }, 't1', 'b')).toThrow('兄弟')
    expect(() => service.view({ role: 'node', ...binding }, 't1')).toThrow('自己')
    expect(() => service.apply({ role: 'node', ...binding }, 't1', read().revision,
      { action: 'suspend', nodeId: 'b', reason: '越界' })).toThrow('其他节点')
    service.report(binding, { action: 'suspend', reason: '缺少证据' })
    if (attempt + 1 < HMM_LIMITS.attempts) apply({ action: 'resume', nodeId: 'a' })
  }
  expect(() => apply({ action: 'resume', nodeId: 'a' })).toThrow('次数')
  expect(() => service.claim('t1', 'a')).toThrow()
})

it('快照接近用户预算时宿主仍能撤销全部在途节点并保留工作帧', () => {
  service.create(controller, 't1', {
    goal: '检查存储与停止边界', maxActive: 8,
    nodes: [{ id: 'root', mode: 'parallel', title: '主线' }, ...Array.from({ length: 8 }, (_, i) =>
      ({ id: `n${i}`, parentId: 'root', title: '独立任务', instruction: '完成分配任务' }))],
  })
  apply({ action: 'dispatch' })
  const bindings = Array.from({ length: 8 }, (_, i) => service.claim('t1', `n${i}`))
  const snapshot = store.get(KV.hmm.workflow('t1'))!
  snapshot.nodes[1]!.frame = '检查点'
  snapshot.skeleton += 'x'.repeat(HMM_LIMITS.bytes - 4096 - Buffer.byteLength(JSON.stringify(snapshot)))
  store.set(KV.hmm.workflow('t1'), snapshot)
  for (const binding of bindings) service.suspendRun(binding, '停止'.repeat(40))
  expect(read().nodes.filter(node => node.mode === 'task').every(node => node.state === 'suspended')).toBe(true)
  expect(service.context(controller, 't1', 'n0').frame).toBe('检查点')
  expect(Buffer.byteLength(JSON.stringify(store.get(KV.hmm.workflow('t1'))))).toBeLessThanOrEqual(HMM_LIMITS.bytes)
  const revision = read().revision
  service.suspendRun(bindings[0]!, '重复取消')
  expect(read().revision).toBe(revision)
})
