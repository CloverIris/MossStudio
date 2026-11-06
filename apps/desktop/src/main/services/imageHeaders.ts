/**
 * Pixel sizes from PNG, JPEG and WebP headers, without decoding (and without
 * an image library). A JPEG's EXIF orientation is applied, as the engine does
 * when it reads one, so the size is the one the picture is shown at.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface ImageHeader {
  format: ImageFormat
  width: number
  height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(data: Uint8Array): boolean {
  return data.length >= 8 && Buffer.from(data.buffer, data.byteOffset, 8).equals(PNG_SIGNATURE)
}

function pngSize(data: Buffer): ImageHeader | null {
  // The IHDR chunk comes first: length (4), "IHDR", width (4), height (4).
  if (data.length < 24 || data.toString('ascii', 12, 16) !== 'IHDR') return null
  return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/** EXIF orientation 1–8 from an APP1 segment, or 1. */
function exifOrientation(segment: Buffer): number {
  if (segment.length < 14 || segment.toString('ascii', 0, 6) !== 'Exif\0\0') return 1
  const tiff = segment.subarray(6)
  const order = tiff.toString('ascii', 0, 2)
  if (order !== 'II' && order !== 'MM') return 1
  const little = order === 'II'
  const u16 = (offset: number): number => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset))
  const u32 = (offset: number): number => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset))
  if (tiff.length < 8) return 1
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return 1
  const count = u16(ifd)
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > tiff.length) return 1
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

function jpegSize(data: Buffer): ImageHeader | null {
  let offset = 2
  let orientation = 1
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return null
    const marker = data[offset + 1]!
    // Fill bytes and stand-alone markers carry no length.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = data.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > data.length) return null
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (marker === 0xe1) orientation = exifOrientation(data.subarray(offset + 4, offset + 2 + length))
    if (isFrame) {
      if (length < 7) return null
      const height = data.readUInt16BE(offset + 5)
      const width = data.readUInt16BE(offset + 7)
      const swap = orientation >= 5
      return { format: 'jpeg', width: swap ? height : width, height: swap ? width : height }
    }
    offset += 2 + length
  }
  return null
}

function webpSize(data: Buffer): ImageHeader | null {
  if (data.length < 30 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = data.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    // Key frame start code 9d 01 2a, then 14-bit width and height.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null
    return { format: 'webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (data[20] !== 0x2f) return null
    const bits = data.readUInt32LE(21)
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { format: 'webp', width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
  }
  return null
}

/** The format and size of an image from its first bytes, or null when it is none of PNG, JPEG, WebP. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (isPng(data)) return pngSize(data)
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return jpegSize(data)
    return webpSize(data)
  } catch {
    return null
  }
}
