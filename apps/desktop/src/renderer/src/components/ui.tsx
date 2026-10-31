import { Button as SdkButton } from '@openai/apps-sdk-ui/components/Button'
import { Markdown } from '@openai/apps-sdk-ui/components/Markdown'
import { AlertCircle, Check, Info, Loader2, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { CheckStatus } from '@shared/types'
import { Presence, useMotionPresence } from './motion'

export { Field, Input, Select, Switch, Textarea } from './form'

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function Card({
  className,
  children,
  ...rest
}: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      className={cn(
        'glass border border-[var(--color-border-subtle)]',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

const statusColor: Record<CheckStatus, string> = {
  ok: 'bg-sky-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  unknown: 'bg-neutral-400',
}

export function StatusDot({ status, className }: { status: CheckStatus; className?: string }): React.JSX.Element {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', statusColor[status], className)} />
}

type PillTone = 'neutral' | 'accent' | 'amber' | 'red' | 'blue'

const pillTone: Record<PillTone, string> = {
  neutral: 'border-[var(--color-border)] text-[var(--color-text-secondary)]',
  accent: 'border-accent-500/25 bg-accent-500/10 text-accent-600 dark:text-accent-300',
  amber: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  red: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
  blue: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
}

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: PillTone
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 text-caption font-medium leading-4',
        pillTone[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  tone = 'secondary',
  size = 'sm',
  className,
  children,
  style,
  ...rest
}: Omit<ComponentProps<typeof SdkButton>, 'color' | 'variant'> & {
  tone?: ButtonTone
}): React.JSX.Element {
  const color = tone === 'danger' ? 'danger' : tone === 'primary' ? 'primary' : 'secondary'
  const variant = tone === 'primary' ? 'solid' : tone === 'ghost' ? 'ghost' : 'soft'
  const tint =
    tone === 'secondary'
      ? 'border border-[var(--color-border-subtle)] bg-white/[0.045]'
      : ''
  return (
    <SdkButton
      color={color}
      variant={variant}
      size={size}
      className={cn(tint, className)}
      style={{
        borderRadius: 'var(--radius-control)',
        fontSize: 'var(--text-ui)',
        lineHeight: '20px',
        minHeight: 32,
        paddingInline: 12,
        color: tone === 'primary' ? '#ffffff' : undefined,
        ...style,
      }}
      {...rest}
    >
      {children}
    </SdkButton>
  )
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ComponentProps<'button'> & { label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'app-icon-button inline-flex size-8 shrink-0 items-center justify-center rounded-[4px] text-[var(--color-text-secondary)] transition enabled:hover:bg-white/[0.07] enabled:hover:text-[var(--color-text)] disabled:opacity-45',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function ProgressBar({
  value,
  tone = 'accent',
  className,
}: {
  value: number
  tone?: 'accent' | 'neutral'
  className?: string
}): React.JSX.Element {
  const width = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div className={cn('h-[3px] w-full overflow-hidden rounded-full bg-white/[0.08]', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-200 ease-out',
          tone === 'accent' ? 'bg-accent-500' : 'bg-[var(--color-text-tertiary)]',
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return <Loader2 className={cn('size-4 animate-spin', className)} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
      {icon ? <div className="text-[var(--color-text-tertiary)]">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-md text-[13px] leading-5 text-[var(--color-text-secondary)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  width?: string
}

function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width,
  sheet = false,
}: DialogProps & { sheet?: boolean }): React.JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null)
  const backdropPressed = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  const { present, ref: panel } = useMotionPresence(open, sheet ? 'sheet' : 'dialog')
  const content = useRef<ReactNode>(null)
  const trigger = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const element = dialog.current
    // A browser close request may be non-cancelable. Reopening during the
    // retained exit must re-enter the native top layer even if presence stayed true.
    if (!open || !element || element.open) return
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    element.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus({ preventScroll: true })
  })

  useLayoutEffect(() => {
    const element = dialog.current
    if (!present || !element) return
    // Native modal dialogs own the top layer, background inertness, focus trap
    // and focus restoration, including when another dialog opens above them.
    return () => {
      element.close()
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
    }
  }, [present])

  const body = (
    <>
      <header className="flex items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] px-5 py-4">
        <div className="min-w-0 break-words">
          <h2 id={titleId} className="text-[15px] font-semibold">{title}</h2>
          {description ? (
            <p id={descriptionId} className="mt-1 break-all text-section leading-5 text-[var(--color-text-secondary)]">{description}</p>
          ) : null}
        </div>
        <IconButton label="关闭" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] px-5 py-3">
          {footer}
        </footer>
      ) : null}
    </>
  )
  if (open) content.current = body
  if (!present) return null

  return createPortal(
    <dialog
      ref={dialog}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn('app-dialog', sheet && 'app-dialog-sheet')}
      data-motion-state={open ? 'open' : 'closed'}
      onClose={(event) => {
        event.stopPropagation()
        if (open && !event.currentTarget.open) onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (open) onClose()
      }}
      onMouseDown={(event) => {
        backdropPressed.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (open && backdropPressed.current && event.target === event.currentTarget) onClose()
        backdropPressed.current = false
      }}
    >
      <div
        ref={panel}
        inert={!open}
        className={cn(
          'app-dialog-panel glass-strong flex w-full flex-col overflow-hidden border border-[var(--color-border-subtle)] shadow-2xl',
          sheet ? 'h-full border-l' : 'max-h-[82vh]',
          width ?? (sheet ? 'max-w-[520px]' : 'max-w-2xl'),
        )}
      >
        {content.current}
      </div>
    </dialog>,
    document.body,
  )
}

