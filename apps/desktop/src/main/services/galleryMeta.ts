import { basename, dirname, extname, join } from 'node:path'
import type { GalleryGeneration, JobParams, JobRecord } from '@shared/types'
import { isInside } from '../lib/paths'

/**
 * Pure helpers behind the gallery: where an image's generation details come
 * from, what its sidecar records, and which paths may be moved to the trash.
 * No file system access here, so every rule is unit-testable.
 */

export const GALLERY_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** Plain-words label for where a job ran. */
export function whereLabel(job: Pick<JobRecord, 'hostId' | 'gpuSnapshot'>, hostName?: string): string {
  if (job.hostId) return hostName?.trim() || job.hostId
  return job.gpuSnapshot?.name ? `本机 · ${job.gpuSnapshot.name}` : '本机'
}

function bundleIdOf(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const value = (snapshot as Record<string, unknown>)['bundleId']
  return typeof value === 'string' && value ? value : undefined
}

/** The first finite number, or undefined (engines may report NaN for a missing seed). */
function finiteOr(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value))
}

/** Parsed AUTOMATIC1111-style `parameters` text: prompt, then "Negative prompt:", then "Steps: …, Seed: …". */
export interface A1111Parameters {
  prompt: string
  negativePrompt?: string
  steps?: number
  cfg?: number
  seed?: number
  width?: number
  height?: number
  modelName?: string
}

/** Returns null when the text has no "Steps:" settings line (it is then a plain prompt). */
export function parseA1111(text: string): A1111Parameters | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let settingsIndex = -1
  for (let index = lines.length - 1; index >= 0 && settingsIndex < 0; index -= 1) {
    if (/^Steps:\s*\d+/.test(lines[index]!.trim())) settingsIndex = index
  }
  if (settingsIndex < 0) return null
  const head = lines.slice(0, settingsIndex)
  const negativeIndex = head.findIndex((line) => line.startsWith('Negative prompt:'))
  const prompt = (negativeIndex >= 0 ? head.slice(0, negativeIndex) : head).join('\n').trim()
  const negativePrompt = negativeIndex >= 0
    ? head.slice(negativeIndex).join('\n').replace(/^Negative prompt:\s*/, '').trim() || undefined
    : undefined
  const settings = new Map<string, string>()
  for (const match of lines[settingsIndex]!.matchAll(/([A-Za-z][A-Za-z0-9 ]*?):\s*("(?:[^"\\]|\\.)*"|[^,]*)(?:,|$)/g)) {
    settings.set(match[1]!.trim().toLowerCase(), match[2]!.trim().replace(/^"|"$/g, ''))
  }
  const size = settings.get('size')?.match(/^(\d+)x(\d+)$/)
  return {
    prompt,
    negativePrompt,
    steps: num(settings.get('steps')),
    cfg: num(settings.get('cfg scale')),
    seed: num(settings.get('seed')),
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
    modelName: str(settings.get('model')),
  }
}

/**
 * The description a person wrote, from what the engine was given. A region
 * layout compiles to JSON whose summary caption is the description; an A1111
 * blob carries settings after the prompt. Anything else is the prompt itself.
 */
export function describePrompt(prompt: string | undefined): { description: string; regions: number } {
  const text = prompt?.trim() ?? ''
  if (text.startsWith('{')) {
    try {
      const layout = JSON.parse(text) as { summary?: { caption?: unknown }; items?: unknown }
      if (layout && typeof layout.summary?.caption === 'string') {
        return { description: layout.summary.caption.trim(), regions: Array.isArray(layout.items) ? layout.items.length : 0 }
      }
    } catch {
      // not JSON: a prompt that happens to start with a brace
    }
  }
  const a1111 = parseA1111(text)
  return { description: a1111 ? a1111.prompt : text, regions: 0 }
}

