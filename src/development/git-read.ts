import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const OUTPUT_BYTES = 16 * 1024 * 1024

/** 只读检查的结构化失败；不回显 Git 标准错误、路径内容或环境变量。 */
export class InspectionError extends Error {
  constructor(readonly code: 'invalid_request' | 'git_unavailable' | 'git_failed' | 'output_limit' | 'cancelled'
    | 'invalid_output' | 'repository_changed' | 'path_unavailable', message: string) { super(message) }
}
export interface InspectionRequest {
  repository: string
  revision?: string
  git?: string
  signal?: AbortSignal
}
/** 保持既有模块登记的仓库 ID 算法；物理目录规范化不能隐式迁移业务身份。 */
export function repositoryIdentity(commonDirectory: string) {
  return createHash('sha256').update(JSON.stringify(process.platform === 'win32'
    ? commonDirectory.toLowerCase() : commonDirectory)).digest('hex')
}
export function gitRecords(output: Buffer, limit = Number.MAX_SAFE_INTEGER): Buffer[] {
  if (!output.length) return []
  if (output.at(-1) !== 0) throw new InspectionError('invalid_output', 'Git 输出不完整，未生成检查结果')
  const result: Buffer[] = []
  for (let from = 0, end = 0; end < output.length; end++) {
    if (output[end] !== 0) continue
    if (result.length >= limit) throw new InspectionError('output_limit', 'Git 清单超过条目预算，未生成部分结果')
    result.push(output.subarray(from, end))
    from = end + 1
  }
  return result
}

/** 仅供内部固定的只读 Git 操作复用；不作为任意命令工具或管理接口暴露。 */
export function gitReader(request: InspectionRequest, directory: () => string, signal: AbortSignal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat', LC_ALL: 'C' })
  const filterConfig: string[] = []
  const argv = () => ['--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...filterConfig]
  const git = async (args: string[], options: { input?: Buffer; outputBytes?: number } = {}) => {
    const maxBuffer = options.outputBytes ?? OUTPUT_BYTES
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > OUTPUT_BYTES)
      throw new InspectionError('invalid_request', 'Git 读取预算无效')
    try {
      signal.throwIfAborted()
      return await new Promise<Buffer>((done, reject) => {
        let closed = false, inputError: Error | undefined, result: { error: unknown; output: Buffer } | undefined
        const settle = () => {
          if (closed && result) {
            const error = result.error ?? inputError
            error ? reject(error) : done(result.output)
          }
        }
        const child = execFile(request.git ?? 'git', [...argv(), ...args],
        { cwd: directory(), env, encoding: 'buffer', maxBuffer, signal, windowsHide: true },
        (error, stdout) => { result = { error, output: stdout }; settle() })
        // 取消可能先于 close；等句柄关闭后才允许调用者释放目录。
        child.once('close', () => { closed = true; settle() })
        if (options.input) {
          child.stdin?.on('error', error => { inputError = error })
          child.stdin?.end(options.input)
        }
      })
    } catch (error) {
      if (signal.aborted) throw new InspectionError('cancelled', '检查已取消或超过时间预算，未生成部分结果')
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') throw new InspectionError('git_unavailable', '找不到指定的 Git 可执行程序')
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw new InspectionError('output_limit', 'Git 输出超过检查预算，未生成部分结果')
      throw new InspectionError('git_failed', 'Git 只读检查失败；请核对仓库权限、提交引用、对象完整性及 Git 功能')
    }
  }
  /** 固定对象读取通道；异步消费形成背压，出错或取消仍等真实 close 及消费结束后返回。 */
  const streamObjects = async (input: Buffer, outputBytes: number, consume: (chunk: Buffer) => void | Promise<void>) => {
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > 512 * 1024 * 1024)
      throw new InspectionError('invalid_request', 'Git 对象流预算无效')
    if (signal.aborted) throw new InspectionError('cancelled', '对象读取已取消')
    await new Promise<void>((resolve, reject) => {
      let failure: unknown, bytes = 0
      const child = spawn(request.git ?? 'git', [...argv(), 'cat-file', '--batch'], {
        cwd: directory(), env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stop = (error: unknown) => { failure ??= error; child.kill() }
      const abort = () => stop(new InspectionError('cancelled', '对象读取已取消或超时'))
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', error => {
        failure ??= new InspectionError('code' in error && error.code === 'ENOENT' ? 'git_unavailable' : 'git_failed',
          'Git 对象读取无法启动')
      })
      child.stdin.on('error', () => stop(new InspectionError('git_failed', 'Git 对象读取输入未完成')))
      child.stdout.on('error', () => stop(new InspectionError('git_failed', 'Git 对象读取输出未完成')))
      const consuming = (async () => {
        try {
          for await (const chunk of child.stdout) {
            if (failure) break
            bytes += chunk.length
            if (bytes > outputBytes) throw new InspectionError('output_limit', 'Git 对象流超过预先核对的读取预算')
            await consume(chunk)
          }
        } catch (error) { stop(error) }
      })()
      // 错误正文不持久化或回显，持续排空以免子进程阻塞。
      child.stderr.resume()
      child.once('close', code => {
        // 退出事件可能先于最后一块异步落盘结束；二者均完成才返回。
        void consuming.then(() => {
          signal.removeEventListener('abort', abort)
          if (failure) reject(failure)
          else if (code !== 0) reject(new InspectionError('git_failed', 'Git 对象流未正常结束'))
          else resolve()
        })
      })
      child.stdin.end(input)
      if (signal.aborted) abort()
    })
  }
  const scalar = async (args: string[]) => (await git(args)).toString('utf8').trim()
  const disableFilters = async () => {
    const names = gitRecords(await git(['config', '--null', '--name-only', '--list']))
    filterConfig.length = 0
    for (const name of new Set(names.map(value => value.toString('utf8')))) {
      if (/^filter\..+\.(clean|process)$/.test(name)) filterConfig.push('-c', `${name}=`)
      if (/^filter\..+\.required$/.test(name)) filterConfig.push('-c', `${name}=false`)
    }
  }
  return { git, scalar, disableFilters, streamObjects }
}
