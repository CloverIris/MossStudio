import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { protocol, shell } from 'electron'
import type { GalleryDetail, GalleryGeneration, GalleryItem, GalleryPage, JobRecord, Settings } from '@shared/types'
import { revealInFileManager } from '../lib/fileManager'
import { isInside, paths } from '../lib/paths'
import { getSettings } from './settings'
import { listJobs } from './supervisor'
import { getTrainingHost } from './trainingHosts'
import { previewsDir } from './jobPreview'
import { isProjectAssetPath, projectsRootDir } from './projects'
import {
  GALLERY_IMAGE_EXT as IMAGE_EXT,
  assertTrashable,
  describePrompt,
  generationFromJob,
  generationFromSidecar,
  mergeSidecar,
  mergeSidecars,
  parseA1111,
  sidecarPath,
  sidecarRecord,
  sidecarsToTrash,
} from './galleryMeta'
const SKIP_DIR = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv'])

interface ScanCache {
  key: string
  at: number
  items: GalleryItem[]
}

let cache: ScanCache | null = null

/** Sidecar contents per image, keyed by path and image mtime, so rescans stay cheap. */
const sidecarCache = new Map<string, { mtime: number; sidecar: Record<string, unknown> | null }>()

interface JobOutput {
  job: JobRecord
  output: { width?: number; height?: number; seed?: number }
}

/** Recent job records by output path (the supervisor keeps the last 60 jobs). */
async function jobIndex(): Promise<Map<string, JobOutput>> {
  const index = new Map<string, JobOutput>()
  try {
    for (const job of await listJobs()) {
      if (job.kind === 'training') continue
      for (const output of job.outputs ?? []) index.set(resolve(output.path), { job, output })
    }
  } catch {
    // job history is optional context
  }
  return index
}

function hostName(hostId: string | undefined): string | undefined {
  if (!hostId) return undefined
  try {
    return getTrainingHost(getSettings(), hostId)?.name
  } catch {
    return undefined
  }
}

async function cachedSidecar(file: string, mtime: number): Promise<Record<string, unknown> | null> {
  const key = resolve(file)
  const hit = sidecarCache.get(key)
  if (hit && hit.mtime === mtime) return hit.sidecar
  const sidecar = await sidecarFor(file)
  sidecarCache.set(key, { mtime, sidecar })
  return sidecar
}

/** Items whose sidecar has been read since the last scan. */
const enriched = new WeakSet<GalleryItem>()

/**
 * Fills prompt / project / job from sidecars, lazily: only for the items a
 * search, a project filter or the returned page needs, a few at a time, so a
 * large folder never means thousands of reads up front.
 */
async function enrich(items: readonly GalleryItem[]): Promise<void> {
  const pending = items.filter((item) => !enriched.has(item))
  for (let index = 0; index < pending.length; index += 32) {
    await Promise.all(
      pending.slice(index, index + 32).map(async (item) => {
        const sidecar = await cachedSidecar(item.path, item.mtime)
        enriched.add(item)
        if (!sidecar) return
        const generation = generationFromSidecar(sidecar)
        const prompt = generation?.description ?? (typeof sidecar['prompt'] === 'string' ? describePrompt(sidecar['prompt']).description : '')
        if (prompt && !item.prompt) item.prompt = prompt
        if (generation?.projectId && !item.projectId) item.projectId = generation.projectId
        if (generation?.jobId && !item.jobId) item.jobId = generation.jobId
      }),
    )
  }
}

export async function galleryRoots(settings: Settings = getSettings()): Promise<string[]> {
  const roots = new Set<string>()
  roots.add(join(paths.root(), 'outputs'))
  for (const dir of settings.galleryRoots) {
    if (dir && existsSync(dir)) roots.add(resolve(dir))
  }
  try {
    const ids = await readdir(paths.instances())
    for (const id of ids) {
      const dir = join(paths.instances(), id, 'outputs')
      if (existsSync(dir)) roots.add(dir)
    }
  } catch {
    // no instances yet
  }
  return [...roots].filter((dir) => existsSync(dir))
}

function idFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: GalleryItem[],
  jobs: Map<string, JobOutput>,
): Promise<void> {
  if (depth > 5) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue
      await walk(root, full, depth + 1, out, jobs)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (!IMAGE_EXT.has(ext)) continue
    try {
      const info = await stat(full)
      const dimensions = await readPngSize(full)
      // Sidecars are read later, only when needed (see `enrich`).
      const job = jobs.get(resolve(full))
      const prompt = job ? describePrompt(job.job.params.prompt).description : undefined
      const projectId = job?.job.projectId
      const jobId = job?.job.id
      out.push({
        id: idFor(full),
        path: full,
        name: entry.name,
        dir,
        root,
        size: info.size,
        mtime: info.mtimeMs,
        ext,
        width: dimensions?.width,
        height: dimensions?.height,
        ...(prompt ? { prompt } : {}),
        ...(projectId ? { projectId } : {}),
        ...(jobId ? { jobId } : {}),
      })
    } catch {
      // ignore unreadable files
    }
  }
}

async function readPngSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(24)
      await handle.read(buffer, 0, 24, 0)
      if (buffer.toString('ascii', 1, 4) !== 'PNG') return null
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

function readPngText(file: string): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const buffer = readFileSync(file)
    if (buffer.toString('ascii', 1, 4) !== 'PNG') return result
    let offset = 8
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)
      if (type === 'tEXt' || type === 'iTXt') {
        const data = buffer.subarray(offset + 8, offset + 8 + length)
        const zero = data.indexOf(0)
        if (zero > 0) {
          const key = data.toString('latin1', 0, zero)
          const value = data.toString('utf8', zero + 1)
          result[key] = value
        }
      }
      if (type === 'IEND') break
      offset += 12 + length
    }
  } catch {
    // ignore
  }
  return result
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** `image.json` (what the engine and MossStudio write) merged over `image.png.json`. */
async function sidecarFor(file: string): Promise<Record<string, unknown> | null> {
  const [own, stem] = await Promise.all([readJson(`${file}.json`), readJson(sidecarPath(file))])
  return mergeSidecars(own, stem)
}

async function metadataFor(file: string): Promise<Record<string, string>> {
  const text = readPngText(file)
  const sidecar = await sidecarFor(file)
  const merged: Record<string, string> = { ...text }
  if (sidecar) {
    for (const [key, value] of Object.entries(sidecar)) {
      if (typeof value === 'string' || typeof value === 'number') merged[key] = String(value)
    }
  }
  return merged
}

async function scan(settings: Settings): Promise<GalleryItem[]> {
  const roots = await galleryRoots(settings)
  const key = roots.join('|')
  if (cache && cache.key === key && Date.now() - cache.at < 5000) return cache.items
  const items: GalleryItem[] = []
  const jobs = await jobIndex()
  await Promise.all(roots.map((root) => walk(root, root, 0, items, jobs)))
  items.sort((a, b) => b.mtime - a.mtime)
  cache = { key, at: Date.now(), items }
  return items
}

export async function listGallery(
  settings: Settings,
  options: { cursor?: string; limit?: number; query?: string; root?: string; projectId?: string; since?: number } = {},
): Promise<GalleryPage> {
  const all = await scan(settings)
  const query = options.query?.trim().toLowerCase()
  const root = options.root ? resolve(options.root) : null
  const candidates = all.filter((item) => {
    if (root && item.root !== root) return false
    return options.since === undefined || item.mtime >= options.since
  })
  // Searching prompts or filtering by project needs every candidate's sidecar.
  if (query || options.projectId) await enrich(candidates)
  const filtered = candidates.filter((item) => {
    if (options.projectId && item.projectId !== options.projectId) return false
    if (!query) return true
    return (
      item.name.toLowerCase().includes(query) ||
      item.path.toLowerCase().includes(query) ||
      Boolean(item.prompt?.toLowerCase().includes(query))
    )
  })
  const limit = options.limit ?? 48
  const offset = Number.parseInt(options.cursor ?? '0', 10) || 0
  const items = filtered.slice(offset, offset + limit)
  await enrich(items)
  return {
    items,
    nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
    total: filtered.length,
    scannedAt: new Date().toISOString(),
  }
}

