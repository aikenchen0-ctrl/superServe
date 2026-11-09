/*!
 * Copyright 2026 Fei2411 and the DS Bot contributors
 * SPDX-License-Identifier: Apache-2.0
 * 改编自 DS-Bot 71d344bf193f3f18185f25de3d8e5c483046910a 的
 * steward.js/shorten 与 parts.js/keptMessages；修改为带原文引用的严格 UTF-8 字节预算，
 * 保留首尾且不切断代理对，不依赖模型、DSH 或额外历史副本。来源与许可见 NOTICE。
 */

export const HANDOFF_INPUT_BYTES = 4096
export interface ContextMessage { ref: string; text: string; chars?: number; truncated?: boolean }
interface KeptMessage extends ContextMessage { chars: number; truncated: boolean }
export interface RecentMessages { messages: KeptMessage[]; omitted: number }
const bytes = (value: RecentMessages) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** 长消息保留要求的开头与纠正的结尾；省略标记属于投影，不改变原文。 */
function shorten(text: string, keep: number): string {
  let head = Math.ceil(keep * 2 / 3), tail = text.length - Math.floor(keep / 3)
  if (head > 0 && /[\uD800-\uDBFF]/.test(text[head - 1]!)) head--
  if (tail < text.length && /[\uDC00-\uDFFF]/.test(text[tail]!)) tail++
  return `${text.slice(0, head)}\n[中间正文已省略，按 ref 读取原文]\n${text.slice(tail)}`
}

/** 输入按旧到新排列；优先保留最新原话，输出仍按时间顺序，计入 JSON 转义和引用开销。 */
export function recentMessages(lines: readonly ContextMessage[], budget = HANDOFF_INPUT_BYTES, earlierOmitted = 0): RecentMessages {
  if (!Number.isSafeInteger(earlierOmitted) || earlierOmitted < 0 || !Number.isSafeInteger(earlierOmitted + lines.length))
    throw new RangeError('历史省略数量必须是非负安全整数')
  const kept: KeptMessage[] = []
  const project = (messages = kept): RecentMessages => ({
    messages: [...messages].reverse(), omitted: earlierOmitted + lines.length - messages.length,
  })
  if (!Number.isSafeInteger(budget) || budget < bytes(project()))
    throw new RangeError('上下文预算不足以容纳省略记录')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    const message = { ref: line.ref, text: line.text, chars: line.chars ?? line.text.length, truncated: line.truncated ?? false }
    if (bytes(project([...kept, message])) <= budget) {
      kept.push(message)
      continue
    }
    if (kept.length) break
    let low = 0, high = line.text.length - 1, best: KeptMessage | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = { ...message, text: shorten(line.text, middle), truncated: true }
      if (bytes(project([candidate])) <= budget) { best = candidate; low = middle + 1 }
      else high = middle - 1
    }
    if (best) kept.push(best)
    break
  }
  return project()
}
