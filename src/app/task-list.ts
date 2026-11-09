import { z } from 'zod'

export const LOCAL_TASK_FILTERS = ['open', 'needs_answer', 'ended', 'all'] as const
export type LocalTaskFilter = typeof LOCAL_TASK_FILTERS[number]

/** 客户端与总管共用目录参数约束，不引入存储实现或执行宿主。 */
export const LocalTaskListSchema = z.object({
  state: z.enum(LOCAL_TASK_FILTERS).default('open'),
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(100).optional(),
  preview: z.literal('question').optional(),
  attention: z.literal('questions').optional(),
}).strict()
export type LocalTaskListQuery = Partial<z.output<typeof LocalTaskListSchema>>
