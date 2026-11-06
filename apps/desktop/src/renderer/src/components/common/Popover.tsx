import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '../cn'

/**
 * A small raised panel anchored under its trigger (menus, pickers). Closes on
 * Escape, on a click outside, and when an item calls `close`.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  className,
  label,
}: {
  /** Renders the trigger; spread `props` onto the button that opens the panel. */
  trigger: (props: {
    open: boolean
    toggle: () => void
    'aria-expanded': boolean
    'aria-controls': string
    'aria-haspopup': 'menu' | 'dialog'
  }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
  label?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      root.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div ref={root} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((value) => !value), 'aria-expanded': open, 'aria-controls': id, 'aria-haspopup': 'menu' })}
      {open ? (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className={cn(
            'absolute top-full z-50 mt-1.5 flex min-w-[200px] flex-col gap-0.5 rounded-xl bg-raised p-1.5 text-ink shadow-float',
            align === 'start' && 'left-0',
            align === 'end' && 'right-0',
            align === 'center' && 'left-1/2 -translate-x-1/2',
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  )
}

/** One row inside a Popover menu. */
export function MenuItem({
  children,
  onSelect,
  selected,
  tone = 'default',
  disabled,
  hint,
}: {
  children: ReactNode
  onSelect: () => void
  selected?: boolean
  tone?: 'default' | 'danger'
  disabled?: boolean
  hint?: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={selected ? 'true' : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-ui transition-colors enabled:hover:bg-well disabled:opacity-40',
        selected && 'bg-well-strong font-medium',
        tone === 'danger' ? 'text-danger' : 'text-ink',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-caption text-ink-2">{hint}</span> : null}
    </button>
  )
}

/** Vertical space between groups of menu items (no rule lines). */
export function MenuGap(): React.JSX.Element {
  return <div aria-hidden="true" className="h-1.5" />
}
