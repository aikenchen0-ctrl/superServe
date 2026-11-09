import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { HmmBaseline, SCENARIOS, CORPUS_VERSION, corpusHash, samples, type BaselineCase, type Scenario } from './fixtures/hmm-baseline.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const runs: BaselineCase[] = []
const repetitions = process.env.HMM_BASELINE_RUN_ID ? Number(process.env.HMM_BASELINE_SAMPLES ?? '3') : 1
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('基线采样次数必须为 1 至 5')

async function execute(scenario: Scenario, sample: number) {
  const host = await startRuntime()
  let baseline: HmmBaseline | undefined, completed = false
  try {
    const { ticket } = await host.acceptedTicket(feishu('1', '@bot compare the fixed device evidence'))
    baseline = new HmmBaseline(host, ticket.id)
    await baseline.start(scenario === 'offline-device')
    await baseline.extract('schedule', true)
    if (scenario === 'offline-device') {
      await expect(baseline.tool('message', 'hmm_device_query', { grantId: 'message', limit: 1 }))
        .rejects.toMatchObject({ code: 'device_offline' })
      baseline.check('离线错误没有触达设备端口', baseline.metrics.deviceQueryCalls === 1)
      await baseline.tool('message', 'hmm_node_report', { action: 'suspend', reason: 'Device offline; await reconnection.' })
      await baseline.settle()
      const view = baseline.view()
      baseline.check('缺失来源时暂停，不伪造成功结果', view.nodes.find(node => node.id === 'message')?.state === 'suspended'
        && view.nodes.find(node => node.id === 'decision')?.state === 'pending' && host.runtime.hmmDispatcher.activeCount() === 0)
      expect(() => host.runtime.hmm.assertReady(ticket.id)).toThrow()
    } else {
      await baseline.extract('message')
      await baseline.decide()
      expect(() => baseline!.command({ action: 'validate', summary: 'Premature acceptance',
        evidenceRefs: [baseline!.context('decision').resultRef!] })).toThrow()
      baseline.check('缺少断言复核时不能验收', baseline.view().phase === 'active')
      baseline.accept()
      if (scenario === 'revision-reuse') {
        const stable = baseline.context('message').resultRef!
        const previous = baseline.context('decision').resultRef!
        const definition = host.runtime.hmm.definition({ role: 'controller' }, ticket.id)
        definition.plan.nodes.find(node => node.id === 'schedule')!.instruction += ' Recheck the stated delivery date.'
        const input = { revision: definition.revision, plan: definition.plan, reason: 'Recheck one source while retaining independent work.' }
        const preview = host.runtime.hmm.revise({ role: 'controller' }, ticket.id, { ...input, preview: true })
        baseline.check('预览不改变当前状态', baseline.view().revision === definition.revision)
        const applied = host.runtime.hmm.revise({ role: 'controller' }, ticket.id, input)
        baseline.check('只重算来源及其消费者', JSON.stringify(applied.invalidated) === JSON.stringify(['schedule', 'decision'])
          && JSON.stringify(preview.invalidated) === JSON.stringify(applied.invalidated))
        baseline.check('独立成果仍保留原引用', baseline.context('message').resultRef === stable)
        baseline.sample()
        baseline.grant('schedule')
        baseline.command({ action: 'dispatch' })
        await baseline.settle()
        await baseline.extract('schedule', true)
        await baseline.decide()
        baseline.check('合并结果引用随重算更新', baseline.context('decision').resultRef !== previous)
        baseline.accept()
      } else if (scenario === 'revoked-source') {
        host.runtime.hmm.revokeDevice({ role: 'controller' }, ticket.id, baseline.view().revision, 'schedule')
        await baseline.settle()
        expect(() => host.runtime.hmm.assertReady(ticket.id)).toThrow()
        baseline.check('撤权后旧验收不能放行', baseline.view().referenceIntegrity === 'invalid')
        baseline.check('撤权清除当前来源正文', baseline.snapshot().evidence?.documents
          .filter(doc => doc.source?.grantId === 'schedule').every(doc => doc.revoked && doc.text === undefined) === true)
      }
    }
    const expected = scenario === 'revision-reuse' ? { sessions: 5, queries: 3, reads: 5 }
      : scenario === 'offline-device' ? { sessions: 2, queries: 1, reads: 2 } : { sessions: 3, queries: 2, reads: 3 }
    baseline.check('执行次数符合固定场景', host.nodeFactory.mock.calls.length === expected.sessions)
    baseline.check('查询与读取次数符合固定场景', baseline.metrics.deviceQueryCalls === expected.queries
      && baseline.metrics.deviceReadCalls === expected.reads)
    baseline.check('失败工具调用未触发隐式重试', baseline.metrics.nodeToolFailures === (scenario === 'offline-device' ? 1 : 0))
    completed = true
  } finally {
    try {
      if (baseline) {
        const result = baseline.finish(scenario, sample, completed)
        runs.push(result)
        if (completed) expect(result.checks.filter(check => !check.passed), '固定资源预算').toEqual([])
      }
    } finally { await host.stop() }
  }
}

for (const scenario of SCENARIOS)
  for (let sample = 1; sample <= repetitions; sample++)
    it(`固定设备基线 ${scenario} / ${sample}`, () => execute(scenario, sample))

afterAll(() => {
  // 专用命令才写报告；普通回归不覆盖上一次基线。失败时仍记录未完成场景。
  if (!process.env.HMM_BASELINE_RUN_ID) return
  const expectedRuns = SCENARIOS.length * repetitions
  writeFileSync(resolve('.artifacts/hmm-baseline.json'), JSON.stringify({
    schemaVersion: 1, runId: process.env.HMM_BASELINE_RUN_ID, corpusVersion: CORPUS_VERSION, corpusHash,
    repetitions, expectedRuns, passed: runs.length === expectedRuns && runs.every(run => run.passed),
    sourceCorpusUtf8Bytes: samples.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0),
    mode: 'scripted-host-and-device-ports',
    exclusions: ['真实模型语义质量与 token 数', '真实网络、TLS、压缩和指定香港通道',
      '单 Agent 内存与峰值内存', 'SQLite 历史页、日志与备份磁盘量', '生产环境延迟与手机能耗'],
    cases: runs,
  }, null, 2) + '\n', 'utf8')
})
