import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readImageHeader } from '@main/services/imageHeaders'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()
const pictures = useTempDir('mossstudio-pictures-')

let assets: typeof import('@main/services/studioAssets')
let electron: typeof import('electron')

beforeEach(async () => {
  vi.resetModules()
  assets = await import('@main/services/studioAssets')
  electron = await import('electron')
})

// --- tiny image writers ------------------------------------------------------

function crc32(data: Buffer): number {
  let crc = ~0
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real grayscale PNG (decodable), `width`×`height`. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const raw = Buffer.alloc((width + 1) * height)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** JPEG markers up to the frame header (enough for a size), optionally with an EXIF orientation. */
function jpeg(width: number, height: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0, 0, 1, 0, 1, 0, 0]))
  if (orientation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4)
    tiff.write('MM', 0, 'ascii')
    tiff.writeUInt16BE(42, 2)
    tiff.writeUInt32BE(8, 4)
    tiff.writeUInt16BE(1, 8)
    tiff.writeUInt16BE(0x0112, 10)
    tiff.writeUInt16BE(3, 12)
    tiff.writeUInt32BE(1, 14)
    tiff.writeUInt16BE(orientation, 18)
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
    const head = Buffer.from([0xff, 0xe1, 0, 0])
    head.writeUInt16BE(payload.length + 2, 2)
    parts.push(head, payload)
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  parts.push(sof, Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

function webpVp8x(width: number, height: number): Buffer {
  const data = Buffer.alloc(30)
  data.write('RIFF', 0, 'ascii')
  data.writeUInt32LE(22, 4)
  data.write('WEBP', 8, 'ascii')
  data.write('VP8X', 12, 'ascii')
  data.writeUInt32LE(10, 16)
  data.writeUIntLE(width - 1, 24, 3)
  data.writeUIntLE(height - 1, 27, 3)
  return data
}

function webpLossless(width: number, height: number): Buffer {
  const data = Buffer.alloc(30)
  data.write('RIFF', 0, 'ascii')
  data.write('WEBP', 8, 'ascii')
  data.write('VP8L', 12, 'ascii')
  data[20] = 0x2f
  data.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21)
  return data
}

function webpLossy(width: number, height: number): Buffer {
  const data = Buffer.alloc(30)
  data.write('RIFF', 0, 'ascii')
  data.write('WEBP', 8, 'ascii')
  data.write('VP8 ', 12, 'ascii')
  data[23] = 0x9d
  data[24] = 0x01
  data[25] = 0x2a
  data.writeUInt16LE(width, 26)
  data.writeUInt16LE(height, 28)
  return data
}

const assetsDir = (projectId = 'project-1'): string => join(dataRoot(), 'projects', projectId, 'assets')

describe('readImageHeader', () => {
  it('reads PNG, JPEG and the three WebP flavours', () => {
    expect(readImageHeader(png(32, 16))).toEqual({ format: 'png', width: 32, height: 16 })
    expect(readImageHeader(jpeg(640, 480))).toEqual({ format: 'jpeg', width: 640, height: 480 })
    expect(readImageHeader(webpVp8x(1920, 1080))).toEqual({ format: 'webp', width: 1920, height: 1080 })
    expect(readImageHeader(webpLossless(300, 200))).toEqual({ format: 'webp', width: 300, height: 200 })
    expect(readImageHeader(webpLossy(800, 600))).toEqual({ format: 'webp', width: 800, height: 600 })
  })

  it('applies a JPEG EXIF rotation (as the engine does) and ignores the others', () => {
    expect(readImageHeader(jpeg(640, 480, 6))).toMatchObject({ width: 480, height: 640 })
    expect(readImageHeader(jpeg(640, 480, 8))).toMatchObject({ width: 480, height: 640 })
    expect(readImageHeader(jpeg(640, 480, 3))).toMatchObject({ width: 640, height: 480 })
  })

  it('returns null for anything else or a cut-off header', () => {
    expect(readImageHeader(Buffer.from('GIF89a......'))).toBeNull()
    expect(readImageHeader(Buffer.alloc(0))).toBeNull()
    expect(readImageHeader(png(4, 4).subarray(0, 12))).toBeNull()
    expect(readImageHeader(jpeg(10, 10).subarray(0, 25))).toBeNull()
  })
})

