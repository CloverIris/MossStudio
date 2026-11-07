/**
 * 创作 board: wiring pictures into a canvas by dragging, removing wires,
 * wires following cards, pictures dropped or pasted onto the board, painting
 * a mask, and the live state of a run on its card.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { CanvasInputs, EngineFeatures, JobRecord } from '@shared/types'
import { settle, useApp, type E2eApp } from '../support/app'

const ENGINE_JOBS = 'http:POST /api/engine-jobs'

interface BoardSetup {
  inputs?: CanvasInputs
  features?: Partial<EngineFeatures>
  adapters?: boolean
  theme?: 'light' | 'dark'
  /** canvas-1 has already run once in place. */
  outputs?: boolean
}

/** A project with one imported picture (img-1) and one layout canvas (canvas-1), selected. */
async function openBoard(app: E2eApp, setup: BoardSetup = {}): Promise<Page> {
  const page = await app.open({ scenario: 'ready', route: '/studio', defer: true, theme: setup.theme })
  await page.evaluate(
    (options) => {
      const { canvasFixture, projectFixture, engineFeaturesFixture, controlAdapterFixture } = window.__mock.fixtures
      const picture = canvasFixture({
        id: 'img-1',
        kind: 'image',
        title: '小猫照片',
        imagePath: '/fixture/projects/project-1/assets/cat-1600x1200.png',
        imageSize: { width: 1600, height: 1200 },
        x: 0,
        y: 0,
        width: 1024,
        height: 768,
        steps: 1,
      })
      const second = canvasFixture({
        id: 'img-2',
        kind: 'image',
        title: '线稿',
        imagePath: '/fixture/projects/project-1/assets/lines-800x1280.png',
        x: 0,
        y: 360,
        width: 640,
        height: 1024,
        steps: 1,
      })
      const layout = canvasFixture({
        id: 'canvas-1',
        title: '画面 1',
        prompt: '一只橘猫坐在窗台上',
        x: 420,
        y: 0,
        ...(options.inputs ? { inputs: options.inputs } : {}),
        ...(options.outputs
          ? {
              outputs: [{ path: '/fixture/outputs/old-1024x1024.png', width: 1024, height: 1024, seed: 3 }],
              jobState: 'succeeded' as const,
            }
          : {}),
      })
      window.__mock.state.projects = [
        projectFixture({ id: 'project-1', name: '小猫', canvases: [picture, second, layout], selectedCanvasId: 'canvas-1' }),
      ]
      window.__mock.state.engineFeatures = engineFeaturesFixture(options.features ?? {})
      window.__mock.state.controlAdapters = options.adapters ? [controlAdapterFixture()] : []
    },
    { inputs: setup.inputs, features: setup.features, adapters: setup.adapters, outputs: setup.outputs },
  )
  await app.start()
  await page.locator('[data-project-switcher]').waitFor()
  await page.locator('article[data-canvas-card="canvas-1"]').waitFor()
  await settle(page, 150)
  return page
}

async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Drag a wire from a card's output port and drop it on another card's picture. */
async function dragWire(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`article[data-canvas-card="${from}"]`).hover()
  const start = await center(page, `[data-output-port="${from}"]`)
  const end = await center(page, `article[data-canvas-card="${to}"] [data-card-body]`)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 })
  await page.mouse.move(end.x, end.y, { steps: 5 })
  await page.mouse.up()
}

async function savedInputs(page: Page, canvasId = 'canvas-1'): Promise<CanvasInputs | null> {
  return page.evaluate((id) => window.__mock.state.projects[0]?.canvases.find((canvas) => canvas.id === id)?.inputs ?? null, canvasId)
}

async function emitJob(page: Page, id: string, patch: Partial<JobRecord>): Promise<void> {
  await page.evaluate(
    ([jobId, change]) => {
      const mock = window.__mock
      const job = { ...mock.state.jobs.find((item) => item.id === jobId)!, ...change } as JobRecord
      mock.state.jobs = [job, ...mock.state.jobs.filter((item) => item.id !== jobId)]
      mock.emit(mock.Events.job, job)
    },
    [id, patch] as const,
  )
}

