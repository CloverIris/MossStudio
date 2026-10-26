import { useRef } from 'react'

const MIN_WIDTH = 240
const MAX_WIDTH = 480

export function StudioDivider({ label, value, direction, onChange }: {
  label: string
  value: number
  direction: 1 | -1
  onChange: (value: number) => void
}): React.JSX.Element {
  const gesture = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const update = (width: number): void => onChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
  return (
    <div
      className="studio-divider"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={Math.round(value)}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        update(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? MAX_WIDTH : value + (event.key === 'ArrowRight' ? 10 : -10) * direction)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        gesture.current = { pointerId: event.pointerId, x: event.clientX, width: value }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const start = gesture.current
        if (!start || start.pointerId !== event.pointerId) return
        if (!(event.buttons & 1)) { gesture.current = null; return }
        update(start.width + (event.clientX - start.x) * direction)
      }}
      onPointerUp={(event) => {
        if (gesture.current?.pointerId !== event.pointerId) return
        gesture.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { gesture.current = null }}
      onLostPointerCapture={() => { gesture.current = null }}
    />
  )
}
