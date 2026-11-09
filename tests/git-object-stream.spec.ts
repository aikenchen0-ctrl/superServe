import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { objectStream } from '../src/development/git-object-stream.ts'

const object = (body: Buffer, type: 'tree' | 'blob' = 'blob', format: 'sha1' | 'sha256' = 'sha1') => {
  const oid = createHash(format).update(`${type} ${body.length}\0`).update(body).digest('hex')
  const header = `${oid} ${type} ${body.length}`
  return { oid, metadata: { type, size: body.length, header },
    frame: Buffer.concat([Buffer.from(header + '\n'), body, Buffer.from('\n')]), body }
}
it.each(['sha1', 'sha256'] as const)('任意 %s 分块不改变包含二进制、空对象的结果', format => {
  const objects = [object(Buffer.from([0, 10, 255, 42]), 'blob', format), object(Buffer.alloc(0), 'tree', format)]
  const all = Buffer.concat(objects.map(item => item.frame))
  for (const width of [1, 2, 7, 41, all.length]) {
    const stream = objectStream(format, new Map(objects.map(item => [item.oid, item.metadata])))
    for (let offset = 0; offset < all.length; offset += width) stream.push(all.subarray(offset, offset + width))
    expect(stream.finish()).toEqual(new Map(objects.map(item =>
      [item.oid, createHash('sha256').update(item.body).digest('hex')])))
  }
})
it.each(['header', 'high-bit-header', 'body', 'separator', 'extra', 'truncated'] as const)('%s 损坏不能生成部分成功', kind => {
  const item = object(Buffer.from('data')), frame = Buffer.from(item.frame)
  if (kind === 'header') frame[0] = 122
  if (kind === 'high-bit-header') frame[0] = frame[0]! | 128
  if (kind === 'body') frame[frame.length - 2] = 11
  if (kind === 'separator') frame[frame.length - 1] = 0
  const input = kind === 'extra' ? Buffer.concat([frame, Buffer.from('x')])
    : kind === 'truncated' ? frame.subarray(0, -1) : frame
  const stream = objectStream('sha1', new Map([[item.oid, item.metadata]]))
  expect(() => { stream.push(input); stream.finish() }).toThrow()
})
it('不把另一对象或错序正文作为当前对象，合法空流仍可完成', () => {
  expect(objectStream('sha1', new Map()).finish().size).toBe(0)
  const first = object(Buffer.from('first')), second = object(Buffer.from('second'))
  const stream = objectStream('sha1', new Map([[first.oid, first.metadata], [second.oid, second.metadata]]))
  expect(() => stream.push(second.frame)).toThrow()
})
it('超长头在流仍未结束时即拒绝；不无限积累缺少换行的数据', () => {
  const item = object(Buffer.from('x')), stream = objectStream('sha1', new Map([[item.oid, item.metadata]]))
  expect(() => stream.push(Buffer.alloc(1024, 120))).toThrow()
})
it('异步消费分片保留顺序，只有内容哈希一致的对象才发 end', async () => {
  const objects = [object(Buffer.from([0, 255, 10])), object(Buffer.alloc(0))]
  const stream = objectStream('sha1', new Map(objects.map(item => [item.oid, item.metadata])))
  const events: string[] = [], data: Buffer[] = []
  for (const part of stream.parts(Buffer.concat(objects.map(item => item.frame)))) {
    await Promise.resolve()
    events.push(part.kind)
    if (part.kind === 'data') data.push(Buffer.from(part.data))
  }
  expect(events).toEqual(['start', 'data', 'end', 'start', 'end'])
  expect(Buffer.concat(data)).toEqual(objects[0]!.body)
  expect(stream.finish().size).toBe(2)
  const corrupted = Buffer.from(objects[0]!.frame); corrupted[corrupted.length - 2] = corrupted[corrupted.length - 2]! ^ 1
  const bad = objectStream('sha1', new Map([[objects[0]!.oid, objects[0]!.metadata]]))
  const seen: string[] = []
  expect(() => { for (const part of bad.parts(corrupted)) seen.push(part.kind) }).toThrow()
  expect(seen).not.toContain('end')
})
