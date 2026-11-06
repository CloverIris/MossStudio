import type { GpuInventoryDevice, GpuProfileOverride, Settings } from './types'

export type GpuMemoryMode = Settings['mossInferMemoryMode']

export function gpuRequiresBf16Tier(device: GpuInventoryDevice): boolean {
  const capability = device.computeCapability
  return capability !== undefined && capability.major > 0 && capability.major < 8
}

export interface ResolvedGpuProfile {
  memoryMode: GpuMemoryMode
  tier: Settings['mossInferTier']
  source: 'recommended' | 'global' | 'gpu-override' | 'hardware-compatibility'
}

export function recommendGpuMemoryMode(device: GpuInventoryDevice): GpuMemoryMode | null {
  const memory = device.memoryTotalBytes
  if (memory === undefined || !Number.isFinite(memory) || memory <= 0) return null
  if (memory < 6 * 1024 ** 3) return 'min_memory'
  if (memory >= 24 * 1024 ** 3) return 'max_speed'
  return 'balanced'
}

export function resolveGpuProfile(
  settings: Pick<Settings, 'gpuProfileMode' | 'gpuProfileOverrides' | 'mossInferMemoryMode' | 'mossInferTier'>,
  device: GpuInventoryDevice,
): ResolvedGpuProfile {
  const override: GpuProfileOverride | undefined = settings.gpuProfileOverrides[device.uuid]
  const recommendedMode = settings.gpuProfileMode === 'auto' ? recommendGpuMemoryMode(device) : null
  const memoryMode = override?.memoryMode ?? recommendedMode ?? settings.mossInferMemoryMode
  const requestedTier = override?.tier ?? settings.mossInferTier
  const bf16Only = gpuRequiresBf16Tier(device)
  return {
    memoryMode,
    tier: bf16Only ? 'reference' : requestedTier,
    source:
      bf16Only && requestedTier !== 'reference'
        ? 'hardware-compatibility'
        : override?.memoryMode !== undefined || override?.tier !== undefined
          ? 'gpu-override'
          : recommendedMode
            ? 'recommended'
            : 'global',
  }
}

export function settingsForGpuProfile(settings: Settings, profile: ResolvedGpuProfile): Settings {
  return {
    ...settings,
    mossInferMemoryMode: profile.memoryMode,
    mossInferTier: profile.tier,
  }
}
