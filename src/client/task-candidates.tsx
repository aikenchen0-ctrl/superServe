import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { ApiError } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint } from './widgets.tsx'

type Catalog = ApiResponse<'GET development/changes/:id/candidates'>
type Item = Catalog['items'][number]
type Receipt = ApiResponse<'POST development/combinations'>
type Query = { offset?: number; snapshot?: string }
type Operation = { status: 'idle' } | { status: 'running'; id: string }
  | { status: 'failed'; id: string; message: string }
  | { status: 'done'; id: string; receipt: Receipt }
const blocked = {
  candidate_unavailable: 'task.candidates.unready', basis_changed: 'task.candidates.changed',
  dependency_unavailable: 'task.candidates.dependency', dependency_limit: 'task.candidates.limit',
} as const

/** 候选操作只在工程区域展开后读取；沿用后台固定计划，不猜测最新分支或替用户扩大组合。 */
export function TaskCandidates({ id, onPrepared }: { id: string; onPrepared?: (receipt: Receipt | undefined) => void }) {
  const { t, call } = usePanel()
  const [read, setRead] = useState<{ generation: number; query: Query }>({ generation: 0, query: {} })
  const [state, setState] = useState<{ status: 'loading' } | { status: 'failed'; message: string }
    | { status: 'ready'; catalog: Catalog }>({ status: 'loading' })
  const [operation, setOperation] = useState<Operation>({ status: 'idle' })
  const visit = useRef<object>(), running = useRef(false), origin = useRef<HTMLElement>()
  const result = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const current = {}
    visit.current = current
    setState({ status: 'loading' }); setOperation({ status: 'idle' })
    call('GET development/changes/:id/candidates', { id, query: read.query }).then(catalog => {
      if (visit.current !== current) return
      if (catalog.ticketId !== id || !/^[a-f0-9]{64}$/.test(catalog.snapshot))
        throw new Error(t('task.candidates.unconfirmed'))
      setState({ status: 'ready', catalog })
    }).catch(failure => {
      if (visit.current === current) setState({ status: 'failed', message:
        failure instanceof ApiError && failure.status === 404 ? t('task.candidates.unavailable') : errorText(failure) })
    })
    return () => { if (visit.current === current) visit.current = undefined }
  }, [id, read, call, t])
  useEffect(() => {
    if (operation.status !== 'done' && operation.status !== 'failed') return
    if (origin.current && (document.activeElement === origin.current || document.activeElement === document.body))
      result.current?.focus({ preventScroll: true })
    origin.current = undefined
  }, [operation])
  const page = (query: Query) => {
    onPrepared?.(undefined)
    setRead(previous => ({ generation: previous.generation + 1, query }))
  }
  const prepare = async (item: Item, button: HTMLButtonElement) => {
    if (running.current || item.plan.state !== 'ready') return
    const current = visit.current, plan = item.plan
    running.current = true
    onPrepared?.(undefined)
    origin.current = document.activeElement === button ? button : undefined
    setOperation({ status: 'running', id: item.candidate.id })
    try {
      const receipt = await call('POST development/combinations', { body: plan.request })
      if (visit.current !== current) return
      const value = receipt.combination
      // 响应必须对应此次全部固定输入；迟到、串任务或形状异常的成功不能替换当前事实。
      if (!value || value.base.commit !== plan.request.baseCommit
        || value.base.repositoryId !== item.candidate.source.repositoryId
        || JSON.stringify(value.candidates) !== JSON.stringify(plan.request.candidates)
        || !['prepared', 'conflicted'].includes(value.phase)
        || receipt.publishAllowed !== false || receipt.validationRequired !== true
        || typeof receipt.basisChanged !== 'boolean'
        || (value.phase === 'prepared' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.source?.commit ?? '')))
        throw new Error(t('task.candidates.unconfirmed'))
      setOperation({ status: 'done', id: item.candidate.id, receipt })
      onPrepared?.(!receipt.basisChanged && value.phase === 'prepared' ? receipt : undefined)
    } catch (failure) {
      if (visit.current === current) setOperation({ status: 'failed', id: item.candidate.id, message: errorText(failure) })
    } finally { running.current = false }
  }
  const busy = operation.status === 'running'
  return <section className="dt-candidates" aria-label={t('task.candidates.title')}>
    <div className="dt-quality-head">
      <h3 className="dt-candidates-heading">{t('task.candidates.title')}</h3>
      <Button variant="ghost" size="sm" disabled={busy} aria-label={t('task.candidates.refresh')}
        title={t('task.candidates.refresh')} icon={<Icon name="refresh" size={14} />} onClick={() => page({})} />
    </div>
    {state.status === 'loading' ? <Hint>{t('loading')}</Hint>
      : state.status === 'failed' ? <p role="alert" className="dt-error">{state.message}</p>
        : <>
          {!state.catalog.items.length && <Hint>{t('task.candidates.empty')}</Hint>}
          <ul className="dt-list dt-quality-list">{state.catalog.items.map(item => {
            const plan = item.plan, own = operation.status !== 'idle' && operation.id === item.candidate.id
            const done = own && operation.status === 'done' ? operation.receipt : undefined
            return <li className="dt-quality-item" key={item.candidate.id}>
              <div className="dt-quality-head"><div className="dt-row-main">
                <div className="dt-row-title">{item.purpose}</div>
                <div className="dt-row-meta">{t('task.candidates.commit')} <code title={item.candidate.source.commit}>
                  {item.candidate.source.commit.slice(0, 12)}</code></div>
              </div></div>
              {plan.state === 'blocked' ? <Hint>{t(blocked[plan.reason])}</Hint> : <>
                <details className="dt-candidate-inputs">
                  <summary>{t('task.candidates.inputs', { count: plan.members.length })}</summary>
                  <p>{t('task.candidates.base')} <code>{plan.request.baseCommit}</code></p>
                  <ol>{plan.members.map(member => <li key={member.id}>{member.purpose}<br /><code>{member.commit}</code></li>)}</ol>
                </details>
                <Button variant="outline" size="sm" disabled={busy || !!done}
                  icon={<Icon name="play" size={14} />} onClick={event => void prepare(item, event.currentTarget)}>
                  {own && busy ? t('task.candidates.preparing') : t('task.candidates.prepare')}
                </Button>
              </>}
              {own && operation.status === 'failed' && <div ref={result} tabIndex={-1} className="dt-quality-result">
                <p role="alert" className="dt-error">{operation.message}</p>
                <Hint>{t('task.candidates.unconfirmed')}</Hint>
              </div>}
              {done && <div ref={result} tabIndex={-1} role="status" className="dt-quality-result">
                <p>{t(done.basisChanged ? 'task.candidates.changed' : done.combination.phase === 'conflicted'
                  ? 'task.candidates.conflicted' : 'task.candidates.prepared')}</p>
                {done.combination.source && <code className="dt-quality-commit">{done.combination.source.commit}</code>}
              </div>}
            </li>
          })}</ul>
          <div className="dt-actions">
            {(read.query.offset ?? 0) > 0 && <Button variant="ghost" size="sm" disabled={busy}
              icon={<Icon name="chevron-left" size={14} />} onClick={() => page({})}>{t('task.candidates.first')}</Button>}
            {state.catalog.nextOffset !== null && <Button variant="ghost" size="sm" disabled={busy}
              icon={<Icon name="chevron-right" size={14} />} onClick={() => page({
                offset: state.catalog.nextOffset!, snapshot: state.catalog.snapshot,
              })}>{t('task.candidates.next')}</Button>}
          </div>
        </>}
  </section>
}
