/** Shared tool primitives and schemas for the main and executor Sessions. */
import { z } from 'zod'
import { IM_WORDS, wordCount } from '../../infra/text.ts'

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>
}
export type RegisterTool = <S extends z.ZodType>(name: string, description: string, schema: S, execute: Tool<S>['execute']) => void
export const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
export const AcknowledgementSchema = z.string().trim().min(1)
  .refine(text => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`)
