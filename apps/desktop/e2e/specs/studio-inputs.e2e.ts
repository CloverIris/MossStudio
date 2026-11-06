/**
 * 创作 › 输入 and 高级 sampling: a start picture from a file or from the board,
 * 重绘幅度, control adapters, references, sampler / scheduler / 高清修复, and how
 * all of it reaches the job; features the engine lacks are hidden, a missing
 * engine or an ungenerated source blocks 生成 with the reason. Also the 模型
 * page's control adapters and Library › 用作起始图.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { CanvasInputs, EngineFeatures, JobParams, JobSampling } from '@shared/types'
import { settle, useApp, type E2eApp } from '../support/app'

const ENGINE_JOBS = 'http:POST /api/engine-jobs'

type JobBody = JobParams & { canvasId: string; projectId: string }

interface StudioSetup {
  /** Inputs of canvas-1 (the selected layout). */
  inputs?: CanvasInputs
  sampling?: JobSampling
  /** null = no usable engine. */
  features?: Partial<EngineFeatures> | null
  adapters?: boolean
  /** canvas-2: a layout with no picture yet, used as an ungenerated source. */
  emptySource?: boolean
  theme?: 'light' | 'dark'
}

/** A project with a picture card (img-1, generated) and a layout canvas (canvas-1, selected). */
async function openStudio(app: E2eApp, setup: StudioSetup = {}): Promise<Page> {
  const page = await app.open({ scenario: 'ready', route: '/studio', defer: true, theme: setup.theme })
  await page.evaluate(
    (options) => {
      const { canvasFixture, projectFixture, engineFeaturesFixture, controlAdapterFixture } = window.__mock.fixtures
      const picture = canvasFixture({
        id: 'img-1',
        kind: 'image',
        title: '小猫照片',
        imagePath: '/fixture/projects/project-1/assets/cat.png',
        x: 0,
        y: 0,
        width: 1024,
        height: 768,
        steps: 1,
      })
      const layout = canvasFixture({
        id: 'canvas-1',
        title: '画面 1',
        prompt: '一只橘猫坐在窗台上',
        x: 420,
        y: 0,
        seedLocked: false,
        ...(options.inputs ? { inputs: options.inputs } : {}),
        ...(options.sampling ? { sampling: options.sampling } : {}),
      })
      const canvases = [picture, layout]
      if (options.emptySource) canvases.push(canvasFixture({ id: 'canvas-2', title: '画面 2', prompt: '草图', x: 840, y: 0 }))
      window.__mock.state.projects = [projectFixture({ id: 'project-1', name: '小猫', canvases, selectedCanvasId: 'canvas-1' })]
      window.__mock.state.engineFeatures = options.features === null ? null : engineFeaturesFixture(options.features ?? {})
      window.__mock.state.controlAdapters = options.adapters ? [controlAdapterFixture()] : []
    },
    { inputs: setup.inputs, sampling: setup.sampling, features: setup.features, adapters: setup.adapters, emptySource: setup.emptySource },
  )
  await app.start()
  await page.locator('[data-project-switcher]').waitFor()
  await page.locator('article[data-canvas-card="canvas-1"]').waitFor()
  await settle(page, 150)
  return page
}

async function submitted(page: Page, count: number): Promise<JobBody[]> {
  await page.waitForFunction(([channel, n]) => window.__mock.callsTo(channel as string).length >= (n as number), [
    ENGINE_JOBS,
    count,
  ] as const)
  return page.evaluate((channel) => window.__mock.callsTo(channel) as JobBody[], ENGINE_JOBS)
}

async function savedInputs(page: Page, canvasId = 'canvas-1'): Promise<CanvasInputs | null> {
  return page.evaluate((id) => window.__mock.state.projects[0]?.canvases.find((canvas) => canvas.id === id)?.inputs ?? null, canvasId)
}

const inputs = (page: Page) => page.locator('[data-inputs-section]')
const generate = (page: Page) => page.locator('[data-studio-generate]')

