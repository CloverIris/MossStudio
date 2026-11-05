import { enginePackageId, enginePackageOptionLabel, enginePackageSummary, enginePackageTitle, isCliEngine, parseEnginePackageId } from '@shared/enginePackages'
import type {
  EnginePlanView,
  EngineReadiness,
  EngineGpuProbeSnapshot,
  GpuInventoryDevice,
  GpuInventorySnapshot,
  GpuSelection,
  GpuTelemetrySnapshot,
  ManagedHost,
  RemoteEngineInfo,
  CheckStatus,
  GpuProfileOverride,
} from '@shared/types'
import { bytes } from '../../lib/format'

export interface GpuRow {
  uuid: string
  name: string
  detail: string
  isDefault: boolean
  status: CheckStatus
  statusLabel: string
  /** Why the engine cannot use this GPU, in its own words. */
  reason?: string
  /** Which engine this GPU runs, e.g. "CUDA 13" or "兼容模式 · 只能文生图". */
  engine?: string
  /** A quiet suggestion for a faster engine (driver update, ROCm 7). */
  tip?: string
}

/** What 设置 › 设备 knows about one GPU's engine: the package in use (readiness) and the plan's verdict. */
export interface GpuEngineInfo {
  deviceUuid: string
  /** Installed package this GPU runs now; null = none. */
  packageId: string | null
  /** The plan's choice for this GPU (what an install would give it); null = nothing runs on it. */
  plannedId: string | null
  reason?: string
  tip?: string
  /** An integrated GPU left unused because a discrete one runs an engine. */
  skipped?: boolean
}

export function gpuEngineInfo(readiness: EngineReadiness | null, plan: EnginePlanView | null): GpuEngineInfo[] {
  const ids = new Set([...(readiness?.devices ?? []).map((device) => device.deviceUuid), ...(plan?.choices ?? []).map((choice) => choice.gpuId)])
  return [...ids].map((deviceUuid) => {
    const used = readiness?.devices?.find((device) => device.deviceUuid === deviceUuid)
    const choice = plan?.choices.find((item) => item.gpuId === deviceUuid)
    return {
      deviceUuid,
      packageId: used?.packageId ?? null,
      plannedId: choice ? choice.packageId : used?.packageId ?? null,
      ...(choice && !choice.package ? { reason: choice.reason } : {}),
      ...(choice?.integratedSkipped ? { skipped: true } : {}),
      ...(choice?.tip ? { tip: choice.tip } : {}),
    }
  })
}

/** "CUDA 13", "兼容模式 · 只能文生图", "AMD 原生 · 只能文生图", "自定义引擎". */
export function engineInUseLabel(packageId: string | null): string | undefined {
  if (!packageId) return undefined
  if (packageId === 'custom') return '自定义引擎'
  const pkg = parseEnginePackageId(packageId)
  if (!pkg) return packageId
  return isCliEngine(pkg) ? `${enginePackageTitle(pkg)} · 只能文生图` : enginePackageTitle(pkg)
}

/**
 * The quiet line that replaces the memory mode / tier pickers of a GPU that
 * runs a CLI engine (Vulkan, HIP): those engines take neither setting. Null
 * for a GPU on moss-server (or with nothing installed), which keeps its pickers.
 */
export function fixedEngineSettingsNote(readiness: EngineReadiness | null, deviceUuid: string): string | null {
  const packageId = readiness?.devices?.find((device) => device.deviceUuid === deviceUuid)?.packageId
  const pkg = packageId ? parseEnginePackageId(packageId) : null
  if (!pkg || !isCliEngine(pkg)) return null
  return `${pkg.kind === 'hip' ? 'AMD 原生' : '兼容模式'}引擎使用固定设置`
}

/** Options for one GPU's engine picker in 高级: 自动 plus every package of the release that runs on it. */
export function engineOverrideOptions(plan: EnginePlanView | null, deviceUuid: string): Array<{ value: string; label: string; description?: string }> {
  const choice = plan?.choices.find((item) => item.gpuId === deviceUuid)
  const auto = { value: 'auto', label: '自动' }
  if (!choice) return [auto]
  return [auto, ...choice.compatible.map((pkg) => ({
    value: enginePackageId(pkg),
    label: enginePackageOptionLabel(pkg),
    ...(isCliEngine(pkg) ? { description: enginePackageSummary(pkg) } : {}),
  }))]
}

/** Set or clear one GPU's engine choice ('auto' clears it). */
export function applyEngineOverride(overrides: Record<string, string>, deviceUuid: string, value: string): Record<string, string> {
  const next = { ...overrides }
  if (value === 'auto') delete next[deviceUuid]
  else if (parseEnginePackageId(value)) next[deviceUuid] = value
  else return overrides
  return next
}

/** The GPU new work goes to: the saved one, or the one the app recommends. */
export function defaultGpuUuid(inventory: GpuInventorySnapshot | null, selection: GpuSelection | undefined): string | undefined {
  if (selection && typeof selection === 'object') return selection.uuid
  return inventory?.recommendedGpuUuid ?? inventory?.devices[0]?.uuid
}

export function gpuMemoryLabel(device: Pick<GpuInventoryDevice, 'memoryTotalBytes'>): string {
  return device.memoryTotalBytes ? bytes(device.memoryTotalBytes) : '显存未知'
}

