/**
 * 创作: describe, lay out regions, pick size and quality, generate, follow the
 * run, look at every output, run again; the project switcher and autosave.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { settle, useApp } from '../support/app'

const ENGINE_JOBS = 'http:POST /api/engine-jobs'

interface JobPayload {
  prompt: string
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  profile: string
  canvasId: string
  projectId: string
  negativePrompt: string
}

async function openStudio(page: Page): Promise<void> {
  // The project loads (or is created) before the switcher appears in the title bar.
  await page.locator('[data-project-switcher]').waitFor()
}

async function describeCanvas(page: Page, text: string): Promise<void> {
  const field = page.getByRole('textbox', { name: '描述', exact: true })
  await field.fill(text)
}

async function submitted(page: Page, count: number): Promise<JobPayload[]> {
  await page.waitForFunction(([channel, n]) => window.__mock.callsTo(channel as string).length >= (n as number), [
    ENGINE_JOBS,
    count,
  ] as const)
  return page.evaluate((channel) => window.__mock.callsTo(channel) as JobPayload[], ENGINE_JOBS)
}

async function lastJobId(page: Page): Promise<string> {
  return page.evaluate(() => window.__mock.state.jobs[0]!.id)
}

/** Drag a region on the selected canvas, in fractions of its picture. */
async function drawRegion(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.getByRole('button', { name: '画框', exact: true }).click()
  const surface = page.locator('[aria-current="true"] [data-region-surface]')
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 4 })
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 })
  await page.mouse.up()
}

