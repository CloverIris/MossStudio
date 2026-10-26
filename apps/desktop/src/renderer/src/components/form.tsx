import { Switch as SdkSwitch } from '@openai/apps-sdk-ui/components/Switch'
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from 'react'

const FieldContext = createContext<{ id: string; hintId?: string } | null>(null)

export function Field({
  id,
  label,
  hint,
  children,
  className = '',
  labelClassName = '',
}: {
  id?: string
  label: string
  hint?: string
  children: ReactNode
  className?: string
  labelClassName?: string
}): React.JSX.Element {
  const generatedId = useId()
  const controlId = id ?? generatedId
  const hintId = hint ? `${controlId}-hint` : undefined
  return (
    <FieldContext.Provider value={{ id: controlId, hintId }}>
      <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
        <label htmlFor={controlId} className={`text-ui text-[var(--color-text-secondary)] ${labelClassName}`}>
          {label}
        </label>
        {children}
        {hint ? <span id={hintId} className="text-caption leading-4 text-[var(--color-text-tertiary)]">{hint}</span> : null}
      </div>
    </FieldContext.Provider>
  )
}

export function Input({ className = '', id, ...props }: ComponentProps<'input'>): React.JSX.Element {
  const field = useContext(FieldContext)
  return <input id={id ?? field?.id} aria-describedby={field?.hintId} className={`app-input ${className}`} {...props} />
}

export function Textarea({ className = '', id, ...props }: ComponentProps<'textarea'>): React.JSX.Element {
  const field = useContext(FieldContext)
  return <textarea id={id ?? field?.id} aria-describedby={field?.hintId} className={`app-input app-textarea ${className}`} {...props} />
}

export function Select({
  className = '',
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
      className={`app-input app-select ${className}`}
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

export function Switch({ className = '', ...props }: ComponentProps<typeof SdkSwitch> & {
  'aria-label'?: string
}): React.JSX.Element {
  return <SdkSwitch className={`app-switch ${className}`} {...props} />
}
