import type { JobRecord, ProjectCanvas } from './types'

const ACTIVE_STATES = new Set(['queued', 'starting', 'running'])

export interface CanvasBranch {
  sourceId: string
  path: ReadonlySet<string>
}

export function canvasBranchesConflict(first: CanvasBranch, second: CanvasBranch): boolean {
  return first.path.has(second.sourceId) || second.path.has(first.sourceId)
}

export function activeCanvasBranchIds(
  canvases: ProjectCanvas[],
  jobs: JobRecord[],
): Set<string> {
  const byId = new Map(canvases.map((canvas) => [canvas.id, canvas]))
  const activeIds = new Set(
    canvases.filter((canvas) => {
      const job = canvas.jobId ? jobs.find((item) => item.id === canvas.jobId) : undefined
      return ACTIVE_STATES.has(job?.state ?? canvas.jobState ?? '')
    }).map((canvas) => canvas.id),
  )
  const busy = new Set<string>()
  for (const activeId of activeIds) {
    let current = byId.get(activeId)
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      busy.add(current.id)
      current = current.sourceCanvasId ? byId.get(current.sourceCanvasId) : undefined
    }
  }
  return busy
}

export function canvasLineage(canvas: ProjectCanvas, canvases: ProjectCanvas[]): string[] {
  const byId = new Map(canvases.map((item) => [item.id, item]))
  const lineage: string[] = []
  let current: ProjectCanvas | undefined = canvas
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    lineage.push(current.id)
    current = current.sourceCanvasId ? byId.get(current.sourceCanvasId) : undefined
  }
  return lineage
}
