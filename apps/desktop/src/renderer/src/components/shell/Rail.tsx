import { Activity, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { cn } from '../cn'
import { visibleRoutes } from './routes'

function RailButton({
  label,
  description,
  active,
  onClick,
  badge,
  children,
  ...rest
}: {
  label: string
  description: string
  active: boolean
  onClick: () => void
  badge?: boolean
  children: ReactNode
  'data-route'?: string
  'aria-expanded'?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={description}
      onClick={onClick}
      className={cn(
        'relative flex size-[52px] flex-col items-center justify-center gap-1 rounded-lg text-micro transition-colors',
        active ? 'bg-panel font-semibold text-ink' : 'text-ink-2 hover:bg-well hover:text-ink',
      )}
      {...rest}
    >
      {children}
      <span>{label}</span>
      {badge ? <span aria-hidden="true" className="absolute right-3 top-2.5 size-[7px] rounded-full bg-accent" /> : null}
    </button>
  )
}

/** The left rail: work first, then the two system destinations at the bottom. */
export function Rail({ current, onNavigate }: { current: string; onNavigate: (route: string) => void }): React.JSX.Element {
  const settings = useApp((state) => state.settings)
  const unread = useApp((state) => state.notifications.some((item) => !item.read))
  const problems = useApp((state) => state.diagnostics.some((item) => item.severity === 'error'))
  const activityOpen = useShell((state) => state.activityOpen)
  const toggleActivity = useShell((state) => state.toggleActivity)
  const closeActivity = useShell((state) => state.closeActivity)

  return (
    <nav aria-label="主导航" className="flex w-16 shrink-0 flex-col items-center gap-1 bg-frame pb-3 pt-1">
      {visibleRoutes(settings).map((route) => {
        const Icon = route.icon
        return (
          <RailButton
            key={route.to}
            data-route={route.to}
            label={route.label}
            description={route.description}
            active={!activityOpen && current === route.to}
            onClick={() => {
              closeActivity()
              onNavigate(route.to)
            }}
          >
            <Icon className="size-5" strokeWidth={1.6} aria-hidden="true" />
          </RailButton>
        )
      })}
      <div className="flex-1" />
      <RailButton
        data-route="activity"
        label="活动"
        description="任务、通知和问题"
        active={activityOpen}
        aria-expanded={activityOpen}
        badge={unread || problems}
        onClick={toggleActivity}
      >
        <Activity className="size-5" strokeWidth={1.6} aria-hidden="true" />
      </RailButton>
      <RailButton
        data-route="/settings"
        label="设置"
        description="外观、设备、存储和网络"
        active={!activityOpen && current === '/settings'}
        onClick={() => {
          closeActivity()
          onNavigate('/settings')
        }}
      >
        <SlidersHorizontal className="size-5" strokeWidth={1.6} aria-hidden="true" />
      </RailButton>
    </nav>
  )
}
