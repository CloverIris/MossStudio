export interface GbcBBox {
  left: number
  top: number
  right: number
  bottom: number
  confidence?: number | null
}

export interface GbcVertex {
  vertex_id?: string
  label?: string
  bbox?: GbcBBox
  descs?: Array<{ text?: string; kind?: string }>
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
