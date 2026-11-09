import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { TaskQualityQuery } from '../development/quality-contracts.ts'
import { ApiError } from './api.ts'
import { Button, DisclosureRow, Icon, Input, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint } from './widgets.tsx'
import { OptimizationPanel } from './optimization-suggestions.tsx'
import { TaskCandidates } from './task-candidates.tsx'
import { TaskAcceptance } from './task-acceptance.tsx'

type Catalog = ApiResponse<'GET tasks/:id/quality'>
type Registered = Extract<Catalog, { state: 'registered' }>
type Profile = Registered['items'][number]
type Receipt = ApiResponse<'POST tasks/:id/quality/verify-sources'> | ApiResponse<'POST tasks/:id/quality/verify-combination'>
type Combination = ApiResponse<'POST development/combinations'>
type Operation = { state: 'idle' } | { state: 'running'; profileId: string }
  | { state: 'failed'; profileId: string; message: string; refresh: boolean }
  | { state: 'done'; profileId: string; receipt: Receipt }

function QualityResults({ id, catalog, query, refresh, page, combination }: {
  id: string; catalog: Registered; query: TaskQualityQuery; refresh: () => void; page: (query: TaskQualityQuery) => void
  combination?: Combination
}) {
  const { t, call } = usePanel()
  const [operation, setOperation] = useState<Operation>({ state: 'idle' })
  const [paths, setPaths] = useState<Record<string, string>>({})
  const visit = useRef<object>(), running = useRef(false)
  useEffect(() => {
    const current = {}
    visit.current = current
    return () => { if (visit.current === current) visit.current = undefined }
  }, [])
  const verify = async (profile: Profile) => {
    if (running.current) return
    const current = visit.current
    running.current = true
    setOperation({ state: 'running', profileId: profile.id })
    try {
      const body = {
        changeRevision: catalog.changeRevision, profileId: profile.id, profileRevision: profile.revision,
        ...(profile.recipeRepositoryRequired ? { recipeRepositoryPath: paths[profile.id]?.trim() } : {}),
      }
      const requestId = combination ? crypto.randomUUID() : undefined
      const receipt = combination
        ? await call('POST tasks/:id/quality/verify-combination', { id, body: {
          ...body, combinationId: combination.combination.id, requestId: requestId!,
        } })
        : await call('POST tasks/:id/quality/verify-sources', { id, body })
      if (visit.current !== current) return
      const source = combination?.combination.source ?? catalog.source
      // 回执必须属于当前选择及登记起点，不能用另一次核验的成功替代。
      if (!receipt || receipt.ticketId !== id || receipt.changeRevision !== catalog.changeRevision
        || receipt.binding?.profile?.id !== profile.id || receipt.binding.profile.revision !== profile.revision
        || receipt.binding.profile.digest !== profile.digest || receipt.binding.source.commit !== source.commit
        || receipt.binding.source.tree !== source.tree
        || (!combination && receipt.binding.source.identity !== catalog.source.identity)
        || (combination && (!('combinationId' in receipt) || receipt.combinationId !== combination.combination.id
          || receipt.requestId !== requestId || !receipt.persisted
          || receipt.verification?.sourceInputs?.scope !== 'committed-tree'
          || receipt.verification.sourceInputs.tree !== source.tree
          || receipt.binding.repositoryId !== combination.combination.source?.repositoryId))
        || !['tracked_content_matched', 'references_unresolved'].includes(receipt.verification?.status))
        throw new Error(t('task.quality.unconfirmed'))
      setOperation({ state: 'done', profileId: profile.id, receipt })
    } catch (failure) {
      if (visit.current === current) setOperation({ state: 'failed', profileId: profile.id, message: errorText(failure),
        refresh: failure instanceof ApiError && failure.status === 409 })
    } finally { running.current = false }
  }
  const busy = operation.state === 'running'
  const changed = operation.state === 'failed' && operation.refresh
  return <>
    <p className="dt-hint">{t(combination ? 'task.quality.combinationBase' : 'task.quality.base')} <code className="dt-quality-commit">
      {combination?.combination.source?.commit ?? catalog.source.commit}</code></p>
    <Hint>{t(combination ? 'task.quality.combinationScope' : 'task.quality.scope')}</Hint>
    {!catalog.items.length && <Hint>{t('task.quality.empty')}</Hint>}
    <ul className="dt-list dt-quality-list">
      {catalog.items.map(profile => <li key={profile.id} className="dt-quality-item">
        <div className="dt-quality-head">
          <div className="dt-row-main"><div className="dt-row-title">{profile.moduleName} / {profile.name}</div>
            <div className="dt-row-meta">{t('task.quality.version', { revision: profile.revision })}
              <span>{profile.format === 'jvm-trial-v1' ? 'JVM' : 'C++'}</span>
              <span>{profile.configurationPath}</span></div>
          </div>
          {!profile.applicable && <Tag tone="warning">{t('task.quality.stale')}</Tag>}
        </div>
        {profile.applicable && profile.recipeRepositoryRequired && <label className="dt-quality-path">
          <span>{t('task.quality.recipePath')}</span>
          <Input value={paths[profile.id] ?? ''} disabled={busy || changed} autoComplete="off" spellCheck={false}
            onChange={event => {
              setPaths(previous => ({ ...previous, [profile.id]: event.target.value }))
              if (operation.state !== 'idle' && operation.profileId === profile.id) setOperation({ state: 'idle' })
            }} />
        </label>}
        <div className="dt-actions">
          <Button variant="outline" size="sm" icon={<Icon name="review" size={14} />}
            disabled={busy || changed || !profile.applicable || (profile.recipeRepositoryRequired && !paths[profile.id]?.trim())}
            onClick={() => void verify(profile)}>{operation.state === 'running' && operation.profileId === profile.id
              ? t('task.quality.checking') : t('task.quality.verify')}</Button>
        </div>
        {operation.state === 'failed' && operation.profileId === profile.id
          && <p className="dt-error" role="alert">{operation.message}</p>}
        {operation.state === 'done' && operation.profileId === profile.id && <div role="status" className="dt-quality-result">
          <strong>{t(operation.receipt.verification.status === 'references_unresolved'
            ? 'task.quality.unresolved' : 'task.quality.matched')}</strong>
          <p>{t('task.quality.remaining')}</p>
          {'combinationId' in operation.receipt && <p>{t('task.quality.recorded')}</p>}
          {operation.receipt.verification.sourceInputs && <p>{t('task.quality.inputs', {
            files: operation.receipt.verification.sourceInputs.files,
            bytes: operation.receipt.verification.sourceInputs.logicalFileBytes,
          })}</p>}
          {operation.receipt.verification.sourceInputs?.status === 'references_unresolved'
            && <p>{t('task.quality.inputReferences', {
              symlinks: operation.receipt.verification.sourceInputs.symlinks,
              submodules: operation.receipt.verification.sourceInputs.submodules,
            })}</p>}
          {(operation.receipt.verification.recipe.symlinks > 0 || operation.receipt.verification.recipe.submodules > 0)
            && <p>{t('task.quality.references', {
            symlinks: operation.receipt.verification.recipe.symlinks,
            submodules: operation.receipt.verification.recipe.submodules,
          })}</p>}
        </div>}
        {operation.state === 'done' && operation.profileId === profile.id && 'combinationId' in operation.receipt
          && <TaskAcceptance key={operation.receipt.requestId} id={id} receipt={operation.receipt} />}
        {!combination && <OptimizationPanel key={`${id}:${profile.id}`} id={id} profileId={profile.id} />}
      </li>)}
    </ul>
    <div className="dt-actions">
      <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} disabled={busy}
        onClick={refresh}>{t('task.quality.refresh')}</Button>
      {(query.offset ?? 0) > 0 && <Button variant="outline" size="sm" icon={<Icon name="chevron-left" size={14} />}
        disabled={busy} onClick={() => page({ ...query, offset: Math.max(0, (query.offset ?? 0) - (query.limit ?? 8)),
          snapshot: catalog.snapshot })}>{t('task.quality.previous')}</Button>}
      {catalog.nextOffset !== null && <Button variant="outline" size="sm" icon={<Icon name="chevron-right" size={14} />}
        disabled={busy} onClick={() => page({ ...query, offset: catalog.nextOffset!, snapshot: catalog.snapshot })}>
        {t('task.quality.next')}</Button>}
    </div>
  </>
}

