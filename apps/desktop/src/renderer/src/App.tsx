import { useEffect, useState } from 'react'
import defaultHomeBackground from './assets/home-background.png'
import { Events, Ipc } from '@shared/channels'
import type { Diagnostic } from '@shared/types'
import { call, onEvent } from './lib/api'
import { useToast } from './components/ui'
import { HashRouter, useLocation, useNavigate } from 'react-router-dom'
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
import { AppTitlebar, GpuTitlebarStatus, TitlebarFrame } from './components/AppTitlebar'
import { APP_PAGES as PAGES, PageNavigation } from './components/PageNavigation'
import type { WindowIntent } from './lib/windows'
import { ArrowUpCircle, Bell, ExternalLink, SquareTerminal, X } from 'lucide-react'
import { Button, IconButton, cn } from './components/ui'

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
            <div className={studio ? 'h-full w-full' : 'mx-auto h-full w-full max-w-[1200px] overflow-y-auto px-6 py-5'}>
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
  const env = useApp((state) => state.env)
  const notificationsOpen = useApp((state) => state.notificationsOpen)
  const setNotificationsOpen = useApp((state) => state.setNotificationsOpen)
  const unread = useApp((state) => state.notifications.filter((item) => !item.read).length)
  const updates = useApp((state) => state.updates)
  const setUpdateDialogOpen = useApp((state) => state.setUpdateDialogOpen)
  const [terminalOpen, setTerminalOpen] = useState(false)
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
        <div className="min-w-0 flex-1" aria-hidden="true" />
        <GpuTitlebarStatus />
        <div className="no-drag ml-auto flex items-center gap-0.5">
          <Oobe />
          <IconButton label={terminalOpen ? '关闭终端' : '打开终端'} className="size-8" onClick={() => setTerminalOpen((open) => !open)}>
            <SquareTerminal className="size-4" />
          </IconButton>
          {/* Passive update indicator: shows up on its own when a later check finds a release. */}
          {updates?.updateAvailable && updates.latestVersion ? (
            <button
              type="button"
              data-update-chip
              title={`MossStudio ${updates.latestVersion} 可用，点击查看更新说明`}
              onClick={() => setUpdateDialogOpen(true)}
              className="mr-1 inline-flex items-center gap-1 rounded-full border border-accent-500/40 bg-accent-500/12 px-2 py-0.5 text-caption font-medium text-accent-200 transition hover:bg-accent-500/20"
            >
              <ArrowUpCircle className="size-3.5" />
              {updates.latestVersion}
            </button>
          ) : null}
          <IconButton
            label={notificationsOpen ? '隐藏通知' : '显示通知'}
            aria-expanded={notificationsOpen}
            aria-controls="notification-panel"
            className={cn('relative size-8', notificationsOpen && 'bg-white/[0.07]')}
            onClick={() => setNotificationsOpen(!notificationsOpen)}
          >
            <Bell className="size-4" />
            {unread > 0 ? (
              <span
                data-notification-badge
                className="absolute right-0.5 top-0.5 flex min-w-3 items-center justify-center rounded-[3px] bg-accent-500 px-0.5 text-micro font-semibold leading-[12px] text-[#10141c]"
              >
                {unread > 9 ? '9+' : unread}
              </span>
            ) : null}
          </IconButton>
        </div>
      </TitlebarFrame>

      <main className="content-surface min-h-0 min-w-0 flex-1 overflow-hidden" style={backgroundStyle}>
        <PageHost active={page.to} />
      </main>

      <footer className="app-workspace-nav glass-thin">
        <div className="app-workspace-meta no-drag">
          <span className="app-workspace-brand">MossStudio</span>
          <span className="app-workspace-version">v{env?.appVersion ?? '…'}</span>
          <span className="app-workspace-divider" aria-hidden="true" />
          <span className="app-workspace-free">本软件永久开源免费</span>
          <Button
            tone="ghost"
            className="app-workspace-github"
            aria-label="打开 MossStudio GitHub 开源仓库"
            title="打开 GitHub 开源仓库"
            onClick={() => {
              void call(Ipc.openExternal, { url: 'https://github.com/CloverIris/MossStudio' })
                .catch((error: unknown) => toast.push(error instanceof Error ? error.message : String(error), 'error'))
            }}
          >
            <ExternalLink className="size-3.5" />
            <span>GitHub</span>
          </Button>
        </div>
        <PageNavigation value={page.to} onChange={navigate} />
        <span className="app-workspace-qq">交流群：1044887698</span>
      </footer>

      {terminalOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-40 h-[42vh] border-t border-[var(--color-border-subtle)] bg-[#14171c] shadow-2xl" data-terminal-drawer>
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
