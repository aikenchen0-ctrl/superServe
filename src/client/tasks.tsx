/** Local HMM task creation, progress, recovery and bounded context input. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type Ref, type SetStateAction } from 'react'
import type { HmmCommand } from '../hmm/model.ts'
import { LOCAL_TASK_FILTERS, type LocalTaskFilter as TaskFilter } from '../app/task-list.ts'
import { Button, DisclosureRow, Dot, Icon, Input, Pill, SegmentedControl, Tag } from './controls.tsx'
import { ApiError, usePoll, type LocalTaskListView, type LocalTaskStatusView, type LocalTaskInputView, type LocalTaskResultSourcesView, type LocalTaskGoalView, type LocalTaskPlanChangeView } from './api.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { clearTaskCreation, readTaskCreation, sameTaskCreation, saveTaskCreation, taskCreationKey,
  type PendingTaskCreation, type TaskMode } from './task-creation.ts'
import { valueLabel, type T } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadState, PageHead, Section, When } from './widgets.tsx'
import { TaskPlan } from './task-plan.tsx'
import { TaskQuality } from './task-quality.tsx'

type TaskRow = LocalTaskListView['items'][number]
type TaskStatus = LocalTaskStatusView
type NodeState = keyof TaskStatus['workflow']['progress']
type TaskPaging = { cursors: string[]; visited: boolean }
type TaskDraft = { goal: string; title: string; mode: TaskMode }
type TaskSearch = { text: string; query: string }
type TaskEntry = { ticketId: string; source: Element | null; pending: boolean }
type AnswerDraft = { questionId: string; question: string; text: string }
const activityViews = {
  running: ['task.running', 'info'],
  paused: ['task.processingPaused', 'neutral'],
  held: ['task.held', 'neutral'],
  review: ['task.awaitingValidation', 'warning'],
  attention: ['task.attention', 'warning'],
  waiting: ['task.waiting', 'neutral'],
  ended: ['task.ended', 'neutral'],
  unknown: ['task.openState', 'neutral'],
} as const
const resumeHints = {
  parent_suspended: 'task.resumeParent',
  attempts_exhausted: 'task.resumeExhausted',
  manual_running: 'task.resumeManual',
} as const
const attentionHints = {
  reference_invalid: 'task.attentionReason.referenceInvalid',
  dependency_blocked: 'task.attentionReason.dependencyBlocked',
  suspended: 'task.attentionReason.suspended',
  plan_review: 'task.attentionReason.planReview',
} as const
const resultHints = {
  evidence_invalid: 'task.resultInvalid',
  input_conflict: 'task.resultInputsChanged',
  claims_unreviewed: 'task.resultClaimsUnreviewed',
  workflow_unverified: 'task.resultUnverified',
} as const

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

type TextSubmission = { text: string; requestId: string }
/** 只保留最近一次提交身份；连续重试同一原文不重复保存，改文须由用户再次提交。 */
function textSubmission(previous: TextSubmission | undefined, text: string): TextSubmission {
  const normalized = text.trim()
  return previous?.text === normalized ? previous : { text: normalized, requestId: requestId() }
}

/** 回答和补充共用持久输入回执；成功状态码本身不能证明当前任务已保存。 */
function confirmsInput(value: unknown, ticketId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as { ticketId?: unknown; inputId?: unknown }
  return receipt.ticketId === ticketId && typeof receipt.inputId === 'string' && !!receipt.inputId.trim()
}

