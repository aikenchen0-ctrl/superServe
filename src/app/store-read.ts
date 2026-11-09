/** Read-only Store queries for views, tools, and Source polling. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Decision, Thread, Ticket, Trigger } from '../core/index.ts'
import type { Dropped, Receipt, TimelinePlace } from './store.ts'

export interface LocalTaskRow {
  ticketId: string
  title: string
  createdAt: string
  updatedAt: string
  needsAnswer: boolean
  questionPreview?: { text: string; truncated: boolean }
  pendingDelivery?: number
  ended: Pick<NonNullable<Ticket['ended']>, 'at' | 'by' | 'outcome'> | null
}

export function storeReads(db: DatabaseSync) {
  const values = <T>(sql: string, ...parameters: SQLInputValue[]): T[] => db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  return {
  /** 仅投影本地任务摘要；按不可变的创建顺序翻页，避免加载全部工单及正文。 */
  localTasks: (state: 'open' | 'needs_answer' | 'ended' | 'all', before: string | undefined, limit: number, search?: string,
    preview?: 'question'): LocalTaskRow[] => {
    const needsAnswer = "open = 1 AND json_type(value, '$.attention') = 'object'"
    const stage = state === 'needs_answer' ? 'AND local_question = 1' : state === 'open' ? 'AND open = 1'
      : state === 'ended' ? 'AND open IS NULL' : ''
    const boundary = before ? 'AND rowid < (SELECT rowid FROM ticket WHERE id = ?)' : ''
    const title = search ? "AND json_extract(value, '$.title') LIKE ? ESCAPE '\\'" : ''
    // 名称按字面子串查询，用户输入中的通配符不能扩大范围。
    const pattern = search?.replace(/[\\%_]/g, match => `\\${match}`)
    // 只在面板明确请求时投影当前问题；普通目录和总管发现工具仍不携带正文。
    const question = preview === 'question' ? `, 'questionText',
      CASE WHEN ${needsAnswer} THEN json_extract(value, '$.attention.question') ELSE NULL END` : ''
    return values<LocalTaskRow & { questionText?: unknown }>(`SELECT json_object('ticketId', id,
      'title', json_extract(value, '$.title'), 'createdAt', json_extract(value, '$.createdAt'),
      'updatedAt', json_extract(value, '$.updatedAt'),
      'needsAnswer', json(CASE WHEN ${needsAnswer} THEN 'true' ELSE 'false' END),
      'pendingDelivery', COALESCE(json_array_length(json_extract(value, '$.undelivered')), 0),
      'ended', CASE WHEN open IS NULL THEN json_object('at', json_extract(value, '$.ended.at'),
        'by', json_extract(value, '$.ended.by'), 'outcome', json_extract(value, '$.ended.outcome')) ELSE NULL END
      ${question}) AS value
      FROM ticket WHERE json_extract(value, '$.executionMode') = 'hmm'
        AND json_extract(value, '$.mandate.actor.source') = 'local'
        AND json_extract(value, '$.mandate.basis.via') = 'operator'
        ${stage} ${boundary} ${title} ORDER BY rowid DESC LIMIT ?`,
      ...before ? [before] : [], ...search ? [`%${pattern}%`] : [], limit)
      .map(({ pendingDelivery, questionText, ...row }) => {
        // 节选按 Unicode 码点限长，收起空白；不改变问题原文、身份或回答契约。
        const chars = row.needsAnswer && !row.ended && typeof questionText === 'string'
          ? Array.from(questionText.replace(/\s+/gu, ' ').trim()) : []
        return { ...row, ...(!row.ended && pendingDelivery ? { pendingDelivery } : {}),
          ...(chars.length ? { questionPreview: { text: chars.slice(0, 160).join(''), truncated: chars.length > 160 } } : {}),
        }
      })
  },
  /** 当前名称范围内是否有待答任务；不受目录页游标或历史筛选限制，不读取正文和工作流。 */
  localQuestionsAvailable: (search?: string): boolean => {
    const pattern = search?.replace(/[\\%_]/g, match => `\\${match}`)
    return !!db.prepare(`SELECT 1 FROM ticket WHERE local_question = 1
      ${search ? "AND json_extract(value, '$.title') LIKE ? ESCAPE '\\'" : ''} LIMIT 1`)
      .get(...search ? [`%${pattern}%`] : [])
  },
  /** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
  recentTriggers: (offset = 0, limit = 50): Trigger[] => db.prepare('SELECT value FROM trigger ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Trigger),
  /** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
  triggerStats: (since: string): Record<string, { received: number; filtered: number; lastAt: string }> => {
    const result: Record<string, { received: number; filtered: number; lastAt: string }> = {}
    for (const row of db.prepare("SELECT json_extract(t.value, '$.source') AS source, MAX(t.at) AS last, SUM(t.at >= ?) AS received, SUM(t.at >= ? AND json_extract(d.value, '$.filtered') IS NOT NULL) AS filtered FROM trigger t LEFT JOIN disposition d ON d.id = t.id GROUP BY source").all(since, since))
      result[String(row.source)] = { received: Number(row.received ?? 0), filtered: Number(row.filtered ?? 0), lastAt: String(row.last ?? '') }
    return result
  },
  /**
   * Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
   * and how many accept/reopen decisions those same arrivals produced.
   */
  flow: (since: string): { judged: number; accepted: number } => {
    const passed = "t.at >= ? AND NOT EXISTS (SELECT 1 FROM disposition s WHERE s.id = t.id AND json_extract(s.value, '$.filtered') IS NOT NULL)"
    const judged = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE ${passed}`).get(since)
    const accepted = db.prepare(`SELECT COUNT(DISTINCT d.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE json_extract(d.value, '$.kind') IN ('accept', 'reopen') AND t.at >= ?`).get(since)
    return { judged: Number(judged?.n ?? 0), accepted: Number(accepted?.n ?? 0) }
  },
  triggers: (options: { source?: string; filtered?: boolean }, offset = 0, limit = 50): { items: Trigger[]; more: boolean } => {
    const where = [...(options.source ? ["json_extract(t.value, '$.source') = ?"] : []), ...(options.filtered ? ["json_extract(d.value, '$.filtered') IS NOT NULL"] : [])]
    const rows = db.prepare(`SELECT t.value FROM trigger t LEFT JOIN disposition d ON d.id = t.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.at DESC LIMIT ? OFFSET ?`).all(...(options.source ? [options.source] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Trigger), more: rows.length > limit }
  },
  /** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
  threadTriggers: (threadKeyValue: string, limit = 50, before?: TimelinePlace, through = false): Trigger[] => {
    const place = before ? `AND (x.at, x.id) ${through ? '<=' : '<'} (?, ?)` : ''
    return values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${place}
      ORDER BY x.at DESC, x.id DESC LIMIT ?`, threadKeyValue, ...before ? [before.at, before.id] : [], limit).reverse()
  },
  threadPage: (threadKeyValue: string, offset: number, limit: number): Trigger[] => values(`SELECT t.value FROM trigger_thread x
    JOIN trigger t ON t.id = x.id WHERE x.thread = ? ORDER BY x.at DESC, t.rowid DESC LIMIT ? OFFSET ?`, threadKeyValue, limit, offset),
  /** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
  neighbours: (threadKeyValue: string, at: string, id: string): { before?: Trigger; after?: Trigger } => {
    const nearest = (side: '<' | '>') => values<Trigger>(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id
      WHERE x.thread = ? AND (x.at, x.id) ${side} (?, ?) AND json_extract(t.value, '$.meta.ci') IS NULL
      ORDER BY x.at ${side === '<' ? 'DESC' : 'ASC'}, x.id ${side === '<' ? 'DESC' : 'ASC'} LIMIT 1`, threadKeyValue, at, id)[0]
    const before = nearest('<'), after = nearest('>')
    return { ...before ? { before } : {}, ...after ? { after } : {} }
  },
  /** Oldest trigger on a thread, used to title the thread in listings. */
  firstTrigger: (threadKeyValue: string, humanOnly = false): Trigger | undefined => {
    const row = db.prepare(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${humanOnly ? 'AND x.human = 1' : ''} ORDER BY x.at ASC, t.rowid ASC LIMIT 1`).get(threadKeyValue)
    return row ? JSON.parse(String(row.value)) as Trigger : undefined
  },
  search: (query: string, limit = 20): Trigger[] => {
    const pattern = `%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return db.prepare("SELECT value FROM trigger WHERE id = ? OR json_extract(value, '$.url') LIKE ? ESCAPE '\\' OR json_extract(value, '$.meta.messageId') = ? OR json_extract(value, '$.text') LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?").all(query, `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`, query, pattern, limit).map(row => JSON.parse(String(row.value)) as Trigger)
  },
  recentDecisions: (offset = 0, limit = 50): Decision[] => db.prepare('SELECT value FROM decision ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value)) as Decision),
  /** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
  decisions: (options: { kinds: string[]; since: string }, offset: number, limit: number): { items: Decision[]; more: boolean } => {
    const where = [...(options.kinds.length ? [`json_extract(d.value, '$.kind') IN (${options.kinds.map(() => '?').join(',')})`] : []),
      ...(options.since ? ["EXISTS (SELECT 1 FROM json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ?)"] : [])]
    const rows = db.prepare(`SELECT d.value FROM decision d ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.rowid DESC LIMIT ? OFFSET ?`)
      .all(...options.kinds, ...(options.since ? [options.since] : []), limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as Decision), more: rows.length > limit }
  },
  /** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
  decisionsOfKinds: (kinds: string[], limit = 30): Decision[] => db.prepare(`SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (${kinds.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT ?`).all(...kinds, limit).map(row => JSON.parse(String(row.value)) as Decision),
  /** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
  failingReplies: (): (Receipt & { attempts: number; error: string })[] => db.prepare(`SELECT o.value, e.attempts, e.error FROM effect e
    JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq`).all()
    .map(row => ({ ...JSON.parse(String(row.value)) as Receipt, attempts: Number(row.attempts), error: String(row.error) })),
  droppedReplies: (limit = 20): Dropped[] =>
    values('SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?', limit),
  droppedSince: (since: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE dropped >= ?').get(since)?.n ?? 0),
  subscribedThreads: (source?: string): Thread[] => source
    ? values('SELECT value FROM thread WHERE subscribed = ? ORDER BY rowid', source)
    // Force the partial index so SQLite does not scan the entire table in rowid order.
    : values('SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid'),
  }
}
