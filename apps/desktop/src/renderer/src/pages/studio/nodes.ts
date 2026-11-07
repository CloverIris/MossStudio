import type { CanvasImageLink, ProjectCanvas } from '@shared/types'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { nextFreeSpot } from './boardLayout'
import { createLayoutCanvas, settingsFrom, type CanvasSettings } from './canvases'
import { MAX_DIMENSION, MIN_DIMENSION, DIMENSION_STEP, nextNodeTitle } from './defaults'
import { linkSourceCanvas, setLink } from './links'
import { canvasDescription, withDescription } from './prompt'
import type { Blocker } from './readiness'
import { boardCanvases, givesPicture, pictureLink, pinRun, spotBeside } from './runs'

/**
 * The 风格 and 放大 nodes. A 风格 (`kind: 'style'`) holds a description and
 * LoRA; every 画面 wired to it generates with them, so a series stays
 * consistent and is changed in one place. A 放大 is a 画面 with `upscale`:
 * it redraws its start picture (原图) larger, at a low strength. The engine
 * has no separate upscaler; this is the same redraw 高清修复 does. Pure, no React.
 */

/** A 风格 card's size on the board (canvas pixels: a 256 × 128 card). */
export const STYLE_CARD = { width: 1024, height: 512 } as const

export const UPSCALE_SCALES = [1.5, 2] as const

/** How much a 放大 redraws: the start picture's strength (0 keeps it, 1 replaces it). */
export const UPSCALE_DETAIL = [
  { id: 'keep', label: '贴近原图', strength: 0.25 },
  { id: 'balanced', label: '适中', strength: 0.4 },
  { id: 'more', label: '更多细节', strength: 0.55 },
] as const
export const UPSCALE_DETAIL_DEFAULT = 0.4

/** What a 放大 asks for when neither it nor its 原图 has a description. */
export const UPSCALE_FALLBACK_PROMPT = '高清，细节清晰，画质细腻'

/** The 风格 nodes a canvas is wired to, in order (missing ones skipped). */
export function stylesOf(canvas: Pick<ProjectCanvas, 'inputs'>, canvases: readonly ProjectCanvas[]): ProjectCanvas[] {
  return (canvas.inputs?.styles?.links ?? []).flatMap((link) => {
    const style = canvases.find((item) => item.id === link.canvasId)
    return style?.kind === 'style' ? [style] : []
  })
}

/** The canvases wired to a 风格. */
export function styleUsers(styleId: string, canvases: readonly ProjectCanvas[]): ProjectCanvas[] {
  return canvases.filter((canvas) => canvas.kind === 'layout' && canvas.inputs?.styles?.links.some((link) => link.canvasId === styleId))
}

/** The pixel size of the picture a link points at, when known. */
export function pictureSize(canvases: readonly ProjectCanvas[], link: CanvasImageLink): { width: number; height: number } | null {
  const source = linkSourceCanvas(link, canvases)
  if (!source) return null
  if (source.kind === 'image') return source.imageSize ?? { width: source.width, height: source.height }
  const outputs = source.outputs ?? []
  const output = outputs[link.output ?? 0] ?? outputs[0]
  return output ? { width: output.width, height: output.height } : null
}

const step = (value: number): number => Math.max(MIN_DIMENSION, Math.round(value / DIMENSION_STEP) * DIMENSION_STEP)

/** A 放大's size: `scale` times the 原图, the long edge kept within MAX_DIMENSION, on the engine's grid. */
export function upscaleSize(size: { width: number; height: number }, scale: number): { width: number; height: number } {
  const width = size.width * scale
  const height = size.height * scale
  const fit = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  return { width: Math.min(MAX_DIMENSION, step(width * fit)), height: Math.min(MAX_DIMENSION, step(height * fit)) }
}

/** A 放大 sized from its 原图 (unchanged when the 原图 or its size is not known yet). */
export function withUpscaleSize(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[]): ProjectCanvas {
  const link = canvas.upscale ? canvas.inputs?.init?.link : undefined
  const size = link ? pictureSize(canvases, link) : null
  if (!canvas.upscale || !size) return canvas
  const target = upscaleSize(size, canvas.upscale.scale)
  return target.width === canvas.width && target.height === canvas.height ? canvas : { ...canvas, ...target }
}

/** Why a 放大 cannot run yet, beyond what every 画面 checks (resolveJobInputs). */
export function nodeBlockers(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[]): Blocker[] {
  if (!canvas.upscale) return []
  const link = canvas.inputs?.init?.link
  if (!link) return [{ id: 'input-invalid', message: '先给放大接一张原图' }]
  const size = pictureSize(canvases, link)
  if (size && Math.max(size.width, size.height) >= MAX_DIMENSION) {
    return [{ id: 'input-invalid', message: `原图已经有 ${MAX_DIMENSION} 像素宽，不能再放大了` }]
  }
  return []
}

/**
 * What a canvas generates with: its description followed by its 风格 nodes',
 * and its LoRA followed by theirs (one already on the canvas keeps its
 * strength). A 放大 without a description takes its 原图's, or a plain
 * "high definition" one, and is sized from its 原图.
 */
