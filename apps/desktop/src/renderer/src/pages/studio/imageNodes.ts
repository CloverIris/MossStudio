import { BOARD_GAP, cardHeight, cardWidth, imageNodeSize } from './boardLayout'

/**
 * Pictures dropped or pasted onto the board. Pure. (The image canvas itself is
 * built by `createImageCanvas` in canvases.ts.)
 */

export const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|bmp)$/i

/** Whether a dropped or pasted file is a picture the board accepts. */
export function isImageFile(file: { type: string; name: string }): boolean {
  return /^image\/(png|jpeg|webp|bmp)$/.test(file.type) || IMAGE_FILE_PATTERN.test(file.name)
}

/**
 * Board positions for pictures dropped at one point (pixel sizes as the
 * import returned them): the first card is centred on the point, the rest
 * follow to its right.
 */
export function dropPositions(
  pictures: ReadonlyArray<{ width: number; height: number }>,
  at: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const sizes = pictures.map(imageNodeSize)
  let x = at.x - (sizes[0] ? cardWidth(sizes[0]) / 2 : 0)
  return sizes.map((size) => {
    const spot = { x: Math.round(x), y: Math.round(at.y - cardHeight(size) / 2) }
    x += cardWidth(size) + BOARD_GAP
    return spot
  })
}
