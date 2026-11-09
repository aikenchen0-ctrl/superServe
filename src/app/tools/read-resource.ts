import { z } from 'zod'
import { resourceGrammar } from '../resources.ts'
import { tool, type Tool } from './tool.ts'

/** 仓库模式的资源目录只在读取工具中加载，不让通用工具基元依赖 DSH 宿主。 */
export function readTool(description: string, executor: boolean,
  read: (resource: string, offset: number, limit: number | undefined, signal: AbortSignal) => Promise<unknown>): Tool {
  return tool({
    name: 'orchestrator_read',
    description,
    schema: z.object({
      resource: z.string().min(1).describe(`The resource, one of: ${resourceGrammar(executor)}.`),
      offset: z.number().int().min(0).default(0).describe('Copy next_offset from the previous page; it counts characters of a text and items of a list.'),
      limit: z.number().int().min(1).max(8000).optional()
        .describe('Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.'),
    }).strict(),
    execute: async (args, signal) => read(args.resource, args.offset, args.limit, signal),
  })
}