export async function galleryDetail(file: string): Promise<GalleryDetail> {
  const settings = getSettings()
  const roots = await galleryRoots(settings)
  const background = settings.homeBackground
  if (!roots.some((root) => isInside(root, file)) && file !== background) {
    throw new Error('文件不在画廊目录中')
  }
  const info = await stat(file)
  const dimensions = await readPngSize(file)
  const meta = await metadataFor(file)
  const job = (await jobIndex()).get(resolve(file))
  const rawPrompt = job?.job.params.prompt || (meta['prompt'] ?? meta['Prompt'] ?? meta['parameters'] ?? meta['Description'])
  const a1111 = rawPrompt ? parseA1111(rawPrompt) : null
  const generation: GalleryGeneration | undefined = job
    ? generationFromJob(job.job, job.output, hostName(job.job.hostId))
    : (generationFromSidecar(await sidecarFor(file)) ?? (a1111 ? a1111Generation(a1111) : undefined))
  // Show and reuse what the person wrote, not a compiled layout or a settings blob.
  const prompt = generation?.description || (rawPrompt ? describePrompt(rawPrompt).description : undefined) || undefined
  const seedRaw = meta['seed'] ?? meta['Seed']
  const parsedSeed = seedRaw ? Number.parseInt(seedRaw, 10) : null
  const seed = generation?.seed ?? (Number.isFinite(parsedSeed) ? parsedSeed : null)
  return {
    id: idFor(file),
    path: file,
    name: basename(file),
    dir: dirname(file),
    root: roots.find((root) => isInside(root, file)) ?? dirname(file),
    size: info.size,
    mtime: info.mtimeMs,
    ext: extname(file).toLowerCase(),
    width: dimensions?.width,
    height: dimensions?.height,
    prompt,
    negativePrompt: job?.job.params.negativePrompt || (meta['negative_prompt'] ?? meta['Negative prompt'] ?? a1111?.negativePrompt),
    parameters: meta['parameters'],
    seed,
    ...(generation?.projectId ? { projectId: generation.projectId } : {}),
    ...(generation?.jobId ? { jobId: generation.jobId } : {}),
    ...(generation ? { generation } : {}),
  }
}

function a1111Generation(parsed: NonNullable<ReturnType<typeof parseA1111>>): GalleryGeneration | undefined {
  const generation: GalleryGeneration = {
    steps: parsed.steps,
    cfg: parsed.cfg,
    seed: parsed.seed,
    width: parsed.width,
    height: parsed.height,
    modelName: parsed.modelName,
    description: parsed.prompt || undefined,
  }
  const defined = Object.entries(generation).filter(([, value]) => value !== undefined)
  return defined.length ? (Object.fromEntries(defined) as GalleryGeneration) : undefined
}

/**
 * Moves one gallery image, and the sidecar that belongs to it, to the OS
 * trash. The real (symlink-resolved) path must lie inside a real gallery root.
 */
export async function trashGalleryItem(file: string): Promise<{ trashed: string[] }> {
  const roots = await galleryRoots()
  let real: string
  try {
    real = await realpath(file)
  } catch {
    throw new Error('找不到这张图片，可能已被移动或删除')
  }
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => resolve(root))))
  assertTrashable(real, realRoots)
  if (!(await stat(real)).isFile()) throw new Error('只能删除图片文件')
  const sidecars = sidecarsToTrash(real, existsSync, (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch {
      return undefined
    }
  })
  await shell.trashItem(real)
  const trashed = [real]
  for (const sidecar of sidecars) {
    try {
      await shell.trashItem(sidecar)
      trashed.push(sidecar)
    } catch {
      // the image is already gone; a leftover sidecar is harmless
    }
  }
  cache = null
  sidecarCache.delete(resolve(file))
  sidecarCache.delete(real)
  return { trashed }
}

/**
 * Records how each output of a finished generation job was made in its JSON
 * sidecar (project, model, steps, CFG, where it ran), keeping whatever the
 * engine already wrote. Job records are pruned; the sidecar stays with the image.
 */
