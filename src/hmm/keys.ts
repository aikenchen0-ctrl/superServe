import { family } from '../kv-key.ts'
import type { HmmWorkflow } from './model.ts'

/** HMM 拥有键定义；宿主只重导出同一对象，不另建副本或改变持久化格式。 */
export const HMM_KEYS = {
  workflow: family<HmmWorkflow, [ticketId: string]>('hmm-workflow:'),
}
