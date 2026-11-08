import { Markdown } from '@openai/apps-sdk-ui/components/Markdown'
import { AlertCircle, Check, ChevronRight, Info, Loader2, X } from 'lucide-react'
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
import { cn } from './cn'
import { Collapse, Presence, useMotionPresence } from './motion'

export { cn } from './cn'
export { Field, Input, Select, Switch, Textarea } from './form'

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

type SurfaceTone = 'panel' | 'surface' | 'raised' | 'well'

const surfaceTone: Record<SurfaceTone, string> = {
  panel: 'bg-panel',
  surface: 'bg-surface',
  raised: 'bg-raised',
  well: 'bg-well',
}

/**
 * A grouped area. It is told apart from its surroundings by tone only, so use
 * a tone one step away from whatever it sits on (panel on surface, surface on panel).
 */
export function Card({ tone = 'panel', className, children, ...rest }: ComponentProps<'div'> & { tone?: SurfaceTone }): React.JSX.Element {
  return (
    <div className={cn('rounded-xl', surfaceTone[tone], className)} {...rest}>
      {children}
    </div>
  )
}

/** Page title block for content pages. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-ink [text-wrap:balance]">{title}</h1>
        {description ? <p className="mt-1 max-w-[68ch] text-ui text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** A titled section. Sections are separated by space, never by lines. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('flex flex-col gap-2.5', className)}>
      {title || actions ? (
        <div className="flex items-end justify-between gap-4 px-1">
          <div className="min-w-0">
            {title ? <h2 className="text-ui font-semibold text-ink-2">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-caption text-ink-2">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** A list of rows on one tonal plate, like a settings group. */
export function Group({
  children,
  className,
  tone = 'panel',
}: {
  children: ReactNode
  className?: string
  tone?: SurfaceTone
}): React.JSX.Element {
  return <div className={cn('flex flex-col gap-0.5 rounded-xl p-1.5', surfaceTone[tone], className)}>{children}</div>
}

/** One row in a Group: what it is on the left, its control on the right. */
export function Row({
  title,
  description,
  leading,
  children,
  className,
  onClick,
  selected,
}: {
  title: ReactNode
  description?: ReactNode
  leading?: ReactNode
  children?: ReactNode
  className?: string
  onClick?: () => void
  selected?: boolean
}): React.JSX.Element {
  const body = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="truncate text-control text-ink">{title}</div>
        {description ? <div className="text-caption text-ink-2 [overflow-wrap:anywhere]">{description}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </>
  )
  const classes = cn(
    'flex min-h-14 w-full items-center gap-4 rounded-lg px-3.5 py-2 text-left',
    selected && 'bg-well',
    onClick && 'transition-colors hover:bg-well',
    className,
  )
  return onClick ? (
    <button type="button" className={classes} onClick={onClick} aria-pressed={selected}>
      {body}
    </button>
  ) : (
    <div className={classes}>{body}</div>
  )
}

/**
 * Collapsed-by-default area for everything the app can decide on its own.
 * `dense` matches the caption-sized field labels of a dense side panel, so the
 * disclosure is never louder than the labels around it.
 */
