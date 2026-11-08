import type { GpuInventoryDevice, GpuProfileOverride, JobGpuProfile, Settings } from './types'

export type GpuMemoryMode = Settings['mossInferMemoryMode']
export type EngineTier = Settings['mossInferTier']

/**
 * A GPU without MossInfer's 8-bit attention kernels (compute capability below
 * 8.0: Turing, Volta). There `high` runs exact attention, so on bf16 weights it
 * is the Reference configuration and the engine refuses it under that name.
 */
export function gpuLacks8BitAttention(device: Pick<GpuInventoryDevice, 'computeCapability'>): boolean {
  const capability = device.computeCapability
  return capability !== undefined && capability.major > 0 && capability.major < 8
}

/** What the engine's `inspect` calls a file's weights (`precision`). */
export type DitPrecision = 'bf16' | 'int8' | 'w4a4'
export type TextEncoderPrecision = 'bf16' | 'int8' | 'w4a8'

/** The loaded weights; a component left out is the bundle's own (bf16). null = not known. */
export interface WeightPrecisions {
  dit: DitPrecision | null
  textEncoder: TextEncoderPrecision | null
}

/**
 * The tier the engine runs for these weights. The weights decide whenever
 * they allow one tier only: INT4 runs only as Turbo, and a quantized DiT or
 * text encoder is refused by Reference. On bf16 weights the person's choice
 * stands, except where the GPU has no 8-bit attention (then only Reference
 * runs) or Turbo was asked for (it needs an INT4 DiT).
 */
export function tierForWeights(
  requested: EngineTier,
  weights: WeightPrecisions,
  device: Pick<GpuInventoryDevice, 'computeCapability'>,
): { tier: EngineTier; reason: 'weights' | 'gpu' | null } {
  const { dit, textEncoder } = weights
  if (dit === 'w4a4') return { tier: 'turbo', reason: requested === 'turbo' ? null : 'weights' }
  if (dit === 'int8' || textEncoder === 'int8' || textEncoder === 'w4a8') {
    return { tier: 'high', reason: requested === 'high' ? null : 'weights' }
  }
  // bf16, or not known (the engine could not be asked): without 8-bit attention only Reference runs bf16.
  if (gpuLacks8BitAttention(device)) return { tier: 'reference', reason: requested === 'reference' ? null : 'gpu' }
  // Not known: the choice stands, Turbo included, since the file may be INT4.
  if (dit === null || textEncoder === null) return { tier: requested, reason: null }
  if (requested === 'turbo') return { tier: 'high', reason: 'weights' }
  return { tier: requested, reason: null }
}

export type ResolvedGpuProfile = JobGpuProfile

export function recommendGpuMemoryMode(device: GpuInventoryDevice): GpuMemoryMode | null {
  const memory = device.memoryTotalBytes
  if (memory === undefined || !Number.isFinite(memory) || memory <= 0) return null
  if (memory < 6 * 1024 ** 3) return 'min_memory'
  if (memory >= 24 * 1024 ** 3) return 'max_speed'
  return 'balanced'
}

/** The memory mode and the tier asked for on this GPU; the job's weights settle the tier (withWeightTier). */
export function resolveGpuProfile(
  settings: Pick<Settings, 'gpuProfileMode' | 'gpuProfileOverrides' | 'mossInferMemoryMode' | 'mossInferTier'>,
  device: GpuInventoryDevice,
): ResolvedGpuProfile {
  const override: GpuProfileOverride | undefined = settings.gpuProfileOverrides[device.uuid]
  const recommendedMode = settings.gpuProfileMode === 'auto' ? recommendGpuMemoryMode(device) : null
  const memoryMode = override?.memoryMode ?? recommendedMode ?? settings.mossInferMemoryMode
  const tier = override?.tier ?? settings.mossInferTier
  return {
    memoryMode,
    tier,
    source:
      override?.memoryMode !== undefined || override?.tier !== undefined ? 'gpu-override' : recommendedMode ? 'recommended' : 'global',
  }
}

/** The profile with the tier these weights run on this GPU. */
export function withWeightTier(
  profile: ResolvedGpuProfile,
  weights: WeightPrecisions,
  device: Pick<GpuInventoryDevice, 'computeCapability'>,
): ResolvedGpuProfile {
  const { tier, reason } = tierForWeights(profile.tier, weights, device)
  if (!reason) return { ...profile, tier }
  return { ...profile, tier, source: reason === 'gpu' ? 'hardware-compatibility' : 'model-weights' }
}

export function settingsForGpuProfile(settings: Settings, profile: ResolvedGpuProfile): Settings {
  return {
    ...settings,
    mossInferMemoryMode: profile.memoryMode,
    mossInferTier: profile.tier,
  }
}
