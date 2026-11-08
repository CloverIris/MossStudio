import { useState } from 'react'
import type { AgentCard, AgentCardAnswer } from '@shared/agent/cards'
import { Button, Input } from '../../../components/ui'

/**
 * The changes the Agent wants to make, shown before anything happens. Applying
 * runs the steps in the order they were planned; nothing goes back to the model
 * first, so a confirmed plan is applied exactly as it was shown.
 */
export function PlanCard({
  card,
  busy,
  onAnswer,
}: {
  card: AgentCard
  busy: boolean
  onAnswer: (answer: AgentCardAnswer) => void
}): React.JSX.Element {
  const [adjusting, setAdjusting] = useState(false)
  const [note, setNote] = useState('')
  const answered = card.answer !== undefined
  const steps = card.steps ?? []

  const result = card.answer?.applied
    ? `已应用 ${steps.length} 处改动`
    : card.answer?.skipped
      ? '已放弃'
      : card.answer?.freeText
        ? '调整意见已发出'
        : ''

  return (
    <div className="flex flex-col gap-2.5 rounded-lg bg-well px-3 py-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-ui text-ink">{card.title}</p>
        {card.why ? <p className="text-caption text-ink-2">{card.why}</p> : null}
      </div>

      {steps.length > 1 ? (
        <ul className="flex flex-col gap-1">
          {steps.map((step, index) => (
            <li key={`${step.tool}-${index}`} className="flex items-start gap-2 text-caption">
              <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-3" />
              <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{step.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {answered ? (
        <p className="text-caption text-ink-2">{result}</p>
      ) : adjusting ? (
        <div className="flex flex-col gap-2">
          <Input
            aria-label="想改哪里"
            value={note}
            disabled={busy}
            placeholder="想改哪里？说一句就行"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex items-center gap-1">
            <Button size="xs" tone="ghost" disabled={busy} onClick={() => setAdjusting(false)}>
              取消
            </Button>
            <span className="flex-1" />
            <Button
              size="xs"
              tone="secondary"
              disabled={busy || !note.trim()}
              onClick={() => onAnswer({ selected: [], freeText: note.trim() })}
            >
              发给助手
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button size="xs" tone="ghost" disabled={busy} onClick={() => onAnswer({ selected: [], skipped: true })}>
            放弃
          </Button>
          <Button size="xs" tone="ghost" disabled={busy} onClick={() => setAdjusting(true)}>
            调整
          </Button>
          <span className="flex-1" />
          <Button size="xs" tone="primary" disabled={busy} onClick={() => onAnswer({ selected: [], applied: true })}>
            应用
          </Button>
        </div>
      )}
    </div>
  )
}