export function generationCanvas(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[]): ProjectCanvas {
  if (canvas.kind !== 'layout') return canvas
  let next = withUpscaleSize(canvas, canvases)
  if (next.upscale && !canvasDescription(next).trim()) {
    const link = next.inputs?.init?.link
    const source = link ? linkSourceCanvas(link, canvases) : undefined
    const inherited = source && source.kind !== 'image' && source.kind !== 'style' ? canvasDescription(source).trim() : ''
    next = withDescription(next, inherited || UPSCALE_FALLBACK_PROMPT)
  }
  const styles = stylesOf(next, canvases)
  if (!styles.length) return next
  const texts = styles.map((style) => style.prompt.trim()).filter(Boolean)
  if (texts.length) next = withDescription(next, [canvasDescription(next).trim(), ...texts].filter(Boolean).join('，'))
  const own = normalizeCanvasAdapters(next.adapters)
  const added = styles.flatMap((style) => normalizeCanvasAdapters(style.adapters))
  const merged = [...own]
  for (const adapter of added) if (!merged.some((item) => item.id === adapter.id)) merged.push(adapter)
  return { ...next, adapters: normalizeCanvasAdapters(merged) }
}

/** A new, empty 风格 node in the first free spot (or at `at`). */
export function createStyleCanvas(
  existing: readonly ProjectCanvas[],
  options: { at?: { x: number; y: number }; id?: string } = {},
): ProjectCanvas {
  const spot = options.at ?? nextFreeSpot(boardCanvases(existing), STYLE_CARD)
  return {
    id: options.id ?? crypto.randomUUID(),
    kind: 'style',
    title: nextNodeTitle(
      '风格',
      existing.map((item) => item.title),
    ),
    x: Math.round(spot.x),
    y: Math.round(spot.y),
    width: STYLE_CARD.width,
    height: STYLE_CARD.height,
    summary: { caption: '', meta: [], canvas: 'single' },
    layers: [],
    prompt: '',
    negative: '',
    seed: 0,
    steps: 1,
    cfg: 0,
    adapters: [],
  }
}

/**
 * 放大: a 放大 node to the right of a card (or at `at`), fed by its picture
 * (a 画面 gives the one on its face; a filmstrip run used so is pinned).
 * `fallback` = the settings a picture card's 放大 starts with.
 */
export function upscaleFromPicture(
  canvases: readonly ProjectCanvas[],
  sourceId: string,
  options: { fallback: CanvasSettings; at?: { x: number; y: number }; id?: string },
): { canvases: ProjectCanvas[]; created: ProjectCanvas } | null {
  const source = canvases.find((canvas) => canvas.id === sourceId)
  if (!source || !givesPicture(source, canvases)) return null
  const link = pictureLink(canvases, { canvasId: sourceId })
  const pinned = pinRun(canvases, link.canvasId)
  const settings = source.kind === 'image' ? options.fallback : settingsFrom(source)
  const base = createLayoutCanvas(pinned, { ...settings, sampling: undefined }, options.id)
  let created: ProjectCanvas = {
    ...base,
    title: nextNodeTitle(
      '放大',
      pinned.map((item) => item.title),
    ),
    upscale: { scale: 2 },
  }
  delete created.sampling
  created = setLink(created, 'init', link)
  created = {
    ...created,
    inputs: { ...created.inputs, init: { ...created.inputs!.init!, strength: UPSCALE_DETAIL_DEFAULT, resize: 'stretch' } },
  }
  created = withUpscaleSize(created, pinned)
  const spot = options.at ? { x: Math.round(options.at.x), y: Math.round(options.at.y) } : spotBeside(source, created, pinned)
  created = { ...created, x: spot.x, y: spot.y }
  return { canvases: [...pinned, created], created }
}

/** Set a 放大's scale (its size follows its 原图). */
export function withUpscaleScale(canvas: ProjectCanvas, scale: number, canvases: readonly ProjectCanvas[]): ProjectCanvas {
  if (!canvas.upscale) return canvas
  return withUpscaleSize({ ...canvas, upscale: { scale } }, canvases)
}

/**
 * 一组同风格的图: a 风格 and three 画面 wired to it, side by side. Each
 * 画面 is described on its own; the 风格 carries what they share.
 */
export function seriesFromStyle(
  existing: readonly ProjectCanvas[],
  settings: CanvasSettings,
): { canvases: ProjectCanvas[]; style: ProjectCanvas; layouts: ProjectCanvas[] } {
  const style = createStyleCanvas(existing)
  let list: ProjectCanvas[] = [...existing, style]
  const layouts: ProjectCanvas[] = []
  for (let index = 0; index < 3; index += 1) {
    const near = layouts.at(-1) ?? style
    const placed = createLayoutCanvas(list, settings)
    const spot = spotBeside(index === 0 ? style : { ...near, y: style.y }, settings, list)
    const layout = setLink({ ...placed, x: spot.x, y: spot.y }, 'style', { canvasId: style.id })
    layouts.push(layout)
    list = [...list, layout]
  }
  return { canvases: list, style, layouts }
}
