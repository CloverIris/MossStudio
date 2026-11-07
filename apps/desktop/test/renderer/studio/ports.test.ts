import { describe, expect, it } from 'vitest'
import type { ControlAdapterEntry, EngineFeatures } from '@shared/types'
import { dropZones, inputSlots, slotDrop, zoneAt, type InputSlot } from '@renderer/pages/studio/ports'
import { boardPorts, slotAt } from '@renderer/pages/studio/wires'
import { canvas } from './fixtures'

const features = (patch: Partial<EngineFeatures> = {}): EngineFeatures => ({
  preview: true,
  imageInput: true,
  control: true,
  references: true,
  hires: true,
  samplers: true,
  lora: true,
  values: {},
  ...patch,
})
const adapter: ControlAdapterEntry = {
  id: 'ctl',
  name: 'union',
  path: '/m/ctl.safetensors',
  sizeBytes: 1,
  controlKinds: ['depth', 'canny'],
  addedAt: '2026-11-05T00:00:00Z',
}
const brief = (slots: InputSlot[]) => slots.map((slot) => [slot.key, slot.label, slot.linked, slot.needs])

describe('studio/ports inputSlots', () => {
  it('offers every role on a fresh canvas, and says the control socket needs an adapter', () => {
    expect(brief(inputSlots(canvas(), features(), []))).toEqual([
      ['init', '起始图', false, null],
      ['control', '控制', false, 'adapter-missing'],
      ['reference', '参考图', false, null],
    ])
    expect(brief(inputSlots(canvas(), features(), [adapter]))[1]).toEqual(['control', '控制', false, 'adapter'])
  })

  it('gives one control socket per kind of the chosen adapter, linked or empty', () => {
    const layout = canvas({
      inputs: { control: { adapterId: 'ctl', images: [{ kind: 'canny', link: { canvasId: 'p' }, strength: 1, start: 0, end: 1 }] } },
    })
    expect(brief(inputSlots(layout, features(), [adapter]))).toEqual([
      ['init', '起始图', false, null],
      ['control:depth', '控制 · 深度', false, null],
      ['control:canny', '控制 · 边缘', true, null],
      ['reference', '参考图', false, null],
    ])
  })

  it('lists linked references and keeps one empty socket until the fourth', () => {
    const links = (n: number) => Array.from({ length: n }, (_, index) => ({ canvasId: `p${index}` }))
    const two = inputSlots(canvas({ inputs: { references: { links: links(2) } } }), features(), [])
    expect(two.filter((slot) => slot.role === 'reference').map((slot) => slot.key)).toEqual(['reference:0', 'reference:1', 'reference'])
    const four = inputSlots(canvas({ inputs: { references: { links: links(4) } } }), features(), [])
    expect(four.filter((slot) => slot.role === 'reference').every((slot) => slot.linked)).toBe(true)
  })

  it('hides roles the engine cannot do, but keeps what is already linked so it can be removed', () => {
    const textOnly = features({ imageInput: false, control: false, references: false, cli: 'vulkan' })
    expect(inputSlots(canvas(), textOnly, [])).toEqual([])
    const linked = canvas({ inputs: { init: { link: { canvasId: 'p' }, strength: 0.6 } } })
    expect(brief(inputSlots(linked, textOnly, []))).toEqual([['init', '起始图 60%', true, null]])
  })

  it('explains empty sockets when no engine is usable', () => {
    const slots = inputSlots(canvas(), null, [], [{ id: 'engine', message: '引擎还没装好' }])
    expect(slots.map((slot) => slot.needs)).toEqual(['engine', 'engine', 'engine'])
    expect(slots[0]!.reason).toBe('引擎还没装好，就绪后才能把图片接进来')
  })

  it('gives picture and result cards no sockets', () => {
    expect(inputSlots(canvas({ kind: 'image', imagePath: '/p.png' }), features(), [])).toEqual([])
    expect(inputSlots(canvas({ kind: 'result' }), features(), [])).toEqual([])
  })
})

