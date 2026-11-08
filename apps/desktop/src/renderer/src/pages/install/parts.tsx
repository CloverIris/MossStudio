import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, cn, FieldLabel, ProgressBar } from '../../components/ui'

/**
 * One setup screen: the content scrolls if it must, the actions stay pinned to
 * the bottom of the (fixed-size) window so the next step is always in reach.
 */
export function Screen({ children, actions }: { children: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-3 pt-2">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">{children}</div>
      </div>
      {actions ? (
        <div className="shrink-0 px-10 pb-6 pt-2">
          <div className="mx-auto flex w-full max-w-[560px] flex-wrap items-center justify-end gap-2">{actions}</div>
        </div>
      ) : null}
    </div>
  )
}

/** A path on one line, cut in the middle of the line rather than at the end. */
export function PathText({ path, className }: { path: string; className?: string }): React.JSX.Element {
  return (
    <span title={path} className={cn('block min-w-0 truncate text-control text-ink [direction:ltr]', className)} data-path>
      {path}
    </span>
  )
}

/** A folder choice: its name, the path, a line under it and 更改… on the right. */
export function FolderField({
  label,
  path,
  detail,
  onChange,
  disabled,
  children,
}: {
  label: string
  path: string
  detail?: ReactNode
  onChange: () => void
  disabled?: boolean
  children?: ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={label} className="flex flex-col gap-1 rounded-xl bg-surface p-1.5">
      <div className="flex items-center gap-4 rounded-lg px-3.5 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <FieldLabel as="h2">{label}</FieldLabel>
          <PathText path={path} />
          {detail ? <span className="tabular text-caption text-ink-2">{detail}</span> : null}
        </div>
        <Button onClick={onChange} disabled={disabled}>
          更改…
        </Button>
      </div>
      {children}
    </section>
  )
}

/** A problem with the chosen folder, with an optional "use this instead" button. */
export function FolderProblem({ text, action }: { text: string; action?: { label: string; onClick: () => void } }): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-col gap-2.5 rounded-lg bg-warn-soft px-3.5 py-3">
      <p className="flex items-start gap-2 text-ui text-ink">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" strokeWidth={1.6} />
        <span className="[overflow-wrap:anywhere]">{text}</span>
      </p>
      {action ? (
        <Button className="max-w-full self-start" onClick={action.onClick}>
          <span className="min-w-0 truncate">{action.label}</span>
        </Button>
      ) : null}
    </div>
  )
}

/** The progress block of the install and uninstall screens. */
export function ProgressBlock({
  label,
  percent,
  detail,
}: {
  label: string
  percent: number | null
  detail?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 pt-2" role="status" aria-live="polite">
      {/* Words above the bar, as in first-run setup's steps. */}
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-ui text-ink">{label}</span>
        {percent !== null && percent < 100 ? <span className="tabular text-ui text-ink-2">{Math.round(percent)}%</span> : null}
      </div>
      <ProgressBar value={percent} label={label} />
      {detail ? <div className="min-w-0 text-caption text-ink-2">{detail}</div> : null}
    </div>
  )
}

/** What went wrong, said plainly, on the danger tone. */
export function FailureBlock({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl bg-danger-soft px-4 py-3.5 text-ui text-ink">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" strokeWidth={1.6} />
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
    </div>
  )
}
