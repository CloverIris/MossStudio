import type { AgentCard, AgentCardAnswer } from '@shared/agent/cards'
import { Button } from '../../../components/ui'

/**
 * A go/no-go, waiting above the input: approve, reject, or type in the input
 * what to change first. Used for "start generating?", where a yes/no in prose
 * is easy to miss and impossible to answer with a click.
 */
export function ConfirmCard({
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
  const approve = card.options?.find((option) => option.id === 'approve')?.label ?? '批准'
  const reject = card.options?.find((option) => option.id === 'reject')?.label ?? '拒绝'
  return (
    <div className="flex flex-col gap-2.5" data-card="confirm">
      <div className="flex flex-col gap-0.5">
        <p className="text-control font-medium text-ink">{card.title}</p>
        {card.why ? <p className="text-caption text-ink-2">{card.why}</p> : null}
      </div>
      <div className="flex items-center gap-1">
        <Button size="xs" tone="ghost" disabled={busy} onClick={() => onAnswer({ selected: ['reject'] })}>
          {reject}
        </Button>
        <Button size="xs" tone="ghost" disabled={busy} onClick={onReply}>
          改一句…
        </Button>
        <span className="flex-1" />
        <Button size="xs" tone="primary" disabled={busy} onClick={() => onAnswer({ selected: ['approve'] })}>
          {approve}
        </Button>
      </div>
    </div>
  )
}
