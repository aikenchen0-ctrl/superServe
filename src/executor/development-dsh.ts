import { scrubbedParentEnv, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { DevelopmentExecutionPort } from '../development/executions.ts'
import type { DevelopmentLaunchPermits } from '../development/launch-permits.ts'
import { requireExecutionContract } from '../development/execution-contract.ts'
import type { PreparedExecutionInput } from '../development/source-materialization.ts'

// 当前公开入口不能逐次要求原生范围、禁止退化或重连；不以平台和安装版本推定保证。
const guarantees = Object.freeze([])
const preparedEnvironment = (env: Record<string, string> | undefined, prepared?: PreparedExecutionInput) => ({
  ...(env ?? {}), ...(prepared ? { SUPERSERVE_SOURCE_DIRECTORY: prepared.sourceDirectory,
    SUPERSERVE_OUTPUT_DIRECTORY: prepared.outputDirectory, SUPERSERVE_MATERIALIZATION_ID: prepared.materializationId } : {}),
})

/** 使用 DSH 公开进程接口；输出只保留有限尾部，不写入开发执行状态库。 */
export function developmentDshPort(subprocess: Pick<SubprocessRuntime, 'spawn'>, runner?: {
  permits: DevelopmentLaunchPermits; argv: readonly string[]; cwd: string
}): DevelopmentExecutionPort {
  if (runner) return {
    guarantees,
    admission: runner.permits,
    outcomeScope: 'trusted_launcher',
    spawn: ({ argv, cwd, env }, binding, requirements = [], prepared?: PreparedExecutionInput) => {
      requireExecutionContract(requirements, guarantees)
      const environment = scrubbedParentEnv()
      for (const [key, value] of Object.entries(env ?? {})) {
        if (process.platform === 'win32') {
          for (const previous of Object.keys(environment)) if (previous.toLowerCase() === key.toLowerCase()) delete environment[previous]
        }
        environment[key] = value
      }
      const envelope = runner.permits.offer(binding, { argv, env: preparedEnvironment(environment, prepared) }, cwd, prepared)
      // 目标的 NODE_OPTIONS 等环境仅随载荷传递，不能在消费许可前影响可信启动器。
      const wrapperEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
        const original = Object.keys(process.env).find(name => name.toLowerCase() === key.toLowerCase())
        if (original) wrapperEnv[original] = process.env[original]
      }
      return subprocess.spawn({ argv: runner.argv, cwd: runner.cwd, env: wrapperEnv, graceMs: 2000,
        stdio: { stdin: { data: JSON.stringify(envelope) }, stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 } } })
    },
  }
  return {
    guarantees,
    spawn: ({ argv, cwd, env }, _binding, requirements = [], prepared?: PreparedExecutionInput) => {
      requireExecutionContract(requirements, guarantees)
      return subprocess.spawn({
        argv, cwd, env: preparedEnvironment(env, prepared), graceMs: 2000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 16_384 }, stderr: { maxBytes: 16_384 } },
      })
    },
  }
}
