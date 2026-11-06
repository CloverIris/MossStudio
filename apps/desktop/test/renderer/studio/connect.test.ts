import { describe, expect, it } from 'vitest'
import type { ControlAdapterEntry, EngineFeatures } from '@shared/types'
import { canConnect, hasPicture, linkMenu } from '@renderer/pages/studio/connect'
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
  controlKinds: ['depth', 'canny', 'scribble'],
  addedAt: '2026-11-05T00:00:00Z',
}
const output = { path: '/o/1.png', width: 1024, height: 1024, seed: 1 }

describe('studio/connect hasPicture', () => {
  it('offers an output port only once a card has a picture', () => {
    expect(hasPicture(canvas({ kind: 'image', imagePath: '/p.png' }))).toBe(true)
    expect(hasPicture(canvas({ kind: 'result', outputs: [output] }))).toBe(true)
    expect(hasPicture(canvas({ kind: 'layout', outputs: [output] }))).toBe(true)
    expect(hasPicture(canvas({ kind: 'layout' }))).toBe(false)
    expect(hasPicture(canvas({ kind: 'result', outputs: [] }))).toBe(false)
  })
})

describe('studio/connect canConnect', () => {
  const image = canvas({ id: 'img', kind: 'image', imagePath: '/p.png' })
  const a = canvas({ id: 'a', outputs: [output] })
  const b = canvas({ id: 'b', outputs: [output], inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })
  const all = [image, a, b]

  it('accepts a wire onto another layout canvas', () => {
    expect(canConnect(all, 'img', a)).toEqual({ ok: true })
    expect(canConnect(all, 'a', b)).toEqual({ ok: true })
  })

  it('refuses itself, non-layout cards and cycles', () => {
    expect(canConnect(all, 'a', a)).toMatchObject({ ok: false, reason: '不能连到自己' })
    expect(canConnect(all, 'a', image)).toMatchObject({ ok: false, reason: '只能连到可编辑的画面' })
    expect(canConnect(all, 'a', canvas({ id: 'r', kind: 'result' }))).toMatchObject({ ok: false })
    // b already takes a; a taking b would close a loop.
    expect(canConnect(all, 'b', a)).toMatchObject({ ok: false, reason: '这样会连成一个圈' })
    expect(canConnect(all, 'a', undefined)).toMatchObject({ ok: false })
  })
})

describe('studio/connect linkMenu', () => {
  const items = (entries: ReturnType<typeof linkMenu>) =>
    entries.map((entry) => (entry.type === 'item' ? `${entry.label}${entry.disabled ? ' (off)' : ''}` : `[${entry.label}]`))

  it('offers every role the engine supports, control kinds from the chosen adapter', () => {
    const target = canvas({ id: 't', inputs: { control: { adapterId: 'ctl', images: [] } } })
    expect(items(linkMenu(target, 's', features(), [adapter]))).toEqual([
      '作为起始图',
      '[作为控制图]',
      '深度',
      '边缘',
      'scribble',
      '作为参考图',
    ])
  })

  it('leaves out roles the engine does not support', () => {
    const target = canvas({ id: 't' })
    expect(items(linkMenu(target, 's', features({ control: false, references: false }), []))).toEqual(['作为起始图'])
    expect(items(linkMenu(target, 's', features({ imageInput: false, control: false }), []))).toEqual(['作为参考图'])
    expect(items(linkMenu(target, 's', features({ imageInput: false, control: false, references: false }), []))).toEqual([
      '[当前引擎不支持把图片接进来]',
    ])
  })

  it('asks for a control adapter first', () => {
    const entries = linkMenu(canvas({ id: 't' }), 's', features(), [adapter])
    expect(entries).toContainEqual({ type: 'item', role: 'control', label: '先在右侧选择控制适配器', disabled: true })
  })

  it('says why nothing can be linked without an engine', () => {
    expect(items(linkMenu(canvas(), 's', null, []))).toEqual(['[没有可用的引擎，暂时不能把图片接进来]'])
    expect(items(linkMenu(canvas(), 's', undefined, []))).toEqual(['[正在读取引擎支持的功能…]'])
  })

  it("gives the 生成 footer's engine reason while the engine is not ready", () => {
    const installing = { id: 'engine', message: '引擎正在安装 · 40%' } as const
    expect(items(linkMenu(canvas(), 's', null, [], [installing]))).toEqual(['[引擎正在安装 · 40%，就绪后才能把图片接进来]'])
  })

  it('marks what is already linked and stops at four references', () => {
    const target = canvas({
      id: 't',
      inputs: {
        init: { link: { canvasId: 's' }, strength: 0.6 },
        control: { adapterId: 'ctl', images: [{ kind: 'depth', link: { canvasId: 'x' }, strength: 1, start: 0, end: 1 }] },
        references: { links: [{ canvasId: 'a' }, { canvasId: 'b' }, { canvasId: 'c' }, { canvasId: 'd' }] },
      },
    })
    const entries = linkMenu(target, 's', features(), [adapter])
    expect(entries).toContainEqual(expect.objectContaining({ role: 'init', current: true, hint: '已连接' }))
    expect(entries).toContainEqual(expect.objectContaining({ role: 'control', kind: 'depth', hint: '替换现有' }))
    expect(entries).toContainEqual(expect.objectContaining({ role: 'reference', disabled: true, hint: '最多 4 张' }))
  })
})
