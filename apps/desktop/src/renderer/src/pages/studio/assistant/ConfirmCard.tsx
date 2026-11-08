import { useState } from 'react'
import type { AgentCard, AgentCardAnswer } from '@shared/agent/cards'
import { Button, Input } from '../../../components/ui'

/**
 * A go/no-go card: approve, reject, or send back one sentence about what to
 * change. Used for "start generating?", where a plain yes/no in prose is easy
 * to miss and impossible to answer with a click.
 */
export function ConfirmCard({
  card,
  busy,
  onAnswer,
}: {
  card: AgentCard
  busy: boolean
  onAnswer: (answer: AgentCardAnswer) => void
}): React.JSX.Element {
  const [replying, setReplying] = useState(false)
  const [note, setNote] = useState('')
  const answered = card.answer !== undefined
  const approve = card.options?.find((option) => option.id === 'approve')?.label ?? '批准'
  const reject = card.options?.find((option) => option.id === 'reject')?.label ?? '拒绝'
  const result = card.answer?.freeText
    ? `已把要求发回：${card.answer.freeText}`
    : card.answer?.skipped
      ? '已跳过'
      : card.answer?.selected.includes('approve')
        ? `已${approve}`
        : `已${reject}`

  return (
    <div className="flex flex-col gap-2.5 rounded-lg bg-well px-3 py-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-ui text-ink">{card.title}</p>
        {card.why ? <p className="text-caption text-ink-2">{card.why}</p> : null}
      </div>

      {answered ? (
        <p className="text-caption text-ink-2">{result}</p>
      ) : replying ? (
        <div className="flex flex-col gap-2">
          <Input
            aria-label="想改哪里"
            value={note}
            disabled={busy}
            placeholder="想改什么？说一句就行"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex items-center gap-1">
            <Button size="xs" tone="ghost" disabled={busy} onClick={() => setReplying(false)}>
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
          <Button size="xs" tone="ghost" disabled={busy} onClick={() => onAnswer({ selected: ['reject'] })}>
            {reject}
          </Button>
          <Button size="xs" tone="ghost" disabled={busy} onClick={() => setReplying(true)}>
            改一句
          </Button>
          <span className="flex-1" />
          <Button size="xs" tone="primary" disabled={busy} onClick={() => onAnswer({ selected: ['approve'] })}>
            {approve}
          </Button>
        </div>
      )}
    </div>
  )
}
