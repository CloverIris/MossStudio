import { describe, expect, it } from 'vitest'
import type { EngineFeatures } from '@shared/types'
import { pictureSources } from '@renderer/pages/studio/connect'
import { inputSlots, socketY } from '@renderer/pages/studio/ports'
import { nearestSocket, offersFor, SNAP_RADIUS } from '@renderer/pages/studio/useWireConnect'
import { canvas } from './fixtures'

const features: EngineFeatures = {
  preview: true,
  imageInput: true,
  control: true,
  references: true,
  hires: true,
  samplers: true,
  lora: true,
  values: {},
}
const slotsFor = (card: ReturnType<typeof canvas>): ReturnType<typeof inputSlots> => inputSlots(card, features, [])

const picture = canvas({ id: 'pic', kind: 'image', title: '小猫', imagePath: '/p/cat.png', x: 0, y: 0, width: 512, height: 512 })
const first = canvas({ id: 'a', title: '画面 1', x: 400, y: 0 })
const second = canvas({ id: 'b', title: '画面 2', x: 400, y: 600 })
// Already fed by 画面 1: linking 画面 1 back into it would make a loop.
const fed = canvas({ id: 'c', title: '画面 3', x: 900, y: 0, inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })

describe('wire offers', () => {
  it('offers sockets on every 画面 that can take the picture, as soon as the wire is out', () => {
    const offers = offersFor([picture, first, second], 'pic', slotsFor)
    expect([...offers.keys()]).toEqual(['a', 'b'])
    expect(offers.get('a')!.slots.map((slot) => slot.label)).toEqual(['起始图', '控制', '参考图'])
  })

  it('leaves out the source and cards that would close a loop', () => {
    const offers = offersFor([picture, first, fed], 'c', slotsFor)
    expect(offers.has('c')).toBe(false)
    expect(offers.has('a')).toBe(false)
    expect(offers.has('pic')).toBe(false)
  })

  it('snaps to the nearest socket within the radius, on any offering card', () => {
    const cards = [picture, first, second]
    const offers = offersFor(cards, 'pic', slotsFor)
    const at = (card: typeof first, index: number): { x: number; y: number } => ({ x: card.x, y: socketY(card, index, 3, 1) })
    expect(nearestSocket(cards, offers, { x: first.x - 20, y: at(first, 2).y + 4 }, 1)).toEqual({ card: first, index: 2 })
    expect(nearestSocket(cards, offers, at(second, 0), 1)).toEqual({ card: second, index: 0 })
    expect(nearestSocket(cards, offers, { x: first.x - SNAP_RADIUS - 10, y: at(first, 1).y }, 1)).toBeNull()
  })

  it('lists the pictures on the board that can go into a card', () => {
    expect(pictureSources([picture, first, fed], first).map((card) => card.id)).toEqual(['pic'])
    // A 画面 with nothing generated has no picture to give.
    expect(pictureSources([picture, first, second], second).map((card) => card.id)).toEqual(['pic'])
  })
})