describe('studio', () => {
  const app = useApp()

  it('generates from the description with the picked size and quality, random seed by default', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio' })
    await openStudio(page)
    const generate = page.locator('[data-studio-generate]')
    await expect.poll(() => generate.isDisabled()).toBe(true)
    await expect.poll(() => page.getByText('先写一句描述', { exact: true }).isVisible()).toBe(true)

    await describeCanvas(page, '海边的灯塔，黄昏，暖色调')
    // Model, size and LoRA fold into one line under the description.
    const summary = page.locator('[data-settings-summary]')
    expect(await summary.textContent()).toBe('MOSS-Image SFT · 1:1')
    await summary.click()
    await page.getByRole('group', { name: '尺寸' }).getByRole('button', { name: '16:9' }).click()
    expect(await summary.textContent()).toBe('MOSS-Image SFT · 16:9')
    await page.getByRole('group', { name: '质量' }).getByRole('button', { name: '精细' }).click()
    await expect.poll(() => generate.isEnabled()).toBe(true)
    await generate.click()

    const [first] = await submitted(page, 1)
    expect(first).toMatchObject({ prompt: '海边的灯塔，黄昏，暖色调', width: 1280, height: 720, steps: 50, profile: 'base' })
    expect(Number.isInteger(first!.seed) && first!.seed >= 0).toBe(true)

    // One run per canvas at a time: the button says so until it finishes.
    await expect.poll(() => generate.textContent()).toContain('生成中')
    await page.evaluate(() => window.__mock.finishJob(window.__mock.state.jobs[0]!.id))
    await expect.poll(() => generate.isEnabled()).toBe(true)

    // Ctrl+Enter generates too, with a fresh random seed.
    await page.getByRole('textbox', { name: '描述', exact: true }).click()
    await page.keyboard.press('Control+Enter')
    const [, second] = await submitted(page, 2)
    expect(second).toMatchObject({ prompt: '海边的灯塔，黄昏，暖色调', width: 1280, height: 720, steps: 50 })
    expect(second!.seed).not.toBe(first!.seed)
  })

  it('keeps a typed seed locked until unlocked', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio' })
    await openStudio(page)
    await describeCanvas(page, 'a red bicycle')
    await page.getByRole('button', { name: /高级/ }).click()
    await page.getByRole('textbox', { name: '种子' }).fill('1234')
    // Typing a seed locks it.
    const unlock = page.getByRole('button', { name: '解锁种子（每次随机）' })
    expect(await unlock.getAttribute('aria-pressed')).toBe('true')
    const generate = page.locator('[data-studio-generate]')
    await generate.click()
    await submitted(page, 1)
    await page.evaluate(() => window.__mock.finishJob(window.__mock.state.jobs[0]!.id))
    await generate.click()
    const [first, second] = await submitted(page, 2)
    expect([first!.seed, second!.seed]).toEqual([1234, 1234])

    await page.evaluate(() => window.__mock.finishJob(window.__mock.state.jobs[0]!.id))
    await unlock.click()
    expect(await page.getByRole('button', { name: '锁定种子（保持不变）' }).getAttribute('aria-pressed')).toBe('false')
    await generate.click()
    const [, , third] = await submitted(page, 3)
    expect(third!.seed).not.toBe(1234)
  })

  it('follows a run: progress and 取消 on the card, then every output in the viewer', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio', theme: 'light' })
    await openStudio(page)
    await describeCanvas(page, 'a quiet forest path')
    await page.locator('[data-studio-generate]').click()
    await submitted(page, 1)
    const id = await lastJobId(page)

    await page.evaluate((jobId) => window.__mock.progressJob(jobId), id)
    const progress = page.getByRole('progressbar', { name: '生成进度' })
    await progress.waitFor()
    await app.screenshot('studio-running-light')
    const cancel = page.getByRole('button', { name: '取消', exact: true })
    await expect.poll(() => cancel.isVisible()).toBe(true)
    await cancel.click()
    await expect.poll(() => app.calls('jobs:cancel')).toEqual([{ id }])

    // A second run that completes with four outputs. It stacks in the 画面's
    // filmstrip (the canceled run without a picture drops out of it).
    await page.locator('[data-studio-generate]').click()
    await submitted(page, 2)
    const second = await lastJobId(page)
    await page.evaluate((jobId) => window.__mock.finishJob(jobId, { outputs: 4 }), second)
    expect(await page.locator('article[data-canvas-card]').count()).toBe(1)
    // The newest thumbnails, then "+N" for the older ones: every output is reachable.
    const footer = page.locator('article[data-canvas-card] footer').filter({ has: page.getByRole('button', { name: '换个种子' }) })
    const thumbs = footer.getByRole('button', { name: /^第 \d 张$/ })
    await expect.poll(() => thumbs.count()).toBeGreaterThan(0)
    const visibleThumbs = await thumbs.count()
    if (visibleThumbs < 4) expect(await footer.getByRole('button', { name: `+${4 - visibleThumbs}` }).isVisible()).toBe(true)
    // The face shows the run's first picture until another is picked.
    const face = page.getByRole('button', { name: '查看 画面 1 的结果' })
    expect(decodeURIComponent((await face.locator('img').getAttribute('src')) ?? '')).toContain(`${second}-0.png`)
    await app.screenshot('studio-outputs-light')

    // Picking a thumbnail puts it on the face; the face opens the viewer there.
    const third = footer.getByRole('button', { name: '第 3 张' })
    await third.click()
    await expect.poll(() => third.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(async () => decodeURIComponent((await face.locator('img').getAttribute('src')) ?? '')).toContain(`${second}-2.png`)
    await face.click()
    const viewer = page.getByRole('dialog')
    await expect.poll(() => viewer.getByText(/第 3 \/ 4 张/).count()).toBeGreaterThan(0)
    await viewer.getByRole('button', { name: '下一张' }).click()
    await expect.poll(() => viewer.getByText(/第 4 \/ 4 张/).count()).toBeGreaterThan(0)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => viewer.getByText(/第 1 \/ 4 张/).count()).toBeGreaterThan(0)
    await viewer.getByRole('button', { name: '下一张' }).click()
    await expect.poll(() => viewer.getByText(/第 2 \/ 4 张/).count()).toBeGreaterThan(0)
    await viewer.getByRole('button', { name: '上一张' }).click()
    const shown = await viewer.locator('img').first().getAttribute('src')
    expect(decodeURIComponent(shown ?? '')).toContain(`${second}-0.png`)
    // The prompt and what to avoid sit above the parameters, as copyable blocks.
    expect(await viewer.locator('[data-prompt-block="描述"]').getByText('a quiet forest path').isVisible()).toBe(true)
    expect(await viewer.locator('[data-prompt-block="不想出现的内容"]').count()).toBe(1)
    await app.screenshot('studio-viewer-light')
    await viewer.getByRole('button', { name: '关闭' }).last().click()
    await expect.poll(() => viewer.count()).toBe(0)
  })

  it('runs again with a new seed or the same one', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio' })
    await openStudio(page)
    await describeCanvas(page, 'mountain lake')
    await page.locator('[data-studio-generate]').click()
    const [first] = await submitted(page, 1)
    await page.evaluate((jobId) => window.__mock.finishJob(jobId, { outputs: 1 }), await lastJobId(page))
    const result = page.locator('article[data-canvas-card]').filter({ has: page.getByRole('button', { name: '换个种子' }) })
    await result.getByRole('button', { name: '换个种子' }).click()
    const [, fresh] = await submitted(page, 2)
    expect(fresh).toMatchObject({ prompt: first!.prompt, width: first!.width, height: first!.height, steps: first!.steps })
    expect(fresh!.seed).not.toBe(first!.seed)

    // Once that run is done, both stack on the one 画面.
    await page.evaluate((jobId) => window.__mock.finishJob(jobId, { outputs: 1 }), await lastJobId(page))
    expect(await page.locator('article[data-canvas-card]').count()).toBe(1)
    // Picking the first picture, 重新生成 repeats that run exactly, seed included.
    await result.getByRole('button', { name: '第 1 张' }).click()
    await result.getByRole('button', { name: /^重新生成/ }).click()
    const [, , same] = await submitted(page, 3)
    expect(same).toMatchObject({ prompt: first!.prompt, seed: first!.seed, steps: first!.steps })
  })

  it('compiles the description and regions into the prompt, and reruns a region canvas', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio', theme: 'light' })
    await openStudio(page)
    await drawRegion(page, [0.1, 0.1], [0.6, 0.5])
    const caption = page.getByRole('textbox', { name: '区域描述' })
    await caption.waitFor()
    await caption.fill('一只橘猫')
    await drawRegion(page, [0.65, 0.6], [0.95, 0.95])
    await caption.fill('一盆绿植')
    // The regions are listed under the description.
    await expect.poll(() => page.getByRole('region', { name: '全部区域' }).locator('[data-layer-id]').count()).toBe(2)
    // Regions alone are not a prompt: the overall description is still asked for.
    await expect.poll(() => page.getByText('先写一句整体描述').isVisible()).toBe(true)
    await describeCanvas(page, '阳光明媚的客厅')
    await app.screenshot('studio-regions-light')
    await page.locator('[data-studio-generate]').click()
    const [run] = await submitted(page, 1)
    const layout = JSON.parse(run!.prompt) as { summary: { caption: string }; items: Array<{ caption: string }> }
    expect(layout.summary.caption).toBe('阳光明媚的客厅')
    expect(layout.items.map((item) => item.caption)).toEqual(['一只橘猫', '一盆绿植'])

    await page.evaluate((jobId) => window.__mock.finishJob(jobId, { outputs: 2 }), await lastJobId(page))
    await page.getByRole('button', { name: '换个种子' }).first().click()
    const [, again] = await submitted(page, 2)
    expect(again!.prompt).toBe(run!.prompt)
    expect(again!.seed).not.toBe(run!.seed)
  })

  it('reruns a saved region-only canvas whose description lives in the layout', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio', defer: true })
    await page.evaluate(() => {
      const { canvasFixture, projectFixture } = window.__mock.fixtures
      const layer = { id: 'r1', kind: 'object', caption: '红色气球', bbox: [100, 100, 500, 500], visible: true } as const
      const canvas = canvasFixture({
        id: 'canvas-1',
        title: '画面 1',
        prompt: '',
        summary: { caption: '节日海报', meta: [], canvas: 'single' },
        layers: [layer as never],
        seed: 77,
        seedLocked: false,
        outputs: [{ path: '/fixture/outputs/old.png', width: 1024, height: 1024, seed: 77 }],
      } as never)
      window.__mock.state.projects = [projectFixture({ id: 'project-1', name: '海报', canvases: [canvas], selectedCanvasId: 'canvas-1' })]
    })
    await app.start()
    await openStudio(page)
    await page.getByRole('button', { name: '换个种子' }).first().click()
    const [run] = await submitted(page, 1)
    const layout = JSON.parse(run!.prompt) as { summary: { caption: string }; items: Array<{ caption: string }> }
    expect(layout.summary.caption).toBe('节日海报')
    expect(layout.items[0]!.caption).toBe('红色气球')
    expect(run!.seed).not.toBe(77)
  })

  it('keeps projects: autosave, new, rename, delete with confirmation', async () => {
    const page = await app.open({ scenario: 'ready', route: '/studio' })
    await openStudio(page)
    await describeCanvas(page, 'autosaved description')
    const status = page.locator('header [role="status"]')
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toBe('已保存')
    const saved = await page.evaluate(() => window.__mock.state.projects[0])
    expect(JSON.stringify(saved?.canvases)).toContain('autosaved description')

    const switcher = page.locator('[data-project-switcher]')
    await switcher.click()
    await page.getByRole('menuitem', { name: '重命名' }).click()
    const name = page.getByRole('dialog').getByRole('textbox', { name: '名称' })
    await name.fill('海报')
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
    await expect.poll(() => switcher.textContent()).toContain('海报')
    await expect
      .poll(() => page.evaluate(() => window.__mock.state.projects.find((item) => item.name === '海报')?.id ?? null), { timeout: 10_000 })
      .not.toBeNull()

    await switcher.click()
    await page.getByRole('menuitem', { name: '新建项目' }).click()
    await expect.poll(() => switcher.textContent()).toContain('未命名项目')
    await expect.poll(() => page.getByRole('textbox', { name: '描述', exact: true }).inputValue()).toBe('')

    // Switch back to 海报 and delete it.
    await switcher.click()
    await page.getByRole('menuitem', { name: /海报/ }).click()
    await expect.poll(() => switcher.textContent()).toContain('海报')
    await expect.poll(() => page.getByRole('textbox', { name: '描述', exact: true }).inputValue()).toBe('autosaved description')
    await switcher.click()
    await page.getByRole('menuitem', { name: '删除项目' }).click()
    const confirm = page.getByRole('dialog')
    await expect.poll(() => confirm.getByText('删除「海报」？').isVisible()).toBe(true)
    await confirm.getByRole('button', { name: '删除项目' }).click()
    await expect.poll(() => app.calls<{ id: string }>('projects:delete').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.evaluate(() => window.__mock.state.projects.some((item) => item.name === '海报'))).toBe(false)
    await expect.poll(() => switcher.textContent()).not.toContain('海报')
    await settle(page)
  })
})
