import type { GalleryDetail, GalleryGeneration, JobSampling } from '@shared/types'

/**
 * Library → Studio handoff: "在创作中复用" asks Studio to open a NEW canvas
 * prefilled with an image's parameters; "用作起始图" (`useAs: 'start'`) also
 * brings the image itself onto the board as a picture card linked into that
 * canvas as its start picture.
 *
 * The Library puts one of these in the store (`requestStudioReuse`) and
 * navigates to /studio; Studio takes it with `takeStudioReuseRequest()`,
 * which returns it once and clears it. It is plain, serialisable data. Every
 * field except `id`, `createdAt`, `sourcePath` and `prompt` may be missing
 * when the image carries no record of it; Studio keeps its own default then.
 */
export interface StudioReuseRequest {
  /** Unique per request, so a consumer can ignore one it already applied. */
  id: string
  /** ISO time the request was made. */
  createdAt: string
  /** The image the parameters come from. */
  sourcePath: string
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  seed?: number
  steps?: number
  cfg?: number
  /** Catalog bundle id of the model that made the image (`ModelBundle.id`). */
  modelBundleId?: string
  /** Display name of that model, for messages when the bundle is not installed. */
  modelName?: string
  adapters?: Array<{ path: string; strength: number }>
  /** Sampler, scheduler and 高清修复 the image was made with (width/height above are then the first pass). */
  sampling?: JobSampling
  /** Studio project the image was generated for, if known. */
  projectId?: string
  /** 'start': put the image on the board and start the new canvas from it. Absent = parameters only. */
  useAs?: 'start'
}

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

/** Builds the handoff for one image. Generation details win over loose metadata. */
export function buildReuseRequest(
  detail: GalleryDetail,
  options: { id?: string; now?: Date; useAs?: 'start' } = {},
): StudioReuseRequest {
  const generation: GalleryGeneration & { baseWidth?: number; baseHeight?: number } = detail.generation ?? {}
  const seed = generation.seed ?? (typeof detail.seed === 'number' ? detail.seed : undefined)
  // A 高清修复 picture records its output size as width/height and the first pass as base*.
  const sampling = generation.sampling && Object.keys(generation.sampling).length ? structuredClone(generation.sampling) : undefined
  return compact({
    id: options.id ?? crypto.randomUUID(),
    createdAt: (options.now ?? new Date()).toISOString(),
    sourcePath: detail.path,
    // The description the person wrote; never a compiled region layout.
    prompt: (generation.description ?? detail.prompt)?.trim() ?? '',
    negativePrompt: text(detail.negativePrompt),
    width: positiveInt(generation.baseWidth ?? generation.width ?? detail.width),
    height: positiveInt(generation.baseHeight ?? generation.height ?? detail.height),
    seed: Number.isInteger(seed) && (seed as number) >= 0 ? seed : undefined,
    steps: positiveInt(generation.steps),
    cfg: finite(generation.cfg),
    modelBundleId: text(generation.modelBundleId),
    modelName: text(generation.modelName),
    adapters: generation.adapters?.length ? generation.adapters.map((item) => ({ ...item })) : undefined,
    sampling,
    projectId: text(generation.projectId ?? detail.projectId),
    useAs: options.useAs,
  })
}

/**
 * 用作起始图: start a new canvas from the picture. The seed is not carried over
 * (a start picture is meant to be varied), the description is; the canvas is
 * the picture's own size, without another 高清修复 pass on top.
 */
export function buildStartPictureRequest(
  detail: GalleryDetail,
  options: { id?: string; now?: Date } = {},
): StudioReuseRequest {
  const full = buildReuseRequest(detail, { ...options, useAs: 'start' })
  delete full.seed
  const width = positiveInt(detail.generation?.width ?? detail.width)
  const height = positiveInt(detail.generation?.height ?? detail.height)
  if (width) full.width = width
  if (height) full.height = height
  if (full.sampling) {
    const { hires: _hires, ...rest } = full.sampling
    if (Object.keys(rest).length) full.sampling = rest
    else delete full.sampling
  }
  return full
}

/** Whether an image has anything worth reusing. */
export function canReuse(detail: GalleryDetail | null): boolean {
  return Boolean(detail && (detail.prompt?.trim() || detail.generation))
}

/** Defensive check for consumers: true only for a well-formed request. */
export function isStudioReuseRequest(value: unknown): value is StudioReuseRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  if (typeof request['id'] !== 'string' || !request['id']) return false
  if (typeof request['createdAt'] !== 'string') return false
  if (typeof request['sourcePath'] !== 'string') return false
  if (typeof request['prompt'] !== 'string') return false
  if (request['useAs'] !== undefined && request['useAs'] !== 'start') return false
  if (request['sampling'] !== undefined && (!request['sampling'] || typeof request['sampling'] !== 'object' || Array.isArray(request['sampling']))) return false
  for (const key of ['width', 'height', 'seed', 'steps', 'cfg'] as const) {
    if (request[key] !== undefined && finite(request[key]) === undefined) return false
  }
  if (request['adapters'] !== undefined) {
    if (!Array.isArray(request['adapters'])) return false
    for (const item of request['adapters'] as unknown[]) {
      if (!item || typeof item !== 'object') return false
      if (typeof (item as Record<string, unknown>)['path'] !== 'string') return false
      if (finite((item as Record<string, unknown>)['strength']) === undefined) return false
    }
  }
  return true
}
