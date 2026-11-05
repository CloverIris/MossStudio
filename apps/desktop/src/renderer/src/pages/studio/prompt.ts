import type { ProjectCanvas, ProjectLayer } from '@shared/types'
import { compileLayout, type LayoutDraft, type LayoutItemDraft } from '../../lib/layout'

/**
 * "The layout is the prompt": what the engine receives is always compiled from
 * the canvas description plus its visible regions. There is no hand-written
 * prompt that silently wins over the layout, and no insert step.
 */

type PromptSource = Pick<ProjectCanvas, 'prompt' | 'summary' | 'layers'>

export function visibleLayers(layers: readonly ProjectLayer[]): ProjectLayer[] {
  return layers.filter((layer) => layer.visible !== false)
}

/**
 * The description of a canvas. New canvases keep it in both `prompt` and
 * `summary.caption`; older ones used `prompt` for plain runs and
 * `summary.caption` for region runs, so read the one that run actually used.
 */
export function canvasDescription(canvas: PromptSource): string {
  const prompt = canvas.prompt ?? ''
  const caption = canvas.summary?.caption ?? ''
  if (visibleLayers(canvas.layers).length > 0) return caption.trim() ? caption : prompt
  return prompt.trim() ? prompt : caption
}

/** Write the description to both places it is read from. */
export function withDescription<T extends PromptSource>(canvas: T, description: string): T {
  return { ...canvas, prompt: description, summary: { ...canvas.summary, caption: description } }
}

export function layerToItem(layer: ProjectLayer): LayoutItemDraft {
  return {
    id: layer.id,
    label: layer.kind,
    caption: layer.caption,
    text: layer.text,
    bbox: layer.bbox,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
  }
}

export function canvasToDraft(canvas: PromptSource & Pick<ProjectCanvas, 'width' | 'height'>): LayoutDraft {
  return {
    width: canvas.width,
    height: canvas.height,
    summary: {
      caption: canvasDescription(canvas),
      meta: canvas.summary?.meta ?? [],
      canvas: canvas.summary?.canvas ?? 'single',
    },
    items: canvas.layers.map(layerToItem),
  }
}

export interface CompiledPrompt {
  ok: boolean
  /** Exactly what is sent to the engine. */
  prompt: string
  /** Human-readable form for the read-only 查看最终提示词 view. */
  preview: string
  source: 'layout' | 'text'
  regions: number
  errors: string[]
}

export const EMPTY_PROMPT_ERROR = '先写一句描述'

export function compileCanvasPrompt(canvas: PromptSource & Pick<ProjectCanvas, 'width' | 'height'>): CompiledPrompt {
  const description = canvasDescription(canvas).trim()
  const regions = visibleLayers(canvas.layers).length
  if (regions === 0) {
    if (!description) return { ok: false, prompt: '', preview: '', source: 'text', regions: 0, errors: [EMPTY_PROMPT_ERROR] }
    return { ok: true, prompt: description, preview: description, source: 'text', regions: 0, errors: [] }
  }
  // compileLayout leaves hidden regions out of both validation and output.
  const result = compileLayout(canvasToDraft(canvas))
  if (!result.ok) return { ok: false, prompt: '', preview: '', source: 'layout', regions, errors: result.errors }
  return { ok: true, prompt: result.prompt, preview: result.preview, source: 'layout', regions, errors: [] }
}