/** 旧宿主可省略任务编号，但会话始终须属于本次访问的总管；带编号时必须匹配当前任务。 */
function confirmsDiscussion(value: unknown, ticketId: string, masterId: string | undefined): boolean {
  if (!masterId || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as { ticketId?: unknown; sessionId?: unknown }
  return receipt.sessionId === masterId && (!Object.hasOwn(receipt, 'ticketId') || receipt.ticketId === ticketId)
}

/** 仅完整任务回执可替代详情读取；旧服务的局部响应仍走原有重读。 */
function confirmsTaskStatus(value: TaskStatus, ticketId: string): boolean {
  return value?.ticketId === ticketId && typeof value.title === 'string'
    && typeof value.paused === 'boolean' && typeof value.activity === 'string' && value.ended !== undefined
    && typeof value.inputs?.total === 'number' && typeof value.inputs.pendingDelivery === 'number'
    && !!value.workflow?.progress && Array.isArray(value.workflow.blockers?.items)
    && Array.isArray(value.workflow.dependencyBlockers?.items) && value.result !== undefined && value.resultError !== undefined
}

/** 断网、服务错误或异常回执不能证明控制动作未提交；明确的参数或权限拒绝仍保留原错误。 */
function controlUnconfirmed(failure: unknown): boolean {
  return !(failure instanceof ApiError) || failure.status === 0 || failure.details.unreachable === true || failure.status >= 500
}

/** 焦点衔接后，按住回车不能把一次操作延伸成后续步骤的连发。 */
function preventRepeatedEnter(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' && event.repeat) event.preventDefault()
}

/** 仅衔接本次提交持有的焦点；用户转移操作、离页或保存未确认时释放，不跨请求保留。 */
function useInputFocus(fallback: { current: HTMLElement | null }) {
  const release = useRef<() => void>()
  const [restore, setRestore] = useState<{ source: HTMLElement; target: { current: HTMLElement | null } }>()
  useEffect(() => () => release.current?.(), [])
  useLayoutEffect(() => {
    if (!restore) return
    setRestore(undefined)
    if (document.hidden
      || (document.activeElement !== restore.source && document.activeElement !== document.body)) return
    // 提交后先完成 DOM 更新，再衔接就近阅读区域；长页面中也须让焦点保持可见。
    const target = restore.target.current?.childElementCount ? restore.target.current : fallback.current
    target?.focus({ preventScroll: true })
    target?.scrollIntoView?.({ block: 'nearest' })
  }, [restore, fallback])
  return (form: HTMLFormElement | null, target: { current: HTMLElement | null }) => {
    release.current?.()
    const source = document.activeElement
    if (!(source instanceof HTMLElement) || !form?.contains(source)) return (_confirmed = false) => {}
    let owned = true
    const cleanup = () => {
      owned = false
      document.removeEventListener('focusin', moved)
      document.removeEventListener('pointerdown', moved)
      if (release.current === cleanup) release.current = undefined
    }
    const moved = (event: Event) => { if (event.target !== source) cleanup() }
    document.addEventListener('focusin', moved)
    document.addEventListener('pointerdown', moved)
    release.current = cleanup
    return (confirmed = false) => {
      const continues = confirmed && owned && !document.hidden
        && (document.activeElement === source || document.activeElement === document.body)
      cleanup()
      if (continues) setRestore({ source, target })
    }
  }
}

function Progress({ progress, t, stale = false, focusRef }: {
  progress: TaskStatus['workflow']['progress']; t: T; stale?: boolean; focusRef?: Ref<HTMLUListElement>
}) {
  const values: { state: NodeState; label: string }[] = [
    { state: 'running', label: t('task.running') }, { state: 'pending', label: t('task.pending') },
    { state: 'completed', label: t('task.completed') }, { state: 'suspended', label: t('task.suspended') },
    { state: 'pruned', label: t('task.pruned') },
  ]
  const dot = (state: NodeState) => state === 'running' ? stale ? 'idle' : 'ongoing' : state === 'completed' ? 'done'
    : state === 'suspended' ? 'warning' : state === 'pruned' ? 'idle' : 'idle'
  return <ul className="dt-task-progress" ref={focusRef} tabIndex={-1} aria-label={t('task.progress')}>
    {values.filter(item => progress[item.state as keyof typeof progress] > 0).map(item => <li key={item.state}>
    <Dot state={dot(item.state)} label={item.label} /><span>{item.label}</span>
    <span className="dt-count">{progress[item.state as keyof typeof progress]}</span>
  </li>)}</ul>
}

/** 首次加载和旧数据读取失败共用重读入口，连续点击不堆积额外请求。 */
function TaskReadState({ error, loading, reload }: { error?: Error; loading: boolean; reload: () => Promise<void> }) {
  const { t } = usePanel()
  const retry = useAction(reload)
  return <>
    <LoadState error={error} loading={loading} />
    {error && <div className="dt-actions">
      <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={retry.busy}
        onClick={() => void retry.run()}>{t('task.reload')}</Button>
    </div>}
  </>
}

/** 使用服务端状态；问题单独优先显示，旧宿主缺字段时只声明未结束。 */
function TaskListRow({ task, onOpen, t, stale = false }: { task: TaskRow; onOpen: (id: string) => void; t: T; stale?: boolean }) {
  const descriptionId = useId()
  const question = !task.ended && task.needsAnswer ? task.questionPreview : undefined
  const activity = task.activity && activityViews[task.activity]
  const label = task.ended ? t(`outcome.${task.ended.outcome}`)
    : task.needsAnswer ? t('task.question')
      : task.activity === 'unknown' ? t('task.statusUnknown') : t(activity?.[0] ?? 'task.openState')
  const resultNotice = task.ended?.outcome === 'completed' && !stale
    ? task.resultAvailability === 'unavailable' ? 'task.resultUnavailable'
      : task.resultAvailability === 'unknown' ? 'task.resultUnconfirmed' : undefined
    : undefined
  const state = task.ended ? resultNotice ? 'warning' : 'idle' : task.needsAnswer ? 'warning'
    : task.activity === 'running' ? stale ? 'idle' : 'ongoing'
      : ['attention', 'review', 'unknown'].includes(task.activity) ? 'warning' : 'idle'
  const reason = !task.ended && !task.needsAnswer && task.activity === 'attention'
    && task.attentionReason && Object.hasOwn(attentionHints, task.attentionReason) ? attentionHints[task.attentionReason] : undefined
  return <li className="dt-row dt-link">
    <Dot state={state} label={resultNotice ? `${label} · ${t(resultNotice)}` : label} />
    <div className="dt-row-main">
      <div className="dt-row-title"><button type="button" className="dt-open" aria-describedby={question || resultNotice ? descriptionId : undefined}
        onClick={() => onOpen(task.ticketId)}>{task.title}</button></div>
      {question && <p id={descriptionId} className="dt-task-question-preview">{question.text}
        {question.truncated && <span>… <span className="dt-row-meta">{t('task.questionExcerpt')}</span></span>}
      </p>}
      <div className="dt-row-meta"><span>{label}</span>
        {reason && <span>{t(reason)}</span>}
        {resultNotice && <span id={descriptionId}>{t(resultNotice)}</span>}
        {!task.ended && !!task.pendingDelivery && <span>{t('task.inputCount', { count: task.pendingDelivery })}</span>}
        <When at={task.updatedAt} /></div>
    </div>
  </li>
}

/** 每次只保留当前页的读取；翻页重建此组件，旧响应和旧错误不能进入新页。 */
function TaskDirectoryPage({ filter, search, before, pageNumber, focus, onPrevious, onNext, onOpen, onFilter, filterFocus }: {
  filter: TaskFilter; search: string; before?: string; pageNumber: number; focus: boolean
  onPrevious?: () => void; onNext: (cursor: string) => void; onOpen: (id: string) => void
  onFilter: (filter: TaskFilter) => void
  filterFocus: { current: TaskFilter | undefined }
}) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tasks', {
    query: { state: filter, before, limit: 50, ...(search ? { q: search } : {}) },
    headers: { 'x-orchestrator-task-view': 'questions' },
  }), [filter, search, before])
  const pageStart = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (filterFocus.current !== filter) return
    pageStart.current?.querySelector<HTMLButtonElement>('.dt-filters button[aria-pressed="true"]')?.focus()
    filterFocus.current = undefined
  }, [filter, filterFocus])
  // 只在用户翻页后移交焦点；轮询不抢走输入或键盘焦点。
  useEffect(() => {
    if (!focus) return
    pageStart.current?.focus({ preventScroll: true })
    pageStart.current?.scrollIntoView?.({ block: 'start' })
  }, [focus])
  return <div ref={pageStart} tabIndex={-1} role="region" aria-label={t('task.pageNumber', { number: pageNumber })}>
    <div className="dt-filters">{LOCAL_TASK_FILTERS.map(value =>
      <Pill key={value} active={filter === value} onClick={() => { if (filter !== value) onFilter(value) }}>
        {t(`task.filter.${value}`)}
        {value === 'needs_answer' && filter !== value && data?.hasQuestions === true && !error
          && <Dot state="warning" label={t(search ? 'task.questionsInSearch' : 'task.questionsAvailable')} />}
      </Pill>)}</div>
    <TaskReadState error={error} loading={!data} reload={reload} />
    {error && data && <Hint>{t('task.staleStatus')}</Hint>}
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(task =>
      <TaskListRow key={task.ticketId} task={task} onOpen={onOpen} t={t} stale={!!error} />)}</ul>
      : <Hint>{t(before ? 'task.emptyPage' : search ? 'task.searchNone' : filter === 'needs_answer' ? 'task.noQuestions' : 'none')}</Hint>)}
    {(onPrevious || data?.nextBefore || focus) && <nav className="dt-actions" aria-label={t('task.pages')}>
      <Button variant="outline" size="sm" title={t('task.previousPage')} aria-label={t('task.previousPage')}
        icon={<Icon name="chevron-left" size={14} />} disabled={!onPrevious} onClick={onPrevious} />
      <span>{t('task.pageNumber', { number: pageNumber })}</span>
      <Button variant="outline" size="sm" title={t('task.nextPage')} aria-label={t('task.nextPage')}
        icon={<Icon name="chevron-right" size={14} />} disabled={!data?.nextBefore || !!error}
        onClick={() => { if (data?.nextBefore && !error) onNext(data.nextBefore) }} />
    </nav>}
  </div>
}

/** 筛选切换仅重建目录，创建草稿留在外层；历史只存游标，不复制任务或后台轮询旧页。 */
function TaskDirectory({ filter, search, onOpen, paging, onPaging, onFilter, filterFocus }: {
  filter: TaskFilter; search: string; onOpen: (id: string) => void; paging: TaskPaging; onPaging: (paging: TaskPaging) => void
  onFilter: (filter: TaskFilter) => void
  filterFocus: { current: TaskFilter | undefined }
}) {
  const before = paging.cursors.at(-1)
  return <TaskDirectoryPage key={before ?? ''} filter={filter} search={search} before={before}
    pageNumber={paging.cursors.length + 1} focus={paging.visited} onOpen={onOpen} onFilter={onFilter} filterFocus={filterFocus}
    onPrevious={before ? () => onPaging({ cursors: paging.cursors.slice(0, -1), visited: true }) : undefined}
    onNext={cursor => onPaging({ cursors: [...paging.cursors, cursor], visited: true })} />
}

