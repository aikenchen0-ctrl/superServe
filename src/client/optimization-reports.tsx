import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { TaskQualityQuery } from '../development/quality-contracts.ts'
import { Button, DisclosureRow, Icon, Input, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint } from './widgets.tsx'
import { errorText, fullTime } from './text.ts'

type Catalog = ApiResponse<'GET tasks/:id/quality/suggestions/:suggestionId/reports'>
function ReportPage({ id, suggestionId, query, page }: {
  id: string; suggestionId: string; query: TaskQualityQuery; page: (query: TaskQualityQuery) => void
}) {
  const { t, call } = usePanel()
  const [read, setRead] = useState<{ state: 'loading' } | { state: 'failed'; message: string }
    | { state: 'ready'; catalog: Catalog }>({ state: 'loading' })
  const [directory, setDirectory] = useState('')
  const [retainRaw, setRetainRaw] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [detail, setDetail] = useState<string>()
  const active = useRef(false), region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let current = true
    active.current = true
    call('GET tasks/:id/quality/suggestions/:suggestionId/reports', { id, suggestionId, query }).then(catalog => {
      if (!current) return
      if (catalog?.ticketId !== id || catalog.suggestionId !== suggestionId || !Array.isArray(catalog.items)
        || catalog.items.some(item => item.ticketId !== id || item.suggestionId !== suggestionId))
        setRead({ state: 'failed', message: t('task.report.unconfirmed') })
      else setRead({ state: 'ready', catalog })
    }, error => { if (current) setRead({ state: 'failed', message: errorText(error) }) })
    return () => { current = false; active.current = false }
  }, [id, suggestionId, query, call, t])
  useEffect(() => {
    if (read.state !== 'loading' && document.activeElement === document.body) region.current?.focus({ preventScroll: true })
  }, [read])
  const capture = useAction(async () => {
    if (!directory.trim()) return
    setFailure(undefined)
    try {
      const result = await call('POST tasks/:id/quality/suggestions/:suggestionId/reports', {
        id, suggestionId, body: { directory: directory.trim(), ...(retainRaw ? { retainRaw: true } : {}) },
      })
      if (!active.current) return
      if (result?.ticketId !== id || result.suggestionId !== suggestionId
        || result.receipt?.ticketId !== id || result.receipt.suggestionId !== suggestionId
        || typeof result.created !== 'boolean' || !/^[a-f0-9]{64}$/.test(result.receipt.id))
        throw new Error(t('task.report.unconfirmed'))
      page({})
    } catch (error) {
      if (active.current) setFailure(errorText(error))
    }
  })
  const download = useAction(async (item: Catalog['items'][number], name: string) => {
    setFailure(undefined)
    try {
      const expected = item.report.artifacts.find(file => file.name === name)
      const file = await call('GET tasks/:id/quality/suggestions/:suggestionId/reports/:reportId/file', {
        id, suggestionId, reportId: item.id, query: { name },
      })
      if (!active.current) return
      if (!expected?.sha256 || file?.ticketId !== id || file.suggestionId !== suggestionId || file.reportId !== item.id
        || file.name !== name || file.sha256 !== expected.sha256 || file.bytes !== expected.bytes
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 4 * 1024 * 1024
        || typeof file.base64 !== 'string' || file.base64.length !== 4 * Math.ceil(file.bytes / 3))
        throw new Error(t('task.report.fileUnconfirmed'))
      const data = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (!active.current) return
      if (data.length !== file.bytes || digest !== file.sha256) throw new Error(t('task.report.fileUnconfirmed'))
      const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
      try {
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = name.split('/').at(-1)!; anchor.click()
      } finally { URL.revokeObjectURL(url) }
    } catch (error) {
      if (active.current) setFailure(error instanceof Error && error.name === 'InvalidCharacterError'
        ? t('task.report.fileUnconfirmed') : errorText(error))
    }
  })
  const busy = capture.busy || download.busy
  if (read.state === 'loading') return <Hint>{t('loading')}</Hint>
  return <div className="dt-report-body" ref={region} tabIndex={-1} role="region" aria-label={t('task.report.title')}>
    <p className="dt-label">{t('task.report.title')}</p>
    {read.state === 'failed' ? <p className="dt-error" role="alert">{read.message}</p> : <>
      {read.catalog.applicability.state === 'needs_reassessment' && <p className="dt-hint">{t('task.report.basisChanged')}</p>}
      {!read.catalog.items.length && <Hint>{t('task.report.empty')}</Hint>}
      <ul className="dt-list">{read.catalog.items.map(item => {
        const open = detail === item.id, report = item.report, retained = read.catalog.retained?.[item.id]
        return <li key={item.id} className="dt-report-item">
          <Tag tone={report.evidence === 'review_required' ? 'neutral' : 'warning'}>{t(`task.report.${report.evidence}`)}</Tag>
          <p className="dt-hint">{retained ? t('task.report.retained', { count: retained.files.length, bytes: retained.retainedBytes })
            : t('task.report.notRetained')}</p>
          <DisclosureRow title={t('task.report.recorded', { time: fullTime(item.recordedAt, t('lang')) })}
            icon={<Icon name="review" size={14} />} open={open} onToggle={() => setDetail(open ? undefined : item.id)}>
            <dl className="dt-optimization-details">
              <dt>{t('task.report.declaredCommit')}</dt><dd>{report.declaredIdentity.sourceCommit ?? t('task.report.unknown')}</dd>
              <dt>{t('task.report.execution')}</dt><dd>{t(`task.report.execution.${report.reportedExecution}`)}</dd>
            </dl>
            <ul className="dt-report-issues">{report.issues.map((issue, index) =>
              <li key={index}><p>{issue.message}</p><p className="dt-hint">{issue.action}</p></li>)}</ul>
            <details><summary>{t('task.report.files')}</summary>
              <dl className="dt-optimization-details">
                <dt>{t('task.report.scope')}</dt><dd>{report.declaredIdentity.scopeDigest ?? t('task.report.unknown')}</dd>
                <dt>{t('task.report.inputs')}</dt><dd>{report.declaredIdentity.inputDigest ?? t('task.report.unknown')}</dd>
                <dt>{t('task.report.bundle')}</dt><dd>{report.bundleDigest}</dd>
              </dl>
              <ul className="dt-report-files">{report.artifacts.map(file => <li key={file.name}>
                <span>{file.name} · {t(`task.report.file.${file.status}`)}</span>
                {file.sha256 && <code>{file.sha256}</code>}
                {retained?.files.some(stored => stored.name === file.name) && <Button variant="ghost" size="sm"
                  disabled={busy} onClick={() => void download.run(item, file.name)}
                  aria-label={t('task.report.downloadNamed', { name: file.name })}>{t('task.report.download')}</Button>}
              </li>)}</ul>
            </details>
          </DisclosureRow>
        </li>
      })}</ul>
      <Hint>{t('task.report.limit')}</Hint>
      <form className="dt-report-form" onSubmit={event => { event.preventDefault(); if (!busy) void capture.run() }}>
        <label><span className="dt-label">{t('task.report.directory')}</span>
          <Input aria-label={t('task.report.directory')} value={directory} maxLength={4096} autoComplete="off" spellCheck={false}
            disabled={busy} onChange={event => setDirectory(event.currentTarget.value)} /></label>
        <label className="dt-report-retain"><input type="checkbox" checked={retainRaw} disabled={busy}
          onChange={event => setRetainRaw(event.currentTarget.checked)} /><span>{t('task.report.retain')}</span></label>
        {retainRaw && <Hint>{t('task.report.retainNotice')}</Hint>}
        <Button type="submit" size="sm" icon={<Icon name="review" size={14} />} disabled={!directory.trim() || busy}>
          {t(capture.busy ? 'task.report.reading' : 'task.report.capture')}</Button>
      </form>
    </>}
    {failure && <p className="dt-error" role="alert">{failure}</p>}
    <div className="dt-actions">
      <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />} disabled={busy}
        onClick={() => page({})}>{t('task.report.reload')}</Button>
      {read.state === 'ready' && (query.offset ?? 0) > 0 && <Button variant="ghost" size="sm"
        icon={<Icon name="chevron-left" size={14} />} disabled={busy}
        onClick={() => page({ offset: Math.max(0, (query.offset ?? 0) - 8), snapshot: read.catalog.snapshot })}>
        {t('task.report.previous')}</Button>}
      {read.state === 'ready' && read.catalog.nextOffset !== null && <Button variant="ghost" size="sm"
        icon={<Icon name="chevron-right" size={14} />} disabled={busy}
        onClick={() => page({ offset: read.catalog.nextOffset!, snapshot: read.catalog.snapshot })}>
        {t('task.report.next')}</Button>}
    </div>
  </div>
}

/** 随建议详情挂载，仅读取持久核对记录；显式提交目录后才读取本机报告。 */
export function OptimizationReportPanel({ id, suggestionId }: { id: string; suggestionId: string }) {
  const [read, setRead] = useState<{ generation: number; query: TaskQualityQuery }>({ generation: 0, query: {} })
  return <ReportPage key={`${id}:${suggestionId}:${read.generation}`} id={id} suggestionId={suggestionId} query={read.query}
    page={query => setRead(value => ({ generation: value.generation + 1, query }))} />
}
