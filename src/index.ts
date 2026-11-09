/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import type { DeviceDescriptor, DevicePort } from './hmm/device-contracts.ts'
import type { WorkspaceBinding } from './development/workspaces.ts'
import type { DevelopmentCommand } from './development/executions.ts'
import type { DevelopmentExecutionRequirement } from './development/execution-contract.ts'
import type { PreparedExecutionInput } from './development/source-materialization.ts'
export type { DevelopmentExecutionRequirement } from './development/execution-contract.ts'
export { HttpDevicePort, type HttpDevicePortOptions } from './hmm/device-http.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
/** 向已启动的宿主绑定经过认证的设备端口；调用方须在插件卸载时执行返回的断开函数。 */
export function attachKnowledgeDevice(ctx: Context, descriptor: DeviceDescriptor, port: DevicePort): () => void {
  return ctx.orchestrator.hmmDevices.attach(descriptor, port)
}
/** 可信插件调用已授权的开发命令；省略要求仅沿用提供方范围，不保证恢复；观测不授权目录释放。 */
export function runDevelopmentCommand(ctx: Context, workspace: WorkspaceBinding, command: DevelopmentCommand,
  requirements: readonly DevelopmentExecutionRequirement[] = [], prepared?: PreparedExecutionInput) {
  return ctx.orchestrator.developmentExecutions.start(workspace, command, requirements, prepared)
}
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(machine.mode === 'hmm' ? 'HMM 受限总管已就绪，可通过本地任务入口提交目标'
    : runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export type { DeviceDescriptor, DevicePort } from './hmm/device-contracts.ts'
export type { WorkspaceBinding } from './development/workspaces.ts'
export type { DevelopmentCommand } from './development/executions.ts'
export * from './core/index.ts'
