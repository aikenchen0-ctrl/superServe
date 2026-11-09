import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(ROOT, 'tsconfig.json')
const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT)
const roots = ['src/hmm', 'src/knowledge', 'src/development'].flatMap(directory =>
  readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name)))

// 使用编译器解析整个依赖闭包，包含类型、重导出和字面量动态导入，而非只匹配 import 文本。
const program = ts.createProgram(roots, { ...config.options, noEmit: true })
const sourcePaths = program.getSourceFiles().map(file => resolve(file.fileName).replaceAll('\\', '/'))
const localPath = (path: string) => relative(ROOT, path).replaceAll('\\', '/')

it('HMM、知识与工程领域可独立完成类型检查，不依赖应用组合根提供类型补丁', () => {
  expect(roots.length).toBeGreaterThan(0)
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
  expect(diagnostics.map(diagnostic => ({
    file: diagnostic.file ? localPath(diagnostic.file.fileName) : undefined,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))).toEqual([])
})

it('HMM、知识与工程领域的传递依赖不穿过宿主层、DSH 或 Cordis，包括纯类型依赖', () => {
  const hostLayers = sourcePaths.map(localPath)
    .filter(path => /^src\/(app|executor|sources|connectors|client)\//.test(path))
  const hostPackages = sourcePaths
    .filter(path => /\/node_modules\/@deepseek-ai\/(dsh(?:-[^/]+)?|cordis)\//.test(path))
    .map(path => path.slice(path.lastIndexOf('/node_modules/') + '/node_modules/'.length))
  expect({ hostLayers, hostPackages }).toEqual({ hostLayers: [], hostPackages: [] })
})

it('HMM 总管工具可独立编译，不通过通用工具或资源入口传递依赖 DSH', () => {
  const controller = ts.createProgram([join(ROOT, 'src/app/tools/hmm-controller.ts')], { ...config.options, noEmit: true })
  const packages = [...new Set(controller.getSourceFiles().flatMap(file => {
    const match = resolve(file.fileName).replaceAll('\\', '/')
      .match(/\/node_modules\/(@deepseek-ai\/(?:dsh(?:-[^/]+)?|cordis))\//)
    return match ? [match[1]] : []
  }))]
  expect(packages).toEqual([])
  const diagnostics = ts.getPreEmitDiagnostics(controller).map(diagnostic => ({
    file: diagnostic.file ? localPath(diagnostic.file.fileName) : undefined,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))
  expect(diagnostics).toEqual([])
})
