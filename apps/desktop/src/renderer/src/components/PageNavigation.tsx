import { Boxes, Check, ChevronDown, Cpu, GraduationCap, Images, LayoutGrid, Package, Settings2, Stethoscope } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export const APP_PAGES = [
  { to: '/studio', label: '创作', description: '提示词、画布与图层布局', icon: LayoutGrid },
  { to: '/engines', label: '引擎', description: '本机与远端推理引擎', icon: Boxes },
  { to: '/models', label: '模型', description: '模型组件、下载与管理', icon: Package },
  { to: '/devices', label: '设备', description: '推理设备与 SSH 连接', icon: Cpu },
  { to: '/training', label: '训练', description: '训练环境与任务', icon: GraduationCap },
  { to: '/gallery', label: '画廊', description: '浏览生成结果与参考图', icon: Images },
  { to: '/diagnostics', label: '诊断', description: '运行状态与问题排查', icon: Stethoscope },
  { to: '/settings', label: '设置', description: '外观、网络与存储', icon: Settings2 },
] as const

export function PageNavigation({ value, onChange }: { value: string; onChange: (route: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const nextFocus = useRef<number | null>(null)
  const selected = APP_PAGES.findIndex((page) => page.to === value)
  const current = APP_PAGES[Math.max(0, selected)]
  const Icon = current.icon
  const focusItem = (index: number): void => {
    const item = menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')[index]
    item?.focus({ preventScroll: true })
    item?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }

  useEffect(() => {
    menu.current?.hidePopover()
  }, [value])

  return (
    <nav className="page-navigation no-drag" aria-label="页面导航">
      <button
        id="page-navigation-trigger"
        type="button"
        className="page-navigation-trigger"
        aria-label={`切换页面：${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="page-navigation-menu"
        popoverTarget="page-navigation-menu"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const index = event.key === 'ArrowUp' ? APP_PAGES.length - 1 : Math.max(0, selected)
          if (menu.current?.matches(':popover-open')) focusItem(index)
          else { nextFocus.current = index; menu.current?.showPopover() }
        }}
      >
        <Icon className="size-4 shrink-0" />
        <span>{current.label}</span>
        <ChevronDown className="page-navigation-chevron size-3.5 shrink-0" />
      </button>
      {createPortal(
        <div
          ref={menu}
          id="page-navigation-menu"
          className="page-navigation-menu no-drag"
          popover="auto"
          role="menu"
          aria-label="切换页面"
          onBeforeToggle={(event) => { event.currentTarget.inert = event.newState !== 'open' }}
          onToggle={(event) => {
            const showing = event.newState === 'open'
            setOpen(showing)
            if (showing) {
              focusItem(nextFocus.current ?? Math.max(0, selected))
              nextFocus.current = null
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') { menu.current?.hidePopover(); return }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') ?? [])
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            focusItem(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
          }}
        >
          {APP_PAGES.map((page) => {
            const PageIcon = page.icon
            const active = page.to === current.to
            return (
              <button key={page.to} type="button" role="menuitemradio" aria-checked={active} tabIndex={-1}
                ref={(element) => { element?.toggleAttribute('autofocus', active) }}
                className="page-navigation-item" data-route={page.to}
                onClick={() => { menu.current?.hidePopover(); onChange(page.to) }}>
                <span className="page-navigation-item-icon"><PageIcon className="size-4" /></span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-ui">{page.label}</span>
                  <span className="block text-caption text-[var(--dropdown-text)]">{page.description}</span>
                </span>
                <span className="flex size-4 shrink-0 items-center" aria-hidden="true">{active ? <Check className="size-4" /> : null}</span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </nav>
  )
}
