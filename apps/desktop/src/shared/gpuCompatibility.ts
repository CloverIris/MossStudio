import type {
  EngineGpuCompatibility,
  EngineGpuProbeSnapshot,
  GpuInventoryDevice,
} from './types'

export interface EngineGpuProbeDevice {
  index?: number
  name?: string
  supported?: boolean
  unsupportedReason?: string
  freeMemoryBytes?: number
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function matchProbeDevice(
  device: GpuInventoryDevice,
  inventory: GpuInventoryDevice[],
  candidates: EngineGpuProbeDevice[],
): EngineGpuProbeDevice | undefined {
  const byIndex = candidates.filter((candidate) =>
    candidate.index === device.index &&
    (candidate.name === undefined || normalizedName(candidate.name) === normalizedName(device.name)),
  )
  if (byIndex.length === 1) return byIndex[0]
  const inventoryNameMatches = inventory.filter(
    (candidate) => normalizedName(candidate.name) === normalizedName(device.name),
  )
  const byUniqueName = candidates.filter((candidate) =>
    candidate.name !== undefined && normalizedName(candidate.name) === normalizedName(device.name),
  )
  return inventoryNameMatches.length === 1 && byUniqueName.length === 1
    ? byUniqueName[0]
    : undefined
}

export function mapEngineGpuProbe(
  inventory: GpuInventoryDevice[],
  candidates: EngineGpuProbeDevice[],
  enginePath: string,
  engineVersion?: string,
  checkedAt = new Date().toISOString(),
): EngineGpuProbeSnapshot {
  const devices: EngineGpuCompatibility[] = inventory.map((device) => {
    const candidate = matchProbeDevice(device, inventory, candidates)
    if (!candidate) {
      return { ...device, status: 'unknown', reason: '引擎 probe 未返回可唯一匹配的 GPU 结果' }
    }
    return {
      ...device,
      status: candidate.supported === true
        ? 'supported'
        : candidate.supported === false
          ? 'unsupported'
          : 'unknown',
      reason: candidate.unsupportedReason,
      freeMemoryBytes: candidate.freeMemoryBytes,
    }
  })
  return { enginePath, engineVersion, checkedAt, devices }
}
