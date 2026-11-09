import { spawn } from 'node:child_process'
import { consumeLaunchPermit } from '../development/launch-permits.ts'

/** 启动器输入只走 stdin，不接受命令行里的命令、环境或令牌；消费提交后才接触目标目录。 */
async function run() {
  const chunks: Buffer[] = []
  let length = 0
  for await (const part of process.stdin) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    length += chunk.length
    if (length > 262_144) throw new Error('启动器输入超出预算')
    chunks.push(chunk)
  }
  const { command, cwd, recordStart, recordExit } = consumeLaunchPermit(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const [program, ...args] = command.argv
  const child = spawn(program!, args, { cwd, env: command.env ?? {}, windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'], shell: false })
  const outcome = await new Promise<{ code: number | null }>((resolve, reject) => {
    let started = false, failure: unknown
    child.once('error', error => {
      failure ??= error
      if (!started) try { recordStart('rejected') } catch (receiptError) { failure = receiptError }
    })
    child.once('spawn', () => {
      // spawn 先于其他正常事件；创建之后的错误不能再被记录成从未启动。
      started = true
      try { recordStart('spawned') } catch (error) { failure = error }
    })
    // exit 只证明直属目标退出；不等待继承 stdout 的后代就持久化该事实。
    child.once('exit', (exitCode, signal) => {
      if (started && !failure) try { recordExit({ exitCode, signal }) } catch (error) { failure = error }
    })
    child.once('close', code => failure ? reject(failure) : resolve({ code }))
  })
  process.exitCode = outcome.code ?? 125
}
void run().catch(() => {
  process.stderr.write('目标启动、退出回执或许可未确认；需核验执行记录。\n')
  process.exitCode = 125
})