/** The n-th saved mask PNG: who it is for and its IHDR. */
async function savedMask(
  page: Page,
  index = 0,
): Promise<{ projectId: string; canvasId: string; signature: number[]; width: number; height: number; depth: number; colour: number }> {
  return page.evaluate((n) => {
    const call = window.__mock.callsTo('studio:save-mask')[n] as { projectId: string; canvasId: string; png: Uint8Array }
    const view = new DataView(call.png.buffer, call.png.byteOffset)
    return {
      projectId: call.projectId,
      canvasId: call.canvasId,
      signature: [...call.png.slice(0, 4)],
      width: view.getUint32(16),
      height: view.getUint32(20),
      depth: call.png[24]!,
      colour: call.png[25]!,
    }
  }, index)
}

async function paintStroke(page: Page): Promise<void> {
  const body = (await page.locator('article[data-canvas-card="canvas-1"] [data-mask-layer]').boundingBox())!
  await page.mouse.move(body.x + body.width * 0.2, body.y + body.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(body.x + body.width * 0.8, body.y + body.height * 0.6, { steps: 8 })
  await page.mouse.up()
}

/** How many mask pixels the card shows (tint alpha > 0). */
async function paintedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>('article[data-canvas-card="canvas-1"] [data-mask-layer] canvas')
    if (!element) return -1
    const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
    let count = 0
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) count += 1
    return count
  })
}

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('studio board', () => {
  const app = useApp()

  it('connects a picture by dragging a wire, as the start picture', async () => {
    const page = await openBoard(app, { adapters: true })
    expect(await page.locator('[data-wire-kind="input"]').count()).toBe(0)
    await dragWire(page, 'img-1', 'canvas-1')

    const menu = page.getByRole('menu', { name: /把「小猫照片」接到「画面 1」/ })
    await menu.waitFor()
    // Every role the engine supports; no control adapter chosen yet.
    expect(await menu.getByRole('menuitem', { name: '作为起始图' }).isEnabled()).toBe(true)
    expect(await menu.getByRole('menuitem', { name: '先在右侧选择控制适配器' }).isDisabled()).toBe(true)
    expect(await menu.getByRole('menuitem', { name: '作为参考图' }).isEnabled()).toBe(true)
    await menu.getByRole('menuitem', { name: '作为起始图' }).click()

    const chip = page.getByRole('button', { name: '连线：起始图 60%' })
    await chip.waitFor()
    expect(await page.locator('[data-wire-kind="input"]').count()).toBe(1)
    // The linked picture becomes the canvas's backdrop.
    expect(await page.locator('article[data-canvas-card="canvas-1"] [data-init-backdrop]').count()).toBe(1)
    await expect.poll(() => savedInputs(page), { timeout: 10_000 }).toMatchObject({ init: { link: { canvasId: 'img-1' }, strength: 0.6 } })
  })

  it('lists the kinds of the chosen control adapter and links one', async () => {
    const page = await openBoard(app, { adapters: true, inputs: { control: { adapterId: 'control-union', images: [] } } })
    await dragWire(page, 'img-2', 'canvas-1')
    const menu = page.getByRole('menu', { name: /接到「画面 1」/ })
    await menu.waitFor()
    for (const kind of ['深度', '边缘', '姿态']) expect(await menu.getByRole('menuitem', { name: kind }).isVisible()).toBe(true)
    await menu.getByRole('menuitem', { name: '深度' }).click()
    await page.getByRole('button', { name: '连线：控制 · 深度' }).waitFor()
    await expect
      .poll(() => savedInputs(page), { timeout: 10_000 })
      .toMatchObject({ control: { adapterId: 'control-union', images: [{ kind: 'depth', link: { canvasId: 'img-2' } }] } })
  })

  it('leaves out roles the engine does not support', async () => {
    const page = await openBoard(app, { adapters: true, features: { control: false, references: false } })
    await dragWire(page, 'img-1', 'canvas-1')
    const menu = page.getByRole('menu', { name: /接到「画面 1」/ })
    await menu.waitFor()
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['作为起始图'])
    expect(await menu.getByText('作为控制图').count()).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => menu.count()).toBe(0)
    expect(await page.locator('[data-wire-draft]').count()).toBe(0)
  })

  it('removes a selected wire with the keyboard', async () => {
    const page = await openBoard(app, {
      inputs: { init: { link: { canvasId: 'img-1' }, strength: 0.5 }, references: { links: [{ canvasId: 'img-2' }] } },
    })
    const reference = page.getByRole('button', { name: '连线：参考 1' })
    await reference.click()
    expect(await reference.getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Delete')
    await expect.poll(() => reference.count()).toBe(0)
    expect(await page.getByRole('button', { name: '连线：起始图 50%' }).isVisible()).toBe(true)

    // Hover shows × on the chip; Backspace works as well.
    const init = page.getByRole('button', { name: '连线：起始图 50%' })
    await init.hover()
    expect(await page.getByRole('button', { name: '断开 起始图 50%' }).isVisible()).toBe(true)
    await init.click()
    await page.keyboard.press('Backspace')
    await expect.poll(() => page.locator('[data-wire-kind="input"]').count()).toBe(0)
    await expect.poll(() => savedInputs(page), { timeout: 10_000 }).toBeNull()
  })

  it('keeps wires attached while a card is dragged', async () => {
    const page = await openBoard(app, { inputs: { init: { link: { canvasId: 'img-1' }, strength: 0.6 } } })
    const wire = page.locator('[data-wire-kind="input"] path').last()
    const before = await wire.getAttribute('d')
    const header = await center(page, 'article[data-canvas-card="img-1"] header')
    await page.mouse.move(header.x - 40, header.y)
    await page.mouse.down()
    await page.mouse.move(header.x - 40, header.y + 60, { steps: 4 })
    // Mid-drag, the wire already follows.
    const during = await wire.getAttribute('d')
    expect(during).not.toBe(before)
    await page.mouse.move(header.x - 40, header.y + 140, { steps: 4 })
    await page.mouse.up()
    const after = await wire.getAttribute('d')
    expect(after).not.toBe(during)
    // The wire still starts at the picture's output port.
    const port = await center(page, '[data-output-port="img-1"]')
    const start = await page.evaluate(() => {
      const path = document.querySelector<SVGPathElement>('[data-wire-kind="input"] path:last-of-type')!
      const point = path.getPointAtLength(0)
      const matrix = path.getScreenCTM()!
      return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.d + matrix.f }
    })
    expect(Math.abs(start.x - port.x)).toBeLessThan(3)
    expect(Math.abs(start.y - port.y)).toBeLessThan(3)
  })

  it('turns dropped and pasted pictures into image cards', async () => {
    const page = await openBoard(app)
    const before = await page.locator('article[data-canvas-kind="image"]').count()
    const target = await center(page, '[data-board]')
    await page.evaluate(
      ([base64, x, y]) => {
        const bytes = Uint8Array.from(atob(base64 as string), (char) => char.charCodeAt(0))
        const data = new DataTransfer()
        data.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
        const board = document.querySelector('[data-board]')!
        board.dispatchEvent(
          new DragEvent('dragover', { dataTransfer: data, clientX: x as number, clientY: y as number, bubbles: true, cancelable: true }),
        )
        board.dispatchEvent(
          new DragEvent('drop', { dataTransfer: data, clientX: x as number, clientY: y as number, bubbles: true, cancelable: true }),
        )
      },
      [PNG_1PX, target.x, target.y + 200] as const,
    )
    await expect.poll(() => page.locator('article[data-canvas-kind="image"]').count()).toBe(before + 1)
    const [dropped] = await app.calls<{ projectId: string; bytes?: Uint8Array; name?: string }>('studio:import-image')
    expect(dropped).toMatchObject({ projectId: 'project-1', name: 'dropped.png' })

    // Paste: the board has focus after a click on its empty part.
    await page.mouse.click(target.x + 300, target.y + 300)
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, PNG_1PX)
    await expect.poll(() => page.locator('article[data-canvas-kind="image"]').count()).toBe(before + 2)
    await expect.poll(() => app.calls('studio:import-image').then((calls) => calls.length)).toBe(2)
    // The new card is an image node: a picture, no generate controls.
    const card = page.locator('article[data-canvas-kind="image"][aria-current="true"]')
    expect(await card.locator('img').count()).toBe(1)
    expect(await card.getByRole('button', { name: /重新生成|换个种子/ }).count()).toBe(0)
    expect(await card.locator('[data-output-port]').count()).toBe(1)
  })

  it('paints a mask over the start picture and saves it', async () => {
    const page = await openBoard(app, { inputs: { init: { link: { canvasId: 'img-1' }, strength: 0.6 } } })
    const tool = page.getByRole('button', { name: '遮罩', exact: true })
    await expect.poll(() => tool.isEnabled()).toBe(true)
    await tool.click()
    const bar = page.getByRole('toolbar', { name: '遮罩工具' })
    await bar.waitFor()
    for (const name of ['画笔', '橡皮', '清除', '反转']) expect(await bar.getByRole('button', { name }).isVisible()).toBe(true)

    await paintStroke(page)

    await expect.poll(() => app.calls('studio:save-mask').then((calls) => calls.length), { timeout: 5_000 }).toBeGreaterThan(0)
    // An 8-bit greyscale PNG at the start picture's own pixel size (1600×1200), not the canvas's (1024×1024).
    expect(await savedMask(page)).toEqual({
      projectId: 'project-1',
      canvasId: 'canvas-1',
      signature: [0x89, 0x50, 0x4e, 0x47],
      width: 1600,
      height: 1200,
      depth: 8,
      colour: 0,
    })
    await expect
      .poll(() => savedInputs(page), { timeout: 10_000 })
      .toMatchObject({ mask: { path: '/fixture/projects/project-1/assets/mask-canvas-1.png' } })
    await app.screenshot('board-mask-light')

    // 清除 empties the mask; leaving the tool saves at once and drops it.
    await bar.getByRole('button', { name: '清除' }).click()
    await bar.getByRole('button', { name: '完成' }).click()
    await expect.poll(() => bar.count()).toBe(0)
    await expect.poll(() => savedInputs(page).then((inputs) => inputs?.mask ?? null), { timeout: 10_000 }).toBeNull()
  })

  it('a new stroke replaces the mask file it painted over (so old masks do not pile up)', async () => {
    const page = await openBoard(app, { inputs: { init: { link: { canvasId: 'img-1' }, strength: 0.6 } } })
    await page.getByRole('button', { name: '遮罩', exact: true }).click()
    await paintStroke(page)
    await expect.poll(() => savedInputs(page).then((inputs) => inputs?.mask?.path ?? null), { timeout: 10_000 }).not.toBeNull()
    const first = await page.evaluate(() => window.__mock.callsTo('studio:save-mask')[0] as { replaces?: string })
    expect(first.replaces).toBeUndefined()
    await paintStroke(page)
    await expect.poll(() => app.calls('studio:save-mask').then((calls) => calls.length), { timeout: 5_000 }).toBe(2)
    const second = await page.evaluate(() => window.__mock.callsTo('studio:save-mask')[1] as { replaces?: string })
    expect(second.replaces).toBe('/fixture/projects/project-1/assets/mask-canvas-1.png')
  })

  it('turns the mask tool off with a reason until a start picture is linked', async () => {
    const page = await openBoard(app)
    const tool = page.getByRole('button', { name: '遮罩', exact: true })
    expect(await tool.isDisabled()).toBe(true)
    expect(await tool.getAttribute('title')).toBe('先给画面连一张起始图，再画遮罩')
  })

  it('paints over the start picture even after the canvas has run, sized from the picture file', async () => {
    // img-2 has no recorded pixel size: the mask takes the picture's natural size (800×1280).
    const page = await openBoard(app, { outputs: true, inputs: { init: { link: { canvasId: 'img-2' }, strength: 0.6, resize: 'fit' } } })
    const card = page.locator('article[data-canvas-card="canvas-1"]')
    expect(await card.locator('[data-init-backdrop]').count()).toBe(0)
    await page.getByRole('button', { name: '遮罩', exact: true }).click()
    // The earlier result steps aside for the start picture and the mask.
    await card.locator('[data-init-backdrop]').waitFor()
    await card.locator('[data-mask-layer]').waitFor()
    await paintStroke(page)
    expect(await paintedPixels(page)).toBeGreaterThan(0)
    await expect.poll(() => app.calls('studio:save-mask').then((calls) => calls.length), { timeout: 5_000 }).toBe(1)
    expect(await savedMask(page)).toMatchObject({ canvasId: 'canvas-1', width: 800, height: 1280 })
    // Fit: the bands beside the picture repeat its edge columns, as the engine fills them.
    await app.screenshot('board-mask-fit-light')
    await page.getByRole('toolbar', { name: '遮罩工具' }).getByRole('button', { name: '完成' }).click()
    // Done painting: the result is back.
    await expect.poll(() => card.locator('[data-init-backdrop]').count()).toBe(0)
  })

  it('forgets the strokes when the mask is cleared with 清除, and never re-saves them', async () => {
    const page = await openBoard(app, { inputs: { init: { link: { canvasId: 'img-1' }, strength: 0.6 } } })
    await page.getByRole('button', { name: '遮罩', exact: true }).click()
    await paintStroke(page)
    await expect.poll(() => savedInputs(page).then((inputs) => inputs?.mask?.path ?? null), { timeout: 10_000 }).not.toBeNull()
    const saves = (await app.calls('studio:save-mask')).length

    // Paint again and clear before the delayed save runs.
    await paintStroke(page)
    // 清除 lives in the mask toolbar while painting (the panel shows the state and one toggle).
    await page.getByRole('toolbar', { name: '遮罩工具' }).getByRole('button', { name: '清除' }).click()
    await expect.poll(() => paintedPixels(page)).toBe(0)
    await settle(page, 1200)
    expect((await app.calls('studio:save-mask')).length).toBe(saves)
    await expect.poll(() => savedInputs(page).then((inputs) => inputs?.mask ?? null), { timeout: 10_000 }).toBeNull()
    expect(await paintedPixels(page)).toBe(0)
  })

  it('shows a run live on its card: queue place, preview frames, progress, failure', async () => {
    const page = await openBoard(app)
    await page.locator('[data-studio-generate]').click()
    await page.waitForFunction((channel) => window.__mock.callsTo(channel).length >= 1, ENGINE_JOBS)
    const id = await page.evaluate(() => window.__mock.state.jobs[0]!.id)
    const card = page.locator('article[data-canvas-card="canvas-1"]')
    // The job carries the card's title, so Activity names it as the card does.
    const canvasTitle = await page.evaluate(() => window.__mock.state.jobs[0]!.canvasTitle)
    expect(canvasTitle).toBeTruthy()
    expect(await card.textContent()).toContain(canvasTitle)

    await emitJob(page, id, { state: 'queued', queuePosition: 2 })
    await expect.poll(() => card.getByText('排队中 · 第 2 个').first().isVisible()).toBe(true)

    await emitJob(page, id, {
      state: 'running',
      stage: 'load',
      queuePosition: undefined,
      progress: { stage: 'load', current: 0, total: 30, percent: 0 },
    })
    await expect.poll(() => card.getByText('正在加载模型').first().isVisible()).toBe(true)

    const preview = { path: `/fixture/cache/previews/${id}.png`, step: 12, total: 30, seq: 1 }
    await emitJob(page, id, { stage: 'denoise', progress: { stage: 'denoise', current: 12, total: 30, percent: 40, etaMs: 7600 }, preview })
    await expect.poll(() => card.locator('[data-card-progress]').textContent()).toBe('12 / 30 · 约 8 秒')
    const front = card.locator('[data-live-preview] img[data-preview-front]')
    await expect.poll(() => front.getAttribute('src')).toContain('seq=1')
    expect(await card.getByRole('progressbar', { name: '生成进度' }).getAttribute('aria-valuenow')).toBe('40')
    await app.screenshot('board-live-preview-light')

    await emitJob(page, id, {
      progress: { stage: 'denoise', current: 18, total: 30, percent: 60, etaMs: 5000 },
      preview: { ...preview, step: 18, seq: 2 },
    })
    await expect.poll(() => front.getAttribute('src')).toContain('seq=2')
    // Never blank between frames: a front picture is always up.
    expect(await front.count()).toBe(1)

    await emitJob(page, id, { stage: 'decode', progress: { stage: 'decode', current: 30, total: 30, percent: 100 } })
    await expect.poll(() => card.locator('[data-card-progress]').textContent()).toBe('还原图像')

    await emitJob(page, id, { state: 'failed', preview: undefined, error: { code: 'E_OOM', message: '显存不够，换小一点的尺寸再试' } })
    await expect.poll(() => card.getByRole('alert').textContent()).toBe('显存不够，换小一点的尺寸再试')
    expect(await card.getByRole('button', { name: '重试 画面 1' }).isVisible()).toBe(true)
  })

  /** Bounding boxes of every wire chip on screen. */
  async function chipBoxes(page: Page): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
    return page.locator('[data-wire-chip] button[aria-label^="连线："]').evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }),
    )
  }

  function overlapping(boxes: Array<{ x: number; y: number; width: number; height: number }>): string[] {
    const hits: string[] = []
    boxes.forEach((a, i) =>
      boxes.slice(i + 1).forEach((b, k) => {
        if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) hits.push(`${i}×${i + k + 1}`)
      }),
    )
    return hits
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`draws wires in the ${theme} theme, chips of one source never overlapping`, async () => {
      // One picture feeds the canvas in three roles; a second one as another control kind.
      const page = await openBoard(app, {
        theme,
        adapters: true,
        inputs: {
          init: { link: { canvasId: 'img-1' }, strength: 0.6 },
          control: {
            adapterId: 'control-union',
            images: [
              { kind: 'depth', link: { canvasId: 'img-1' }, strength: 1, start: 0, end: 1 },
              { kind: 'canny', link: { canvasId: 'img-2' }, strength: 1, start: 0, end: 1 },
            ],
          },
          references: { links: [{ canvasId: 'img-1' }] },
        },
      })
      expect(await page.locator('[data-wire-kind="input"]').count()).toBe(4)
      for (const name of ['起始图 60%', '控制 · 深度', '控制 · 边缘', '参考 1']) {
        expect(await page.getByRole('button', { name: `连线：${name}` }).isVisible()).toBe(true)
      }
      const boxes = await chipBoxes(page)
      expect(boxes).toHaveLength(4)
      expect(overlapping(boxes)).toEqual([])
      // Chips sit on the consumer's side, left of its picture.
      const body = (await page.locator('article[data-canvas-card="canvas-1"] [data-card-body]').boundingBox())!
      for (const box of boxes) expect(box.x + box.width).toBeLessThanOrEqual(body.x)
      await app.screenshot(`board-wires-${theme}`)

      // Zoomed out the chips keep their size, spread apart with their ports, and still do not overlap.
      const zoomOut = page.getByRole('button', { name: '缩小' })
      for (let step = 0; step < 2; step += 1) await zoomOut.click()
      await settle(page)
      const far = await chipBoxes(page)
      expect(far).toHaveLength(4)
      expect(far.every((box) => Math.round(box.height) === Math.round(boxes[0]!.height))).toBe(true)
      expect(overlapping(far)).toEqual([])
      await app.screenshot(`board-wires-zoomed-out-${theme}`)
      // Too far out for labels: the cards are tiny, so the chips step aside.
      for (let step = 0; step < 2; step += 1) await zoomOut.click()
      await expect.poll(() => chipBoxes(page).then((list) => list.length)).toBe(0)
      expect(await page.locator('[data-wire-kind="input"]').count()).toBe(4)
    })
  }
})
