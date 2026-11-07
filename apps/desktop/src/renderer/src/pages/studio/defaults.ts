/**
 * Plain-language presets for the Studio parameters panel. Pure data and helpers,
 * no React, so the mapping between what the user picks and what the engine
 * receives is unit tested.
 */

export const DEFAULT_NEGATIVE = 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact'

export const MIN_DIMENSION = 256
export const MAX_DIMENSION = 2048
/** The engine works on 16-pixel tiles; every width and height is a multiple of this. */
export const DIMENSION_STEP = 16

export type SizePresetId = '1:1' | '4:3' | '3:4' | '16:9' | 'custom'

export interface SizePreset {
  id: Exclude<SizePresetId, 'custom'>
  width: number
  height: number
}

/** About one megapixel each, every side a multiple of 16. */
export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: '1:1', width: 1024, height: 1024 },
  { id: '4:3', width: 1152, height: 864 },
  { id: '3:4', width: 864, height: 1152 },
  { id: '16:9', width: 1280, height: 720 },
]

export const DEFAULT_SIZE = { width: 1024, height: 1024 } as const

/** Which preset a size matches exactly; anything else is shown as 自定义. */
export function sizePresetFor(width: number, height: number): SizePresetId {
  return SIZE_PRESETS.find((preset) => preset.width === width && preset.height === height)?.id ?? 'custom'
}

/** Snap a typed dimension to the engine grid and the supported range. */
export function clampDimension(value: number, fallback: number = DEFAULT_SIZE.width): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  const snapped = Math.round(value / DIMENSION_STEP) * DIMENSION_STEP
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, snapped))
}

export type QualityId = 'fast' | 'standard' | 'fine'
export type SamplerProfile = 'dmd8' | 'base'

export interface QualityPreset {
  id: QualityId
  label: string
  steps: number
  /** Sampler profile sent with the job. 快速 is the 8-step DMD profile. */
  profile: SamplerProfile
  /** CFG the preset is tuned for; picking a preset resets CFG to this. */
  cfg: number
  hint: string
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { id: 'fast', label: '快速', steps: 8, profile: 'dmd8', cfg: 1, hint: '8 步，几秒出图' },
  { id: 'standard', label: '标准', steps: 20, profile: 'base', cfg: 3, hint: '20 步，细节和速度兼顾' },
  { id: 'fine', label: '精细', steps: 50, profile: 'base', cfg: 3, hint: '50 步，最慢但细节最多' },
]

export const DEFAULT_QUALITY: QualityId = 'standard'

export function qualityPreset(id: QualityId): QualityPreset {
  return QUALITY_PRESETS.find((preset) => preset.id === id) ?? QUALITY_PRESETS[1]
}

/** The preset a step count was chosen from, or 'custom' for older canvases. */
export function qualityFor(steps: number): QualityId | 'custom' {
  return QUALITY_PRESETS.find((preset) => preset.steps === steps)?.id ?? 'custom'
}

/** Quality as it reads everywhere (panel and viewer): "标准 · 20 步", or "自定义 · 28 步". */
export function qualityLabel(steps: number): string {
  const id = qualityFor(steps)
  return `${id === 'custom' ? '自定义' : qualityPreset(id).label} · ${steps} 步`
}

/** Nearest preset, for values that arrive from outside the panel (e.g. the assistant). */
export function nearestQuality(steps: number): QualityId {
  let best = QUALITY_PRESETS[0]
  for (const preset of QUALITY_PRESETS) {
    if (Math.abs(preset.steps - steps) < Math.abs(best.steps - steps)) best = preset
  }
  return best.id
}

/**
 * Sampler profile for a run. A preset step count carries the profile the user
 * picked with it; step counts saved by older versions keep their old meaning
 * (8 steps or fewer ran the DMD profile).
 */
export function profileFor(steps: number): SamplerProfile {
  const quality = qualityFor(steps)
  if (quality !== 'custom') return qualityPreset(quality).profile
  return steps <= 8 ? 'dmd8' : 'base'
}

/** Seeds are stored as non-negative 31-bit integers (the project schema requires int). */
export const SEED_MAX = 2 ** 31 - 1

export function randomSeed(random: () => number = Math.random): number {
  return Math.floor(random() * SEED_MAX)
}

/** The seed every canvas had before 随机 existed; nobody chose it on purpose. */
export const LEGACY_DEFAULT_SEED = 42

/**
 * Whether a canvas keeps its seed. Canvases saved before the lock existed
 * (`seedLocked` undefined) always reused their seed; one the user changed from
 * the old default of 42 counts as deliberately chosen and stays locked, while
 * the untouched default becomes random like every new canvas.
 */
export function isSeedLocked(canvas: { seed: number; seedLocked?: boolean }): boolean {
  return canvas.seedLocked ?? canvas.seed !== LEGACY_DEFAULT_SEED
}

/** Seed the next run uses: the kept seed when locked, a fresh one otherwise. */
export function seedForRun(canvas: { seed: number; seedLocked?: boolean }, random: () => number = Math.random): number {
  return isSeedLocked(canvas) ? canvas.seed : randomSeed(random)
}

/** Parse a typed seed; empty or invalid text yields null. */
export function parseSeed(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return Math.min(SEED_MAX, Number(trimmed))
}

/** Next free "画面 N" title. Older projects named them "Canvas N"; both count. */
export function nextCanvasTitle(titles: readonly string[]): string {
  let highest = 0
  for (const title of titles) {
    const match = /^(?:画面|Canvas) (\d+)$/.exec(title)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `画面 ${highest + 1}`
}

export const UNTITLED_PROJECT = '未命名项目'

/** Untitled name that does not collide with an existing project. */
export function nextProjectName(names: readonly string[]): string {
  const used = new Set(names)
  if (!used.has(UNTITLED_PROJECT)) return UNTITLED_PROJECT
  let index = 2
  while (used.has(`${UNTITLED_PROJECT} ${index}`)) index += 1
  return `${UNTITLED_PROJECT} ${index}`
}