/** Generation details for one output of a job record. */
export function generationFromJob(
  job: JobRecord,
  output: { width?: number; height?: number; seed?: number } = {},
  hostName?: string,
): GalleryGeneration {
  return {
    jobId: job.id,
    projectId: job.projectId,
    modelName: job.instanceName || undefined,
    modelBundleId: bundleIdOf(job.modelSnapshot),
    steps: finiteOr(job.params.steps),
    cfg: finiteOr(job.params.cfg),
    width: finiteOr(output.width, job.params.width),
    height: finiteOr(output.height, job.params.height),
    seed: finiteOr(output.seed, job.params.seed),
    adapters: job.params.adapters?.length ? job.params.adapters.map((item) => ({ ...item })) : undefined,
    createdAt: job.startedAt,
    where: whereLabel(job, hostName),
    hostId: job.hostId,
    ...describedPrompt(job.params.prompt),
    ...inputsOf(job.params),
  }
}

/** The image inputs and sampling choices of a job, copied (absent ones left out). */
function inputsOf(params: JobParams): Pick<GalleryGeneration, 'baseWidth' | 'baseHeight' | 'initImage' | 'mask' | 'control' | 'references' | 'sampling'> {
  const copy = <T>(value: T | undefined): T | undefined => (value === undefined ? undefined : structuredClone(value))
  const out = {
    baseWidth: params.sampling?.hires ? params.width : undefined,
    baseHeight: params.sampling?.hires ? params.height : undefined,
    initImage: copy(params.initImage),
    mask: copy(params.mask),
    control: copy(params.control),
    references: copy(params.references),
    sampling: params.sampling && Object.keys(params.sampling).length ? copy(params.sampling) : undefined,
  }
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined))
}

/**
 * The sidecar keys for a job's image inputs, in the engine's own spellings
 * (init_image, denoise_strength, control.images[].path…), so the file reads
 * like the request that made the picture. Absent inputs are left out.
 */
export function jobInputsSidecar(params: JobParams): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  if (params.initImage) {
    record['init_image'] = params.initImage.path
    record['denoise_strength'] = params.initImage.strength
    if (params.initImage.resize) record['resize'] = params.initImage.resize
  }
  if (params.mask) record['mask'] = params.mask.path
  if (params.control) {
    record['control'] = {
      adapter: params.control.adapter,
      ...(params.control.loraStrength !== undefined ? { lora_strength: params.control.loraStrength } : {}),
      images: params.control.images.map((image) => ({ ...image })),
    }
  }
  if (params.references) {
    record['references'] = {
      images: [...params.references.paths],
      ...(params.references.maxEdge !== undefined ? { max_edge: params.references.maxEdge } : {}),
    }
  }
  const sampling = params.sampling
  if (sampling?.sampler) record['sampler'] = sampling.sampler
  if (sampling?.scheduler) record['scheduler'] = sampling.scheduler
  if (sampling?.shift !== undefined) record['shift'] = sampling.shift
  if (sampling?.hires) {
    record['hires'] = { ...sampling.hires }
    // width/height are the finished picture's; the first pass ran at the requested size.
    record['base_width'] = params.width
    record['base_height'] = params.height
  }
  if (sampling?.stepCache) record['step_cache'] = sampling.stepCache
  if (sampling?.cfgTruncation !== undefined) record['cfg_truncation'] = sampling.cfgTruncation
  return record
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** `jobInputsSidecar` read back; anything malformed is skipped, never guessed. */
function inputsFromSidecar(sidecar: Record<string, unknown>): Pick<GalleryGeneration, 'baseWidth' | 'baseHeight' | 'initImage' | 'mask' | 'control' | 'references' | 'sampling'> {
  const out: Pick<GalleryGeneration, 'baseWidth' | 'baseHeight' | 'initImage' | 'mask' | 'control' | 'references' | 'sampling'> = {}
  const baseWidth = num(sidecar['base_width'])
  const baseHeight = num(sidecar['base_height'])
  if (baseWidth !== undefined && baseHeight !== undefined) {
    out.baseWidth = baseWidth
    out.baseHeight = baseHeight
  }
  const init = str(sidecar['init_image'])
  const strength = num(sidecar['denoise_strength'])
  if (init && strength !== undefined) {
    const resize = sidecar['resize']
    out.initImage = { path: init, strength, ...(resize === 'crop' || resize === 'fit' || resize === 'stretch' ? { resize } : {}) }
  }
  const mask = str(sidecar['mask'])
  if (mask) out.mask = { path: mask }
  const control = objectOf(sidecar['control'])
  const adapter = control ? str(control['adapter']) : undefined
  if (control && adapter) {
    const images = Array.isArray(control['images'])
      ? (control['images'] as unknown[]).flatMap((item) => {
          const image = objectOf(item)
          const kind = image ? str(image['kind']) : undefined
          const path = image ? str(image['path']) : undefined
          if (!image || !kind || !path) return []
          return [{ kind, path, strength: num(image['strength']) ?? 1, start: num(image['start']) ?? 0, end: num(image['end']) ?? 1 }]
        })
      : []
    const loraStrength = num(control['lora_strength'])
    out.control = { adapter, images, ...(loraStrength !== undefined ? { loraStrength } : {}) }
  }
  const references = objectOf(sidecar['references'])
  if (references && Array.isArray(references['images'])) {
    const paths = (references['images'] as unknown[]).flatMap((item) => (str(item) ? [item as string] : []))
    const maxEdge = num(references['max_edge'])
    if (paths.length) out.references = { paths, ...(maxEdge !== undefined ? { maxEdge } : {}) }
  }
  const hires = objectOf(sidecar['hires'])
  const hiresWidth = hires ? num(hires['width']) : undefined
  const hiresHeight = hires ? num(hires['height']) : undefined
  const sampling = {
    sampler: str(sidecar['sampler']),
    scheduler: str(sidecar['scheduler']),
    shift: num(sidecar['shift']),
    hires: hires && hiresWidth !== undefined && hiresHeight !== undefined
      ? Object.fromEntries(Object.entries({ width: hiresWidth, height: hiresHeight, steps: num(hires['steps']), strength: num(hires['strength']) })
        .filter(([, value]) => value !== undefined)) as { width: number; height: number; steps?: number; strength?: number }
      : undefined,
    stepCache: str(sidecar['step_cache']),
    cfgTruncation: num(sidecar['cfg_truncation']),
  }
  const definedSampling = Object.entries(sampling).filter(([, value]) => value !== undefined)
  if (definedSampling.length) out.sampling = Object.fromEntries(definedSampling)
  return out
}

