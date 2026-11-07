import { describe, expect, it } from 'vitest'
import type { EngineFeatures, ProjectCanvas } from '@shared/types'
import { canvasFromPicture, copyAsLayout, defaultSettings, removeCanvasFrom, settingsFrom } from '@renderer/pages/studio/canvases'
import { canConnect, linkMenu } from '@renderer/pages/studio/connect'
import { compileCanvasPrompt } from '@renderer/pages/studio/prompt'
import { linksOf, removeLink, setLink } from '@renderer/pages/studio/links'
import { maskAvailability } from '@renderer/pages/studio/mask'
import {
  createStyleCanvas,
  generationCanvas,
  nodeBlockers,
  seriesFromStyle,
  styleUsers,
  upscaleFromPicture,
  upscaleSize,
  withUpscaleScale,
} from '@renderer/pages/studio/nodes'
import { inputSlots, slotDrop, styleDrop } from '@renderer/pages/studio/ports'
import { boardPorts } from '@renderer/pages/studio/wires'
import { canvas, layer } from './fixtures'

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
const style = (id: string, patch: Partial<ProjectCanvas> = {}): ProjectCanvas =>
  ({ ...createStyleCanvas([], { id, at: { x: -400, y: 0 } }), ...patch }) as ProjectCanvas
const picture = canvas({
  id: 'p',
  kind: 'image',
  title: '照片',
  imagePath: '/p.png',
  imageSize: { width: 800, height: 600 },
  width: 800,
  height: 600,
  x: -600,
})
const keys = (slots: ReturnType<typeof inputSlots>) => slots.map((slot) => [slot.key, slot.label, slot.linked])

