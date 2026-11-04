import type { AdapterEntry, JobRecord, ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { clampBox } from '../../lib/layout'
import type { StudioReuseRequest } from '../../lib/studioReuse'
import { resultSpot, nextFreeSpot } from './board'
import { DEFAULT_NEGATIVE, DEFAULT_QUALITY, DEFAULT_SIZE, clampDimension, isSeedLocked, nextCanvasTitle, qualityPreset } from './defaults'

/** Pure canvas and region operations. Every edit returns new objects. */

export type CanvasSettings = Pick<
  ProjectCanvas,
  'width' | 'height' | 'negative' | 'seed' | 'seedLocked' | 'steps' | 'cfg' | 'modelBundleId' | 'deviceId' | 'deviceUuid' | 'adapters'
>

export function defaultSettings(): CanvasSettings {
  const quality = qualityPreset(DEFAULT_QUALITY)
  return {
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    negative: DEFAULT_NEGATIVE,
    seed: 0,
    seedLocked: false,
    steps: quality.steps,
    cfg: quality.cfg,
    adapters: [],
  }
}

/** Bring a canvas saved by an older version up to date (see `isSeedLocked`). */
export function migrateCanvas(canvas: ProjectCanvas): ProjectCanvas {
  if (canvas.seedLocked !== undefined) return canvas
  return { ...canvas, seedLocked: isSeedLocked(canvas) }
}

/** Settings a new canvas inherits, so a user's choices carry over to the next one. */
export function settingsFrom(canvas: ProjectCanvas | null | undefined): CanvasSettings {
  if (!canvas) return defaultSettings()
  return {
    width: canvas.width,
    height: canvas.height,
    negative: canvas.negative,
    seed: canvas.seed,
    seedLocked: isSeedLocked(canvas),
    steps: canvas.steps,
    cfg: canvas.cfg,
    modelBundleId: canvas.modelBundleId,
    deviceId: canvas.deviceId,
    deviceUuid: canvas.deviceUuid,
    adapters: normalizeCanvasAdapters(canvas.adapters),
  }
}

/** A blank layout canvas placed in the first free board slot. */
export function createLayoutCanvas(existing: readonly ProjectCanvas[], settings: CanvasSettings, id: string = crypto.randomUUID()): ProjectCanvas {
  const position = nextFreeSpot(existing, settings)
  return {
    id,
    kind: 'layout',
    title: nextCanvasTitle(existing.map((item) => item.title)),
    x: position.x,
    y: position.y,
    summary: { caption: '', meta: [], canvas: 'single' },
    layers: [],
    prompt: '',
    ...settings,
    modelBundleId: settings.modelBundleId || undefined,
    deviceId: settings.deviceId || undefined,
    deviceUuid: settings.deviceUuid || undefined,
  }
}

/** An editable copy of any canvas (layout or result), placed beside it. */
export function copyAsLayout(source: ProjectCanvas, existing: readonly ProjectCanvas[], id: string = crypto.randomUUID()): ProjectCanvas {
  const placed = createLayoutCanvas(existing, settingsFrom(source), id)
  return {
    ...placed,
    summary: structuredClone(source.summary),
    prompt: source.prompt,
    layers: source.layers.map((layer) => ({ ...layer, id: crypto.randomUUID() })),
    backgroundPath: source.backgroundPath,
  }
}

/**
 * The canvas a run writes into. A layout canvas with no picture yet renders its
 * first run in place; every later run gets its own result card under the
 * source, so earlier pictures are never overwritten.
 */
export function taskCanvasFor(
  source: ProjectCanvas,
  canvases: readonly ProjectCanvas[],
  id: string = crypto.randomUUID(),
): { canvases: ProjectCanvas[]; taskId: string } {
  const runInPlace = source.kind === 'layout' && (source.outputs?.length ?? 0) === 0
  const reset = { jobId: undefined, jobState: 'starting' as const, progress: undefined, outputs: [], error: undefined }
  if (runInPlace) {
    return {
      taskId: source.id,
      canvases: canvases.map((item) => item.id === source.id ? { ...source, ...reset } : item),
    }
  }
  const spot = resultSpot(source, canvases)
  const task: ProjectCanvas = {
    ...source,
    ...reset,
    id,
    kind: 'result',
    title: `${source.title} · 结果`,
    x: spot.x,
    y: spot.y,
    sourceCanvasId: source.id,
  }
  return { taskId: id, canvases: [...canvases, task] }
}

/** Copy job state, outputs and errors onto the canvases that track those jobs. */
export function applyJobs(canvases: ProjectCanvas[], jobs: readonly JobRecord[]): ProjectCanvas[] {
  let changed = false
  const next = canvases.map((canvas) => {
    if (!canvas.jobId) return canvas
    const job = jobs.find((item) => item.id === canvas.jobId)
    if (!job) return canvas
    const outputs = job.outputs ?? canvas.outputs ?? []
    const sameOutputs = outputs.length === (canvas.outputs?.length ?? 0)
      && outputs.every((output, index) => output.path === canvas.outputs?.[index]?.path)
    if (canvas.jobState === job.state && sameOutputs && canvas.error?.message === job.error?.message) return canvas
    changed = true
    return { ...canvas, jobState: job.state, outputs, error: job.error }
  })
  return changed ? next : canvases
}

/* ------------------------------------------------------------------ */
/* Regions                                                             */
/* ------------------------------------------------------------------ */

export const MIN_REGION = 12

export function newRegion(kind: ProjectLayerKind, bbox: [number, number, number, number], id: string = crypto.randomUUID()): ProjectLayer {
  return { id, kind, caption: '', text: kind === 'text' ? '' : undefined, bbox, visible: true, locked: false, opacity: 1 }
}

/** A drawn rectangle becomes a region only when it is big enough to be intentional. */
export function regionFromDrag(start: [number, number], end: [number, number], canvas: Pick<ProjectCanvas, 'width' | 'height'>): [number, number, number, number] | null {
  const box = clampBox(
    [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])],
    canvas.width,
    canvas.height,
  )
  return box[2] - box[0] >= MIN_REGION && box[3] - box[1] >= MIN_REGION ? box : null
}

