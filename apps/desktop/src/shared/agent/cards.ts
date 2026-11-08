import { z } from 'zod'

/**
 * A card is the Agent asking something inside the chat, and the answer the
 * user gave. Cards live on the assistant message that asked, so a reopened
 * conversation still shows what was asked and what was chosen.
 *
 * Answers are turn-based: the tool returns at once, the model's turn ends, and
 * the answer becomes a normal user message that starts the next turn. Nothing
 * waits for a person inside a tool call.
 */

export const AGENT_CARD_KINDS = ['choice', 'plan'] as const

export const agentCardOptionSchema = z.strictObject({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  detail: z.string().max(160).optional(),
})

export const agentCardAnswerSchema = z.strictObject({
  /** Option ids the user picked. */
  selected: z.array(z.string().max(40)).max(8),
  freeText: z.string().max(500).optional(),
  skipped: z.boolean().optional(),
  /** Plan cards: the user applied the changes. */
  applied: z.boolean().optional(),
})

/** One deferred tool call a plan card will run when the user confirms. */
export const planStepSchema = z.strictObject({
  tool: z.string().min(1).max(60),
  args: z.record(z.string(), z.unknown()),
  /** One line from the tool's own `summarize`, shown in the card. */
  label: z.string().min(1).max(160),
})

export const agentCardSchema = z.strictObject({
  id: z.string().min(1).max(80),
  kind: z.enum(AGENT_CARD_KINDS),
  /** The question, or what the plan will do. */
  title: z.string().min(1).max(200),
  why: z.string().max(300).optional(),
  multiple: z.boolean().optional(),
  allowFreeText: z.boolean().optional(),
  options: z.array(agentCardOptionSchema).max(8).optional(),
  steps: z.array(planStepSchema).max(12).optional(),
  answer: agentCardAnswerSchema.optional(),
  createdAt: z.string().min(1).max(40),
})

export type AgentCard = z.infer<typeof agentCardSchema>
export type AgentCardKind = AgentCard['kind']
export type AgentCardOption = z.infer<typeof agentCardOptionSchema>
export type AgentCardAnswer = z.infer<typeof agentCardAnswerSchema>
export type PlanStep = z.infer<typeof planStepSchema>

/** A fresh, validated card; the id only has to be unique inside a conversation. */
export function makeCard(card: Omit<AgentCard, 'id' | 'createdAt'>): AgentCard {
  return agentCardSchema.parse({
    ...card,
    id: `card-${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  })
}
