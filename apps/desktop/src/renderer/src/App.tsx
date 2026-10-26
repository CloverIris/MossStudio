import { useEffect, useRef, useState } from 'react'
import defaultHomeBackground from './assets/home-background.png'
import { Events } from '@shared/channels'
import type { Diagnostic } from '@shared/types'
import { onEvent } from './lib/api'
import { useToast } from './components/ui'
import { HashRouter, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider } from './components/ui'
import { NotificationPanel } from './components/NotificationPanel'
import { UpdateDialog } from './components/UpdateDialog'
import { Oobe } from './components/Oobe'
import { GalleryPage } from './pages/Gallery'
import { DiagnosticsPage } from './pages/Diagnostics'
import { DevicesPage } from './pages/Devices'
import { EnginePage } from './pages/Engine'
import { StudioPage } from './pages/Studio'
import { ModelsPage } from './pages/Models'
import { SettingsPage } from './pages/Settings'
import { TerminalPage } from './pages/Terminal'
import { TrainingPage } from './pages/Training'
import { TrainerWindow } from './pages/TrainerWindow'
import { useApp } from './store'
import { cloverUrl } from './lib/clover'
import { MotionPanel } from './components/motion'
import { AppTitlebar, TitlebarFrame } from './components/AppTitlebar'
import type { WindowIntent } from './lib/windows'
import {
  Bell,
  Boxes,
  Cpu,
  GraduationCap,
  Images,
  LayoutGrid,
  Package,
  Settings2,
  SquareTerminal,
  Stethoscope,
  X,
  GripVertical,
} from 'lucide-react'
import { IconButton, cn } from './components/ui'

