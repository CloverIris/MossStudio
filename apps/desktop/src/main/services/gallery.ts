import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { protocol } from 'electron'
import type { GalleryDetail, GalleryItem, GalleryPage, Settings } from '@shared/types'
import { revealInFileManager } from '../lib/fileManager'
import { isInside, paths } from '../lib/paths'
import { getSettings } from './settings'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const SKIP_DIR = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv'])

interface ScanCache {
  key: string
  at: number
  items: GalleryItem[]
}

let cache: ScanCache | null = null

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

async function walk(root: string, dir: string, depth: number, out: GalleryItem[]): Promise<void> {
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
      await walk(root, full, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (!IMAGE_EXT.has(ext)) continue
    try {
      const info = await stat(full)
      const dimensions = await readPngSize(full)
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

function sidecarFor(file: string): Record<string, unknown> | null {
  const candidates = [`${file}.json`, `${file.slice(0, -extname(file).length)}.json`]
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>
    } catch {
      // try next
    }
  }
  return null
}

function metadataFor(file: string): Record<string, string> {
  const text = readPngText(file)
  const sidecar = sidecarFor(file)
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
  await Promise.all(roots.map((root) => walk(root, root, 0, items)))
  items.sort((a, b) => b.mtime - a.mtime)
  cache = { key, at: Date.now(), items }
  return items
}

export async function listGallery(
  settings: Settings,
  options: { cursor?: string; limit?: number; query?: string; root?: string } = {},
): Promise<GalleryPage> {
  const all = await scan(settings)
  const query = options.query?.trim().toLowerCase()
  const root = options.root ? resolve(options.root) : null
  const filtered = all.filter((item) => {
    if (root && item.root !== root) return false
    if (!query) return true
    return item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query)
  })
  const limit = options.limit ?? 48
  const offset = Number.parseInt(options.cursor ?? '0', 10) || 0
  const items = filtered.slice(offset, offset + limit)
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
  const meta = metadataFor(file)
  const prompt = meta['prompt'] ?? meta['Prompt'] ?? meta['parameters'] ?? meta['Description']
  const seedRaw = meta['seed'] ?? meta['Seed']
  const seed = seedRaw ? Number.parseInt(seedRaw, 10) : null
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
    negativePrompt: meta['negative_prompt'] ?? meta['Negative prompt'],
    parameters: meta['parameters'],
    seed: Number.isFinite(seed) ? seed : null,
  }
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

export function registerGalleryProtocol(): void {
  protocol.handle('clover', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'local') return new Response('Not found', { status: 404 })
      const file = url.searchParams.get('path')
      if (!file) return new Response('Missing path', { status: 400 })
      const settings = getSettings()
      const roots = await galleryRoots(settings)
      const allowed = roots.some((root) => isInside(root, file)) || file === settings.homeBackground
      if (!allowed) return new Response('Forbidden', { status: 403 })
      const ext = extname(file).toLowerCase()
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : 'application/octet-stream'
      const data = await readFile(file)
      return new Response(new Uint8Array(data), { headers: { 'content-type': mime } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function cloverUrl(file: string): string {
  return `clover://local?path=${encodeURIComponent(file)}`
}
