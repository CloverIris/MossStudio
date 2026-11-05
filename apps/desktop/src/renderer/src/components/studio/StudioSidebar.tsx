import type { ReactNode } from 'react'
import { cn } from '../ui'
import { StudioDivider } from './StudioDivider'

/** A resizable Studio side panel on the panel tone. */
export function StudioSidebar({ side, label, width, onWidthChange, children, className }: {
  side: 'left' | 'right'
  label: string
  width: number
  onWidthChange: (value: number) => void
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <aside
      aria-label={label}
      data-side={side}
      className={cn('relative flex h-full min-h-0 shrink-0 flex-col bg-panel', className)}
      style={{ width }}
    >
      {children}
      <StudioDivider
        label={side === 'left' ? '调整左侧面板宽度' : '调整右侧面板宽度'}
        value={width}
        direction={side === 'left' ? 1 : -1}
        onChange={onWidthChange}
        className={side === 'left' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'}
      />
    </aside>
  )
}
