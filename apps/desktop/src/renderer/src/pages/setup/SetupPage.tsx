import { AlertCircle, Check, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Settings } from '@shared/types'
import { featureVisibility } from '../../lib/features'
import { useApp } from '../../store'
import { Button, ProgressBar, Spinner, cn, useToast } from '../../components/ui'
import { useAppInfo } from '../settings/useAppInfo'
import type { PlanLine } from '../../lib/engineInstall'
import { setupSpaceLabel, stepsToStart, type SetupStep } from './setupState'
import { useSetup } from './useSetup'

function StepMark({ step, index }: { step: SetupStep; index: number }): React.JSX.Element {
  const base = 'flex size-6 items-center justify-center rounded-full text-caption font-semibold'
  if (step.state === 'done')
    return (
      <span className={cn(base, 'bg-ok text-on-ink')}>
        <Check className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
      </span>
    )
  if (step.state === 'error' || (step.state === 'blocked' && step.id === 'gpu')) {
    return (
      <span className={cn(base, 'bg-danger text-on-danger')}>
        <AlertCircle className="size-3.5" aria-hidden="true" strokeWidth={1.6} />
      </span>
    )
  }
  if (step.state === 'running') return <span className={cn(base, 'bg-accent text-on-accent')}>{index + 1}</span>
  return <span className={cn(base, 'bg-well-strong text-ink-2')}>{index + 1}</span>
}

const STATE_LABEL: Record<SetupStep['state'], string> = {
  waiting: '等待开始',
  running: '进行中',
  done: '已完成',
  error: '出错了',
  blocked: '无法继续',
}

function StepRow({ step, index }: { step: SetupStep; index: number }): React.JSX.Element {
  const current = step.state === 'running'
  return (
    <li
      className={cn('grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-lg px-4 py-3.5', current && 'bg-surface')}
      aria-current={current ? 'step' : undefined}
    >
      <StepMark step={step} index={index} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-control text-ink">
          {step.title}
          <span className="sr-only">：{STATE_LABEL[step.state]}</span>
        </span>
        <span className={cn('tabular text-ui [overflow-wrap:anywhere]', step.state === 'error' ? 'text-danger' : 'text-ink-2')}>
          {step.detail}
        </span>
        {current ? <ProgressBar className="mt-2" value={step.percent ?? null} label={`${step.title}进度`} /> : null}
      </div>
      <span className="tabular text-ui text-ink-2">{current && step.percent !== undefined ? `${Math.round(step.percent)}%` : null}</span>
    </li>
  )
}

/** What was detected and what each GPU will run, one line per GPU; tips stay quiet. */
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
 * First run: one screen that prepares the computer — GPU check, engine, and
 * the recommended model — behind a single 开始准备 button.
 */
