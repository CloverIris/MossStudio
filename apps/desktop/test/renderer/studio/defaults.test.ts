import { describe, expect, it } from 'vitest'
import {
  MAX_DIMENSION,
  MIN_DIMENSION,
  QUALITY_PRESETS,
  SEED_MAX,
  clampDimension,
  nearestQuality,
  nextCanvasTitle,
  nextProjectName,
  parseSeed,
  profileFor,
  qualityFor,
  randomSeed,
  seedForRun,
  sizePresetFor,
} from '@renderer/pages/studio/defaults'

describe('studio/defaults size presets', () => {
  it('matches presets exactly and calls everything else custom', () => {
    expect(sizePresetFor(1024, 1024)).toBe('1:1')
    expect(sizePresetFor(1152, 864)).toBe('4:3')
    expect(sizePresetFor(864, 1152)).toBe('3:4')
    expect(sizePresetFor(1280, 720)).toBe('16:9')
    expect(sizePresetFor(512, 512)).toBe('custom')
  })

  it('snaps typed sizes to the 16-pixel grid inside the supported range', () => {
    expect(clampDimension(990)).toBe(992)
    expect(clampDimension(1000)).toBe(1008)
    expect(clampDimension(10)).toBe(MIN_DIMENSION)
    expect(clampDimension(99999)).toBe(MAX_DIMENSION)
    expect(clampDimension(Number.NaN, 768)).toBe(768)
    expect(clampDimension(0, 640)).toBe(640)
  })
})

describe('studio/defaults quality presets', () => {
  it('maps 快速/标准/精细 to 8/20/50 steps with an explicit profile', () => {
    expect(QUALITY_PRESETS.map((preset) => [preset.label, preset.steps, preset.profile])).toEqual([
      ['快速', 8, 'dmd8'],
      ['标准', 20, 'base'],
      ['精细', 50, 'base'],
    ])
    expect(qualityFor(8)).toBe('fast')
    expect(qualityFor(20)).toBe('standard')
    expect(qualityFor(50)).toBe('fine')
    expect(qualityFor(30)).toBe('custom')
  })

  it('takes the profile from the preset, and keeps the old rule for older step counts', () => {
    expect(profileFor(8)).toBe('dmd8')
    expect(profileFor(20)).toBe('base')
    expect(profileFor(4)).toBe('dmd8')
    expect(profileFor(30)).toBe('base')
  })

  it('snaps outside values to the nearest preset', () => {
    expect(nearestQuality(1)).toBe('fast')
    expect(nearestQuality(14)).toBe('fast')
    expect(nearestQuality(15)).toBe('standard')
    expect(nearestQuality(36)).toBe('fine')
  })
})

describe('studio/defaults seeds', () => {
  it('draws a new seed unless the seed is locked', () => {
    expect(seedForRun({ seed: 42, seedLocked: true }, () => 0.5)).toBe(42)
    expect(seedForRun({ seed: 42 }, () => 0.5)).toBe(Math.floor(0.5 * SEED_MAX))
    expect(seedForRun({ seed: 42, seedLocked: false }, () => 0)).toBe(0)
  })

  it('keeps random seeds inside the stored integer range', () => {
    for (const value of [0, 0.25, 0.999999]) {
      const seed = randomSeed(() => value)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(SEED_MAX)
    }
  })

  it('parses only digits and clamps to the maximum', () => {
    expect(parseSeed(' 123 ')).toBe(123)
    expect(parseSeed('')).toBeNull()
    expect(parseSeed('-5')).toBeNull()
    expect(parseSeed('1e3')).toBeNull()
    expect(parseSeed('99999999999')).toBe(SEED_MAX)
  })
})

describe('studio/defaults names', () => {
  it('numbers canvases after the highest existing one, old names included', () => {
    expect(nextCanvasTitle([])).toBe('画面 1')
    expect(nextCanvasTitle(['画面 1', 'Canvas 4', '画面 2 · 结果'])).toBe('画面 5')
  })

  it('finds an unused untitled project name', () => {
    expect(nextProjectName([])).toBe('未命名项目')
    expect(nextProjectName(['未命名项目', '未命名项目 2'])).toBe('未命名项目 3')
  })
})

describe('studio/defaults seeds saved before the lock existed', () => {
  it('keeps a seed the user changed, and makes the untouched default random', async () => {
    const { isSeedLocked, LEGACY_DEFAULT_SEED } = await import('@renderer/pages/studio/defaults')
    expect(isSeedLocked({ seed: 1234 })).toBe(true)
    expect(isSeedLocked({ seed: LEGACY_DEFAULT_SEED })).toBe(false)
    expect(isSeedLocked({ seed: 1234, seedLocked: false })).toBe(false)
    expect(isSeedLocked({ seed: LEGACY_DEFAULT_SEED, seedLocked: true })).toBe(true)
    expect(seedForRun({ seed: 1234 }, () => 0.5)).toBe(1234)
  })
})
