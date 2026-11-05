import type { JobParams } from '@shared/types'

/**
 * JobParams → moss-server `generate` params, spelled exactly as main.cpp's
 * request_params() parses them. Only what the job sets is sent: an absent
 * field keeps the engine's own default (its "unset" markers).
 */

export interface GenerateRequestOptions {
  /** PNG the engine writes the result to. */
  output: string
  loras?: Array<{ path: string; strength: number }>
  /** PNG the engine rewrites with the live preview; omitted = no preview. */
  previewOutput?: string
  previewEvery?: number
}

/** Our painted masks are 8-bit, white = repaint: the engine's "u8" encoding (not "binary01"). */
export const MASK_ENCODING = 'u8'

export function buildGenerateParams(params: JobParams, options: GenerateRequestOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {
    output: options.output,
    prompt: params.prompt,
    negative_prompt: params.negativePrompt,
    width: params.width,
    height: params.height,
    steps: params.steps,
    cfg: params.cfg,
    seed: params.seed,
    save_metadata: true,
    include_prompts: true,
  }
  if (options.loras?.length) out['loras'] = options.loras.map((lora) => ({ path: lora.path, strength: lora.strength }))

  if (params.initImage) {
    out['init_image'] = params.initImage.path
    out['denoise_strength'] = params.initImage.strength
    if (params.initImage.resize) out['resize'] = params.initImage.resize
    if (params.mask) {
      out['mask'] = params.mask.path
      out['mask_encoding'] = MASK_ENCODING
    }
  }

  if (params.control) {
    const control: Record<string, unknown> = { adapter: params.control.adapter }
    if (params.control.loraStrength !== undefined) control['lora_strength'] = params.control.loraStrength
    if (params.control.images.length) {
      control['images'] = params.control.images.map((image) => ({
        kind: image.kind,
        path: image.path,
        strength: image.strength,
        start: image.start,
        end: image.end,
      }))
    }
    out['control'] = control
  }

  if (params.references?.paths.length) {
    const references: Record<string, unknown> = { images: [...params.references.paths] }
    if (params.references.maxEdge !== undefined) references['max_edge'] = params.references.maxEdge
    out['references'] = references
  }

  const sampling = params.sampling
  if (sampling) {
    if (sampling.sampler) out['sampler'] = sampling.sampler
    if (sampling.scheduler) out['scheduler'] = sampling.scheduler
    if (sampling.shift !== undefined) out['shift'] = sampling.shift
    if (sampling.hires) {
      const hires: Record<string, unknown> = { width: sampling.hires.width, height: sampling.hires.height }
      if (sampling.hires.steps !== undefined) hires['steps'] = sampling.hires.steps
      if (sampling.hires.strength !== undefined) hires['strength'] = sampling.hires.strength
      out['hires'] = hires
    }
    if (sampling.stepCache) out['step_cache'] = sampling.stepCache
    if (sampling.cfgTruncation !== undefined) out['cfg_truncation'] = sampling.cfgTruncation
  }

  if (options.previewOutput) {
    out['preview_output'] = options.previewOutput
    if (options.previewEvery !== undefined) out['preview_every'] = options.previewEvery
  }
  return out
}

/** The size of the PNG the engine writes: the hires pass's when there is one. */
export function outputSizeOf(params: JobParams): { width: number; height: number } {
  const hires = params.sampling?.hires
  return hires ? { width: hires.width, height: hires.height } : { width: params.width, height: params.height }
}

/** About 15 preview frames per job at most, one per step on short runs. */
export function previewEveryFor(steps: number): number {
  return Math.max(1, Math.round(steps / 15))
}

/** Every image file a job reads, in a stable order, with where it sits in the params. */
export function jobInputFiles(params: JobParams): Array<{ role: 'init' | 'mask' | 'control' | 'reference'; index: number; path: string }> {
  const files: Array<{ role: 'init' | 'mask' | 'control' | 'reference'; index: number; path: string }> = []
  if (params.initImage) files.push({ role: 'init', index: 0, path: params.initImage.path })
  if (params.mask) files.push({ role: 'mask', index: 0, path: params.mask.path })
  params.control?.images.forEach((image, index) => files.push({ role: 'control', index, path: image.path }))
  params.references?.paths.forEach((path, index) => files.push({ role: 'reference', index, path }))
  return files
}

/** A copy of `params` with each input image path passed through `rewrite` (the control adapter file is not an image). */
export function rewriteJobInputPaths(params: JobParams, rewrite: (path: string) => string): JobParams {
  return {
    ...params,
    ...(params.initImage ? { initImage: { ...params.initImage, path: rewrite(params.initImage.path) } } : {}),
    ...(params.mask ? { mask: { path: rewrite(params.mask.path) } } : {}),
    ...(params.control
      ? { control: { ...params.control, images: params.control.images.map((image) => ({ ...image, path: rewrite(image.path) })) } }
      : {}),
    ...(params.references
      ? { references: { ...params.references, paths: params.references.paths.map(rewrite) } }
      : {}),
  }
}