function TaskList({ onOpen, filter, paging, onPaging, draft, onDraft, optionsOpen, onOptionsOpen, search, onSearch }: {
  onOpen: (id: string) => void; filter: TaskFilter; paging: TaskPaging; onPaging: (paging: TaskPaging) => void
  draft: TaskDraft; onDraft: Dispatch<SetStateAction<TaskDraft>>
  optionsOpen: boolean; onOptionsOpen: (open: boolean) => void
  search: TaskSearch; onSearch: Dispatch<SetStateAction<TaskSearch>>
}) {
  const { t, call, navigate } = usePanel()
  const { state } = usePanelData()
  const searchForm = useRef<HTMLFormElement>(null)
  const filterFocus = useRef<TaskFilter>()
  const searchScopeId = useId()
  const searchChanged = search.text.trim() !== search.query
  const storageKey = taskCreationKey(state!.masterId, state!.setup.machine.stateDir)
  const [pendingCreation, setPendingCreation] = useState(() => readTaskCreation(storageKey))
  const creationAttempt = pendingCreation.submission
  const [storageFailed, setStorageFailed] = useState(false)
  const storageProblem = pendingCreation.status !== 'ready' ? pendingCreation.status : storageFailed ? 'unavailable' : undefined
  const goal = creationAttempt?.goal ?? draft.goal
  const title = creationAttempt ? creationAttempt.title ?? '' : draft.title
  const mode = creationAttempt?.mode ?? draft.mode
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const create = useAction(async () => {
    const current = readTaskCreation(storageKey)
    // 其他面板可能已保存提交；先展示原文，须由用户再次确认，不能借本次点击发送。
    if (current.status !== 'ready' || (current.submission && !sameTaskCreation(current.submission, creationAttempt))) {
      restoreCreation(current)
      return
    }
    const submission = creationAttempt ?? {
      requestId: requestId(), title: title.trim() || undefined, goal: goal.trim(), mode,
    }
    if (!saveTaskCreation(storageKey, submission)) { setStorageFailed(true); return }
    setPendingCreation({ status: 'ready', submission })
    // 发送后由原提交身份接管；迟到成功不能让已发送目标重新变成可创建的草稿。
    const transferredDraft: TaskDraft = { goal: '', title: '', mode: submission.mode }
    onDraft(transferredDraft)
    let created
    try {
      created = await call('POST tasks', { body: submission })
    } catch (failure) {
      // 只有宿主的校验拒绝或创建前暂停/未就绪才能解除快照；网络错误不证明工单没有创建。
      if (failure instanceof ApiError && !failure.details.unreachable
        && ((failure.status === 400 && failure.issues.length > 0)
          || (failure.status === 409 && ['paused', 'runtime_unavailable'].includes(failure.details.code ?? '')))) {
        const cleared = clearTaskCreation(storageKey, submission)
        // 只恢复本次转交后未被替代的草稿，旧拒绝不能覆盖后来编辑或另一请求的结果。
        if (cleared) onDraft(current => current === transferredDraft
          ? { goal: submission.goal, title: submission.title ?? '', mode: submission.mode } : current)
        if (mounted.current) {
          if (cleared) setPendingCreation({ status: 'ready' })
          else setStorageFailed(true)
        }
      }
      throw failure
    }
    // 成功状态码没有有效任务回执时，仍保留原提交身份。
    if (!created || typeof created.ticketId !== 'string' || !created.ticketId.trim())
      throw new Error(t('task.creationUnconfirmed'))
    const cleared = clearTaskCreation(storageKey, submission)
    // 离开页面后不让迟到的创建回执抢回导航。
    if (!mounted.current) return
    if (!cleared) { setStorageFailed(true); return }
    setPendingCreation({ status: 'ready' })
    navigate({ page: 'tasks', id: created.ticketId })
  })
  function restoreCreation(saved: PendingTaskCreation = readTaskCreation(storageKey)) {
    // 浏览器记录消失不证明原请求失败；本页仍持有的未知提交不能因此换号。
    setPendingCreation({ ...saved, submission: saved.submission ?? creationAttempt })
    setStorageFailed(false)
    if (saved.status === 'ready' && saved.submission) {
      onDraft({ ...draft, goal: saved.submission.goal, title: saved.submission.title ?? '', mode: saved.submission.mode })
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void create.run() }
  const creationLocked = create.busy || !!creationAttempt || !!storageProblem
  return <>
    <div className="dt-page-head"><div className="dt-page-title"><h2>{t('tab.tasks')}</h2></div></div>
    <Section title={t('task.create')}>
      {state?.paused && <Hint>{t('task.pausedCreate')}</Hint>}
      <form className="dt-form dt-task-form" onSubmit={submit}>
        <label className="dt-field"><span>{t('task.goal')}</span>
          <textarea className="dt-textarea" rows={3} maxLength={2000} required value={goal}
            onChange={event => onDraft({ ...draft, goal: event.target.value })} disabled={creationLocked || state?.paused} />
        </label>
        <DisclosureRow icon={<Icon name="settings" size={14} />} title={t('task.optionalSettings')}
          open={optionsOpen} onToggle={() => onOptionsOpen(!optionsOpen)}>
          <div className="dt-disclosure-body dt-task-options">
            <label className="dt-field"><span>{t('task.title')}</span>
              <Input value={title} maxLength={160} onChange={event => onDraft({ ...draft, title: event.target.value })}
                disabled={creationLocked || state?.paused} />
            </label>
            <SegmentedControl<TaskMode> label={t('task.modeLabel')} value={mode} disabled={creationLocked || state?.paused}
              onChange={mode => onDraft({ ...draft, mode })} options={[
                { value: 'single', label: t('task.single') }, { value: 'multi', label: t('task.multi') },
              ]} />
          </div>
        </DisclosureRow>
        <div className="dt-actions">
          <Button variant="primary" type="submit" disabled={create.busy || !!storageProblem || (!!state?.paused && !creationAttempt) || !goal.trim()}
            icon={<Icon name={creationAttempt ? 'refresh' : 'plus'} size={14} />}>
            {t(creationAttempt && !create.busy ? 'task.confirmCreation' : 'task.create')}</Button>
          {create.busy && <Hint>{t('loading')}</Hint>}
        </div>
        {storageProblem && <div role="alert">
          <Hint>{t(storageProblem === 'invalid' ? 'task.creationStorageInvalid' : 'task.creationStorageUnavailable')}</Hint>
          <div className="dt-actions">
            <Button variant="outline" icon={<Icon name="refresh" size={14} />} onClick={() => restoreCreation()}>
              {t('task.reload')}</Button>
            {pendingCreation.status === 'invalid' && <ConfirmButton variant="outline" icon="trash"
              label={t('task.clearCreationRecord')} title={t('task.clearCreationRecord')}
              message={t('task.clearCreationRecordConfirm')} onConfirm={async () => {
                if (!clearTaskCreation(storageKey, pendingCreation.raw)) {
                  restoreCreation()
                  throw new Error(t('task.creationStorageUnavailable'))
                }
                restoreCreation()
              }} />}
          </div>
        </div>}
        {creationAttempt && !create.busy && <Hint>{t('task.creationUnconfirmed')}</Hint>}
      </form>
    </Section>
    <Section title={t('task.list')}>
      <form ref={searchForm} role="search" aria-label={t('task.search')} className="dt-task-search"
        onSubmit={event => {
          event.preventDefault()
          onSearch(current => current.query === current.text.trim() ? current : { ...current, query: current.text.trim() })
        }}>
        <Input value={search.text} maxLength={100} enterKeyHint="search" aria-label={t('task.search')}
          aria-describedby={searchChanged ? searchScopeId : undefined}
          placeholder={t('task.searchPlaceholder')} onChange={event => onSearch({ ...search, text: event.target.value })} />
        <Button variant="outline" size="sm" type="submit" icon={<Icon name="search" size={14} />}
          title={t('task.search')} aria-label={t('task.search')} disabled={search.text.trim() === search.query} />
        <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />}
          title={t('task.searchClear')} aria-label={t('task.searchClear')} disabled={!search.text && !search.query}
          onClick={() => {
            onSearch({ text: '', query: '' })
            searchForm.current?.querySelector('input')?.focus()
          }} />
      </form>
      {searchChanged && <p id={searchScopeId} className="dt-hint dt-task-search-scope">
        {t(search.query ? 'task.searchScope' : 'task.searchScopeAny', {
          state: t(`task.filter.${filter}`), query: search.query,
        })}
      </p>}
      <TaskDirectory key={JSON.stringify([filter, search.query])} filter={filter} search={search.query}
        onOpen={onOpen} paging={paging} onPaging={onPaging} filterFocus={filterFocus}
        onFilter={value => { filterFocus.current = value; navigate({ page: 'tasks', query: { filter: value } }, true) }} />
    </Section>
  </>
}