describe('studio/ports slotDrop', () => {
  const [init, control, reference] = inputSlots(canvas(), features(), [])

  it('links into the socket it was dropped on', () => {
    expect(slotDrop(init!, canvas(), 'p')).toEqual({ ok: true, role: 'init' })
    expect(slotDrop(reference!, canvas(), 'p')).toEqual({ ok: true, role: 'reference' })
    const depth = inputSlots(canvas({ inputs: { control: { adapterId: 'ctl', images: [] } } }), features(), [adapter])[1]!
    expect(slotDrop(depth, canvas(), 'p')).toEqual({ ok: true, role: 'control', kind: 'depth' })
  })

  it('refuses with a reason: no adapter, or a reference that is already there', () => {
    expect(slotDrop(control!, canvas(), 'p')).toEqual({ ok: false, reason: '需要先添加控制适配器' })
    const linked = canvas({ inputs: { references: { links: [{ canvasId: 'p' }] } } })
    expect(slotDrop(reference!, linked, 'p')).toEqual({ ok: false, reason: '已经是这个画面的参考图' })
  })
})

describe('studio/wires boardPorts', () => {
  const picture = canvas({ id: 'p', kind: 'image', imagePath: '/p.png', x: 0, y: 0 })
  const layout = canvas({ id: 'l', x: 600, y: 0, inputs: { references: { links: [{ canvasId: 'p' }] } } })
  const slotsFor = (item: typeof layout) => inputSlots(item, features(), [])

  it('ends wires at their sockets and puts empty sockets beside them, chips stacked without overlap', () => {
    const { wires, empties, slots } = boardPorts([picture, layout], 1, slotsFor)
    expect(slots.map((item) => item.slot.key)).toEqual(['init', 'control', 'reference:0', 'reference'])
    expect(empties.map((item) => item.slot.key)).toEqual(['init', 'control', 'reference'])
    const wire = wires.find((item) => item.id === 'input:l:reference:0')!
    expect(wire.to).toEqual(slots[2]!.port)
    const chips = [empties[0]!.chip, empties[1]!.chip, wire.chip!, empties[2]!.chip]
    for (let index = 1; index < chips.length; index += 1)
      expect(chips[index]!.y).toBeGreaterThanOrEqual(chips[index - 1]!.y + chips[index - 1]!.h)
  })

  it('without slots, draws ports for links only (as before)', () => {
    const { wires, empties } = boardPorts([picture, layout], 1)
    expect(empties).toEqual([])
    expect(wires.map((item) => item.id)).toEqual(['input:l:reference:0'])
  })

  it('finds the nearest socket within the radius', () => {
    const { slots } = boardPorts([picture, layout], 1, slotsFor)
    const target = slots[1]!.port
    expect(slotAt(slots, { x: target.x + 3, y: target.y + 2 }, 10)?.slot.key).toBe('control')
    expect(slotAt(slots, { x: target.x + 30, y: target.y }, 10)).toBeUndefined()
  })
})

describe('studio/ports dropZones', () => {
  it('a picture can go into every input the card has (a linked start or control picture is replaced, references take one more)', () => {
    const linked = canvas({
      inputs: {
        init: { link: { canvasId: 'p' }, strength: 0.6 },
        references: { links: [{ canvasId: 'p' }] },
      },
    })
    const zones = dropZones(inputSlots(linked, features(), [adapter], [], true), 'image')
    expect(zones.map((slot) => slot.key)).toEqual(['init', 'control', 'reference'])
  })

  it('a 风格 only goes into the 风格 socket', () => {
    const slots = inputSlots(canvas(), features(), [], [], true)
    expect(dropZones(slots, 'style').map((slot) => slot.key)).toEqual(['style'])
    expect(dropZones(inputSlots(canvas(), features(), []), 'style')).toEqual([])
  })

  it('splits the face evenly, top to bottom', () => {
    expect([0, 0.2, 0.34, 0.5, 0.99, 1.4, -1].map((fraction) => zoneAt(3, fraction))).toEqual([0, 0, 1, 1, 2, 2, 0])
  })
})
