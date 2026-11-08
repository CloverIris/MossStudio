import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type { GpuTelemetryDevice, GpuTelemetrySnapshot, JobRecord, Settings } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { cn } from '../cn'
import { Notice } from '../common/Notice'
import { Popover } from '../common/Popover'
import { Button, ProgressBar } from '../ui'
import { UpdateChip } from '../update/UpdateChip'
import { PreparationChip } from './PreparationChip'

const GIB = 1024 ** 3

function gib(value: number | undefined): string {
  return value === undefined ? '—' : (value / GIB).toFixed(1)
}

function ratio(used: number | undefined, total: number | undefined): number {
  if (!used || !total) return 0
  return Math.min(100, (used / total) * 100)
}

export function selectedGpu(telemetry: GpuTelemetrySnapshot | null, settings: Settings | null): GpuTelemetryDevice | undefined {
  if (!telemetry) return undefined
  const configured = settings && settings.gpuSelection !== 'auto' ? settings.gpuSelection.uuid : undefined
  const uuid = configured ?? telemetry.recommendedGpuUuid
  return telemetry.devices.find((device) => device.uuid === uuid) ?? telemetry.devices[0]
}

export function activeJobCount(jobs: JobRecord[]): number {
  return jobs.filter((job) => job.state === 'running' || job.state === 'starting' || job.state === 'queued').length
}

