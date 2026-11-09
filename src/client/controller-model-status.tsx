import { useEffect, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { Button, DisclosureRow, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, when } from './text.ts'
import { Hint, KeyValues, LoadState } from './widgets.tsx'

type Status = ApiResponse<'GET models/controller'>
const modelText = (model: NonNullable<Status['configured']['model']>) =>
  `${model.provider} / ${model.model}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}`

/** 按需读取总管模型记录；折叠或切换会话后丢弃迟到响应，不触发轮询。 */
export function ControllerModelStatus({ sessionId }: { sessionId: string }) {
  const { t, call, openSession, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Status>()
  const [error, setError] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const read = async () => {
    const current = ++generation.current
    setBusy(true); setData(undefined); setError(undefined)
    try {
      const result = await call('GET models/controller')
      if (generation.current !== current) return
      if (result.sessionId !== sessionId) throw new Error(t('controllerModel.identityChanged'))
      setData(result)
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure : new Error(errorText(failure)))
    } finally { if (generation.current === current) setBusy(false) }
  }
  const toggle = () => {
    if (open) {
      generation.current++; setOpen(false); setBusy(false); setData(undefined); setError(undefined)
    } else { setOpen(true); void read() }
  }
  const observation = data?.observation
  const rows: [string, string][] = data ? [[t('controllerModel.configured'), data.configured.model
    ? modelText(data.configured.model) : t('controllerModel.inherit')]] : []
  if (observation?.state === 'observed') rows.push(
    [t('controllerModel.lastUsed'), observation.lastUsed ? modelText(observation.lastUsed) : t('controllerModel.unrecorded')],
    [t('controllerModel.next'), observation.next ? modelText(observation.next) : t('controllerModel.unrecorded')],
  )
  return <DisclosureRow icon={<Icon name="session" />} title={t('controllerModel.title')} open={open} onToggle={toggle}>
    <div className="dt-disclosure-body dt-controller-model">
      <LoadState loading={busy} error={error} />
      {data && <>
        <KeyValues rows={rows} />
        {observation?.state === 'unknown' && <Hint>{t(`controllerModel.reason.${observation.reason}`)}</Hint>}
        <Hint>{t('controllerModel.observedAt', { at: when(data.observedAt, t('lang')) })}</Hint>
        <Hint>{t('controllerModel.meaning')}</Hint>
      </>}
      <div className="dt-actions">
        <Button variant="ghost" size="sm" icon={<Icon name="refresh" />} disabled={busy}
          onClick={() => { void read() }}>{t('controllerModel.reload')}</Button>
        <Button variant="ghost" size="sm" icon={<Icon name="session" />}
          onClick={() => { void openSession(sessionId).catch(failure => notify(errorText(failure))) }}>
          {t('controllerModel.openSession')}</Button>
      </div>
    </div>
  </DisclosureRow>
}