export function moveBox(origin: [number, number, number, number], dx: number, dy: number, canvas: Pick<ProjectCanvas, 'width' | 'height'>): [number, number, number, number] {
  const [x1, y1, x2, y2] = origin
  const width = x2 - x1
  const height = y2 - y1
  const left = Math.round(Math.max(0, Math.min(canvas.width - width, x1 + dx)))
  const top = Math.round(Math.max(0, Math.min(canvas.height - height, y1 + dy)))
  return [left, top, left + width, top + height]
}

export function resizeBox(origin: [number, number, number, number], dx: number, dy: number, canvas: Pick<ProjectCanvas, 'width' | 'height'>): [number, number, number, number] {
  const [x1, y1, x2, y2] = origin
  return [
    x1,
    y1,
    Math.round(Math.max(x1 + MIN_REGION, Math.min(canvas.width, x2 + dx))),
    Math.round(Math.max(y1 + MIN_REGION, Math.min(canvas.height, y2 + dy))),
  ]
}

/** Move a region to another position in the list; list order is region numbering. */
export function reorderLayers(layers: readonly ProjectLayer[], fromId: string, toId: string): ProjectLayer[] {
  const from = layers.findIndex((layer) => layer.id === fromId)
  const to = layers.findIndex((layer) => layer.id === toId)
  if (from < 0 || to < 0 || from === to) return [...layers]
  const next = [...layers]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** Change the picture size and pull every region back inside it. */
export function resizeCanvas<T extends Pick<ProjectCanvas, 'width' | 'height' | 'layers'>>(canvas: T, width: number, height: number): T {
  return {
    ...canvas,
    width,
    height,
    layers: canvas.layers.map((layer) => ({ ...layer, bbox: clampBox(layer.bbox, width, height) })),
  }
}

/* ------------------------------------------------------------------ */
/* Reuse from 作品                                                      */
/* ------------------------------------------------------------------ */

/** Find the library LoRA a file path belongs to (by file name, then by id in the path). */
export function matchAdapterPath(path: string, catalog: readonly AdapterEntry[]): AdapterEntry | undefined {
  const parts = path.split(/[\\/]/).filter(Boolean)
  const base = parts[parts.length - 1]
  return catalog.find((entry) => entry.files.some((file) => file.split(/[\\/]/).pop() === base))
    ?? catalog.find((entry) => parts.includes(entry.id))
}

export interface ReuseResult {
  canvas: ProjectCanvas
  /** LoRA files of the source image that are not in the library. */
  missingAdapters: string[]
}

/**
 * A new editable canvas carrying an image's recorded parameters. The seed is
 * kept locked, so the first run reproduces the image the user picked.
 */
export function canvasFromReuse(
  request: StudioReuseRequest,
  existing: readonly ProjectCanvas[],
  base: CanvasSettings,
  adapterCatalog: readonly AdapterEntry[] = [],
  id: string = crypto.randomUUID(),
): ReuseResult {
  const missingAdapters: string[] = []
  const adapters = (request.adapters ?? []).flatMap((item) => {
    const entry = matchAdapterPath(item.path, adapterCatalog)
    if (!entry) {
      missingAdapters.push(item.path.split(/[\\/]/).pop() ?? item.path)
      return []
    }
    return [{ id: entry.id, strength: item.strength }]
  })
  const width = request.width ? clampDimension(request.width, base.width) : base.width
  const height = request.height ? clampDimension(request.height, base.height) : base.height
  const settings: CanvasSettings = {
    ...base,
    width,
    height,
    negative: request.negativePrompt ?? base.negative,
    seed: request.seed ?? base.seed,
    seedLocked: request.seed !== undefined ? true : base.seedLocked,
    steps: request.steps ?? base.steps,
    cfg: request.cfg ?? base.cfg,
    modelBundleId: request.modelBundleId ?? base.modelBundleId,
    adapters: normalizeCanvasAdapters(adapters),
  }
  const canvas = createLayoutCanvas(existing, settings, id)
  return { canvas: { ...canvas, prompt: request.prompt, summary: { ...canvas.summary, caption: request.prompt } }, missingAdapters }
}
