import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { Button, DisclosureRow, Icon, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint } from './widgets.tsx'
import { TaskCheckReport } from './task-check-report.tsx'

type Preview = ApiResponse<'GET tasks/:id/quality/acceptance'>
type Receipt = ApiResponse<'POST tasks/:id/quality/verify-combination'>
function AcceptanceRead({ id, receipt }: { id: string; receipt: Receipt }) {
  const { t, call } = usePanel()
  const [read, setRead] = useState<{ state: 'loading' } | { state: 'failed'; message: string }
    | { state: 'ready'; value: Preview }>({ state: 'loading' })
  const [source, setSource] = useState(''), [rationale, setRationale] = useState('')
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>()
  const [generation, refresh] = useState(0)
  const visit = useRef<object>(), running = useRef(false)
  useEffect(() => {
    const token = {}
    visit.current = token
    setRead({ state: 'loading' }); setFailure(undefined)
    call('GET tasks/:id/quality/acceptance', { id, query: { sourceCheckId: receipt.requestId } }).then(value => {
      if (visit.current !== token) return
      if (value.basis.ticketId !== id || value.basis.changeRevision !== receipt.changeRevision
        || value.source.requestId !== receipt.requestId || value.source.combinationId !== receipt.combinationId
        || value.source.commit !== receipt.binding.source.commit
        || value.basis.profile.id !== receipt.binding.profile.id || value.basis.profile.revision !== receipt.binding.profile.revision
        || value.basis.profile.digest !== receipt.binding.profile.digest
        || !/^[a-f0-9]{64}$/.test(value.basisDigest)
        || value.assurance.executionAuthorized !== false || value.assurance.publishAllowed !== false)
        throw new Error(t('task.acceptance.unconfirmed'))
      setRead({ state: 'ready', value })
      const latest = value.events.at(-1)?.evidence
      setSource(latest?.source ?? ''); setRationale(latest?.rationale ?? '')
    }).catch(error => { if (visit.current === token) setRead({ state: 'failed', message: errorText(error) }) })
    return () => { if (visit.current === token) visit.current = undefined }
  }, [id, receipt, generation, call, t])
  const decide = async (action: 'confirm' | 'withdraw') => {
    if (running.current || read.state !== 'ready') return
    const token = visit.current, previous = read.value, requestId = crypto.randomUUID()
    running.current = true; setBusy(true); setFailure(undefined)
    try {
      const shared = { requestId, basisDigest: previous.basisDigest, revision: previous.revision }
      const result = await call('POST tasks/:id/quality/acceptance', { id, body: action === 'confirm'
        ? { ...shared, action, sourceCheckId: receipt.requestId, evidence: { source: source.trim(), rationale: rationale.trim() } }
        : { ...shared, action } })
      if (visit.current !== token) return
      if (result.basis.ticketId !== id || result.basisDigest !== previous.basisDigest
        || result.revision !== previous.revision + 1 || (action === 'confirm' && !result.current)
        || result.state !== (action === 'confirm' ? 'confirmed' : 'withdrawn')
        || !result.events.some(event => event.requestId === requestId && event.action === action)
        || result.assurance.executionAuthorized !== false || result.assurance.publishAllowed !== false)
        throw new Error(t('task.acceptance.unconfirmed'))
      setRead({ state: 'ready', value: { ...previous, ...result } })
      if (action === 'withdraw') { setSource(''); setRationale('') }
    } catch (error) { if (visit.current === token) setFailure(errorText(error)) }
    finally { running.current = false; if (visit.current === token) setBusy(false) }
  }
  if (read.state === 'loading') return <Hint>{t('loading')}</Hint>
  const requirement = (scope: 'task' | 'module', text: string, index: number) => {
    const mapped = read.state === 'ready' ? read.value.mapping?.requirements.find(item =>
      item.scope === scope && item.index === index && item.text === text)?.checks : undefined
    return <li key={`${scope}:${index}`}>{text} <span className="dt-hint">
      {mapped?.length ? mapped.join(', ') : t('task.acceptance.unmapped')}</span></li>
  }
  return <div className="dt-acceptance">
    {read.state === 'failed' ? <p role="alert" className="dt-error">{read.message}</p> : <>
      <p>{t(read.value.state === 'confirmed' ? 'task.acceptance.confirmed'
        : read.value.state === 'withdrawn' ? 'task.acceptance.withdrawn' : 'task.acceptance.pending')}</p>
      <Hint>{t('task.acceptance.scope')}</Hint>
      <h4>{t('task.acceptance.requirements')}</h4>
      <ul>{read.value.basis.task.acceptance.map((item, index) => requirement('task', item, index))}</ul>
      <h4>{read.value.basis.module.name}</h4>
      <ul>{read.value.basis.module.acceptance.map((item, index) => requirement('module', item, index))}</ul>
      <p>{t('task.acceptance.recipe')} <code>{read.value.basis.profile.recipe.path}</code><br />
        <code className="dt-quality-commit">{read.value.basis.profile.recipe.commit}</code></p>
      <section aria-label={t('task.acceptance.checks')}>
        <h4>{t('task.acceptance.checks')}</h4>
        <p>{t(read.value.mapping?.state === 'declared' ? 'task.acceptance.mappingDeclared'
          : read.value.mapping?.state === 'incomplete' ? 'task.acceptance.mappingIncomplete' : 'task.acceptance.mappingMissing')}</p>
        {read.value.mapping && <>
          {read.value.mapping.unmatched.length > 0 && <p className="dt-error">{t('task.acceptance.mappingMismatch')}</p>}
          {read.value.mapping.checks.length > 0 && <details><summary>{t('task.acceptance.checkDetails')}</summary>
            <ol>{read.value.mapping.executionOrder.map(checkId => {
              const check = read.value.mapping.checks.find(item => item.id === checkId)!
              return <li key={check.id}><strong>{check.title}</strong> <code>{check.id}</code>
                <p>{t('task.acceptance.checkTool')} <code>{check.command.tool}</code></p>
                <p>{t('task.acceptance.checkCwd')} <code>{check.command.cwd.root}: {check.command.cwd.path}</code></p>
                <pre className="dt-check-arguments">{JSON.stringify(check.command.argv, null, 2)}</pre>
                <p>{t('task.acceptance.checkRequires')} {check.requires.length ? check.requires.join(', ') : t('task.acceptance.noDependencies')}</p>
                <p>{t('task.acceptance.checkResult', { count: check.result.minimumTests, timeout: check.timeoutMs })}<br />
                  <code>{check.result.format}: {check.result.path}</code></p>
                <TaskCheckReport key={`${read.value.basisDigest}:${read.value.revision}:${check.id}`} id={id}
                  sourceCheckId={receipt.requestId} combinationId={receipt.combinationId}
                  basisDigest={read.value.basisDigest} revision={read.value.revision} check={check} />
              </li>
            })}</ol>
          </details>}
        </>}
      </section>
      <label className="dt-field"><span>{t('task.acceptance.source')}</span>
        <Input value={source} maxLength={2000} disabled={busy || !!failure} autoComplete="off"
          onChange={event => setSource(event.target.value)} /></label>
      <label className="dt-field"><span>{t('task.acceptance.rationale')}</span>
        <textarea className="dt-textarea" value={rationale} maxLength={2000} rows={3} disabled={busy || !!failure}
          onChange={event => setRationale(event.target.value)} /></label>
      <div className="dt-actions">
        <Button variant="outline" size="sm" icon={<Icon name="review" size={14} />}
          disabled={busy || !!failure || !source.trim() || !rationale.trim()
            || (read.value.state === 'confirmed' && source.trim() === read.value.events.at(-1)?.evidence?.source
              && rationale.trim() === read.value.events.at(-1)?.evidence?.rationale)}
          onClick={() => void decide('confirm')}>{t('task.acceptance.confirm')}</Button>
        {read.value.state === 'confirmed' && <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />}
          disabled={busy || !!failure} onClick={() => void decide('withdraw')}>{t('task.acceptance.withdraw')}</Button>}
      </div>
      {read.value.events.length > 0 && <details><summary>{t('task.acceptance.history')}</summary>
        <ol>{read.value.events.map(event => <li key={event.requestId}>
          {t(event.action === 'confirm' ? 'task.acceptance.confirm' : 'task.acceptance.withdraw')} · <time>{event.at}</time>
          {event.evidence && <><p>{event.evidence.source}</p><p>{event.evidence.rationale}</p></>}
        </li>)}</ol></details>}
    </>}
    {failure && <p role="alert" className="dt-error">{failure}</p>}
    {(read.state === 'failed' || failure) && <Button size="sm" icon={<Icon name="refresh" size={14} />}
      disabled={busy} onClick={() => refresh(value => value + 1)}>{t('task.acceptance.refresh')}</Button>}
  </div>
}

/** 来源回执下按需读取确认；折叠和离页不保留输入，不自动提交或派发。 */
export function TaskAcceptance({ id, receipt }: { id: string; receipt: Receipt }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  return <DisclosureRow title={t('task.acceptance.title')} icon={<Icon name="review" size={14} />} open={open}
    onToggle={() => setOpen(value => !value)}>
    {open && <AcceptanceRead key={receipt.requestId} id={id} receipt={receipt} />}
  </DisclosureRow>
}
