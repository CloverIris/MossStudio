import type { ProjectLayerKind } from '@shared/types'

/** What the assistant sees of the canvas the user is working on. */
export interface StudioSnapshot {
  title: string
  description: string
  width: number
  height: number
  regions: Array<{ kind: ProjectLayerKind; caption: string; text?: string; visible: boolean }>
}

/** A region box in 0-1 canvas coordinates, as the tools take it. */
export interface LayerBox {
  x: number
  y: number
  w: number
  h: number
}

/** The fields a tool may change on an existing region; everything is optional. */
export interface LayerPatch {
  caption?: string
  text?: string
  bbox?: LayerBox
  visible?: boolean
  opacity?: number
}

export interface AddedLayer {
  added: string
  bbox: [number, number, number, number]
  index: number
}

/** One picture of a set the Agent builds in one call. */
export interface SceneDraft {
  title: string
  prompt: string
  width?: number
  height?: number
  regions?: Array<{ label: 'object' | 'character'; caption: string; bbox?: LayerBox }>
  texts?: Array<{ caption: string; text: string; bbox?: LayerBox }>
}

/**
 * The renderer owns the Studio state, so tool calls are executed here and the
 * result is handed back to the main process, which relays it to the model.
 * Every method must read the Studio's live state at call time, never a value
 * captured when the API was registered.
 */
export interface StudioToolApi {
  /** Whether anything is selected, and whether it can be edited at all. */
  state(): { hasSelection: boolean; editable: boolean }
  readContext(): unknown
  /** Plain snapshot of the selected canvas, or null when none is selected. */
  snapshot(): StudioSnapshot | null
  /** Replace the description of the selected canvas; throws when it cannot be edited. */
  setPrompt(prompt: string): { written: number }
  setSampler(patch: { width?: number; height?: number; steps?: number; cfg?: number; seed?: number }): unknown
  addLayer(input: { label: 'object' | 'character'; caption: string; bbox?: LayerBox }): AddedLayer
  /** A text region always carries both strings: caption is the style, text is the words. */
  addTextLayer(input: { caption: string; text: string; bbox?: LayerBox }): AddedLayer
  updateLayer(input: { index: number; patch: LayerPatch }): { updated: string; index: number }
  removeLayer(index: number): { removed: string; index: number }
  /** Build a set of layout canvases in one go; returns their ids so the Agent can refine them. */
  createScenes(scenes: SceneDraft[]): { created: Array<{ id: string; title: string }> }
  /** Make another canvas the selected one (the tools edit whatever is selected). */
  selectCanvas(id: string): { selected: string; title: string }
  generate(prompt?: string): Promise<unknown> | unknown
  /** What still blocks generation on the selected canvas; empty when it can run. */
  problems(): string[]
}
