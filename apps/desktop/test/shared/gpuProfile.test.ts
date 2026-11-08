import { describe, expect, it } from 'vitest'
import {
  gpuLacks8BitAttention,
  recommendGpuMemoryMode,
  resolveGpuProfile,
  settingsForGpuProfile,
  tierForWeights,
  withWeightTier,
  type WeightPrecisions,
} from '@shared/gpuProfile'
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

describe('gpuLacks8BitAttention', () => {
  it('flags pre-Ampere GPUs only', () => {
    expect(gpuLacks8BitAttention(gpu('rtx20', 8 * GiB, 7, 5))).toBe(true)
    expect(gpuLacks8BitAttention(gpu('v100', 16 * GiB, 7, 0))).toBe(true)
    expect(gpuLacks8BitAttention(gpu('pascal', 8 * GiB, 6, 1))).toBe(true)
    expect(gpuLacks8BitAttention(gpu('ampere', 12 * GiB, 8, 6))).toBe(false)
    expect(gpuLacks8BitAttention(gpu('blackwell', 12 * GiB, 12, 0))).toBe(false)
  })

  it('does not restrict GPUs with an unknown capability', () => {
    expect(gpuLacks8BitAttention(gpu('unknown', 8 * GiB))).toBe(false)
    expect(gpuLacks8BitAttention(gpu('zero', 8 * GiB, 0, 0))).toBe(false)
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

  it('passes the tier asked for through on every GPU: the weights settle it later', () => {
    const turbo: ProfileSettings = { ...settings(), gpuProfileOverrides: { rtx20: { tier: 'turbo' } } }
    expect(resolveGpuProfile(turbo, gpu('rtx20', 8 * GiB, 7, 5))).toEqual({ memoryMode: 'balanced', tier: 'turbo', source: 'gpu-override' })
    expect(resolveGpuProfile(settings(), gpu('v100', 16 * GiB, 7, 0))).toEqual({
      memoryMode: 'balanced',
      tier: 'high',
      source: 'recommended',
    })
  })
})

const bf16: WeightPrecisions = { dit: 'bf16', textEncoder: 'bf16' }
const rtx20 = gpu('rtx20', 8 * GiB, 7, 5)
const ampere = gpu('ampere', 12 * GiB, 8, 6)

describe('tierForWeights', () => {
  it('runs an INT8 DiT or text encoder at High, on Turing too', () => {
    for (const device of [rtx20, ampere]) {
      for (const requested of ['reference', 'high', 'turbo'] as const) {
        expect(tierForWeights(requested, { dit: 'int8', textEncoder: 'bf16' }, device).tier).toBe('high')
        expect(tierForWeights(requested, { dit: 'bf16', textEncoder: 'int8' }, device).tier).toBe('high')
        expect(tierForWeights(requested, { dit: 'bf16', textEncoder: 'w4a8' }, device).tier).toBe('high')
      }
    }
    expect(tierForWeights('reference', { dit: 'int8', textEncoder: 'bf16' }, rtx20)).toEqual({ tier: 'high', reason: 'weights' })
    expect(tierForWeights('high', { dit: 'int8', textEncoder: 'bf16' }, rtx20)).toEqual({ tier: 'high', reason: null })
  })

  it('runs an INT4 DiT only as Turbo, whatever the text encoder', () => {
    expect(tierForWeights('high', { dit: 'w4a4', textEncoder: 'int8' }, ampere)).toEqual({ tier: 'turbo', reason: 'weights' })
    expect(tierForWeights('turbo', { dit: 'w4a4', textEncoder: 'bf16' }, rtx20)).toEqual({ tier: 'turbo', reason: null })
  })

  it('keeps the choice for bf16 weights where the GPU has 8-bit attention, except Turbo', () => {
    expect(tierForWeights('reference', bf16, ampere)).toEqual({ tier: 'reference', reason: null })
    expect(tierForWeights('high', bf16, ampere)).toEqual({ tier: 'high', reason: null })
    expect(tierForWeights('turbo', bf16, ampere)).toEqual({ tier: 'high', reason: 'weights' })
  })

  it('runs bf16 weights as Reference where the GPU has no 8-bit attention', () => {
    expect(tierForWeights('high', bf16, rtx20)).toEqual({ tier: 'reference', reason: 'gpu' })
    expect(tierForWeights('reference', bf16, rtx20)).toEqual({ tier: 'reference', reason: null })
  })

  it('keeps the choice for unknown weights (the file may be INT4), and runs Reference without 8-bit attention', () => {
    const unknown: WeightPrecisions = { dit: null, textEncoder: 'bf16' }
    expect(tierForWeights('high', unknown, rtx20)).toEqual({ tier: 'reference', reason: 'gpu' })
    expect(tierForWeights('turbo', unknown, ampere)).toEqual({ tier: 'turbo', reason: null })
    expect(tierForWeights('high', { dit: 'bf16', textEncoder: null }, gpu('unknown', 8 * GiB))).toEqual({ tier: 'high', reason: null })
  })
})

describe('withWeightTier', () => {
  it('names what changed the tier', () => {
    const profile = resolveGpuProfile(settings(), rtx20)
    expect(withWeightTier(profile, bf16, rtx20)).toEqual({ memoryMode: 'balanced', tier: 'reference', source: 'hardware-compatibility' })
    expect(withWeightTier(profile, { dit: 'w4a4', textEncoder: 'bf16' }, rtx20)).toEqual({
      memoryMode: 'balanced',
      tier: 'turbo',
      source: 'model-weights',
    })
    expect(withWeightTier(profile, { dit: 'int8', textEncoder: 'bf16' }, rtx20)).toEqual(profile)
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
