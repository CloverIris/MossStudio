import type { GbcParseResult } from '@shared/gbc'
import type { ProjectCanvas } from '@shared/types'
import { addRegion, createLayoutCanvas, settingsFrom, type CanvasSettings } from './canvases'
import { clampDimension } from './defaults'
import { linkSourceImage } from './links'
import { pictureSize } from './nodes'
import { canvasDescription, withDescription } from './prompt'
import { givesPicture, pictureLink, spotBeside } from './runs'

/** The size of a 画面 shaped like the picture, with as many pixels as `settings` asks for. */
export function sizeLike(
  picture: { width: number; height: number },
  settings: Pick<CanvasSettings, 'width' | 'height'>,
): {
  width: number
  height: number
} {
  const area = settings.width * settings.height
  const aspect = picture.width / picture.height
  return { width: clampDimension(Math.sqrt(area * aspect)), height: clampDimension(Math.sqrt(area / aspect)) }
}

/**
 * 拆成区域: an empty 画面 beside the card whose picture is read, shaped like
 * that picture; its regions come in when GBC is done. It is not wired to the
 * picture: it keeps only the layout, where 用作起始图 keeps the pixels.
 * `path` is the picture to read (a 画面 gives the run on its face).
 */
export function regionsCanvasFrom(
  canvases: readonly ProjectCanvas[],
  sourceId: string,
  options: { fallback: CanvasSettings; id?: string },
): { canvases: ProjectCanvas[]; created: ProjectCanvas; path: string } | null {
  const source = canvases.find((canvas) => canvas.id === sourceId)
  if (!source || !givesPicture(source, canvases)) return null
  const link = pictureLink(canvases, { canvasId: sourceId })
  const path = linkSourceImage(link, canvases)
  if (!path) return null
  const settings = source.kind === 'image' ? options.fallback : settingsFrom(source)
  const picture = pictureSize(canvases, link)
  const placed = createLayoutCanvas(canvases, picture ? { ...settings, ...sizeLike(picture, settings) } : settings, options.id)
  const created = { ...placed, ...spotBeside(source, placed, canvases) }
  return { canvases: [...canvases, created], created, path }
}

/**
 * The regions GBC found, added to the 画面. A description typed while it was
 * reading is kept; otherwise the picture's caption becomes the description.
 */
export function withParsedRegions(canvas: ProjectCanvas, result: GbcParseResult): ProjectCanvas {
  let next = canvasDescription(canvas).trim() || !result.summary ? canvas : withDescription(canvas, result.summary)
  for (const region of result.regions) next = addRegion(next, { kind: 'object', caption: region.caption, bbox: region.bbox }).canvas
  return next
}

/** Still as 拆成区域 made it: nothing typed, drawn or generated, so 停止 or a failure may take it away again. */
export function untouched(canvas: ProjectCanvas): boolean {
  return !canvas.layers.length && !canvasDescription(canvas).trim() && !canvas.jobId && !canvas.outputs?.length && !canvas.inputs
}