/** Rows for the GPU group: name, memory, which one is the default, and whether the engine can use it. */
export function gpuRows(
  inventory: GpuInventorySnapshot | null,
  probe: EngineGpuProbeSnapshot | null,
  telemetry: GpuTelemetrySnapshot | null,
  selection: GpuSelection | undefined,
  engines: GpuEngineInfo[] = [],
): GpuRow[] {
  const preferred = defaultGpuUuid(inventory, selection)
  const automatic = !selection || selection === 'auto'
  return (inventory?.devices ?? []).map((device) => {
    const engine = engines.find((item) => item.deviceUuid === device.uuid)
    const cli = engine?.packageId ? isCliEngine(parseEnginePackageId(engine.packageId) ?? 'cuda') : false
    // The CUDA probe only speaks for GPUs that run moss-server; the plan speaks for the rest.
    const compatibility = cli
      ? { status: 'supported' as const, reason: undefined }
      : engine?.skipped && !engine.packageId
        ? { status: 'skipped' as const, reason: '已有独立显卡运行引擎，默认不使用这块集成显卡' }
        : engine && engine.plannedId === null && engine.reason
        ? { status: 'unsupported' as const, reason: engine.reason }
        : probe?.devices.find((candidate) => candidate.uuid === device.uuid)
    const live = telemetry?.devices.find((candidate) => candidate.uuid === device.uuid)
    const isDefault = device.uuid === preferred
    const parts = [gpuMemoryLabel(device)]
    if (isDefault) parts.push(automatic ? '默认（自动选择）' : '默认')
    if (live && (live.runningTasks > 0 || live.queuedTasks > 0)) parts.push(`${live.runningTasks} 个任务进行中`)
    const status: CheckStatus = compatibility?.status === 'supported'
      ? 'ok'
      : compatibility?.status === 'unsupported' ? 'error' : 'unknown'
    return {
      uuid: device.uuid,
      name: device.name,
      detail: parts.join(' · '),
      isDefault,
      status,
      statusLabel: status === 'ok' ? '正常' : status === 'error' ? '不能使用' : compatibility?.status === 'skipped' ? '未使用' : '待检测',
      reason: compatibility?.status === 'unsupported' || compatibility?.status === 'skipped' ? compatibility.reason : undefined,
      ...(engineInUseLabel(engine?.packageId ?? null) ? { engine: engineInUseLabel(engine!.packageId)! } : {}),
      ...(engine?.tip ? { tip: engine.tip } : {}),
    }
  })
}

/** Plain explanation when no GPU is listed. */
export function gpuEmptyMessage(inventory: GpuInventorySnapshot | null): string {
  if (!inventory) return '正在检测显卡…'
  if (inventory.status === 'error') return `检测显卡失败：${inventory.error ?? '未知原因'}。可以重新检测，或更新显卡驱动后再试。`
  return '没有找到能运行引擎的显卡。可以更新显卡驱动后重新检测。'
}

/** A saved default GPU that is no longer connected. */
export function savedGpuMissing(inventory: GpuInventorySnapshot | null, selection: GpuSelection | undefined): boolean {
  return Boolean(selection && typeof selection === 'object' && inventory && !inventory.devices.some((device) => device.uuid === selection.uuid))
}

export interface HostSummary {
  status: CheckStatus
  statusLabel: string
  detail: string
}

/** One line for a remote host row: where it is, what it has, and whether it answers. */
export function hostSummary(host: ManagedHost, engine: RemoteEngineInfo | undefined): HostSummary {
  const address = `${host.user ?? ''}@${host.host ?? ''}${host.port && host.port !== 22 ? `:${host.port}` : ''}`
  const gpu = host.devices[0]?.name ?? engine?.gpu?.split('\n')[0]
  const parts = [address]
  if (gpu) parts.push(gpu)
  if (engine?.online) parts.push(engine.available ? (engine.version ? `引擎 ${engine.version} 已安装` : '引擎已安装') : '引擎未安装')
  if (host.status === 'error') {
    return { status: 'error', statusLabel: '连接失败', detail: [address, host.error ?? '无法连接'].join(' · ') }
  }
  if (host.status === 'ok') return { status: 'ok', statusLabel: '在线', detail: parts.join(' · ') }
  return { status: 'unknown', statusLabel: '未测试', detail: parts.join(' · ') }
}

export type OverrideField = 'memoryMode' | 'tier'

/**
 * Set or clear one GPU's own memory mode or tier. 'global' clears it; a GPU
 * with nothing of its own left is dropped from the map.
 */
export function applyGpuOverride(
  overrides: Record<string, GpuProfileOverride>,
  uuid: string,
  field: OverrideField,
  value: string,
): Record<string, GpuProfileOverride> {
  const next: GpuProfileOverride = { ...overrides[uuid] }
  if (field === 'memoryMode') {
    if (value === 'global') delete next.memoryMode
    else if (value === 'min_memory' || value === 'balanced' || value === 'max_speed') next.memoryMode = value
    else return overrides
  } else {
    if (value === 'global') delete next.tier
    else if (value === 'reference' || value === 'high' || value === 'turbo') next.tier = value
    else return overrides
  }
  const result = { ...overrides }
  if (next.memoryMode === undefined && next.tier === undefined) delete result[uuid]
  else result[uuid] = next
  return result
}

/**
 * Remote engine install options: the main process probes the host and picks
 * the CUDA package with the same chooser as for this computer.
 */
export function remoteInstallOptions(): { channel: 'stable' } {
  return { channel: 'stable' }
}
