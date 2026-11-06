import { describe, expect, it } from 'vitest'
import { gpuRequiresBf16Tier, recommendGpuMemoryMode, resolveGpuProfile, settingsForGpuProfile } from '@shared/gpuProfile'
import type { GpuInventoryDevice, GpuProfileOverride, Settings } from '@shared/types'

const GiB = 1024 ** 3

const gpu = (uuid: string, memoryTotalBytes: number | undefined, major?: number, minor = 0): GpuInventoryDevice => ({
  uuid,
  index: 0,
  name: 'Test GPU',
  memoryTotalBytes,
  computeCapability: major === undefined ? undefined : { major, minor },
})

type ProfileSettings = Parameters<typeof resolveGpuProfile>[0]

const settings = (overrides: Record<string, GpuProfileOverride> = {}, mode: Settings['gpuProfileMode'] = 'auto'): ProfileSettings => ({
  gpuProfileMode: mode,
  gpuProfileOverrides: overrides,
  mossInferMemoryMode: 'balanced',
  mossInferTier: 'high',
})

/**
 * settingsForGpuProfile only spreads and overwrites two fields, so a handful of
 * unrelated fields is enough to prove the rest are carried over untouched.
 */
function fullSettings(): Settings {
  const partial: Partial<Settings> = {
    theme: 'dark',
    language: 'en',
    inferenceBackend: 'mossinfer',
    mossInferServerPath: 'server.exe',
    mossInferMemoryMode: 'balanced',
    mossInferTier: 'high',
    gpuSelection: { uuid: 'device' },
    gpuProfileMode: 'auto',
    gpuProfileOverrides: {},
    deviceLabels: { device: 'Main' },
  }
  return partial as Settings
}

describe('recommendGpuMemoryMode', () => {
  it('uses total VRAM thresholds', () => {
    expect(recommendGpuMemoryMode(gpu('under-six', 6 * GiB - 1))).toBe('min_memory')
    expect(recommendGpuMemoryMode(gpu('six', 6 * GiB))).toBe('balanced')
    expect(recommendGpuMemoryMode(gpu('eight', 8 * GiB))).toBe('balanced')
    expect(recommendGpuMemoryMode(gpu('medium', 16 * GiB))).toBe('balanced')
    expect(recommendGpuMemoryMode(gpu('under-24', 24 * GiB - 1))).toBe('balanced')
    expect(recommendGpuMemoryMode(gpu('large', 24 * GiB))).toBe('max_speed')
    expect(recommendGpuMemoryMode(gpu('huge', 80 * GiB))).toBe('max_speed')
    expect(recommendGpuMemoryMode(gpu('tiny', 1))).toBe('min_memory')
  })

  it('returns null for unknown or nonsensical VRAM', () => {
    expect(recommendGpuMemoryMode(gpu('unknown', undefined))).toBeNull()
    expect(recommendGpuMemoryMode(gpu('zero', 0))).toBeNull()
    expect(recommendGpuMemoryMode(gpu('negative', -GiB))).toBeNull()
    expect(recommendGpuMemoryMode(gpu('nan', Number.NaN))).toBeNull()
    expect(recommendGpuMemoryMode(gpu('inf', Number.POSITIVE_INFINITY))).toBeNull()
  })
})

describe('gpuRequiresBf16Tier', () => {
  it('flags pre-Ampere GPUs only', () => {
    expect(gpuRequiresBf16Tier(gpu('rtx20', 8 * GiB, 7, 5))).toBe(true)
    expect(gpuRequiresBf16Tier(gpu('v100', 16 * GiB, 7, 0))).toBe(true)
    expect(gpuRequiresBf16Tier(gpu('pascal', 8 * GiB, 6, 1))).toBe(true)
    expect(gpuRequiresBf16Tier(gpu('ampere', 12 * GiB, 8, 6))).toBe(false)
    expect(gpuRequiresBf16Tier(gpu('blackwell', 12 * GiB, 12, 0))).toBe(false)
  })

  it('does not restrict GPUs with an unknown capability', () => {
    expect(gpuRequiresBf16Tier(gpu('unknown', 8 * GiB))).toBe(false)
    expect(gpuRequiresBf16Tier(gpu('zero', 8 * GiB, 0, 0))).toBe(false)
  })
})

