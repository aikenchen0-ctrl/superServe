import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HmmDispatcher } from '../src/hmm/dispatcher.ts'
import { HmmDevices } from '../src/hmm/devices.ts'
import type { HmmBinding } from '../src/hmm/model.ts'
import type { HmmNodeRuntime, HmmNodeStart } from '../src/hmm/node-runtime.ts'
import { HmmWorkflows } from '../src/hmm/workflow.ts'
import { HealthBoard } from '../src/infra/health.ts'

const fixture = fileURLToPath(new URL('./fixtures/hmm-crash.ts', import.meta.url))
const actor = { role: 'controller' as const }, ticketId = 'crash-boundary'
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superserve-crash-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it.each(['before-commit', 'after-commit', 'after-validation'] as const)(
  '独立进程在 %s 直接退出后，从持久状态恢复而不重放旧执行',
  async point => {
    const path = join(directory, 'state.sqlite')
    const child = await new Promise<{ code: number | string | null | undefined; signal: string | null | undefined; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['--experimental-transform-types', fixture, path, point],
        { timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => resolve({ code: error?.code, signal: error?.signal, stdout, stderr }))
    })
    expect(child.code, child.stderr).toBe(73)
    expect(child.signal).toBeFalsy()
    const receipt = JSON.parse(child.stdout) as { point: string; binding: HmmBinding }
    expect(receipt.point).toBe(point)
    expect(receipt.binding).toMatchObject({ ticketId, nodeId: 'solve' })
    const store = new Store(path), lifetime = new AbortController()
    const effects = new Effects(store, new HealthBoard())
    let dispatcher: HmmDispatcher | undefined
    const requests: HmmNodeStart[] = [], reviews: string[] = []
    const runtime: HmmNodeRuntime = {
      install: () => () => {},
      start: vi.fn(async request => {
        request.authorize()
        requests.push(request)
        request.onDelivered()
        return { cancel: vi.fn(), finish: async () => {}, dispose: async () => {} }
      }),
    }
    const hmm = new HmmWorkflows(store, undefined, {
      changed: () => dispatcher?.request(),
      recoveryRequired: (ticketId, revision) => effects.enqueue('relay', `hmm-recovery:${ticketId}:${revision}`, {
        text: JSON.stringify({ kind: 'hmm_attention', reasonCode: 'host_interrupted', ticket_id: ticketId, revision }),
      }),
    })
    const view = () => hmm.view(actor, ticketId)
    const command = (action: 'resume' | 'dispatch') => hmm.apply(actor, ticketId, view().revision,
      action === 'resume' ? { action, nodeId: 'solve' } : { action })
    try {
      const before = view(), original = before.nodes.find(node => node.id === 'solve')!
      expect(before.autoRun).toBe(point !== 'after-validation')
      expect(original).toMatchObject({ state: point === 'before-commit' ? 'running' : 'completed', attempt: 1,
        sessionId: receipt.binding.sessionId })
      expect(!!original.resultRef).toBe(point !== 'before-commit')
      expect(hmm.context(actor, ticketId, 'solve').frame).toBe(point === 'before-commit' ? 'DURABLE_CHECKPOINT' : '')
      // 消费退出前持久化的协调请求，验证恢复闸门而不只检查状态字段。
      expect(effects.pending('hmmDispatch')).toBe(true)
      expect(effects.pending('hmmDispatch', `launch:${receipt.binding.sessionId}`)).toBe(true)
      expect(effects.pending('hmmDispatch', `retire:${receipt.binding.sessionId}`)).toBe(point !== 'before-commit')
      hmm.recover()
      const recovered = view()
      expect(recovered.autoRun).toBe(false)
      expect(hmm.current(receipt.binding)).toBe(false)
      hmm.recover()
      expect(view()).toEqual(recovered)
      effects.handle('relay', async ({ text }) => { reviews.push(text) })
      dispatcher = new HmmDispatcher({ nodeRuntime: runtime, store, effects, hmm,
        hmmDevices: new HmmDevices(hmm, lifetime.signal), lifetime: lifetime.signal,
        paused: () => false, closing: () => false, workerCount: () => 0 })
      dispatcher.install()
      effects.start()
      await effects.idle()
      expect(runtime.start).not.toHaveBeenCalled()
      expect(dispatcher.activeCount()).toBe(0)
      expect(effects.pending('hmmDispatch')).toBe(false)
      expect(reviews).toHaveLength(1)
      expect(JSON.parse(reviews[0]!)).toMatchObject(point === 'before-commit'
        ? { kind: 'hmm_attention', reasonCode: 'host_interrupted', ticket_id: ticketId, revision: recovered.revision }
        : { kind: 'hmm_review', ticket_id: ticketId })
      expect(() => hmm.report(receipt.binding, { action: 'checkpoint', frame: 'STALE_WRITE' })).toThrow('失效')
      expect(view()).toEqual(recovered)

      if (point === 'before-commit') {
        expect(recovered.nodes.find(node => node.id === 'solve')).toMatchObject({ state: 'suspended', attempt: 1 })
        expect(recovered.awaitingValidation).toBe(false)
        command('resume')
        await effects.idle()
        expect(runtime.start).not.toHaveBeenCalled()
        command('dispatch')
        await effects.idle()
        expect(runtime.start).toHaveBeenCalledOnce()
        expect(requests[0]!.binding.sessionId).not.toBe(receipt.binding.sessionId)
        expect(requests[0]!.binding.lease).not.toBe(receipt.binding.lease)
        expect(JSON.stringify(requests[0]!.input)).toContain('DURABLE_CHECKPOINT')
        expect(JSON.stringify(requests[0]!.input)).not.toContain('COMMITTED_RESULT')
        expect(view().nodes.find(node => node.id === 'solve')).toMatchObject({ state: 'running', attempt: 2 })
      } else {
        expect(recovered.nodes.find(node => node.id === 'solve')).toMatchObject({
          state: 'completed', attempt: 1, resultRef: original.resultRef, sessionId: original.sessionId,
        })
        expect(hmm.context(actor, ticketId, 'solve').result?.summary).toBe('COMMITTED_RESULT')
        if (point === 'after-commit') {
          expect(recovered.awaitingValidation).toBe(true)
          command('dispatch')
          await effects.idle()
          expect(runtime.start).not.toHaveBeenCalled()
          hmm.apply(actor, ticketId, view().revision, {
            action: 'validate', summary: '恢复后验收', evidenceRefs: [original.resultRef!],
          })
        } else {
          expect(recovered).toEqual(before)
        }
        expect(view().phase).toBe('validated')
        expect(() => hmm.assertReady(ticketId)).not.toThrow()
      }
    } finally {
      lifetime.abort()
      await dispatcher?.shutdown()
      await effects.drain()
      store.close()
    }
  }, 15_000,
)