describe('importImageFile / importImageBytes', () => {
  it('copies a picture into the project assets under its content hash and reports its size', async () => {
    const source = join(pictures(), 'photo.png')
    writeFileSync(source, png(64, 32))
    const imported = await assets.importImageFile('project-1', source)
    expect(imported).toEqual({ path: expect.stringMatching(/[0-9a-f]{24}\.png$/), width: 64, height: 32 })
    expect(imported.path.startsWith(assetsDir())).toBe(true)
    expect(readFileSync(imported.path).equals(readFileSync(source))).toBe(true)
    // The same picture again is the same asset, written once.
    expect((await assets.importImageFile('project-1', source)).path).toBe(imported.path)
    expect(readdirSync(assetsDir())).toHaveLength(1)
  })

  it('two imports of the same picture at once both succeed with the one asset', async () => {
    const picture = png(48, 48)
    const results = await Promise.all(Array.from({ length: 6 }, () => assets.importImageBytes('project-1', picture)))
    expect(new Set(results.map((result) => result.path)).size).toBe(1)
    expect(readdirSync(assetsDir())).toEqual([results[0]!.path.split(/[\\/]/).pop()])
    expect(readFileSync(results[0]!.path).equals(picture)).toBe(true)
  })

  it('stores a JPEG as .jpg with its displayed size', async () => {
    const imported = await assets.importImageBytes('project-1', jpeg(400, 300, 6))
    expect(imported.path.endsWith('.jpg')).toBe(true)
    expect(imported).toMatchObject({ width: 300, height: 400 })
  })

  it('converts a WebP to PNG (the engine reads PNG and JPEG only)', async () => {
    vi.spyOn(electron.nativeImage, 'createFromBuffer').mockReturnValue({ isEmpty: () => false, toPNG: () => png(50, 40) } as never)
    const imported = await assets.importImageBytes('project-1', webpVp8x(50, 40))
    expect(imported).toMatchObject({ path: expect.stringMatching(/\.png$/), width: 50, height: 40 })
    expect(readImageHeader(readFileSync(imported.path))?.format).toBe('png')
  })

  it('says what to do with a WebP Electron cannot decode', async () => {
    await expect(assets.importImageBytes('project-1', webpLossy(10, 10))).rejects.toMatchObject({
      code: 'E_IMAGE_FORMAT', message: '无法读取这张 WebP 图片，请先转换为 PNG 或 JPEG 再导入',
    })
  })

  it('refuses other formats, empty or oversized files, giant pictures and bad project ids', async () => {
    await expect(assets.importImageBytes('project-1', Buffer.from('GIF89a'))).rejects.toMatchObject({ code: 'E_IMAGE_FORMAT', message: '只能导入 PNG、JPEG 或 WebP 图片' })
    await expect(assets.importImageBytes('project-1', Buffer.alloc(0))).rejects.toMatchObject({ code: 'E_IMAGE_FORMAT' })
    await expect(assets.importImageBytes('project-1', png(20000, 10))).rejects.toMatchObject({ code: 'E_IMAGE_TOO_LARGE' })
    await expect(assets.importImageBytes('project-1', Buffer.alloc(assets.MAX_IMPORT_BYTES + 1))).rejects.toMatchObject({ code: 'E_IMAGE_TOO_LARGE' })
    await expect(assets.importImageBytes('../escape', png(4, 4))).rejects.toMatchObject({ code: 'E_INPUT' })
    await expect(assets.importImageFile('project-1', join(pictures(), 'gone.png'))).rejects.toMatchObject({ code: 'E_INPUT_PATH' })
    mkdirSync(join(pictures(), 'folder'))
    await expect(assets.importImageFile('project-1', join(pictures(), 'folder'))).rejects.toMatchObject({ code: 'E_INPUT_PATH' })
    expect(() => readdirSync(join(dataRoot(), 'escape'))).toThrow()
  })
})

describe('saveMask', () => {
  it('writes the PNG as mask-<canvas>-<hash>.png in the project assets', async () => {
    const mask = png(64, 64)
    const saved = await assets.saveMask('project-1', 'canvas-7', mask)
    expect(saved.path).toMatch(/mask-canvas-7-[0-9a-f]{24}\.png$/)
    expect(saved.path.startsWith(assetsDir())).toBe(true)
    expect(readFileSync(saved.path).equals(mask)).toBe(true)
    expect((await assets.saveMask('project-1', 'canvas-7', mask)).path).toBe(saved.path)
  })

  it('keeps an odd canvas id from reaching the file name', async () => {
    const saved = await assets.saveMask('project-1', '../../x', png(4, 4))
    expect(saved.path.startsWith(join(assetsDir(), 'mask-______x-'))).toBe(true)
  })

  it('refuses anything that is not a PNG, and oversized masks', async () => {
    await expect(assets.saveMask('project-1', 'c', jpeg(4, 4))).rejects.toMatchObject({ code: 'E_IMAGE_FORMAT', message: '遮罩必须是 PNG 图片' })
    await expect(assets.saveMask('project-1', 'c', Buffer.alloc(0))).rejects.toMatchObject({ code: 'E_IMAGE_FORMAT' })
    const huge = Buffer.concat([png(4, 4), Buffer.alloc(assets.MAX_MASK_BYTES)])
    await expect(assets.saveMask('project-1', 'c', huge)).rejects.toMatchObject({ code: 'E_IMAGE_TOO_LARGE' })
    await expect(assets.saveMask('a/b', 'c', png(4, 4))).rejects.toMatchObject({ code: 'E_INPUT' })
  })
})
