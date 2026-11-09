import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '../app/runtime.ts'
import { KNOWLEDGE_DOMAINS } from '../knowledge/contracts.ts'
import { DeviceDescriptorSchema } from '../hmm/device-contracts.ts'
import { HttpDevicePort } from '../hmm/device-http.ts'

const InputSchema = DeviceDescriptorSchema.extend({
  route: DeviceDescriptorSchema.shape.route.default('direct'),
  baseUrl: z.string().min(1).max(2048),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  allowInsecureLocalhost: z.boolean().default(false),
}).strict()

export type DeviceHttpConfig = z.input<typeof InputSchema>
export const name = 'dsh-superagent-device-http'
export const inject = ['orchestrator']
export const Config = s.object({
  id: s.string().required().description('稳定设备标识，须与知识授权中的 deviceId 一致。'),
  label: s.string().required().description('设备显示名称。'),
  domains: s.array(s.union([...KNOWLEDGE_DOMAINS])).min(1).max(6).required()
    .description('桥接服务提供的数据域；声明能力不授予读取权。'),
  route: s.union(['direct', 'designated-hk']).default('direct')
    .description('可信部署的路由声明，不构成地域或腾讯认证证明。'),
  baseUrl: s.string().required().description('固定 HTTPS 桥接地址，不允许地址凭据或查询参数。'),
  tokenEnv: s.string().required().description('宿主环境变量名称，只保存名称，不保存凭据值。'),
  allowInsecureLocalhost: s.boolean().default(false).description('仅允许回环 HTTP 开发测试。'),
})

/** 原生注入等待宿主就绪；端口注册和卸载沿用同一生命周期，不额外授予节点权限。 */
export function apply(ctx: Context, input: DeviceHttpConfig): void {
  let config: z.output<typeof InputSchema>
  try {
    config = InputSchema.parse(input)
  } catch {
    throw new Error('设备连接器配置无效，请检查设备标识、数据域、地址及凭据变量名称')
  }
  const token = process.env[config.tokenEnv]
  if (!token) throw new Error('设备连接凭据环境变量未配置')
  let port: HttpDevicePort
  try {
    port = new HttpDevicePort({ baseUrl: config.baseUrl, token, allowInsecureLocalhost: config.allowInsecureLocalhost })
  } catch {
    // 配置和网络错误不得把凭据或带凭据的地址写入日志。
    throw new Error('设备连接器地址或凭据配置无效')
  }
  const { id, label, domains, route } = config
  ctx.effect(() => ctx.orchestrator.hmmDevices.attach({ id, label, domains, route }, port), 'knowledge device: HTTP')
}
