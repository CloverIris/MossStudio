import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCanvas } from '@shared/types'
import { deleteProject, getProject, listProjects, saveProject } from '@main/services/projects'
import { useTempDataRoot } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()
const projectsRoot = (): string => join(dataRoot(), 'projects')

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

function canvas(patch: Partial<ProjectCanvas> = {}): ProjectCanvas {
  return {
    id: 'layout-canvas',
    kind: 'layout',
    title: 'Layout',
    x: 0,
    y: 0,
    width: 512,
    height: 512,
    summary,
    layers: [],
    prompt: '',
    negative: '',
    seed: 1,
    steps: 20,
    cfg: 2,
    ...patch,
  }
}

function fixtureFile(rel: string, content: string): string {
  const path = join(dataRoot(), 'fixtures', rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T00:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('saveProject / getProject (ported from the in-Electron smoke test)', () => {
  it('stores multiple canvases with their own background assets and job state', () => {
    const result = canvas({
      id: 'result-canvas',
      kind: 'result',
      title: 'Result',
      y: 428,
      prompt: 'result prompt',
      seed: 8,
      steps: 4,
      cfg: 1,
      sourceCanvasId: 'layout-canvas',
      jobId: 'job-fixture',
      jobState: 'succeeded',
      outputs: [{ path: join(dataRoot(), 'fixtures', 'result.png'), width: 512, height: 512, seed: 8 }],
      backgroundPath: fixtureFile('second/background.png', 'second-background'),
    })
    const layout = canvas({
      layers: [layer],
      prompt: 'layout prompt',
      negative: 'negative',
      seed: 9,
      backgroundPath: fixtureFile('first/background.png', 'first-background'),
    })
    const saved = saveProject({ name: 'Multi Canvas', canvases: [layout, result], selectedCanvasId: result.id })
    expect(saved.schemaVersion).toBe(3)
    expect(saved.selectedCanvasId).toBe(result.id)
    expect(saved.canvases).toHaveLength(2)
    expect(saved.canvases[1]?.x).toBe(0)
    expect(saved.canvases[1]?.y).toBe(428)

    const stored = getProject(saved.id)!
    expect(stored.canvases[0]?.backgroundPath).not.toBe(stored.canvases[1]?.backgroundPath)
    expect(readFileSync(stored.canvases[0]!.backgroundPath!, 'utf8')).toBe('first-background')
    expect(readFileSync(stored.canvases[1]!.backgroundPath!, 'utf8')).toBe('second-background')
    expect(stored.canvases[1]?.jobId).toBe('job-fixture')
    expect(stored.canvases[1]?.outputs?.[0]?.path).toBe(result.outputs![0]!.path)
    // Backgrounds are copied into the project, so the originals can go away.
    for (const item of stored.canvases) expect(item.backgroundPath!.startsWith(join(projectsRoot(), saved.id, 'assets'))).toBe(true)

    const empty = saveProject({ id: saved.id, name: 'Multi Canvas', canvases: [] })
    expect(empty.canvases).toHaveLength(0)
    expect(empty.selectedCanvasId).toBeUndefined()
    expect(getProject(saved.id)?.canvases).toHaveLength(0)
  })

  it('a file written by an older schema is not readable any more', () => {
    const dir = join(projectsRoot(), 'legacy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ schemaVersion: 2, id: 'legacy', name: 'Legacy', canvases: [] }))
    expect(getProject('legacy')).toBeNull()
    expect(listProjects()).toEqual([])
  })
})

describe('saveProject', () => {
  it('assigns an id, trims the name and defaults page and selection', () => {
    const saved = saveProject({ name: '   ', canvases: [canvas({ id: 'r', kind: 'result' }), canvas({ id: 'l' })] })
    expect(saved.id).toMatch(/^project-[a-f0-9]{8}$/)
    expect(saved.name).toBe('未命名 Project')
    expect(saved.page).toBe(1)
    // Without an explicit (or valid) selection the layout canvas wins over the first one.
    expect(saved.selectedCanvasId).toBe('l')
    expect(saved.createdAt).toBe('2026-03-01T00:00:00.000Z')
    expect(saved.updatedAt).toBe(saved.createdAt)
    expect(existsSync(join(projectsRoot(), saved.id, 'assets'))).toBe(true)
    expect(readdirSync(join(projectsRoot(), saved.id)).sort()).toEqual(['assets', 'project.json'])
  })

  it('falls back to the first canvas when no layout exists and ignores an unknown selection', () => {
    const saved = saveProject({
      name: 'x',
      canvases: [canvas({ id: 'r1', kind: 'result' }), canvas({ id: 'r2', kind: 'result' })],
      selectedCanvasId: 'missing',
    })
    expect(saved.selectedCanvasId).toBe('r1')
  })

  it('keeps createdAt, seriesId and page from the existing project on update', () => {
    const first = saveProject({ name: 'One', canvases: [], seriesId: ' series-a ', page: 3 })
    expect(first.seriesId).toBe('series-a')
    vi.setSystemTime(new Date('2026-03-02T00:00:00.000Z'))
    const second = saveProject({ id: first.id, name: 'One renamed', canvases: [] })
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBe('2026-03-02T00:00:00.000Z')
    expect(second.seriesId).toBe('series-a')
    expect(second.page).toBe(3)
    const third = saveProject({ id: first.id, name: 'One', canvases: [], seriesId: '  ', page: 7 })
    expect(third.seriesId).toBe('series-a')
    expect(third.page).toBe(7)
  })

  it('an id that does not exist on disk creates a fresh project instead of trusting the input id', () => {
    const saved = saveProject({ id: 'project-made-up', name: 'x', canvases: [] })
    expect(saved.id).not.toBe('project-made-up')
    expect(existsSync(join(projectsRoot(), 'project-made-up'))).toBe(false)
  })

  it('does not copy a background that already lives in the project assets', () => {
    const saved = saveProject({ name: 'x', canvases: [canvas({ backgroundPath: fixtureFile('bg.png', 'bg') })] })
    const assetPath = saved.canvases[0]!.backgroundPath!
    const again = saveProject({ id: saved.id, name: 'x', canvases: saved.canvases })
    expect(again.canvases[0]!.backgroundPath).toBe(assetPath)
    expect(readdirSync(join(projectsRoot(), saved.id, 'assets'))).toHaveLength(1)
  })

  it('sanitises the canvas id used in the asset name', () => {
    const saved = saveProject({ name: 'x', canvases: [canvas({ id: '../../evil id', backgroundPath: fixtureFile('bg.png', 'bg') })] })
    const asset = saved.canvases[0]!.backgroundPath!
    expect(asset).toBe(join(projectsRoot(), saved.id, 'assets', '______evil_id-bg.png'))
    expect(readFileSync(asset, 'utf8')).toBe('bg')
  })

  it('keeps a background path that does not exist as-is', () => {
    const missing = join(dataRoot(), 'nope.png')
    const saved = saveProject({ name: 'x', canvases: [canvas({ backgroundPath: missing })] })
    expect(saved.canvases[0]!.backgroundPath).toBe(missing)
  })

  it('reuses an existing asset with the same name rather than overwriting it', () => {
    const saved = saveProject({ name: 'x', canvases: [canvas({ backgroundPath: fixtureFile('a/bg.png', 'first') })] })
    const again = saveProject({ id: saved.id, name: 'x', canvases: [canvas({ backgroundPath: fixtureFile('b/bg.png', 'second') })] })
    expect(again.canvases[0]!.backgroundPath).toBe(saved.canvases[0]!.backgroundPath)
    expect(readFileSync(again.canvases[0]!.backgroundPath!, 'utf8')).toBe('first')
  })
})

describe('listProjects', () => {
  it('returns summaries newest first and skips unreadable entries', () => {
    const a = saveProject({ name: 'A', canvases: [canvas({ width: 640, height: 480, layers: [layer, { ...layer, id: 'l2' }] })] })
    vi.setSystemTime(new Date('2026-03-05T00:00:00.000Z'))
    const b = saveProject({
      name: 'B',
      canvases: [canvas({ id: 'r', kind: 'result', width: 100, height: 200, layers: [layer] })],
      seriesId: 's',
      page: 2,
    })
    mkdirSync(join(projectsRoot(), 'broken'), { recursive: true })
    writeFileSync(join(projectsRoot(), 'broken', 'project.json'), '{')
    mkdirSync(join(projectsRoot(), 'empty-dir'), { recursive: true })
    writeFileSync(join(projectsRoot(), 'stray-file.json'), '{}')

    expect(listProjects()).toEqual([
      { id: b.id, name: 'B', width: 100, height: 200, layerCount: 1, seriesId: 's', page: 2, updatedAt: '2026-03-05T00:00:00.000Z' },
      { id: a.id, name: 'A', width: 640, height: 480, layerCount: 2, seriesId: undefined, page: 1, updatedAt: '2026-03-01T00:00:00.000Z' },
    ])
  })

  it('defaults the size of a project without canvases to 1024', () => {
    saveProject({ name: 'Empty', canvases: [] })
    expect(listProjects()[0]).toMatchObject({ width: 1024, height: 1024, layerCount: 0 })
  })

  it('returns an empty list before any project exists', () => {
    expect(listProjects()).toEqual([])
  })
})

describe('getProject', () => {
  it('rejects documents without an id or canvases array', () => {
    for (const [id, body] of [
      ['no-id', { schemaVersion: 3, canvases: [] }],
      ['no-canvases', { schemaVersion: 3, id: 'no-canvases' }],
      ['null', null],
    ] as const) {
      mkdirSync(join(projectsRoot(), id), { recursive: true })
      writeFileSync(join(projectsRoot(), id, 'project.json'), JSON.stringify(body))
      expect(getProject(id)).toBeNull()
    }
    expect(getProject('missing')).toBeNull()
  })
})

describe('deleteProject', () => {
  it('removes the project directory and its assets, and ignores unknown ids', () => {
    const saved = saveProject({ name: 'x', canvases: [canvas({ backgroundPath: fixtureFile('bg.png', 'bg') })] })
    deleteProject('unknown')
    expect(getProject(saved.id)).not.toBeNull()
    deleteProject(saved.id)
    expect(getProject(saved.id)).toBeNull()
    expect(existsSync(join(projectsRoot(), saved.id))).toBe(false)
    expect(existsSync(join(dataRoot(), 'fixtures', 'bg.png'))).toBe(true)
  })
})

describe('project ids cannot escape the projects folder', () => {
  it.each(['..', '../x', '.', 'a/b', 'a\\b', '', ' x'])('rejects %j', (id) => {
    mkdirSync(projectsRoot(), { recursive: true })
    writeFileSync(join(dataRoot(), 'settings.json'), '{}')
    expect(() => deleteProject(id)).toThrow(/Invalid project id/)
    expect(getProject(id)).toBeNull()
    expect(existsSync(join(dataRoot(), 'settings.json'))).toBe(true)
  })

  it('still accepts generated and legacy-style ids', () => {
    const project = saveProject({ name: 'ok', canvases: [] })
    expect(project.id).toMatch(/^project-[0-9a-f]{8}$/)
    expect(getProject(project.id)?.name).toBe('ok')
    deleteProject(project.id)
    expect(getProject(project.id)).toBeNull()
  })
})