function TaskQuestion({ id, question, onAnswered, readFailed, draft, captureFocus, savedFocus }: {
  id: string; question: NonNullable<TaskStatus['question']>
  onAnswered: (receipt?: LocalTaskInputView, questionId?: string) => Promise<boolean>; readFailed: boolean
  draft: { current: AnswerDraft | undefined }
  captureFocus: ReturnType<typeof useInputFocus>
  savedFocus: { current: HTMLElement | null }
}) {
  const { t, call, notify } = usePanel()
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<number | 'other' | null>(null)
  const [previous, setPrevious] = useState(() => draft.current?.questionId !== question.id ? draft.current : undefined)
  const [previousOpen, setPreviousOpen] = useState(false)
  const answerField = useRef<HTMLTextAreaElement>(null)
  const answerForm = useRef<HTMLFormElement>(null)
  const restoring = useRef(false)
  useEffect(() => {
    if (restoring.current) {
      const target = answerField.current ?? answerForm.current?.querySelector<HTMLInputElement>('input[type="radio"]')
      target?.focus()
      restoring.current = false
    }
  }, [previous, selected])
  const choices = question.choices?.length ? question.choices : undefined
  const answerText = choices && typeof selected === 'number' ? choices[selected]! : text.trim()
  const remember = (nextText: string, nextSelected: typeof selected) => {
    const value = choices && typeof nextSelected === 'number' ? choices[nextSelected]! : nextText
    draft.current = value.trim() ? { questionId: question.id, question: question.text, text: value } : previous
  }
  const discardPrevious = () => {
    if (draft.current?.questionId === previous?.questionId) draft.current = undefined
    restoring.current = true
    setPrevious(undefined)
  }
  const answerAttempt = useRef<TextSubmission>()
  const pendingFocus = useRef<() => void>()
  const [sent, setSent] = useState(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pendingFocus.current?.() } }, [])
  const answer = useAction(async () => {
    let receipt: LocalTaskInputView | undefined
    if (!sent) {
      // 原文重试复用身份；改答属于新提交，仍由问题身份防止覆盖已保存的答案。
      const attempt = answerAttempt.current = textSubmission(answerAttempt.current, answerText)
      const finishFocus = pendingFocus.current = captureFocus(answerForm.current, savedFocus)
      try {
        const saved = await call('POST tasks/:id/inputs', { id, headers: { 'x-orchestrator-task-view': 'state' }, body: {
          requestId: attempt.requestId, text: attempt.text, questionId: question.id,
        } })
        // 问题替换或离页后不把旧回执反馈到新问题，也不触发旧页面重读。
        if (!mounted.current) return
        if (!confirmsInput(saved, id)) throw new Error(t('task.answerUnconfirmed'))
        receipt = saved
        finishFocus(true)
        if (draft.current?.questionId === question.id) draft.current = undefined
        setPrevious(undefined)
        setSent(true)
        notify(t('task.answerSaved'))
      } catch (failure) {
        if (!mounted.current) return
        // 重读可能关闭问题；同页仍需知道改答未保存，但旧任务页离开后不再提示。
        if (failure instanceof ApiError && failure.status === 409 && !await onAnswered()) return
        throw failure
      } finally { finishFocus(); pendingFocus.current = undefined }
    }
    if (mounted.current) await onAnswered(receipt, question.id)
  })
  return <Section title={t('task.question')}>
    <p className="dt-event-text">{question.text}</p>
    {previous && <DisclosureRow icon={<Icon name="history" size={14} />} title={t('task.previousAnswer')}
      open={previousOpen} onToggle={() => setPreviousOpen(open => !open)}>
      <div className="dt-disclosure-body dt-form">
        <p className="dt-hint">{previous.question}</p>
        <p className="dt-event-text">{previous.text}</p>
        <div className="dt-actions">
          <Button variant="outline" size="sm" disabled={answer.busy || sent || !!answerText}
            onClick={() => {
              const nextSelected = choices ? 'other' : null
              restoring.current = true
              setText(previous.text); setSelected(nextSelected); remember(previous.text, nextSelected)
              setPrevious(undefined)
            }}>{t('task.usePreviousAnswer')}</Button>
          <Button variant="ghost" size="sm" onClick={discardPrevious}>{t('task.discardPreviousAnswer')}</Button>
        </div>
        {!!answerText && <Hint>{t('task.previousAnswerOccupied')}</Hint>}
      </div>
    </DisclosureRow>}
    {sent ? <Hint>{t('task.answerSaved')}</Hint> : <form ref={answerForm} className="dt-form dt-task-form"
      onSubmit={event => { event.preventDefault(); void answer.run() }}>
      {choices && <fieldset className="dt-question-choices" disabled={answer.busy}>
        <legend>{t('task.answer')}</legend>
        {[...choices, t('task.answerOther')].map((choice, index) => {
          const value = index === choices.length ? 'other' : index
          return <label className="dt-question-choice" key={index}>
            <input type="radio" name={`answer-${question.id}`} checked={selected === value}
              onChange={() => { setSelected(value); remember(text, value) }} />
            <span>{choice}</span>
          </label>
        })}
      </fieldset>}
      {(!choices || selected === 'other') && <label className="dt-field"><span>{choices ? t('task.answerOther') : t('task.answer')}</span>
        <textarea ref={answerField} className="dt-textarea" rows={2} maxLength={4000} required value={text} disabled={answer.busy}
          onChange={event => { setText(event.target.value); remember(event.target.value, selected) }} />
      </label>}
      <div className="dt-actions"><Button variant="primary" icon={<Icon name="review" size={14} />}
        type="submit" disabled={answer.busy || !answerText}>{t('task.sendAnswer')}</Button></div>
    </form>}
    {sent && !readFailed && <Button variant="outline" disabled={answer.busy} onClick={() => void answer.run()}
      icon={<Icon name="refresh" size={14} />}>{t('task.reload')}</Button>}
  </Section>
}

function LastAnswer({ receipt }: { receipt: NonNullable<TaskStatus['lastAnswer']> }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  return <div className="dt-task-context"><DisclosureRow icon={<Icon name="review" size={14} />}
    title={<><span>{t('task.lastAnswer')}</span><span className="dt-row-meta"><When at={receipt.at} /></span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('task.answeredQuestion')}</Hint>
      <p className="dt-event-text">{receipt.question.text}</p>
      <Hint>{t('task.savedAnswer')}</Hint>
      <p className="dt-event-text">{receipt.answer.text}</p>
      {(receipt.question.truncated || receipt.answer.truncated) && <Hint>{t('task.answerExcerpt')}</Hint>}
    </div>
  </DisclosureRow></div>
}

/** 目标读取独立于执行进度；只在用户展开时读取，计划改版或离页后忽略旧回执。 */
function TaskGoal({ id, planVersion, onChanged }: { id: string; planVersion: number; onChanged: () => Promise<void> }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState<LocalTaskGoalView>()
  const [error, setError] = useState<Error>()
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const read = useAction(async () => {
    setError(undefined)
    try {
      const next = await call('GET tasks/:id/goal', { id, query: { planVersion } })
      if (mounted.current) setGoal(next)
    } catch (failure) {
      if (!mounted.current) return
      setError(failure instanceof Error ? failure : new Error(String(failure)))
      if (failure instanceof ApiError && failure.status === 409) {
        setGoal(undefined)
        await onChanged()
      }
    }
  })
  return <DisclosureRow icon={<Icon name="review" size={14} />} title={t('task.currentGoal')}
    open={open} onToggle={() => {
      setOpen(!open)
      if (!open && !goal) void read.run()
    }}>
    <div className="dt-disclosure-body">
      <LoadState error={error} loading={read.busy && !goal} />
      {goal && <p className="dt-event-text">{goal.text}</p>}
      {error && <div className="dt-actions"><Button variant="outline" size="sm"
        icon={<Icon name="refresh" size={14} />} disabled={read.busy} onClick={() => void read.run()}>
        {t('task.reload')}</Button></div>}
    </div>
  </DisclosureRow>
}

