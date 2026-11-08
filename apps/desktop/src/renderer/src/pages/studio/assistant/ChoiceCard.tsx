import { Check } from 'lucide-react'
import { useState } from 'react'
import type { AgentCard, AgentCardAnswer } from '@shared/agent/cards'
import { Button, cn } from '../../../components/ui'

/**
 * A question the Agent asked, waiting above the input. The answer is stored
 * on the message and sent as the next user message, which continues the
 * conversation; words typed in the input answer it too.
 */
export function ChoiceCard({
  card,
  busy,
  onAnswer,
}: {
  card: AgentCard
  busy: boolean
  onAnswer: (answer: AgentCardAnswer) => void
  onReply?: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const options = card.options ?? []

  function toggle(id: string): void {
    if (busy) return
    setSelected((current) => {
      if (card.multiple) return current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      return current[0] === id ? [] : [id]
    })
  }

  return (
    <div className="flex flex-col gap-2.5" data-card="choice">
      <div className="flex flex-col gap-0.5">
        <p className="text-control font-medium text-ink">{card.title}</p>
        {card.why ? <p className="text-caption text-ink-2">{card.why}</p> : null}
      </div>

      <div className="flex flex-col gap-1" role={card.multiple ? 'group' : 'radiogroup'} aria-label={card.title}>
        {options.map((option) => {
          const checked = selected.includes(option.id)
          return (
            <button
              key={option.id}
              type="button"
              role={card.multiple ? 'checkbox' : 'radio'}
              aria-checked={checked}
              disabled={busy}
              onClick={() => toggle(option.id)}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                checked ? 'bg-accent-soft' : 'bg-well enabled:hover:bg-well-strong',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center transition-colors',
                  card.multiple ? 'rounded-[4px]' : 'rounded-full',
                  checked ? 'bg-accent text-on-accent' : 'bg-well-strong',
                )}
              >
                {checked ? (
                  card.multiple ? (
                    <Check className="size-3" strokeWidth={2.6} />
                  ) : (
                    <span className="size-1.5 rounded-full bg-on-accent" />
                  )
                ) : null}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-ui text-ink">{option.label}</span>
                {option.detail ? <span className="text-caption text-ink-2 [overflow-wrap:anywhere]">{option.detail}</span> : null}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-1">
        <Button size="xs" tone="ghost" disabled={busy} onClick={() => onAnswer({ selected: [], skipped: true })}>
          跳过
        </Button>
        <span className="flex-1" />
        <Button size="xs" tone="primary" disabled={busy || selected.length === 0} onClick={() => onAnswer({ selected })}>
          确定
        </Button>
      </div>
    </div>
  )
}