export function Advanced({
  title = '高级',
  summary,
  children,
  defaultOpen = false,
  className,
  dense = false,
}: {
  title?: string
  summary?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  dense?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  return (
    <div className={cn('flex flex-col', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex items-center rounded-lg px-3.5 text-left transition-colors hover:bg-well',
          dense ? 'min-h-9 gap-2' : 'min-h-11 gap-3',
        )}
      >
        <ChevronRight
          className={cn('size-4 shrink-0 text-ink-2 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
          strokeWidth={1.6}
        />
        <span className={cn('font-medium text-ink-2', dense ? 'text-caption' : 'text-ui')}>{title}</span>
        {summary && !open ? <span className="min-w-0 flex-1 truncate text-caption text-ink-2">{summary}</span> : null}
      </button>
      <Collapse open={open} id={panelId}>
        <div className="pt-1">{children}</div>
      </Collapse>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

const statusColor: Record<CheckStatus, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  error: 'bg-danger',
  unknown: 'bg-ink-3',
}

/**
 * The label of a field or block (ui-rules: caption, medium, ink-2), with an optional value on the
 * right. `as="h3"` when it heads a block of content (a list of parameters, a group of inputs).
 */
export function FieldLabel({
  children,
  value,
  htmlFor,
  as = 'span',
  className,
}: {
  children: ReactNode
  value?: ReactNode
  htmlFor?: string
  as?: 'span' | 'h2' | 'h3'
  className?: string
}): React.JSX.Element {
  const label = 'text-caption font-medium text-ink-2'
  const Heading = as
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={label}>
          {children}
        </label>
      ) : (
        <Heading className={label}>{children}</Heading>
      )}
      {value !== undefined ? <span className="tabular flex items-center text-caption text-ink-2">{value}</span> : null}
    </div>
  )
}

export function StatusDot({ status, className }: { status: CheckStatus; className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={cn('inline-block size-2 shrink-0 rounded-full', statusColor[status], className)} />
}

type PillTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

const pillTone: Record<PillTone, string> = {
  neutral: 'bg-well text-ink-2',
  accent: 'bg-accent-soft text-ink',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
}

/** A small status label. Colour is reserved for state: ok, warn, danger. */
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
      className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium', pillTone[tone], className)}
    >
      {children}
    </span>
  )
}

/**
 * A word that tells a model from its family (INT8, 8 步, FP16-fixed), shown
 * after its name. Not a state: state is a `Pill`.
 */