/** 折叠时不读取；重读或翻页卸载旧回执，不保留跨任务的路径和结果。 */
function QualityRead({ id, query, refresh, page, combination, onPrepared }: {
  id: string; query: TaskQualityQuery; refresh: () => void; page: (query: TaskQualityQuery) => void
  combination?: Combination; onPrepared: (receipt: Combination | undefined) => void
}) {
  const { t, call } = usePanel()
  const region = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'failed'; message: string }
    | { status: 'ready'; catalog: Catalog }>({ status: 'loading' })
  useEffect(() => {
    let active = true
    call('GET tasks/:id/quality', { id, query }).then(catalog => {
      if (active) setState({ status: 'ready', catalog })
    }, error => { if (active) setState({ status: 'failed', message: errorText(error) }) })
    return () => { active = false }
  }, [id, query, call])
  useEffect(() => {
    // 翻页或重读移除原按钮后接续焦点；用户转去其他控件时不抢回。
    if (state.status !== 'loading' && document.activeElement === document.body) region.current?.focus({ preventScroll: true })
  }, [state])
  if (state.status === 'loading') return <Hint>{t('loading')}</Hint>
  return <div ref={region} role="region" tabIndex={-1} aria-label={t('task.quality.title')}>
    {state.status === 'ready' && state.catalog.state === 'registered'
      ? <>
        <TaskCandidates key={id} id={id} onPrepared={onPrepared} />
        <h3 className="dt-candidates-heading">{t('task.quality.sources')}</h3>
        <QualityResults key={combination?.combination.id ?? 'registered'} id={id} catalog={state.catalog}
          combination={combination} query={query} refresh={refresh} page={page} />
      </>
      : <>
        {state.status === 'failed' ? <p className="dt-error" role="alert">{state.message}</p>
          : <Hint>{t('task.quality.unregistered')}</Hint>}
        <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} onClick={refresh}>{t('task.quality.refresh')}</Button>
      </>}
  </div>
}

export function TaskQuality({ id }: { id: string }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<{ ticketId: string; receipt: Combination }>()
  const onPrepared = useCallback((receipt: Combination | undefined) =>
    setSelected(receipt ? { ticketId: id, receipt } : undefined), [id])
  const [read, setRead] = useState<{ generation: number; query: TaskQualityQuery }>({ generation: 0, query: {} })
  const page = (query: TaskQualityQuery) => setRead(previous => ({ generation: previous.generation + 1, query }))
  return <section className="dt-task-quality">
    <DisclosureRow title={t('task.quality.title')} icon={<Icon name="review" size={14} />} open={open}
      onToggle={() => { if (open) setSelected(undefined); setOpen(value => !value); page({}) }}>
      <div className="dt-quality-body">{open && <QualityRead key={`${id}:${read.generation}`} id={id} query={read.query}
        combination={selected?.ticketId === id ? selected.receipt : undefined} onPrepared={onPrepared}
        refresh={() => page({})} page={page} />}</div>
    </DisclosureRow>
  </section>
}
