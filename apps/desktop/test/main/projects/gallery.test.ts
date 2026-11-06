import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()
const external = useTempDir('mossstudio-gallery-ext-')

type Gallery = typeof import('@main/services/gallery')
type SettingsModule = typeof import('@main/services/settings')
let gallery: Gallery
let settingsModule: SettingsModule
let electron: typeof import('electron')

beforeEach(async () => {
  vi.resetModules()
  gallery = await import('@main/services/gallery')
  settingsModule = await import('@main/services/settings')
  // Same module graph as the freshly imported service.
  electron = await import('electron')
})

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...settingsModule.DEFAULT_SETTINGS, ...patch }
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

/** Minimal PNG: signature, IHDR with the given size, optional tEXt chunks, IEND. */
function png(width: number, height: number, text: Record<string, string> = {}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...Object.entries(text).map(([key, value]) =>
      chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'utf8')])),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function put(path: string, content: string | Buffer, mtimeSeconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds)
  return path
}
const outputs = (): string => join(dataRoot(), 'outputs')

describe('galleryRoots', () => {
  it('includes existing outputs, configured roots and instance outputs only', async () => {
    mkdirSync(outputs(), { recursive: true })
    mkdirSync(join(dataRoot(), 'instances', 'a', 'outputs'), { recursive: true })
    mkdirSync(join(dataRoot(), 'instances', 'b'), { recursive: true })
    const roots = await gallery.galleryRoots(settings({ galleryRoots: [external(), join(external(), 'missing'), ''] }))
    expect(roots.sort()).toEqual([outputs(), external(), join(dataRoot(), 'instances', 'a', 'outputs')].sort())
  })

  it('drops the default outputs folder when it does not exist', async () => {
    expect(await gallery.galleryRoots(settings())).toEqual([])
  })
})

describe('listGallery', () => {
  it('lists images newest first with PNG dimensions and skips hidden, tooling and non-image files', async () => {
    put(join(outputs(), 'old.png'), png(64, 32), 1_000)
    put(join(outputs(), 'nested', 'new.jpg'), 'jpeg', 3_000)
    put(join(outputs(), 'mid.webp'), 'webp', 2_000)
    put(join(outputs(), 'notes.txt'), 'x')
    put(join(outputs(), '.hidden.png'), png(1, 1))
    put(join(outputs(), 'node_modules', 'x.png'), png(1, 1))
    put(join(outputs(), '.cache', 'y.png'), png(1, 1))

    const page = await gallery.listGallery(settings())
    expect(page.items.map((item) => item.name)).toEqual(['new.jpg', 'mid.webp', 'old.png'])
    expect(page.total).toBe(3)
    expect(page.nextCursor).toBeNull()
    const old = page.items[2]!
    expect(old).toMatchObject({ width: 64, height: 32, ext: '.png', root: outputs(), dir: outputs() })
    expect(old.id).toMatch(/^[a-f0-9]{16}$/)
    expect(page.items[0]!.width).toBeUndefined()
  })

  it('paginates with a numeric cursor and filters by query and root', async () => {
    for (let i = 0; i < 5; i++) put(join(outputs(), `img-${i}.png`), png(1, 1), 1_000 + i)
    put(join(external(), 'cat.png'), png(1, 1), 10)
    const s = settings({ galleryRoots: [external()] })

    const first = await gallery.listGallery(s, { limit: 2 })
    expect(first.items.map((i) => i.name)).toEqual(['img-4.png', 'img-3.png'])
    expect(first.nextCursor).toBe('2')
    const last = await gallery.listGallery(s, { limit: 2, cursor: '4' })
    expect(last.items.map((i) => i.name)).toEqual(['img-0.png', 'cat.png'])
    expect(last.nextCursor).toBeNull()
    expect((await gallery.listGallery(s, { cursor: 'garbage', limit: 1 })).items[0]!.name).toBe('img-4.png')

    expect((await gallery.listGallery(s, { query: '  CAT ' })).items.map((i) => i.name)).toEqual(['cat.png'])
    expect((await gallery.listGallery(s, { root: external() })).total).toBe(1)
    expect((await gallery.listGallery(s, { root: join(external(), 'none') })).total).toBe(0)
  })

  it('stops descending after five levels', async () => {
    put(join(outputs(), '1/2/3/4/5/ok.png'), png(1, 1))
    put(join(outputs(), '1/2/3/4/5/6/deep.png'), png(1, 1))
    expect((await gallery.listGallery(settings())).items.map((i) => i.name)).toEqual(['ok.png'])
  })

  it('caches a scan for a few seconds', async () => {
    put(join(outputs(), 'a.png'), png(1, 1))
    expect((await gallery.listGallery(settings())).total).toBe(1)
    put(join(outputs(), 'b.png'), png(1, 1))
    expect((await gallery.listGallery(settings())).total).toBe(1)
  })
})

