import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { OptimizationQuery } from '../development/optimization-suggestions.ts'
import { ApiError } from './api.ts'
import { Button, DisclosureRow, Icon, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint } from './widgets.tsx'
import { errorText } from './text.ts'
import { OptimizationReportPanel } from './optimization-reports.tsx'

type Catalog = ApiResponse<'GET tasks/:id/quality/suggestions'>
type Item = Catalog['items'][number]
function SuggestionsPage({ id, query, page }: { id: string; query: OptimizationQuery; page: (query: OptimizationQuery) => void }) {
  const { t, call } = usePanel()
  const [read, setRead] = useState<{ state: 'loading' } | { state: 'failed'; message: string }
    | { state: 'ready'; catalog: Catalog }>({ state: 'loading' })
  const [failure, setFailure] = useState<string>()
  const [detail, setDetail] = useState<string>()
  const active = useRef(false), region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let current = true
    active.current = true
    call('GET tasks/:id/quality/suggestions', { id, query }).then(catalog => {
      if (current) setRead({ state: 'ready', catalog })
    }, error => { if (current) setRead({ state: 'failed', message: errorText(error) }) })
    return () => { current = false; active.current = false }
  }, [id, query, call])
  useEffect(() => {
    if (read.state !== 'loading' && document.activeElement === document.body) region.current?.focus({ preventScroll: true })
  }, [read])
  const refresh = () => page({ profileId: query.profileId })
  const decision = useAction(async (item: Item) => {
    setFailure(undefined)
    const action = item.disposition === 'open' ? 'defer' : 'reopen'
    try {
      const receipt = await call('POST tasks/:id/quality/suggestions/:suggestionId/decision', { id,
        suggestionId: item.suggestion.id, body: { revision: item.revision, action } })
      if (!active.current) return
      if (receipt?.suggestion?.ticketId !== id || receipt.suggestion.id !== item.suggestion.id
        || !Number.isSafeInteger(receipt.revision) || receipt.revision < item.revision
        || typeof receipt.changed !== 'boolean' || !['open', 'deferred'].includes(receipt.disposition))
        throw new Error(t('task.optimization.unconfirmed'))
      refresh()
    } catch (error) {
      if (!active.current) return
      // 保留失败原因；版本冲突不替用户在新版本上重放动作。
      setFailure(error instanceof ApiError && error.status === 409 ? t('task.optimization.changed') : errorText(error))
    }
  })
  if (read.state === 'loading') return <Hint>{t('loading')}</Hint>
  return <div ref={region} tabIndex={-1} role="region" aria-label={t('task.optimization.title')} className="dt-optimization-body">
    {read.state === 'failed' ? <p className="dt-error" role="alert">{read.message}</p> : <>
      {!read.catalog.items.length && <Hint>{t('task.optimization.empty')}</Hint>}
      <ul className="dt-list">{read.catalog.items.map(item => {
        const suggestion = item.suggestion, open = detail === suggestion.id
        const stale = item.applicability.state === 'needs_reassessment'
        return <li key={suggestion.id} className="dt-optimization-item">
          <div className="dt-actions">
            <Tag tone={stale ? 'warning' : 'neutral'}>{t(stale ? 'task.optimization.stale' : 'task.optimization.aligned')}</Tag>
            {item.disposition === 'deferred' && <Tag tone="quiet">{t('task.optimization.deferred')}</Tag>}
          </div>
          <p className="dt-optimization-finding">{suggestion.finding}</p>
          {stale && <p className="dt-hint">{item.applicability.reasons.map(reason => t(`task.optimization.${reason}`)).join('；')}</p>}
          <DisclosureRow title={t('task.optimization.detail')} icon={<Icon name="review" size={14} />} open={open}
            onToggle={() => setDetail(open ? undefined : suggestion.id)}>
            <dl className="dt-optimization-details">
              <dt>{t('task.optimization.proposal')}</dt><dd>{suggestion.proposal}</dd>
              <dt>{t('task.optimization.validation')}</dt><dd>{suggestion.validation}</dd>
              <dt>{t('task.quality.base')}</dt><dd><code>{suggestion.binding.source.commit}</code></dd>
              <dt>{t('task.optimization.basis')}</dt><dd>{t('task.optimization.versions', {
                change: suggestion.binding.changeRevision, profile: suggestion.binding.profile.revision,
              })}</dd>
            </dl>
            <Hint>{t('task.optimization.scope')}</Hint>
            <OptimizationReportPanel key={suggestion.id} id={id} suggestionId={suggestion.id} />
          </DisclosureRow>
          <Button variant="ghost" size="sm" disabled={decision.busy || !!failure}
            icon={<Icon name={item.disposition === 'open' ? 'clock' : 'queue'} size={14} />}
            onClick={() => void decision.run(item)}>{t(item.disposition === 'open' ? 'task.optimization.defer' : 'task.optimization.reopen')}</Button>
        </li>
      })}</ul>
    </>}
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    <div className="dt-actions">
      <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} disabled={decision.busy} onClick={refresh}>
        {t('task.optimization.refresh')}</Button>
      {read.state === 'ready' && (query.offset ?? 0) > 0 && <Button variant="outline" size="sm"
        icon={<Icon name="chevron-left" size={14} />} disabled={decision.busy}
        onClick={() => page({ ...query, offset: Math.max(0, (query.offset ?? 0) - 8), snapshot: read.catalog.snapshot })}>
        {t('task.optimization.previous')}</Button>}
      {read.state === 'ready' && read.catalog.nextOffset !== null && <Button variant="outline" size="sm"
        icon={<Icon name="chevron-right" size={14} />} disabled={decision.busy}
        onClick={() => page({ ...query, offset: read.catalog.nextOffset!, snapshot: read.catalog.snapshot })}>
        {t('task.optimization.next')}</Button>}
    </div>
  </div>
}

/** 只在用户展开时读取该配置的建议；不派发 Agent 或取得工作区写入权。 */
export function OptimizationPanel({ id, profileId }: { id: string; profileId: string }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState<{ generation: number; query: OptimizationQuery }>({ generation: 0, query: { profileId } })
  const page = (query: OptimizationQuery) => setRead(previous => ({ generation: previous.generation + 1, query }))
  return <DisclosureRow title={t('task.optimization.title')} icon={<Icon name="review" size={14} />} open={open}
    onToggle={() => { setOpen(value => !value); page({ profileId }) }}>
    {open && <SuggestionsPage key={`${id}:${profileId}:${read.generation}`} id={id} query={read.query} page={page} />}
  </DisclosureRow>
}
