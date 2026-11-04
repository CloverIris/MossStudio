import type { GalleryDetail } from '@shared/types'

/**
 * Library → Studio handoff: "在创作中复用" asks Studio to open a NEW canvas
 * prefilled with an image's parameters.
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
  /** Studio project the image was generated for, if known. */
  projectId?: string
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
  options: { id?: string; now?: Date } = {},
): StudioReuseRequest {
  const generation = detail.generation ?? {}
  const seed = generation.seed ?? (typeof detail.seed === 'number' ? detail.seed : undefined)
  return compact({
    id: options.id ?? crypto.randomUUID(),
    createdAt: (options.now ?? new Date()).toISOString(),
    sourcePath: detail.path,
    // The description the person wrote; never a compiled region layout.
    prompt: (generation.description ?? detail.prompt)?.trim() ?? '',
    negativePrompt: text(detail.negativePrompt),
    width: positiveInt(generation.width ?? detail.width),
    height: positiveInt(generation.height ?? detail.height),
    seed: Number.isInteger(seed) && (seed as number) >= 0 ? seed : undefined,
    steps: positiveInt(generation.steps),
    cfg: finite(generation.cfg),
    modelBundleId: text(generation.modelBundleId),
    modelName: text(generation.modelName),
    adapters: generation.adapters?.length ? generation.adapters.map((item) => ({ ...item })) : undefined,
    projectId: text(generation.projectId ?? detail.projectId),
  })
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
