import { Check } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { cn } from '../cn'

/**
 * A checkbox with its label (and an optional line under it). The whole row is
 * the hit area; the box fills with the accent when checked.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg px-3.5 py-3 text-left transition-colors enabled:hover:bg-well disabled:opacity-40',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors',
          checked ? 'bg-accent text-on-accent' : 'bg-well-strong',
        )}
      >
        {checked ? <Check className="size-3.5" strokeWidth={2.6} /> : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-control text-ink">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="text-caption text-ink-2 [overflow-wrap:anywhere]">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  )
}
