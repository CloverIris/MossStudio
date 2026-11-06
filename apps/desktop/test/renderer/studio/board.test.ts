import { describe, expect, it } from 'vitest'
import {
  BOARD_GAP,
  BOARD_UNIT,
  CARD_FOOTER,
  CARD_HEADER,
  boardBounds,
  cardHeight,
  cardWidth,
  centerOn,
  fitView,
  nextFreeSpot,
  pointInCanvas,
  resultSpot,
  zoomAround,
  ZOOM_MAX,
} from '@renderer/pages/studio/boardLayout'

const placed = (x: number, y: number, width = 1024, height = 1024) => ({ x, y, width, height })

describe('studio/board geometry', () => {
  it('scales cards with the picture size', () => {
    expect(cardWidth({ width: 1024, height: 1024 })).toBe(1024 * BOARD_UNIT)
    expect(cardHeight({ width: 1024, height: 512 })).toBe(CARD_HEADER + 512 * BOARD_UNIT + CARD_FOOTER)
  })

  it('places a new card in the first free slot', () => {
    expect(nextFreeSpot([], { width: 1024, height: 1024 })).toEqual({ x: 0, y: 0 })
    const slot = cardWidth({ width: 1024, height: 1024 }) + BOARD_GAP
    expect(nextFreeSpot([placed(0, 0)], { width: 1024, height: 1024 })).toEqual({ x: slot, y: 0 })
  })

  it('drops a result under its source and skips taken spots', () => {
    const source = placed(0, 0)
    const below = cardHeight(source) + BOARD_GAP
    expect(resultSpot(source, [source])).toEqual({ x: 0, y: below })
    expect(resultSpot(source, [source, placed(0, below)])).toEqual({ x: 0, y: below * 2 })
  })

  it('bounds every card plus an extra rect', () => {
    expect(boardBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    const bounds = boardBounds([placed(100, 50)], { x: 0, y: 0, w: 10, h: 10 })
    expect(bounds).toEqual({ x: 0, y: 0, w: 100 + cardWidth(placed(0, 0)), h: 50 + cardHeight(placed(0, 0)) })
  })

  it('fits without enlarging past 100% and centres the content', () => {
    const view = fitView({ width: 1000, height: 800 }, { x: 0, y: 0, w: 200, h: 100 }, { top: 0, side: 0 })
    expect(view.zoom).toBe(1)
    expect(view.pan).toEqual({ x: 400, y: 350 })
    expect(fitView({ width: 500, height: 500 }, { x: 0, y: 0, w: 1000, h: 1000 }, { top: 0, side: 0 }).zoom).toBe(0.5)
  })

  it('keeps the point under the cursor fixed while zooming', () => {
    const before = { zoom: 1, pan: { x: 10, y: 20 } }
    const after = zoomAround(before, 110, 220, 2)
    // Board point under (110, 220) is (100, 200) before and after.
    expect((110 - after.pan.x) / after.zoom).toBeCloseTo(100)
    expect((220 - after.pan.y) / after.zoom).toBeCloseTo(200)
    expect(zoomAround({ zoom: ZOOM_MAX, pan: { x: 0, y: 0 } }, 0, 0, 2)).toEqual({ zoom: ZOOM_MAX, pan: { x: 0, y: 0 } })
  })

  it('centres a rect and converts pointer positions into canvas pixels', () => {
    expect(centerOn({ width: 400, height: 400 }, { x: 0, y: 0, w: 100, h: 100 }, 1).pan).toEqual({ x: 150, y: 150 })
    const rect = { left: 10, top: 20, width: 256, height: 128 }
    expect(pointInCanvas({ x: 138, y: 84 }, rect, { width: 1024, height: 512 })).toEqual([512, 256])
    expect(pointInCanvas({ x: -50, y: 999 }, rect, { width: 1024, height: 512 })).toEqual([0, 512])
  })
})