export async function recordJobOutputs(job: JobRecord): Promise<boolean> {
  if (job.kind === 'training' || job.state !== 'succeeded' || !job.outputs?.length) return false
  const name = hostName(job.hostId)
  const roots = await galleryRoots()
  for (const output of job.outputs) {
    if (!output.path || !IMAGE_EXT.has(extname(output.path).toLowerCase())) continue
    // Only ever write next to images the gallery shows.
    if (!roots.some((root) => isInside(root, output.path))) continue
    const target = sidecarPath(output.path)
    try {
      let existing: Record<string, unknown> | null = null
      if (existsSync(target)) {
        // Never overwrite a file we cannot read as a sidecar (another tool's JSON, say).
        let parsed: unknown
        try {
          parsed = JSON.parse(await readFile(target, 'utf8'))
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        existing = parsed as Record<string, unknown>
      }
      await writeFile(target, JSON.stringify(mergeSidecar(existing, sidecarRecord(job, output, name)), null, 2), 'utf8')
      sidecarCache.delete(resolve(output.path))
    } catch {
      // best effort: the image itself is the result
    }
  }
  cache = null
  return true
}

export async function readGalleryFile(file: string): Promise<{ base64: string; mime: string }> {
  const roots = await galleryRoots()
  if (!roots.some((root) => isInside(root, file))) throw new Error('文件不在画廊目录中')
  const info = await stat(file)
  if (info.size > 32 * 1024 * 1024) throw new Error('图片超过 32 MB')
  const mime =
    extname(file).toLowerCase() === '.png'
      ? 'image/png'
      : extname(file).toLowerCase() === '.webp'
        ? 'image/webp'
        : 'image/jpeg'
  return { base64: (await readFile(file)).toString('base64'), mime }
}

export async function revealInFolder(file: string): Promise<void> {
  const roots = await galleryRoots()
  if (!roots.some((root) => isInside(root, file))) throw new Error('文件不在画廊目录中')
  await revealInFileManager(file)
}

/** The picture types clover:// hands out from the Studio folders (assets may hold other copied files). */
const STUDIO_PICTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/**
 * The symlink-resolved path of a live preview (cache/previews) or a picture in
 * a project's assets folder, or null when `file` is neither. The check runs on
 * the resolved path, and callers read that path, so a link placed in either
 * folder (or swapped in after the check) cannot hand out a file from elsewhere.
 */
export async function studioPicturePath(file: string): Promise<string | null> {
  let real: string
  try {
    real = await realpath(file)
  } catch {
    return null
  }
  if (!STUDIO_PICTURE_EXT.has(extname(real).toLowerCase())) return null
  const previews = await realpath(previewsDir()).catch(() => null)
  if (previews && isInside(previews, real) && real !== previews) return real
  const projects = await realpath(projectsRootDir()).catch(() => null)
  if (!projects || !isInside(projects, real)) return null
  // Re-anchor on the lexical root so the id/assets shape is checked on the resolved path.
  return isProjectAssetPath(join(projectsRootDir(), relative(projects, real))) ? real : null
}

export function registerGalleryProtocol(): void {
  protocol.handle('clover', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'local') return new Response('Not found', { status: 404 })
      const file = url.searchParams.get('path')
      if (!file) return new Response('Missing path', { status: 400 })
      const settings = getSettings()
      const roots = await galleryRoots(settings)
      const listed = roots.some((root) => isInside(root, file)) || file === settings.homeBackground
      const target = listed ? file : await studioPicturePath(file)
      if (!target) return new Response('Forbidden', { status: 403 })
      const ext = extname(target).toLowerCase()
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : 'application/octet-stream'
      const data = await readFile(target)
      // Readable by a canvas (crossOrigin='anonymous'); which files are served is decided above.
      return new Response(new Uint8Array(data), { headers: { 'content-type': mime, 'access-control-allow-origin': '*' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function cloverUrl(file: string): string {
  return `clover://local?path=${encodeURIComponent(file)}`
}
