import type { Settings } from '@shared/types'
import { AdapterResolutionError, normalizeCanvasAdapters, resolveAdapterSelection, type ResolvedLora } from '@shared/adapters'
import { findAdapterName, resolveAdapterFile } from './models'

export { AdapterResolutionError }
export type { ResolvedLora }

export interface ResolveAdapterOptions {
  /** Set when the job runs on a remote engine host. */
  hostId?: string
}

/**
 * Turn the Canvas' model-library ids into weight files the engine can open.
 *
 * Resolution happens right before the job starts, never at save time: a project
 * keeps ids so moving or reinstalling the library cannot leave it pointing at a
 * stale path. Both the IPC path and the HTTP backend go through here — missing
 * or unsupported adapters fail loudly with a message the Studio shows verbatim.
 */
export async function resolveCanvasAdapters(
  settings: Settings,
  input: unknown,
  options: ResolveAdapterOptions = {},
): Promise<ResolvedLora[]> {
  const adapters = normalizeCanvasAdapters(input)
  if (!adapters.length) return []
  if (options.hostId) {
    throw new AdapterResolutionError('远端引擎暂不支持 LoRA：请把此 Canvas 切换到本机 MossInfer，或先移除 LoRA')
  }
  return resolveAdapterSelection(adapters, {
    resolveFile: (id) => resolveAdapterFile(settings, id),
    nameOf: (id) => findAdapterName(settings, id),
  })
}
