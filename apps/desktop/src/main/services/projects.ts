import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectCanvas, ProjectDocument, ProjectSummary } from '@shared/types'
import { paths } from '../lib/paths'

function projectsRoot(): string {
  return join(paths.root(), 'projects')
}

function projectDir(id: string): string {
  return join(projectsRoot(), id)
}

function projectFile(id: string): string {
  return join(projectDir(id), 'project.json')
}

function readProject(id: string): ProjectDocument | null {
  try {
    const raw = JSON.parse(readFileSync(projectFile(id), 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw['id'] !== 'string') return null
    if (raw['schemaVersion'] === 2 && Array.isArray(raw['canvases'])) return raw as unknown as ProjectDocument
    if (raw['schemaVersion'] !== 1) return null

    const projectId = raw['id']
    const canvas: ProjectCanvas = {
      id: `${projectId}-canvas-1`,
      kind: 'layout',
      title: typeof raw['name'] === 'string' ? raw['name'] : '画布 1',
      row: 0,
      column: 0,
      width: Number(raw['width']),
      height: Number(raw['height']),
      summary: raw['summary'] as ProjectDocument['summary'],
      layers: raw['layers'] as ProjectDocument['layers'],
      prompt: String(raw['prompt'] ?? ''),
      negative: String(raw['negative'] ?? ''),
      seed: Number(raw['seed'] ?? 42),
      steps: Number(raw['steps'] ?? 8),
      cfg: Number(raw['cfg'] ?? 3),
      modelBundleId: typeof raw['modelBundleId'] === 'string' ? raw['modelBundleId'] : undefined,
      deviceId: typeof raw['deviceId'] === 'string' ? raw['deviceId'] : undefined,
      backgroundPath: typeof raw['backgroundPath'] === 'string' ? raw['backgroundPath'] : undefined,
    }
    return {
      ...(raw as unknown as Omit<ProjectDocument, 'schemaVersion' | 'canvases' | 'selectedCanvasId' | 'board'>),
      schemaVersion: 2,
      canvases: [canvas],
      selectedCanvasId: canvas.id,
      board: { columns: 2 },
    }
  } catch {
    return null
  }
}

function writeProject(project: ProjectDocument): void {
  mkdirSync(join(projectDir(project.id), 'assets'), { recursive: true })
  const file = projectFile(project.id)
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(project, null, 2), 'utf8')
  renameSync(temporary, file)
}

function summary(project: ProjectDocument): ProjectSummary {
  const canvas = project.canvases.find((item) => item.kind === 'layout') ?? project.canvases[0]
  return {
    id: project.id,
    name: project.name,
    width: canvas?.width ?? project.width,
    height: canvas?.height ?? project.height,
    layerCount: project.canvases.reduce((count, item) => count + item.layers.length, 0),
    seriesId: project.seriesId,
    page: project.page,
    updatedAt: project.updatedAt,
  }
}

export function listProjects(): ProjectSummary[] {
  try {
    return readdirSync(projectsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readProject(entry.name))
      .filter((project): project is ProjectDocument => Boolean(project))
      .map(summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

export function getProject(id: string): ProjectDocument | null {
  return readProject(id)
}

export interface SaveProjectInput {
  id?: string
  name: string
  width: number
  height: number
  summary: ProjectDocument['summary']
  layers: ProjectDocument['layers']
  prompt: string
  negative: string
  seed: number
  steps: number
  cfg: number
  instanceId?: string
  modelBundleId?: string
  deviceId?: string
  backgroundPath?: string
  seriesId?: string
  page?: number
  canvases?: ProjectCanvas[]
  selectedCanvasId?: string
  board?: ProjectDocument['board']
}

export function saveProject(input: SaveProjectInput): ProjectDocument {
  const existing = input.id ? readProject(input.id) : null
  const now = new Date().toISOString()
  const id = existing?.id ?? `project-${randomUUID().slice(0, 8)}`
  const persistAsset = (path: string | undefined, assetId: string): string | undefined => {
    if (!path || !existsSync(path)) return path
    const assets = join(projectDir(id), 'assets')
    mkdirSync(assets, { recursive: true })
    const assetRelativePath = relative(resolve(assets), resolve(path))
    if (assetRelativePath && assetRelativePath !== '..' && !assetRelativePath.startsWith(`..${sep}`) && !isAbsolute(assetRelativePath)) return path
    const safeAssetId = assetId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const target = join(assets, `${safeAssetId}-${basename(path)}`)
    if (path !== target && !existsSync(target)) copyFileSync(path, target)
    return target
  }
  const previous = existing?.canvases ?? []
  const requestedSelectedCanvasId = input.selectedCanvasId ?? existing?.selectedCanvasId
  const incomingCanvases = input.canvases ?? (() => {
    const prior = previous.find((canvas) => canvas.id === requestedSelectedCanvasId && canvas.kind === 'layout')
    const canvas: ProjectCanvas = {
      id: prior?.id ?? `${id}-canvas-1`,
      kind: 'layout',
      title: input.name.trim() || prior?.title || '画布 1',
      row: prior?.row ?? 0,
      column: prior?.column ?? 0,
      width: input.width,
      height: input.height,
      summary: input.summary,
      layers: input.layers,
      prompt: input.prompt,
      negative: input.negative,
      seed: input.seed,
      steps: input.steps,
      cfg: input.cfg,
      modelBundleId: input.modelBundleId,
      deviceId: input.deviceId,
      backgroundPath: input.backgroundPath,
    }
    if (prior) return previous.map((item) => item.id === prior.id ? canvas : item)
    return previous.length ? [...previous, canvas] : [canvas]
  })()
  const canvases = incomingCanvases.map((canvas) => ({
    ...canvas,
    backgroundPath: persistAsset(canvas.backgroundPath, canvas.id),
  }))
  const selected = canvases.find((canvas) => canvas.id === requestedSelectedCanvasId && canvas.kind === 'layout')
    ?? canvases.find((canvas) => canvas.kind === 'layout')
    ?? canvases[0]
  const rootSnapshot = selected ?? {
    width: input.width,
    height: input.height,
    summary: input.summary,
    layers: input.layers,
    prompt: input.prompt,
    negative: input.negative,
    seed: input.seed,
    steps: input.steps,
    cfg: input.cfg,
    modelBundleId: input.modelBundleId,
    deviceId: input.deviceId,
    backgroundPath: persistAsset(input.backgroundPath, 'project-background'),
  }
  const project: ProjectDocument = {
    schemaVersion: 2,
    id,
    name: input.name.trim() || '未命名 Project',
    canvases,
    selectedCanvasId: canvases.some((canvas) => canvas.id === requestedSelectedCanvasId)
      ? requestedSelectedCanvasId
      : selected?.id,
    board: input.board ?? existing?.board ?? { columns: 2 },
    width: rootSnapshot.width,
    height: rootSnapshot.height,
    summary: rootSnapshot.summary,
    layers: rootSnapshot.layers,
    prompt: rootSnapshot.prompt,
    negative: rootSnapshot.negative,
    seed: rootSnapshot.seed,
    steps: rootSnapshot.steps,
    cfg: rootSnapshot.cfg,
    instanceId: input.instanceId,
    modelBundleId: rootSnapshot.modelBundleId,
    deviceId: rootSnapshot.deviceId,
    backgroundPath: rootSnapshot.backgroundPath,
    seriesId: input.seriesId?.trim() || existing?.seriesId || undefined,
    page: input.page ?? existing?.page ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  writeProject(project)
  return project
}

export function deleteProject(id: string): void {
  if (!existsSync(projectDir(id))) return
  rmSync(projectDir(id), { recursive: true, force: true })
}
