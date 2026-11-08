import type { ReactNode } from 'react'
import { cn, ProgressBar } from '../../components/ui'
import type { ProgressInfo } from './logic'

/**
 * One download's progress: what it is doing and the percentage on top, the
 * bar, then the amount (or what went wrong) and the speed and time left (or
 * what is left) underneath. The bar's colour says the state: accent while it
 * downloads, grey when paused, red when it stopped on an error.
 */
export function DownloadProgress({
  info,
  label,
  heading,
  title,
  className,
}: {
  info: ProgressInfo
  /** Names the progress bar for assistive technology: "<model> 下载进度". */
  label: string
  /** Top left instead of the state words, e.g. the model's name on a 下载 row. */
  heading?: ReactNode
  /** The bar's tooltip: the file being written now. */
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)} data-download-progress>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        {heading ?? <span className="text-caption text-ink-2">{info.stateText}</span>}
        {info.percent !== null ? <span className="tabular shrink-0 text-ui font-semibold text-ink">{info.percent}%</span> : null}
      </div>
      <ProgressBar value={info.percent} tone={info.tone} size="md" label={label} title={title} />
      <div className="tabular flex min-w-0 justify-between gap-3 text-caption text-ink-2">
        <span className={cn('flex min-w-0 gap-3', info.detailTone === 'danger' && 'text-danger')}>
          {/* Under a name the state moves down here; while it downloads, the speed already says so. */}
          {/* Not twice: an error that already says 下载没有完成 stands alone. */}
          {heading && !info.detail.includes(info.stateText) ? (
            <span className={cn('shrink-0', info.stateText === '下载中' && 'sr-only')}>{info.stateText}</span>
          ) : null}
          <span className="min-w-0 truncate" title={info.detail}>
            {info.detail}
          </span>
        </span>
        {info.facts.length ? (
          <span className="flex shrink-0 gap-3">
            {info.facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  )
}
