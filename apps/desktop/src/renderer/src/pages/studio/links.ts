import type { CanvasImageLink, CanvasInputs, ProjectCanvas } from '@shared/types'

/**
 * Pure helpers for the pictures a canvas takes in. Every input is a link to
 * another canvas on the board (drawn as a wire). Shared by the inspector and
 * the board; every edit returns new objects.
 */

/** How a link feeds a canvas: a picture (start, control, reference), or a 风格 node's description and LoRA. */
export type LinkRole = 'init' | 'control' | 'reference' | 'style'

export interface CanvasLinkEntry {
  role: LinkRole
  /** Control kind, for `role: 'control'`. */
  kind?: string
  /** Position in the reference (or 风格) list, for `role: 'reference'` / `'style'`. */
  index?: number
  link: CanvasImageLink
  /** Short chip text, e.g. "起始图 60%", "控制 · 深度", "参考 2". */
  label: string
}

export const DEFAULT_INIT_STRENGTH = 0.6
export const DEFAULT_CONTROL_STRENGTH = 1
export const MAX_REFERENCES = 4
/** 风格 nodes one canvas can take. */
export const MAX_STYLES = 3

const CONTROL_KIND_LABELS: Record<string, string> = {
  depth: '深度',
  canny: '边缘',
  pose: '姿态',
}

/** Plain name of a control kind; unknown kinds are shown as the engine names them. */
export function controlKindLabel(kind: string): string {
  return CONTROL_KIND_LABELS[kind] ?? kind
}

