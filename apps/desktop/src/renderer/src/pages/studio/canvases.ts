import type { AdapterEntry, CanvasInputs, JobRecord, ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { clampBox } from '../../lib/layout'
import type { SceneDraft } from '../../lib/agent/types'
import type { StudioReuseRequest } from '../../lib/studioReuse'
import { BOARD_GAP, cardRect, cardWidth, imageNodeSize, resultSpot, nextFreeSpot } from './boardLayout'
import { DEFAULT_NEGATIVE, DEFAULT_QUALITY, DEFAULT_SIZE, clampDimension, isSeedLocked, nextCanvasTitle, qualityPreset } from './defaults'
import { DEFAULT_INIT_STRENGTH, dropLinksTo, linksOf } from './links'
import { cleanSampling, generationSize, outputSize, scaleHires } from './sampling'

/** Pure canvas and region operations. Every edit returns new objects. */

export type CanvasSettings = Pick<
  ProjectCanvas,
  | 'width'
  | 'height'
  | 'negative'
  | 'seed'
  | 'seedLocked'
  | 'steps'
  | 'cfg'
  | 'modelBundleId'
  | 'deviceId'
  | 'deviceUuid'
  | 'adapters'
  | 'sampling'
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

const unit = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback

/** Inputs as saved, with out-of-range numbers pulled back and a mask without a start picture dropped. */
function migrateInputs(inputs: CanvasInputs): CanvasInputs | undefined {
  const next: CanvasInputs = {}
  if (inputs.init?.link?.canvasId) next.init = { ...inputs.init, strength: unit(inputs.init.strength, DEFAULT_INIT_STRENGTH) }
  if (next.init && inputs.mask?.path) next.mask = inputs.mask
  if (inputs.control) {
    const images = (inputs.control.images ?? [])
      .filter((image) => image?.kind && image.link?.canvasId)
      .map((image) => {
        const start = unit(image.start, 0)
        return {
          ...image,
          strength: typeof image.strength === 'number' && Number.isFinite(image.strength) ? Math.min(10, Math.max(0, image.strength)) : 1,
          start,
          end: Math.max(start, unit(image.end, 1)),
        }
      })
    next.control = { ...inputs.control, adapterId: inputs.control.adapterId ?? '', images }
  }
  if (inputs.references?.links?.length)
    next.references = { ...inputs.references, links: inputs.references.links.filter((link) => link?.canvasId) }
  return next.init || next.control || next.references ? next : undefined
}

/** Bring a canvas saved by an older version up to date (see `isSeedLocked`). */
export function migrateCanvas(canvas: ProjectCanvas): ProjectCanvas {
  let next = canvas.seedLocked !== undefined ? canvas : { ...canvas, seedLocked: isSeedLocked(canvas) }
  if (next.inputs) {
    const inputs = migrateInputs(next.inputs)
    next = { ...next, inputs }
    if (!inputs) delete next.inputs
  }
  if (next.sampling) {
    const sampling = cleanSampling(next.sampling)
    next = { ...next, sampling }
    if (!sampling) delete next.sampling
  }
  return next
}

/** A whole project's canvases on load: each migrated, and links to canvases that no longer exist dropped. */
export function migrateCanvases(canvases: readonly ProjectCanvas[]): ProjectCanvas[] {
  let list = canvases.map(migrateCanvas)
  const ids = new Set(list.map((canvas) => canvas.id))
  const dangling = new Set(list.flatMap((canvas) => linksOf(canvas).map((entry) => entry.link.canvasId)).filter((id) => !ids.has(id)))
  for (const id of dangling) list = dropLinksTo(list, id).canvases
  return list
}

/** Settings a new canvas inherits, so a user's choices carry over to the next one. */
export function settingsFrom(canvas: ProjectCanvas | null | undefined): CanvasSettings {
  if (!canvas || canvas.kind === 'image') return defaultSettings()
  const size = generationSize(canvas)
  // Sampler choices carry over; the costly second pass is turned on per canvas.
  const sampling = cleanSampling({ ...canvas.sampling, hires: undefined })
  return {
    width: size.width,
    height: size.height,
    ...(sampling ? { sampling } : {}),
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
export function createLayoutCanvas(
  existing: readonly ProjectCanvas[],
  settings: CanvasSettings,
  id: string = crypto.randomUUID(),
): ProjectCanvas {
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

/**
 * An editable copy of any canvas (layout or result), placed beside it. It
 * keeps the source's pictures: its links still point at the same canvases. A
 * copied picture card is another picture card.
 */
export function copyAsLayout(source: ProjectCanvas, existing: readonly ProjectCanvas[], id: string = crypto.randomUUID()): ProjectCanvas {
  if (source.kind === 'image' && source.imagePath) {
    const pixels = source.imageSize ?? { width: source.width, height: source.height }
    return createImageCanvas(existing, { path: source.imagePath, ...pixels }, undefined, id, source.title)
  }
  const placed = createLayoutCanvas(existing, settingsFrom(source), id)
  const copy: ProjectCanvas = {
    ...placed,
    summary: structuredClone(source.summary),
    prompt: source.prompt,
    layers: source.layers.map((layer) => ({ ...layer, id: crypto.randomUUID() })),
    backgroundPath: source.backgroundPath,
  }
  if (source.inputs) copy.inputs = structuredClone(source.inputs)
  if (source.sampling) copy.sampling = structuredClone(source.sampling)
  return copy
}

function fileTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.[^.]+$/, '') || '图片'
}

/**
 * A picture card for an imported file (`picture` carries its pixel size). Placed to the left of `near` (the
 * canvas it feeds) when that spot is free, otherwise in the first free slot.
 */
export function createImageCanvas(
  existing: readonly ProjectCanvas[],
  picture: { path: string; width: number; height: number },
  near?: Pick<ProjectCanvas, 'x' | 'y' | 'width' | 'height'>,
  id: string = crypto.randomUUID(),
  title: string = fileTitle(picture.path),
): ProjectCanvas {
  const size = imageNodeSize(picture)
  let position = nextFreeSpot(existing, size)
  if (near) {
    const taken = existing.map(cardRect)
    const w = cardWidth(size)
    const rect = { x: near.x - w - BOARD_GAP * 2, y: near.y, w, h: cardRect({ x: 0, y: 0, ...size }).h }
    for (let guard = 0; guard < 200; guard += 1) {
      const clash = taken.some(
        (item) => rect.x < item.x + item.w && rect.x + rect.w > item.x && rect.y < item.y + item.h && rect.y + rect.h > item.y,
      )
      if (!clash) break
      rect.y += rect.h + BOARD_GAP
    }
    position = { x: Math.round(rect.x), y: Math.round(rect.y) }
  }
  return {
    id,
    kind: 'image',
    imagePath: picture.path,
    // The picture's real pixels (a mask must match them); width/height are the card size.
    ...(picture.width > 0 && picture.height > 0
      ? { imageSize: { width: Math.round(picture.width), height: Math.round(picture.height) } }
      : {}),
    title,
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    summary: { caption: '', meta: [], canvas: 'single' },
    layers: [],
    prompt: '',
    negative: '',
    seed: 0,
    steps: 1,
    cfg: 0,
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
      canvases: canvases.map((item) => (item.id === source.id ? { ...source, ...reset } : item)),
    }
  }
  // A 高清修复 run's card is the size of the finished picture; the first-pass
  // size is kept so running it again repeats the same job.
  const base = generationSize(source)
  const output = outputSize(source)
  const resized = output.width !== base.width || output.height !== base.height
  const spot = resultSpot(source, canvases)
  const task: ProjectCanvas = {
    ...source,
    ...reset,
    id,
    kind: 'result',
    title: `${source.title} · 结果`,
    x: spot.x,
    y: spot.y,
    width: output.width,
    height: output.height,
    sourceCanvasId: source.id,
  }
  if (resized) task.baseSize = base
  else delete task.baseSize
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
    const sameOutputs =
      outputs.length === (canvas.outputs?.length ?? 0) && outputs.every((output, index) => output.path === canvas.outputs?.[index]?.path)
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

export function newRegion(
  kind: ProjectLayerKind,
  bbox: [number, number, number, number],
  id: string = crypto.randomUUID(),
  text?: string,
): ProjectLayer {
  return { id, kind, caption: '', text: kind === 'text' ? (text ?? '') : undefined, bbox, visible: true, locked: false, opacity: 1 }
}

/** A region to add: a normalised box (omitted puts it in the middle) and its two strings. */
export interface RegionInput {
  kind: ProjectLayerKind
  caption: string
  /** Only text regions carry words. */
  text?: string
  bbox?: { x: number; y: number; w: number; h: number }
}

/**
 * Add one region to a canvas and return both the new canvas and the region.
 * The box arrives normalised (as the tools take it) and leaves in pixels,
 * pulled back inside the picture.
 */
export function addRegion(canvas: ProjectCanvas, input: RegionInput): { canvas: ProjectCanvas; region: ProjectLayer } {
  const { width, height } = canvas
  const box = input.bbox
    ? clampBox(
        [input.bbox.x * width, input.bbox.y * height, (input.bbox.x + input.bbox.w) * width, (input.bbox.y + input.bbox.h) * height],
        width,
        height,
      )
    : clampBox([width * 0.2, height * 0.2, width * 0.8, height * 0.8], width, height)
  const region = { ...newRegion(input.kind, box, crypto.randomUUID(), input.text), caption: input.caption }
  return { canvas: { ...canvas, layers: [...canvas.layers, region] }, region }
}

/**
 * One canvas of a set, ready to add: its own size, description, regions and
 * words, placed where the board has room for it.
 */
export function sceneCanvas(
  scene: SceneDraft,
  existing: readonly ProjectCanvas[],
  settings: CanvasSettings,
  id: string = crypto.randomUUID(),
): ProjectCanvas {
  const placed = createLayoutCanvas(
    existing,
    {
      ...settings,
      width: clampDimension(scene.width ?? settings.width, settings.width),
      height: clampDimension(scene.height ?? settings.height, settings.height),
    },
    id,
  )
  let canvas: ProjectCanvas = {
    ...placed,
    title: scene.title.trim(),
    prompt: scene.prompt.trim(),
    summary: { ...placed.summary, caption: scene.prompt.trim() },
  }
  for (const region of scene.regions ?? []) {
    canvas = addRegion(canvas, { kind: region.label, caption: region.caption, bbox: region.bbox }).canvas
  }
  for (const text of scene.texts ?? []) {
    canvas = addRegion(canvas, { kind: 'text', caption: text.caption, text: text.text, bbox: text.bbox }).canvas
  }
  return canvas
}

/** Fields a region edit may carry; the box is already in canvas pixels. */
export interface LayerEdit {
  caption?: string
  text?: string
  bbox?: [number, number, number, number]
  visible?: boolean
  opacity?: number
}

/**
 * Apply an edit to one region. Only text regions keep a `text`, and an edited
 * box is pulled back inside the canvas, so a tool cannot move a region out of
 * the picture.
 */
export function editLayer(layer: ProjectLayer, edit: LayerEdit, size: Pick<ProjectCanvas, 'width' | 'height'>): ProjectLayer {
  const next: ProjectLayer = { ...layer }
  if (edit.caption !== undefined) next.caption = edit.caption
  if (edit.text !== undefined && next.kind === 'text') next.text = edit.text
  if (edit.visible !== undefined) next.visible = edit.visible
  if (edit.opacity !== undefined) next.opacity = Math.min(1, Math.max(0.1, edit.opacity))
  if (edit.bbox) next.bbox = clampBox(edit.bbox, size.width, size.height)
  return next
}

/** A drawn rectangle becomes a region only when it is big enough to be intentional. */
export function regionFromDrag(
  start: [number, number],
  end: [number, number],
  canvas: Pick<ProjectCanvas, 'width' | 'height'>,
): [number, number, number, number] | null {
  const box = clampBox(
    [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])],
    canvas.width,
    canvas.height,
  )
  return box[2] - box[0] >= MIN_REGION && box[3] - box[1] >= MIN_REGION ? box : null
}

