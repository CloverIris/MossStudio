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
  /** img-2 records its pixel size (800 × 1280), as pictures imported now do. */
  pictureSizes?: boolean
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
        ...(options.pictureSizes ? { imageSize: { width: 800, height: 1280 } } : {}),
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
    { inputs: setup.inputs, features: setup.features, adapters: setup.adapters, outputs: setup.outputs, pictureSizes: setup.pictureSizes },
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

/**
 * Drag a wire from a card's output port over another card; its face shows
 * one drop zone per input. Returns the zone labels; with `zone`, lets go on
 * that zone, with `hold` keeps the button down over it.
 */
async function dragToZone(page: Page, from: string, to: string, zone?: string, hold = false): Promise<string[]> {
  await page.locator(`article[data-canvas-card="${from}"]`).hover()
  const start = await center(page, `[data-output-port="${from}"]`)
  const end = await center(page, `article[data-canvas-card="${to}"] [data-card-body]`)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 })
  await page.mouse.move(end.x, end.y, { steps: 5 })
  const zones = page.locator(`article[data-canvas-card="${to}"] [data-drop-zone]`)
  await expect.poll(() => zones.count()).toBeGreaterThan(0)
  const labels = await zones.evaluateAll((items) => items.map((item) => item.getAttribute('data-drop-zone') ?? ''))
  if (zone) {
    const target = await center(page, `article[data-canvas-card="${to}"] [data-drop-zone="${zone}"]`)
    await page.mouse.move(target.x, target.y, { steps: 3 })
    if (!hold) await page.mouse.up()
  } else if (!hold) await page.mouse.up()
  return labels
}

/** Open the ＋ beside a card and choose an input (and, when given, how to fill it). */
async function addInput(page: Page, canvasId: string, input: string, how?: string): Promise<void> {
  await page.locator(`article[data-canvas-card="${canvasId}"]`).hover()
  await page.locator(`[data-input-adder="${canvasId}"] button`).first().click()
  const items = page.getByRole('menuitem', { name: input, exact: true })
  if (await items.count()) await items.first().click()
  if (how) await page.getByRole('menuitem', { name: how }).click()
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

  it('connects a picture by dragging a wire onto the start-picture zone', async () => {
    const page = await openBoard(app, { adapters: true })
    expect(await page.locator('[data-wire-kind="input"]').count()).toBe(0)
    // Over the card, its face shows what it can take, one zone each (no control adapter chosen yet).
    const zones = await dragToZone(page, 'img-1', 'canvas-1', '起始图')
    expect(zones).toEqual(['起始图', '控制', '参考图'])

    const chip = page.getByRole('button', { name: '连线：起始图 60%' })
    await chip.waitFor()
    expect(await page.locator('[data-wire-kind="input"]').count()).toBe(1)
    // The linked picture shows as its thumbnail at the wire's end, and as the canvas's backdrop.
    expect(await page.locator('[data-input-thumb="input:canvas-1:init:"]').count()).toBe(1)
    expect(await page.locator('article[data-canvas-card="canvas-1"] [data-init-backdrop]').count()).toBe(1)
    await expect.poll(() => savedInputs(page), { timeout: 10_000 }).toMatchObject({ init: { link: { canvasId: 'img-1' }, strength: 0.6 } })
  })

  it('offers one zone per kind of the chosen control adapter and links one', async () => {
    const page = await openBoard(app, { adapters: true, inputs: { control: { adapterId: 'control-union', images: [] } } })
    const zones = await dragToZone(page, 'img-2', 'canvas-1', '控制 · 深度')
    expect(zones).toEqual(['起始图', '控制 · 深度', '控制 · 边缘', '控制 · 姿态', '参考图'])
    await page.getByRole('button', { name: '连线：控制 · 深度' }).waitFor()
    await expect
      .poll(() => savedInputs(page), { timeout: 10_000 })
      .toMatchObject({ control: { adapterId: 'control-union', images: [{ kind: 'depth', link: { canvasId: 'img-2' } }] } })
  })

  it('leaves out roles the engine does not support', async () => {
    const page = await openBoard(app, { adapters: true, features: { control: false, references: false } })
    expect(await dragToZone(page, 'img-1', 'canvas-1')).toEqual(['起始图'])
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
      for (let step = 0; step < 3; step += 1) await zoomOut.click()
      await expect.poll(() => chipBoxes(page).then((list) => list.length)).toBe(0)
      expect(await page.locator('[data-wire-kind="input"]').count()).toBe(4)
    })
  }
})

