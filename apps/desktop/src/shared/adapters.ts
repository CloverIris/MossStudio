import type { AdapterEntry, CanvasAdapter } from './types'

/**
 * LoRA adapters are shared by the renderer, the main process and the engine
 * request builder, so the rules live here instead of being re-invented in each
 * layer. Nothing in this module touches the filesystem or Electron.
 */

/** moss-server applies the weight as-is; 0 disables it, 2 is the usual hard ceiling. */
export const ADAPTER_STRENGTH_MIN = 0
export const ADAPTER_STRENGTH_MAX = 2
export const ADAPTER_STRENGTH_DEFAULT = 1
export const ADAPTER_STRENGTH_STEP = 0.05

/** One Canvas cannot stack more than this many adapters. */
export const ADAPTERS_PER_CANVAS_MAX = 16

/**
 * Library ids are also directory names under `<models root>/adapters`, so a
 * valid id is exactly one safe path segment: it can never climb out of the root.
 */
const ADAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/

export function isAdapterId(value: unknown): value is string {
  return typeof value === 'string' && ADAPTER_ID_PATTERN.test(value)
}

/** Clamp to the engine range and round to two decimals (the slider step). */
export function clampAdapterStrength(value: unknown, fallback = ADAPTER_STRENGTH_DEFAULT): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return normalizeStrength(fallback)
  return normalizeStrength(Math.min(ADAPTER_STRENGTH_MAX, Math.max(ADAPTER_STRENGTH_MIN, numeric)))
}

function normalizeStrength(value: number): number {
  const clamped = Math.min(ADAPTER_STRENGTH_MAX, Math.max(ADAPTER_STRENGTH_MIN, Number.isFinite(value) ? value : ADAPTER_STRENGTH_DEFAULT))
  return Math.round(clamped * 100) / 100
}

/**
 * Accepts whatever arrives from a project file, the HTTP API or the agent and
 * returns the canonical list: valid ids only, no duplicates, clamped strengths,
 * hard cap on the count. `path` is only a shortcut for the engine payload.
 */
export function normalizeCanvasAdapters(input: unknown): CanvasAdapter[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const adapters: CanvasAdapter[] = []
  for (const item of input) {
    if (adapters.length >= ADAPTERS_PER_CANVAS_MAX) break
    if (!item || typeof item !== 'object') continue
    const raw = item as { id?: unknown; strength?: unknown; path?: unknown }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!isAdapterId(id) || seen.has(id)) continue
    seen.add(id)
    const adapter: CanvasAdapter = { id, strength: clampAdapterStrength(raw.strength) }
    if (typeof raw.path === 'string' && raw.path.trim()) adapter.path = raw.path.trim()
    adapters.push(adapter)
  }
  return adapters
}

export interface AdapterStatus {
  adapter: CanvasAdapter
  /** Catalog name, or the id when the entry is gone from the library. */
  name: string
  kind: AdapterEntry['kind'] | null
  installed: boolean
}

/** Join a Canvas' selection with the library so the UI can flag missing files. */
export function adapterStatuses(adapters: readonly CanvasAdapter[], catalog: readonly AdapterEntry[] | null | undefined): AdapterStatus[] {
  const byId = new Map((catalog ?? []).map((entry) => [entry.id, entry]))
  return adapters.map((adapter) => {
    const entry = byId.get(adapter.id)
    return {
      adapter,
      name: entry?.name || adapter.id,
      kind: entry?.kind ?? null,
      installed: entry?.installed === true,
    }
  })
}

/**
 * Few-step DMD bundles ship as adapters but are driven by the `dmd8` sampling
 * profile, not by the user. Applying them again from the LoRA row would double
 * the effect, so the picker hides them.
 */
export function isSelectableAdapter(entry: AdapterEntry): boolean {
  return entry.installed && entry.kind !== 'dmd'
}

/** `1` instead of `1.00`, `0.85` instead of `0.8500000000000001`. */
export function formatAdapterStrength(value: number): string {
  return (
    normalizeStrength(value)
      .toFixed(2)
      .replace(/\.?0+$/, '') || '0'
  )
}

/** One resolved LoRA, ready for `moss-server`'s `generate.loras`. */
export interface ResolvedLora {
  path: string
  strength: number
}

/** A Canvas asked for adapters the engine cannot be given. */
export class AdapterResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterResolutionError'
  }
}

export interface AdapterResolver {
  /** Absolute weight file for a library id, or null when it is not installed. */
  resolveFile: (id: string) => Promise<string | null>
  /** Human name for the id, used in the error message. */
  nameOf: (id: string) => Promise<string>
}

/**
 * Join the selection with the filesystem and fail on anything that cannot be
 * sent. Dropping unresolved adapters would generate a picture without the LoRA
 * while the Canvas still shows it selected — the kind of silent quality
 * regression that is very hard to spot in the output.
 */
export async function resolveAdapterSelection(adapters: readonly CanvasAdapter[], resolver: AdapterResolver): Promise<ResolvedLora[]> {
  const resolved: ResolvedLora[] = []
  const missing: string[] = []
  for (const adapter of adapters) {
    let path: string | null = null
    try {
      path = await resolver.resolveFile(adapter.id)
    } catch {
      path = null
    }
    if (!path) {
      missing.push(await resolver.nameOf(adapter.id).catch(() => adapter.id))
      continue
    }
    resolved.push({ path, strength: adapter.strength })
  }
  if (missing.length) {
    const listed = missing.map((name) => `「${name}」`).join('')
    throw new AdapterResolutionError(`LoRA ${listed} 未安装或权重文件缺失；请到模型库重新安装，或从 Canvas 上移除后再生成`)
  }
  return resolved
}
