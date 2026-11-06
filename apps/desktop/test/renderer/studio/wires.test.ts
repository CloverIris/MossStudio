import { describe, expect, it } from 'vitest'
import { CARD_HEADER, cardBodyHeight, cardWidth } from '@renderer/pages/studio/boardLayout'
import {
  boardWires,
  cardAt,
  CHIP_GAP,
  CHIP_HEIGHT,
  chipWidth,
  inputPort,
  MIN_HANDLE,
  outputPort,
  PORT_SPACING,
  stackChips,
  wirePath,
  wirePoint,
  type ChipRect,
} from '@renderer/pages/studio/wires'
import { canvas } from './fixtures'

const picture = (id: string, x: number, y: number) =>
  canvas({ id, kind: 'image', imagePath: `/p/${id}.png`, x, y, width: 1024, height: 1024 })

describe('studio/wires geometry', () => {
  it('puts the output port on the right edge and inputs on the left, centred on the picture', () => {
    const card = canvas({ x: 100, y: 50 })
    const middle = 50 + CARD_HEADER + cardBodyHeight(card) / 2
    expect(outputPort(card)).toEqual({ x: 100 + cardWidth(card), y: middle })
    expect(inputPort(card, 0, 1)).toEqual({ x: 100, y: middle })
  })

  it('stacks several input ports evenly around the middle', () => {
    const card = canvas({ x: 0, y: 0 })
    const middle = CARD_HEADER + cardBodyHeight(card) / 2
    const ys = [0, 1, 2].map((index) => inputPort(card, index, 3).y)
    expect(ys).toEqual([middle - PORT_SPACING, middle, middle + PORT_SPACING])
  })

  it('keeps stacked ports inside a short picture', () => {
    const card = canvas({ x: 0, y: 0, width: 1024, height: 128 })
    const body = cardBodyHeight(card)
    const ports = [0, 1, 2, 3, 4, 5].map((index) => inputPort(card, index, 6).y)
    expect(Math.min(...ports)).toBeGreaterThan(CARD_HEADER)
    expect(Math.max(...ports)).toBeLessThan(CARD_HEADER + body)
  })

  it('draws a horizontal cubic bézier with handles of at least MIN_HANDLE', () => {
    expect(wirePath({ x: 0, y: 0 }, { x: 400, y: 100 })).toBe('M 0 0 C 200 0, 200 100, 400 100')
    expect(wirePath({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(`M 0 0 C ${MIN_HANDLE} 0, ${10 - MIN_HANDLE} 0, 10 0`)
  })

  it('finds points on the curve: its ends and its middle', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 400, y: 100 }
    expect(wirePoint(from, to, 0)).toEqual(from)
    expect(wirePoint(from, to, 1)).toEqual(to)
    expect(wirePoint(from, to, 0.5)).toEqual({ x: 200, y: 50 })
  })
})

describe('studio/wires boardWires', () => {
  it('draws one labelled wire per input link of a layout canvas', () => {
    const a = picture('a', 0, 0)
    const b = picture('b', 0, 400)
    const layout = canvas({
      id: 'l',
      x: 600,
      y: 0,
      inputs: {
        init: { link: { canvasId: 'a' }, strength: 0.6 },
        control: { adapterId: 'ctl', images: [{ kind: 'depth', link: { canvasId: 'b' }, strength: 1, start: 0, end: 1 }] },
        references: { links: [{ canvasId: 'a' }, { canvasId: 'b' }] },
      },
    })
    const wires = boardWires([a, b, layout])
    expect(wires.map((wire) => [wire.id, wire.label, wire.sourceId, wire.role, wire.at])).toEqual([
      ['input:l:init:', '起始图 60%', 'a', 'init', undefined],
      ['input:l:control:depth', '控制 · 深度', 'b', 'control', 'depth'],
      ['input:l:reference:0', '参考 1', 'a', 'reference', 0],
      ['input:l:reference:1', '参考 2', 'b', 'reference', 1],
    ])
    expect(wires[0]!.from).toEqual(outputPort(a))
    expect(wires.map((wire) => wire.to)).toEqual([0, 1, 2, 3].map((index) => inputPort(layout, index, 4, CHIP_HEIGHT + CHIP_GAP)))
    expect(wires[0]!.mid).toEqual(wirePoint(wires[0]!.from, wires[0]!.to, 0.5))
  })

  it('draws a faint, unlabelled lineage wire for a result and not its copied inputs', () => {
    const a = picture('a', 0, 0)
    const source = canvas({ id: 's', x: 600, y: 0, inputs: { init: { link: { canvasId: 'a' }, strength: 0.5 } } })
    const result = canvas({ id: 'r', kind: 'result', x: 600, y: 600, sourceCanvasId: 's', inputs: source.inputs })
    const wires = boardWires([a, source, result])
    const lineage = wires.filter((wire) => wire.targetId === 'r')
    expect(lineage).toEqual([expect.objectContaining({ id: 'lineage:r', kind: 'lineage', sourceId: 's' })])
    expect(lineage[0]!.label).toBeUndefined()
    expect(wires.filter((wire) => wire.targetId === 's')).toHaveLength(1)
  })

  it('skips links whose source is gone or is the canvas itself', () => {
    const layout = canvas({
      id: 'l',
      inputs: { init: { link: { canvasId: 'gone' }, strength: 0.6 }, references: { links: [{ canvasId: 'l' }] } },
    })
    expect(boardWires([layout])).toEqual([])
  })

  it('moves with the cards: a moved source moves its wire end', () => {
    const a = picture('a', 0, 0)
    const layout = canvas({ id: 'l', x: 600, y: 0, inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })
    const before = boardWires([a, layout])[0]!
    const after = boardWires([{ ...a, x: 50, y: 70 }, layout])[0]!
    expect(after.from).toEqual({ x: before.from.x + 50, y: before.from.y + 70 })
    expect(after.to).toEqual(before.to)
    expect(after.path).not.toBe(before.path)
  })
})

describe('studio/wires cardAt', () => {
  it('finds the topmost card under a point', () => {
    const bottom = canvas({ id: 'bottom', x: 0, y: 0 })
    const top = canvas({ id: 'top', x: 100, y: 100 })
    expect(cardAt([bottom, top], { x: 150, y: 150 })?.id).toBe('top')
    expect(cardAt([bottom, top], { x: 10, y: 10 })?.id).toBe('bottom')
    expect(cardAt([bottom, top], { x: -5, y: 10 })).toBeUndefined()
  })
})

describe('studio/wires chips', () => {
  const intersects = (a: ChipRect, b: ChipRect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

  /** One picture feeding a canvas in every role: start picture, two control kinds, four references. */
  function fannedIn(height: number) {
    const source = picture('a', 0, 0)
    const layout = canvas({
      id: 'l',
      x: 600,
      y: 0,
      height,
      inputs: {
        init: { link: { canvasId: 'a' }, strength: 0.6 },
        control: {
          adapterId: 'ctl',
          images: ['depth', 'canny'].map((kind) => ({ kind, link: { canvasId: 'a' }, strength: 1, start: 0, end: 1 })),
        },
        references: {
          links: [{ canvasId: 'a' }, { canvasId: 'a', output: 1 }, { canvasId: 'a', output: 2 }, { canvasId: 'a', output: 3 }],
        },
      },
    })
    return [source, layout]
  }

  for (const zoom of [0.25, 0.5, 1, 2]) {
    for (const height of [1024, 256]) {
      it(`never overlaps chips of links from one source (zoom ${zoom}, picture height ${height})`, () => {
        const chips = boardWires(fannedIn(height), zoom).map((wire) => wire.chip!)
        expect(chips).toHaveLength(7)
        for (let i = 0; i < chips.length; i += 1) {
          for (let j = i + 1; j < chips.length; j += 1) expect(intersects(chips[i]!, chips[j]!), `chips ${i} and ${j}`).toBe(false)
        }
      })
    }
  }

  it('sits each chip just left of its own port, in port order, at screen size', () => {
    const wires = boardWires(fannedIn(1024), 1)
    const spacing = CHIP_HEIGHT + CHIP_GAP
    wires.forEach((wire, index) => {
      const chip = wire.chip!
      expect(chip.h).toBe(CHIP_HEIGHT)
      expect(chip.w).toBe(chipWidth(wire.label!))
      expect(chip.x + chip.w).toBeCloseTo(wire.to.x - CHIP_GAP * 2)
      // A tall picture spreads its ports so every chip is centred on its own port.
      expect(chip.y + chip.h / 2).toBeCloseTo(wire.to.y)
      if (index) expect(wire.to.y - wires[index - 1]!.to.y).toBeCloseTo(spacing)
    })
  })

  it('pushes chips apart when their ports are closer than a chip, keeping the stack centred', () => {
    const ports = [
      { x: 0, y: 100 },
      { x: 0, y: 101 },
      { x: 0, y: 102 },
    ]
    const chips = stackChips(ports, ['起始图 60%', '控制 · 深度', '参考 1'], 1)
    expect(chips[1]!.y).toBeCloseTo(chips[0]!.y + CHIP_HEIGHT + CHIP_GAP)
    expect(chips[2]!.y).toBeCloseTo(chips[1]!.y + CHIP_HEIGHT + CHIP_GAP)
    expect(chips[1]!.y + CHIP_HEIGHT / 2).toBeCloseTo(101)
  })

  it('keeps ports at the default spacing when chips already fit', () => {
    expect(inputPort(canvas(), 1, 2, 0).y - inputPort(canvas(), 0, 2, 0).y).toBe(PORT_SPACING)
  })

  it('estimates chip width from the label', () => {
    expect(chipWidth('参考 2')).toBe(Math.ceil(16 + 22 + 4 + 6.5))
    expect(chipWidth('控制 · 深度')).toBeGreaterThan(chipWidth('参考 2'))
  })
})
