import { z } from 'zod'

/** 总管与任务页共用有界问题契约，不携带模型会话或执行权限。 */
export const LocalTaskQuestionSchema = z.object({
  revision: z.number().int().positive(),
  question: z.string().trim().min(1).max(1000).nullable(),
  choices: z.array(z.string().trim().min(1).max(120)).min(2).max(4)
    .refine(items => new Set(items).size === items.length, '选项不能重复').optional(),
}).strict()
export type LocalTaskQuestionInput = z.input<typeof LocalTaskQuestionSchema>
