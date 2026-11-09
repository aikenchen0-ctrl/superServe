import { writeSync } from 'node:fs'
import { Store } from '../../src/app/store.ts'
import { Effects } from '../../src/app/effects.ts'
import type { Ticket } from '../../src/core/model.ts'
import { HmmWorkflows } from '../../src/hmm/workflow.ts'
import { HealthBoard } from '../../src/infra/health.ts'

const [path, point] = process.argv.slice(2)
if (!path || !['before-commit', 'after-commit', 'after-validation'].includes(point ?? ''))
  throw new Error('必须指定测试数据库和有效退出位置')

const store = new Store(path)
const effects = new Effects(store, new HealthBoard())
const actor = { role: 'controller' as const }, ticketId = 'crash-boundary'
const hmm = new HmmWorkflows(store, undefined, {
  changed: () => effects.enqueue('hmmDispatch', 'ready', {}),
  review: (ticketId, revision) => effects.enqueue('relay', `hmm-review:${ticketId}:${revision}`, {
    text: JSON.stringify({ kind: 'hmm_review', ticket_id: ticketId, revision }),
  }),
})
store.tickets.save({
  id: ticketId, title: '退出恢复边界', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'listed' },
    actor: { source: 'test', id: 'owner' }, scope: 'test' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'e1', triggerIds: ['e1'] },
} satisfies Ticket)
hmm.runPlan(actor, ticketId, {
  goal: '只读取给定输入并保存一个结果', maxActive: 1,
  nodes: [{ id: 'root', title: '主线', mode: 'serial' },
    { id: 'solve', parentId: 'root', title: '求解', instruction: 'Read the given inputs and publish a result.' }],
})
const binding = hmm.claim(ticketId, 'solve')
effects.enqueue('hmmDispatch', `launch:${binding.sessionId}`, { operation: 'launch', sessionId: binding.sessionId })
hmm.report(binding, { action: 'checkpoint', frame: 'DURABLE_CHECKPOINT' })
const { inputRef } = hmm.context({ role: 'node', ...binding }, ticketId, 'solve')

function exitWithoutCleanup(): never {
  // 同步输出仅作父进程验证；故意跳过 store.close 和所有宿主关停流程。
  writeSync(1, JSON.stringify({ point, binding }))
  process.exit(73)
}

store.atomic(() => {
  hmm.report(binding, { action: 'complete', summary: 'COMMITTED_RESULT', evidenceRefs: [inputRef!] })
  effects.enqueue('hmmDispatch', `retire:${binding.sessionId}`, { operation: 'retire', sessionId: binding.sessionId })
  if (point === 'before-commit') exitWithoutCleanup()
})
if (point === 'after-validation') {
  const workflow = hmm.view(actor, ticketId)
  const resultRef = workflow.nodes.find(node => node.id === 'solve')!.resultRef!
  hmm.apply(actor, ticketId, workflow.revision, { action: 'validate', summary: '已验收', evidenceRefs: [resultRef] })
}
exitWithoutCleanup()