describe('readable nodes', () => {
  const app = useApp()
  const card = (page: Page, id = 'canvas-1') => page.locator(`article[data-canvas-card="${id}"]`)

  it('shows only the picture or description and the title at rest; the rest on hover or selection', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await openBoard(app, { theme })
      // Nothing to read on the board but content: no empty sockets, settings pills or "尚未生成".
      expect(await card(page).locator('[data-face-description]').textContent()).toBe('一只橘猫坐在窗台上')
      expect(await card(page).locator('[data-card-chips]').count()).toBe(0)
      expect((await card(page).locator('header').textContent())?.replace('画面 1', '').trim()).toBe('')
      expect(await page.locator('[data-empty-port], [data-empty-port-dot]').count()).toBe(0)
      // The selected 画面 offers one ＋ for inputs; a picture card takes nothing in.
      await page.locator('[data-input-adder="canvas-1"] button').click()
      expect(await page.getByRole('menuitem').allTextContents()).toEqual(['起始图', '控制', '参考图'])
      await page.keyboard.press('Escape')
      await card(page, 'img-1').hover()
      expect(await page.locator('[data-input-adder="img-1"]').count()).toBe(0)
      await app.screenshot(`board-readable-node-${theme}`)
    }
  })

  it('adds an input from the ＋: from a file or from the board', async () => {
    const page = await openBoard(app)
    await page.evaluate(() => window.__mock.handle(window.__mock.Ipc.pickImages, () => ['/home/me/pictures/sofa.png']))
    await addInput(page, 'canvas-1', '起始图', '从文件…')
    await expect.poll(async () => (await savedInputs(page))?.init?.link.canvasId ?? '', { timeout: 10_000 }).toMatch(/.+/)
    const picture = (await savedInputs(page))!.init!.link.canvasId
    expect(await page.locator(`article[data-canvas-card="${picture}"]`).count()).toBe(1)
    await expect.poll(() => page.locator('[data-wire-chip="input:canvas-1:init:"]').textContent()).toBe('起始图 60%')
    // A linked start picture is no longer offered.
    await addInput(page, 'canvas-1', '参考图', '从画板选择')
    await expect.poll(() => page.locator('[data-pick-hint]').textContent()).toContain('参考图')
    await page.locator('article[data-canvas-card="img-2"] [data-card-body]').click()
    await expect
      .poll(async () => (await savedInputs(page))?.references?.links.map((link) => link.canvasId), { timeout: 10_000 })
      .toEqual(['img-2'])
  })

  it('a zone that cannot take the wire says why, only while the wire is over it', async () => {
    const page = await openBoard(app)
    await dragToZone(page, 'img-2', 'canvas-1', '参考图')
    await expect.poll(async () => (await savedInputs(page))?.references?.links, { timeout: 10_000 }).toEqual([{ canvasId: 'img-2' }])
    // No role menu: the zone already said what the picture is for.
    expect(await page.getByRole('menu').count()).toBe(0)

    // No control adapter installed: the 控制 zone refuses and says what to do.
    await dragToZone(page, 'img-1', 'canvas-1', '控制', true)
    const zone = page.locator('article[data-canvas-card="canvas-1"] [data-drop-zone="控制"]')
    await expect.poll(() => zone.textContent()).toContain('需要先添加控制适配器')
    expect(await page.locator('article[data-canvas-card="canvas-1"] [data-drop-zone="起始图"]').textContent()).toBe('起始图')
    await app.screenshot('board-socket-refused-light')
    await page.mouse.up()
    expect((await savedInputs(page))?.control).toBeUndefined()
    await expect.poll(() => page.locator('[data-drop-zones]').count()).toBe(0)
  })

  it('asks which control adapter to use, then offers one input per kind', async () => {
    const page = await openBoard(app, { adapters: true })
    await addInput(page, 'canvas-1', '控制', 'moss-control-union.safetensors')
    await page.locator('[data-input-adder="canvas-1"] button').click()
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['起始图', '控制 · 深度', '控制 · 边缘', '控制 · 姿态', '参考图'])
    await page.keyboard.press('Escape')
    await dragToZone(page, 'img-2', 'canvas-1', '控制 · 边缘')
    await expect
      .poll(async () => (await savedInputs(page))?.control?.images.map((image) => image.kind), { timeout: 10_000 })
      .toEqual(['canny'])
  })

  it('writes the description on the card itself', async () => {
    const page = await openBoard(app)
    await card(page)
      .locator('[data-card-body]')
      .dblclick({ position: { x: 120, y: 140 } })
    const editor = card(page).locator('[data-face-editor]')
    await expect.poll(() => editor.evaluate((element) => element === document.activeElement)).toBe(true)
    await editor.fill('一只橘猫在雪地里')
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => card(page).locator('[data-face-description]').textContent()).toBe('一只橘猫在雪地里')
    await expect
      .poll(() => page.evaluate(() => window.__mock.state.projects[0]?.canvases.find((item) => item.id === 'canvas-1')?.prompt), {
        timeout: 10_000,
      })
      .toBe('一只橘猫在雪地里')
    // The left panel shows the same text.
    expect(await page.getByRole('textbox', { name: '描述' }).first().inputValue()).toBe('一只橘猫在雪地里')

    // Esc leaves it as it was.
    await card(page)
      .locator('[data-card-body]')
      .dblclick({ position: { x: 120, y: 140 } })
    await editor.fill('不要这个')
    await page.keyboard.press('Escape')
    await expect.poll(() => card(page).locator('[data-face-description]').textContent()).toBe('一只橘猫在雪地里')
  })
})

