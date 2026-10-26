import { Bell, BellOff, Cpu, House, PanelLeftClose, PanelLeftOpen, SquareTerminal, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { t } from '../lib/i18n'
import { useApp } from '../store'
import { openWindow } from '../lib/windows'
import { cn, IconButton } from './ui'

interface AppTitlebarProps {
  kind: 'launcher' | 'creator' | 'terminal' | 'trainer' | 'devices'
  collapsed?: boolean
  onToggleSidebar?: () => void
  notificationsOpen?: boolean
  onToggleNotifications?: () => void
  unread?: number
  appName?: string
  appTag?: string
  right?: ReactNode
}

export function TitlebarFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <header
      data-platform={window.clover.platform}
      className="app-titlebar glass-thin drag relative flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)]"
    >
      {children}
    </header>
  )
}

export function AppTitlebar({
  kind,
  collapsed,
  onToggleSidebar,
  notificationsOpen,
  onToggleNotifications,
  unread = 0,
  appName = t('app.name'),
  appTag,
  right,
}: AppTitlebarProps): React.JSX.Element {
  const env = useApp((state) => state.env)
  const channel = window.clover.channel
  const version = env?.appVersion ?? '0.1.0'

  return (
    <TitlebarFrame>
      <div className="no-drag flex items-center gap-1">
        {kind === 'launcher' ? (
          <IconButton
            label={collapsed ? '展开侧栏' : '收起侧栏'}
            className="size-8"
            onClick={onToggleSidebar}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </IconButton>
        ) : (
          <IconButton label="回到工作台" className="size-8" onClick={() => openWindow('launcher')}>
            <House className="size-4" />
          </IconButton>
        )}
      </div>

      <div className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-baseline gap-1.5">
        <span className="text-ui font-semibold tracking-[-0.01em] text-[var(--color-text)]">{appName}</span>
        <span
          className={cn(
            'rounded-[2px] border px-1 py-px text-micro font-semibold uppercase leading-[11px] tracking-[0.08em]',
            channel === 'release'
              ? 'border-white/10 text-[var(--color-text-tertiary)]'
              : 'border-accent-500/30 text-accent-300',
          )}
        >
          {appTag ?? channel}
        </span>
        <span className="text-caption tabular-nums text-[var(--color-text-tertiary)]">{version}</span>
      </div>

      <div className="no-drag flex items-center gap-0.5">
        {kind === 'launcher' ? (
          <>
            <IconButton label="打开设备管理器" className="size-8" onClick={() => openWindow('devices')}>
              <Cpu className="size-4" />
            </IconButton>
            <IconButton label="打开 MossStudio" className="size-8" onClick={() => openWindow('creator')}>
              <Wand2 className="size-4" />
            </IconButton>
            <IconButton label="打开终端" className="size-8" onClick={() => openWindow('terminal')}>
              <SquareTerminal className="size-4" />
            </IconButton>
            <IconButton
              label={notificationsOpen ? '隐藏通知' : '显示通知'}
              aria-expanded={notificationsOpen}
              aria-controls="notification-panel"
              className={cn('relative size-8', notificationsOpen && 'bg-white/[0.07] text-[var(--color-text)]')}
              onClick={onToggleNotifications}
            >
              {notificationsOpen ? <Bell className="size-4" /> : <BellOff className="size-4" />}
              {unread > 0 ? (
                <span className="absolute right-1 top-1 flex min-w-3 items-center justify-center rounded-[3px] bg-accent-500 px-0.5 text-micro font-semibold leading-[12px] text-[#10141c]">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </IconButton>
          </>
        ) : kind === 'creator' ? (
          <IconButton label="打开终端" className="size-8" onClick={() => openWindow('terminal')}>
            <SquareTerminal className="size-4" />
          </IconButton>
        ) : null}
        {right}
      </div>
    </TitlebarFrame>
  )
}
