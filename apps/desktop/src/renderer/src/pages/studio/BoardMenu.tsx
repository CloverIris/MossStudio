import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MenuGap, MenuItem } from '../../components/common/Popover'

export type BoardMenuEntry = { label: string; onSelect: () => void; tone?: 'danger'; disabled?: boolean; title?: string } | { gap: true }

const MENU_WIDTH = 200

/** Keeps the useful entries: no gap at either end or next to another gap. */
export function tidyEntries(entries: readonly BoardMenuEntry[]): BoardMenuEntry[] {
  const out: BoardMenuEntry[] = []
  for (const entry of entries) {
    if ('gap' in entry && (!out.length || 'gap' in out[out.length - 1]!)) continue
    out.push(entry)
  }
  while (out.length && 'gap' in out[out.length - 1]!) out.pop()
  return out
}

/**
 * The board's right-click menu: on empty space, on a card or on a wire.
 * Floats at the pointer, kept inside the board viewport.
 */
export function BoardMenu({
  label,
  entries,
  at,
  bounds,
  onClose,
}: {
  label: string
  entries: readonly BoardMenuEntry[]
  /** The click point relative to the board viewport. */
  at: { x: number; y: number }
  bounds: { width: number; height: number }
  onClose: () => void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => setHeight(root.current?.offsetHeight ?? 0), [entries])

  useEffect(() => {
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
    window.addEventListener('blur', close.current)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close.current)
    }
  }, [])

  const left = Math.max(8, Math.min(at.x, bounds.width - MENU_WIDTH - 8))
  const top = Math.max(8, Math.min(at.y, bounds.height - height - 8))

  return (
    <div
      ref={root}
      role="menu"
      aria-label={label}
      data-board-ui
      data-board-menu
      onContextMenu={(event) => event.preventDefault()}
      className="absolute z-40 flex flex-col gap-0.5 rounded-xl bg-raised p-1.5 text-ink shadow-float"
      style={{ left, top, width: MENU_WIDTH }}
    >
      {tidyEntries(entries).map((entry, index) =>
        'gap' in entry ? (
          <MenuGap key={`gap-${index}`} />
        ) : (
          <MenuItem
            key={entry.label}
            tone={entry.tone}
            disabled={entry.disabled}
            title={entry.title}
            onSelect={() => {
              onClose()
              entry.onSelect()
            }}
          >
            {entry.label}
          </MenuItem>
        ),
      )}
    </div>
  )
}
