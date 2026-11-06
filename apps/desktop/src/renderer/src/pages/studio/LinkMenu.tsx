import { useEffect, useRef } from 'react'
import { MenuItem } from '../../components/common/Popover'
import type { LinkMenuEntry } from './connect'
import type { LinkRole } from './links'

const MENU_WIDTH = 240

/**
 * What a dropped wire becomes: 作为起始图 / 作为控制图 › kinds / 作为参考图.
 * Floats at the drop point, inside the board viewport.
 */
export function LinkMenu({
  entries,
  title,
  at,
  bounds,
  onPick,
  onClose,
}: {
  entries: readonly LinkMenuEntry[]
  title: string
  /** Drop point relative to the board viewport. */
  at: { x: number; y: number }
  bounds: { width: number; height: number }
  onPick: (role: LinkRole, kind?: string) => void
  onClose: () => void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) close.current()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close.current()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const left = Math.max(8, Math.min(at.x + 8, bounds.width - MENU_WIDTH - 8))
  const top = Math.max(8, Math.min(at.y + 8, bounds.height - 40 * (entries.length + 1) - 8))

  return (
    <div
      ref={root}
      role="menu"
      aria-label={title}
      data-board-ui
      data-link-menu
      className="absolute z-40 flex flex-col gap-0.5 rounded-xl bg-raised p-1.5 text-ink shadow-float"
      style={{ left, top, width: MENU_WIDTH }}
    >
      <div className="truncate px-2.5 pb-1 pt-0.5 text-caption text-ink-2">{title}</div>
      {entries.map((entry, index) => {
        if (entry.type === 'note') {
          return (
            <p key={index} className="px-2.5 py-1.5 text-caption text-ink-2">
              {entry.label}
            </p>
          )
        }
        if (entry.type === 'heading') {
          return (
            <div key={index} className="px-2.5 pt-1.5 text-micro font-medium text-ink-2">
              {entry.label}
            </div>
          )
        }
        return (
          <MenuItem
            key={index}
            disabled={entry.disabled}
            selected={entry.current}
            hint={entry.hint}
            onSelect={() => onPick(entry.role, entry.kind)}
          >
            {entry.role === 'control' && entry.kind ? <span className="pl-2">{entry.label}</span> : entry.label}
          </MenuItem>
        )
      })}
    </div>
  )
}