/** Live performance readout of the default GPU. Click for every GPU. */
export function PerfMonitor(): React.JSX.Element {
  const navigate = useNavigate()
  const telemetry = useApp((state) => state.gpuTelemetry)
  const settings = useApp((state) => state.settings)
  const jobs = useApp((state) => state.jobs)
  const gpu = selectedGpu(telemetry, settings)
  const tasks = activeJobCount(jobs)

  const utilization = gpu?.utilizationPercent
  // 负载 / 显存 / 任务: the same words in the chip and in the popover under it.
  const summary = gpu
    ? `显卡负载 ${utilization ?? '—'}%，显存 ${gib(gpu.memoryUsedBytes)} / ${gib(gpu.memoryTotalBytes)} GB，${tasks} 个任务`
    : telemetry?.status === 'unavailable'
      ? '未检测到显卡'
      : '正在读取显卡状态'

  return (
    <div className="no-drag">
      <Popover
        role="dialog"
        label="显卡状态"
        align="end"
        className="w-[360px] p-2"
        trigger={({ toggle, open, ...aria }) => (
          <button
            type="button"
            data-perf-monitor
            {...aria}
            aria-label={`性能：${summary}。点击查看每块显卡`}
            onClick={toggle}
            className={cn(
              // Hover and open lift to the popover's tone: ink-2 labels on well-strong over the light frame fall below 4.5:1.
              'tabular flex h-7 items-center gap-4 whitespace-nowrap rounded-md px-3 text-caption text-ink transition-colors hover:bg-raised max-[1180px]:gap-3',
              open ? 'bg-raised' : 'bg-well',
            )}
          >
            {gpu ? (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="text-ink-2">负载</span>
                  <ProgressBar value={utilization ?? 0} tone="neutral" className="w-9 max-[1180px]:hidden" />
                  <span className="w-8 text-right">{utilization ?? '—'}%</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-ink-2">显存</span>
                  <ProgressBar
                    value={ratio(gpu.memoryUsedBytes, gpu.memoryTotalBytes)}
                    tone="neutral"
                    className="w-9 max-[1180px]:hidden"
                  />
                  <span>
                    {gib(gpu.memoryUsedBytes)} / {gib(gpu.memoryTotalBytes)} GB
                  </span>
                </span>
              </>
            ) : (
              <span className="text-ink-2">{summary}</span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="text-ink-2">任务</span>
              <span>{tasks}</span>
            </span>
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="flex items-baseline justify-between px-2 pb-2 pt-1">
              <h2 className="text-section font-semibold">显卡</h2>
              <span className="text-caption text-ink-2">
                {telemetry ? `更新于 ${new Date(telemetry.sampledAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待检测'}
              </span>
            </div>
            {telemetry?.error ? (
              <Notice tone="warn" className="mb-2">
                {telemetry.error}
              </Notice>
            ) : null}
            <div className="flex flex-col gap-0.5">
              {(telemetry?.devices ?? []).map((device) => (
                <div key={device.uuid} className={cn('flex flex-col gap-2 rounded-lg px-2 py-2.5', device.uuid === gpu?.uuid && 'bg-well')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-control text-ink">{device.name}</span>
                    <span className="shrink-0 text-caption text-ink-2">{device.uuid === gpu?.uuid ? '默认' : `显卡 ${device.index}`}</span>
                  </div>
                  <div className="tabular grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-caption">
                    <span className="text-ink-2">负载</span>
                    <ProgressBar value={device.utilizationPercent ?? 0} tone="neutral" label={`${device.name} 负载`} />
                    <span className="text-right">{device.utilizationPercent ?? '—'}%</span>
                    <span className="text-ink-2">显存</span>
                    <ProgressBar
                      value={ratio(device.memoryUsedBytes, device.memoryTotalBytes)}
                      tone="neutral"
                      label={`${device.name} 显存`}
                    />
                    <span className="text-right">
                      {gib(device.memoryUsedBytes)} / {gib(device.memoryTotalBytes)} GB
                    </span>
                  </div>
                  <span className="text-caption text-ink-2">
                    {device.runningTasks} 个运行中 · {device.queuedTasks} 个排队
                  </span>
                </div>
              ))}
              {telemetry && telemetry.devices.length === 0 ? (
                <p className="px-2 py-3 text-caption text-ink-2">没有检测到可用的显卡。</p>
              ) : null}
            </div>
            <Button
              tone="ghost"
              block
              className="mt-1 justify-start px-2"
              onClick={() => {
                close()
                void navigate('/settings/devices')
              }}
            >
              设备与引擎设置
            </Button>
          </>
        )}
      </Popover>
    </div>
  )
}

type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

function controlWindow(action: WindowAction | 'state'): Promise<{ maximized: boolean } | null> {
  return call<{ maximized: boolean }>(Ipc.windowControl, { action }).catch(() => null)
}

/** Whether this window has no system frame and draws its own window buttons (Linux). */
export function drawsWindowControls(): boolean {
  return window.clover.platform === 'linux'
}

/**
 * Minimize, maximize / restore and close for a frameless window. Windows and
 * macOS keep the system's own buttons over the title bar.
 */
export function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let live = true
    void controlWindow('state').then((state) => {
      if (live && state) setMaximized(state.maximized)
    })
    const off = onEvent<{ maximized: boolean }>(Events.windowState, (state) => setMaximized(state.maximized))
    return () => {
      live = false
      off()
    }
  }, [])
  const button = 'inline-flex h-full w-11 items-center justify-center text-ink-2 transition-colors'
  return (
    <div data-window-controls className="no-drag flex h-full shrink-0 items-stretch">
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        className={cn(button, 'hover:bg-raised hover:text-ink')}
        onClick={() => void controlWindow('minimize')}
      >
        <Minus className="size-4" strokeWidth={1.6} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
        className={cn(button, 'hover:bg-raised hover:text-ink')}
        onClick={() => void controlWindow('toggle-maximize').then((state) => state && setMaximized(state.maximized))}
      >
        {maximized ? (
          <Copy className="size-3.5 -scale-x-100" strokeWidth={1.6} aria-hidden="true" />
        ) : (
          <Square className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        aria-label="关闭"
        title="关闭"
        className={cn(button, 'hover:bg-danger hover:text-on-danger')}
        onClick={() => void controlWindow('close')}
      >
        <X className="size-4" strokeWidth={1.6} aria-hidden="true" />
      </button>
    </div>
  )
}

export function TitlebarFrame({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  const frameless = drawsWindowControls()
  return (
    <header
      data-platform={window.clover.platform}
      className={cn('app-titlebar drag relative flex shrink-0 items-center gap-2 bg-frame', className)}
      // A frameless window has no system title bar to double-click: do what it would.
      onDoubleClick={
        frameless
          ? (event) => {
              if ((event.target as HTMLElement).closest('button, a, input, [role="button"], .no-drag')) return
              void controlWindow('toggle-maximize')
            }
          : undefined
      }
    >
      {children}
      {frameless ? <WindowControls /> : null}
    </header>
  )
}

export function Titlebar({ appName = 'MossStudio', monitor = true }: { appName?: string; monitor?: boolean }): React.JSX.Element {
  const setTitlebarSlot = useShell((state) => state.setTitlebarSlot)
  return (
    <TitlebarFrame>
      <span className="shrink-0 whitespace-nowrap text-ui font-semibold text-ink">{appName}</span>
      {/* Pages render their own context here, e.g. the Studio project switcher. */}
      <div ref={setTitlebarSlot} className="no-drag flex min-w-0 items-center gap-1" />
      <div className="min-w-0 flex-1" />
      <PreparationChip />
      <UpdateChip />
      {monitor ? <PerfMonitor /> : null}
    </TitlebarFrame>
  )
}

/** Render page context into the title bar, next to the app name. */
export function TitlebarPortal({ children }: { children: ReactNode }): React.JSX.Element | null {
  const slot = useShell((state) => state.titlebarSlot)
  if (!slot) return null
  return createPortal(
    <>
      <span aria-hidden="true" className="px-1 text-ui text-ink-3">
        /
      </span>
      {children}
    </>,
    slot,
  )
}