function useAppBackground(): React.CSSProperties {
  const settings = useApp((state) => state.settings)
  const custom = Boolean(settings?.homeBackground)
  const source = custom ? cloverUrl(settings!.homeBackground!) : defaultHomeBackground
  return {
    backgroundImage: `linear-gradient(rgba(18,20,24,${custom ? 0.78 : 0.55}), rgba(18,20,24,${custom ? 0.90 : 0.70})), url("${source}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundColor: '#191b1f',
  }
}

const PAGES = [
  { to: '/studio', label: '创作', title: 'Studio', icon: LayoutGrid },
  { to: '/engines', label: '引擎', title: '引擎', icon: Boxes },
  { to: '/models', label: '模型', title: '模型与下载', icon: Package },
  { to: '/devices', label: '设备', title: '设备与连接', icon: Cpu },
  { to: '/training', label: '训练', title: '训练', icon: GraduationCap },
  { to: '/gallery', label: '画廊', title: '画廊', icon: Images },
  { to: '/diagnostics', label: '诊断', title: '诊断', icon: Stethoscope },
  { to: '/settings', label: '设置', title: '设置', icon: Settings2 },
] as const

const PAGE_COMPONENTS: Record<string, React.ComponentType> = {
  '/studio': StudioPage,
  '/engines': EnginePage,
  '/models': ModelsPage,
  '/devices': DevicesPage,
  '/training': TrainingPage,
  '/gallery': GalleryPage,
  '/diagnostics': DiagnosticsPage,
  '/settings': SettingsPage,
}

function PageHost({ active }: { active: string }): React.JSX.Element {
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([active]))
  useEffect(() => {
    setMounted((previous) => previous.has(active) ? previous : new Set([...previous, active]))
  }, [active])
  return (
    <>
      {[...mounted].map((key) => {
        const Page = PAGE_COMPONENTS[key]
        if (!Page) return null
        const studio = key === '/studio'
        return (
          <div key={key} className={cn('h-full min-h-0', key !== active && 'hidden')}>
            <div className={studio ? 'h-full w-full px-3 py-2' : 'mx-auto h-full w-full max-w-[1200px] overflow-y-auto px-6 py-5'}>
              <ErrorBoundary><Page /></ErrorBoundary>
            </div>
          </div>
        )
      })}
    </>
  )
}

function StudioShell(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const backgroundStyle = useAppBackground()
  const notificationsOpen = useApp((state) => state.notificationsOpen)
  const setNotificationsOpen = useApp((state) => state.setNotificationsOpen)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const studio = location.pathname === '/studio'
  const page = PAGES.find((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)) ?? PAGES[0]

  useEffect(() => {
    const listener = (event: Event): void => {
      const intent = (event as CustomEvent<WindowIntent>).detail
      if (intent.target === 'terminal') setTerminalOpen(true)
      else if (intent.target === 'management') navigate(intent.route ?? '/settings')
      else navigate('/studio')
    }
    window.addEventListener('mossstudio:window-intent', listener)
    return () => window.removeEventListener('mossstudio:window-intent', listener)
  }, [navigate])

  useEffect(
    () =>
      onEvent<Diagnostic>(Events.diagnostic, (diagnostic) => {
        if (diagnostic.toast) toast.push(diagnostic.title, diagnostic.severity === 'warning' ? 'info' : 'error')
      }),
    [toast],
  )

  return (
    <div className="app-shell flex h-full flex-col text-[var(--color-text)]">
      <TitlebarFrame>
        <div className="no-drag flex items-center gap-2">
          <IconButton label="回到创作" className="size-8" onClick={() => navigate('/studio')}>
            <LayoutGrid className="size-4" />
          </IconButton>
          <span className="text-ui font-semibold">MossStudio</span>
          <span className="rounded border border-white/10 px-1 py-px text-micro uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            {page.title}
          </span>
        </div>
        <div className="no-drag flex items-center gap-0.5">
          <Oobe />
          <IconButton label={terminalOpen ? '关闭终端' : '打开终端'} className="size-8" onClick={() => setTerminalOpen((open) => !open)}>
            <SquareTerminal className="size-4" />
          </IconButton>
          <IconButton
            label={notificationsOpen ? '隐藏通知' : '显示通知'}
            aria-expanded={notificationsOpen}
            aria-controls="notification-panel"
            className={cn('size-8', notificationsOpen && 'bg-white/[0.07]')}
            onClick={() => setNotificationsOpen(!notificationsOpen)}
          >
            <Bell className="size-4" />
          </IconButton>
        </div>
      </TitlebarFrame>

      <main className="content-surface min-h-0 min-w-0 flex-1 overflow-hidden" style={backgroundStyle}>
        <PageHost active={page.to} />
      </main>

      <nav className="glass-thin flex h-11 shrink-0 items-stretch border-t border-[var(--color-border-subtle)] px-1">
        {PAGES.map((item) => {
          const Icon = item.icon
          const active = location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                'relative flex min-w-[68px] flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-ui transition',
                active
                  ? 'border-accent-400 bg-white/[0.05] text-[var(--color-text)]'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:bg-white/[0.03] hover:text-[var(--color-text-secondary)]',
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </NavLink>
          )
        })}
      </nav>

      {terminalOpen ? (
        <div className="fixed inset-x-0 bottom-11 z-40 h-[42vh] border-t border-[var(--color-border-subtle)] bg-[#14171c] shadow-2xl">
          <div className="flex h-10 items-center justify-between border-b border-[var(--color-border-subtle)] px-3">
            <span className="text-caption font-medium">终端</span>
            <IconButton label="关闭终端" onClick={() => setTerminalOpen(false)}><X className="size-4" /></IconButton>
          </div>
          <div className="h-[calc(42vh-40px)]">
            <ErrorBoundary><TerminalPage /></ErrorBoundary>
          </div>
        </div>
      ) : null}
      <NotificationPanel />
      <UpdateDialog />
    </div>
  )
}

function TrainerShell(): React.JSX.Element {
  const backgroundStyle = useAppBackground()
  return (
    <div className="app-shell flex h-full flex-col text-[var(--color-text)]">
      <AppTitlebar kind="trainer" appName="Kohaku Trainer" appTag="external" />
      <MotionPanel transitionKey="trainer" className="min-h-0 flex-1 overflow-y-auto" style={backgroundStyle}>
        <TrainerWindow />
      </MotionPanel>
    </div>
  )
}

export function App(): React.JSX.Element {
  const init = useApp((state) => state.init)
  const kind = window.clover.windowKind
  useEffect(() => { void init() }, [init])
  return (
    <ToastProvider>
      <HashRouter>
        {kind === 'trainer' ? <TrainerShell /> : <StudioShell />}
      </HashRouter>
    </ToastProvider>
  )
}
