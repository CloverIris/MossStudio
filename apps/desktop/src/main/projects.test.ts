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
    id: 'legacy-layer',
    kind: 'object' as const,
    caption: 'legacy object',
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
    const legacy = {
      schemaVersion: 1,
      id: projectId,
      name: 'Legacy Project',
      width: 512,
      height: 512,
      summary,
      layers: [layer],
      prompt: 'legacy prompt',
      negative: '',
      seed: 7,
      steps: 8,
      cfg: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    writeFileSync(join(projectRoot, 'project.json'), JSON.stringify(legacy))

    const migrated = getProject(projectId)
    assert.equal(migrated?.schemaVersion, 2)
    assert.equal(migrated?.canvases.length, 1)
    assert.equal(migrated?.canvases[0]?.kind, 'layout')
    assert.equal(migrated?.canvases[0]?.prompt, 'legacy prompt')
    assert.equal(JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf8')).schemaVersion, 1)

    const result = {
      id: 'result-canvas',
      kind: 'result' as const,
      title: 'Result',
      row: 0,
      column: 1,
      width: 512,
      height: 512,
      summary,
      layers: [],
      prompt: 'result prompt',
      negative: '',
      seed: 8,
      steps: 4,
      cfg: 1,
      jobId: 'job-fixture',
      jobState: 'succeeded' as const,
      outputs: [{ path: join(fixtureRoot, 'result.png'), width: 512, height: 512, seed: 8 }],
    }
    const layout = {
      id: 'layout-canvas',
      kind: 'layout' as const,
      title: 'Layout',
      row: 0,
      column: 0,
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
      id: projectId,
      name: 'Multi Canvas',
      width: 512,
      height: 512,
      summary,
      layers: [layer],
      prompt: layout.prompt,
      negative: layout.negative,
      seed: layout.seed,
      steps: layout.steps,
      cfg: layout.cfg,
      canvases: [layout, { ...result, backgroundPath: join(fixtureRoot, 'second', 'background.png') }],
      selectedCanvasId: result.id,
    })
    assert.equal(saved.selectedCanvasId, result.id)
    assert.equal(saved.canvases.length, 2)
    const stored = getProject(projectId)
    assert.equal(stored?.canvases[0]?.backgroundPath === stored?.canvases[1]?.backgroundPath, false)
    assert.equal(readFileSync(stored!.canvases[0]!.backgroundPath!, 'utf8'), 'first-background')
    assert.equal(readFileSync(stored!.canvases[1]!.backgroundPath!, 'utf8'), 'second-background')
    assert.equal(stored?.canvases[1]?.jobId, 'job-fixture')
    assert.equal(stored?.canvases[1]?.outputs?.[0]?.path, result.outputs[0]?.path)

    const empty = saveProject({
      id: projectId,
      name: 'Multi Canvas',
      width: 512,
      height: 512,
      summary,
      layers: [],
      prompt: '',
      negative: '',
      seed: 0,
      steps: 8,
      cfg: 1,
      canvases: [],
    })
    assert.equal(empty.canvases.length, 0)
    assert.equal(empty.selectedCanvasId, undefined)
    assert.equal(getProject(projectId)?.canvases.length, 0)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
