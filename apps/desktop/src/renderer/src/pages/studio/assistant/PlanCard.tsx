import { Minus, MoveDiagonal2, Pencil, Plus } from 'lucide-react'
import type { AgentCard, AgentCardAnswer } from '@shared/agent/cards'
import { Button } from '../../../components/ui'

/** What a step does, at a glance: add, change, size, remove. */
function StepIcon({ tool }: { tool: string }): React.JSX.Element {
  const props = { className: 'mt-0.5 size-3.5 shrink-0 text-accent', strokeWidth: 2, 'aria-hidden': true } as const
  if (tool.includes('remove')) return <Minus {...props} />
  if (tool.includes('add') || tool.includes('create')) return <Plus {...props} />
  if (tool.includes('sampler')) return <MoveDiagonal2 {...props} />
  return <Pencil {...props} />
}

/**
 * The changes the Agent wants to make, waiting for 审批. Its new boxes show on
 * the selected 画面 meanwhile. Applying runs the steps in the planned order,
 * without going back to the model, so a plan is applied exactly as shown;
 * words typed in the input send it back with a change.
 */
export function PlanCard({
  card,
  busy,
  onAnswer,
  onReply,
}: {
  card: AgentCard
  busy: boolean
  onAnswer: (answer: AgentCardAnswer) => void
  onReply?: () => void
}): React.JSX.Element {
  const steps = card.steps ?? []
  return (
    <div className="flex flex-col gap-2.5" data-card="plan">
      <div className="flex flex-col gap-0.5">
        <p className="text-control font-medium text-ink">{card.title}</p>
        {card.why ? <p className="text-caption text-ink-2">{card.why}</p> : null}
      </div>

      {steps.length ? (
        <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto" aria-label="方案里的改动">
          {steps.map((step, index) => (
            <li key={`${step.tool}-${index}`} className="flex items-start gap-2 text-caption">
              <StepIcon tool={step.tool} />
              <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{step.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-1">
        <Button size="xs" tone="ghost" disabled={busy} onClick={() => onAnswer({ selected: [], skipped: true })}>
          放弃
        </Button>
        <Button size="xs" tone="ghost" disabled={busy} onClick={onReply}>
          调整…
        </Button>
        <span className="flex-1" />
        <Button size="xs" tone="primary" disabled={busy} onClick={() => onAnswer({ selected: [], applied: true })}>
          应用
        </Button>
      </div>
    </div>
  )
}
