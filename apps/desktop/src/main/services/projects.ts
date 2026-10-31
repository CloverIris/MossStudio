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

/** Only the current schema is understood; older project files are simply not opened. */
const SCHEMA_VERSION = 3

function readProject(id: string): ProjectDocument | null {
  try {
    const raw = JSON.parse(readFileSync(projectFile(id), 'utf8')) as ProjectDocument
    if (!raw || typeof raw.id !== 'string') return null
    if (raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.canvases)) return null
    return raw
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
    width: canvas?.width ?? 1024,
    height: canvas?.height ?? 1024,
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
  canvases: ProjectCanvas[]
  selectedCanvasId?: string
  seriesId?: string
  page?: number
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
  const canvases = input.canvases.map((canvas) => ({
    ...canvas,
    backgroundPath: persistAsset(canvas.backgroundPath, canvas.id),
  }))
  const selected = canvases.find((canvas) => canvas.id === input.selectedCanvasId)
    ?? canvases.find((canvas) => canvas.kind === 'layout')
    ?? canvases[0]
  const project: ProjectDocument = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: input.name.trim() || '未命名 Project',
    canvases,
    selectedCanvasId: selected?.id,
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