function describedPrompt(prompt: string | undefined): Pick<GalleryGeneration, 'description' | 'regions'> {
  const { description, regions } = describePrompt(prompt)
  return { ...(description ? { description } : {}), ...(regions ? { regions } : {}) }
}

const num = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

/**
 * Generation details from a JSON sidecar. Reads both the engine's own fields
 * (prompt, seed, width, height) and the ones `sidecarRecord` adds.
 * Returns undefined when the sidecar says nothing useful.
 */
export function generationFromSidecar(sidecar: Record<string, unknown> | null): GalleryGeneration | undefined {
  if (!sidecar) return undefined
  const adapters = Array.isArray(sidecar['adapters'])
    ? (sidecar['adapters'] as unknown[]).flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const path = str((item as Record<string, unknown>)['path'])
        const strength = num((item as Record<string, unknown>)['strength'])
        return path && strength !== undefined ? [{ path, strength }] : []
      })
    : []
  const generation: GalleryGeneration = {
    jobId: str(sidecar['job_id']),
    projectId: str(sidecar['project_id']),
    modelName: str(sidecar['model_name']) ?? str(sidecar['model']),
    modelBundleId: str(sidecar['model_bundle_id']),
    steps: num(sidecar['steps']),
    cfg: num(sidecar['cfg']),
    width: num(sidecar['width']),
    height: num(sidecar['height']),
    seed: num(sidecar['seed']),
    adapters: adapters.length ? adapters : undefined,
    createdAt: str(sidecar['created_at']),
    where: str(sidecar['where']),
    hostId: str(sidecar['host_id']),
    description: str(sidecar['description']),
    regions: num(sidecar['regions']),
    ...inputsFromSidecar(sidecar),
  }
  const defined = Object.entries(generation).filter(([, value]) => value !== undefined)
  return defined.length ? (Object.fromEntries(defined) as GalleryGeneration) : undefined
}