/** 最近修订按计划版本读取；统计仅说明影响范围，不参与派发、恢复或验收。 */
function TaskPlanChange({ id, planVersion, onChanged }: { id: string; planVersion: number; onChanged: () => Promise<void> }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [change, setChange] = useState<LocalTaskPlanChangeView>()
  const [error, setError] = useState<Error>()
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const read = useAction(async () => {
    setError(undefined)
    try {
      const next = await call('GET tasks/:id/plan-change', { id, query: { planVersion } })
      if (mounted.current) setChange(next)
    } catch (failure) {
      if (!mounted.current) return
      setError(failure instanceof Error ? failure : new Error(String(failure)))
      if (failure instanceof ApiError && failure.status === 409) {
        setChange(undefined)
        await onChanged()
      }
    }
  })
  const rows = change ? (['added', 'removed', 'changed', 'affected'] as const)
    .filter(kind => change[kind] > 0).map<[string, number]>(kind => [t(`task.planChange.${kind}`), change[kind]]) : []
  return <DisclosureRow icon={<Icon name="review" size={14} />} title={t('task.planChange')}
    open={open} onToggle={() => {
      setOpen(!open)
      if (!open && !change) void read.run()
    }}>
    <div className="dt-disclosure-body">
      <LoadState error={error} loading={read.busy && !change} />
      {change && <>
        <span className="dt-row-meta"><When at={change.at} /></span>
        <p className="dt-event-text">{change.reason}</p>
        {rows.length > 0 && <div className="dt-row-meta">{rows.map(([label, value]) =>
          <LabelValue key={label} label={label} value={value} />)}</div>}
        {!!change.affectedSteps?.items.length && <>
          <Hint>{t('task.planChange.affectedSteps')}</Hint>
          <ul className="dt-list dt-task-plan-impact" aria-label={t('task.planChange.affectedSteps')}>
            {change.affectedSteps.items.map((title, index) => <li className="dt-row" key={index}>
              <div className="dt-row-main"><div className="dt-row-title">{title}</div></div>
            </li>)}
          </ul>
        </>}
        {!!change.affectedSteps?.omitted && <Hint>{t('task.planChange.omittedSteps', {
          count: change.affectedSteps.omitted,
        })}</Hint>}
      </>}
      {error && <div className="dt-actions"><Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
        disabled={read.busy} onClick={() => void read.run()}>{t('task.reload')}</Button></div>}
    </div>
  </DisclosureRow>
}

/** 页身份与连续游标确认后才展示；旧宿主可省略偏移回显，不固定合法页长。 */
function confirmsResultSources(value: unknown, id: string, revision: number, count: number, offset: number,
  seen: ReadonlySet<string>): value is LocalTaskResultSourcesView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const page = value as LocalTaskResultSourcesView
  if (page.ticketId !== id || page.revision !== revision || page.total !== count
    || !Array.isArray(page.items) || !page.items.length
    || (Object.hasOwn(page, 'offset') && page.offset !== offset)) return false
  const end = offset + page.items.length
  if (end > count || page.nextOffset !== (end < count ? end : null)) return false
  const identities = new Set(seen)
  for (const item of page.items) {
    if (!item || typeof item !== 'object' || typeof item.nodeId !== 'string' || !item.nodeId.trim()
      || identities.has(item.nodeId) || typeof item.title !== 'string' || !item.summary
      || typeof item.summary.text !== 'string' || typeof item.summary.truncated !== 'boolean') return false
    identities.add(item.nodeId)
  }
  return true
}

/** 仅用户展开后读取有界成果节选；任务版本变化重建此组件，离页后不反馈旧请求。 */
function ResultSources({ id, revision, count, onChanged, onDiscuss, discussDisabled }: {
  id: string; revision: number; count: number; onChanged: () => Promise<void>
  onDiscuss: () => void; discussDisabled: boolean
}) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<LocalTaskResultSourcesView>()
  const [error, setError] = useState<Error>()
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const read = useAction(async () => {
    const offset = page ? page.nextOffset : 0
    if (offset === null) return
    setError(undefined)
    try {
      const next = await call('GET tasks/:id/result-sources', { id, query: { revision, offset } })
      if (!mounted.current) return
      if (!confirmsResultSources(next, id, revision, count, offset, new Set(page?.items.map(item => item.nodeId))))
        throw new Error(t('task.resultSourcesUnconfirmed'))
      setPage(previous => ({ ...next, items: [...(previous?.items ?? []), ...next.items] }))
    } catch (failure) {
      if (!mounted.current) return
      setError(failure instanceof Error ? failure : new Error(String(failure)))
      if (failure instanceof ApiError && failure.status === 409) {
        setPage(undefined)
        await onChanged()
      }
    }
  })
  return <DisclosureRow icon={<Icon name="review" size={14} />}
    title={<><span>{t('task.resultSources')}</span>{' '}<span className="dt-count">{count}</span></>}
    open={open} onToggle={() => {
      setOpen(!open)
      if (!open && !page) void read.run()
    }}>
    <div className="dt-disclosure-body">
      <LoadState error={error} loading={read.busy && !page} />
      {page && <ul className="dt-list dt-task-result-sources" aria-label={t('task.resultSources')}>
        {page.items.map(item => <li className="dt-row" key={item.nodeId}>
          <div className="dt-row-main"><div className="dt-row-title">{item.title}</div>
            <p className="dt-event-text">{item.summary.text}</p></div>
        </li>)}
      </ul>}
      {page?.items.some(item => item.summary.truncated) && <Hint>{t('task.resultSourceExcerpt')}</Hint>}
      {(error || page?.nextOffset != null) && <div className="dt-actions">{error ? <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={read.busy}
        onClick={() => void read.run()}>{t('task.reload')}</Button>
        : page?.nextOffset != null && <Button variant="outline" size="sm" icon={<Icon name="chevron-down" size={14} />}
          disabled={read.busy} onClick={() => void read.run()}>
          {t('task.moreResultSources', { count: page.total - page.items.length })}</Button>}</div>}
      <div className="dt-actions"><Button variant="outline" size="sm" icon={<Icon name="session" size={14} />}
        disabled={discussDisabled} onClick={onDiscuss}>{t('task.openOrchestrator')}</Button></div>
    </div>
  </DisclosureRow>
}

