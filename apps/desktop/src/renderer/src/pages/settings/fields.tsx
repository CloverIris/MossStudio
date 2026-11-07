import { FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Ipc } from '@shared/channels'
import type { Settings } from '@shared/types'
import { call } from '../../lib/api'
import { commitText, createCommitGuard, textOf, type Validator } from '../../lib/settingsDraft'
import { useApp } from '../../store'
import { Button, IconButton, Input, Row, Switch, cn, useToast } from '../../components/ui'
import { PathValue } from '../../components/common/PathValue'

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Save a settings patch; failures become a toast. Resolves to whether it was saved. */
export function useSaveSettings(): (patch: Partial<Settings> & { hfToken?: string | null }, success?: string) => Promise<boolean> {
  const saveSettings = useApp((state) => state.saveSettings)
  const toast = useToast()
  return useCallback(
    async (patch, success) => {
      try {
        await saveSettings(patch)
        if (success) toast.push(success, 'success')
        return true
      } catch (error) {
        toast.push(`没有保存：${errorText(error)}`, 'error')
        return false
      }
    },
    [saveSettings, toast],
  )
}

/** Open a folder in the system file manager. */
export function useOpenPath(): (path: string | null | undefined) => void {
  const toast = useToast()
  return useCallback(
    (path) => {
      if (!path) return
      void call(Ipc.openPath, { path }).catch((error: unknown) => toast.push(errorText(error), 'error'))
    },
    [toast],
  )
}

export async function pickFolder(title: string): Promise<string | null> {
  return call<string | null>(Ipc.pickDialog, { kind: 'folder', title })
}

/** A row whose control sits under its title, for long values like paths and addresses. */
export function StackRow({
  title,
  description,
  error,
  children,
  htmlFor,
}: {
  title: ReactNode
  description?: ReactNode
  error?: string | null
  children: ReactNode
  htmlFor?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg px-3.5 py-3">
      <div className="flex flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-control text-ink">
            {title}
          </label>
        ) : (
          <div className="text-control text-ink">{title}</div>
        )}
        {description ? <div className="text-caption text-ink-2">{description}</div> : null}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * A text setting that saves when it loses focus or on Enter. Escape puts the
 * saved value back. Invalid input stays in the field with the reason under it.
 */
export function TextSetting<T = string | null>({
  title,
  description,
  value,
  onSave,
  validate,
  parse,
  placeholder,
  type = 'text',
  mono,
  inline,
  inputClassName,
  trailing,
  clearOnSave,
}: {
  title: ReactNode
  description?: ReactNode
  value: T
  onSave: (value: T) => Promise<boolean>
  validate?: Validator
  parse?: (text: string) => T
  placeholder?: string
  type?: 'text' | 'password' | 'number'
  mono?: boolean
  /** Put the field on the right of the row instead of under the title. */
  inline?: boolean
  inputClassName?: string
  trailing?: ReactNode
  /** Empty the field after saving (secrets that are never shown again). */
  clearOnSave?: boolean
}): React.JSX.Element {
  const id = useId()
  const saved = textOf(value as string | number | null)
  const [draft, setDraft] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const focused = useRef(false)
  const guard = useRef(createCommitGuard()).current

  // Follow changes made elsewhere (another window, a reset) unless the person is typing.
  useEffect(() => {
    if (!focused.current) {
      setDraft(saved)
      setError(null)
      guard.reset()
    }
  }, [saved, guard])

  async function commit(): Promise<void> {
    if (!guard.shouldCommit(draft)) return
    const result = commitText<T>(draft, value, { validate, parse })
    if (result.kind === 'invalid') {
      setError(result.message)
      return
    }
    setError(null)
    if (result.kind === 'unchanged') return
    guard.sent(draft)
    setSaving(true)
    const ok = await onSave(result.value)
    setSaving(false)
    if (!ok) guard.failed()
    if (!ok || clearOnSave) setDraft(saved)
  }

  const input = (
    <Input
      id={id}
      type={type}
      value={draft}
      placeholder={placeholder}
      autoComplete={type === 'password' ? 'new-password' : 'off'}
      spellCheck={false}
      aria-invalid={error ? true : undefined}
      aria-busy={saving || undefined}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(event) => {
        setDraft(event.target.value)
        guard.reset()
        if (error) setError(null)
      }}
      onBlur={() => {
        focused.current = false
        void commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(saved)
          setError(null)
        }
      }}
      className={cn(mono && 'font-mono text-caption', inline ? 'w-40' : 'w-full', inputClassName)}
    />
  )

  if (inline) {
    return (
      <div className="flex flex-col">
        <Row title={<label htmlFor={id}>{title}</label>} description={description}>
          {input}
          {trailing}
        </Row>
        {error ? (
          <p role="alert" className="-mt-1 px-3.5 pb-2 text-right text-caption text-danger">
            {error}
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <StackRow title={title} description={description} error={error} htmlFor={id}>
      <div className="flex items-center gap-2">
        {input}
        {trailing}
      </div>
    </StackRow>
  )
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: ReactNode
  description?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Row title={title} description={description}>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={typeof title === 'string' ? title : undefined} />
    </Row>
  )
}

/** A folder setting: shows the folder in use, lets the person pick another or go back to the default. */
export function FolderRow({
  title,
  description,
  value,
  fallback,
  onChange,
  pickTitle,
}: {
  title: ReactNode
  description?: ReactNode
  /** The custom folder, or null for the default. */
  value: string | null
  /** The folder actually used when `value` is null. */
  fallback?: string | null
  onChange: (path: string | null) => Promise<boolean>
  pickTitle: string
}): React.JSX.Element {
  const toast = useToast()
  const openPath = useOpenPath()
  const shown = value ?? fallback ?? null

  async function pick(): Promise<void> {
    try {
      const path = await pickFolder(pickTitle)
      if (path && path !== value) await onChange(path)
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  return (
    <StackRow title={title} description={description}>
      <div className="flex min-w-0 items-center gap-2">
        <PathValue value={shown} empty="默认位置" suffix={value ? undefined : '（默认）'} className="flex-1" />
        <Button onClick={() => void pick()}>更改</Button>
        {value ? (
          <Button tone="ghost" onClick={() => void onChange(null)}>
            恢复默认
          </Button>
        ) : null}
        <IconButton label="在文件管理器中打开" disabled={!shown} onClick={() => openPath(shown)}>
          <FolderOpen className="size-4" />
        </IconButton>
      </div>
    </StackRow>
  )
}

/** Section heading + content column used by every settings section. */
export function SectionBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-7">{children}</div>
}
