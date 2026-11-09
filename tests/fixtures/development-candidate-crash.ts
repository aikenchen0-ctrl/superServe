import { readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../../src/app/store.ts'
import { DevelopmentCandidates } from '../../src/development/candidates.ts'
import type { DevelopmentChanges } from '../../src/development/changes.ts'

const [directory, configPath] = process.argv.slice(2)
if (!directory || !configPath) throw new Error('必须提供测试状态目录和固定配置')
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  view: ReturnType<DevelopmentChanges['get']>; candidate: string; base: string
}
const store = new Store(join(directory, 'state.sqlite'))
const service = new DevelopmentCandidates(store, { get: () => structuredClone(config.view) }, {
  stateDir: directory, signal: new AbortController().signal, available: () => true,
})
const original = store.set.bind(store)
store.set = (key, value) => {
  original(key, value)
  const result = value as { phase?: string; id?: string; source?: { commit: string } }
  if (String(key).startsWith('development:combination:') && result.phase === 'prepared') {
    // ref 已成功，事务尚未提交；强制退出跳过 finally 和数据库正常关闭。
    writeSync(1, JSON.stringify({ id: result.id, commit: result.source?.commit }) + '\n')
    process.kill(process.pid, 'SIGKILL')
    throw new Error('崩溃注入未生效')
  }
}
const deadline = setTimeout(() => process.exit(74), 25_000)
try {
  const candidate = await service.register(config.view.change.ticketId, {
    changeRevision: config.view.change.revision, commit: config.candidate, declaredComplete: true,
  })
  await service.prepare({ baseCommit: config.base, candidates: [candidate.candidate.id] })
  throw new Error('未到达预期崩溃边界')
} finally { clearTimeout(deadline); await service.shutdown(); store.close() }
