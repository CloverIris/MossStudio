import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeCanvasBranchIds,
  canvasBranchesConflict,
  canvasLineage,
} from '../apps/desktop/src/shared/canvasJobBranch.ts'

const canvas = (id, sourceCanvasId) => ({
  id,
  kind: sourceCanvasId ? 'result' : 'layout',
  title: id,
  sourceCanvasId,
  jobState: 'idle',
  width: 512,
  height: 512,
  x: 0,
  y: 0,
  summary: { caption: '', meta: [], canvas: 'single' },
  layers: [],
  prompt: 'test',
  negative: '',
  seed: 1,
  steps: 4,
  cfg: 1,
})

const canvases = [
  canvas('root'),
  canvas('child', 'root'),
  canvas('grandchild', 'child'),
  canvas('sibling', 'root'),
  canvas('other-root'),
]

test('an active descendant locks itself and its ancestors, not a sibling result', () => {
  const jobs = [{ id: 'job', state: 'running' }]
  const activeCanvases = canvases.map((item) => item.id === 'grandchild' ? { ...item, jobId: 'job' } : item)
  const busy = activeCanvasBranchIds(activeCanvases, jobs)
  assert.deepEqual([...busy].sort(), ['child', 'grandchild', 'root'])
  assert.equal(busy.has('sibling'), false)
  assert.equal(busy.has('other-root'), false)
})

test('lineage includes the source and each ancestor once', () => {
  assert.deepEqual(canvasLineage(canvases[2], canvases), ['grandchild', 'child', 'root'])
})

test('branch reservations block ancestors and descendants without blocking siblings', () => {
  const root = { sourceId: 'root', path: new Set(['root']) }
  const child = { sourceId: 'child', path: new Set(['child', 'root']) }
  const sibling = { sourceId: 'sibling', path: new Set(['sibling', 'root']) }
  assert.equal(canvasBranchesConflict(root, child), true)
  assert.equal(canvasBranchesConflict(child, sibling), false)
})
