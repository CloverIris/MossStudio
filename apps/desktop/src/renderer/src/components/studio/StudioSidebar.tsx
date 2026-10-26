import { PanelLeftOpen, PanelRightOpen } from 'lucide-react'
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { IconButton } from '../ui'
import { StudioDivider } from './StudioDivider'

export function StudioSidebar({ side, label, width, collapsed, onExpand, onWidthChange, children }: {
  side: 'left' | 'right'
  label: string
  width: number
  collapsed: boolean
  onExpand: () => void
  onWidthChange: (value: number) => void
  children: ReactNode
}): React.JSX.Element {
  const content = useRef<HTMLDivElement>(null)
  const expand = useRef<HTMLButtonElement>(null)
  const previous = useRef(collapsed)
  const direction = side === 'left' ? 1 : -1
  const name = side === 'left' ? '左栏' : '右栏'

  useLayoutEffect(() => {
    if (previous.current === collapsed) return
    previous.current = collapsed
    const target = collapsed ? expand.current : content.current?.querySelector<HTMLElement>('[data-sidebar-collapse]')
    target?.focus({ preventScroll: true })
  }, [collapsed])

  return (
    <aside className="studio-sidebar" aria-label={label} data-side={side} data-collapsed={collapsed}
      style={{ '--studio-sidebar-width': `${width}px` } as CSSProperties}>
      <div ref={content} className="studio-sidebar-content" inert={collapsed} aria-hidden={collapsed}>
        {children}
      </div>
      <div className="studio-sidebar-rail" inert={!collapsed} aria-hidden={!collapsed}>
        <IconButton ref={expand} label={`展开${name}`} aria-expanded={false} onClick={onExpand}>
          {side === 'left' ? <PanelLeftOpen className="size-4" /> : <PanelRightOpen className="size-4" />}
        </IconButton>
      </div>
      {!collapsed ? <StudioDivider label={side === 'left' ? '左侧设置宽度' : '右侧工具宽度'} value={width} direction={direction} onChange={onWidthChange} /> : null}
    </aside>
  )
}
