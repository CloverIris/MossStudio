import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { GpuTelemetryDevice, GpuTelemetrySnapshot, JobRecord, Settings } from '@shared/types'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { cn } from '../cn'
import { UpdateChip } from '../update/UpdateChip'

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

function Meter({ value }: { value: number }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="h-1 w-9 overflow-hidden rounded-full bg-well-strong">
      <span className="block h-full rounded-full bg-ink transition-[width] duration-500" style={{ width: `${value}%` }} />
    </span>
  )
}

/** Live performance readout of the default GPU. Click for every GPU. */
export function PerfMonitor(): React.JSX.Element {
  const navigate = useNavigate()
  const telemetry = useApp((state) => state.gpuTelemetry)
  const settings = useApp((state) => state.settings)
  const jobs = useApp((state) => state.jobs)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const gpu = selectedGpu(telemetry, settings)
  const tasks = activeJobCount(jobs)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const utilization = gpu?.utilizationPercent
  const summary = gpu
    ? `GPU ${utilization ?? '—'}%，显存 ${gib(gpu.memoryUsedBytes)} / ${gib(gpu.memoryTotalBytes)} GB，${tasks} 个任务`
    : telemetry?.status === 'unavailable' ? '未检测到 NVIDIA GPU' : '正在读取 GPU 状态'

  return (
    <div ref={root} className="no-drag relative">
      <button
        type="button"
        data-perf-monitor
        aria-expanded={open}
        aria-label={`性能：${summary}。点击查看每块 GPU`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          // Hover and open lift to the popover's tone: ink-2 labels on well-strong over the light frame fall below 4.5:1.
          'tabular flex h-7 items-center gap-4 rounded-md px-3 text-caption text-ink transition-colors hover:bg-raised',
          open ? 'bg-raised' : 'bg-well',
        )}
      >
        {gpu ? (
          <>
            <span className="flex items-center gap-1.5"><span className="text-ink-2">GPU</span><Meter value={utilization ?? 0} /><span className="w-8 text-right">{utilization ?? '—'}%</span></span>
            <span className="flex items-center gap-1.5"><span className="text-ink-2">显存</span><Meter value={ratio(gpu.memoryUsedBytes, gpu.memoryTotalBytes)} /><span>{gib(gpu.memoryUsedBytes)} / {gib(gpu.memoryTotalBytes)} GB</span></span>
          </>
        ) : (
          <span className="text-ink-2">{summary}</span>
        )}
        <span className="flex items-center gap-1.5"><span className="text-ink-2">任务</span><span>{tasks}</span></span>
      </button>

      {open ? (
        <div role="dialog" aria-label="GPU 状态" className="absolute right-0 top-[calc(100%+6px)] z-50 w-[360px] rounded-xl bg-raised p-2 shadow-float">
          <div className="flex items-baseline justify-between px-2 pb-2 pt-1">
            <span className="text-ui font-semibold">GPU</span>
            <span className="text-caption text-ink-2">{telemetry ? `更新于 ${new Date(telemetry.sampledAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '等待检测'}</span>
          </div>
          {telemetry?.error ? <p role="status" className="px-2 pb-2 text-caption text-warn">{telemetry.error}</p> : null}
          <div className="flex flex-col gap-0.5">
            {(telemetry?.devices ?? []).map((device) => (
              <div key={device.uuid} className={cn('flex flex-col gap-2 rounded-lg px-2.5 py-2.5', device.uuid === gpu?.uuid && 'bg-well')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-ui font-medium">{device.name}</span>
                  <span className="shrink-0 text-caption text-ink-2">{device.uuid === gpu?.uuid ? '默认' : `GPU ${device.index}`}</span>
                </div>
                <div className="tabular grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-caption">
                  <span className="text-ink-2">负载</span>
                  <span className="h-1 overflow-hidden rounded-full bg-well-strong"><span className="block h-full rounded-full bg-ink" style={{ width: `${device.utilizationPercent ?? 0}%` }} /></span>
                  <span className="text-right">{device.utilizationPercent ?? '—'}%</span>
                  <span className="text-ink-2">显存</span>
                  <span className="h-1 overflow-hidden rounded-full bg-well-strong"><span className="block h-full rounded-full bg-ink" style={{ width: `${ratio(device.memoryUsedBytes, device.memoryTotalBytes)}%` }} /></span>
                  <span className="text-right">{gib(device.memoryUsedBytes)} / {gib(device.memoryTotalBytes)} GB</span>
                </div>
                <span className="text-caption text-ink-2">{device.runningTasks} 个运行中 · {device.queuedTasks} 个排队</span>
              </div>
            ))}
            {telemetry && telemetry.devices.length === 0 ? (
              <p className="px-2 py-3 text-caption text-ink-2">没有可用的 NVIDIA GPU。生成需要一块 NVIDIA 显卡。</p>
            ) : null}
          </div>
          <button
            type="button"
            className="mt-1 flex h-9 w-full items-center rounded-lg px-2.5 text-ui text-ink transition-colors hover:bg-well"
            onClick={() => {
              setOpen(false)
              navigate('/settings/devices')
            }}
          >
            设备与引擎设置
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function TitlebarFrame({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <header
      data-platform={window.clover.platform}
      className={cn('app-titlebar drag relative flex shrink-0 items-center gap-2 bg-frame', className)}
    >
      {children}
    </header>
  )
}

export function Titlebar({ appName = 'MossStudio', monitor = true }: { appName?: string; monitor?: boolean }): React.JSX.Element {
  const setTitlebarSlot = useShell((state) => state.setTitlebarSlot)
  return (
    <TitlebarFrame>
      <span className="shrink-0 text-ui font-semibold text-ink">{appName}</span>
      {/* Pages render their own context here, e.g. the Studio project switcher. */}
      <div ref={setTitlebarSlot} className="no-drag flex min-w-0 items-center gap-1" />
      <div className="min-w-0 flex-1" />
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
      <span aria-hidden="true" className="px-1 text-ui text-ink-3">/</span>
      {children}
    </>,
    slot,
  )
}
