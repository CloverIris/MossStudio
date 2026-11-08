import { AlertCircle, Check, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Collapse } from '../../../components/motion'
import { cn, Spinner } from '../../../components/ui'
import { toolLabel, traceHeadline } from './format'

export interface TraceEntry {
  id: string
  name: string
  status: 'running' | 'ok' | 'error'
  detail?: string
}

export function ToolLine({ status, name, detail }: { status: TraceEntry['status']; name: string; detail?: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-1.5 text-caption">
      {status === 'running' ? (
        <Spinner className="mt-0.5 size-3.5 shrink-0" />
      ) : status === 'ok' ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden="true" strokeWidth={1.6} />
      ) : (
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" strokeWidth={1.6} />
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="text-ink">{toolLabel(name)}</span>
        {detail ? <span className="text-ink-2"> · {detail}</span> : null}
      </span>
    </div>
  )
}

/**
 * What the Agent did, folded into one line. The detail (a whole canvas list,
 * for instance) is one click away, so a long read no longer pushes the answer
 * and its card out of sight.
 */
export function ToolTrace({ entries }: { entries: readonly TraceEntry[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return <></>
  const running = entries.some((entry) => entry.status === 'running')
  const failed = entries.some((entry) => entry.status === 'error')
  const last = entries[entries.length - 1]!
  const detail = entries.length === 1 ? last.detail : undefined

  return (
    <div className="rounded-lg bg-well">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-caption transition-colors enabled:hover:bg-well-strong"
      >
        {running ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : failed ? (
          <AlertCircle className="size-3.5 shrink-0 text-danger" aria-hidden="true" strokeWidth={1.6} />
        ) : (
          <Check className="size-3.5 shrink-0 text-ok" aria-hidden="true" strokeWidth={1.6} />
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-ink">{traceHeadline(entries.map((entry) => entry.name))}</span>
          {detail ? <span className="text-ink-2"> · {detail}</span> : null}
        </span>
        <ChevronDown className={cn('size-3.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} strokeWidth={1.6} />
      </button>
      <Collapse open={open}>
        <div className="flex flex-col gap-1 px-2.5 pb-2">
          {entries.map((entry) => (
            <ToolLine key={entry.id} {...entry} />
          ))}
        </div>
      </Collapse>
    </div>
  )
}
