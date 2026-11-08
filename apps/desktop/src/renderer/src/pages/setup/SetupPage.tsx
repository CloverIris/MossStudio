import { Check, ChevronRight, ExternalLink, Monitor, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { ManagedHost, Settings } from '@shared/types'
import { call } from '../../lib/api'
import { bytes } from '../../lib/format'
import { timeLeftLabel, type Preparation } from '../../lib/preparation'
import { useApp } from '../../store'
import { Button, ProgressBar, Spinner, cn, useToast } from '../../components/ui'
import { pickFolder } from '../settings/fields'
import { HostDialog } from '../settings/HostDialog'
import { emptyHostForm, hostPathsPatch, hostSavePayload, type HostForm } from '../settings/hostForm'
import type { PlanLine } from '../../lib/engineInstall'
import { setupNeedLine, setupSpaceLabel, stepsToStart, type SetupStep } from './setupState'
import { useSetup } from './useSetup'

/** The README section on which computers run MossStudio. */
const WHICH_COMPUTERS_URL = 'https://github.com/ShallowElec/MossStudio#哪些电脑能用'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What was detected and what each GPU will run, one line per GPU. Shown on request. */
function PlanLines({ lines }: { lines: PlanLine[] }): React.JSX.Element | null {
  if (lines.length === 0) return null
  return (
    <ul className="flex flex-col gap-1 rounded-xl bg-surface px-4 py-3" aria-label="检测到的显卡">
      {lines.map((line) => (
        <li key={line.gpuId} className="flex flex-col gap-0.5 py-1.5">
          <span className="flex flex-wrap items-baseline gap-x-2 text-ui">
            <span className="font-medium text-ink">{line.gpu}</span>
            <span className={cn('tabular', line.supported || line.skipped ? 'text-ink-2' : 'text-danger')}>{line.detail}</span>
          </span>
          {line.note ? <span className="text-caption text-ink-2">{line.note}</span> : null}
          {line.tip ? <span className="text-caption text-ink-2">{line.tip}</span> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * The GPU in one quiet line; what each GPU runs opens under it when there is
 * more to say. When it will run slowly, the tick turns amber and one line says why.
 */
function GpuLine({ step, lines, slow }: { step: SetupStep | undefined; lines: PlanLine[]; slow?: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!step || step.state !== 'done') return null
  const more = lines.length > 1 || lines.some((line) => line.note || line.tip || !line.supported)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2 text-ui text-ink-2">
          {slow ? (
            <span
              className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-warn text-[12px] font-bold leading-none text-on-ink"
              aria-hidden="true"
            >
              !
            </span>
          ) : (
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ok text-on-ink">
              <Check className="size-3" strokeWidth={2.6} aria-hidden="true" />
            </span>
          )}
          <span className="tabular min-w-0 truncate" data-setup-gpu>
            {step.detail}
          </span>
          {lines.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className={cn('shrink-0 rounded-md px-1.5 text-ui hover:bg-well hover:text-ink', more ? 'text-ink' : 'text-ink-2')}
            >
              {open ? '收起' : '详情'}
            </button>
          ) : null}
        </div>
        {slow ? (
          <p className="pl-[26px] text-ui text-warn" data-setup-slow>
            {slow}
          </p>
        ) : null}
      </div>
      {open ? <PlanLines lines={lines} /> : null}
    </div>
  )
}

/** Everything being downloaded as one number, the parts small underneath. */
function Progress({ progress, modelName }: { progress: Preparation; modelName: string }): React.JSX.Element {
  const left = timeLeftLabel(progress.secondsLeft)
  const percent = Math.round(progress.percent)
  return (
    <div className="flex flex-col gap-3" data-setup-progress>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="tabular text-display font-semibold text-ink">{percent}%</span>
        <span className="tabular text-ui text-ink-2">
          {bytes(progress.done)} / {bytes(progress.total)}
          {left ? ` · 还要${left}` : ''}
        </span>
      </div>
      <ProgressBar value={progress.percent} label="准备进度" />
      <ul className="flex flex-col gap-1 text-ui text-ink-2" aria-label="正在下载">
        {progress.parts.map((part) => (
          <li key={part.id} className="flex items-center gap-2">
            <span className={cn('w-4 shrink-0', part.finished ? 'text-ok' : part.failed ? 'text-danger' : 'text-ink-2')} aria-hidden="true">
              {part.finished ? '✓' : part.failed ? '!' : '↓'}
            </span>
            <span className="min-w-0 flex-1 truncate">{part.id === 'engine' ? '运行组件' : modelName}</span>
            <span className="tabular">
              {part.finished
                ? bytes(part.total)
                : `${bytes(part.done)} / ${bytes(part.total)}${part.speedBps > 0 ? ` · ${bytes(part.speedBps)}/s` : ''}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A way forward when nothing can run here, as one large choice. */
function Choice({
  icon,
  title,
  detail,
  busy,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  detail: string
  busy?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-3.5 rounded-xl bg-surface px-4 py-3.5 text-left transition-colors enabled:hover:bg-well disabled:opacity-60"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-well-strong text-ink">
        {busy ? <Spinner /> : icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-control font-medium text-ink">{title}</span>
        <span className="text-ui text-ink-2">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-3" strokeWidth={1.6} aria-hidden="true" />
    </button>
  )
}

/**
 * First run, one screen at a time: what will be downloaded and where (one
 * button), then one progress with the time left (and 先去看看 into the
 * board), or, when this computer cannot run the model, the ways forward.
 * Once everything is in place it goes straight to the board.
 */
export function SetupPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const { view, progress, modelName, starting, start, redetect, redetecting, chooseModelFolder, usingFolder, info } = useSetup()
  const [leaving, setLeaving] = useState(false)
  const [hostForm, setHostForm] = useState<HostForm | null>(null)
  const space = setupSpaceLabel(view)

  async function leave(state: Settings['onboardingState'], to: string): Promise<void> {
    setLeaving(true)
    try {
      await saveSettings({ onboardingState: state })
      void navigate(to, { replace: true })
    } catch (error) {
      toast.push(errorText(error), 'error')
    } finally {
      setLeaving(false)
    }
  }

  const running = view.phase === 'running'
  const pending = stepsToStart(view)
  const mac = view.os === 'macos'
  const need = setupNeedLine(view)
  const gpuStep = view.steps.find((step) => step.id === 'gpu')
  const modelStep = view.steps.find((step) => step.id === 'model')
  const failedStep = view.steps.find((step) => step.state === 'error')

  // Everything in place: straight to the board. Say so only if it was downloading here.
  const sawRunning = useRef(false)
  if (running) sawRunning.current = true
  const finishing = useRef(false)
  useEffect(() => {
    if (view.phase !== 'done' || finishing.current) return
    finishing.current = true
    void saveSettings({ onboardingState: 'completed' })
      .then(() => {
        if (sawRunning.current) toast.push('模型准备好了，可以生成了', 'success')
        void navigate('/studio', { replace: true })
      })
      .catch((error: unknown) => {
        finishing.current = false
        toast.push(errorText(error), 'error')
      })
  }, [view.phase, saveSettings, navigate, toast])

  // Picked up after a restart (the engine still installing, the model never started): carry on.
  const resumed = useRef(false)
  useEffect(() => {
    if (!running || pending.length === 0 || starting || resumed.current) return
    resumed.current = true
    void start()
  }, [running, pending.length, starting, start])

  async function pickLocalFolder(): Promise<void> {
    try {
      const outcome = await chooseModelFolder()
      if (outcome) toast.push(outcome.message, outcome.ready ? 'success' : 'info')
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  async function changeFolder(): Promise<void> {
    try {
      const path = await pickFolder('选择模型保存位置')
      if (path) await saveSettings({ modelsRoot: path })
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  // 用另一台电脑: remote hosts come on and the new one is added right here.
  async function addAnotherComputer(): Promise<void> {
    try {
      if (!settings?.remoteHostsEnabled) await saveSettings({ remoteHostsEnabled: true })
      setHostForm(emptyHostForm())
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }
  async function saveHost(form: HostForm): Promise<boolean> {
    try {
      const saved = await call<ManagedHost>(Ipc.hostsSave, hostSavePayload(form))
      await call(Ipc.hostsUpdatePaths, hostPathsPatch(saved.id, form))
      setHostForm(null)
      toast.push(`已添加 ${saved.name}`, 'success')
      // 设备 prepares it: connection, engine, then the model.
      await leave('active', '/settings/devices')
      return true
    } catch (error) {
      toast.push(`没有保存：${errorText(error)}`, 'error')
      return false
    }
  }

  const modelsPath = settings?.modelsRoot || info?.modelsPath

  return (
    <div className="flex h-full justify-center overflow-y-auto bg-panel px-6 pb-16 pt-[clamp(32px,14vh,140px)]">
      <div className="flex w-full max-w-[520px] flex-col gap-7">
        {view.phase === 'blocked' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-display font-semibold text-ink">{mac ? '这台 Mac 不能在本机生成' : '这台电脑跑不了模型'}</h1>
              <p className="text-ui text-ink-2" data-setup-reason>
                {mac ? '需要一台装有 NVIDIA 显卡的电脑。' : gpuStep?.detail}
              </p>
              {need ? (
                <p className="text-ui text-ink-3" data-setup-need>
                  {need}
                  {/* An inline link inside the sentence (ui-rules §3). */}
                  <button
                    type="button"
                    onClick={() => void call(Ipc.openExternal, { url: WHICH_COMPUTERS_URL })}
                    className="inline-flex items-center gap-0.5 rounded-sm align-baseline text-ink-2 underline underline-offset-2 hover:text-ink"
                  >
                    哪些电脑能用
                    <ExternalLink className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
                  </button>
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2.5">
              <Choice
                icon={<Monitor className="size-[18px]" strokeWidth={1.6} />}
                title="用另一台电脑"
                detail="连上一台有 NVIDIA 显卡的电脑，在它上面生成"
                onClick={() => void addAnotherComputer()}
              />
              {mac ? null : (
                <Choice
                  icon={<RefreshCw className="size-[18px]" strokeWidth={1.6} />}
                  title="重新检测"
                  detail="刚装好显卡或更新了驱动"
                  busy={redetecting}
                  onClick={() => void redetect()}
                />
              )}
            </div>
            <div className="flex justify-end">
              <Button tone="ghost" size="lg" disabled={leaving} onClick={() => void leave('dismissed', '/studio')}>
                先随便看看
              </Button>
            </div>
          </>
        ) : running && progress ? (
          <>
            <h1 className="text-display font-semibold text-ink">正在准备</h1>
            <Progress progress={progress} modelName={modelName} />
            <div className="flex items-center gap-3">
              {modelsPath ? (
                <span className="min-w-0 flex-1 truncate text-ui text-ink-2" title={modelsPath}>
                  保存到 {modelsPath}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <Button tone="primary" size="lg" disabled={leaving} onClick={() => void leave('active', '/studio')}>
                先去看看
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-display font-semibold text-ink">准备开始创作</h1>
              <p className="text-ui text-ink-2">先下载一次模型，之后都在本机运行。</p>
            </div>
            {view.phase === 'checking' ? (
              <p className="flex items-center gap-2 text-ui text-ink-2">
                <Spinner />
                正在检查这台电脑…
              </p>
            ) : (
              <GpuLine step={gpuStep} lines={view.lines} {...(view.slow ? { slow: view.slow } : {})} />
            )}
            <div className="flex flex-col gap-3 rounded-xl bg-surface px-5 py-4" data-setup-summary>
              <span className="tabular text-title font-semibold text-ink">{space ? `下载${space}` : '正在计算大小…'}</span>
              {view.diskShort ? (
                // Plain danger text in the card's own rhythm, not a Notice box (ui-rules §4).
                <p className="text-ui text-danger" role="status" data-setup-disk>
                  {view.diskShort}
                </p>
              ) : null}
              <div className="flex items-center gap-3 text-ui text-ink-2">
                <span className="min-w-0 flex-1 truncate" title={modelsPath}>
                  保存到 {modelsPath ?? '…'}
                </span>
                <Button size="sm" onClick={() => void changeFolder()} disabled={starting}>
                  更改
                </Button>
              </div>
              {failedStep ? (
                <p className="text-ui text-danger [overflow-wrap:anywhere]" role="alert">
                  没有下载完：{failedStep.detail}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {modelStep && modelStep.state !== 'done' ? (
                // Quiet: most people download; someone with the files already can point at them.
                <Button tone="ghost" size="sm" disabled={usingFolder} onClick={() => void pickLocalFolder()}>
                  {usingFolder ? <Spinner /> : null}已有模型文件…
                </Button>
              ) : null}
              <span className="flex-1" />
              <Button tone="ghost" size="lg" disabled={leaving} onClick={() => void leave('dismissed', '/studio')}>
                稍后
              </Button>
              <Button
                tone="primary"
                size="lg"
                // Not enough room in the chosen folder: 更改 is the way on.
                disabled={starting || view.phase === 'checking' || Boolean(view.diskShort)}
                onClick={() => void start()}
              >
                {starting ? <Spinner /> : null}
                {view.phase === 'error' ? '重试' : '开始下载'}
              </Button>
            </div>
          </>
        )}
      </div>
      <HostDialog open={hostForm !== null} initial={hostForm ?? emptyHostForm()} onClose={() => setHostForm(null)} onSave={saveHost} />
    </div>
  )
}
