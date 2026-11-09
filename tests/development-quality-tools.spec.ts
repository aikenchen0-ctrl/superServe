import * as fs from 'node:fs/promises'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyQualityTools } from '../src/development/quality-tools.ts'
import { DevelopmentQualityProfiles } from '../src/development/quality-profiles.ts'
import { inspectDevelopmentSource } from '../src/development/inspect.ts'
import { verifyQualitySources } from '../src/development/quality-sources.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime } from './fixtures/host.ts'

vi.mock('node:fs/promises', async original => {
  const source = await original<typeof import('node:fs/promises')>()
  return { ...source, open: vi.fn(source.open) }
})
const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture(python = false) {
  const root = await mkdtemp(join(tmpdir(), 'superserve-quality-tools-'))
  roots.push(root)
  const entry = join(root, 'tool.bin'), content = 'tool content'
  await writeFile(entry, content)
  const site = join(root, 'site-packages'), distribution = 'sample_quality-1.0.0.dist-info'
  const directory = join(site, distribution)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'METADATA'), 'Metadata-Version: 2.4\nName: sample-quality\nVersion: 1.0.0\nRequires-Dist: dependency>=1\n\nDescription\n')
  await writeFile(join(directory, 'RECORD'), 'tool.bin,sha256=declaration,12\n')
  await writeFile(join(directory, 'direct_url.json'), JSON.stringify({ url: 'file:///PRIVATE_SOURCE', dir_info: { editable: true } }))
  const request = { tools: [{ name: 'sample', version: '1.0.0', sha256: sha(content) }],
    locations: [{ name: 'sample', path: entry, ...(python ? { python: { sitePackagesPath: site,
      distribution, packageName: 'sample-quality' } } : {}) }] }
  return { root, entry, directory, site, request }
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.open).mockImplementation(original.open)
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !target.split(sep).at(-1)!.startsWith('superserve-quality-tools-'))
      throw new Error('测试目录边界不符')
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

it('普通工具只核对文件内容，不靠版本字符串获得执行许可', async () => {
  const { entry, request } = await fixture()
  const before = await lstat(entry), result = await verifyQualityTools(request)
  expect(result).toMatchObject({ status: 'selected_content_matched', read: { bytesRead: 12, filesRead: 1 },
    assurance: { readOnly: true, toolsVerified: false, toolExecutionAttempted: false, executionAuthorized: false },
    observations: [{ contentMatched: true, declaredVersion: '1.0.0' }] })
  expect((await lstat(entry)).mtimeMs).toBe(before.mtimeMs)
  expect(JSON.stringify(result)).not.toContain(entry)
})

it('超过报告上限的工具文件采用有界流式摘要，等价位置/顺序不改内容身份', async () => {
  const { root, entry, request } = await fixture()
  const content = Buffer.alloc(5 * 1024 * 1024 + 1, 87)
  await writeFile(entry, content)
  const peer = join(root, 'peer.bin')
  await writeFile(peer, content)
  request.tools[0]!.sha256 = sha(content)
  request.tools.push({ ...request.tools[0]!, name: 'other' })
  request.locations.push({ name: 'other', path: entry })
  const result = await verifyQualityTools(request)
  expect(result.read).toEqual({ bytesRead: content.length, filesRead: 1, pathsObserved: 1 })
  request.locations.reverse()
  request.locations[0]!.path = peer
  const reordered = await verifyQualityTools(request)
  expect(reordered.observationDigest).toBe(result.observationDigest)
  expect(reordered.read.bytesRead).toBe(content.length * 2)
})

it('相同文件名和声明版本不能隐藏内容变化', async () => {
  const { entry, request } = await fixture()
  await writeFile(entry, 'changed file')
  const result = await verifyQualityTools(request)
  expect(result.status).toBe('mismatch')
  expect(result.observations[0]!.issues).toContainEqual(expect.objectContaining({ code: 'tool_content_mismatch' }))
})

it.each(['missing', 'extra', 'duplicate'])('缺失/额外/重复工具位置不能悄悄改变检查范围：%s', async kind => {
  const { request } = await fixture()
  if (kind === 'missing') request.tools.push({ ...request.tools[0]!, name: 'second' })
  else request.locations.push({ ...request.locations[0]!, name: kind === 'extra' ? 'other' : 'sample' })
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'tool_scope_mismatch' })
})