export function roleLabel(role: LinkRole): string {
  return role === 'init' ? '起始图' : role === 'control' ? '控制图' : role === 'style' ? '风格' : '参考图'
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Every link of a canvas, in port order: start picture, control images, references. */
export function linksOf(canvas: Pick<ProjectCanvas, 'inputs'>): CanvasLinkEntry[] {
  const inputs = canvas.inputs
  if (!inputs) return []
  const entries: CanvasLinkEntry[] = []
  if (inputs.init) entries.push({ role: 'init', link: inputs.init.link, label: `起始图 ${percent(inputs.init.strength)}` })
  for (const image of inputs.control?.images ?? []) {
    entries.push({ role: 'control', kind: image.kind, link: image.link, label: `控制 · ${controlKindLabel(image.kind)}` })
  }
  ;(inputs.references?.links ?? []).forEach((link, index) => {
    entries.push({ role: 'reference', index, link, label: `参考 ${index + 1}` })
  })
  ;(inputs.styles?.links ?? []).forEach((link, index) => {
    entries.push({ role: 'style', index, link, label: `风格 ${index + 1}` })
  })
  return entries
}

export function linkSourceCanvas(link: CanvasImageLink, canvases: readonly ProjectCanvas[]): ProjectCanvas | undefined {
  return canvases.find((item) => item.id === link.canvasId)
}

/** The picture a canvas offers to others: an image node's file, or a generated output. */
export function canvasPicture(canvas: ProjectCanvas, output?: number): string | null {
  if (canvas.kind === 'image') return canvas.imagePath || null
  const outputs = canvas.outputs ?? []
  return outputs[output ?? 0]?.path ?? outputs[0]?.path ?? null
}

/** Path of the picture a link points at, or null while the source has none (or is gone). */
export function linkSourceImage(link: CanvasImageLink, canvases: readonly ProjectCanvas[]): string | null {
  const source = linkSourceCanvas(link, canvases)
  return source ? canvasPicture(source, link.output) : null
}

function sameLink(a: CanvasImageLink, b: CanvasImageLink): boolean {
  return a.canvasId === b.canvasId && (a.output ?? 0) === (b.output ?? 0)
}

function withInputs(canvas: ProjectCanvas, inputs: CanvasInputs): ProjectCanvas {
  const empty = !inputs.init && !inputs.mask && !inputs.control && !inputs.references && !inputs.styles
  if (empty) {
    const { inputs: _drop, ...rest } = canvas
    return rest
  }
  return { ...canvas, inputs }
}

/** True when `source` would feed itself, directly or through other links. */
export function wouldCycle(target: ProjectCanvas, sourceId: string, canvases: readonly ProjectCanvas[]): boolean {
  const seen = new Set<string>()
  const stack = [sourceId]
  while (stack.length) {
    const id = stack.pop() as string
    if (id === target.id) return true
    if (seen.has(id)) continue
    seen.add(id)
    const node = canvases.find((item) => item.id === id)
    // Result and picture cards are finished pictures; their recorded inputs feed nothing any more.
    if (node?.kind === 'layout') for (const entry of linksOf(node)) stack.push(entry.link.canvasId)
  }
  return false
}

/**
 * Link a picture into a role. `init` replaces the start picture (keeping its
 * strength), `control` sets the image for `kind` (needs `kind`), `reference`
 * appends unless already linked or MAX_REFERENCES are linked. A canvas never
 * links to itself.
 */
export function setLink(canvas: ProjectCanvas, role: LinkRole, link: CanvasImageLink, kind?: string): ProjectCanvas {
  if (link.canvasId === canvas.id) return canvas
  const inputs: CanvasInputs = { ...canvas.inputs }
  if (role === 'init') {
    const previous = inputs.init
    const changedSource = previous && !sameLink(previous.link, link)
    inputs.init = {
      link: { ...link },
      strength: previous?.strength ?? DEFAULT_INIT_STRENGTH,
      ...(previous?.resize ? { resize: previous.resize } : {}),
    }
    // A mask is painted over one particular start picture.
    if (changedSource) delete inputs.mask
    return withInputs(canvas, inputs)
  }
  if (role === 'control') {
    if (!kind) return canvas
    const control = inputs.control ?? { adapterId: '', images: [] }
    const existing = control.images.find((image) => image.kind === kind)
    const image = existing
      ? { ...existing, link: { ...link } }
      : { kind, link: { ...link }, strength: DEFAULT_CONTROL_STRENGTH, start: 0, end: 1 }
    const images = existing ? control.images.map((item) => (item.kind === kind ? image : item)) : [...control.images, image]
    inputs.control = { ...control, images }
    return withInputs(canvas, inputs)
  }
  if (role === 'style') {
    const styles = inputs.styles?.links ?? []
    if (styles.some((item) => item.canvasId === link.canvasId) || styles.length >= MAX_STYLES) return canvas
    inputs.styles = { links: [...styles, { canvasId: link.canvasId }] }
    return withInputs(canvas, inputs)
  }
  const references = inputs.references ?? { links: [] }
  if (references.links.some((item) => sameLink(item, link)) || references.links.length >= MAX_REFERENCES) return canvas
  inputs.references = { ...references, links: [...references.links, { ...link }] }
  return withInputs(canvas, inputs)
}

/**
 * Remove one link: the start picture (and the mask painted over it), the
 * control image of a kind (or at an index), or the reference at an index.
 * The chosen control adapter stays when its last image is removed.
 */
export function removeLink(canvas: ProjectCanvas, role: LinkRole, which?: number | string): ProjectCanvas {
  if (!canvas.inputs) return canvas
  const inputs: CanvasInputs = { ...canvas.inputs }
  if (role === 'init') {
    if (!inputs.init) return canvas
    delete inputs.init
    delete inputs.mask
    return withInputs(canvas, inputs)
  }
  if (role === 'control') {
    const control = inputs.control
    if (!control) return canvas
    const images = control.images.filter((image, index) => (typeof which === 'number' ? index !== which : image.kind !== which))
    if (images.length === control.images.length) return canvas
    inputs.control = { ...control, images }
    return withInputs(canvas, inputs)
  }
  if (role === 'style') {
    const styles = inputs.styles?.links ?? []
    if (typeof which !== 'number' || which < 0 || which >= styles.length) return canvas
    const links = styles.filter((_, index) => index !== which)
    if (links.length) inputs.styles = { links }
    else delete inputs.styles
    return withInputs(canvas, inputs)
  }
  const references = inputs.references
  if (!references || typeof which !== 'number' || which < 0 || which >= references.links.length) return canvas
  const links = references.links.filter((_, index) => index !== which)
  if (links.length || references.maxEdge !== undefined) inputs.references = { ...references, links }
  else delete inputs.references
  return withInputs(canvas, inputs)
}

/** Remove every link that points at `canvasId` from one canvas; returns how many went. */
export function dropLinksFrom(canvas: ProjectCanvas, canvasId: string): { canvas: ProjectCanvas; removed: number } {
  let next = canvas
  let removed = 0
  for (const entry of linksOf(canvas).reverse()) {
    if (entry.link.canvasId !== canvasId) continue
    next = removeLink(next, entry.role, entry.role === 'control' ? entry.kind : entry.index)
    removed += 1
  }
  return { canvas: next, removed }
}

/**
 * After deleting a canvas: drop the links that pointed at it, and count them
 * for the toast. Result cards keep their recorded inputs (they are the frozen
 * parameters of a run, never drawn as wires); running one again then says its
 * source is gone instead of quietly generating without it.
 */
export function dropLinksTo(canvases: readonly ProjectCanvas[], deletedId: string): { canvases: ProjectCanvas[]; removed: number } {
  let removed = 0
  const next = canvases.map((canvas) => {
    if (canvas.kind === 'result') return canvas
    const result = dropLinksFrom(canvas, deletedId)
    removed += result.removed
    return result.canvas
  })
  return { canvases: next, removed }
}

/** Which canvases point at `canvasId` (consumers of its picture). */
export function consumersOf(canvases: readonly ProjectCanvas[], canvasId: string): ProjectCanvas[] {
  return canvases.filter((canvas) => linksOf(canvas).some((entry) => entry.link.canvasId === canvasId))
}

/* ------------------------------------------------------------------ */
/* Editing an input's settings (the inspector)                         */
/* ------------------------------------------------------------------ */

/** The input slot the board's pick mode fills: the next card clicked becomes this link. */
export interface PickTarget {
  canvasId: string
  role: LinkRole
  /** Control kind, for `role: 'control'`. */
  kind?: string
}

type InitInput = NonNullable<CanvasInputs['init']>
type ControlImage = NonNullable<CanvasInputs['control']>['images'][number]

export function patchInit(canvas: ProjectCanvas, patch: Partial<Pick<InitInput, 'strength' | 'resize'>>): ProjectCanvas {
  const init = canvas.inputs?.init
  if (!init) return canvas
  const next: InitInput = { ...init, ...patch }
  if (next.resize === undefined) delete next.resize
  return { ...canvas, inputs: { ...canvas.inputs, init: next } }
}

/**
 * Choose the control adapter; images already linked stay (a kind the new one
 * lacks is reported before 生成). No adapter ('') turns control off, images included.
 */
export function setControlAdapter(canvas: ProjectCanvas, adapterId: string): ProjectCanvas {
  const control = canvas.inputs?.control
  if (!adapterId) {
    if (!control) return canvas
    const inputs: CanvasInputs = { ...canvas.inputs }
    delete inputs.control
    return withInputs(canvas, inputs)
  }
  return { ...canvas, inputs: { ...canvas.inputs, control: { ...(control ?? { images: [] }), adapterId } } }
}

export function patchControl(canvas: ProjectCanvas, patch: { loraStrength?: number }): ProjectCanvas {
  const control = canvas.inputs?.control
  if (!control) return canvas
  const next = { ...control, ...patch }
  if (next.loraStrength === undefined) delete next.loraStrength
  return { ...canvas, inputs: { ...canvas.inputs, control: next } }
}

export function patchControlImage(
  canvas: ProjectCanvas,
  kind: string,
  patch: Partial<Pick<ControlImage, 'strength' | 'start' | 'end'>>,
): ProjectCanvas {
  const control = canvas.inputs?.control
  if (!control?.images.some((image) => image.kind === kind)) return canvas
  const images = control.images.map((image) => {
    if (image.kind !== kind) return image
    const next = { ...image, ...patch }
    // 0 ≤ start ≤ end ≤ 1: moving one end pushes the other.
    if (patch.start !== undefined && next.end < next.start) next.end = next.start
    if (patch.end !== undefined && next.start > next.end) next.start = next.end
    return next
  })
  return { ...canvas, inputs: { ...canvas.inputs, control: { ...control, images } } }
}

export function patchReferences(canvas: ProjectCanvas, patch: { maxEdge?: number }): ProjectCanvas {
  const references = canvas.inputs?.references
  if (!references) return canvas
  const next = { ...references, ...patch }
  if (next.maxEdge === undefined) delete next.maxEdge
  return { ...canvas, inputs: { ...canvas.inputs, references: next } }
}
