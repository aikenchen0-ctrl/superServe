import { z } from 'zod'

const reasons = {
  AUTH: '模型鉴权失败，请检查提供方账号、密钥或访问权限后恢复',
  MISSING_CREDENTIAL: '缺少模型凭据，请配置后恢复',
  INVALID_CREDENTIAL: '模型凭据无效，请修正后恢复',
  QUOTA: '模型额度已耗尽，请补充额度后恢复',
  ACCOUNT_QUOTA: '模型账号余额不足，请检查账号额度后恢复',
  RATE_LIMIT: '模型请求被限流，请稍后显式恢复',
  CONTEXT_WINDOW_EXCEEDED: '模型上下文超限，请检查节点输入与模型配置后恢复',
  NO_ADAPTER: '模型提供方未注册，请检查宿主配置后恢复',
  UNKNOWN: '模型回合失败，请检查模型配置和运行记录后恢复',
} as const

export type ModelFailureCode = keyof typeof reasons
export const ModelFailureCodeSchema = z.enum(Object.keys(reasons) as ModelFailureCode[])

/** 只消费宿主的稳定错误码，不解析错误文案，也不传播提供方正文或凭据。 */
export function modelFailure(error: unknown): { code: ModelFailureCode; reason: string } {
  const supplied = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  const code = ModelFailureCodeSchema.catch('UNKNOWN').parse(supplied)
  return { code, reason: reasons[code] }
}