/** Answer the next picture-file dialog with these paths. */
async function pickFiles(page: Page, paths: string[]): Promise<void> {
  await page.evaluate((files) => window.__mock.handle(window.__mock.Ipc.pickImages, () => files), paths)
}

describe('studio inputs', () => {
  const app = useApp()

  it('sets a start picture from a file, changes 重绘幅度, and the job carries the resolved path and strength', async () => {
    const page = await openStudio(app)
    await pickFiles(page, ['/home/me/Pictures/sketch.png'])
    await inputs(page).getByRole('button', { name: '添加起始图' }).click()
    await page.getByRole('menuitem', { name: '从文件…' }).click()

    // The picture becomes a card on the board, linked as the start picture.
    await expect.poll(() => savedInputs(page).then((value) => value?.init?.strength), { timeout: 10_000 }).toBe(0.6)
    const imported = await page.evaluate(() => window.__mock.state.projects[0]!.canvases.find((canvas) => canvas.title === 'sketch'))
    expect(imported).toMatchObject({ kind: 'image', imagePath: '/fixture/projects/project-1/assets/sketch.png' })
    expect(await app.calls('studio:import-image')).toEqual([{ projectId: 'project-1', path: '/home/me/Pictures/sketch.png' }])
    const row = inputs(page).locator('[data-input-row="起始图"]')
    await expect.poll(() => row.getByText('sketch').isVisible()).toBe(true)

    await row.getByRole('slider', { name: '重绘幅度' }).fill('0.35')
    await expect.poll(() => row.getByText('35%').isVisible()).toBe(true)
    // The mask row appears once there is a start picture.
    await expect.poll(() => page.locator('[data-mask-row]').getByText(/未画/).isVisible()).toBe(true)

    await generate(page).click()
    const [job] = await submitted(page, 1)
    expect(job!.initImage).toEqual({ path: '/fixture/projects/project-1/assets/sketch.png', strength: 0.35 })
    expect(job!.mask).toBeUndefined()

    // Removing it removes the link (the picture card stays on the board).
    await page.evaluate(() => window.__mock.finishJob(window.__mock.state.jobs[0]!.id))
    await row.getByRole('button', { name: '移除起始图' }).click()
    await expect.poll(() => savedInputs(page).then((value) => value?.init ?? null), { timeout: 10_000 }).toBeNull()
  })

  it('picks a start picture from the board; Esc cancels picking', async () => {
    const page = await openStudio(app)
    const add = inputs(page).getByRole('button', { name: '添加起始图' })
    await add.click()
    await page.getByRole('menuitem', { name: '从画板选择' }).click()
    await expect.poll(() => inputs(page).getByRole('status').textContent()).toContain('在画板上点一张有图片的卡片')
    await page.keyboard.press('Escape')
    await expect.poll(() => inputs(page).getByRole('status').count()).toBe(0)

    await add.click()
    await page.getByRole('menuitem', { name: '从画板选择' }).click()
    await page.locator('article[data-canvas-card="img-1"] [data-card-body]').click()
    await expect.poll(() => savedInputs(page).then((value) => value?.init?.link.canvasId), { timeout: 10_000 }).toBe('img-1')
    // Picking did not move the selection.
    expect(await page.locator('article[data-canvas-card="canvas-1"]').getAttribute('aria-current')).toBe('true')
    await expect.poll(() => inputs(page).locator('[data-input-row="起始图"]').getByText('小猫照片').isVisible()).toBe(true)
  })

  it('blocks 生成 with the reason while the source has no picture yet', async () => {
    const page = await openStudio(app, { emptySource: true, inputs: { init: { link: { canvasId: 'canvas-2' }, strength: 0.6 } } })
    await expect.poll(() => generate(page).isDisabled()).toBe(true)
    await expect.poll(() => page.getByText('起始图「画面 2」还没生成').isVisible()).toBe(true)
    expect(await app.calls(ENGINE_JOBS)).toEqual([])
  })

  it('uses a control adapter: choose it, link a depth picture, strength reaches the job', async () => {
    const page = await openStudio(app, {
      adapters: true,
      inputs: {
        control: { adapterId: 'control-union', images: [{ kind: 'depth', link: { canvasId: 'img-1' }, strength: 1, start: 0, end: 1 }] },
      },
    })
    const row = inputs(page).locator('[data-input-row="控制图 · 深度"]')
    await expect.poll(() => row.getByText('小猫照片').isVisible()).toBe(true)
    await row.getByRole('slider', { name: '强度' }).fill('0.5')
    await generate(page).click()
    const [job] = await submitted(page, 1)
    expect(job!.control).toEqual({
      adapter: '/fixture/models/control/moss-control-union.safetensors',
      images: [{ kind: 'depth', path: '/fixture/projects/project-1/assets/cat.png', strength: 0.5, start: 0, end: 1 }],
    })
  })

  it('points to 模型 when no control adapter is registered', async () => {
    const page = await openStudio(app)
    const control = page.locator('[data-control-row]')
    await expect.poll(() => control.getByText('需要控制适配器').isVisible()).toBe(true)
    await control.getByRole('button', { name: '去添加' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/models')
  })

  it('hides what the engine cannot do', async () => {
    const page = await openStudio(app, {
      features: { imageInput: false, control: false, references: false, samplers: false, hires: false },
    })
    await page.getByRole('button', { name: /高级/ }).first().click()
    await page.locator('[data-sampling-section]').waitFor()
    expect(await inputs(page).count()).toBe(0)
    expect(await page.getByRole('combobox', { name: '采样器' }).count()).toBe(0)
    expect(await page.getByRole('switch', { name: '高清修复' }).count()).toBe(0)
  })

  it('shows inputs disabled with the reason when no engine is usable', async () => {
    const page = await openStudio(app, { features: null })
    await expect.poll(() => inputs(page).getByText('没有可用的引擎，暂时不能添加图片').isVisible()).toBe(true)
    expect(await inputs(page).getByRole('button', { name: '添加起始图' }).isDisabled()).toBe(true)
    expect(await inputs(page).getByRole('button', { name: '添加参考图' }).isDisabled()).toBe(true)
  })

  it('sends the 高级 sampling choices; 高清修复 makes the result card the output size', async () => {
    const page = await openStudio(app)
    await page.getByRole('button', { name: /高级/ }).first().click()
    const sampler = page.getByRole('combobox', { name: '采样器' })
    await expect.poll(() => sampler.locator('option').first().textContent()).toBe('默认')
    await sampler.selectOption('dpmpp_2m')
    await page.getByRole('combobox', { name: '调度器' }).selectOption('karras')
    await page.getByRole('switch', { name: '高清修复' }).click()
    await page.getByRole('group', { name: '高清修复尺寸' }).getByRole('button', { name: '×1.5' }).click()
    await page.getByRole('combobox', { name: '步缓存' }).selectOption('fbcache')
    const truncation = page.getByRole('textbox', { name: 'CFG 截断' })
    await truncation.fill('0.6')
    await truncation.press('Enter')

    // First run renders in place; the second gets a result card.
    await generate(page).click()
    const [first] = await submitted(page, 1)
    expect(first!.sampling).toEqual({
      sampler: 'dpmpp_2m',
      scheduler: 'karras',
      hires: { width: 1536, height: 1536, strength: 0.35 },
      stepCache: 'fbcache',
      cfgTruncation: 0.6,
    })
    expect([first!.width, first!.height]).toEqual([1024, 1024])
    await page.evaluate(() => window.__mock.finishJob(window.__mock.state.jobs[0]!.id))
    await expect.poll(() => generate(page).isEnabled()).toBe(true)
    await generate(page).click()
    const [, second] = await submitted(page, 2)
    const result = await page.evaluate(
      (id) => window.__mock.state.projects[0]!.canvases.find((canvas) => canvas.id === id),
      second!.canvasId,
    )
    expect(result).toMatchObject({ kind: 'result', width: 1536, height: 1536, baseSize: { width: 1024, height: 1024 } })
  })

  it('looks right with inputs set, light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await openStudio(app, {
        theme,
        adapters: true,
        inputs: {
          init: { link: { canvasId: 'img-1' }, strength: 0.6 },
          mask: { path: '/fixture/projects/project-1/assets/mask-canvas-1.png' },
          control: { adapterId: 'control-union', images: [{ kind: 'depth', link: { canvasId: 'img-1' }, strength: 1, start: 0, end: 1 }] },
          references: { links: [{ canvasId: 'img-1' }] },
        },
      })
      await inputs(page).locator('[data-input-row="起始图"]').waitFor()
      await app.screenshot(`studio-inputs-${theme}`)
    }
  })
})

