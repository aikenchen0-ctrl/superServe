import { useEffect, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { Button, DisclosureRow, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint } from './widgets.tsx'

type Workspace = ApiResponse<'GET development/workspaces'>['items'][number]
type Execution = ApiResponse<'GET development/workspaces/:id/execution'>['execution']
function ExecutionObservation({ workspace }: { workspace: Workspace }) {
  const { call, t } = usePanel()
  const [read, setRead] = useState<{ state: 'loading' } | { state: 'failed'; message: string }
    | { state: 'ready'; value: Execution }>({ state: 'loading' })
  const [generation, refresh] = useState(0)
  useEffect(() => {
    let current = true
    setRead({ state: 'loading' })
    call('GET development/workspaces/:id/execution', { id: workspace.workspaceId }).then(({ execution }) => {
      if (execution && (execution.workspaceId !== workspace.workspaceId || execution.operationId !== workspace.operationId
        || execution.generation !== workspace.generation))
        throw new Error(t('devExecution.changed'))
      if (execution?.targetResult && (execution.targetResultScope !== 'direct_child_only' || execution.validationPassed !== false
        || !['unobserved', 'not_started', 'exited'].includes(execution.targetResult.state)
        || (execution.targetResult.state === 'exited'
          && ((execution.targetResult.exitCode !== null) === (execution.targetResult.signal !== null)))))
        throw new Error(t('devExecution.unconfirmed'))
      if (current) setRead({ state: 'ready', value: execution })
    }).catch(error => { if (current) setRead({ state: 'failed', message: errorText(error) }) })
    return () => { current = false }
  }, [workspace, generation, call, t])
  return <div className="dt-acceptance">
    {read.state === 'loading' ? <Hint>{t('loading')}</Hint>
      : read.state === 'failed' ? <p role="alert" className="dt-error">{read.message}</p>
        : !read.value ? <Hint>{t('devExecution.noExecution')}</Hint>
          : <>
            <p>{t(read.value.targetResult?.state === 'exited' ? 'devExecution.targetExited'
              : read.value.targetResult?.state === 'not_started' ? 'devExecution.notStarted' : 'devExecution.unknown')}</p>
            {read.value.targetResult?.state === 'exited' && <p>{t('devExecution.result', {
              code: read.value.targetResult.exitCode ?? '—', signal: read.value.targetResult.signal ?? '—',
            })}</p>}
            <Hint>{t('devExecution.scope')}</Hint>
            <p>{t(read.value.workspaceReleaseAllowed ? 'devExecution.released' : 'devExecution.retained')}</p>
            {read.value.outcome?.kind === 'exited' && <details><summary>{t('devExecution.provider')}</summary>
              <p>{read.value.outcomeScope} · {t('devExecution.result', {
                code: read.value.outcome.exitCode ?? '—', signal: read.value.outcome.signal ?? '—',
              })}</p>
            </details>}
          </>}
    <Button size="sm" variant="ghost" icon={<Icon name="refresh" size={14} />}
      disabled={read.state === 'loading'} onClick={() => refresh(value => value + 1)}>{t('devExecution.refresh')}</Button>
  </div>
}
function WorkspacePage({ offset, page }: { offset: number; page: (offset: number) => void }) {
  const { call, t } = usePanel()
  const [read, setRead] = useState<{ state: 'loading' } | { state: 'failed'; message: string }
    | { state: 'ready'; value: ApiResponse<'GET development/workspaces'> }>({ state: 'loading' })
  const [selected, select] = useState<string>()
  const [generation, refresh] = useState(0)
  useEffect(() => {
    let current = true
    setRead({ state: 'loading' }); select(undefined)
    call('GET development/workspaces', { query: { offset, limit: 8 } })
      .then(value => { if (current) setRead({ state: 'ready', value }) },
        error => { if (current) setRead({ state: 'failed', message: errorText(error) }) })
    return () => { current = false }
  }, [offset, generation, call])
  return <div className="dt-disclosure-body">
    {read.state === 'loading' ? <Hint>{t('loading')}</Hint>
      : read.state === 'failed' ? <p role="alert" className="dt-error">{read.message}</p>
        : !read.value.items.length ? <Hint>{t('devExecution.empty')}</Hint>
          : <ul className="dt-list">{read.value.items.map(workspace => <li key={workspace.workspaceId}>
            <p><code className="dt-quality-commit">{workspace.path}</code></p>
            <DisclosureRow title={`${workspace.owner} · ${workspace.generation}`} icon={<Icon name="review" size={14} />}
              open={selected === workspace.workspaceId}
              onToggle={() => select(previous => previous === workspace.workspaceId ? undefined : workspace.workspaceId)}>
              {selected === workspace.workspaceId && <ExecutionObservation workspace={workspace} />}
            </DisclosureRow>
          </li>)}</ul>}
    <div className="dt-actions">
      <Button size="sm" variant="ghost" icon={<Icon name="refresh" size={14} />} disabled={read.state === 'loading'}
        onClick={() => refresh(value => value + 1)}>{t('devExecution.refresh')}</Button>
      {offset > 0 && <Button size="sm" icon={<Icon name="chevron-left" size={14} />}
        disabled={read.state === 'loading'} onClick={() => page(Math.max(0, offset - 8))}>{t('task.quality.previous')}</Button>}
      {read.state === 'ready' && read.value.nextOffset !== null
        && <Button size="sm" icon={<Icon name="chevron-right" size={14} />}
          onClick={() => page(read.value.nextOffset!)}>{t('task.quality.next')}</Button>}
    </div>
  </div>
}
/** 原执行页的按需只读观测，不增加轮询、命令输入或目录释放动作。 */
export function DevelopmentExecutionObservations() {
  const { t } = usePanel()
  const [open, setOpen] = useState(false), [offset, page] = useState(0)
  return <DisclosureRow title={t('devExecution.title')} icon={<Icon name="review" size={14} />} open={open}
    onToggle={() => { setOpen(value => !value); page(0) }}>
    {open && <WorkspacePage key={offset} offset={offset} page={page} />}
  </DisclosureRow>
}
