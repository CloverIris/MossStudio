import { AlertCircle, AlertTriangle, Info, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'

export type NoticeTone = 'info' | 'warn' | 'danger'

const noticeTone: Record<NoticeTone, { box: string; icon: LucideIcon; iconClass: string }> = {
  info: { box: 'bg-well', icon: Info, iconClass: 'text-ink-2' },
  warn: { box: 'bg-warn-soft', icon: AlertTriangle, iconClass: 'text-warn' },
  danger: { box: 'bg-danger-soft', icon: AlertCircle, iconClass: 'text-danger' },
}

/**
 * A message that sits in the page: something to know (info), something to
 * watch (warn), or something that will be lost (danger). A soft tonal fill
 * and an icon, never a border; the text stays ink so it reads at any tone.
 * `action` is one small Button (size xs or sm) that resolves it.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
  ...rest
}: {
  tone?: NoticeTone
  title?: ReactNode
  children: ReactNode
  action?: ReactNode
  className?: string
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'children' | 'className'>): React.JSX.Element {
  const style = noticeTone[tone]
  const Icon = style.icon
  return (
    <div
      role="status"
      data-notice={tone}
      className={cn('flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-ui text-ink', style.box, className)}
      {...rest}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', style.iconClass)} strokeWidth={1.6} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 self-center">{action}</div> : null}
    </div>
  )
}
