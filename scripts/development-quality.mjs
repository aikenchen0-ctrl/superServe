import { parseArgs } from 'node:util'
import { inspectQualityEvidence, QualityImportError } from '../lib/development-quality.js'

const abort = new AbortController()
const cancel = () => abort.abort()
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' }, format: { type: 'string' }, help: { type: 'boolean' },
      'expected-commit': { type: 'string' }, 'expected-scope': { type: 'string' }, 'expected-input': { type: 'string' },
    },
    strict: true, allowPositionals: false,
  })
  if (values.help) {
    console.log('只读解释指定质量报告，不执行脚本、不保存报告、不批准候选。')
    console.log('用法：node scripts/development-quality.mjs --directory <证据目录> --format <jvm-trial-v1|native-crap-v1>')
    console.log('可选：--expected-commit <提交> --expected-scope <范围摘要> --expected-input <输入摘要>')
    console.log('退出码：0 帮助；1 读取/参数失败；2 缺证或过期；3 已解释但仍需审查。')
  } else {
    const result = await inspectQualityEvidence({
      directory: values.directory, format: values.format, expectedCommit: values['expected-commit'],
      expectedScopeDigest: values['expected-scope'], expectedInputDigest: values['expected-input'],
    }, abort.signal)
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = ['insufficient_evidence', 'stale'].includes(result.evidence) ? 2 : 3
  }
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof QualityImportError ? error.code : 'import_failed',
    message: error instanceof QualityImportError ? error.message : '无法导入质量证据，请核对参数与报告格式',
  }))
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
}