function TaskDetail({ id, entry }: { id: string; entry?: TaskEntry }) {
  const { t, call, navigate, openSession, notify } = usePanel()
  const { state } = usePanelData()
  const { data, error, reload, accept } = usePoll(() => call('GET tasks/:id', { id }), [id])
  const entryTitle = useRef<HTMLHeadingElement>(null)
  const inputForm = useRef<HTMLFormElement>(null)
  const answerArea = useRef<HTMLDivElement>(null)
  const contextArea = useRef<HTMLDivElement>(null)
  const captureInputFocus = useInputFocus(entryTitle)
  useEffect(() => {
    if (!entry?.pending) return
    entry.pending = false
    const focused = document.activeElement
    const continues = focused === document.body || focused === entry.source
    entry.source = null
    if (!continues) return
    // 只接续明确的目录打开动作；异步读取与后续轮询不再次移动焦点或滚动。
    entryTitle.current?.focus({ preventScroll: true })
  }, [entry])
  const [text, setText] = useState('')
  // 仅保留本次任务页访问最近填写的一份内容，不持久化或自动用于新问题。
  const answerDraft = useRef<AnswerDraft>()
  const [inputOptionsOpen, setInputOptionsOpen] = useState(false)
  const progressStart = useRef<HTMLUListElement>(null)
  const blockerList = useRef<HTMLUListElement>(null)
  const blockerMore = useRef<HTMLDivElement>(null)
  const recoveryFocus = useRef<{ button: HTMLButtonElement; index: number; confirmed: boolean }>()
  const [blockerPages, setBlockerPages] = useState<{ key: string; items: TaskStatus['workflow']['blockers']['items']; nextOffset: number | null }>()
  // 新服务按列表快照保留阅读位置；旧服务缺少标识时仍按完整版本保守失效。
  const blockerKey = data && (data.workflow.blockers.snapshot
    ? `snapshot:${data.workflow.blockers.snapshot}` : `revision:${data.workflow.revision}`)
  // 每次快照访问使用独立身份；同一标识切走再回来，也不能接收上次访问的在途响应。
  const blockerRead = useRef({ key: blockerKey })
  if (blockerRead.current.key !== blockerKey) blockerRead.current = { key: blockerKey }
  const extraBlockers = blockerPages?.key === blockerKey ? blockerPages : undefined
  const inputAttempt = useRef<TextSubmission>()
  // 同次任务页访问复用定位编号；跨任务或重新挂载才建立新访问，保留 A/B/A 的定位顺序。
  const discussionId = useRef<{ taskId: string; requestId: string }>()
  const discussionTarget = useRef({ id })
  if (discussionTarget.current.id !== id) {
    discussionTarget.current = { id }
    discussionId.current = undefined
  }
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; recoveryFocus.current = undefined }
  }, [])
  const discussion = useAction(async () => {
    const page = discussionTarget.current
    if (discussionId.current?.taskId !== id) discussionId.current = { taskId: id, requestId: requestId() }
    const request = discussionId.current
    try {
      const target = await call('POST tasks/:id/discuss', { id, body: { requestId: request.requestId } })
      // 离开或切到另一任务后，不让迟到响应把用户带回旧会话。
      if (!mounted.current || discussionTarget.current !== page) return
      if (!confirmsDiscussion(target, id, state?.masterId)) throw new Error(t('task.discussionUnconfirmed'))
      await openSession(target.sessionId)
    } catch (failure) {
      // 背景写入仍完成其生命周期；旧访问失败不影响当前页面，当前访问仍可原样重试。
      if (mounted.current && discussionTarget.current === page) throw failure
    }
  })
  const moreBlockers = useAction(async () => {
    if (!data || !blockerKey) return
    const reading = blockerRead.current
    const revision = data.workflow.revision
    const snapshot = data.workflow.blockers.snapshot
    const offset = extraBlockers ? extraBlockers.nextOffset : data.workflow.blockers.items.length
    if (offset === null) return
    try {
      const page = await call('GET tasks/:id/blockers', { id, query: { revision, offset, ...(snapshot ? { snapshot } : {}) } })
      if (!mounted.current || blockerRead.current !== reading) return
      setBlockerPages(previous => ({ key: blockerKey,
        items: [...(previous?.key === blockerKey ? previous.items : []), ...page.items], nextOffset: page.nextOffset }))
    } catch (failure) {
      if (!mounted.current || blockerRead.current !== reading) return
      // 分页冲突只丢弃旧页并重读摘要，不自动用新版本重新请求或执行。
      if (failure instanceof ApiError && failure.status === 409) { setBlockerPages(undefined); await reload() }
      if (mounted.current) throw failure
    }
  })
  const command = useAction(async (value: HmmCommand) => {
    if (!data) return
    // 旧快照仍可阅读和收缩执行；继续工作须先取得一次成功的状态更新。
    if (error && (value.action === 'dispatch' || value.action === 'resume')) return
    try {
      if (value.action === 'resume') {
        const reading = blockerRead.current
        const next = await call('POST tasks/:id/resume', { id, body: { revision: data.workflow.revision, nodeId: value.nodeId } })
        // 命令不因离页撤销，旧回执只停止影响已离开的视图。
        if (!mounted.current) return
        if (blockerRead.current === reading) {
          if (recoveryFocus.current) recoveryFocus.current.confirmed = true
          // 回执到达即让旧分页失效，不等待后续状态重读；新投影只接纳匹配的服务端延续证明。
          blockerRead.current = { key: blockerKey }
          const nextBlockers = next.workflow.blockers
          setBlockerPages(previous => {
            if (!data.workflow.blockers.snapshot || !nextBlockers?.snapshot
              || nextBlockers.continuedFrom !== data.workflow.blockers.snapshot) return undefined
            const known = [...data.workflow.blockers.items, ...(previous && previous.key === blockerKey ? previous.items : [])]
              .filter(blocker => blocker.nodeId !== value.nodeId)
            const seen = new Set<string>()
            const items = [...nextBlockers.items, ...known].filter(blocker => {
              if (seen.has(blocker.nodeId)) return false
              seen.add(blocker.nodeId)
              return true
            }).slice(0, nextBlockers.total)
            const firstPageIds = new Set(nextBlockers.items.map(blocker => blocker.nodeId))
            return { key: `snapshot:${nextBlockers.snapshot}`, items: items.filter(blocker => !firstPageIds.has(blocker.nodeId)),
              nextOffset: items.length < nextBlockers.total ? items.length : null }
          })
        } else recoveryFocus.current = undefined
        // 期间已读到其他变化就重读，不用节点版本推断输入或全局暂停的新旧。
        if (confirmsTaskStatus(next, id) && accept(next, data)) return
      } else {
        const receipt = await call('POST tickets/:id/hmm/commands', { id, body: { revision: data.workflow.revision, command: value } })
        if (!mounted.current) return
        const next = receipt?.task
        // 控制回执与任务投影须绑定同一版本；已有更新或旧宿主缺投影时仍重读，不重放命令。
        if ((value.action === 'dispatch' || value.action === 'hold') && next && confirmsTaskStatus(next, id)
          && receipt.ticketId === id && receipt.revision === data.workflow.revision + 1
          && next.workflow.revision === receipt.revision && next.workflow.planVersion === data.workflow.planVersion
          && next.workflow.phase === receipt.phase && next.workflow.autoRun === (value.action === 'dispatch')
          && accept(next, data)) return
      }
      if (mounted.current) await reload()
    } catch (failure) {
      if (value.action === 'resume') recoveryFocus.current = undefined
      if (!mounted.current) return
      const unconfirmed = controlUnconfirmed(failure)
      // 回执未知或版本冲突只核对事实；读取失败沿用状态待核实与执行限制，不自动重发。
      if (unconfirmed || (failure instanceof ApiError && failure.status === 409)) await reload()
      if (mounted.current) throw unconfirmed ? new Error(t('task.controlUnconfirmed'), { cause: failure }) : failure
    }
  })
  async function readAfterInput(receipt?: LocalTaskInputView, questionId?: string): Promise<boolean> {
    if (!mounted.current) return false
    const next = receipt?.task
    // 回执须明确当前问题状态；并发读取已更新页面时重读，不用工作流版本替代输入新鲜度。
    if (data && next && confirmsTaskStatus(next, id) && next.question !== undefined
      && (!questionId || next.question?.id !== questionId) && accept(next, data)) return true
    await reload()
    return mounted.current
  }
  const input = useAction(async () => {
    const attempt = inputAttempt.current = textSubmission(inputAttempt.current, text)
    const finishFocus = captureInputFocus(inputForm.current, contextArea)
    try {
      const saved = await call('POST tasks/:id/inputs', { id, body: attempt, headers: { 'x-orchestrator-task-view': 'state' } })
      // 离页只停止界面反馈，不取消可能已保存的请求，也不重读已经离开的任务。
      if (!mounted.current) return
      if (!confirmsInput(saved, id)) throw new Error(t('task.contextUnconfirmed'))
      finishFocus(true)
      inputAttempt.current = undefined
      setText('')
      notify(t('task.contextSaved'))
      await readAfterInput(saved)
    } catch (failure) {
      if (mounted.current) throw failure
    } finally { finishFocus() }
  })
  useEffect(() => {
    const pending = recoveryFocus.current
    if (!pending || command.busy) return
    recoveryFocus.current = undefined
    if (!pending.confirmed || error || data?.ended || pending.button.isConnected) return
    // 只接续被移除按钮的焦点；等待期间用户转去输入或其他控件时，不抢回位置。
    if (document.activeElement !== document.body && document.activeElement !== pending.button) return
    const list = blockerList.current, rows = Array.from(list?.children ?? [])
    const nearby = [...rows.slice(pending.index), ...rows.slice(0, pending.index).reverse()]
      .map(row => row.querySelector<HTMLButtonElement>('button:not(:disabled)')).find(Boolean)
    const more = blockerMore.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    const target = nearby ?? more ?? list ?? progressStart.current
    target?.focus({ preventScroll: true })
  }, [data, error, command.busy])
  const submitInput = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void input.run() }
  // 仅可信的计划读取错误允许继续讨论；任务缺失、越权或宿主不可达不能据此推断身份。
  const planReadProblem = error instanceof ApiError && !error.details.unreachable
    ? error.status === 404 && error.details.code === 'workflow_missing' ? 'task.planMissing'
      : error.status === 409 && error.details.code === 'schema_unsupported' ? 'task.planUnsupported' : undefined
    : undefined
  const readError = planReadProblem ? new Error(t(planReadProblem)) : error
  const discussionButton = <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />}
    disabled={!state?.masterId || discussion.busy} onClick={() => void discussion.run()}>
    {t('task.openOrchestrator')}</Button>
  if (!data) return <><PageHead title={t('tab.tasks')} titleRef={entryTitle}>{planReadProblem && discussionButton}</PageHead>
    <TaskReadState error={readError} loading reload={reload} /></>
  const task: TaskStatus = data
  const blockers = [...task.workflow.blockers.items, ...(extraBlockers?.items ?? [])]
  const remainingBlockers = task.workflow.blockers.total - blockers.length
  // 旧宿主未提供依赖摘要时仍可阅读；空投影仅用于渲染，不能据此确认依赖健康。
  const dependencyBlockers = task.workflow.dependencyBlockers ?? { total: 0, omitted: 0, items: [] }
  const active = !task.ended
  // 待回答提示只调整呈现优先级，暂停事实与执行权限仍由原有字段和领域约束维护。
  const needsAnswer = active && !!task.question
  const [activityLabel, activityTone] = activityViews[task.activity] ?? activityViews.unknown
  const blockersNeedOrchestrator = task.workflow.blockers.requiresOrchestrator === undefined
    ? task.activity === 'attention' || task.workflow.blockers.total > 0
    : task.workflow.blockers.requiresOrchestrator
  const dispatchBlocker = task.workflow.dispatchBlocker
  const needsOrchestrator = !!planReadProblem || (task.workflow.requiresOrchestrator
    ?? (task.workflow.awaitingValidation
      || !!dispatchBlocker
      || blockersNeedOrchestrator
      || !task.workflow.dependencyBlockers || dependencyBlockers.total > 0
      || !!task.resultError || task.inputs.pendingDelivery > 0
      || task.workflow.referenceIntegrity === 'invalid'))
  const allNodesSuspended = task.workflow.progress.suspended > 0
    && task.workflow.progress.suspended + task.workflow.progress.pruned === task.workflow.progress.total
  const runningSteps = task.workflow.runningSteps
  // 进行中的问答就近确认保存事实；终态仍优先呈现交付结果，再展示历史回执。
  const savedAnswer = task.lastAnswer && <LastAnswer key={task.lastAnswer.inputId} receipt={task.lastAnswer} />
  return <>
    <PageHead title={task.title} titleRef={entryTitle}>
      {needsOrchestrator && discussionButton}
      {active && task.paused && <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />}
        onClick={() => navigate(settingsRoute('execution'))}>{t('task.openExecutionSettings')}</Button>}
      <Tag tone={error || task.ended ? 'neutral' : needsAnswer ? 'warning' : activityTone}>
        {error ? t('task.statusUnknown') : task.ended ? t(`outcome.${task.ended.outcome}`)
          : needsAnswer ? t('task.question') : t(activityLabel)}
      </Tag>
    </PageHead>
    <TaskReadState error={readError} loading={false} reload={reload} />
    {error && <Hint>{t('task.staleStatus')}</Hint>}
    {task.result && <Section title={t('task.result')}><p className="dt-flow">{task.result.summary}</p>
      {!error && !!task.result.sourceCount && <ResultSources key={`${id}:${task.workflow.revision}`}
        id={id} revision={task.workflow.revision} count={task.result.sourceCount} onChanged={reload}
        onDiscuss={() => void discussion.run()} discussDisabled={!state?.masterId || discussion.busy} />}
    </Section>}
    {task.resultError && <p className="dt-banner dt-danger">{t(Object.hasOwn(resultHints, task.resultError)
      ? resultHints[task.resultError as keyof typeof resultHints] : 'task.resultUnavailable')}</p>}
    <div ref={answerArea} tabIndex={-1} hidden={!(active && (task.question || savedAnswer))}
      className={active && (task.question || savedAnswer) ? 'dt-task-answer' : undefined}
      role={active && (task.question || savedAnswer) ? 'group' : undefined}
      aria-label={active && (task.question || savedAnswer) ? t('task.answer') : undefined}>
      {active && task.question && <TaskQuestion key={task.question.id} id={id} question={task.question}
        draft={answerDraft} onAnswered={readAfterInput} readFailed={!!error} savedFocus={answerArea}
        captureFocus={captureInputFocus} />}
      {active && savedAnswer}
    </div>
    {task.paused && <Hint>{t('task.globallyPaused')}</Hint>}
    {active && !error && !needsAnswer && !needsOrchestrator && task.workflow.autoRun && !task.paused && !state?.paused
      && task.activity === 'waiting' && task.workflow.waitingFor === 'capacity'
      && <Hint>{t('task.capacityWaiting')}</Hint>}
    {task.workflow.planReviewRequired && <Hint>{t('task.planReviewRequired')}</Hint>}
    {!error && task.goalAvailable && <TaskGoal key={`goal:${id}:${task.workflow.planVersion}`}
      id={id} planVersion={task.workflow.planVersion} onChanged={reload} />}
    {!error && task.workflow.planChangeAvailable && <TaskPlanChange key={`plan-change:${id}:${task.workflow.planVersion}`}
      id={id} planVersion={task.workflow.planVersion} onChanged={reload} />}
    <TaskPlan id={id} revision={task.workflow.revision} planVersion={task.workflow.planVersion}
      editable={active && !task.paused && !error} onChanged={reload}
      onDiscuss={() => void discussion.run()} discussDisabled={!state?.masterId || discussion.busy} />
    <TaskQuality key={id} id={id} />
    <Section title={t('task.progress')} count={`${task.workflow.progress.completed}/${task.workflow.progress.total}`}>
      <Progress progress={task.workflow.progress} t={t} stale={!!error} focusRef={progressStart} />
      {active && task.inputs.pendingDelivery > 0 && <Hint>
        {t('task.inputCount', { count: task.inputs.pendingDelivery })}
      </Hint>}
      {active && dispatchBlocker && !error && !task.workflow.blockers.total
        && <Hint>{t(resumeHints[dispatchBlocker] ?? 'task.resumeUnknown')}</Hint>}
      {active && !!runningSteps?.items.length && <>
        <ul className="dt-list dt-task-running" aria-label={t(error ? 'task.previousRunningSteps' : 'task.runningSteps')}>
          {runningSteps.items.map(step => <li className="dt-row" key={step.nodeId}>
            <Dot state={error ? 'idle' : 'ongoing'} label={t(error ? 'task.previousRunningSteps' : 'task.running')} />
            <div className="dt-row-main"><div className="dt-row-title">{step.title}</div></div>
          </li>)}
        </ul>
        {runningSteps.omitted > 0 && <Hint>{t('task.omittedRunningSteps', { count: runningSteps.omitted })}</Hint>}
      </>}
      {active && !task.question && !task.workflow.planReviewRequired && !allNodesSuspended && !task.workflow.awaitingValidation
        && (task.workflow.autoRun || (!dispatchBlocker && !task.workflow.blockers.total)) && <div className="dt-actions">
        {task.workflow.autoRun
          ? <Button variant="outline" icon={<Icon name="pause" size={14} />} disabled={command.busy}
            onClick={() => void command.run({ action: 'hold' })}>{t('task.hold')}</Button>
          : <Button variant="outline" icon={<Icon name="play" size={14} />} disabled={command.busy || task.paused || !!error}
            onClick={() => void command.run({ action: 'dispatch' })}>{t('task.dispatch')}</Button>}
      </div>}
    </Section>
    {task.workflow.blockers.total > 0 && <Section title={t('task.blockers')} count={task.workflow.blockers.total}>
      <ul className="dt-list dt-task-blockers" ref={blockerList} tabIndex={-1} aria-label={t('task.blockers')}>
        {blockers.map((blocker, index) => <li className="dt-row" key={blocker.nodeId}>
        <Dot state="warning" label={t('task.suspended')} />
        <div className="dt-row-main"><div className="dt-row-title">{blocker.title || t('task.blockerItem')}</div>
          <div className="dt-row-meta">{blocker.modelFailureCode
            ? valueLabel(t, 'taskFailure', blocker.modelFailureCode) : blocker.reason}</div>
          {active && blocker.resume !== 'available' && <div className="dt-row-meta">
            {t(resumeHints[blocker.resume as keyof typeof resumeHints] ?? 'task.resumeUnknown')}</div>}
        </div>
        {active && !task.question && blocker.resume === 'available' && <div className="dt-row-actions"><Button variant="outline" size="sm"
          aria-label={t('task.resumeNamed', { title: blocker.title || t('task.blockerItem') })} disabled={command.busy || task.paused || !!error}
          onKeyDown={preventRepeatedEnter}
          icon={<Icon name="play" size={14} />}
          onClick={event => {
            recoveryFocus.current = document.activeElement === event.currentTarget
              ? { button: event.currentTarget, index, confirmed: false } : undefined
            void command.run({ action: 'resume', nodeId: blocker.nodeId })
          }}>{t('task.resume')}</Button></div>}
      </li>)}</ul>
      {remainingBlockers > 0 && extraBlockers?.nextOffset !== null && <div className="dt-actions" ref={blockerMore}>
        <Button variant="outline" size="sm" disabled={moreBlockers.busy || command.busy}
          onKeyDown={preventRepeatedEnter}
          icon={<Icon name="chevron-down" size={14} />} onClick={() => void moreBlockers.run()}>
          {t('task.moreBlockers', { count: remainingBlockers })}</Button>
      </div>}
    </Section>}
    {dependencyBlockers.total > 0 && <Section title={t('task.dependencyBlockers')}
      count={dependencyBlockers.total}>
      <ul className="dt-list dt-task-dependencies">{dependencyBlockers.items.map(blocker => <li className="dt-row" key={blocker.nodeId}>
        <Dot state="warning" label={t('task.blocked')} /><div className="dt-row-main">
          <div className="dt-row-title">{blocker.title || t('task.dependencyStep')}</div>
          <div className="dt-row-meta">{t('task.blockedByCount', {
            count: blocker.blockedBy.length + (blocker.omittedDependencies ?? 0),
          })}</div>
        </div>
      </li>)}</ul>
      {dependencyBlockers.omitted > 0 && <Hint>{t('task.omittedDependencySteps', {
        count: dependencyBlockers.omitted,
      })}</Hint>}
      <Hint>{t('task.dependencyItem')}</Hint>
    </Section>}
    {!active && savedAnswer}
    {(active || task.lastContext) && <div className="dt-task-context" ref={contextArea}
      tabIndex={-1} role="group" aria-label={t('task.context')}>
      <DisclosureRow icon={<Icon name={active ? 'plus' : 'review'} size={14} />}
        title={<><span>{t(active ? 'task.addContext' : 'task.lastContext')}</span>
          {task.lastContext && <span className="dt-row-meta">
            {active && <span>{t('task.lastContext')}</span>}<When at={task.lastContext.at} />
          </span>}
          </>}
        open={inputOptionsOpen} onToggle={() => setInputOptionsOpen(open => !open)}>
        <div className="dt-disclosure-body">
          {task.lastContext && <>
            <Hint>{t('task.lastContext')}</Hint>
            <p className="dt-event-text">{task.lastContext.text}</p>
            {task.lastContext.truncated && <Hint>{t('task.contextExcerpt')}</Hint>}
          </>}
          {active && <form ref={inputForm} className="dt-form dt-task-form" onSubmit={submitInput}>
            <label className="dt-field"><span>{t('task.context')}</span>
              <textarea className="dt-textarea" rows={3} maxLength={4000} required value={text}
                onChange={event => setText(event.target.value)} disabled={input.busy} />
            </label>
            <div className="dt-actions"><Button variant="outline" type="submit" disabled={input.busy || !text.trim()}
              icon={<Icon name="plus" size={14} />}>{t('task.sendContext')}</Button></div>
          </form>}
        </div>
      </DisclosureRow>
    </div>}
    {active && <div className="dt-actions">
      <ConfirmButton variant="outline" icon="stop" label={t('task.stop')} title={t('task.stop')}
        message={t('task.stopConfirm', { title: task.title })}
        onConfirm={async () => {
          try {
            const next = await call('POST tasks/:id/stop', { id })
            if (mounted.current && (!confirmsTaskStatus(next, id) || !accept(next, data))) await reload()
          } catch (failure) {
            if (!mounted.current) return
            const unconfirmed = controlUnconfirmed(failure)
            if (unconfirmed || (failure instanceof ApiError && failure.status === 409)) await reload()
            if (mounted.current) throw unconfirmed ? new Error(t('task.controlUnconfirmed'), { cause: failure }) : failure
          }
        }} />
    </div>}
  </>
}

