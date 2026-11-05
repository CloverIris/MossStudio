import { useEffect, useState, type ReactNode } from 'react'
import { Input, cn } from '../../components/ui'

/** Small building blocks shared by the 输入 and 高级 sampling sections. */

export function FieldLabel({ children, value, htmlFor }: { children: ReactNode; value?: ReactNode; htmlFor?: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-caption font-semibold text-ink-2">{children}</label>
      ) : (
        <span className="text-caption font-semibold text-ink-2">{children}</span>
      )}
      {value !== undefined ? <span className="tabular text-caption text-ink-2">{value}</span> : null}
    </div>
  )
}

/** A labelled range with its value on the right. */
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
}): React.JSX.Element {
  return (
    <label className={cn('flex items-center gap-3 text-caption', className)}>
      <span className="w-14 shrink-0 text-ink-2">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1 accent-ink"
      />
      <span className="tabular w-10 shrink-0 text-right text-ink">{format(value)}</span>
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
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      className={cn('tabular', className)}
    />
  )
}
