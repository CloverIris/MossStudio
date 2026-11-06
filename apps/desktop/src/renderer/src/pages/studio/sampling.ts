import type { EngineFeatures, JobHires, JobSampling, ProjectCanvas } from '@shared/types'
import { DIMENSION_STEP } from './defaults'

/**
 * 高级 sampling choices: sampler, scheduler, shift, 高清修复 (a second pass at a
 * larger size), step cache and CFG truncation. Every field is optional; an
 * absent one means the engine's own default ("默认"). Pure, no React.
 */

const SAMPLER_NAMES: Record<string, string> = {
  euler: 'Euler',
  ab2: 'AB2',
  euler_ancestral: 'Euler 祖先',
  heun: 'Heun',
  dpmpp_2m: 'DPM++ 2M',
  dpmpp_2m_sde: 'DPM++ 2M SDE',
  er_sde: 'ER-SDE',
  res_multistep: 'RES 多步',
  dataspace: '数据空间',
}

const SCHEDULER_NAMES: Record<string, string> = {
  moss: 'MOSS',
  simple: '简单',
  normal: '标准',
  karras: 'Karras',
  exponential: '指数',
  beta: 'Beta',
  sgm_uniform: 'SGM 均匀',
}

const STEP_CACHE_NAMES: Record<string, string> = {
  off: '关闭',
  fbcache: '首块缓存',
}

export type EnumParam = 'sampler' | 'scheduler' | 'step_cache' | 'resize'

const NAMES: Record<EnumParam, Record<string, string>> = {
  sampler: SAMPLER_NAMES,
  scheduler: SCHEDULER_NAMES,
  step_cache: STEP_CACHE_NAMES,
  resize: { crop: '裁剪', fit: '适应', stretch: '拉伸' },
}

/** "DPM++ 2M · dpmpp_2m": a friendly name plus the engine's own name; unknown names as they are. */
export function enumLabel(param: EnumParam, value: string): string {
  const friendly = NAMES[param][value]
  if (!friendly) return value
  return param === 'resize' ? friendly : `${friendly} · ${value}`
}

/** The values the engine accepts for an enum parameter (never a hard-coded list). */
export function enumValues(features: EngineFeatures | null | undefined, param: EnumParam): string[] {
  return features?.values?.[param] ?? []
}

/** Select options: 默认 first, then every accepted value; a saved value the engine no longer lists stays visible. */
export function enumOptions(
  features: EngineFeatures | null | undefined,
  param: EnumParam,
  current?: string,
): Array<{ value: string; label: string; disabled?: boolean }> {
  const values = enumValues(features, param)
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: '', label: '默认' },
    ...values.map((value) => ({ value, label: enumLabel(param, value) })),
  ]
  if (current && !values.includes(current))
    options.push({ value: current, label: `${enumLabel(param, current)}（不支持）`, disabled: true })
  return options
}

/** Drop absent fields; no sampling at all is `undefined`. */
export function cleanSampling(sampling: JobSampling | undefined): JobSampling | undefined {
  if (!sampling) return undefined
  const next: JobSampling = {}
  if (sampling.sampler) next.sampler = sampling.sampler
  if (sampling.scheduler) next.scheduler = sampling.scheduler
  if (sampling.shift !== undefined && Number.isFinite(sampling.shift)) next.shift = sampling.shift
  if (sampling.hires) next.hires = sampling.hires
  if (sampling.stepCache) next.stepCache = sampling.stepCache
  if (sampling.cfgTruncation !== undefined && Number.isFinite(sampling.cfgTruncation)) next.cfgTruncation = sampling.cfgTruncation
  return Object.keys(next).length ? next : undefined
}

/** Set one sampling field (undefined = back to the engine default) and return the canvas. */
export function withSampling<T extends Pick<ProjectCanvas, 'sampling'>>(canvas: T, patch: Partial<JobSampling>): T {
  const sampling = cleanSampling({ ...canvas.sampling, ...patch })
  const next = { ...canvas, sampling }
  if (!sampling) delete next.sampling
  return next
}

/* ------------------------------------------------------------------ */
/* 高清修复                                                             */
/* ------------------------------------------------------------------ */