describe('resolveGpuProfile', () => {
  it('falls back to global values when VRAM is unknown', () => {
    expect(resolveGpuProfile(settings(), gpu('unknown', undefined))).toEqual({
      memoryMode: 'balanced',
      tier: 'high',
      source: 'global',
    })
  })

  it('selects the recommended memory mode without changing the tier', () => {
    expect(resolveGpuProfile(settings(), gpu('large', 24 * GiB))).toEqual({
      memoryMode: 'max_speed',
      tier: 'high',
      source: 'recommended',
    })
    expect(resolveGpuProfile(settings(), gpu('small', 4 * GiB))).toEqual({
      memoryMode: 'min_memory',
      tier: 'high',
      source: 'recommended',
    })
  })

  it('lets per-GPU overrides win without mutating settings', () => {
    const before = settings({ device: { memoryMode: 'min_memory', tier: 'reference' } })
    const result = resolveGpuProfile(before, gpu('device', 24 * GiB))
    expect(result).toEqual({ memoryMode: 'min_memory', tier: 'reference', source: 'gpu-override' })
    expect(before.mossInferMemoryMode).toBe('balanced')
    expect(before.mossInferTier).toBe('high')
  })

  it('fills the fields a partial override leaves out', () => {
    expect(resolveGpuProfile(settings({ device: { tier: 'turbo' } }), gpu('device', 24 * GiB))).toEqual({
      memoryMode: 'max_speed',
      tier: 'turbo',
      source: 'gpu-override',
    })
    expect(resolveGpuProfile(settings({ device: { memoryMode: 'min_memory' } }), gpu('device', 24 * GiB))).toEqual({
      memoryMode: 'min_memory',
      tier: 'high',
      source: 'gpu-override',
    })
  })

  it('treats an empty override object as no override', () => {
    expect(resolveGpuProfile(settings({ device: {} }), gpu('device', 24 * GiB)).source).toBe('recommended')
    expect(resolveGpuProfile(settings({ device: {} }, 'custom'), gpu('device', 24 * GiB)).source).toBe('global')
  })

  it('only applies overrides for the matching uuid', () => {
    expect(resolveGpuProfile(settings({ other: { memoryMode: 'min_memory' } }), gpu('device', 24 * GiB))).toEqual({
      memoryMode: 'max_speed',
      tier: 'high',
      source: 'recommended',
    })
  })

  it('uses the custom global profile for GPUs without overrides', () => {
    const custom = { ...settings({}, 'custom'), mossInferMemoryMode: 'min_memory' as const, mossInferTier: 'turbo' as const }
    expect(resolveGpuProfile(custom, gpu('device', 24 * GiB))).toEqual({
      memoryMode: 'min_memory',
      tier: 'turbo',
      source: 'global',
    })
  })

  it('still honours overrides in custom mode', () => {
    expect(resolveGpuProfile(settings({ device: { memoryMode: 'max_speed' } }, 'custom'), gpu('device', 4 * GiB))).toEqual({
      memoryMode: 'max_speed',
      tier: 'high',
      source: 'gpu-override',
    })
  })

  it('forces BF16 Reference on pre-Ampere GPUs without constraining others', () => {
    const mixed: ProfileSettings = {
      ...settings(),
      mossInferTier: 'turbo',
      gpuProfileOverrides: { rtx20: { tier: 'turbo' }, ampere: { tier: 'high' } },
    }
    const rtx20 = gpu('rtx20', 8 * GiB, 7, 5)
    const v100 = gpu('v100', 16 * GiB, 7, 0)
    const ampere = gpu('ampere', 12 * GiB, 8, 6)

    expect(resolveGpuProfile(mixed, rtx20)).toEqual({ memoryMode: 'balanced', tier: 'reference', source: 'hardware-compatibility' })
    expect(resolveGpuProfile(mixed, v100)).toEqual({ memoryMode: 'balanced', tier: 'reference', source: 'hardware-compatibility' })
    expect(resolveGpuProfile(mixed, ampere)).toEqual({ memoryMode: 'balanced', tier: 'high', source: 'gpu-override' })
  })

  it('does not blame hardware when the user already chose Reference', () => {
    const reference: ProfileSettings = { ...settings(), mossInferTier: 'reference' }
    expect(resolveGpuProfile(reference, gpu('rtx20', 8 * GiB, 7, 5))).toEqual({
      memoryMode: 'balanced',
      tier: 'reference',
      source: 'recommended',
    })
    expect(resolveGpuProfile({ ...reference, gpuProfileMode: 'custom' }, gpu('rtx20', 8 * GiB, 7, 5)).source).toBe('global')
    expect(resolveGpuProfile(settings({ rtx20: { tier: 'reference' } }), gpu('rtx20', 8 * GiB, 7, 5)).source).toBe('gpu-override')
  })
})

describe('settingsForGpuProfile', () => {
  it('only applies the selected memory mode and tier', () => {
    const original = fullSettings()
    const profile = resolveGpuProfile(settings(), gpu('device', 24 * GiB))
    const execution = settingsForGpuProfile(original, profile)
    expect(execution).not.toBe(original)
    expect(execution).toEqual({ ...original, mossInferMemoryMode: 'max_speed', mossInferTier: 'high' })
    expect(execution.gpuSelection).toEqual(original.gpuSelection)
    expect(original.mossInferMemoryMode).toBe('balanced')
  })

  it('does not leak the profile source into settings', () => {
    const execution = settingsForGpuProfile(fullSettings(), {
      memoryMode: 'min_memory',
      tier: 'reference',
      source: 'hardware-compatibility',
    })
    expect(execution).not.toHaveProperty('source')
    expect(execution.mossInferTier).toBe('reference')
  })
})
