import { Check } from 'lucide-react'
import { useState } from 'react'
import type { AgentCard, AgentCardAnswer } from '@shared/agent/cards'
import { Button, cn, Input } from '../../../components/ui'

/**
 * A question the Agent asked, answered in the chat. The answer is stored on the
 * message (so a reopened conversation still shows it) and then sent as the next
 * user message, which is what continues the conversation.
 */
export function ChoiceCard({
  card,
  busy,
  onAnswer,
}: {
  card: AgentCard
  busy: boolean
  onAnswer: (answer: AgentCardAnswer) => void
}): React.JSX.Element {
  const answered = card.answer !== undefined
  const [selected, setSelected] = useState<string[]>(card.answer?.selected ?? [])
  const [free, setFree] = useState(card.answer?.freeText ?? '')
  const options = card.options ?? []
  const locked = answered || busy

  function toggle(id: string): void {
    if (locked) return
    setSelected((current) => {
      if (card.multiple) return current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      return current[0] === id ? [] : [id]
    })
  }

  const chosen = options.filter((option) => (card.answer?.selected ?? selected).includes(option.id))
  const summary = card.answer?.skipped
    ? '已跳过'
    : [
        chosen.length ? `你选了：${chosen.map((option) => option.label).join('、')}` : '',
        card.answer?.freeText ? `补充：${card.answer.freeText}` : '',
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <div className="flex flex-col gap-2.5 rounded-lg bg-well px-3 py-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-ui text-ink">{card.title}</p>
        {card.why ? <p className="text-caption text-ink-2">{card.why}</p> : null}
      </div>

      <div className="flex flex-col gap-0.5" role={card.multiple ? 'group' : 'radiogroup'} aria-label={card.title}>
        {options.map((option) => {
          const checked = (card.answer?.selected ?? selected).includes(option.id)
          return (
            <button
              key={option.id}
              type="button"
              role={card.multiple ? 'checkbox' : 'radio'}
              aria-checked={checked}
              disabled={locked}
              onClick={() => toggle(option.id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors enabled:hover:bg-well-strong',
                answered && !checked && 'opacity-50',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex size-[18px] shrink-0 items-center justify-center transition-colors',
                  card.multiple ? 'rounded-[5px]' : 'rounded-full',
                  checked ? 'bg-accent text-on-accent' : 'bg-well-strong',
                )}
              >
                {checked ? (
                  card.multiple ? (
                    <Check className="size-3.5" strokeWidth={2.6} />
                  ) : (
                    <span className="size-1.5 rounded-full bg-on-accent" />
                  )
                ) : null}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-control text-ink">{option.label}</span>
                {option.detail ? <span className="text-caption text-ink-2 [overflow-wrap:anywhere]">{option.detail}</span> : null}
              </span>
            </button>
          )
        })}
      </div>

      {answered ? (
        <p className="text-caption text-ink-2">{summary || '已作答'}</p>
      ) : (
        <>
          {card.allowFreeText ? (
            <Input
              aria-label="补充说明"
              value={free}
              disabled={busy}
              placeholder="也可以直接写你的答案…"
              onChange={(event) => setFree(event.target.value)}
              className="h-8"
            />
          ) : null}
          <div className="flex items-center gap-1">
            <Button size="xs" tone="ghost" disabled={busy} onClick={() => onAnswer({ selected: [], skipped: true })}>
              跳过
            </Button>
            <span className="flex-1" />
            <Button
              size="xs"
              tone="primary"
              disabled={busy || (selected.length === 0 && !free.trim())}
              onClick={() => onAnswer({ selected, freeText: free.trim() || undefined })}
            >
              选好了
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