export const HIRES_MAX_DIMENSION = 4096
/** A result card takes the hires size, and a card is at least 64 pixels a side. */
export const HIRES_MIN_DIMENSION = 64
export const HIRES_SCALES = [1.5, 2] as const
export const HIRES_STRENGTH_DEFAULT = 0.35
export type HiresChoice = 'off' | '1.5' | '2' | 'custom'

function snap(value: number): number {
  return Math.max(HIRES_MIN_DIMENSION, Math.min(HIRES_MAX_DIMENSION, Math.round(value / DIMENSION_STEP) * DIMENSION_STEP))
}

/** The second-pass size for a scale of the first-pass size, on the engine's 16-pixel grid. */
export function hiresSize(base: { width: number; height: number }, scale: number): { width: number; height: number } {
  return { width: snap(base.width * scale), height: snap(base.height * scale) }
}

/** Snap a typed hires dimension. */
export function clampHiresDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return snap(value)
}

/** The size the first pass runs at: a result of a hires run records it in `baseSize`. */
export function generationSize(canvas: Pick<ProjectCanvas, 'width' | 'height'> & { baseSize?: { width: number; height: number } }): {
  width: number
  height: number
} {
  return canvas.baseSize ? { ...canvas.baseSize } : { width: canvas.width, height: canvas.height }
}

/** The size of the finished picture. */
export function outputSize(
  canvas: Pick<ProjectCanvas, 'width' | 'height' | 'sampling'> & { baseSize?: { width: number; height: number } },
): { width: number; height: number } {
  const hires = canvas.sampling?.hires
  return hires ? { width: hires.width, height: hires.height } : generationSize(canvas)
}

export function hiresChoice(canvas: Pick<ProjectCanvas, 'width' | 'height' | 'sampling'>): HiresChoice {
  const hires = canvas.sampling?.hires
  if (!hires) return 'off'
  for (const scale of HIRES_SCALES) {
    const size = hiresSize(canvas, scale)
    if (size.width === hires.width && size.height === hires.height) return String(scale) as HiresChoice
  }
  return 'custom'
}

/** Turn hires on at a scale, keeping its steps and strength. */
export function withHiresScale<T extends Pick<ProjectCanvas, 'width' | 'height' | 'sampling'>>(canvas: T, scale: number): T {
  const previous = canvas.sampling?.hires
  const hires: JobHires = { ...previous, ...hiresSize(canvas, scale) }
  if (hires.strength === undefined) hires.strength = HIRES_STRENGTH_DEFAULT
  return withSampling(canvas, { hires })
}

export function withHiresPatch<T extends Pick<ProjectCanvas, 'width' | 'height' | 'sampling'>>(canvas: T, patch: Partial<JobHires>): T {
  const previous = canvas.sampling?.hires ?? { ...hiresSize(canvas, 2), strength: HIRES_STRENGTH_DEFAULT }
  const hires: JobHires = { ...previous, ...patch }
  if (hires.steps === undefined) delete hires.steps
  if (hires.strength === undefined) delete hires.strength
  return withSampling(canvas, { hires })
}

/** A canvas resized from `from` keeps its hires target in proportion. */
export function scaleHires(
  sampling: JobSampling | undefined,
  from: { width: number; height: number },
  to: { width: number; height: number },
): JobSampling | undefined {
  const hires = sampling?.hires
  if (!sampling || !hires || (from.width === to.width && from.height === to.height)) return sampling
  return {
    ...sampling,
    hires: { ...hires, width: snap((hires.width / from.width) * to.width), height: snap((hires.height / from.height) * to.height) },
  }
}

/** One line for the collapsed 高级 summary, e.g. "DPM++ 2M · 高清修复 ×2". Empty when all default. */
export function samplingSummary(canvas: Pick<ProjectCanvas, 'width' | 'height' | 'sampling'>): string {
  const sampling = canvas.sampling
  if (!sampling) return ''
  const parts: string[] = []
  if (sampling.sampler) parts.push(SAMPLER_NAMES[sampling.sampler] ?? sampling.sampler)
  if (sampling.scheduler) parts.push(SCHEDULER_NAMES[sampling.scheduler] ?? sampling.scheduler)
  const choice = hiresChoice(canvas)
  if (choice === 'custom' && sampling.hires) parts.push(`高清修复 ${sampling.hires.width}×${sampling.hires.height}`)
  else if (choice !== 'off') parts.push(`高清修复 ×${choice}`)
  return parts.join(' · ')
}