describe('filmstrip, 用作起始图 and recipes', () => {
  const app = useApp()
  const card = (page: Page, id = 'canvas-1') => page.locator(`article[data-canvas-card="${id}"]`)
  const saved = (page: Page, id: string) =>
    page.evaluate((canvasId) => window.__mock.state.projects[0]?.canvases.find((item) => item.id === canvasId) ?? null, id)
  const cardIds = (page: Page) =>
    page.locator('article[data-canvas-card]').evaluateAll((items) => items.map((item) => item.getAttribute('data-canvas-card')))

  /**
   * canvas-1 as an older project saved it: two runs as result cards of their
   * own (now folded into its filmstrip) and one pinned to the board.
   */
  async function openWithRuns(theme: 'light' | 'dark' = 'light'): Promise<Page> {
    const page = await app.open({ scenario: 'ready', route: '/studio', defer: true, theme })
    await page.evaluate(() => {
      const { canvasFixture, projectFixture, engineFeaturesFixture } = window.__mock.fixtures
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
      const layout = canvasFixture({ id: 'canvas-1', title: '画面 1', prompt: '一只橘猫坐在窗台上', x: 420, y: 0 })
      const run = (id: string, y: number, extra: object = {}) =>
        canvasFixture({
          id,
          kind: 'result',
          title: '画面 1 · 结果',
          prompt: '一只橘猫坐在窗台上',
          x: 420,
          y,
          sourceCanvasId: 'canvas-1',
          jobState: 'succeeded',
          outputs: [{ path: `/fixture/outputs/${id}-1024x1024.png`, width: 1024, height: 1024, seed: y }],
          ...extra,
        } as never)
      window.__mock.state.projects = [
        projectFixture({
          id: 'project-1',
          name: '小猫',
          canvases: [picture, layout, run('run-1', 380), run('run-2', 760), run('kept', 1140, { pinned: true, x: 860 })],
          selectedCanvasId: 'canvas-1',
        }),
      ]
      window.__mock.state.engineFeatures = engineFeaturesFixture({})
      window.__mock.state.controlAdapters = []
    })
    await app.start()
    await card(page).waitFor()
    await settle(page, 150)
    return page
  }

  it("stacks a 画面's runs in its filmstrip; a pinned one stays a card with its lineage wire", async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await openWithRuns(theme)
      expect(await cardIds(page)).toEqual(['img-1', 'canvas-1', 'kept'])
      // Every run is in the strip, the pinned one too.
      const strip = card(page).locator('[data-filmstrip]')
      expect(await strip.getByRole('button', { name: /^第 \d 张$/ }).count()).toBe(3)
      // The newest is on the face.
      expect(await strip.getByRole('button', { name: '第 3 张' }).getAttribute('aria-pressed')).toBe('true')
      expect(await page.locator('[data-wire="lineage:kept"]').count()).toBe(1)
      await app.screenshot(`board-filmstrip-${theme}`)
      // Not selected, the strip steps back to a count on the face.
      await card(page, 'img-1').locator('[data-card-body]').click()
      await expect.poll(() => card(page).locator('[data-strip-count]').textContent()).toBe('3')
    }
  })

  it('picks a picture for the face, and pins one by dragging it onto the board', async () => {
    const page = await openWithRuns()
    const strip = card(page).locator('[data-filmstrip]')
    await strip.getByRole('button', { name: '第 1 张' }).click()
    await expect.poll(async () => (await saved(page, 'canvas-1'))?.shownOutput, { timeout: 10_000 }).toEqual({ canvasId: 'run-1' })
    const face = card(page).getByRole('button', { name: '查看 画面 1 的结果' })
    expect(await face.locator('img').getAttribute('src')).toContain('run-1-1024x1024.png')

    // Drag the second picture out of the strip and let go below the card.
    const thumb = (await strip.getByRole('button', { name: '第 2 张' }).boundingBox())!
    const body = (await card(page).boundingBox())!
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumb.x + 40, thumb.y + 40, { steps: 4 })
    await expect.poll(() => page.locator('[data-run-drag]').count()).toBe(1)
    await page.mouse.move(body.x + body.width / 2, body.y + body.height + 120, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => cardIds(page)).toEqual(['img-1', 'canvas-1', 'run-2', 'kept'])
    await expect.poll(async () => (await saved(page, 'run-2'))?.pinned, { timeout: 10_000 }).toBe(true)
    // It is a card now, and still in its 画面's strip.
    expect(await strip.getByRole('button', { name: /^第 \d 张$/ }).count()).toBe(3)
    expect(await page.locator('[data-wire="lineage:run-2"]').count()).toBe(1)

    // 收回 puts it back into the strip.
    await card(page, 'run-2').hover()
    await card(page, 'run-2')
      .getByRole('button', { name: /更多操作$/ })
      .click()
    await page.getByRole('menuitem', { name: '收回到「画面 1」' }).click()
    await expect.poll(() => cardIds(page)).toEqual(['img-1', 'canvas-1', 'kept'])
  })

  it('用作起始图: a new 画面 to the right, wired from the picture on the face', async () => {
    const page = await openWithRuns()
    await card(page).locator('[data-filmstrip]').getByRole('button', { name: '第 2 张' }).click()
    await card(page).getByRole('button', { name: '画面 1 更多操作' }).click()
    await page.getByRole('menuitem', { name: '用作起始图' }).click()
    await expect.poll(async () => (await cardIds(page)).length).toBe(5)
    const created = (await cardIds(page)).find((id) => !['img-1', 'canvas-1', 'run-2', 'kept'].includes(id!))!
    // The run it starts from became a card of its own, and feeds the new 画面.
    await expect
      .poll(async () => (await saved(page, created))?.inputs?.init, { timeout: 10_000 })
      .toEqual({ link: { canvasId: 'run-2' }, strength: 0.6 })
    expect((await saved(page, created))?.prompt).toBe('一只橘猫坐在窗台上')
    expect(await page.locator(`[data-wire-chip="input:${created}:init:"]`).textContent()).toBe('起始图 60%')
    const source = (await card(page).boundingBox())!
    const fresh = (await card(page, created).boundingBox())!
    expect(fresh.x).toBeGreaterThan(source.x + source.width)
    // It is the selected card, ready to be described.
    expect(await card(page, created).getAttribute('aria-current')).toBe('true')
  })

  it('a wire dropped on the empty board offers a new 画面 fed by the picture', async () => {
    const page = await openWithRuns()
    await card(page, 'img-1').hover()
    const start = await center(page, '[data-output-port="img-1"]')
    const body = (await card(page, 'img-1').boundingBox())!
    const end = { x: body.x + body.width / 2, y: body.y + body.height + 200 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await page.mouse.up()
    const menu = page.getByRole('menu', { name: '用「小猫照片」新建画面' })
    await expect.poll(() => menu.isVisible()).toBe(true)
    await menu.getByRole('menuitem', { name: '新画面 · 参考图' }).click()
    await expect.poll(async () => (await cardIds(page)).length).toBe(4)
    const created = (await cardIds(page)).find((id) => !['img-1', 'canvas-1', 'kept'].includes(id!))!
    await expect
      .poll(async () => (await saved(page, created))?.inputs?.references?.links, { timeout: 10_000 })
      .toEqual([{ canvasId: 'img-1' }])
  })

  it('starts from a recipe: the picture comes from a file, and 局部重绘 opens the mask', async () => {
    const page = await openWithRuns()
    // One ＋ holds the ways to start. No control adapter yet: 按构图生成 is off and says why on hover.
    await page.getByRole('button', { name: '新建', exact: true }).click()
    const compose = page.getByRole('menuitem', { name: /按构图生成/ })
    expect(await compose.isDisabled()).toBe(true)
    expect(await compose.getAttribute('title')).toBe('需要先在模型页添加控制适配器')
    await app.screenshot('board-recipes-light')

    await page.evaluate(() => window.__mock.handle(window.__mock.Ipc.pickImages, () => ['/home/me/pictures/sofa.png']))
    await page.getByRole('menuitem', { name: '局部重绘' }).click()
    await expect.poll(async () => (await cardIds(page)).length, { timeout: 10_000 }).toBe(5)
    // The new 画面 (selected) and the picture card that feeds it.
    const created = await page.locator('article[data-canvas-kind="layout"][aria-current="true"]').getAttribute('data-canvas-card')
    expect(created).not.toBe('canvas-1')
    await expect.poll(async () => (await saved(page, created!))?.inputs?.init?.link.canvasId ?? '', { timeout: 10_000 }).toMatch(/.+/)
    await expect.poll(() => page.getByRole('toolbar', { name: '遮罩工具' }).isVisible()).toBe(true)
  })
})

