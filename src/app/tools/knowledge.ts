import { z } from 'zod'
import { KNOWLEDGE_DOMAINS, type KnowledgeAccess, type KnowledgeStore } from '../../knowledge/contracts.ts'
import { tool, type Tool } from './tool.ts'

/** Knowledge capability shared by the orchestrator and a task Agent. */
export interface KnowledgeToolHost {
  readonly knowledge: KnowledgeStore
}

const QuerySchema = z.object({
  text: z.string().trim().min(1).max(1000).optional(),
  domains: z.array(z.enum(KNOWLEDGE_DOMAINS)).min(1).optional(),
  devices: z.array(z.string().min(1)).min(1).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(20).default(8),
  include_inferred: z.boolean().default(false),
}).strict()

/** Builds a read-only knowledge tool whose access is fixed by the authenticated Agent role. */
export function knowledgeTool(host: KnowledgeToolHost, access: KnowledgeAccess): Tool {
  return tool({
    name: 'knowledge_query',
    description: 'Find bounded evidence from the knowledge devices this Agent may access. Results contain source and version references; request raw content separately.',
    schema: QuerySchema,
    execute: async args => host.knowledge.query({
      ...(args.text ? { text: args.text } : {}),
      ...(args.domains ? { domains: args.domains } : {}),
      ...(args.devices ? { devices: args.devices } : {}),
      ...(args.from ? { from: args.from } : {}),
      ...(args.to ? { to: args.to } : {}),
      limit: args.limit,
      includeInferred: args.include_inferred,
    }, access),
  })
}
