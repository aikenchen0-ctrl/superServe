import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildSourceHash } from '../scripts/build-source-hash.ts'
import { buildInfo } from '../src/app/build-info.ts'
import { startRuntime } from './fixtures/host.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(reverse = false) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-build-'))
  directories.push(root)
  const files = {
    'package.json': '{"name":"test"}',
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    'tsdown.config.ts': 'export default {}',
    'scripts/build-source-hash.ts': 'export const hash = true',
    'scripts/development-inspect.mjs': 'console.log("inspection")',
    'scripts/development-range-probe.mjs': 'console.log("range probe")',
    'scripts/development-range-worker.mjs': 'console.log("range worker")',
    'scripts/development-creation-probe.mjs': 'console.log("creation probe")',
    'scripts/development-quality.mjs': 'console.log("quality review")',
    'src/index.ts': 'export const name = "test"',
    'src/app/part.ts': 'export const part = 1',
    'src/client/app.tsx': 'export const view = null',
    'src/client/style.css': 'body { color: black }',
  }
  for (const [path, text] of reverse ? Object.entries(files).reverse() : Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

it('相同内容不受绝对路径和文件创建顺序影响', () => {
  const hash = buildSourceHash(fixture())
  expect(hash).toMatch(/^[a-f0-9]{64}$/)
  expect(buildSourceHash(fixture(true))).toBe(hash)
})

it.each(['src/app/part.ts', 'src/client/style.css', 'package.json', 'pnpm-lock.yaml',
  'tsdown.config.ts', 'scripts/build-source-hash.ts', 'scripts/development-inspect.mjs',
  'scripts/development-range-probe.mjs', 'scripts/development-range-worker.mjs',
  'scripts/development-creation-probe.mjs', 'scripts/development-quality.mjs'])('构建输入 %s 改变时指纹随之改变', file => {
  const root = fixture(), before = buildSourceHash(root)
  writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8') + '\n')
  expect(buildSourceHash(root)).not.toBe(before)
})

it('新增和删除源码会改变指纹，运行产物与凭据文件不参与计算', () => {
  const root = fixture(), before = buildSourceHash(root)
  for (const path of ['.env', 'src/.env', '.artifacts/result.json']) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), 'not-a-build-input')
  }
  expect(buildSourceHash(root)).toBe(before)
  const added = join(root, 'src/app/extra.ts')
  writeFileSync(added, 'export const extra = true')
  expect(buildSourceHash(root)).not.toBe(before)
  rmSync(added)
  expect(buildSourceHash(root)).toBe(before)
})

it('源码运行明确返回空指纹，管理端不能把它当作构建产物', async () => {
  expect(buildInfo).toEqual({ sourceHash: null })
  expect(Object.isFrozen(buildInfo)).toBe(true)
  const h = await startRuntime(undefined, { mode: 'hmm' })
  try {
    expect(await h.api('GET', 'state')).toMatchObject({ status: 200, body: { build: { sourceHash: null } } })
  } finally { await h.stop() }
})
