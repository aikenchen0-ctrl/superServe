import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { Button, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint } from './widgets.tsx'
import type { AcceptanceCheck } from '../development/acceptance-checks.ts'

type Result = ApiResponse<'POST tasks/:id/quality/check-report'>
/** 优先读取受控输出根；旧目录输入仅保留为未认证补证，输入变化清除结果。 */
export function TaskCheckReport({ id, sourceCheckId, combinationId, basisDigest, revision, check }: {
  id: string; sourceCheckId: string; combinationId: string; basisDigest: string; revision: number; check: AcceptanceCheck
}) {
  const { t, call } = usePanel()
  const [state, setState] = useState<{ status: 'idle' } | { status: 'reading' } | { status: 'failed'; message: string }
    | { status: 'done'; value: Result }>({ status: 'idle' })
  const active = useRef(false), running = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const read = async () => {
    if (running.current) return
    running.current = true; setState({ status: 'reading' })
    try {
      const value = await call('POST tasks/:id/quality/check-report', { id, body: {
        sourceCheckId, basisDigest, revision, checkId: check.id,
      } })
      if (!active.current) return
      if (value.ticketId !== id || value.sourceCheckId !== sourceCheckId || value.basisDigest !== basisDigest
        || value.revision !== revision || value.checkId !== check.id || value.combinationId !== combinationId
        || value.artifact?.name !== check.result.path || value.persisted !== false
        || value.assurance.outputRootBound !== true
        || value.assurance.executionAuthenticated !== false || value.assurance.reportMatchesSource !== false
        || value.assurance.publishAllowed !== false
        || (value.report && (value.artifact.status !== 'read'
          || value.report.sha256 !== value.artifact.sha256 || value.report.bytes !== value.artifact.bytes
          || value.report.format !== check.result.format
          || !['content_consistent', 'failures_reported', 'incomplete', 'invalid'].includes(value.report.state)
          || value.report.assurance.executionAuthenticated !== false || value.report.assurance.publishAllowed !== false)))
        throw new Error(t('task.acceptance.unconfirmed'))
      setState({ status: 'done', value })
    } catch (error) { if (active.current) setState({ status: 'failed', message: errorText(error) }) }
    finally { running.current = false }
  }
  return <div className="dt-acceptance">
    <Button size="sm" variant="outline" icon={<Icon name="review" size={14} />}
      disabled={state.status === 'reading'} onClick={() => void read()}>{t('task.checkReport.inspect')}</Button>
    {state.status === 'failed' && <p role="alert" className="dt-error">{state.message}</p>}
    {state.status === 'done' && <div role="status">
      <p>{t(state.value.report ? `task.checkReport.${state.value.report.state}` : 'task.checkReport.unavailable')}</p>
      {state.value.report?.counts && <p>{t('task.checkReport.counts', { ...state.value.report.counts })}</p>}
      {state.value.report && state.value.report.issues.length > 0 && <p><code>{state.value.report.issues.join(', ')}</code></p>}
      <Hint>{t('task.checkReport.scope')}</Hint>
    </div>}
  </div>
}
