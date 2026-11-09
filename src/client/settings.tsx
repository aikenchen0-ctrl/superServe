/** Settings tab shell routing between stage settings (Sources, Eval, Execution), Prompts, and Deployment. */
import type { StateView } from './api.ts'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings, ProcessingControl } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { SettingsProvider } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'
import { Button, Icon } from './controls.tsx'

const STAGE_GROUPS: readonly SettingsGroup[] = ['source', 'eval', 'execution']
export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, back, backLabel, navigate } = usePanel()
  const { reload } = usePanelData()
  const hmmMode = state.setup.machine.mode === 'hmm'
  const fromTask = backLabel === t('tab.tasks')
  const groups: readonly SettingsGroup[] = hmmMode ? ['execution', 'prompts', 'deployment'] : SETTINGS_GROUPS
  const visibleGroup = groups.includes(group) ? group : hmmMode ? 'execution' : group
  const content = (() => {
    switch (visibleGroup) {
      case 'source': return <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      case 'execution': return <SettingsProvider><ExecutionSettings /></SettingsProvider>
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
    }
  })()
  return <div className="dt-settings">
    {fromTask && <div className="dt-actions">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" />} onClick={back}>
        {t('task.returnToTask')}</Button>
    </div>}
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {groups.map(value => <button key={value} type="button" className="dt-settings-link" data-stage={STAGE_GROUPS.includes(value)
        || undefined}
        aria-current={value === visibleGroup ? 'page' : undefined} onClick={() => navigate(settingsRoute(value),
          true)}>{t(`settingsGroup.${value}`)}</button>)}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{t(`settingsGroup.${visibleGroup}`)}</h2>
      {content}
      {hmmMode && visibleGroup === 'execution' && <ProcessingControl state={state} reload={reload} />}
    </div>
  </div>
}
