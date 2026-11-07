import type { CanvasImageLink, ProjectCanvas } from '@shared/types'
import { normalizeCanvasAdapters } from '@shared/adapters'
import { ACTIVE_JOB_STATES } from '../../lib/format'
import { BOARD_GAP, cardRect, cardWidth, overlaps, resultSpot } from './boardLayout'
import { linksOf } from './links'

/**
 * The runs of a 画面 (layout canvas) and its filmstrip. A layout canvas's first
 * run renders on the canvas itself; every later run is a result canvas with
 * `sourceCanvasId` pointing back. Those results stay folded into the 画面's
 * filmstrip, off the board, until they are pinned or used as an input: then
 * they are cards of their own. Pure, no React.
 */

/**
 * Results that live in their 画面's filmstrip instead of on the board: not
 * pinned, made by a layout canvas that still exists, and not feeding any
 * canvas (a picture that feeds another one is always shown, so its wire is).
 */
export function foldedRunIds(canvases: readonly ProjectCanvas[]): Set<string> {
  const byId = new Map(canvases.map((canvas) => [canvas.id, canvas]))
  // Result cards keep a frozen copy of their inputs; only live canvases count as consumers.
  const consumed = new Set(
    canvases.filter((canvas) => canvas.kind !== 'result').flatMap((canvas) => linksOf(canvas).map((entry) => entry.link.canvasId)),
  )
  const folded = new Set<string>()
  for (const canvas of canvases) {
    if (canvas.kind !== 'result' || canvas.pinned || consumed.has(canvas.id)) continue
    const source = canvas.sourceCanvasId ? byId.get(canvas.sourceCanvasId) : undefined
    if (source?.kind === 'layout') folded.add(canvas.id)
  }
  return folded
}

/** The canvases drawn as cards on the board. */
export function boardCanvases(canvases: readonly ProjectCanvas[], folded: ReadonlySet<string> = foldedRunIds(canvases)): ProjectCanvas[] {
  return canvases.filter((canvas) => !folded.has(canvas.id))
}

/** A canvas that has been run at least once (started, finished or failed). */
function hasRun(canvas: ProjectCanvas): boolean {
  return Boolean(canvas.jobId || canvas.jobState || canvas.outputs?.length)
}

export function isActiveRun(canvas: Pick<ProjectCanvas, 'jobState'>): boolean {
  return ACTIVE_JOB_STATES.has(canvas.jobState ?? '')
}

/** A layout canvas's runs, oldest first: its own first run, then its folded results. */
export function runsOf(
  layout: ProjectCanvas,
  canvases: readonly ProjectCanvas[],
  folded: ReadonlySet<string> = foldedRunIds(canvases),
): ProjectCanvas[] {
  if (layout.kind !== 'layout') return []
  const later = canvases.filter((canvas) => folded.has(canvas.id) && canvas.sourceCanvasId === layout.id)
  return hasRun(layout) ? [layout, ...later] : later
}

/** One picture of a filmstrip, or a run that has none (yet): running, failed or canceled. */
export interface StripItem {
  runId: string
  /** Index within that run's outputs. */
  output: number
  path?: string
  /** 1-based place in the strip, as 第 N 张. */
  number: number
}

/**
 * The strip's items, oldest first. A run without pictures (still going,
 * failed or stopped) shows only while it is the newest: older ones would
 * only be noise.
 */
export function stripOf(runs: readonly ProjectCanvas[]): StripItem[] {
  const items: StripItem[] = []
  runs.forEach((run, index) => {
    const outputs = run.outputs ?? []
    if (!outputs.length) {
      if (index === runs.length - 1) items.push({ runId: run.id, output: 0, number: items.length + 1 })
      return
    }
    outputs.forEach((output, at) => items.push({ runId: run.id, output: at, path: output.path, number: items.length + 1 }))
  })
  return items
}

/**
 * Index of the item a layout canvas shows on its face: the one picked in the
 * strip, otherwise the first picture of the newest run.
 */
export function shownIndex(layout: Pick<ProjectCanvas, 'shownOutput'>, strip: readonly StripItem[]): number {
  const picked = layout.shownOutput
  const index = picked ? strip.findIndex((item) => item.runId === picked.canvasId && item.output === (picked.output ?? 0)) : -1
  if (index >= 0) return index
  const newest = strip.at(-1)
  return newest ? strip.findIndex((item) => item.runId === newest.runId) : -1
}

export interface Filmstrip {
  runs: ProjectCanvas[]
  items: StripItem[]
  /** -1 when the canvas has not run yet. */
  shown: number
}

export function filmstripOf(
  layout: ProjectCanvas,
  canvases: readonly ProjectCanvas[],
  folded: ReadonlySet<string> = foldedRunIds(canvases),
): Filmstrip {
  const runs = runsOf(layout, canvases, folded)
  const items = stripOf(runs)
  return { runs, items, shown: items.length ? shownIndex(layout, items) : -1 }
}

/** The run and picture a layout canvas shows on its face, if it has run. */
export function shownRun(layout: ProjectCanvas, canvases: readonly ProjectCanvas[]): { run: ProjectCanvas; item: StripItem } | null {
  const strip = filmstripOf(layout, canvases)
  const item = strip.items[strip.shown]
  const run = item ? strip.runs.find((canvas) => canvas.id === item.runId) : undefined
  return item && run ? { run, item } : null
}

/**
 * The picture a link to `link.canvasId` should carry. A 画面 gives the
 * picture shown on its face (the one picked in its filmstrip), so a wire
 * from it points at that run's output; anything else is linked as it is.
 */