describe('风格 and 放大 nodes', () => {
  const app = useApp()
  const card = (page: Page, id: string) => page.locator(`article[data-canvas-card="${id}"]`)
  const selectedId = (page: Page) => page.locator('article[data-canvas-card][aria-current="true"]').getAttribute('data-canvas-card')
  const jobs = (page: Page) => page.evaluate((channel) => window.__mock.callsTo(channel) as Array<Record<string, unknown>>, ENGINE_JOBS)

  it('放大 a picture: a node with one 原图 socket, its size from the 原图, and a run that redraws it larger', async () => {
    // 线稿 is an 800 × 1280 picture: ×2 is 1600 × 2560, kept within 2048 on the long edge.
    for (const theme of ['light', 'dark'] as const) {
      const page = await openBoard(app, { theme, pictureSizes: true })
      await card(page, 'img-2').hover()
      await card(page, 'img-2').getByRole('button', { name: '线稿 更多操作' }).click()
      await page.getByRole('menuitem', { name: '放大', exact: true }).click()
      await expect.poll(() => page.locator('article[data-node="upscale"]').count()).toBe(1)
      const id = (await selectedId(page))!
      expect(await card(page, id).locator('header').textContent()).toContain('放大 1')
      // One socket, the 原图, already wired; the size is the 原图's times two, within 2048.
      expect(await page.locator(`[data-wire-chip="input:${id}:init:"]`).textContent()).toBe('原图')
      expect(await page.locator(`[data-empty-port^="${id}/"]`).count()).toBe(0)
      // The left panel sums it up; opened, 放大倍数 and 细节 instead of 尺寸, and no 输入 section.
      const summary = page.locator('[data-settings-summary]')
      expect(await summary.textContent()).toContain('放大 ×2')
      await summary.click()
      expect(await page.getByText('1280 × 2048').isVisible()).toBe(true)
      expect(await page.getByRole('group', { name: '放大倍数' }).isVisible()).toBe(true)
      expect(await page.getByRole('group', { name: '尺寸' }).count()).toBe(0)
      await app.screenshot(`board-upscale-${theme}`)
      if (theme === 'dark') break

      await page.getByRole('group', { name: '放大倍数' }).getByRole('button', { name: '×1.5' }).click()
      await expect.poll(() => page.getByText('1200 × 1920').isVisible()).toBe(true)
      await page.getByRole('group', { name: '细节' }).getByRole('button', { name: '更多细节' }).click()
      await page.locator('[data-studio-generate]').click()
      await expect.poll(async () => (await jobs(page)).length, { timeout: 10_000 }).toBe(1)
      const [job] = await jobs(page)
      expect(job).toMatchObject({ width: 1200, height: 1920, prompt: '高清，细节清晰，画质细腻' })
      expect(job!['initImage']).toMatchObject({ strength: 0.55, resize: 'stretch' })
      expect(String((job!['initImage'] as { path: string }).path)).toContain('lines-800x1280.png')
    }
  })

  it('a 风格 wired into a 画面 adds its description to what the 画面 generates', async () => {
    const page = await openBoard(app)
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await page.getByRole('menuitem', { name: '新建风格' }).click()
    await expect.poll(() => page.locator('article[data-canvas-kind="style"]').count()).toBe(1)
    const styleId = (await selectedId(page))!
    await page.getByRole('textbox', { name: '风格描述' }).fill('水彩插画，柔和的粉色调')
    await expect.poll(() => card(page, styleId).locator('[data-face-description]').textContent()).toBe('水彩插画，柔和的粉色调')
    // The 画面's ＋ now offers 风格; a wire from the 风格 dropped on the 画面 links it.
    await page.locator('article[data-canvas-card="canvas-1"]').hover()
    await page.locator('[data-input-adder="canvas-1"] button').click()
    expect(await page.getByRole('menuitem').allTextContents()).toContain('风格')
    await page.keyboard.press('Escape')
    expect(await dragToZone(page, styleId, 'canvas-1', '风格')).toEqual(['风格'])
    await expect.poll(async () => (await savedInputs(page))?.styles?.links, { timeout: 10_000 }).toEqual([{ canvasId: styleId }])
    expect(await page.locator('[data-wire-chip="input:canvas-1:style:0"]').textContent()).toBe('风格 1')
    await card(page, styleId).locator('[data-card-body]').click()
    await expect.poll(() => page.locator('[data-style-users]').textContent()).toContain('1 个')
    await app.screenshot('board-style-light')

    await card(page, 'canvas-1').locator('header button').first().click()
    await page.locator('[data-studio-generate]').click()
    await expect.poll(async () => (await jobs(page)).length, { timeout: 10_000 }).toBe(1)
    expect((await jobs(page))[0]!['prompt']).toBe('一只橘猫坐在窗台上，水彩插画，柔和的粉色调')
    // The 画面's own description is unchanged.
    expect(await page.getByRole('textbox', { name: '描述' }).first().inputValue()).toBe('一只橘猫坐在窗台上')
  })

  it('一组同风格的图: a 风格 and three 画面 wired to it', async () => {
    const page = await openBoard(app)
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await page.getByRole('menuitem', { name: '一组同风格的图' }).click()
    await expect.poll(() => page.locator('article[data-canvas-kind="style"]').count()).toBe(1)
    // The 风格 is selected, ready to be described.
    const styleId = (await selectedId(page))!
    expect(await page.locator(`article[data-canvas-card="${styleId}"]`).getAttribute('data-canvas-kind')).toBe('style')
    await expect.poll(() => page.locator(`[data-wire^="input:"][data-wire$=":style:0"]`).count()).toBe(3)
    expect(await page.locator('[data-style-users]').textContent()).toContain('3 个')
  })
})
