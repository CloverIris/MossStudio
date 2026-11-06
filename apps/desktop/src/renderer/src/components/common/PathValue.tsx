import { Copy } from 'lucide-react'
import { IconButton, useCopyText } from '../ui'
import { cn } from '../cn'

/**
 * A read-only folder, file or address: monospace in a well, cut to one line
 * with the full value on hover, selectable, and optionally copyable.
 */
export function PathValue({
  value,
  empty = '—',
  suffix,
  copy = false,
  className,
}: {
  value: string | null | undefined
  /** Shown when there is no value. */
  empty?: string
  /** Plain text after the value, e.g. "（默认）". */
  suffix?: string
  copy?: boolean
  className?: string
}): React.JSX.Element {
  const copyText = useCopyText()
  return (
    <span className={cn('flex min-w-0 items-center gap-1 rounded-md bg-well', className)} data-path-value>
      <span className="selectable min-w-0 flex-1 truncate px-2.5 py-1.5 font-mono text-caption text-ink-2" title={value ?? undefined}>
        {value || empty}
        {value && suffix ? suffix : ''}
      </span>
      {copy && value ? (
        <IconButton label="复制" className="mr-0.5 size-7" onClick={() => void copyText(value)}>
          <Copy className="size-3.5" strokeWidth={1.6} />
        </IconButton>
      ) : null}
    </span>
  )
}