it('可编辑安装、依赖和启动扩展明确缺证，不执行代码或回显路径正文', async () => {
  const { root, site, request } = await fixture(true)
  const marker = join(root, 'must-not-exist')
  await writeFile(join(site, 'editable.pth'), 'PRIVATE_SOURCE_PATH\n')
  await writeFile(join(site, 'execute.pth'), `import pathlib; pathlib.Path(${JSON.stringify(marker)}).touch()\n`)
  await writeFile(join(site, 'sitecustomize.py'), 'PRIVATE_STARTUP_CODE')
  const result = await verifyQualityTools(request)
  expect(result.observations[0]!.python).toMatchObject({ editable: true,
    metadataNameMatched: true, metadataVersionMatched: true, dependencies: [{ name: 'dependency' }],
    startup: { pathLines: 1, executableLines: 1, customizers: 1 }, recordPresent: true })
  expect(result.observations[0]!.issues.map(value => value.code)).toEqual(expect.arrayContaining([
    'python_editable_source_unverified', 'python_dependencies_unverified', 'python_record_not_verified', 'python_startup_unresolved',
  ]))
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('发行包名称规范化匹配，元数据版本不同仍报告不匹配', async () => {
  const { directory, request } = await fixture(true)
  await writeFile(join(directory, 'METADATA'), 'Metadata-Version: 2.4\nName: Sample_Quality\nVersion: 2.0.0\n\n')
  const result = await verifyQualityTools(request)
  expect(result.status).toBe('mismatch')
  expect(result.observations[0]!.python).toMatchObject({ metadataNameMatched: true, metadataVersionMatched: false })
})

it('缺少元数据和安装清单保留缺证，缺来源不能推断普通安装', async () => {
  const { directory, request } = await fixture(true)
  for (const name of ['METADATA', 'RECORD', 'direct_url.json']) await rm(join(directory, name))
  const result = await verifyQualityTools(request)
  expect(result.status).toBe('evidence_incomplete')
  expect(result.observations[0]!.python).toMatchObject({ editable: 'unknown', recordPresent: false })
})

it('损坏来源记录不会退化成非可编辑安装，URL 凭据不会进入输出', async () => {
  const { directory, request } = await fixture(true)
  await writeFile(join(directory, 'direct_url.json'), '{"url":"https://user:PRIVATE_SECRET@example.invalid"')
  const result = await verifyQualityTools(request)
  expect(result.status).toBe('evidence_incomplete')
  expect(result.observations[0]!.python?.editable).toBe('unknown')
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET')
})

it('工具文件核对后被替换时拒绝混合结论', async () => {
  const { entry, request } = await fixture(true)
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof original.open>) => {
    if (String(args[0]).endsWith('METADATA')) await writeFile(entry, 'changed tool')
    return original.open(...args)
  })
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'tool_changed' })
})

it('扫描启动文件后新建 .pth 会使该次核验失效', async () => {
  const { site, request } = await fixture(true)
  await writeFile(join(site, 'first.pth'), '# comment\n')
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof original.open>) => {
    if (String(args[0]).endsWith('first.pth')) await writeFile(join(site, 'new.pth'), 'PRIVATE_PATH\n')
    return original.open(...args)
  })
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'tool_changed' })
})

it('原先缺失的来源记录中途出现时，不沿用未知观测生成混合结果', async () => {
  const { directory, request } = await fixture(true)
  await rm(join(directory, 'direct_url.json'))
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof original.open>) => {
    if (String(args[0]).endsWith('RECORD'))
      await writeFile(join(directory, 'direct_url.json'), JSON.stringify({ url: 'file:///PRIVATE_SOURCE', dir_info: { editable: true } }))
    return original.open(...args)
  })
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'tool_changed' })
})

it('可选清单的缺失不能被复用为另一个必需工具的有效记录', async () => {
  const { directory, request } = await fixture(true)
  await rm(join(directory, 'RECORD'))
  request.tools.push({ ...request.tools[0]!, name: 'zz-required' })
  request.locations.push({ name: 'zz-required', path: join(directory, 'RECORD') })
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'tool_unreadable' })
})

it('安装目录连接不能扩大读取授权', async () => {
  const { root, site, request } = await fixture(true)
  const alias = join(root, 'alias')
  await symlink(site, alias, process.platform === 'win32' ? 'junction' : 'dir')
  request.locations[0]!.python!.sitePackagesPath = alias
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'unsafe_tool_path' })
})

it('显式指定的共享硬链接只读一次，内容变化后不能复用旧摘要', async () => {
  const { root, entry, request } = await fixture()
  const linked = join(root, 'linked')
  await link(entry, linked)
  request.tools.push({ ...request.tools[0]!, name: 'other' })
  request.locations.push({ name: 'other', path: linked })
  const result = await verifyQualityTools(request)
  expect(result.status).toBe('selected_content_matched')
  expect(result.read).toEqual({ bytesRead: 12, filesRead: 1, pathsObserved: 2 })
  await writeFile(linked, 'changed shared content')
  const changed = await verifyQualityTools(request)
  expect(changed.status).toBe('mismatch')
  expect(changed.observations.every(value => !value.contentMatched)).toBe(true)
})

