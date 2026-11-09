export interface GbcBBox {
  left: number
  top: number
  right: number
  bottom: number
  confidence?: number | null
}

/** One caption of a vertex; ml-gbc names its kind `label` (short, detail…), older writers `kind`. */
export interface GbcDescription {
  text?: string
  label?: string
  kind?: string
}

export interface GbcVertex {
  vertex_id?: string
  label?: string
  bbox?: GbcBBox
  descs?: GbcDescription[]
  in_edges?: unknown[]
  out_edges?: unknown[]
}

export interface GbcGraph {
  vertices?: GbcVertex[]
  edges?: unknown[]
}

export interface GbcRunInput {
  folder?: string
  files?: string[]
  providerId: string
  detector: 'owlv2' | 'sam3'
  versionId?: string
  sidecarJson?: boolean
  sidecarTxt?: boolean
}

export interface GbcImageResult {
  key: string
  name: string
  path: string
  summary: string
  vertices: GbcVertex[]
  graph?: GbcGraph
  graphCount?: number
}

export interface GbcRunResult {
  id: string
  outputDir: string
  graphCount: number
  vertexCount: number
  summary: string
  vertices: GbcVertex[]
  images: GbcImageResult[]
  sidecarFiles?: string[]
}

/** One prerequisite check shown to the user; both processes read the same shape. */
export interface GbcCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface GbcStatus {
  available: boolean
  version?: string
  error?: string
  python?: string
  venv?: string
  checks: GbcCheck[]
  versionId?: string
}

/** A region found in a picture: its words and its box, normalised to the picture (0–1). */
export interface GbcRegion {
  caption: string
  bbox: { x: number; y: number; w: number; h: number }
}

/** 拆成区域: what a picture becomes on its new 画面. */
export interface GbcParseResult {
  /** The whole picture's caption, the 画面's description. */
  summary: string
  regions: GbcRegion[]
}

/** While 拆成区域 runs: the first run downloads the detector, later ones only read. */
export interface GbcParseProgress {
  runId: string
  phase: 'download' | 'reading'
  /** 0–100 while downloading, when the download says how far it is. */
  percent?: number
}

/** 安装 in 设置 › 功能: fetching KohakuGBC's code, then its Python packages. */
export interface GbcSetupProgress {
  phase: 'code' | 'packages' | 'done' | 'failed'
  error?: string
}

/** More regions than this crowd a 画面; the largest are kept. */
export const GBC_MAX_REGIONS = 12
/** A box covering nearly the whole picture says nothing about the layout. */
const WHOLE_PICTURE = 0.9

function descKind(desc: GbcDescription): string {
  return (desc.label ?? desc.kind ?? '').toLowerCase()
}

function caption(vertex: GbcVertex, prefer: RegExp): string {
  const descs = (vertex.descs ?? []).filter((desc) => desc.text?.trim())
  const pick = descs.find((desc) => prefer.test(descKind(desc))) ?? descs[0]
  return pick?.text?.trim() ?? ''
}

function edgeSource(edge: unknown): string | undefined {
  if (!edge || typeof edge !== 'object') return undefined
  const source = (edge as { source?: unknown }).source
  return typeof source === 'string' ? source : undefined
}

/**
 * The regions and description a GBC graph gives a 画面. Regions are the
 * objects the picture's caption names (entity vertices under the image vertex);
 * their parts and the relation and composition vertices would only crowd it.
 * A graph that does not say which entities are top level keeps every entity.
 */
export function regionsFromGraph(graph: GbcGraph): GbcParseResult {
  const vertices = graph.vertices ?? []
  const image = vertices.find((vertex) => vertex.label === 'image')
  const imageId = image?.vertex_id ?? ''
  const entities = vertices.filter((vertex) => vertex.label === 'entity' && vertex.bbox)
  const topLevel = entities.filter((vertex) => (vertex.in_edges ?? []).some((edge) => edgeSource(edge) === imageId))
  const chosen = topLevel.length ? topLevel : entities
  const regions = chosen
    .map((vertex) => {
      const box = vertex.bbox!
      const x = Math.min(Math.max(box.left, 0), 1)
      const y = Math.min(Math.max(box.top, 0), 1)
      const w = Math.min(Math.max(box.right, 0), 1) - x
      const h = Math.min(Math.max(box.bottom, 0), 1) - y
      return { caption: caption(vertex, /short/), bbox: { x, y, w, h } }
    })
    .filter((region) => region.caption && region.bbox.w > 0 && region.bbox.h > 0 && region.bbox.w * region.bbox.h < WHOLE_PICTURE)
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)
    .slice(0, GBC_MAX_REGIONS)
  return { summary: image ? caption(image, /detail|long/) : '', regions }
}

/** What the menu says while GBC is still being checked; the entry is off until then. */
export const PARSE_CHECKING = '正在检查'

/** The 助手 models GBC can read pictures with: an OpenAI-compatible or Anthropic API with a key. */
export function gbcCanUse(provider: { kind: string; hasKey: boolean }): boolean {
  return provider.hasKey && (provider.kind === 'openai' || provider.kind === 'anthropic')
}

/**
 * Why 拆成区域 cannot run yet, as the menu says it, or null when it can.
 * `status` is undefined while it is still being checked.
 */
export function gbcBlocker(
  status: Pick<GbcStatus, 'available'> | null | undefined,
  providers: readonly { kind: string; hasKey: boolean }[],
): string | null {
  if (status === undefined) return PARSE_CHECKING
  // A chosen model that is gone falls back to the first usable one, so only having none blocks.
  if (!providers.some(gbcCanUse)) return '先给助手加一个模型'
  if (!status?.available) return '看图还没装好'
  return null
}
