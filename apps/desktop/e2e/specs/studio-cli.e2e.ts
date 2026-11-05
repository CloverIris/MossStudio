/**
 * 创作 on a machine whose only GPU runs moss-infer-vulkan (兼容模式): text to
 * image only. The inputs it cannot do are hidden with one quiet line saying
 * why, LoRA cannot be added (and one already on the canvas blocks 生成 with
 * the reason), and a plain run goes through.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { JobParams } from '@shared/types'
import { settle, useApp, type E2eApp } from '../support/app'

const ENGINE_JOBS = 'http:POST /api/engine-jobs'
const NOTE = '这台设备用兼容模式引擎，只能文生图：LoRA、起始图、遮罩、控制、参考图、高清修复和更换采样器都不可用。'

async function openStudio(app: E2eApp, options: { lora?: boolean; theme?: 'light' | 'dark' } = {}): Promise<Page> {
  const page = await app.open({ scenario: 'vulkanOnly', route: '/studio', defer: true, theme: options.theme })
  await page.evaluate((lora) => {
    const { canvasFixture, projectFixture } = window.__mock.fixtures
    const picture = canvasFixture({
      id: 'img-1', kind: 'image', title: '小猫照片', imagePath: '/fixture/projects/project-1/assets/cat.png', x: 0, y: 0, width: 1024, height: 768, steps: 1,
    })
    const layout = canvasFixture({
      id: 'canvas-1', title: '画面 1', prompt: '一只橘猫坐在窗台上', x: 420, y: 0, seedLocked: false,
      ...(lora ? { adapters: [{ id: window.__mock.state.catalog.adapters[0]!.id, strength: 0.8 }] } : {}),
    })
    window.__mock.state.projects = [projectFixture({ id: 'project-1', name: '小猫', canvases: [picture, layout], selectedCanvasId: 'canvas-1' })]
  }, Boolean(options.lora))
  await app.start()
  await page.locator('article[data-canvas-card="canvas-1"]').waitFor()
  await settle(page, 150)
  return page
}

const note = (page: Page) => page.locator('[data-cli-engine-note]')
const generate = (page: Page) => page.locator('[data-studio-generate]')

describe('studio on a 兼容模式 (Vulkan) engine', () => {
  const app = useApp()

  it('shows 文生图 only: no picture inputs, no LoRA picker, no sampler or 高清修复, with one quiet explanation', async () => {
    const page = await openStudio(app)
    await expect.poll(() => note(page).textContent()).toBe(NOTE)
    expect(await page.locator('[data-inputs-section]').count()).toBe(0)
    expect(await page.getByRole('button', { name: '添加起始图' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '添加参考图' }).count()).toBe(0)
    expect(await page.locator('[data-control-row]').count()).toBe(0)
    expect(await page.locator('[data-adapter-picker]').count()).toBe(0)

    await page.getByRole('button', { name: /高级/ }).first().click()
    await page.locator('[data-sampling-section]').waitFor()
    expect(await page.getByRole('combobox', { name: '采样器' }).count()).toBe(0)
    expect(await page.getByRole('switch', { name: '高清修复' }).count()).toBe(0)
    expect(await page.getByRole('combobox', { name: '步缓存' }).count()).toBe(0)
    expect(await page.getByRole('textbox', { name: 'CFG 截断' }).count()).toBe(0)
    // Shift is a flag of the CLI: still there.
    expect(await page.getByRole('textbox', { name: 'Shift' }).count()).toBe(1)
  })

  it('a plain run goes through with no inputs and no LoRA', async () => {
    const page = await openStudio(app)
    await expect.poll(() => generate(page).isEnabled()).toBe(true)
    await generate(page).click()
    await page.waitForFunction((channel) => window.__mock.callsTo(channel).length >= 1, ENGINE_JOBS)
    const [body] = await page.evaluate((channel) => window.__mock.callsTo(channel) as Array<JobParams & { adapters?: unknown[] }>, ENGINE_JOBS)
    expect(body!.prompt).toContain('一只橘猫坐在窗台上')
    expect(body!.adapters ?? []).toEqual([])
    for (const key of ['initImage', 'mask', 'control', 'references'] as const) expect(body![key]).toBeUndefined()
  })

  it('a LoRA already on the canvas stays removable and blocks 生成 until it is removed', async () => {
    const page = await openStudio(app, { lora: true })
    const blocker = page.getByText('兼容模式引擎不支持 LoRA，请移除 LoRA 后再生成')
    await expect.poll(() => blocker.isVisible()).toBe(true)
    expect(await generate(page).isDisabled()).toBe(true)
    expect(await page.locator('[data-adapter-picker]').count()).toBe(0)
    await page.locator('[data-adapter-row]').getByRole('button', { name: /^移除/ }).click()
    await expect.poll(() => blocker.count()).toBe(0)
    await expect.poll(() => generate(page).isEnabled()).toBe(true)
  })

  it('looks right, light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await openStudio(app, { theme })
      await expect.poll(() => note(page).isVisible()).toBe(true)
      await app.screenshot(`studio-cli-${theme}`)
    }
  })
})