describe('galleryDetail', () => {
  it('reads PNG text chunks and a sidecar JSON, sidecar winning', async () => {
    const file = put(join(outputs(), 'a.png'), png(16, 8, { prompt: 'png prompt', seed: '7', negative_prompt: 'bad' }))
    put(`${file}.json`, JSON.stringify({ prompt: 'sidecar prompt', seed: 42, nested: { ignored: true } }))
    const detail = await gallery.galleryDetail(file)
    expect(detail).toMatchObject({
      path: file,
      name: 'a.png',
      root: outputs(),
      width: 16,
      height: 8,
      prompt: 'sidecar prompt',
      negativePrompt: 'bad',
      seed: 42,
      ext: '.png',
    })
  })

  it('falls back to the sidecar next to the stem and alternative keys', async () => {
    const file = put(join(outputs(), 'b.jpg'), 'jpeg')
    put(join(outputs(), 'b.json'), JSON.stringify({ parameters: 'steps: 4', 'Negative prompt': 'n', Seed: 'abc' }))
    const detail = await gallery.galleryDetail(file)
    expect(detail.prompt).toBe('steps: 4')
    expect(detail.parameters).toBe('steps: 4')
    expect(detail.negativePrompt).toBe('n')
    expect(detail.seed).toBeNull()
    expect(detail.width).toBeUndefined()
  })

  it('refuses files outside the gallery roots but allows the home background', async () => {
    const outside = put(join(external(), 'x.png'), png(2, 2))
    await expect(gallery.galleryDetail(outside)).rejects.toThrow('文件不在画廊目录中')
    settingsModule.updateSettings({ homeBackground: outside })
    const detail = await gallery.galleryDetail(outside)
    expect(detail.root).toBe(external())
    expect(detail.width).toBe(2)
  })

  it('refuses a traversal path that only looks like it is inside a root', async () => {
    mkdirSync(outputs(), { recursive: true })
    const sibling = put(join(dataRoot(), 'outputs-evil', 'x.png'), png(1, 1))
    await expect(gallery.galleryDetail(join(outputs(), '..', 'outputs-evil', 'x.png'))).rejects.toThrow('文件不在画廊目录中')
    await expect(gallery.galleryDetail(sibling)).rejects.toThrow('文件不在画廊目录中')
  })
})

describe('readGalleryFile / revealInFolder', () => {
  it('returns base64 content with a MIME type from the extension', async () => {
    const pngFile = put(join(outputs(), 'a.png'), png(1, 1))
    const webp = put(join(outputs(), 'a.webp'), 'w')
    const jpg = put(join(outputs(), 'a.JPG'), 'j')
    expect(await gallery.readGalleryFile(pngFile)).toEqual({ base64: png(1, 1).toString('base64'), mime: 'image/png' })
    expect((await gallery.readGalleryFile(webp)).mime).toBe('image/webp')
    expect((await gallery.readGalleryFile(jpg)).mime).toBe('image/jpeg')
  })

  it('refuses files outside the roots', async () => {
    mkdirSync(outputs(), { recursive: true })
    const outside = put(join(external(), 'x.png'), 'x')
    await expect(gallery.readGalleryFile(outside)).rejects.toThrow('文件不在画廊目录中')
    await expect(gallery.revealInFolder(outside)).rejects.toThrow('文件不在画廊目录中')
  })

  it('reveals a gallery file through the file manager', async () => {
    if (process.platform === 'win32') return
    const file = put(join(outputs(), 'a.png'), 'x')
    const reveal = vi.spyOn(electron.shell, 'showItemInFolder')
    await gallery.revealInFolder(file)
    expect(reveal).toHaveBeenCalledWith(file)
  })
})

describe('registerGalleryProtocol', () => {
  async function handler(): Promise<(request: Request) => Promise<Response>> {
    const handle = vi.spyOn(electron.protocol, 'handle')
    gallery.registerGalleryProtocol()
    expect(handle).toHaveBeenCalledWith('clover', expect.any(Function))
    return handle.mock.calls[0]![1] as unknown as (request: Request) => Promise<Response>
  }

  it('serves files inside the roots and the home background, and nothing else', async () => {
    const file = put(join(outputs(), 'a.png'), png(1, 1))
    const outside = put(join(external(), 'x.webp'), 'x')
    const serve = await handler()
    const ok = await serve(new Request(gallery.cloverUrl(file)))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(png(1, 1))

    expect((await serve(new Request(gallery.cloverUrl(outside)))).status).toBe(403)
    expect((await serve(new Request('clover://other?path=x'))).status).toBe(404)
    expect((await serve(new Request('clover://local'))).status).toBe(400)
    expect((await serve(new Request(gallery.cloverUrl(join(outputs(), 'missing.png'))))).status).toBe(404)

    settingsModule.updateSettings({ homeBackground: outside })
    const background = await serve(new Request(gallery.cloverUrl(outside)))
    expect(background.status).toBe(200)
    expect(background.headers.get('content-type')).toBe('image/webp')
  })

  it('builds clover:// URLs that round-trip any path', () => {
    const path = '/a b/c&d?.png'
    expect(new URL(gallery.cloverUrl(path)).searchParams.get('path')).toBe(path)
  })
})
