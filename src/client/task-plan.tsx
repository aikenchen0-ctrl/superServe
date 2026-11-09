import { useEffect, useReducer, useRef, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { DependencyCycleLink } from '../hmm/model.ts'
import { ApiError } from './api.ts'
import { Button, DisclosureRow, Icon, Input, SegmentedControl, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { ConfirmButton, Hint, LoadState } from './widgets.tsx'

type Definition = ApiResponse<'GET tickets/:id/hmm/plan'>
type Plan = Definition['plan']
type Node = Plan['nodes'][number]
type Impact = ApiResponse<'POST tickets/:id/hmm/revisions'>
type Candidate = { revision: number; plan: Plan; reason: string }
type PlanField = 'title' | 'instruction' | 'children' | 'dependencies'
type DraftFrame = { plan?: Plan; selected?: string }
type PlanDraft = {
  current: DraftFrame; past: DraftFrame[]; future: DraftFrame[]; nodeIds: string[]; baseNodeIds: string[]; group?: string
}
type DraftAction = { type: 'load'; plan: Plan } | { type: 'select'; selected?: string }
  | { type: 'change'; update: (plan: Plan) => Plan; selected?: string; group?: string }
  | { type: 'separate' | 'undo' | 'redo' | 'settled' }

/** 仅保留二十次本页编辑，共享未变节点；连续字段输入合为一次，不复制持久状态。 */
function planDraftReducer(state: PlanDraft, action: DraftAction): PlanDraft {
  if (action.type === 'load') {
    const nodeIds = action.plan.nodes.map(node => node.id)
    return { current: { plan: action.plan }, past: [], future: [], nodeIds, baseNodeIds: nodeIds }
  }
  if (action.type === 'select') return { ...state, current: { ...state.current, selected: action.selected }, group: undefined }
  if (action.type === 'separate') return state.group ? { ...state, group: undefined } : state
  if (action.type === 'settled') return { ...state, past: [], future: [], group: undefined }
  if (action.type === 'undo') {
    const previous = state.past.at(-1)
    return previous ? { ...state, current: previous, past: state.past.slice(0, -1),
      future: [...state.future, state.current], group: undefined } : state
  }
  if (action.type === 'redo') {
    const next = state.future.at(-1)
    return next ? { ...state, current: next, past: [...state.past, state.current],
      future: state.future.slice(0, -1), group: undefined } : state
  }
  if (action.type !== 'change' || !state.current.plan) return state
  const plan = action.update(state.current.plan)
  if (plan === state.current.plan) return state
  const past = action.group && action.group === state.group ? state.past : [...state.past, state.current].slice(-20)
  const retained = new Set([...state.baseNodeIds, ...plan.nodes.map(node => node.id),
    ...past.flatMap(frame => frame.plan?.nodes.map(node => node.id) ?? [])])
  return { current: { plan, selected: action.selected ?? state.current.selected },
    past, future: [], group: action.group, baseNodeIds: state.baseNodeIds,
    nodeIds: [...state.nodeIds.filter(id => retained.has(id)),
      ...plan.nodes.filter(node => !state.nodeIds.includes(node.id)).map(node => node.id)] }
}

function confirmsImpact(value: Impact, id: string, revision: number, planVersion: number, applied: boolean) {
  return !!value && value.ticketId === id && value.applied === applied
    && value.revision === revision + Number(applied) && value.planVersion === planVersion + Number(applied)
    && value.candidatePlanVersion === planVersion + 1
    && [value.added, value.removed, value.changed, value.invalidated]
      .every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))
}

/** 只接受当前候选中真实存在、前后相接的闭环；旧宿主或异常诊断保持通用错误。 */
function dependencyCycle(error: Error | undefined, plan: Plan | undefined): DependencyCycleLink[] {
  if (!plan || !(error instanceof ApiError) || error.details.code !== 'dependency_cycle') return []
  const raw = error.details.cycle
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > plan.nodes.length) return []
  const links: DependencyCycleLink[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object' || typeof value.nodeId !== 'string' || typeof value.dependencyId !== 'string'
      || !['explicit', 'serial', 'both'].includes(value.kind)) return []
    const node = plan.nodes.find(item => item.id === value.nodeId)
    const dependency = plan.nodes.find(item => item.id === value.dependencyId)
    if (!node || !dependency || node.id === dependency.id || !node.parentId || dependency.parentId !== node.parentId) return []
    const explicit = node.dependsOn.includes(dependency.id)
    const siblings = plan.nodes.filter(item => item.parentId === node.parentId)
    const serial = plan.nodes.find(item => item.id === node.parentId)?.mode === 'serial'
      && siblings.indexOf(dependency) < siblings.indexOf(node)
    if (!explicit && !serial) return []
    const kind = explicit && serial ? 'both' : explicit ? 'explicit' : 'serial'
    if (value.kind !== kind) return []
    links.push({ nodeId: node.id, dependencyId: dependency.id, kind })
  }
  if (new Set(links.map(link => link.nodeId)).size !== links.length
    || links.some((link, index) => link.dependencyId !== links[(index + 1) % links.length]!.nodeId)) return []
  return links
}