export function Tag({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'tabular inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-micro font-semibold tracking-wide whitespace-nowrap',
        'bg-well-strong text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  )
}

const progressFill = {
  accent: 'bg-accent',
  neutral: 'bg-ink',
  /** Paused: the amount stays, the colour steps back. */
  muted: 'bg-ink-3',
  danger: 'bg-danger',
}

/**
 * Progress from 0 to 100. Pass `null` when the amount is not known: the bar
 * then shows a moving segment, never a full bar that would read as done.
 * `md` is the bar of a download row; `sm` (default) the thin one of the
 * titlebar, popovers and the installer.
 */
export function ProgressBar({
  value,
  tone = 'accent',
  size = 'sm',
  className,
  label,
  title,
}: {
  value: number | null
  tone?: keyof typeof progressFill
  size?: 'sm' | 'md'
  className?: string
  label?: string
  title?: string
}): React.JSX.Element {
  const fill = progressFill[tone]
  const track = cn('relative w-full overflow-hidden rounded-full bg-well-strong', size === 'md' ? 'h-1.5' : 'h-1', className)
  if (value === null) {
    return (
      <div role="progressbar" aria-label={label} aria-busy="true" data-indeterminate title={title} className={track}>
        <div className={cn('ui-progress-indeterminate absolute inset-y-0 left-0 w-[30%] rounded-full', fill)} />
      </div>
    )
  }
  const width = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
      title={title}
      className={track}
    >
      <div
        className={cn('h-full rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none', fill)}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return <Loader2 aria-hidden="true" className={cn('size-4 animate-spin', className)} strokeWidth={1.6} />
}

/** The one loading line: a spinner and what is being read. */
export function LoadingRow({ label = '正在读取…', className }: { label?: string; className?: string }): React.JSX.Element {
  return (
    <div role="status" className={cn('flex items-center gap-2 py-2 text-ui text-ink-2', className)}>
      <Spinner className="shrink-0" />
      {label}
    </div>
  )
}

const emptySize = {
  /** A whole page or panel with nothing in it. */
  page: { box: 'gap-2 px-6 py-14', title: 'text-control', description: 'text-ui' },
  /** One section or list inside a page. */
  section: { box: 'gap-1 px-4 py-6', title: 'text-ui', description: 'text-caption' },
}

/** The one empty pattern: what is missing, why, and the action that fills it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'page',
  className,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  size?: keyof typeof emptySize
  className?: string
}): React.JSX.Element {
  const sizes = emptySize[size]
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', sizes.box, className)}>
      {icon ? <div className="mb-1 text-ink-3">{icon}</div> : null}
      <p className={cn('font-medium text-ink', sizes.title)}>{title}</p>
      {description ? <p className={cn('max-w-md text-ink-2', sizes.description)}>{description}</p> : null}
      {action ? <div className={size === 'page' ? 'mt-3' : 'mt-2'}>{action}</div> : null}
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <kbd className={cn('font-sans text-caption font-normal opacity-60', className)}>{children}</kbd>
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ghost-danger'
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const buttonTone: Record<ButtonTone, string> = {
  primary: 'bg-ink text-on-ink font-semibold enabled:hover:opacity-90',
  secondary: 'bg-well text-ink enabled:hover:bg-well-strong',
  ghost: 'bg-transparent text-ink enabled:hover:bg-well',
  danger: 'bg-danger text-on-danger font-semibold enabled:hover:opacity-90',
  'ghost-danger': 'bg-transparent text-danger enabled:hover:bg-danger-soft',
}

const buttonSize: Record<ButtonSize, string> = {
  xs: 'h-[26px] px-2 text-ui gap-1',
  sm: 'h-[30px] px-3 text-ui gap-1.5',
  md: 'h-[34px] px-3.5 text-control gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2.5 rounded-lg',
}

/**
 * Primary is solid ink and appears at most once per view. Secondary is a
 * filled well, ghost has no fill until hovered. Danger is solid and confirms a
 * destructive action (the button inside the confirm step); ghost-danger starts
 * one from a row or a panel. Sizes: xs 26px (inline in dense panels), sm 30px,
 * md 34px (dialog footers), lg 44px (the one main action of a screen).
 */
export function Button({
  tone = 'secondary',
  size = 'sm',
  block,
  className,
  children,
  type = 'button',
  ...rest
}: ComponentProps<'button'> & {
  tone?: ButtonTone
  size?: ButtonSize
  block?: boolean
}): React.JSX.Element {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md transition-[background-color,opacity,color] disabled:opacity-40',
        buttonTone[tone],
        buttonSize[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function IconButton({ label, children, className, ...rest }: ComponentProps<'button'> & { label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors enabled:hover:bg-well enabled:hover:text-ink disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Two to five mutually exclusive choices. The chosen one is raised. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
  block,
}: {
  value: T
  options: Array<{ value: T; label: ReactNode; hint?: string; disabled?: boolean }>
  onChange: (value: T) => void
  className?: string
  label?: string
  block?: boolean
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex shrink-0 gap-0.5 rounded-lg bg-well p-[3px]', block && 'flex w-full', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.hint}
          disabled={option.disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex h-7 min-w-0 items-center justify-center whitespace-nowrap rounded-md px-3 text-ui transition-colors disabled:opacity-40',
            block && 'flex-1',
            value === option.value
              ? 'bg-raised font-semibold text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
              : 'text-ink-2 enabled:hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Page-level tabs. Same look as Segmented but without the well behind them. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T
  options: Array<{ value: T; label: ReactNode; count?: number }>
  onChange: (value: T) => void
  className?: string
  label?: string
}): React.JSX.Element {
  return (
    <div role="tablist" aria-label={label} className={cn('flex flex-wrap items-center gap-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-control transition-colors',
            value === option.value ? 'bg-well-strong font-semibold text-ink' : 'text-ink-2 hover:bg-well hover:text-ink',
          )}
        >
          {option.label}
          {option.count ? <span className="tabular text-caption text-ink-2">{option.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

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
      <header className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
        <div className="min-w-0 break-words">
          <h2 id={titleId} className="text-section font-semibold text-ink">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1 text-ui text-ink-2 [overflow-wrap:anywhere]">
              {description}
            </p>
          ) : null}
        </div>
        <IconButton label="关闭" onClick={onClose} className="-mr-2 -mt-1">
          <X className="size-4" strokeWidth={1.6} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">{children}</div>
      {footer ? <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-6 pb-5 pt-3">{footer}</footer> : null}
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
          'flex w-full flex-col overflow-hidden bg-surface shadow-float',
          sheet ? 'h-full' : 'max-h-[84vh] rounded-xl',
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

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  destructive = true,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
  destructive?: boolean
}): React.JSX.Element {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button tone="ghost" size="md" data-dialog-initial-focus onClick={onClose}>
            取消
          </Button>
          <Button tone={destructive ? 'danger' : 'primary'} size="md" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-control text-ink-2">{description}</p>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

type ToastTone = 'info' | 'success' | 'error'

/** One thing to do from a toast, e.g. 看看新内容. Choosing it closes the toast. */
export interface ToastAction {
  label: string
  onClick: () => void
}

type ToastPush = (message: string, tone?: ToastTone, action?: ToastAction) => void

interface ToastItem {
  id: string
  message: string
  tone: ToastTone
  action?: ToastAction
  open: boolean
}

const ToastContext = createContext<{ push: ToastPush }>({
  push: () => undefined,
})

export function useToast(): { push: ToastPush } {
  return useContext(ToastContext)
}

export function useCopyText(): (text: string, message?: string) => Promise<void> {
  const { push } = useToast()
  return useCallback(
    async (text: string, message = '已复制') => {
      try {
        await navigator.clipboard.writeText(text)
        push(message, 'success')
      } catch {
        push('复制失败，请选择文本后手动复制', 'error')
      }
    },
    [push],
  )
}

const toastIcon: Record<ToastTone, ReactNode> = {
  info: <Info className="size-4 text-ink-2" aria-hidden="true" strokeWidth={1.6} />,
  success: <Check className="size-4 text-ok" aria-hidden="true" strokeWidth={1.6} />,
  error: <AlertCircle className="size-4 text-danger" aria-hidden="true" strokeWidth={1.6} />,
}

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<string, number>())
  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
      timers.current.clear()
    },
    [],
  )
  useEffect(() => {
    const retained = new Set(items.map((item) => item.id))
    for (const [id, timer] of timers.current) {
      if (!retained.has(id)) {
        window.clearTimeout(timer)
        timers.current.delete(id)
      }
    }
  }, [items])
  const push = useCallback<ToastPush>((message, tone = 'info', action) => {
    const id = crypto.randomUUID()
    setItems((previous) => [...previous.slice(-2), { id, message, tone, action, open: true }])
    const timer = window.setTimeout(() => {
      timers.current.delete(id)
      setItems((previous) => previous.map((item) => (item.id === id ? { ...item, open: false } : item)))
    }, 5000)
    timers.current.set(id, timer)
  }, [])
  const value = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
        {items.map((item) => (
          <Presence
            key={item.id}
            open={item.open}
            preset="toast"
            onExited={() => setItems((previous) => previous.filter((entry) => entry.id !== item.id))}
            role="status"
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg bg-raised py-2.5 pl-3.5 pr-2 text-ui text-ink shadow-float"
          >
            <span className="mt-0.5">{toastIcon[item.tone]}</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.message}</span>
            {item.action ? (
              <button
                type="button"
                className="-my-1 h-7 shrink-0 rounded-md px-2 text-ui font-medium text-ink hover:bg-well"
                onClick={() => {
                  item.action!.onClick()
                  setItems((previous) => previous.map((entry) => (entry.id === item.id ? { ...entry, open: false } : entry)))
                }}
              >
                {item.action.label}
              </button>
            ) : null}
            <IconButton
              label="关闭提示"
              className="-my-1 size-7"
              onClick={() => {
                setItems((previous) => previous.map((entry) => (entry.id === item.id ? { ...entry, open: false } : entry)))
              }}
            >
              <X className="size-3.5" strokeWidth={1.6} />
            </IconButton>
          </Presence>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function MarkdownBody({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="clover-md selectable text-ui leading-6 text-ink-2">
      <Markdown breakNewLines skipHtml>
        {children}
      </Markdown>
    </div>
  )
}

/**
 * Standard content page: a light surface that scrolls, with a centred column.
 * Full-bleed pages (Studio, Library, Settings) lay themselves out instead.
 */
export function PageScroll({
  children,
  className,
  width = 'max-w-[1080px]',
}: {
  children: ReactNode
  className?: string
  width?: string
}): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className={cn('mx-auto flex w-full flex-col gap-8 px-10 pb-16 pt-8', width, className)}>{children}</div>
    </div>
  )
}
