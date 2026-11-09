import { openSync, readSync, closeSync, fstatSync, lstatSync, constants } from 'node:fs'
import { interactionPlanHash, summarizeInteraction } from './hmm-interaction-report.ts'

const usage = `用法：
  node scripts/hmm-interaction.mjs --plan-hash 计划.json
  node scripts/hmm-interaction.mjs 观测.json

只读离线文件，结果输出到标准输出；不启动宿主、不联网、不采集用户行为。
观测正文为 { plan, observations }。计划和记录格式见 docs/hmm-backend.md 的交互成本对照章节。
退出码：0=记录完整可作描述性比较，2=证据不完整，1=格式或读取失败。
退出码 0 不表示产品更优；脚本采样不代表人类收益。`

/** 先拒绝非普通路径，再核验已打开对象；有界读取也覆盖读取期间文件增长。 */
function readJson(path) {
  const limit = 8 * 1024 * 1024
  if (!lstatSync(path).isFile()) throw new Error('输入必须是普通 JSON 文件，不接受目录、链接或管道。')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('输入必须是至多 8 MiB 的普通 JSON 文件。')
    const buffer = Buffer.alloc(limit + 1)
    let length = 0, received
    do {
      received = readSync(fd, buffer, length, buffer.length - length, null)
      length += received
      if (length > limit) throw new Error('输入超过 8 MiB，不能完整核验。')
    } while (received > 0)
    return JSON.parse(buffer.subarray(0, length).toString('utf8'))
  } finally { closeSync(fd) }
}

try {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') console.log(usage)
  else if (args.length === 2 && args[0] === '--plan-hash') console.log(interactionPlanHash(readJson(args[1])))
  else if (args.length === 1 && !args[0].startsWith('-')) {
    const result = summarizeInteraction(readJson(args[0]))
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.comparisonReady ? 0 : 2
  } else throw new Error(usage)
} catch (error) {
  const message = error?.name === 'ZodError' ? '字段格式不符合协议，请核对必填项、数值和摘要。'
    : error instanceof SyntaxError ? '输入不是有效的 JSON。'
      : error?.code ? '无法读取指定输入文件。' : error instanceof Error ? error.message : '未知错误。'
  console.error(`交互报告失败：${message}`)
  process.exitCode = 1
}