export function Modal(props: DialogProps): React.JSX.Element {
  return <Dialog {...props} />
}

export function Sheet(props: DialogProps): React.JSX.Element {
  return <Dialog {...props} sheet />
}

export function ConfirmDialog({ open, title, description, confirmLabel, onClose, onConfirm }: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Modal open={open} title={title} onClose={onClose} width="max-w-md" footer={
      <>
        <Button tone="ghost" data-dialog-initial-focus onClick={onClose}>取消</Button>
        <Button tone="danger" onClick={onConfirm}>{confirmLabel}</Button>
      </>
    }>
      <p className="text-ui leading-6 text-[var(--color-text-secondary)]">{description}</p>
    </Modal>
  )
}

type ToastTone = 'info' | 'success' | 'error'

interface ToastItem {
  id: string
  message: string
  tone: ToastTone
  open: boolean
}

const ToastContext = createContext<{ push: (message: string, tone?: ToastTone) => void }>({
  push: () => undefined,
})

export function useToast(): { push: (message: string, tone?: ToastTone) => void } {
  return useContext(ToastContext)
}

export function useCopyText(): (text: string, message?: string) => Promise<void> {
  const { push } = useToast()
  return useCallback(async (text: string, message = '已复制') => {
    try {
      await navigator.clipboard.writeText(text)
      push(message, 'success')
    } catch {
      push('复制失败，请选择文本后手动复制', 'error')
    }
  }, [push])
}

const toastIcon: Record<ToastTone, ReactNode> = {
  info: <Info className="size-4 text-sky-500" />,
  success: <Check className="size-4 text-sky-500" />,
  error: <AlertCircle className="size-4 text-red-500" />,
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<string, number>())
  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer))
    timers.current.clear()
  }, [])
  useEffect(() => {
    const retained = new Set(items.map((item) => item.id))
    for (const [id, timer] of timers.current) {
      if (!retained.has(id)) {
        window.clearTimeout(timer)
        timers.current.delete(id)
      }
    }
  }, [items])
  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = crypto.randomUUID()
    setItems((previous) => [...previous.slice(-2), { id, message, tone, open: true }])
    const timer = window.setTimeout(() => {
      timers.current.delete(id)
      setItems((previous) => previous.map((item) => item.id === id ? { ...item, open: false } : item))
    }, 5000)
    timers.current.set(id, timer)
  }, [])
  const value = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-1.5">
        {items.map((item) => (
          <Presence
            key={item.id}
            open={item.open}
            preset="toast"
            onExited={() => setItems((previous) => previous.filter((entry) => entry.id !== item.id))}
            role="status"
            className="glass-strong pointer-events-auto flex items-start gap-2 rounded-[6px] border border-[var(--color-border-subtle)] px-2.5 py-2 text-ui shadow-lg"
          >
            {toastIcon[item.tone]}
            <span className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere]">{item.message}</span>
            <IconButton label="关闭提示" className="size-6" onClick={() => {
              setItems((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, open: false } : entry))
            }}><X className="size-3.5" /></IconButton>
          </Presence>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function MarkdownBody({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="clover-md text-[13px] leading-6 text-[var(--color-text-secondary)]">
      <Markdown breakNewLines skipHtml>
        {children}
      </Markdown>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T
  options: Array<{ value: T; label: string; hint?: string }>
  onChange: (value: T) => void
  className?: string
  label?: string
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className={cn('app-segmented inline-flex shrink-0 rounded-[4px] border border-[var(--color-border-subtle)] bg-white/[0.035] p-0.5', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.hint}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-h-7 whitespace-nowrap rounded-[3px] px-3 py-1 text-caption font-medium transition',
            value === option.value
              ? 'bg-white/[0.09] text-[var(--color-text)] shadow-sm'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
