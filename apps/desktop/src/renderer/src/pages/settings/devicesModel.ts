import type {
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
): GpuRow[] {
  const preferred = defaultGpuUuid(inventory, selection)
  const automatic = !selection || selection === 'auto'
  return (inventory?.devices ?? []).map((device) => {
    const compatibility = probe?.devices.find((candidate) => candidate.uuid === device.uuid)
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
      statusLabel: status === 'ok' ? '正常' : status === 'error' ? '不能使用' : '待检测',
      reason: compatibility?.status === 'unsupported' ? compatibility.reason : undefined,
    }
  })
}

/** Plain explanation when no GPU is listed. */
export function gpuEmptyMessage(inventory: GpuInventorySnapshot | null): string {
  if (!inventory) return '正在检测显卡…'
  if (inventory.status === 'error') return `检测显卡失败：${inventory.error ?? '未知原因'}。可以重新检测，或更新 NVIDIA 显卡驱动后再试。`
  return '没有找到 NVIDIA 显卡。在本机生成图片需要一块 NVIDIA 显卡。'
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

/** Remote engine install options picked from what the host's CUDA check found. */
export function remoteInstallOptions(engine: RemoteEngineInfo | undefined): {
  channel: 'stable'
  flavour: 'cu12' | 'cu13'
  variant: 'system-cuda' | 'bundled'
  architecture: 'auto'
} {
  const flavour = engine?.cuda?.recommendedFlavour ?? 'cu13'
  const variant = engine?.cuda?.recommendedVariant ?? (engine?.cuda?.flavours.includes(flavour) ? 'system-cuda' : 'bundled')
  return { channel: 'stable', flavour, variant, architecture: 'auto' }
}
