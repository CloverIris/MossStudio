import { useCallback, useEffect, useRef, useState } from 'react'
import type { Wire } from './wires'

function isTyping(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]'))
}

/**
 * The selected wire: click selects, Delete / Backspace removes its link,
 * Escape lets go. Lineage wires are not links and cannot be removed.
 */
export function useWireSelection(
  wires: readonly Wire[],
  onRemove: (wire: Wire) => void,
): { selectedWireId: string | null; select: (id: string | null) => void; remove: (wire: Wire) => void } {
  const [selectedWireId, select] = useState<string | null>(null)
  const removeRef = useRef(onRemove)
  removeRef.current = onRemove

  const remove = useCallback((wire: Wire) => {
    if (wire.kind !== 'input' || !wire.role) return
    removeRef.current(wire)
    select(null)
  }, [])

  // A selected wire goes away when its link does.
  useEffect(() => {
    if (selectedWireId && !wires.some((wire) => wire.id === selectedWireId)) select(null)
  }, [wires, selectedWireId])

  useEffect(() => {
    if (!selectedWireId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || document.querySelector('dialog[open]')) return
      if (event.key === 'Escape') {
        select(null)
        return
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const wire = wires.find((item) => item.id === selectedWireId)
      if (!wire) return
      event.preventDefault()
      remove(wire)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedWireId, wires, remove])

  return { selectedWireId, select, remove }
}