describe('studio/nodes 风格', () => {
  it("a 画面 generates with its description followed by its 风格 nodes', and their LoRA after its own", () => {
    const watercolor = style('s1', { prompt: '水彩插画，柔和粉色', adapters: [{ id: 'paper', strength: 0.8 }] })
    const soft = style('s2', { prompt: '  ', adapters: [{ id: 'mine', strength: 0.2 }] })
    let layout = canvas({ id: 'l', prompt: '一只猫', adapters: [{ id: 'mine', strength: 1 }] })
    layout = setLink(setLink(layout, 'style', { canvasId: 's1' }), 'style', { canvasId: 's2' })
    const list = [watercolor, soft, layout]
    const made = generationCanvas(layout, list)
    expect(compileCanvasPrompt(made).prompt).toBe('一只猫，水彩插画，柔和粉色')
    // One already on the 画面 keeps its strength.
    expect(made.adapters).toEqual([
      { id: 'mine', strength: 1 },
      { id: 'paper', strength: 0.8 },
    ])
    // The 画面 itself is unchanged; editing the 风格 changes what every 画面 gets.
    expect(layout.prompt).toBe('一只猫')
    const edited = list.map((item) => (item.id === 's1' ? { ...item, prompt: '油画' } : item))
    expect(compileCanvasPrompt(generationCanvas(layout, edited)).prompt).toBe('一只猫，油画')
    expect(styleUsers('s1', list).map((item) => item.id)).toEqual(['l'])
  })

  it('a 风格 description also reaches a 画面 with regions', () => {
    const layout = setLink(canvas({ id: 'l', prompt: '海报', layers: [layer()] }), 'style', { canvasId: 's1' })
    const made = generationCanvas(layout, [style('s1', { prompt: '复古' }), layout])
    expect(compileCanvasPrompt(made).prompt).toContain('海报，复古')
  })

  it('links at most three 风格 each once, and removing or deleting one drops the link', () => {
    let layout = canvas({ id: 'l' })
    for (const id of ['s1', 's2', 's2', 's3', 's4']) layout = setLink(layout, 'style', { canvasId: id })
    expect(linksOf(layout).map((entry) => [entry.role, entry.link.canvasId, entry.label])).toEqual([
      ['style', 's1', '风格 1'],
      ['style', 's2', '风格 2'],
      ['style', 's3', '风格 3'],
    ])
    expect(removeLink(layout, 'style', 1).inputs?.styles?.links.map((link) => link.canvasId)).toEqual(['s1', 's3'])
    const { canvases, removedLinks } = removeCanvasFrom([style('s1'), layout], 's1')
    expect(removedLinks).toBe(1)
    expect(canvases[0]!.inputs?.styles?.links.map((link) => link.canvasId)).toEqual(['s2', 's3'])
  })

  it('a 画面 offers a 风格 socket once the board has a 风格; it takes only 风格 wires', () => {
    const layout = canvas({ id: 'l' })
    expect(keys(inputSlots(layout, features(), [])).map(([key]) => key)).toEqual(['init', 'control', 'reference'])
    const slots = inputSlots(setLink(layout, 'style', { canvasId: 's1' }), features(), [], [], true)
    expect(keys(slots).slice(-2)).toEqual([
      ['style:0', '风格 1', true],
      ['style', '风格', false],
    ])
    const socket = slots.at(-1)!
    expect(slotDrop(socket, layout, 's1', 'style')).toEqual({ ok: true, role: 'style' })
    expect(slotDrop(socket, layout, 'p', 'image')).toEqual({ ok: false, reason: '这里只能接风格' })
    expect(slotDrop(slots[0]!, layout, 's1', 'style')).toEqual({ ok: false, reason: '风格要接到「风格」上' })
    expect(styleDrop(setLink(layout, 'style', { canvasId: 's1' }), 's1')).toEqual({ ok: false, reason: '这个风格已经接上了' })
    // A 风格 wire is drawn from the 风格 card into its socket.
    const wired = setLink(layout, 'style', { canvasId: 's1' })
    const { wires } = boardPorts([style('s1'), wired], 1, (item) => inputSlots(item, features(), [], [], true))
    expect(wires.map((wire) => [wire.id, wire.sourceId, wire.label])).toEqual([['input:l:style:0', 's1', '风格 1']])
  })

  it('a 风格 cannot feed a 放大, and copies as a 风格', () => {
    const made = upscaleFromPicture([picture], 'p', { fallback: defaultSettings(), id: 'u' })!
    const upscale = made.canvases.find((item) => item.id === 'u')!
    expect(canConnect([style('s1'), upscale], 's1', upscale)).toEqual({ ok: false, reason: '放大不用风格' })
    const copy = copyAsLayout(style('s1', { prompt: '水彩', title: '风格 1' }), [style('s1', { title: '风格 1' })], 'c')
    expect(copy).toMatchObject({ id: 'c', kind: 'style', prompt: '水彩', title: '风格 2' })
    // New 画面 never take their settings from a 风格.
    expect(settingsFrom(style('s1', { steps: 1 }))).toEqual(defaultSettings())
  })

  it('一组同风格的图: a 风格 and three 画面 wired to it, side by side', () => {
    const series = seriesFromStyle([], defaultSettings())
    expect(series.style.kind).toBe('style')
    expect(series.layouts).toHaveLength(3)
    for (const layout of series.layouts) {
      expect(layout.inputs?.styles?.links).toEqual([{ canvasId: series.style.id }])
      expect(layout.x).toBeGreaterThan(series.style.x)
    }
    expect(new Set(series.layouts.map((layout) => layout.title)).size).toBe(3)
    expect(series.canvases).toHaveLength(4)
  })
})