export function pictureLink(canvases: readonly ProjectCanvas[], link: CanvasImageLink): CanvasImageLink {
  const source = canvases.find((canvas) => canvas.id === link.canvasId)
  if (source?.kind !== 'layout') return link
  const shown = shownRun(source, canvases)
  if (!shown?.item.path) return link
  return shown.item.output ? { canvasId: shown.run.id, output: shown.item.output } : { canvasId: shown.run.id }
}

/** Whether a canvas has a picture to give: a 画面 through its filmstrip. */
export function givesPicture(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[]): boolean {
  if (canvas.kind === 'image') return Boolean(canvas.imagePath)
  if (canvas.kind === 'layout') return Boolean(shownRun(canvas, canvases)?.item.path)
  return Boolean(canvas.outputs?.length)
}

/** First spot to the right of `near` (then further down) where a card of `size` is free. */
export function spotBeside(
  near: Pick<ProjectCanvas, 'x' | 'y' | 'width' | 'height'>,
  size: Pick<ProjectCanvas, 'width' | 'height'>,
  canvases: readonly ProjectCanvas[],
): { x: number; y: number } {
  const taken = boardCanvases(canvases).map(cardRect)
  const rect = cardRect({ x: near.x + cardWidth(near) + BOARD_GAP * 2, y: near.y, width: size.width, height: size.height })
  for (let guard = 0; guard < 200; guard += 1) {
    if (!taken.some((item) => overlaps(rect, item))) break
    rect.y += rect.h + BOARD_GAP
  }
  return { x: Math.round(rect.x), y: Math.round(rect.y) }
}

/**
 * Pin a filmstrip run as a card of its own: under its 画面 (or at `at`, where
 * it was dragged to). Its 画面 then shows its newest remaining picture. A run
 * that is already a card, or the 画面's own first run, stays as it is.
 */
export function pinRun(canvases: readonly ProjectCanvas[], runId: string, at?: { x: number; y: number }): ProjectCanvas[] {
  const run = canvases.find((canvas) => canvas.id === runId)
  if (!run || run.kind !== 'result') return [...canvases]
  const folded = foldedRunIds(canvases)
  const wasFolded = folded.has(run.id)
  const source = canvases.find((canvas) => canvas.id === run.sourceCanvasId)
  const others = boardCanvases(canvases, folded).filter((canvas) => canvas.id !== run.id)
  const spot = at ? { x: Math.round(at.x), y: Math.round(at.y) } : wasFolded && source ? resultSpot(source, others) : run
  return canvases.map((canvas) => {
    if (canvas.id === run.id) return { ...canvas, pinned: true, x: spot.x, y: spot.y }
    if (wasFolded && canvas.id === run.sourceCanvasId && canvas.shownOutput?.canvasId === run.id) {
      const { shownOutput: _shown, ...rest } = canvas
      return rest
    }
    return canvas
  })
}

/** Put a pinned result back into its 画面's filmstrip (it stays a card while it feeds another canvas). */
export function unpinRun(canvases: readonly ProjectCanvas[], runId: string): ProjectCanvas[] {
  return canvases.map((canvas) => {
    if (canvas.id !== runId || !canvas.pinned) return canvas
    const { pinned: _pinned, ...rest } = canvas
    return rest
  })
}

/** Whether a pinned result can go back into a filmstrip: its 画面 still exists. */
export function canUnpin(canvas: ProjectCanvas, canvases: readonly ProjectCanvas[]): boolean {
  if (canvas.kind !== 'result' || !canvas.pinned) return false
  return canvases.some((item) => item.id === canvas.sourceCanvasId && item.kind === 'layout')
}

/**
 * Remove one run from a filmstrip. A folded result is deleted; the 画面's own
 * first run only loses its pictures and job (the 画面 itself stays).
 */
export function dropRun(canvases: readonly ProjectCanvas[], runId: string): ProjectCanvas[] {
  const run = canvases.find((canvas) => canvas.id === runId)
  if (!run) return [...canvases]
  if (run.kind === 'result') {
    return canvases
      .filter((canvas) => canvas.id !== runId)
      .map((canvas) => {
        if (canvas.shownOutput?.canvasId !== runId) return canvas
        const { shownOutput: _shown, ...rest } = canvas
        return rest
      })
  }
  return canvases.map((canvas) => {
    if (canvas.id !== runId) return canvas
    const { jobId: _job, jobState: _state, progress: _progress, outputs: _outputs, error: _error, shownOutput: _shown, ...rest } = canvas
    return rest
  })
}

/**
 * 用这次的设置: a 画面 takes back the settings one of its runs was made with
 * (description, regions, size, model, quality, seed, sampling and LoRA). Its
 * pictures stay linked as they are now.
 */
export function withRunSettings(layout: ProjectCanvas, run: ProjectCanvas): ProjectCanvas {
  if (layout.kind !== 'layout' || run.id === layout.id) return layout
  const size = run.baseSize ?? { width: run.width, height: run.height }
  const next: ProjectCanvas = {
    ...layout,
    prompt: run.prompt,
    summary: structuredClone(run.summary),
    layers: structuredClone(run.layers),
    negative: run.negative,
    width: size.width,
    height: size.height,
    steps: run.steps,
    cfg: run.cfg,
    seed: run.outputs?.[0]?.seed ?? run.seed,
    seedLocked: true,
    modelBundleId: run.modelBundleId,
    adapters: normalizeCanvasAdapters(run.adapters),
  }
  if (run.sampling) next.sampling = structuredClone(run.sampling)
  else delete next.sampling
  return next
}
