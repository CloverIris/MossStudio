import { createContext, useContext, useId, type ComponentProps, type ReactNode } from 'react'
import { cn } from './cn'

const FieldContext = createContext<{ id: string; hintId?: string } | null>(null)

/** A label above its control, with an optional hint underneath. */
export function Field({
  id,
  label,
  hint,
  children,
  className,
  labelClassName,
}: {
  id?: string
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
  labelClassName?: string
}): React.JSX.Element {
  const generatedId = useId()
  const controlId = id ?? generatedId
  const hintId = hint ? `${controlId}-hint` : undefined
  return (
    <FieldContext.Provider value={{ id: controlId, hintId }}>
      <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
        <label htmlFor={controlId} className={cn('text-caption font-medium text-ink-2', labelClassName)}>
          {label}
        </label>
        {children}
        {hint ? <span id={hintId} className="text-caption text-ink-2">{hint}</span> : null}
      </div>
    </FieldContext.Provider>
  )
}

export function Input({ className, id, ...props }: ComponentProps<'input'>): React.JSX.Element {
  const field = useContext(FieldContext)
  return <input id={id ?? field?.id} aria-describedby={field?.hintId} className={cn('ui-field', className)} {...props} />
}

export function Textarea({ className, id, ...props }: ComponentProps<'textarea'>): React.JSX.Element {
  const field = useContext(FieldContext)
  return <textarea id={id ?? field?.id} aria-describedby={field?.hintId} className={cn('ui-field ui-textarea', className)} {...props} />
}

export function Select({
  className,
  id,
  options,
  children,
  onChange,
  onValueChange,
  ...props
}: ComponentProps<'select'> & {
  options?: Array<{ value: string; label: string; disabled?: boolean }>
  onValueChange?: (value: string) => void
}): React.JSX.Element {
  const field = useContext(FieldContext)
  return (
    <select
      id={id ?? field?.id}
      aria-describedby={field?.hintId}
      className={cn('ui-field ui-select', className)}
      onChange={(event) => {
        onChange?.(event)
        onValueChange?.(event.target.value)
      }}
      {...props}
    >
      {options ? options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
      )) : children}
    </select>
  )
}

/** An on/off switch. The accent fill means "on". */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'onChange'> & {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-well-strong',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-0.5 size-4 rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[left]',
          checked ? 'left-4 bg-white' : 'left-0.5 bg-raised',
        )}
      />
    </button>
  )
}
