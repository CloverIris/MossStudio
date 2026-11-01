import type { GpuInventoryDevice, GpuProfileOverride, Settings } from './types'

export type GpuMemoryMode = Settings['mossInferMemoryMode']

export interface ResolvedGpuProfile {
  memoryMode: GpuMemoryMode
  tier: Settings['mossInferTier']
  source: 'recommended' | 'global' | 'gpu-override'
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
  const memoryMode = override?.memoryMode ?? (
    recommendedMode ?? settings.mossInferMemoryMode
  )
  return {
    memoryMode,
    tier: override?.tier ?? settings.mossInferTier,
    source: override?.memoryMode !== undefined || override?.tier !== undefined
      ? 'gpu-override'
      : recommendedMode ? 'recommended' : 'global',
  }
}

export function settingsForGpuProfile(settings: Settings, profile: ResolvedGpuProfile): Settings {
  return {
    ...settings,
    mossInferMemoryMode: profile.memoryMode,
    mossInferTier: profile.tier,
  }
}
