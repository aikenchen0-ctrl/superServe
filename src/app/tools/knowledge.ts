import { z } from 'zod'
import { HmmError, type HmmActor } from '../../hmm/model.ts'
import { DeviceGrantSchema, DeviceQuerySchema } from '../../hmm/device-contracts.ts'
import type { HmmToolHost } from './hmm.ts'
import { tool, type Tool } from './tool.ts'

const QuerySchema = DeviceQuerySchema.extend({
  ticket_id: z.string().min(1).max(200).optional(),
  node_id: DeviceGrantSchema.shape.nodeId,
}).strict()

/** 工单身份由宿主绑定；查询元数据与读取原文都必须使用节点已有授权。 */
export function knowledgeTool(host: Pick<HmmToolHost, 'hmmDevices'>, boundTicket?: string): Tool {
  const actor: HmmActor = boundTicket ? { role: 'worker', ticketId: boundTicket } : { role: 'controller' }
  return tool({
    name: 'knowledge_query',
    description: '按 node_id 及其 deviceGrants 中的 grantId 查询设备知识，返回最多 8 条来源元数据和短期 handle，不含原文或图谱断言。总管必须传 ticket_id；执行器固定在当前工单。原文由同一调用者以相同 node_id 调用 hmm_evidence，request 为 {action:"device_read",handle}；元数据不能作为证据。',
    schema: QuerySchema,
    execute: async (input, signal) => {
      signal.throwIfAborted()
      const { ticket_id, node_id, ...request } = QuerySchema.parse(input)
      if (boundTicket && ticket_id && boundTicket !== ticket_id)
        throw new HmmError('scope_denied', '不能访问其他工单的知识', 403)
      const ticket = boundTicket ?? ticket_id
      if (!ticket) throw new HmmError('ticket_required', '总管必须指定工单编号')
      return host.hmmDevices.query(actor, ticket, node_id, request, signal)
    },
  })
}
