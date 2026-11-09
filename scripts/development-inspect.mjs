import { parseArgs } from 'node:util'
import { inspectDevelopmentSource, InspectionError } from '../lib/development-inspect.js'

try {
  const { values } = parseArgs({
    options: { repo: { type: 'string' }, revision: { type: 'string' }, git: { type: 'string' }, help: { type: 'boolean' } },
    strict: true, allowPositionals: false,
  })
  if (values.help) {
    console.log('只读检查固定提交和工作区风险，不创建候选、提交或检出目录。')
    console.log('用法：node scripts/development-inspect.mjs --repo <仓库目录> [--revision <提交引用>] [--git <Git路径>]')
    console.log('JSON 中 blobBytes 为源码文件逻辑字节，不是磁盘占用；目录干净也不表示已经冻结或获准复用。')
  } else {
    if (!values.repo) throw new InspectionError('invalid_request', '缺少 --repo 仓库目录')
    console.log(JSON.stringify(await inspectDevelopmentSource({
      repository: values.repo, revision: values.revision, git: values.git,
    }), null, 2))
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof InspectionError ? error.code : 'invalid_request',
    message: error instanceof InspectionError ? error.message : '参数无效，请使用 --help 查看说明' }))
  process.exitCode = 1
}