export function moveBox(
  origin: [number, number, number, number],
  dx: number,
  dy: number,
  canvas: Pick<ProjectCanvas, 'width' | 'height'>,
): [number, number, number, number] {
  const [x1, y1, x2, y2] = origin
  const width = x2 - x1
  const height = y2 - y1
  const left = Math.round(Math.max(0, Math.min(canvas.width - width, x1 + dx)))
  const top = Math.round(Math.max(0, Math.min(canvas.height - height, y1 + dy)))
  return [left, top, left + width, top + height]
}

export function resizeBox(
  origin: [number, number, number, number],
  dx: number,
  dy: number,
  canvas: Pick<ProjectCanvas, 'width' | 'height'>,
): [number, number, number, number] {
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

/** Change the picture size, pull every region back inside it and keep a 高清修复 target in proportion. */
export function resizeCanvas<T extends Pick<ProjectCanvas, 'width' | 'height' | 'layers'> & { sampling?: ProjectCanvas['sampling'] }>(
  canvas: T,
  width: number,
  height: number,
): T {
  const next = {
    ...canvas,
    width,
    height,
    layers: canvas.layers.map((layer) => ({ ...layer, bbox: clampBox(layer.bbox, width, height) })),
  }
  if (canvas.sampling?.hires) next.sampling = scaleHires(canvas.sampling, canvas, { width, height })
  return next
}

/** After deleting a canvas: the remaining canvases without links to it, and how many links went. */
export function removeCanvasFrom(canvases: readonly ProjectCanvas[], id: string): { canvases: ProjectCanvas[]; removedLinks: number } {
  const { canvases: next, removed } = dropLinksTo(
    canvases.filter((canvas) => canvas.id !== id),
    id,
  )
  return { canvases: next, removedLinks: removed }
}

/* ------------------------------------------------------------------ */
/* Reuse from 作品                                                      */
/* ------------------------------------------------------------------ */

/** Find the library LoRA a file path belongs to (by file name, then by id in the path). */
export function matchAdapterPath(path: string, catalog: readonly AdapterEntry[]): AdapterEntry | undefined {
  const parts = path.split(/[\\/]/).filter(Boolean)
  const base = parts[parts.length - 1]
  return (
    catalog.find((entry) => entry.files.some((file) => file.split(/[\\/]/).pop() === base)) ??
    catalog.find((entry) => parts.includes(entry.id))
  )
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
  // The image's sampler and 高清修复 come with it, so reuse reproduces the picture.
  const sampling = request.sampling ? cleanSampling(structuredClone(request.sampling)) : base.sampling
  if (sampling) settings.sampling = sampling
  else delete settings.sampling
  const canvas = createLayoutCanvas(existing, settings, id)
  return { canvas: { ...canvas, prompt: request.prompt, summary: { ...canvas.summary, caption: request.prompt } }, missingAdapters }
}
