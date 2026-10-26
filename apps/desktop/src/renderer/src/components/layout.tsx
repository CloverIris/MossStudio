import {
  Boxes,
  Home,
  Images,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  Stethoscope,
  Dumbbell,
  Wand2,
  type LucideIcon,
} from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { t, type MessageKey } from '../lib/i18n'
import { useApp } from '../store'
import { cn, IconButton } from './ui'

interface NavItem {
  to: string
  key: MessageKey
  icon: LucideIcon
  end?: boolean
}

const launcherNav: NavItem[] = [
  { to: '/', key: 'nav.home', icon: Home, end: true },
  { to: '/instances', key: 'nav.instances', icon: Boxes },
  { to: '/models', key: 'nav.models', icon: Package },
  { to: '/training', key: 'nav.trainer', icon: Dumbbell },
  { to: '/gallery', key: 'nav.gallery', icon: Images },
  { to: '/diagnostics', key: 'nav.diagnostics', icon: Stethoscope },
]

const creatorNav: NavItem[] = [
  { to: '/studio', key: 'nav.studio', icon: Wand2 },
  { to: '/gallery', key: 'nav.gallery', icon: Images },
]

function NavRow({
  item,
  collapsed,
  count,
}: {
  item: NavItem
  collapsed: boolean
  count?: number
}): React.JSX.Element {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? t(item.key) : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center rounded-[4px] text-ui transition-colors',
          collapsed ? 'h-8 justify-center' : 'h-8 gap-2.5 px-2.5',
          isActive
            ? 'bg-white/[0.065] font-medium text-[var(--color-text)]'
            : 'text-[var(--color-text-secondary)] hover:bg-white/[0.04] hover:text-[var(--color-text)]',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn('size-[15px] shrink-0', isActive && 'text-[var(--color-text)]')}
            strokeWidth={1.8}
          />
          {!collapsed ? <span className="flex-1 truncate">{t(item.key)}</span> : null}
          {!collapsed && count ? (
            <span className="rounded-[4px] bg-white/[0.07] px-1.5 text-caption leading-[16px] text-[var(--color-text-tertiary)]">
              {count}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  )
}

export function Sidebar(): React.JSX.Element {
  const settings = useApp((state) => state.settings)
  const instances = useApp((state) => state.instances)
  const downloads = useApp((state) => state.downloads)
  const diagnostics = useApp((state) => state.diagnostics)
  const collapsed = settings?.sidebarCollapsed ?? false
  const activeDownloads = downloads.filter((task) => task.state === 'running' || task.state === 'queued' || task.state === 'verifying').length

  return (
    <aside
      className={cn(
        'glass-thin flex shrink-0 flex-col border-r border-[var(--color-border-subtle)] px-2 pb-2 pt-2 transition-[width] duration-200 ease-out',
        collapsed ? 'w-[56px]' : 'w-[200px]',
      )}
    >
      <nav className="flex flex-col gap-0.5">
        {launcherNav.map((item) => (
          <NavRow
            key={item.to}
            item={item}
            collapsed={collapsed}
            count={
              item.to === '/instances'
                ? instances.length
                : item.to === '/models'
                  ? activeDownloads
                  : item.to === '/diagnostics'
                    ? diagnostics.length
                    : 0
            }
          />
        ))}
      </nav>

      <div className="mt-auto">
        <NavRow
          item={{ to: '/settings', key: 'nav.settings', icon: SettingsIcon }}
          collapsed={collapsed}
        />
      </div>
    </aside>
  )
}

export function CreatorSidebar(): React.JSX.Element {
  return (
    <aside className="glass-thin flex w-[200px] shrink-0 flex-col border-r border-[var(--color-border-subtle)] px-2 pb-2 pt-2">
      <nav className="flex flex-col gap-0.5">
        {creatorNav.map((item) => (
          <NavRow key={item.to} item={item} collapsed={false} />
        ))}
      </nav>
      <div className="mt-auto px-2.5 pb-1 text-caption leading-4 text-[var(--color-text-tertiary)]">
        MossStudio
      </div>
    </aside>
  )
}

export function SidebarCollapseButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <IconButton label={collapsed ? '展开侧栏' : '收起侧栏'} onClick={onToggle}>
      {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
    </IconButton>
  )
}