/**
 * The fields MossStudio adds to an output's sidecar once its job finishes, so
 * the Library can show and filter by them after the job record is pruned.
 * Keys the engine already wrote are never overwritten (see `mergeSidecar`).
 */
export function sidecarRecord(
  job: JobRecord,
  output: { width?: number; height?: number; seed?: number },
  hostName?: string,
): Record<string, unknown> {
  const generation = generationFromJob(job, output, hostName)
  const record: Record<string, unknown> = {
    prompt: job.params.prompt,
    negative_prompt: job.params.negativePrompt || undefined,
    seed: generation.seed,
    width: generation.width,
    height: generation.height,
    steps: generation.steps,
    cfg: generation.cfg,
    model_name: generation.modelName,
    model_bundle_id: generation.modelBundleId,
    adapters: generation.adapters,
    job_id: job.id,
    project_id: job.projectId,
    created_at: job.startedAt,
    where: generation.where,
    host_id: job.hostId,
    description: generation.description,
    regions: generation.regions,
    ...jobInputsSidecar(job.params),
  }
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

/** Adds the missing keys of `extra` to `existing`; existing values win. */
export function mergeSidecar(
  existing: Record<string, unknown> | null,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { ...extra, ...(existing ?? {}) }
}

/** The sidecar path MossStudio writes for an image: same name, `.json` extension. */
export function sidecarPath(file: string): string {
  return join(dirname(file), `${basename(file, extname(file))}.json`)
}

/**
 * Validates a path the renderer asked to delete. The path must be an image
 * strictly inside one of the gallery roots (never a root itself). Callers pass
 * symlink-resolved paths for both, so a link cannot point the check elsewhere.
 * Returns the root that contains it, or throws an error the user can read.
 */
export function assertTrashable(file: string, roots: readonly string[]): string {
  if (!GALLERY_IMAGE_EXT.has(extname(file).toLowerCase())) throw new Error('只能删除图片文件')
  const root = roots.find((candidate) => isInside(candidate, file) && !isInside(file, candidate))
  if (!root) throw new Error('这张图片不在作品目录中，无法删除')
  return root
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Written by MossStudio or its engine (not, say, a ComfyUI workflow that shares the name). */
export function isMossSidecar(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value['job_id'] === 'string' || typeof value['project_id'] === 'string' || value['engine'] === 'mossinfer'
}

const SIDECAR_KEYS = ['prompt', 'negative_prompt', 'seed', 'width', 'height', 'parameters', 'job_id', 'project_id', 'description']

/** Worth reading as image metadata: an object with at least one generation key. */
export function isImageSidecar(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && SIDECAR_KEYS.some((key) => key in value)
}

/**
 * Merges an image's two possible sidecars. `image.json` is what the engine and
 * MossStudio write, so it wins over `image.png.json`; either is ignored unless
 * it looks like image metadata.
 */
export function mergeSidecars(own: unknown, stem: unknown): Record<string, unknown> | null {
  const a = isImageSidecar(own) ? own : null
  const b = isImageSidecar(stem) ? stem : null
  return a || b ? { ...(a ?? {}), ...(b ?? {}) } : null
}

/**
 * Sidecars to move to the trash with an image. `image.png.json` always belongs
 * to it. `image.json` only when MossStudio wrote it and no other image shares
 * the name, so an unrelated file in a user's folder is never trashed.
 */
export function sidecarsToTrash(
  file: string,
  exists: (path: string) => boolean,
  read: (path: string) => unknown,
): string[] {
  const own = `${file}.json`
  const shared = sidecarPath(file)
  const stem = join(dirname(file), basename(file, extname(file)))
  const sibling = [...GALLERY_IMAGE_EXT].some(
    (ext) => ext !== extname(file).toLowerCase() && (exists(`${stem}${ext}`) || exists(`${stem}${ext.toUpperCase()}`)),
  )
  const result = exists(own) ? [own] : []
  if (!sibling && shared !== own && exists(shared) && isMossSidecar(read(shared))) result.push(shared)
  return result
}