/** 只比较预览绑定的两份定义，不计算成果失效或推断新的执行关系。 */
function PlanChanges({ before, after, label }: { before: Plan; after: Plan; label: (node: Node) => string }) {
  const { t } = usePanel()
  const [open, setOpen] = useState<string>()
  const name = (plan: Plan, id: string) => {
    const node = plan.nodes.find(item => item.id === id)
    return node ? label(node) : t('task.dependencyStep')
  }
  const path = (plan: Plan, id: string | undefined) => {
    const names: string[] = [], seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const node = plan.nodes.find(item => item.id === id)
      if (!node) break
      names.unshift(label(node)); id = node.parentId
    }
    return names.join(' / ') || t('task.plan.topLevel')
  }
  const mode = (value: Node['mode']) => t(value === 'task' ? 'task.plan.step'
    : value === 'serial' ? 'task.plan.serial' : 'task.plan.parallel')
  const nodes = after.nodes.flatMap(node => {
    const original = before.nodes.find(item => item.id === node.id)
    if (!original) return []
    const fields: { key: string; label: string; before: string; after: string }[] = []
    const add = (key: string, label: string, oldValue: unknown, newValue: unknown, oldText: string, newText: string) => {
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
        fields.push({ key, label, before: oldText || t('task.plan.none'), after: newText || t('task.plan.none') })
    }
    add('title', t('task.plan.name'), original.title, node.title, original.title, node.title)
    add('instruction', t('task.plan.instruction'), original.instruction ?? '', node.instruction ?? '',
      original.instruction ?? '', node.instruction ?? '')
    add('mode', t('task.plan.groupMode'), original.mode, node.mode, mode(original.mode), mode(node.mode))
    add('purpose', t('task.plan.purpose'), original.purpose ?? 'reasoning', node.purpose ?? 'reasoning',
      t(original.purpose === 'survey' ? 'task.plan.survey' : 'task.plan.reasoning'),
      t(node.purpose === 'survey' ? 'task.plan.survey' : 'task.plan.reasoning'))
    add('parent', t('task.plan.parent'), original.parentId, node.parentId,
      path(before, original.parentId), path(after, node.parentId))
    add('dependencies', t('task.plan.dependencies'), original.dependsOn, node.dependsOn,
      original.dependsOn.map(id => name(before, id)).join('\n'), node.dependsOn.map(id => name(after, id)).join('\n'))
    const oldChildren = before.nodes.filter(item => item.parentId === node.id).map(item => item.id)
    const newChildren = after.nodes.filter(item => item.parentId === node.id).map(item => item.id)
    add('children', t('task.plan.children'), oldChildren, newChildren,
      oldChildren.map(id => name(before, id)).join('\n'), newChildren.map(id => name(after, id)).join('\n'))
    for (const key of ['evidenceRequired', 'claimsRequired'] as const)
      add(key, t(`task.plan.${key}`), original[key] ?? false, node[key] ?? false,
        t(original[key] ? 'yes' : 'no'), t(node[key] ? 'yes' : 'no'))
    return fields.length ? [{ node, fields }] : []
  })
  if (!nodes.length) return null
  return <div className="dt-task-plan-changes">
    <Hint>{t('task.plan.edits')}</Hint>
    {nodes.map(({ node, fields }) => <DisclosureRow key={node.id} icon={<Icon name="review" size={14} />}
      title={<><span className="dt-task-plan-change-name">{label(node)}</span>
        <span className="dt-row-meta">{fields.map(field => field.label).join(t('listSeparator'))}</span></>}
      open={open === node.id} onToggle={() => setOpen(open === node.id ? undefined : node.id)}>
      <dl className="dt-disclosure-body dt-task-plan-comparison">
        {fields.map(field => <div key={field.key}>
          <dt>{field.label}</dt>
          <dd><span className="dt-row-meta">{t('task.plan.before')}</span><p className="dt-event-text">{field.before}</p></dd>
          <dd><span className="dt-row-meta">{t('task.plan.after')}</span><p className="dt-event-text">{field.after}</p></dd>
        </div>)}
      </dl>
    </DisclosureRow>)}
  </div>
}