it('超大工具在读取前拒绝，元数据与取消各自受预算约束', async () => {
  const { entry, directory, request } = await fixture(true)
  await truncate(entry, 256 * 1024 * 1024 + 1)
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'tool_read_budget' })
  await writeFile(entry, 'tool content')
  await writeFile(join(directory, 'METADATA'), Buffer.alloc(1024 * 1024 + 1, 65))
  await expect(verifyQualityTools(request)).rejects.toMatchObject({ code: 'tool_read_budget' })
  const controller = new AbortController()
  controller.abort()
  await expect(verifyQualityTools(request, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
})

it('读取中取消会关闭文件句柄，不返回部分摘要', async () => {
  const { request } = await fixture(), controller = new AbortController()
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof original.open>) => {
    const handle = await original.open(...args)
    controller.abort()
    return handle
  })
  await expect(verifyQualityTools(request, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
})

const moduleId = 'a'.repeat(64), repositoryId = 'b'.repeat(64)
const module = { schemaVersion: 1 as const, id: moduleId, repositoryId, revision: 1, name: 'module',
  paths: ['module'], contracts: [], acceptance: ['保持原始验收'] }
const definition = (tools: Awaited<ReturnType<typeof fixture>>['request']['tools']) => ({
  requestId: 'profile', revision: 0, name: 'quality', module: { id: moduleId, revision: 1 }, format: 'native-crap-v1',
  recipe: { repositoryId, commit: '1'.repeat(40), tree: '2'.repeat(40), path: 'tools' },
  configuration: { path: 'targets.json', sha256: 'c'.repeat(64) },
  tools, environment: { runtime: 'windows', architecture: 'x64' },
})
it.each(['profile', 'module', 'shutdown'])('工具核验结束后 %s 已变化，不能绑定过时配置', async change => {
  const { root, request } = await fixture(), store = new Store(join(root, 'state.sqlite'))
  let active = true, latest = { ...module }
  try {
    const profiles = new DevelopmentQualityProfiles(store, { module: (_id, version) => version ? module : latest,
      find: () => { throw new Error('本测试不读取任务') }, get: () => { throw new Error('本测试不读取任务') } },
      { available: () => active, inspect: inspectDevelopmentSource, verifySources: verifyQualitySources,
        verifyTools: async input => {
          const result = await verifyQualityTools(input)
          if (change === 'profile') profiles.save({ ...definition(request.tools), requestId: 'updated', revision: 1 })
          else if (change === 'module') latest = { ...module, revision: 2 }
          else active = false
          return result
        } })
    const saved = profiles.save(definition(request.tools)).profile
    await expect(profiles.verifyTools({ profileId: saved.id, profileRevision: saved.revision, locations: request.locations }))
      .rejects.toMatchObject({ code: change === 'profile' ? 'quality_profile_changed'
        : change === 'module' ? 'quality_module_changed' : 'runtime_unavailable' })
  } finally { store.close() }
})

it('Runtime/HTTP 工具核验不落库、不持久保存安装路径，仍不授予执行权', async () => {
  const { root, request } = await fixture()
  const h = await startRuntime(store => {
    store.set(`development:module:${module.id}`, module)
    store.set(`development:module-version:${module.id}:1`, module)
  }, { mode: 'hmm' })
  try {
    const saved = await h.api('POST', 'development/quality-profiles', definition(request.tools))
    expect(saved.status).toBe(200)
    const profile = saved.body.profile as { id: string; revision: number }
    const count = () => h.runtime.store.db.prepare('SELECT count(*) AS n FROM kv').get()!.n
    const before = count()
    const result = await h.api('POST', 'development/quality-bindings/verify-tools', {
      profileId: profile.id, profileRevision: profile.revision, locations: request.locations,
    })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ persisted: false, assurance: { executionAuthorized: false },
      verification: { status: 'selected_content_matched' } })
    expect(count()).toBe(before)
    expect(JSON.stringify(result.body)).not.toContain(root)
    expect(JSON.stringify(h.runtime.store.db.prepare("SELECT value FROM kv WHERE key LIKE 'development:quality-%'").all())).not.toContain(root)
    expect(await readFile(request.locations[0]!.path, 'utf8')).toBe('tool content')
  } finally { await h.stop() }
})