describe('模型 › 控制适配器', () => {
  const app = useApp()

  it('adds a control adapter file, shows the engine error for a wrong file, removes after confirming', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', theme: 'light' })
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: '控制适配器' }) })
    await expect.poll(() => section.getByText('还没有控制适配器').isVisible()).toBe(true)

    await page.evaluate(() => window.__mock.handle(window.__mock.Ipc.pickDialog, () => '/home/me/models/notes.txt'))
    await section.getByRole('button', { name: '添加文件' }).click()
    await expect.poll(() => page.getByText('没能添加：这个文件不是控制适配器').isVisible()).toBe(true)

    await page.evaluate(() => window.__mock.handle(window.__mock.Ipc.pickDialog, () => '/home/me/models/depth-control.safetensors'))
    await section.getByRole('button', { name: '添加文件' }).click()
    await expect.poll(() => section.getByText('depth-control.safetensors').isVisible()).toBe(true)
    for (const kind of ['深度', '边缘', '姿态']) expect(await section.getByText(kind, { exact: true }).isVisible()).toBe(true)
    await app.screenshot('models-control-adapters-light')

    await section.getByRole('button', { name: '移除 depth-control.safetensors' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '移除' }).click()
    await expect.poll(() => section.getByText('还没有控制适配器').isVisible()).toBe(true)
    expect(await app.calls('control-adapters:remove')).toEqual([{ id: 'control-1' }])
  })

  it('is hidden when the engine cannot use control adapters', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', defer: true })
    await page.evaluate(() => {
      window.__mock.state.engineFeatures = window.__mock.fixtures.engineFeaturesFixture({ control: false })
    })
    await app.start()
    await page.getByRole('heading', { name: '存储位置' }).waitFor()
    await settle(page, 150)
    expect(await page.getByRole('heading', { name: '控制适配器' }).count()).toBe(0)
  })
})

