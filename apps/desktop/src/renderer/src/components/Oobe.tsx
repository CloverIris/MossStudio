import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Boxes, Check, ChevronDown, ChevronRight, Download, ListChecks, Maximize2, RefreshCw, X } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type { EngineRemoteProgress, ManagedHost, MossInferDownloadState, OnboardingStatus, OnboardingStep, Settings } from '@shared/types'
import { call, onEvent } from '../lib/api'
import { bytes } from '../lib/format'
import { useApp } from '../store'
import { useUiAnimationEnabled } from './motion'
import { OobeSpotlight } from './OobeSpotlight'
import { Button, IconButton, ProgressBar, Spinner, cn, useToast } from './ui'

type Screen = 'welcome' | 'overview' | 'checklist' | null

export function Oobe(): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const catalog = useApp((state) => state.catalog)
  const downloads = useApp((state) => state.downloads)
  const animate = useUiAnimationEnabled()
  const [screen, setScreen] = useState<Screen>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [spotlightDismissed, setSpotlightDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [hosts, setHosts] = useState<ManagedHost[]>([])
  const [engineDownload, setEngineDownload] = useState<MossInferDownloadState | null>(null)
  const [remoteProgress, setRemoteProgress] = useState<EngineRemoteProgress | null>(null)
  const [revision, setRevision] = useState(0)
  const initialized = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const previousRect = useRef<DOMRect | null>(null)
  const hostId = settings?.onboardingHostId ?? 'local'
  const visible = screen === 'overview' || screen === 'checklist'
  const docked = screen === 'checklist'
  const current = status?.hostId === hostId ? status : null
  const completed = current?.steps.filter((step) => step.status === 'ok').length ?? 0
  const total = current?.steps.length ?? 3
  const refresh = (): void => setRevision((value) => value + 1)

  useEffect(() => {
    if (!settings || initialized.current) return
    initialized.current = true
    if ((settings.onboardingState ?? 'pending') === 'pending') setScreen('welcome')
    else if (settings.onboardingState === 'active') setScreen('checklist')
  }, [settings])

  useEffect(() => {
    if (!visible) return
    let canceled = false
    const loadHosts = (): void => {
      void call<ManagedHost[]>(Ipc.hostsList).then((list) => {
        if (!canceled) setHosts(list.filter((host) => host.kind === 'ssh'))
      }).catch(() => undefined)
    }
    loadHosts()
    const off = onEvent(Events.hostsChanged, () => { loadHosts(); refresh() })
    return () => { canceled = true; off() }
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let canceled = false
    setChecking(true)
    const timer = window.setTimeout(() => {
      void call<OnboardingStatus>(Ipc.onboardingStatus, { hostId }).then((next) => {
        if (!canceled) { setStatus(next); setError(null) }
      }).catch((reason: unknown) => {
        if (!canceled) setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => { if (!canceled) setChecking(false) })
    }, 120)
    return () => { canceled = true; window.clearTimeout(timer) }
  }, [visible, hostId, location.pathname, catalog, settings?.modelsRoot, settings?.mossInferServerPath, revision])

  useEffect(() => {
    if (!visible) return
    window.addEventListener('focus', refresh)
    const offLocal = onEvent<MossInferDownloadState>(Events.mossInferDownload, (next) => {
      setEngineDownload(next)
      if (next.phase === 'done' || next.phase === 'error') refresh()
    })
    const offRemote = onEvent<EngineRemoteProgress>(Events.engineRemoteProgress, (next) => {
      if (next.hostId !== hostId) return
      setRemoteProgress(next)
      if (next.phase === 'done' || next.phase === 'error') refresh()
    })
    if (hostId === 'local') void call<MossInferDownloadState | null>(Ipc.mossInferDownloadState).then(setEngineDownload).catch(() => undefined)
    return () => { window.removeEventListener('focus', refresh); offLocal(); offRemote() }
  }, [visible, hostId])

  useLayoutEffect(() => {
    const element = dialog.current
    const content = panel.current
    if (!element || !content || !screen) return
    const modal = screen !== 'checklist'
    if (element.open && element.matches(':modal') !== modal) element.close()
    if (!element.open) {
      if (modal) element.showModal()
      else element.show()
    }
    const from = previousRect.current
    previousRect.current = null
    const to = content.getBoundingClientRect()
    if (!animate) return
    const duration = from ? 460 : 180
    const animation = content.animate([
      from ? { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 1 }
        : { transform: 'translateY(8px) scale(0.985)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' })
    // Release transforms even when a hidden Electron window pauses its timeline.
    const timer = window.setTimeout(() => animation.cancel(), duration + 80)
    void animation.finished.then(() => animation.cancel(), () => undefined)
    return () => { window.clearTimeout(timer); animation.cancel() }
  }, [screen, animate])

  useEffect(() => {
    if (!screen) trigger.current?.focus({ preventScroll: true })
  }, [screen])

  async function choose(state: Settings['onboardingState'], next: Screen): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    try {
      await saveSettings({ onboardingState: state })
      setScreen(next)
      setCollapsed(false)
      setSpotlightDismissed(false)
      return true
    } catch (reason) {
      toast.push(reason instanceof Error ? reason.message : String(reason), 'error')
      return false
    } finally { setBusy(false) }
  }

  async function changeHost(id: string): Promise<void> {
    setBusy(true)
    try { await saveSettings({ onboardingHostId: id }) }
    catch (reason) { toast.push(reason instanceof Error ? reason.message : String(reason), 'error') }
    finally { setBusy(false) }
  }

  function dock(step?: OnboardingStep): void {
    if (screen !== 'checklist') previousRect.current = panel.current?.getBoundingClientRect() ?? null
    setScreen('checklist')
    setCollapsed(false)
    if (!step) return
    setSpotlightDismissed(false)
    const query = new URLSearchParams({ hostId })
    if (step.action === 'models') {
      if (current?.bundleId) query.set('bundle', current.bundleId)
      query.set('component', 'all')
    }
    navigate(`/${step.action}?${query}`)
  }

  function close(): void {
    if (busy) return
    if (screen === 'welcome') void choose('dismissed', null)
    else if (screen === 'overview') dock()
    else { setCollapsed(true); trigger.current?.focus({ preventScroll: true }) }
  }

  const canFinish = Boolean(current?.ready && completed === total && !checking && !error)

  return (
    <>
      <button ref={trigger} type="button" aria-label="新手引导" title="新手引导" disabled={!settings || busy}
        className={cn('app-icon-button relative inline-flex size-8 items-center justify-center rounded-[4px] text-[var(--color-text-secondary)] hover:bg-white/[0.07]', docked && 'bg-white/[0.07] text-accent-300')}
        onClick={() => {
          if (docked) setCollapsed((value) => !value)
          else if (settings?.onboardingState === 'active') setScreen('overview')
          else void choose('active', 'overview')
        }}>
        <ListChecks className="size-4" />
        {settings?.onboardingState === 'active' ? <span className="absolute right-1 top-1 size-1 rounded-full bg-accent-400" /> : null}
      </button>
      <OobeSpotlight active={docked && !collapsed && !spotlightDismissed} hostId={hostId} route={location.pathname}
        step={current?.steps.find((step) => `/${step.action}` === location.pathname && step.status !== 'ok')}
        onActivate={() => setSpotlightDismissed(true)}
        onDismiss={() => { setSpotlightDismissed(true); trigger.current?.focus({ preventScroll: true }) }} />
      {screen ? createPortal(
        <dialog ref={dialog} className="app-oobe" data-screen={screen} data-collapsed={docked && collapsed} aria-modal={!docked} aria-labelledby="oobe-title"
          onCancel={(event) => { event.preventDefault(); close() }}
          onKeyDown={(event) => { if (docked && event.key === 'Escape') { event.preventDefault(); close() } }}>
          <div ref={panel} className="app-oobe-panel glass-strong flex max-h-full min-h-0 flex-col overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
            <header className={cn('relative flex shrink-0 justify-between gap-3 border-b border-[var(--color-border-subtle)]', docked ? 'items-center px-4 py-2.5' : 'items-start px-5 py-4')}>
              {docked ? <button type="button" data-oobe-toggle aria-label={collapsed ? '展开准备清单' : '收起准备清单'} aria-expanded={!collapsed} aria-controls="oobe-content" disabled={busy}
                className="absolute inset-0 rounded-t-[var(--radius-dialog)] outline-none transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.07]"
                onClick={() => setCollapsed((value) => !value)} /> : null}
              <div className={cn('min-w-0', docked && 'pointer-events-none relative')}>
                {docked ? <div className="flex items-center gap-2"><ListChecks className="size-4 shrink-0 text-accent-300" /><h2 id="oobe-title" className="text-ui font-semibold">{canFinish ? '准备就绪' : '准备清单'}</h2><span className="text-caption tabular-nums text-[var(--color-text-tertiary)]" aria-live="polite">{completed} / {total}</span></div> : <>
                  <div className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-[0.12em] text-accent-300"><ListChecks className="size-4" /> MossStudio · 初次见面</div>
                  <h2 id="oobe-title" className="mt-1 text-[18px] font-semibold tracking-tight">{screen === 'welcome' ? '需要带你完成首次配置吗？' : canFinish ? '准备就绪，开始创作吧' : '准备好你的第一次创作'}</h2>
                  {screen !== 'welcome' ? <p className="mt-1 text-caption text-[var(--color-text-tertiary)]" aria-live="polite">{completed} / {total} 项已就绪{checking ? ' · 检查中…' : ''}</p> : null}
                </>}
              </div>
              <div className={cn('flex shrink-0 items-center gap-0.5', docked && 'pointer-events-none relative')}>
                {docked ? <IconButton label="重新检查准备清单" className="pointer-events-auto size-6" disabled={checking} onClick={refresh}>{checking ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}</IconButton> : null}
                {docked ? <IconButton label="展开引导详情" className="pointer-events-auto size-6" onClick={() => { setScreen('overview'); setCollapsed(false) }}><Maximize2 className="size-4" /></IconButton> : null}
                <IconButton label={docked ? collapsed ? '展开准备清单' : '收起准备清单' : screen === 'welcome' ? '跳过引导' : '固定到右下角'} className="pointer-events-auto size-6" disabled={busy}
                  aria-expanded={docked ? !collapsed : undefined} aria-controls={docked ? 'oobe-content' : undefined}
                  onClick={() => docked ? setCollapsed((value) => !value) : close()}>
                  {docked ? <ChevronDown className={cn('size-3.5 transition-transform', collapsed && 'rotate-180')} /> : <X className="size-4" />}
                </IconButton>
              </div>
            </header>
            {screen === 'welcome' ? (
              <>
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
                  <p className="text-ui leading-6 text-[var(--color-text-secondary)]">从推理设备、MossInfer 引擎到模型权重，一步步准备好生成图片所需的内容。</p>
                  <div className="grid grid-cols-3 gap-2">
                    {[{ icon: Boxes, label: '配置引擎' }, { icon: Download, label: '准备模型' }, { icon: ListChecks, label: '跟随清单' }].map(({ icon: Icon, label }) =>
                      <div key={label} className="rounded-[6px] border border-[var(--color-border-subtle)] bg-white/[0.025] px-3 py-3"><Icon className="mb-2 size-4 text-accent-300" /><span className="text-ui text-[var(--color-text-secondary)]">{label}</span></div>,
                    )}
                  </div>
                  <p className="text-ui leading-5 text-[var(--color-text-tertiary)]">配置时清单会停靠在右下角，可向下收起。也可以稍后通过标题栏的清单按钮重新开启。</p>
                </div>
                <footer className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-border-subtle)] px-5 py-3">
                  <Button tone="ghost" disabled={busy} onClick={() => void choose('dismissed', null)}>暂时跳过</Button>
                  <Button tone="primary" disabled={busy} onClick={() => void choose('active', 'overview')}>开始引导<ArrowRight className="size-4" /></Button>
                </footer>
              </>
            ) : (
              <div id="oobe-content" className="flex min-h-0 flex-1 flex-col overflow-hidden" inert={docked && collapsed} aria-hidden={docked && collapsed}>
                <div className={cn('min-h-0 flex-1 overflow-y-auto', docked ? 'px-4' : 'px-5')}>
                  <div className={cn('space-y-2 border-b border-[var(--color-border-subtle)]', docked ? 'py-2' : 'py-3')}>
                    <label className="flex items-center gap-3 text-caption text-[var(--color-text-secondary)]">准备位置
                      <select aria-label="引导准备位置" className="app-input min-w-0 flex-1" value={hostId} disabled={busy} onChange={(event) => void changeHost(event.target.value)}>
                        <option value="local">本机{window.clover.platform === 'darwin' ? '（macOS 需使用远端推理）' : ''}</option>
                        {hosts.map((host) => <option key={host.id} value={host.id}>{host.name} · SSH</option>)}
                        {hostId !== 'local' && !hosts.some((host) => host.id === hostId) ? <option value={hostId}>已移除的 SSH 主机</option> : null}
                      </select>
                    </label>
                    <ProgressBar value={completed / total * 100} />
                    {!docked ? <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">{current?.bundleName ? `模型组合：${current.bundleName}。` : ''}已有内容会自动勾选，下载可在对应页面暂停或继续。</p> : null}
                  </div>
                  {error ? <p role="alert" className="py-3 text-ui text-red-300">检查失败：{error}。请重新检查或切换准备位置。</p> : null}
                  {!current ? !error ? <div className="flex items-center gap-2 py-6 text-ui text-[var(--color-text-secondary)]"><Spinner className="size-4" />正在检查所需项目…</div> : null : (
                    <ol className="divide-y divide-[var(--color-border-subtle)]">
                      {current.steps.map((step, index) => {
                        const done = step.status === 'ok'
                        const tasks = hostId === 'local' ? downloads.filter((item) => item.kind === 'model' && step.modelIds?.includes(item.targetId)) : []
                        const queued = tasks.some((task) => task.state === 'queued') && !tasks.some((task) => task.state === 'running' || task.state === 'verifying')
                        const taskBytes = tasks.reduce((sum, task) => sum + task.bytes, 0)
                        const taskTotal = tasks.reduce((sum, task) => sum + task.totalBytes, 0)
                        const engine = step.id === 'engine' && hostId === 'local' ? engineDownload : null
                        const remote = step.id === 'engine' && remoteProgress?.hostId === hostId ? remoteProgress : null
                        const running = !done && (tasks.some((task) => ['queued', 'running', 'verifying'].includes(task.state)) || engine && !['done', 'error'].includes(engine.phase) || remote && !['done', 'error'].includes(remote.phase))
                        const failed = !done && (tasks.some((task) => task.state === 'error') || engine?.phase === 'error' || remote?.phase === 'error')
                        const label = done ? '已就绪' : failed ? '下载失败，可重试' : running ? queued ? '排队中' : '准备中' : tasks.some((task) => task.state === 'paused') ? '已暂停' : step.status === 'partial' ? '待补齐' : '待准备'
                        return <li key={step.id} data-oobe-step={step.id} data-status={done ? 'ok' : failed ? 'error' : running ? 'running' : step.status} className="flex items-start gap-2.5 py-3">
                          <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-caption tabular-nums', done ? 'border-accent-500/25 bg-accent-500/10 text-accent-300' : 'border-[var(--color-border)] text-[var(--color-text-tertiary)]')}>
                            {done ? <Check className="size-4" /> : running ? <Spinner className="size-4" /> : index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span className="text-ui font-medium">{step.title}</span><span className={cn('text-caption', failed ? 'text-red-300' : done ? 'text-accent-300' : 'text-[var(--color-text-tertiary)]')}>{label}</span></div>
                            <p className="mt-1 break-words text-caption leading-4 text-[var(--color-text-tertiary)]">{step.detail}</p>
                            {!done && step.sizeBytes ? <p className="mt-1 text-caption tabular-nums text-[var(--color-text-tertiary)]">约 {bytes(step.sizeBytes)}{taskTotal ? ` · 下载进度 ${Math.round(taskBytes / taskTotal * 100)}%` : ''}</p> : null}
                          </div>
                          {!done ? <button type="button" aria-label={`前往配置${step.title}`} className="shrink-0 rounded-[4px] px-1.5 py-1 text-caption text-accent-300 hover:bg-white/[0.05]" onClick={() => dock(step)}>{docked ? '配置' : '前往配置'}<ChevronRight className="ml-0.5 inline size-3" /></button> : null}
                        </li>
                      })}
                    </ol>
                  )}
                </div>
                <footer className={cn('flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--color-border-subtle)]', docked ? 'justify-end px-4 py-2' : 'justify-between px-5 py-3')}>
                  {!docked ? <button type="button" className="text-caption text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] disabled:opacity-50" disabled={checking} onClick={refresh}>重新检查</button> : null}
                  <div className="flex items-center gap-1">
                    <Button tone="ghost" disabled={busy} onClick={() => void choose('dismissed', null)}>结束引导</Button>
                    <Button tone="primary" className="min-w-20 tabular-nums" aria-busy={checking} disabled={busy || !canFinish} onClick={() => {
                      void choose('completed', null).then((saved) => { if (saved) navigate('/studio') })
                    }}><span aria-live="polite">{canFinish ? '完成' : `${completed}/${total}`}</span></Button>
                  </div>
                </footer>
              </div>
            )}
          </div>
        </dialog>, document.body,
      ) : null}
    </>
  )
}
