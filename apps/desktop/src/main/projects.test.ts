import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './lib/paths'
import { getProject, saveProject } from './services/projects'

export function runProjectCanvasTests(): void {
  const projectId = `project-canvas-test-${process.pid}`
  const projectRoot = join(paths.root(), 'projects', projectId)
  const fixtureRoot = join(paths.root(), `project-canvas-fixtures-${process.pid}`)
  const summary = { caption: 'fixture', meta: [], canvas: 'single' as const }
  const layer = {
    id: 'layer-1',
    kind: 'object' as const,
    caption: 'object',
    bbox: [10, 20, 200, 220] as [number, number, number, number],
    visible: true,
    locked: false,
    opacity: 1,
  }

  rmSync(projectRoot, { recursive: true, force: true })
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(join(fixtureRoot, 'first'), { recursive: true })
  mkdirSync(join(fixtureRoot, 'second'), { recursive: true })
  writeFileSync(join(fixtureRoot, 'first', 'background.png'), 'first-background')
  writeFileSync(join(fixtureRoot, 'second', 'background.png'), 'second-background')

  try {
    const result = {
      id: 'result-canvas',
      kind: 'result' as const,
      title: 'Result',
      x: 0,
      y: 428,
      width: 512,
      height: 512,
      summary,
      layers: [],
      prompt: 'result prompt',
      negative: '',
      seed: 8,
      steps: 4,
      cfg: 1,
      sourceCanvasId: 'layout-canvas',
      jobId: 'job-fixture',
      jobState: 'succeeded' as const,
      outputs: [{ path: join(fixtureRoot, 'result.png'), width: 512, height: 512, seed: 8 }],
    }
    const layout = {
      id: 'layout-canvas',
      kind: 'layout' as const,
      title: 'Layout',
      x: 0,
      y: 0,
      width: 512,
      height: 512,
      summary,
      layers: [layer],
      prompt: 'layout prompt',
      negative: 'negative',
      seed: 9,
      steps: 20,
      cfg: 2,
      backgroundPath: join(fixtureRoot, 'first', 'background.png'),
    }
    const saved = saveProject({
      name: 'Multi Canvas',
      canvases: [layout, { ...result, backgroundPath: join(fixtureRoot, 'second', 'background.png') }],
      selectedCanvasId: result.id,
    })
    assert.equal(saved.schemaVersion, 3)
    assert.equal(saved.selectedCanvasId, result.id)
    assert.equal(saved.canvases.length, 2)
    assert.equal(saved.canvases[1]?.x, 0)
    assert.equal(saved.canvases[1]?.y, 428)

    const stored = getProject(saved.id)
    assert.equal(stored?.canvases[0]?.backgroundPath === stored?.canvases[1]?.backgroundPath, false)
    assert.equal(readFileSync(stored!.canvases[0]!.backgroundPath!, 'utf8'), 'first-background')
    assert.equal(readFileSync(stored!.canvases[1]!.backgroundPath!, 'utf8'), 'second-background')
    assert.equal(stored?.canvases[1]?.jobId, 'job-fixture')
    assert.equal(stored?.canvases[1]?.outputs?.[0]?.path, result.outputs[0]?.path)

    const empty = saveProject({ id: saved.id, name: 'Multi Canvas', canvases: [] })
    assert.equal(empty.canvases.length, 0)
    assert.equal(empty.selectedCanvasId, undefined)
    assert.equal(getProject(saved.id)?.canvases.length, 0)

    // A file written by an older schema is not readable any more.
    rmSync(projectRoot, { recursive: true, force: true })
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(join(projectRoot, 'project.json'), JSON.stringify({ schemaVersion: 2, id: projectId, name: 'Legacy', canvases: [] }))
    assert.equal(getProject(projectId), null)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