export function SetupPage(): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const settings = useApp((state) => state.settings)
  const saveSettings = useApp((state) => state.saveSettings)
  const info = useAppInfo()
  const { view, starting, start, redetect, redetecting, chooseModelFolder, usingFolder } = useSetup()
  const [leaving, setLeaving] = useState(false)
  const space = setupSpaceLabel(view)
  const { remoteHosts } = featureVisibility(settings)

  async function pickLocalFolder(): Promise<void> {
    try {
      const outcome = await chooseModelFolder()
      if (outcome) toast.push(outcome.message, outcome.ready ? 'success' : 'info')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function leave(state: Settings['onboardingState'], to: string): Promise<void> {
    setLeaving(true)
    try {
      await saveSettings({ onboardingState: state })
      void navigate(to, { replace: true })
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLeaving(false)
    }
  }

  const running = view.phase === 'running'
  const done = view.phase === 'done'
  const pending = stepsToStart(view)
  const mac = view.os === 'macos'
  const modelStep = view.steps.find((step) => step.id === 'model')

  return (
    <div className="flex h-full justify-center overflow-y-auto bg-panel px-6 pb-16 pt-[clamp(32px,12vh,120px)]">
      <div className="flex w-full max-w-[560px] flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-display font-semibold text-ink">{done ? '一切就绪' : '准备好你的电脑'}</h1>
          <p className="text-ui leading-[22px] text-ink-2">
            {done
              ? '显卡、推理引擎和推荐模型都已准备好，可以开始创作了。'
              : `MossStudio 会检测显卡、安装推理引擎并下载推荐模型。${space ? `需要${space} 空间，` : ''}耗时取决于网速。你可以离开这个页面，准备会在后台继续。`}
          </p>
        </div>

        <ol className="flex flex-col gap-1" aria-label="准备步骤">
          {view.steps.map((step, index) => (
            <StepRow key={step.id} step={step} index={index} />
          ))}
        </ol>

        {done ? null : <PlanLines lines={view.lines} />}

        {view.phase === 'blocked' ? (
          <div className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-4">
            <p className="text-ui text-ink">
              {mac
                ? '这台 Mac 不能在本机运行推理引擎。'
                : '在这台电脑上没有找到能运行引擎的显卡。如果显卡已经装好，请更新显卡驱动后重新检测。'}
            </p>
            <p className="text-ui text-ink-2">
              {remoteHosts
                ? '也可以添加一台装有 NVIDIA 显卡的远程主机，在它上面运行。'
                : '也可以使用一台装有 NVIDIA 显卡的远程主机：在 设置 › 功能 中开启「远程主机」。'}
            </p>
            {/* Blocked, these are the actions that work: 重新检测 is the main one (a Mac cannot redetect its way out). */}
            <div className="flex flex-wrap gap-2">
              {mac ? null : (
                <Button tone="primary" size="md" onClick={() => void redetect()} disabled={redetecting}>
                  {redetecting ? <Spinner /> : <RefreshCw className="size-4" strokeWidth={1.6} />}重新检测
                </Button>
              )}
              <Button
                tone={mac ? 'primary' : 'secondary'}
                size="md"
                onClick={() => void leave('active', remoteHosts ? '/settings/devices' : '/settings/features')}
                disabled={leaving}
              >
                {remoteHosts ? '添加远程主机' : '去开启远程主机'}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {modelStep && modelStep.state !== 'done' && modelStep.state !== 'running' && view.phase !== 'blocked' ? (
            // Quiet: most people download; someone with the files already can point at them.
            <Button tone="ghost" size="sm" disabled={usingFolder} onClick={() => void pickLocalFolder()}>
              {usingFolder ? <Spinner /> : null}已有模型文件？使用本地文件夹
            </Button>
          ) : info?.modelsPath && !done ? (
            <span className="min-w-0 truncate text-ui text-ink-2" title={info.modelsPath}>
              模型保存到 {info.modelsPath}
            </span>
          ) : null}
          <span className="flex-1" />
          {done ? (
            <Button tone="primary" size="lg" disabled={leaving} onClick={() => void leave('completed', '/studio')}>
              开始创作
            </Button>
          ) : running ? (
            <>
              <Button size="lg" tone="ghost" disabled={leaving} onClick={() => void leave('active', '/studio')}>
                在后台继续
              </Button>
              {pending.length > 0 ? (
                // E.g. after a restart mid-install: the engine is still downloading but the model never started.
                <Button tone="primary" size="lg" disabled={starting} onClick={() => void start()}>
                  {starting ? <Spinner /> : null}
                  {pending.includes('model') ? '同时下载模型' : '继续准备'}
                </Button>
              ) : (
                <Button tone="primary" size="lg" disabled>
                  开始创作
                </Button>
              )}
            </>
          ) : (
            <>
              <Button tone="ghost" size="lg" disabled={leaving} onClick={() => void leave('dismissed', '/studio')}>
                跳过
              </Button>
              {/* Nothing to start while blocked: the way forward is in the box above. */}
              {view.phase === 'blocked' ? null : (
                <Button tone="primary" size="lg" disabled={starting || view.phase === 'checking'} onClick={() => void start()}>
                  {starting ? <Spinner /> : null}
                  {view.phase === 'error' ? '重试' : '开始准备'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