describe('作品 › 用作起始图', () => {
  const app = useApp()

  it('opens 创作 with the picture on the board linked as the start picture of a new canvas', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio', theme: 'light', defer: true })
    await page.evaluate(() => {
      const { galleryItemFixture } = window.__mock.fixtures
      window.__mock.state.gallery = [galleryItemFixture(0, { prompt: '海边的灯塔', seed: 1000 })]
    })
    await app.start()
    await page.locator('[data-project-switcher]').waitFor()
    await page.getByRole('button', { name: '作品' }).click()
    await page.locator('[data-library-item]').first().click()
    await page.getByRole('complementary', { name: '作品详情' }).getByRole('button', { name: '用作起始图' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/studio')

    const row = page.locator('[data-inputs-section] [data-input-row="起始图"]')
    await expect.poll(() => row.isVisible(), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => page.getByRole('textbox', { name: '描述', exact: true }).inputValue()).toBe('海边的灯塔')
    const imports = await app.calls<{ path: string }>('studio:import-image')
    expect(imports.at(-1)?.path).toBe('/fixture/outputs/moss_0000.png')
    await generate(page).click()
    const [job] = await submitted(page, 1)
    expect(job!.initImage).toMatchObject({ path: expect.stringContaining('/assets/moss_0000.png'), strength: 0.6 })
  })
})
