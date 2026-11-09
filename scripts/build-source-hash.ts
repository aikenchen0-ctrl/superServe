import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 仅在构建时读取受控源码与锁文件，不读取凭据、运行目录或个人配置。 */
export function buildSourceHash(root: string): string {
  const files = ['package.json', 'pnpm-lock.yaml', 'tsdown.config.ts', 'scripts/build-source-hash.ts', 'scripts/development-inspect.mjs',
    'scripts/development-range-probe.mjs', 'scripts/development-range-worker.mjs', 'scripts/development-creation-probe.mjs',
    'scripts/development-quality.mjs',
    ...readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(?:tsx?|css)$/.test(entry.name))
      .map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))]
  const hash = createHash('sha256')
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0')
  return hash.digest('hex')
}