/** 编辑稿只在本页保留；预览绑定完整候选与执行版本，应用不隐含继续执行。 */
export function TaskPlan({ id, revision, planVersion, editable, onChanged, onDiscuss, discussDisabled }: {
  id: string; revision: number; planVersion: number; editable: boolean
  onChanged: () => Promise<void>; onDiscuss: () => void; discussDisabled: boolean
}) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [definition, setDefinition] = useState<Definition>()
  const [draft, updateDraft] = useReducer(planDraftReducer, { current: {}, past: [], future: [], nodeIds: [], baseNodeIds: [] })
  const { plan, selected } = draft.current
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<{ candidate: Candidate; impact: Impact }>()
  const [error, setError] = useState<Error>()
  const [conflict, setConflict] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [saved, setSaved] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [baseChanged, setBaseChanged] = useState(false)
  const mounted = useRef(false)
  const pending = useRef(false)
  const latest = useRef({ revision, planVersion, editable })
  const correctionFocus = useRef<{ nodeId: string; field: PlanField }>()
  const editor = useRef<HTMLFieldSetElement>(null)
  const cycleFocus = useRef<Element | null>()
  const cyclePanel = useRef<HTMLDivElement>(null)
  const previewFocus = useRef<Element | null>()
  const previewPanel = useRef<HTMLElement>(null)
  latest.current = { revision, planVersion, editable }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const target = correctionFocus.current
    if (!target || target.nodeId !== selected || !open) return
    correctionFocus.current = undefined
    const field = editor.current?.querySelector<HTMLElement>(`[data-plan-field="${target.field}"]`)
    const control = target.field === 'dependencies' ? field?.querySelector<HTMLElement>('input[aria-invalid="true"]') : field
    const focus = control && !control.matches(':disabled') ? control
      : editor.current?.parentElement?.querySelector<HTMLElement>('.dt-task-plan-title')
    // 定位只由用户点击触发；只读时停在步骤标题，不尝试激活被禁用的编辑控件。
    focus?.focus({ preventScroll: true })
    const location = control ?? editor.current
    location?.scrollIntoView?.({ block: 'center' })
  }, [draft.current, selected, open])
  const stale = !!definition && (definition.revision !== revision || definition.planVersion !== planVersion)
  const dirty = !!definition && !!plan && (JSON.stringify(plan) !== JSON.stringify(definition.plan) || !!reason.trim())
  const pruned = !!definition?.prunedNodeIds.length
  const refreshable = typeof definition?.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(definition.fingerprint)
    && stale && planVersion === definition.planVersion
    && !baseChanged && !uncertain && !saved && !pruned && !readFailed
  const unresolved = plan?.nodes.flatMap(node => {
    const fields: PlanField[] = []
    if (!node.title.trim()) fields.push('title')
    if (node.mode === 'task' && !node.instruction?.trim()) fields.push('instruction')
    if (node.mode !== 'task' && !plan.nodes.some(child => child.parentId === node.id)) fields.push('children')
    if (node.dependsOn.some(id => {
      const dependency = plan.nodes.find(item => item.id === id)
      return !dependency || dependency.parentId !== node.parentId
    })) fields.push('dependencies')
    return fields.map(field => ({ node, field }))
  }) ?? []
  const read = useAction(async () => {
    if (pending.current) return
    pending.current = true
    setError(undefined)
    try {
      const next = await call('GET tickets/:id/hmm/plan', { id })
      if (!mounted.current) return
      if (!next?.plan || !Number.isSafeInteger(next.revision) || next.revision < 1
        || !Number.isSafeInteger(next.planVersion) || next.planVersion < 1
        || !Array.isArray(next.plan.nodes) || !next.plan.nodes.length
        || !Array.isArray(next.prunedNodeIds) || !Array.isArray(next.retiredNodeIds))
        throw new Error(t('task.plan.readUnconfirmed'))
      setDefinition(next); updateDraft({ type: 'load', plan: structuredClone(next.plan) }); setReason('')
      setPreview(undefined); setConflict(false); setUncertain(false); setSaved(false); setReadFailed(false)
      setBaseChanged(false)
      if (next.revision !== revision || next.planVersion !== planVersion) await onChanged()
    } catch (failure) {
      if (!mounted.current) return
      setReadFailed(true); setPreview(undefined)
      setError(failure instanceof Error ? failure : new Error(String(failure)))
    } finally { pending.current = false }
  })
  const refresh = useAction(async () => {
    if (pending.current || !definition || !refreshable || !editable) return
    pending.current = true
    setError(undefined); setPreview(undefined)
    try {
      const next = await call('GET tickets/:id/hmm/plan-identity', { id })
      if (!mounted.current || !latest.current.editable) return
      if (!next || next.ticketId !== id || !Number.isSafeInteger(next.revision) || next.revision < definition.revision
        || !Number.isSafeInteger(next.planVersion) || next.planVersion < 1
        || typeof next.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(next.fingerprint))
        throw new Error(t('task.plan.checkUnconfirmed'))
      if (next.planVersion !== definition.planVersion || next.fingerprint !== definition.fingerprint
        || latest.current.planVersion !== definition.planVersion) {
        setBaseChanged(true); setConflict(true)
      } else if (next.revision < latest.current.revision) {
        throw new Error(t('task.plan.checkAdvanced'))
      } else {
        // 只移动同一计划的执行基线；草稿、原因及编辑历史保持原样，必须重新预览。
        setDefinition({ ...definition, revision: next.revision })
        setConflict(false)
      }
      await onChanged()
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure : new Error(String(failure)))
    } finally { pending.current = false }
  })
  const inspect = useAction(async () => {
    if (pending.current || !definition || !plan || !editable || stale || conflict || uncertain || pruned
      || saved || readFailed || unresolved.length > 0 || !dirty || !reason.trim()) return
    pending.current = true
    const origin = document.activeElement
    const normalized = structuredClone(plan)
    normalized.goal = normalized.goal.trim()
    for (const node of normalized.nodes) {
      node.title = node.title.trim()
      if (node.instruction !== undefined) node.instruction = node.instruction.trim()
    }
    const candidate: Candidate = { revision: definition.revision, plan: normalized, reason: reason.trim() }
    setError(undefined); setPreview(undefined)
    try {
      const impact = await call('POST tickets/:id/hmm/revisions', { id, body: { ...candidate, preview: true } })
      if (!mounted.current) return
      if (!confirmsImpact(impact, id, candidate.revision, definition.planVersion, false))
        throw new Error(t('task.plan.unconfirmed'))
      previewFocus.current = origin
      setPreview({ candidate, impact })
    } catch (failure) {
      if (!mounted.current) return
      if (failure instanceof ApiError && failure.details.code === 'dependency_cycle') cycleFocus.current = origin
      setError(failure instanceof Error ? failure : new Error(String(failure)))
      if (failure instanceof ApiError && failure.status === 409) {
        // 无变化等校验拒绝仍可编辑；只有版本冲突要求用户核对新计划。
        if (failure.details.code === 'revision_conflict') setConflict(true)
        await onChanged()
      }
    } finally { pending.current = false }
  })
  const apply = useAction(async () => {
    if (pending.current || !preview || !editable || stale || conflict || uncertain || pruned || readFailed || saved) return
    pending.current = true
    let confirmed = false
    setError(undefined)
    try {
      const receipt = await call('POST tickets/:id/hmm/revisions', {
        id, body: { ...preview.candidate, preview: false },
      })
      if (!mounted.current) return
      if (!confirmsImpact(receipt, id, preview.candidate.revision, preview.impact.planVersion, true))
        throw new Error(t('task.plan.unconfirmed'))
      confirmed = true
      updateDraft({ type: 'settled' })
      setSaved(true); setPreview(undefined)
      await onChanged()
    } catch (failure) {
      if (!mounted.current) return
      setError(failure instanceof Error ? failure : new Error(String(failure)))
      if (confirmed) return
      setPreview(undefined)
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true)
        await onChanged()
      } else {
        // 响应丢失不能证明没有写入；先重读核对，不用新版本自动重放修订。
        setUncertain(true)
      }
    } finally { pending.current = false }
  })
  const busy = read.busy || refresh.busy || inspect.busy || apply.busy
  const locked = busy || !editable || stale || conflict || uncertain || pruned || readFailed || saved
  const cycle = !stale && !conflict && !uncertain ? dependencyCycle(error, plan) : []
  useEffect(() => {
    if (cycleFocus.current === undefined) return
    const origin = cycleFocus.current
    cycleFocus.current = undefined
    if (cycle.length && (document.activeElement === origin || document.activeElement === document.body))
      cyclePanel.current?.focus()
  }, [error, cycle.length])
  useEffect(() => {
    if (previewFocus.current === undefined) return
    const origin = previewFocus.current
    previewFocus.current = undefined
    // 只接续仍在等待本次提交的焦点；结果过期、面板折叠或用户已转到别处时不定位。
    if (preview && open && !stale && !conflict && !uncertain && editable
      && (document.activeElement === origin || document.activeElement === document.body)) {
      previewPanel.current?.focus({ preventScroll: true })
      previewPanel.current?.scrollIntoView?.({ block: 'start' })
    }
  }, [preview, open, stale, conflict, uncertain, editable])
  // 同名标签沿用本页首次出现的身份顺序，不随重排或撤销改变，也不写入计划定义。
  const titles = new Map<string, Set<string>>()
  for (const node of [...(definition?.plan.nodes ?? []), ...(plan?.nodes ?? [])]) {
    const title = node.title.trim() || t('task.plan.newStep')
    if (!titles.has(title)) titles.set(title, new Set())
    titles.get(title)!.add(node.id)
  }
  const reserved = new Set(titles.keys()), names = new Map<string, Map<string, string>>()
  for (const [title, ids] of titles) {
    const group = new Map<string, string>()
    let index = 0
    for (const id of [...ids].sort((a, b) => draft.nodeIds.indexOf(a) - draft.nodeIds.indexOf(b))) {
      let name = title
      if (ids.size > 1) {
        do { name = t('task.plan.sameName', { title, index: ++index }) } while (reserved.has(name))
        reserved.add(name)
      }
      group.set(id, name)
    }
    names.set(title, group)
  }
  const label = (node: Node | undefined): string => {
    if (!node) return t('task.dependencyStep')
    const title = node.title.trim() || t('task.plan.newStep')
    return names.get(title)?.get(node.id) ?? title
  }
  const setSelected = (selected?: string) => updateDraft({ type: 'select', selected })
  const change = (update: (plan: Plan) => Plan, selected?: string, group?: string) => {
    if (locked || pending.current) return
    setPreview(undefined); setError(undefined)
    updateDraft({ type: 'change', update, selected, group })
  }
  const edit = (nodeId: string, update: Partial<Node>, field?: 'title' | 'instruction') => {
    change(current => {
      const target = current.nodes.find(node => node.id === nodeId)
      if (!target || Object.entries(update).every(([name, value]) => target[name as keyof Node] === value)) return current
      return { ...current, nodes: current.nodes.map(node => node.id === nodeId ? { ...node, ...update } : node) }
    }, undefined, field && `${nodeId}:${field}`)
  }
  const travel = (type: 'undo' | 'redo') => {
    if (locked || pending.current) return
    setPreview(undefined); setError(undefined)
    updateDraft({ type })
  }
  const freshId = (allocated = new Set<string>()) => {
    let next = ''
    do { next = `node_${crypto.randomUUID().replaceAll('-', '')}` }
    while (allocated.has(next) || plan?.nodes.some(node => node.id === next) || definition?.retiredNodeIds.includes(next))
    allocated.add(next)
    return next
  }
  const descendants = (nodeId: string, source = plan): Set<string> => {
    const result = new Set([nodeId])
    if (!source) return result
    let expanded = true
    while (expanded) {
      expanded = false
      for (const node of source.nodes) if (node.parentId && result.has(node.parentId) && !result.has(node.id)) {
        result.add(node.id); expanded = true
      }
    }
    return result
  }
  const groupPath = (node: Node) => {
    const names = [label(node)], visited = new Set([node.id])
    let parentId = node.parentId
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId)
      const parent = plan?.nodes.find(item => item.id === parentId)
      if (!parent) break
      names.unshift(label(parent)); parentId = parent.parentId
    }
    return names.join(' / ')
  }
  const removeNodes = (node: Node): { nodes: Node[]; removed: string[]; detached: number } => {
    if (!plan) return { nodes: [], removed: [], detached: 0 }
    const removed = descendants(node.id)
    const nodes = plan.nodes.filter(item => !removed.has(item.id))
    const detached = plan.nodes.filter(item => !removed.has(item.id))
      .reduce((total, item) => total + item.dependsOn.filter(id => removed.has(id)).length, 0)
    return { nodes, removed: plan.nodes.filter(item => removed.has(item.id)).map(item => item.title), detached }
  }
  const addStep = (parentId: string) => {
    if (!plan || locked || pending.current || stale) return
    const nodeId = freshId()
    const node: Node = { id: nodeId, parentId, title: t('task.plan.newStep'), mode: 'task',
      instruction: '', evidenceRequired: false, claimsRequired: false, dependsOn: [] }
    change(current => ({ ...current, nodes: [...current.nodes, node] }), nodeId)
  }
  const addGroup = (parentId: string) => {
    if (!plan || locked || pending.current || stale) return
    const groupId = freshId()
    const group: Node = { id: groupId, parentId, title: t('task.plan.newGroup'), mode: 'parallel',
      instruction: undefined, evidenceRequired: false, claimsRequired: false, dependsOn: [] }
    change(current => ({ ...current, nodes: [...current.nodes, group] }), groupId)
  }
  const copyLimit = definition?.limits?.nodes
  const canCopy = (node: Node, current = plan) => {
    if (!current?.nodes.find(item => item.id === node.id)?.parentId || typeof copyLimit !== 'number'
      || !Number.isSafeInteger(copyLimit) || copyLimit < 2) return false
    const reserved = new Set([...(definition?.retiredNodeIds ?? []),
      ...(definition?.plan.nodes.map(item => item.id) ?? []), ...current.nodes.map(item => item.id)])
    return reserved.size + descendants(node.id, current).size <= copyLimit
  }
  const copyBranch = (node: Node) => {
    if (!plan || locked || pending.current || !canCopy(node)) return
    const branch = descendants(node.id), source = plan.nodes.filter(item => branch.has(item.id))
    const allocated = new Set<string>(), mapping = new Map(source.map(item => [item.id, freshId(allocated)]))
    const suffix = t('task.plan.copySuffix')
    // 只复制定义；新编号保留分支内部关系，外部消费者仍引用原节点。
    const copied: Node[] = source.map(item => ({
      id: mapping.get(item.id)!, parentId: mapping.get(item.parentId ?? '') ?? item.parentId,
      title: item.id === node.id ? item.title.slice(0, Math.max(0, 160 - suffix.length)) + suffix : item.title,
      mode: item.mode, instruction: item.instruction, evidenceRequired: item.evidenceRequired, claimsRequired: item.claimsRequired,
      ...(item.purpose === 'survey' ? { purpose: item.purpose } : {}),
      dependsOn: item.dependsOn.map(dependency => mapping.get(dependency) ?? dependency),
    }))
    const offset = plan.nodes.findIndex(item => item.id === node.id) + 1
    change(current => canCopy(node, current)
      ? { ...current, nodes: [...current.nodes.slice(0, offset), ...copied, ...current.nodes.slice(offset)] } : current,
      mapping.get(node.id))
  }
  const moveNode = (node: Node, parentId: string) => {
    if (!plan || locked || pending.current || stale || parentId === node.parentId
      || descendants(node.id).has(parentId) || !plan.nodes.some(item => item.id === parentId && item.mode !== 'task')) return
    const moved = { ...node, parentId }
    // 移入目标分组末尾；保留原显式依赖，供操作者核对跨组引用。
    change(current => ({ ...current, nodes: [...current.nodes.filter(item => item.id !== node.id), moved] }))
  }
  const reorder = (node: Node, direction: -1 | 1) => {
    if (!plan) return
    const siblings = plan.nodes.filter(item => item.parentId === node.parentId)
    const other = siblings[siblings.findIndex(item => item.id === node.id) + direction]
    if (!other) return
    const nodes = [...plan.nodes], index = nodes.findIndex(item => item.id === node.id), target = nodes.indexOf(other)
    const moved = nodes[index]!
    nodes[index] = nodes[target]!
    nodes[target] = moved
    change(current => ({ ...current, nodes }))
  }
  const renderNodes = (parentId?: string) => {
    if (!plan) return null
    const siblings = plan.nodes.filter(node => node.parentId === parentId)
    return <ul className="dt-task-plan-tree">{siblings.map((node, index) => <li key={node.id}>
      <div className="dt-task-plan-row">
        <Button variant="ghost" className="dt-task-plan-title" aria-expanded={selected === node.id}
          disabled={busy} onClick={() => setSelected(selected === node.id ? undefined : node.id)}
          icon={<Icon name="settings" size={14} />}>{label(node)}</Button>
        <Tag>{t(node.mode === 'task' ? node.purpose === 'survey' ? 'task.plan.survey' : 'task.plan.step'
          : node.mode === 'serial' ? 'task.plan.serial' : 'task.plan.parallel')}</Tag>
        {siblings.length > 1 && <div className="dt-actions">
          {([-1, 1] as const).map(direction => <Button key={direction} variant="outline" size="sm"
            disabled={locked || (direction < 0 ? index === 0 : index === siblings.length - 1)}
            title={t(direction < 0 ? 'task.plan.moveUp' : 'task.plan.moveDown', { title: label(node) })}
            aria-label={t(direction < 0 ? 'task.plan.moveUp' : 'task.plan.moveDown', { title: label(node) })}
            icon={<Icon name={direction < 0 ? 'chevron-up' : 'chevron-down'} size={14} />}
            onClick={() => reorder(node, direction)} />)}
        </div>}
      </div>
      {selected === node.id && <fieldset ref={editor} className="dt-fieldset dt-task-plan-fields" disabled={locked}
        aria-label={label(node)}>
        <label className="dt-field"><span>{t('task.plan.name')}</span>
          <Input required maxLength={160} value={node.title} data-plan-field="title"
            aria-invalid={!node.title.trim() || undefined} onBlur={() => updateDraft({ type: 'separate' })}
            onChange={event => edit(node.id, { title: event.target.value }, 'title')} />
        </label>
        {node.parentId && <label className="dt-field"><span>{t('task.plan.parent')}</span>
          <select className="dt-select" value={node.parentId} disabled={locked} onChange={event => moveNode(node, event.target.value)}>
            {plan.nodes.filter(group => group.mode !== 'task' && !descendants(node.id).has(group.id)).map((group, index) =>
              <option key={group.id} value={group.id} title={groupPath(group)}>{index + 1}. {groupPath(group)}</option>)}
          </select>
        </label>}
        {node.mode === 'task' && <SegmentedControl<'reasoning' | 'survey'> label={t('task.plan.purpose')}
          value={node.purpose ?? 'reasoning'} disabled={locked}
          onChange={purpose => edit(node.id, { purpose: purpose === 'survey' ? purpose : undefined })}
          options={[{ value: 'reasoning', label: t('task.plan.reasoning') }, { value: 'survey', label: t('task.plan.survey') }]} />}
        {node.mode === 'task' ? <label className="dt-field"><span>{t('task.plan.instruction')}</span>
          <textarea className="dt-textarea" required rows={4} maxLength={4000} value={node.instruction ?? ''}
            data-plan-field="instruction" aria-invalid={!node.instruction?.trim() || undefined}
            onBlur={() => updateDraft({ type: 'separate' })}
            onChange={event => edit(node.id, { instruction: event.target.value }, 'instruction')} />
        </label> : <SegmentedControl<'serial' | 'parallel'> label={t('task.plan.groupMode')} value={node.mode}
          disabled={locked} onChange={mode => edit(node.id, { mode })}
          options={[{ value: 'serial', label: t('task.plan.serial') }, { value: 'parallel', label: t('task.plan.parallel') }]} />}
        {(siblings.length > 1 || node.dependsOn.length > 0)
          && <fieldset className="dt-question-choices" data-plan-field="dependencies">
          <legend>{t('task.plan.dependencies')}</legend>
          {[...new Set([...siblings.filter(item => item.id !== node.id).map(item => item.id), ...node.dependsOn])]
            .map(dependencyId => {
              const dependency = plan.nodes.find(item => item.id === dependencyId)
              const name = label(dependency ?? definition?.plan.nodes.find(item => item.id === dependencyId))
              return <label className="dt-question-choice" key={dependencyId}>
                <input type="checkbox" checked={node.dependsOn.includes(dependencyId)}
                  aria-invalid={!dependency || dependency.parentId !== node.parentId || undefined} onChange={event => edit(node.id, {
                  dependsOn: event.target.checked ? [...node.dependsOn, dependencyId]
                    : node.dependsOn.filter(id => id !== dependencyId),
                })} /><span>{!dependency ? t('task.plan.removedDependency', { title: name })
                  : dependency.parentId !== node.parentId ? t('task.plan.otherGroup', { title: name }) : name}</span>
              </label>
            })}
        </fieldset>}
        {node.mode !== 'task' && <div className="dt-actions">
          <Button variant="outline" size="sm" disabled={locked || stale} data-plan-field="children"
            icon={<Icon name="plus" size={14} />} onClick={() => addStep(node.id)}>{t('task.plan.addStep')}</Button>
          <Button variant="outline" size="sm" disabled={locked || stale}
            icon={<Icon name="plus" size={14} />} onClick={() => addGroup(node.id)}>{t('task.plan.addGroup')}</Button>
        </div>}
        {node.parentId && typeof copyLimit === 'number' && Number.isSafeInteger(copyLimit) && copyLimit >= 2
          && <Button variant="outline" size="sm"
          disabled={locked || !canCopy(node)} icon={<Icon name="plus" size={14} />}
          title={t(canCopy(node) ? 'task.plan.copyHint' : 'task.plan.copyLimit', { limit: copyLimit })}
          onClick={() => copyBranch(node)}>{t('task.plan.copy')}</Button>}
        {node.id !== plan.nodes.find(item => !item.parentId)?.id && <ConfirmButton variant="outline" icon="trash"
          label={t('task.plan.remove')} title={t('task.plan.removeTitle')}
          message={(() => {
            const removal = removeNodes(node)
            return t('task.plan.removeConfirm', { title: label(node), count: removal.removed.length - 1,
              dependencies: removal.detached })
          })()}
          onConfirm={async () => {
            if (locked || stale || pending.current) return
            const removal = removeNodes(node)
            change(current => ({ ...current, nodes: removal.nodes }), node.parentId)
          }} />}
      </fieldset>}
      {node.mode !== 'task' && renderNodes(node.id)}
    </li>)}</ul>
  }
  return <DisclosureRow icon={<Icon name="review" size={14} />} title={t('task.plan.title')}
    open={open} onToggle={() => { setOpen(!open); if (!open && !definition) void read.run() }}>
    <div className="dt-disclosure-body dt-task-plan">
      <LoadState error={error} loading={read.busy && !definition} />
      {cycle.length > 0 && <div ref={cyclePanel} tabIndex={-1} className="dt-task-plan-cycle">
        <Hint>{t('task.plan.cycleHelp')}</Hint>
        <ol className="dt-task-plan-cycle-links" aria-label={t('task.plan.cycleHelp')}>
          {cycle.map(link => <li key={link.nodeId}>
            <p className="dt-event-text">{t(link.kind === 'explicit' ? 'task.plan.cycleExplicit'
              : link.kind === 'serial' ? 'task.plan.cycleSerial' : 'task.plan.cycleBoth', {
              node: label(plan?.nodes.find(node => node.id === link.nodeId)),
              dependency: label(plan?.nodes.find(node => node.id === link.dependencyId)),
            })}</p>
            <div className="dt-actions">{(link.kind === 'both' ? ['explicit', 'serial'] as const : [link.kind]).map(kind =>
              <Button key={kind} variant="outline" size="sm" disabled={locked} onClick={() => {
                const target = kind === 'explicit' ? link.nodeId : plan!.nodes.find(node => node.id === link.nodeId)!.parentId!
                correctionFocus.current = { nodeId: target, field: 'title' }
                setSelected(target)
              }}>{t(kind === 'explicit' ? 'task.plan.inspectStep' : 'task.plan.inspectGroup')}</Button>)}</div>
          </li>)}
        </ol>
      </div>}
      {saved ? <Hint>{t('task.plan.saved')}</Hint> : definition && plan && <>
        {(stale || conflict) && <Hint>{t(baseChanged ? 'task.plan.definitionChanged'
          : refreshable ? 'task.plan.executionChanged' : 'task.plan.changed')}</Hint>}
        {refreshable && <div className="dt-actions"><Button variant="outline" size="sm"
          icon={<Icon name="refresh" size={14} />} disabled={busy || !editable} onClick={() => void refresh.run()}>
          {t('task.plan.checkKeepingDraft')}</Button></div>}
        {uncertain && <Hint>{t('task.plan.unconfirmed')}</Hint>}
        {pruned && <><Hint>{t('task.plan.pruned')}</Hint>
          <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />}
            disabled={discussDisabled} onClick={onDiscuss}>{t('task.openOrchestrator')}</Button></>}
        <form className="dt-form" onSubmit={event => { event.preventDefault(); void inspect.run() }}>
          {renderNodes()}
          {unresolved.length > 0 && <div>
            <Hint>{t('task.plan.needsRepair')}</Hint>
            <ul className="dt-task-plan-issues" aria-label={t('task.plan.needsRepair')}>
              {unresolved.map(({ node, field }) => <li key={`${node.id}:${field}`}><Button variant="ghost" size="sm"
                disabled={busy} onClick={() => {
                  correctionFocus.current = { nodeId: node.id, field }
                  setSelected(node.id)
                }}><span>{t('task.plan.issue', { title: label(node), reason: t(`task.plan.issue.${field}`) })}</span></Button></li>)}
            </ul>
          </div>}
          <label className="dt-field"><span>{t('task.plan.reason')}</span>
            <textarea className="dt-textarea" rows={2} maxLength={500} required disabled={locked} value={reason}
              onChange={event => {
                setReason(event.target.value); updateDraft({ type: 'separate' }); setPreview(undefined); setError(undefined)
              }} />
          </label>
          <div className="dt-actions"><Button variant="outline" type="submit" icon={<Icon name="review" size={14} />}
            disabled={locked || stale || unresolved.length > 0 || !dirty || !reason.trim()}>{t('task.plan.preview')}</Button>
            <div className="dt-task-plan-history" role="group" aria-label={t('task.plan.history')}>
              <Button variant="outline" size="sm" disabled={locked || !draft.past.length} title={t('task.plan.undo')}
                aria-label={t('task.plan.undo')} icon={<Icon name="chevron-left" size={14} />} onClick={() => travel('undo')} />
              <Button variant="outline" size="sm" disabled={locked || !draft.future.length} title={t('task.plan.redo')}
                aria-label={t('task.plan.redo')} icon={<Icon name="chevron-right" size={14} />} onClick={() => travel('redo')} />
            </div>
          </div>
        </form>
        {preview && !stale && !conflict && <section ref={previewPanel} tabIndex={-1}
          aria-label={t('task.plan.previewResult')} className="dt-task-plan-preview">
          <p className="dt-hint">{t('task.plan.consequences')}</p>
          <p className="dt-row-meta">{t('task.plan.impact', {
            added: preview.impact.added.length, removed: preview.impact.removed.length,
            changed: preview.impact.changed.length, affected: preview.impact.invalidated.length,
          })}</p>
          {(['added', 'removed'] as const).filter(kind => preview.impact[kind].length > 0).map(kind => <div key={kind}>
            <Hint>{t(`task.planChange.${kind}`)}</Hint>
            <ul className="dt-task-plan-diff" aria-label={t(`task.planChange.${kind}`)}>
              {preview.impact[kind].map(nodeId => <li key={nodeId}>{
                label((kind === 'removed' ? definition?.plan : preview.candidate.plan)?.nodes.find(node => node.id === nodeId))
              }</li>)}
            </ul>
          </div>)}
          {definition && <PlanChanges before={definition.plan} after={preview.candidate.plan} label={label} />}
          {preview.impact.invalidated.length > 0 && <div>
            <Hint>{t('task.plan.affected')}</Hint>
            <ul className="dt-task-plan-affected" aria-label={t('task.plan.affected')}>
              {preview.impact.invalidated.map(nodeId => <li key={nodeId}>
                {label(preview.candidate.plan.nodes.find(node => node.id === nodeId))}
              </li>)}
            </ul>
          </div>}
          <Button variant="primary" icon={<Icon name="review" size={14} />}
            disabled={busy || !editable} onClick={() => void apply.run()}>{t('task.plan.apply')}</Button>
        </section>}
      </>}
      {(definition || error) && <div className="dt-actions">{dirty && !saved && !busy
        ? <ConfirmButton variant="outline" icon="refresh" label={t('task.plan.reload')} title={t('task.plan.reload')}
          message={t('task.plan.discard')} onConfirm={async () => { await read.run() }} />
        : <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
          disabled={busy} onClick={() => void read.run()}>{t('task.plan.reload')}</Button>}
      </div>}
    </div>
  </DisclosureRow>
}
