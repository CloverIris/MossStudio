import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { codedError } from '../lib/codedError'
import { readImageHeader, isPng, type ImageHeader } from './imageHeaders'
import { PROJECT_ID_PATTERN, projectAssetsDir } from './projects'

/**
 * Pictures a Studio project takes in: images brought onto the board and the
 * masks painted on a canvas. Both land in `<project>/assets/` under a content
 * hash, so the same picture is stored once and a name can never escape the folder.
 */

/** Largest picture accepted (bytes); a 4096² RGBA PNG without compression is 64 MiB. */
export const MAX_IMPORT_BYTES = 80 * 1024 * 1024
/** Largest painted mask (bytes). */
export const MAX_MASK_BYTES = 32 * 1024 * 1024
/** Longest side the engine is asked to read. */
export const MAX_IMAGE_EDGE = 16384

export interface ImportedImage {
  path: string
  width: number
  height: number
}

function assetsDirFor(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw codedError('E_INPUT', 'Project 无效，请重新打开项目')
  return projectAssetsDir(projectId)
}

function hashOf(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 24)
}

async function writeOnce(target: string, data: Uint8Array): Promise<void> {
  try {
    if ((await stat(target)).isFile()) return
  } catch {
    // not there yet
  }
  // Unique per call: two imports of the same picture may run at once.
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, data)
  try {
    await rename(temporary, target)
  } catch (error) {
    // The other import won (on Windows a rename onto an open file can fail): its copy is the same bytes.
    await rm(temporary, { force: true }).catch(() => undefined)
    const exists = await stat(target).then((info) => info.isFile(), () => false)
    if (!exists) throw error
  }
}

function checkHeader(header: ImageHeader | null): ImageHeader {
  if (!header) throw codedError('E_IMAGE_FORMAT', '只能导入 PNG、JPEG 或 WebP 图片')
  if (header.width < 1 || header.height < 1) throw codedError('E_IMAGE_FORMAT', '图片尺寸无效')
  if (header.width > MAX_IMAGE_EDGE || header.height > MAX_IMAGE_EDGE) {
    throw codedError('E_IMAGE_TOO_LARGE', `图片太大了（最长边不超过 ${MAX_IMAGE_EDGE} 像素）`)
  }
  return header
}

/**
 * The engine reads PNG and JPEG only, so a WebP picture is stored as PNG.
 * Electron decodes it; when it cannot, the person is told what to do.
 */
function webpToPng(data: Uint8Array): Uint8Array {
  const image = nativeImage.createFromBuffer(Buffer.from(data))
  const png = image.isEmpty() ? null : image.toPNG()
  if (!png?.length) throw codedError('E_IMAGE_FORMAT', '无法读取这张 WebP 图片，请先转换为 PNG 或 JPEG 再导入')
  return png
}

/** Copy picture bytes into the project's assets: `<hash>.png|jpg`. */
export async function importImageBytes(projectId: string, bytes: Uint8Array): Promise<ImportedImage> {
  const dir = assetsDirFor(projectId)
  if (!bytes.byteLength) throw codedError('E_IMAGE_FORMAT', '图片是空的')
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw codedError('E_IMAGE_TOO_LARGE', '图片文件太大了（不超过 80 MB）')
  let header = checkHeader(readImageHeader(bytes))
  let data = bytes
  if (header.format === 'webp') {
    data = webpToPng(bytes)
    header = checkHeader(readImageHeader(data))
  }
  const ext = header.format === 'png' ? 'png' : 'jpg'
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${hashOf(data)}.${ext}`)
  await writeOnce(target, data)
  return { path: target, width: header.width, height: header.height }
}

/** Copy a picture file the person chose (drop, file dialog, Library) into the project's assets. */
export async function importImageFile(projectId: string, path: string): Promise<ImportedImage> {
  assetsDirFor(projectId)
  let info
  try {
    info = await stat(path)
  } catch {
    throw codedError('E_INPUT_PATH', '找不到这张图片，它可能已被移动或删除')
  }
  if (!info.isFile()) throw codedError('E_INPUT_PATH', '只能导入图片文件')
  if (info.size > MAX_IMPORT_BYTES) throw codedError('E_IMAGE_TOO_LARGE', '图片文件太大了（不超过 80 MB）')
  return importImageBytes(projectId, await readFile(path))
}

/** Write a painted mask (PNG, white = repaint) for one canvas: `mask-<canvas>-<hash>.png`. */
export async function saveMask(projectId: string, canvasId: string, png: Uint8Array): Promise<{ path: string }> {
  const dir = assetsDirFor(projectId)
  if (!png.byteLength || !isPng(png)) throw codedError('E_IMAGE_FORMAT', '遮罩必须是 PNG 图片')
  if (png.byteLength > MAX_MASK_BYTES) throw codedError('E_IMAGE_TOO_LARGE', '遮罩文件太大了')
  checkHeader(readImageHeader(png))
  const safeCanvas = canvasId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'canvas'
  await mkdir(dir, { recursive: true })
  const target = join(dir, `mask-${safeCanvas}-${hashOf(png)}.png`)
  await writeOnce(target, png)
  return { path: target }
}
