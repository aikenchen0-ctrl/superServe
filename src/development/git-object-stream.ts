import { createHash, type Hash } from 'node:crypto'
import { InspectionError } from './git-read.ts'

export interface ObjectMetadata { type: string; size: number; header: string }
export type ObjectPart = { kind: 'start'; oid: string; type: string; size: number }
  | { kind: 'data'; oid: string; data: Buffer } | { kind: 'end'; oid: string }
const invalid = (): never => { throw new InspectionError('invalid_output', 'Git 对象流不完整或与声明内容不一致') }

/** 严格按长度解析 cat-file 帧；仅保留当前头和摘要状态，不积累对象正文。 */
export function objectStream(format: 'sha1' | 'sha256', objects: ReadonlyMap<string, ObjectMetadata>) {
  const expected = objects.entries(), hashes = new Map<string, string>()
  let next = expected.next(), header = Buffer.alloc(0)
  let body: { remaining: number; oid: Hash; content: Hash } | undefined
  let separator = false
  function* parts(chunk: Buffer): Generator<ObjectPart> {
      let offset = 0
      while (offset < chunk.length) {
        if (next.done) invalid()
        if (separator) {
          if (chunk[offset++] !== 10) invalid()
          separator = false
          next = expected.next()
        } else if (body) {
          const count = Math.min(body.remaining, chunk.length - offset)
          const slice = chunk.subarray(offset, offset + count)
          body.oid.update(slice); body.content.update(slice)
          offset += count; body.remaining -= count
          yield { kind: 'data', oid: next.value![0], data: slice }
          if (body.remaining === 0) {
            if (body.oid.digest('hex') !== next.value![0]) invalid()
            hashes.set(next.value![0], body.content.digest('hex'))
            body = undefined
            separator = true
            yield { kind: 'end', oid: next.value![0] }
          }
        } else {
          const end = chunk.indexOf(10, offset)
          const stop = end < 0 ? chunk.length : end
          if (header.length + stop - offset > 128) invalid()
          header = Buffer.concat([header, chunk.subarray(offset, stop)])
          offset = end < 0 ? stop : end + 1
          if (end < 0) continue
          const [, value] = next.value!
          if (!header.equals(Buffer.from(value.header, 'ascii'))) invalid()
          header = Buffer.alloc(0)
          body = { remaining: value.size, oid: createHash(format).update(`${value.type} ${value.size}\0`),
            content: createHash('sha256') }
          yield { kind: 'start', oid: next.value![0], type: value.type, size: value.size }
          if (value.size === 0) {
            if (body.oid.digest('hex') !== next.value![0]) invalid()
            hashes.set(next.value![0], body.content.digest('hex'))
            body = undefined
            separator = true
            yield { kind: 'end', oid: next.value![0] }
          }
        }
      }
  }
  return {
    parts,
    push(chunk: Buffer) { for (const _ of parts(chunk)) { /* 只读核验消费全部分帧，不保留正文。 */ } },
    finish() {
      if (!next.done || body || separator || header.length) invalid()
      return hashes
    },
  }
}
