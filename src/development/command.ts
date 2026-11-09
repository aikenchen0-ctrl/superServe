import { z } from 'zod'

const text = z.string().max(32_768).refine(value => !value.includes('\0'), '内容不能包含空字符')
/** 控制面和可信启动器共享的命令输入边界，不包含执行权限。 */
export const DevelopmentCommandSchema = z.object({
  argv: z.array(text).min(1).max(256).refine(argv => !!argv[0]?.length, '程序名不能为空'),
  env: z.record(z.string().min(1).max(256).regex(/^[^=\0]+$/), text).optional(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 131_072, '命令超出执行输入预算')
export type DevelopmentCommand = z.infer<typeof DevelopmentCommandSchema>