export function TasksPage({ id, filter = 'open' }: { id?: string; filter?: TaskFilter }) {
  const { navigate } = usePanel()
  const entry = useRef<TaskEntry>()
  // 只在同宿主的任务导航内保留草稿；不写入存储，也不保留离页后的目录轮询。
  const [draft, setDraft] = useState<TaskDraft>({ goal: '', title: '', mode: 'multi' })
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [search, setSearch] = useState<TaskSearch>({ text: '', query: '' })
  const [directory, setDirectory] = useState<{ filter: TaskFilter; search: string; paging: TaskPaging }>(() =>
    ({ filter, search: '', paging: { cursors: [], visited: false } }))
  // 详情没有筛选参数；只在目录实际切换筛选时清除阅读位置，不保留任务副本。
  useEffect(() => {
    if (!id) setDirectory(previous => previous.filter === filter && previous.search === search.query ? previous
      : { filter, search: search.query, paging: { cursors: [], visited: false } })
  }, [id, filter, search.query])
  const paging = directory.filter === filter && directory.search === search.query ? directory.paging : { cursors: [], visited: false }
  return id ? <TaskDetail key={id} id={id} entry={entry.current?.ticketId === id ? entry.current : undefined} />
    : <TaskList filter={filter} paging={paging} onPaging={paging => setDirectory({ filter, search: search.query, paging })}
      draft={draft} onDraft={setDraft}
      search={search} onSearch={setSearch}
      optionsOpen={optionsOpen} onOptionsOpen={setOptionsOpen}
      onOpen={ticketId => {
        entry.current = { ticketId, source: document.activeElement, pending: true }
        navigate({ page: 'tasks', id: ticketId })
      }} />
}
