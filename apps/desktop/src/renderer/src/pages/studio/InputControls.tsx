import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { IconButton, Input, cn } from '../../components/ui'

/** Small building blocks shared by the 生成设置 panel: 输入, 模型, 高级 and sampling. */

export { FieldLabel } from '../../components/ui'

/**
 * One slot of 输入 or 模型 (起始图, 控制, 参考图, LoRA): its name, a short hint
 * and its add action. A sub-slot (a kind of control adapter) reads quieter,
 * indented under its slot by the caller.
 */
export function SlotHeader({
  title,
  hint,
  children,
  sub,
}: {
  title: string
  hint?: string
  children?: ReactNode
  sub?: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-h-[26px] items-center justify-between gap-2">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn('shrink-0', sub ? 'text-caption text-ink-2' : 'text-ui text-ink')}>{title}</span>
        {hint ? <span className="truncate text-caption text-ink-2">{hint}</span> : null}
      </span>
      {children}
    </div>
  )
}

/**
 * One thing a slot holds (a linked picture, a LoRA): what it is, a remove
 * action, and its strength underneath. Every slot item has this one shape.
 */
export function SlotRow({
  leading,
  title,
  caption,
  titleTone = 'ink',
  removeLabel,
  onRemove,
  children,
  ...rest
}: {
  leading?: ReactNode
  title: string
  caption?: ReactNode
  /** warn: the item cannot be used as it is (a LoRA whose file is gone). */
  titleTone?: 'ink' | 'warn'
  removeLabel: string
  /** Absent on a read-only canvas. */
  onRemove?: () => void
  children?: ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'children'>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-well p-2" {...rest}>
      <div className="flex items-center gap-2.5">
        {leading ? <span className="shrink-0">{leading}</span> : null}
        <span className={cn('flex min-w-0 flex-1 flex-col', !leading && 'pl-1')}>
          <span className={cn('truncate text-ui', titleTone === 'warn' ? 'text-warn' : 'text-ink')} title={title}>
            {title}
          </span>
          {caption ? <span className="truncate text-caption text-ink-2">{caption}</span> : null}
        </span>
        {onRemove ? (
          <IconButton label={removeLabel} className="size-7" onClick={onRemove}>
            <X className="size-3.5" strokeWidth={1.6} />
          </IconButton>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/** A labelled range with its value on the right. Every slider of the panel is one of these. */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
  className,
  id,
  ariaLabel,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
  disabled?: boolean
  className?: string
  id?: string
  /** When several sliders share a label (强度), the name that tells them apart. */
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <label className={cn('flex items-center gap-3 text-caption', className)}>
      <span className="w-14 shrink-0 text-ink-2">{label}</span>
      <input
        id={id}
        type="range"
        aria-label={ariaLabel ?? label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1 accent-ink"
      />
      <span className="tabular w-10 shrink-0 text-right text-ink-2">{format(value)}</span>
    </label>
  )
}

/**
 * A number field that commits on blur or Enter; empty means "use the default"
 * (shown as the 默认 placeholder).
 */
export function OptionalNumberInput({
  label,
  value,
  onCommit,
  parse,
  placeholder = '默认',
  id,
  className,
}: {
  label: string
  value: number | undefined
  onCommit: (value: number | undefined) => void
  /** Turn typed text into a valid value, or null to refuse it. */
  parse: (value: number) => number | null
  placeholder?: string
  id?: string
  className?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value])
  const commit = (): void => {
    const text = draft.trim()
    if (!text) {
      if (value !== undefined) onCommit(undefined)
      return
    }
    const parsed = parse(Number(text))
    if (parsed === null) {
      setDraft(value === undefined ? '' : String(value))
      return
    }
    setDraft(String(parsed))
    if (parsed !== value) onCommit(parsed)
  }
  return (
    <Input
      id={id}
      aria-label={label}
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d.-]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      className={cn('tabular', className)}
    />
  )
}
