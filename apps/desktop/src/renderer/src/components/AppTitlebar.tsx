import { Bell, BellOff, ChevronDown, Cpu, House, PanelLeftClose, PanelLeftOpen, SquareTerminal, Wand2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { t } from '../lib/i18n'
import { useApp } from '../store'
import { openWindow } from '../lib/windows'
import { cn, IconButton } from './ui'
import { resolveGpuProfile } from '@shared/gpuProfile'

interface AppTitlebarProps {
  kind: 'launcher' | 'creator' | 'terminal' | 'trainer' | 'devices'
  collapsed?: boolean
  onToggleSidebar?: () => void
  notificationsOpen?: boolean
  onToggleNotifications?: () => void
  unread?: number
  appName?: string
  appTag?: string
  right?: ReactNode
}

export function TitlebarFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <header
      data-platform={window.clover.platform}
      className="app-titlebar glass-thin drag relative flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)]"
    >
      {children}
    </header>
  )
}

export function GpuTitlebarStatus(): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const telemetry = useApp((state) => state.gpuTelemetry)
  const settings = useApp((state) => state.settings)
  const configuredUuid = settings?.gpuSelection !== 'auto' ? settings?.gpuSelection.uuid : undefined
  const selectedUuid = configuredUuid ?? telemetry?.recommendedGpuUuid
  const selectedGpu = telemetry?.devices.find((device) => device.uuid === selectedUuid)
  const activeTasks = telemetry?.devices.reduce((total, device) => total + device.runningTasks, 0) ?? 0
  const memory = (value: number | undefined): string => value === undefined
    ? '未知'
    : `${(value / 1024 ** 3).toFixed(1)} GB`
  const memoryModeLabel = (mode: string): string => mode === 'min_memory'
    ? '省显存'
    : mode === 'max_speed' ? '速度优先' : '均衡'
  const summary = telemetry?.status === 'error'
    ? '遥测暂不可用'
    : telemetry?.status === 'unavailable'
      ? '未检测到 NVIDIA GPU'
      : selectedGpu
        ? `${selectedGpu.name} · GPU ${selectedGpu.utilizationPercent ?? '—'}% · ${memory(selectedGpu.memoryUsedBytes)}/${memory(selectedGpu.memoryTotalBytes)} · ${activeTasks} 运行`
        : configuredUuid && telemetry
          ? '已保存的默认 GPU 未连接'
          : telemetry ? '未选择推理 GPU' : '正在检测 GPU…'
  const profileSourceLabel = (source: 'recommended' | 'global' | 'gpu-override'): string =>
    source === 'recommended' ? '推荐' : source === 'gpu-override' ? '自定义' : '全局'

  return (
    <div className="no-drag absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
      <button
        type="button"
        className="flex max-w-[min(56vw,680px)] items-center gap-2 rounded-md px-2 py-1 text-caption text-[var(--color-text-secondary)] transition-colors hover:bg-white/[0.06] hover:text-[var(--color-text)]"
        aria-expanded={expanded}
        aria-label={`MossStudio 推理设备状态：${summary}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="shrink-0 font-semibold text-[var(--color-text)]">MossStudio</span>
        <span className="text-[var(--color-text-tertiary)]">·</span>
        <span className="truncate">{summary}</span>
        <ChevronDown className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded ? (
        <div className="absolute left-1/2 top-[calc(100%+8px)] w-[min(420px,90vw)] -translate-x-1/2 rounded-lg border border-[var(--color-border-subtle)] bg-[#171a20] p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-ui font-semibold text-[var(--color-text)]">本机推理设备</span>
            <span className="text-caption text-[var(--color-text-tertiary)]">
              {telemetry ? `更新于 ${new Date(telemetry.sampledAt).toLocaleTimeString()}` : '等待设备检测'}
            </span>
          </div>
          {telemetry?.error ? <p role="status" className="mb-2 text-caption text-amber-200">{telemetry.error}</p> : null}
          <div className="space-y-2">
            {(telemetry?.devices ?? []).map((device) => {
              const deviceProfile = settings ? resolveGpuProfile(settings, device) : undefined
              return (
                <div key={device.uuid} className="rounded-md border border-[var(--color-border-subtle)] bg-white/[0.025] px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-ui font-medium text-[var(--color-text)]">
                      {device.name} · GPU {device.index}
                    </span>
                    <span className="shrink-0 text-caption text-[var(--color-text-tertiary)]">
                      {device.uuid === selectedUuid ? '默认设备' : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-caption text-[var(--color-text-secondary)]">
                    SM{device.computeCapability ? `${device.computeCapability.major}${device.computeCapability.minor}` : '未知'}
                    {' · '}GPU {device.utilizationPercent === undefined ? '—' : `${device.utilizationPercent}%`}
                    {' · '}显存 {memory(device.memoryUsedBytes)}/{memory(device.memoryTotalBytes)}
                  </p>
                  <p className="mt-1 text-caption text-[var(--color-text-tertiary)]">
                    {device.runningTasks} 运行 · {device.queuedTasks} 排队
                    {deviceProfile ? ` · ${memoryModeLabel(deviceProfile.memoryMode)}（${profileSourceLabel(deviceProfile.source)}）· ${deviceProfile.tier}` : ''}
                  </p>
                </div>
              )
            })}
            {telemetry && telemetry.devices.length === 0 && !telemetry.error ? (
              <p className="text-caption text-[var(--color-text-tertiary)]">当前没有可用的本机 NVIDIA 推理设备。</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function AppTitlebar({
  kind,
  collapsed,
  onToggleSidebar,
  notificationsOpen,
  onToggleNotifications,
  unread = 0,
  appName = t('app.name'),
  appTag,
  right,
}: AppTitlebarProps): React.JSX.Element {
  const env = useApp((state) => state.env)
  const channel = window.clover.channel
  const version = env?.appVersion ?? '0.1.0'

  return (
    <TitlebarFrame>
      <div className="no-drag flex items-center gap-1">
        {kind === 'launcher' ? (
          <IconButton
            label={collapsed ? '展开侧栏' : '收起侧栏'}
            className="size-8"
            onClick={onToggleSidebar}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </IconButton>
        ) : (
          <IconButton label="回到工作台" className="size-8" onClick={() => openWindow('launcher')}>
            <House className="size-4" />
          </IconButton>
        )}
      </div>

      <div className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-baseline gap-1.5">
        <span className="text-ui font-semibold tracking-[-0.01em] text-[var(--color-text)]">{appName}</span>
        <span
          className={cn(
            'rounded-[2px] border px-1 py-px text-micro font-semibold uppercase leading-[11px] tracking-[0.08em]',
            channel === 'release'
              ? 'border-white/10 text-[var(--color-text-tertiary)]'
              : 'border-accent-500/30 text-accent-300',
          )}
        >
          {appTag ?? channel}
        </span>
        <span className="text-caption tabular-nums text-[var(--color-text-tertiary)]">{version}</span>
      </div>

      <div className="no-drag flex items-center gap-0.5">
        {kind === 'launcher' ? (
          <>
            <IconButton label="打开设备管理器" className="size-8" onClick={() => openWindow('devices')}>
              <Cpu className="size-4" />
            </IconButton>
            <IconButton label="打开 MossStudio" className="size-8" onClick={() => openWindow('creator')}>
              <Wand2 className="size-4" />
            </IconButton>
            <IconButton label="打开终端" className="size-8" onClick={() => openWindow('terminal')}>
              <SquareTerminal className="size-4" />
            </IconButton>
            <IconButton
              label={notificationsOpen ? '隐藏通知' : '显示通知'}
              aria-expanded={notificationsOpen}
              aria-controls="notification-panel"
              className={cn('relative size-8', notificationsOpen && 'bg-white/[0.07] text-[var(--color-text)]')}
              onClick={onToggleNotifications}
            >
              {notificationsOpen ? <Bell className="size-4" /> : <BellOff className="size-4" />}
              {unread > 0 ? (
                <span className="absolute right-1 top-1 flex min-w-3 items-center justify-center rounded-[3px] bg-accent-500 px-0.5 text-micro font-semibold leading-[12px] text-[#10141c]">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </IconButton>
          </>
        ) : kind === 'creator' ? (
          <IconButton label="打开终端" className="size-8" onClick={() => openWindow('terminal')}>
            <SquareTerminal className="size-4" />
          </IconButton>
        ) : null}
        {right}
      </div>
    </TitlebarFrame>
  )
}
