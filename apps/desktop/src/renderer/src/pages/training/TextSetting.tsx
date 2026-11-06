import { useEffect, useId, useState } from 'react'
import { Input, cn } from '../../components/ui'

/**
 * A text setting that saves itself: on blur or Enter, when the value changed and
 * is valid. Problems are shown under the field instead of in a toast.
 */
export function TextSetting({
  label,
  value,
  placeholder,
  validate,
  onSave,
  className,
  mono = true,
}: {
  label: string
  value: string | null
  placeholder?: string
  validate?: (value: string) => string | null
  onSave: (value: string | null) => Promise<void>
  className?: string
  mono?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(value ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const errorId = useId()

  useEffect(() => {
    setDraft(value ?? '')
  }, [value])

  async function commit(): Promise<void> {
    const next = draft.trim()
    const problem = validate?.(next) ?? null
    setError(problem)
    if (problem || next === (value ?? '') || saving) return
    setSaving(true)
    try {
      await onSave(next || null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={draft}
        placeholder={placeholder}
        disabled={saving}
        onChange={(event) => {
          setDraft(event.target.value)
          if (error) setError(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void commit()
          }
          if (event.key === 'Escape') {
            setDraft(value ?? '')
            setError(null)
          }
        }}
        className={cn('w-full', mono && 'font-mono text-caption')}
      />
      {error ? (
        <span id={errorId} role="alert" className="text-caption text-danger">
          {error}
        </span>
      ) : null}
    </div>
  )
}