describe('studio/nodes 放大', () => {
  it('scales the 原图, the long edge kept within 2048 on the 16-pixel grid', () => {
    expect(upscaleSize({ width: 1024, height: 1024 }, 2)).toEqual({ width: 2048, height: 2048 })
    expect(upscaleSize({ width: 800, height: 600 }, 1.5)).toEqual({ width: 1200, height: 896 })
    expect(upscaleSize({ width: 1536, height: 1024 }, 2)).toEqual({ width: 2048, height: 1360 })
  })

  it('放大 a picture: a 放大 node to its right, wired to it as 原图, sized from it', () => {
    const made = upscaleFromPicture([picture], 'p', { fallback: defaultSettings(), id: 'u' })!
    expect(made.created).toMatchObject({ id: 'u', kind: 'layout', title: '放大 1', upscale: { scale: 2 }, width: 1600, height: 1200 })
    expect(made.created.inputs?.init).toEqual({ link: { canvasId: 'p' }, strength: 0.4, resize: 'stretch' })
    expect(made.created.x).toBeGreaterThan(picture.x)
    expect(withUpscaleScale(made.created, 1.5, made.canvases)).toMatchObject({ upscale: { scale: 1.5 }, width: 1200, height: 896 })
    // Its one socket is the 原图; a picture dropped on it can only be that.
    expect(keys(inputSlots(made.created, features(), [], [], true))).toEqual([['init', '原图', true]])
    expect(linkMenu(made.created, 'q', features(), [])).toEqual([
      { type: 'item', role: 'init', label: '作为原图', current: false, hint: '替换现有' },
    ])
    expect(maskAvailability(made.created, features())).toEqual({ hidden: true, enabled: false })
  })

  it("a 放大 without a description takes its 原图's, or a plain one", () => {
    const source = canvas({ id: 'r', kind: 'result', prompt: '雪山湖泊', outputs: [{ path: '/r.png', width: 1024, height: 768, seed: 1 }] })
    const made = upscaleFromPicture([source], 'r', { fallback: defaultSettings(), id: 'u' })!
    expect(made.created).toMatchObject({ width: 2048, height: 1536 })
    expect(compileCanvasPrompt(generationCanvas(made.created, made.canvases)).prompt).toBe('雪山湖泊')
    const fromPicture = upscaleFromPicture([picture], 'p', { fallback: defaultSettings(), id: 'u' })!
    expect(compileCanvasPrompt(generationCanvas(fromPicture.created, fromPicture.canvases)).prompt).toBe('高清，细节清晰，画质细腻')
  })

  it('says what is missing: a 原图, or room to grow', () => {
    const made = upscaleFromPicture([picture], 'p', { fallback: defaultSettings(), id: 'u' })!
    expect(nodeBlockers(made.created, made.canvases)).toEqual([])
    expect(nodeBlockers(removeLink(made.created, 'init'), made.canvases)).toEqual([{ id: 'input-invalid', message: '先给放大接一张原图' }])
    const big = canvas({ ...picture, imageSize: { width: 2048, height: 1024 } })
    expect(nodeBlockers(made.created, [big, made.created])[0]!.message).toBe('原图已经有 2048 像素宽，不能再放大了')
    // Only a card with a picture can be enlarged; a plain 画面 has no extra checks.
    expect(upscaleFromPicture([canvas()], 'c1', { fallback: defaultSettings() })).toBeNull()
    expect(nodeBlockers(canvas(), [canvas()])).toEqual([])
  })

  it('a copied 放大 is another 放大 of the same 原图', () => {
    const made = upscaleFromPicture([picture], 'p', { fallback: defaultSettings(), id: 'u' })!
    const copy = copyAsLayout(made.created, made.canvases, 'c')
    expect(copy).toMatchObject({ title: '放大 2', upscale: { scale: 2 }, width: 1600, height: 1200 })
    expect(copy.inputs?.init?.link).toEqual({ canvasId: 'p' })
    // canvasFromPicture of a 放大's run gives a plain 画面 (not another 放大).
    const run = canvas({
      id: 'run',
      kind: 'result',
      sourceCanvasId: 'u',
      outputs: [{ path: '/o.png', width: 1600, height: 1200, seed: 1 }],
    })
    expect(
      canvasFromPicture([...made.canvases, run], 'run', { role: 'init', fallback: defaultSettings() })!.created.upscale,
    ).toBeUndefined()
  })
})
