import { useEffect, useState } from 'react'
import { HashRouter, useLocation, useNavigate } from 'react-router-dom'
import { Events } from '@shared/channels'
import type { Diagnostic } from '@shared/types'
import { onEvent } from './lib/api'
import { useShell } from './lib/shell'
import type { WindowIntent } from './lib/windows'
import { useApp } from './store'
import { ErrorBoundary } from './components/ErrorBoundary'
import { MotionPanel } from './components/motion'
import { ToastProvider, cn, useToast } from './components/ui'
import { UpdateDialog } from './components/UpdateDialog'
import { ActivityPanel } from './components/shell/ActivityPanel'
import { Rail } from './components/shell/Rail'
import { LEGACY_REDIRECTS, routeRoot, visibleRoutes } from './components/shell/routes'
import { Titlebar } from './components/shell/Titlebar'
import { LibraryPage } from './pages/Library'
import { ModelsPage } from './pages/Models'
import { SettingsPage } from './pages/Settings'
import { SetupPage } from './pages/Setup'
import { StudioPage } from './pages/Studio'
import { TrainerWindow } from './pages/TrainerWindow'
import { TrainingPage } from './pages/Training'

const PAGE_COMPONENTS: Record<string, React.ComponentType> = {
  '/studio': StudioPage,
  '/library': LibraryPage,
  '/models': ModelsPage,
  '/training': TrainingPage,
  '/settings': SettingsPage,
}

/**
 * Pages stay mounted once visited (Studio is expensive to rebuild), but only the
 * current one is shown. Each page owns its own layout and background tone.
 */
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
        return (
          <div key={key} data-page={key} className={cn('h-full min-h-0', key !== active && 'hidden')}>
            <ErrorBoundary><Page /></ErrorBoundary>
          </div>
        )
      })}
    </>
  )
}

function useWindowIntents(): void {
  const navigate = useNavigate()
  const openActivity = useShell((state) => state.openActivity)
  useEffect(() => {
    const listener = (event: Event): void => {
      const intent = (event as CustomEvent<WindowIntent>).detail
      if (intent.target === 'terminal') openActivity('jobs')
      else if (intent.target === 'management') navigate(LEGACY_REDIRECTS[intent.route ?? ''] ?? intent.route ?? '/settings')
      else navigate('/studio')
    }
    window.addEventListener('mossstudio:window-intent', listener)
    return () => window.removeEventListener('mossstudio:window-intent', listener)
  }, [navigate, openActivity])
}

function useDiagnosticToasts(): void {
  const toast = useToast()
  useEffect(
    () =>
      onEvent<Diagnostic>(Events.diagnostic, (diagnostic) => {
        if (diagnostic.toast) toast.push(diagnostic.title, diagnostic.severity === 'warning' ? 'info' : 'error')
      }),
    [toast],
  )
}

function StudioShell(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const settings = useApp((state) => state.settings)
  const openActivity = useShell((state) => state.openActivity)
  useWindowIntents()
  useDiagnosticToasts()

  const pathname = location.pathname
  const root = routeRoot(pathname)

  // Old links keep working: send them to where that feature lives now.
  useEffect(() => {
    const target = LEGACY_REDIRECTS[root]
    if (!target) return
    if (root === '/diagnostics') openActivity('problems')
    navigate(target, { replace: true })
  }, [root, navigate, openActivity])

  // First run: nothing works until the computer is prepared, so start there.
  useEffect(() => {
    if (settings?.onboardingState === 'pending' && root !== '/setup') navigate('/setup', { replace: true })
  }, [settings?.onboardingState, root, navigate])

  if (root === '/setup') {
    return (
      <div className="flex h-full flex-col bg-frame text-ink">
        <Titlebar monitor={false} />
        <main className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary><SetupPage /></ErrorBoundary>
        </main>
        <UpdateDialog />
      </div>
    )
  }

  const routes = visibleRoutes(settings)
  const known = root === '/settings' || routes.some((route) => route.to === root)
  const active = known ? root : '/studio'

  return (
    <div className="flex h-full flex-col bg-frame text-ink">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <Rail current={active} onNavigate={navigate} />
        <main className="relative min-w-0 flex-1 overflow-hidden rounded-tl-xl">
          <PageHost active={active} />
          <ActivityPanel />
        </main>
      </div>
      <UpdateDialog />
    </div>
  )
}

function TrainerShell(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col bg-frame text-ink">
      <Titlebar appName="MossStudio 训练" />
      <MotionPanel transitionKey="trainer" className="min-h-0 flex-1 overflow-y-auto rounded-tl-xl bg-surface">
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
