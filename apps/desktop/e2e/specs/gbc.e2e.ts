/**
 * 看图拆区域: 拆成区域 in a picture's menu fills a new 画面 with the regions
 * KohakuGBC finds, and 设置 › 功能 sets it up.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { ProjectCanvas, Settings } from '@shared/types'
import { settle, useApp, type E2eApp } from '../support/app'

const PICTURE = '/fixture/projects/project-1/assets/cat-1600x1200.png'

interface Setup {
  settings?: Partial<Settings>
  /** GBC is installed and runs. */
  ready?: boolean
  /** The 助手 has a model that can read pictures. */
  provider?: boolean
  theme?: 'light' | 'dark'
}

/** A project with one imported picture (img-1) and one 画面 (canvas-1). */
async function openBoard(app: E2eApp, setup: Setup = {}): Promise<Page> {
  const page = await app.open({
    scenario: 'ready',
    route: '/studio',
    defer: true,
    theme: setup.theme,
    settings: { gbcEnabled: true, ...setup.settings },
  })
  await page.evaluate(
    ({ picturePath, ready, provider }) => {
      const { canvasFixture, projectFixture, aiProviderFixture, gbcStatusFixture } = window.__mock.fixtures
      const picture = canvasFixture({
        id: 'img-1',
        kind: 'image',
        title: '小猫照片',
        imagePath: picturePath,
        imageSize: { width: 1600, height: 1200 },
        x: 0,
        y: 0,
        width: 1024,
        height: 768,
      })
      const layout = canvasFixture({ id: 'canvas-1', title: '画面 1', prompt: '一只橘猫坐在窗台上', x: 0, y: 300 })
      window.__mock.state.projects = [
        projectFixture({ id: 'project-1', name: '小猫', canvases: [picture, layout], selectedCanvasId: 'canvas-1' }),
      ]
      window.__mock.state.aiProviders = provider
        ? [
            aiProviderFixture({ id: 'local', kind: 'ollama', name: 'Ollama' }),
            aiProviderFixture({ id: 'claude', kind: 'anthropic', name: 'Claude' }),
          ]
        : []
      window.__mock.state.gbc.status = gbcStatusFixture(ready)
    },
    { picturePath: PICTURE, ready: setup.ready ?? true, provider: setup.provider ?? true },
  )
  await app.start()
  await page.locator('article[data-canvas-card="img-1"]').waitFor()
  await settle(page, 150)
  return page
}

const card = (page: Page, id: string) => page.locator(`article[data-canvas-card="${id}"]`)

async function pictureMenu(page: Page): Promise<string[]> {
  const body = (await card(page, 'img-1').locator('[data-card-body]').boundingBox())!
  await page.mouse.click(body.x + body.width / 2, body.y + body.height / 2, { button: 'right' })
  const menu = page.getByRole('menu', { name: '小猫照片 操作' })
  await menu.waitFor()
  return menu.getByRole('menuitem').allTextContents()
}

async function cardIds(page: Page): Promise<string[]> {
  return page.locator('article[data-canvas-card]').evaluateAll((items) => items.map((item) => item.getAttribute('data-canvas-card')!))
}

async function saved(page: Page, id: string): Promise<ProjectCanvas | undefined> {
  return page.evaluate((canvasId) => window.__mock.state.projects[0]?.canvases.find((canvas) => canvas.id === canvasId), id)
}

describe('拆成区域', () => {
  const app = useApp()

  it('is not offered while 看图拆区域 is off', async () => {
    const page = await openBoard(app, { settings: { gbcEnabled: false } })
    expect(await pictureMenu(page)).toEqual(['用作起始图', '放大', '复制', '删除'])
    expect(await app.calls('gbc:status')).toEqual([])
  })

  it('fills a new 画面 beside the picture with its regions and description', async () => {
    const page = await openBoard(app)
    expect(await pictureMenu(page)).toEqual(['用作起始图', '拆成区域', '放大', '复制', '删除'])
    await app.screenshot('gbc-picture-menu-light')
    await page.getByRole('menuitem', { name: '拆成区域' }).click()

    await expect.poll(async () => (await cardIds(page)).length).toBe(3)
    const created = (await cardIds(page)).find((id) => id !== 'img-1' && id !== 'canvas-1')!
    const call = (await app.calls<{ runId: string; path: string }>('gbc:parse'))[0]!
    expect(call.path).toBe(PICTURE)
    await expect.poll(() => card(page, created).locator('[data-region-id]').count()).toBe(2)
    await expect.poll(() => page.getByText('已拆出 2 个区域').isVisible()).toBe(true)

    await expect.poll(() => saved(page, created).then((item) => item?.layers.length), { timeout: 10_000 }).toBe(2)
    const canvas = await saved(page, created)
    expect(canvas!.prompt).toBe('午后的窗台，阳光照在一只睡着的橘猫身上')
    expect(canvas!.layers.map((region) => [region.kind, region.caption])).toEqual([
      ['object', '趴着睡觉的橘猫'],
      ['object', '窗外的晴天'],
    ])
    // Shaped like the 4:3 picture, and only its layout: no wire from the picture.
    expect(canvas!.width / canvas!.height).toBeCloseTo(4 / 3, 1)
    expect(canvas!.inputs).toBeUndefined()
    expect(await page.locator(`[data-wire-chip^="input:${created}:"]`).count()).toBe(0)
    const source = (await card(page, 'img-1').boundingBox())!
    const fresh = (await card(page, created).boundingBox())!
    expect(fresh.x).toBeGreaterThan(source.x + source.width)
    expect(await card(page, created).getAttribute('aria-current')).toBe('true')
    await app.screenshot('gbc-regions-light')
  })

  it('shows the picture faintly while reading; 停止 takes the empty 画面 away', async () => {
    const page = await openBoard(app, { theme: 'dark' })
    // Reading takes as long as the test wants; 停止 ends it the way main does, answering null.
    await page.evaluate(() => {
      const mock = window.__mock as typeof window.__mock & { release?: (value: null) => void }
      mock.handle(mock.Ipc.gbcParse, (payload, { emit }) => {
        emit(mock.Events.gbcParse, { runId: (payload as { runId: string }).runId, phase: 'download', percent: 40 })
        return new Promise((resolve) => {
          mock.release = resolve
        })
      })
      mock.handle(mock.Ipc.gbcCancel, () => {
        mock.release?.(null)
        return true
      })
    })
    await pictureMenu(page)
    await page.getByRole('menuitem', { name: '拆成区域' }).click()
    const status = page.locator('[data-card-status="parsing"]')
    await status.waitFor()
    await expect.poll(() => status.textContent()).toContain('正在下载看图模型')
    expect(await status.textContent()).toContain('40% · 只有第一次')
    await app.screenshot('gbc-reading-dark')

    await status.getByRole('button', { name: '停止' }).click()
    const runId = (await app.calls<{ runId: string }>('gbc:parse'))[0]!.runId
    expect(await app.calls('gbc:cancel')).toEqual([{ runId }])
    await expect.poll(() => cardIds(page)).toEqual(['img-1', 'canvas-1'])
  })

  it('a failure says why and takes the empty 画面 away', async () => {
    const page = await openBoard(app)
    await page.evaluate(() => window.__mock.fail(window.__mock.Ipc.gbcParse, { code: 'E_GBC', message: '没在这张图里找到物体' }))
    await pictureMenu(page)
    await page.getByRole('menuitem', { name: '拆成区域' }).click()
    await expect.poll(() => page.getByText('没拆成：没在这张图里找到物体').isVisible()).toBe(true)
    await expect.poll(() => cardIds(page)).toEqual(['img-1', 'canvas-1'])
  })

  it('says what is missing, and leads to 设置', async () => {
    const page = await openBoard(app, { provider: false })
    await pictureMenu(page)
    const entry = page.getByRole('menuitem', { name: /拆成区域/ })
    expect(await entry.textContent()).toBe('拆成区域 先给助手加一个模型')

    const notInstalled = await openBoard(app, { ready: false })
    await pictureMenu(notInstalled)
    expect(await notInstalled.getByRole('menuitem', { name: /拆成区域/ }).textContent()).toBe('拆成区域 看图还没装好')
    await notInstalled.getByRole('menuitem', { name: /拆成区域/ }).click()
    await expect.poll(() => notInstalled.evaluate(() => window.location.hash)).toBe('#/settings/features')
    expect(await app.calls('gbc:parse')).toEqual([])
  })
})

describe('设置 › 功能 › 看图拆区域', () => {
  const app = useApp()

  async function openSettings(theme: 'light' | 'dark' = 'light'): Promise<Page> {
    const page = await app.open({ route: '/settings/features', defer: true, theme })
    await page.evaluate(() => {
      const { aiProviderFixture } = window.__mock.fixtures
      window.__mock.state.aiProviders = [
        aiProviderFixture({ id: 'local', kind: 'ollama', name: 'Ollama', model: 'llava' }),
        aiProviderFixture({ id: 'claude', kind: 'anthropic', name: 'Claude', model: 'claude-sonnet' }),
        aiProviderFixture({ id: 'gpt', kind: 'openai', name: 'GPT', model: 'gpt-x' }),
      ]
    })
    await app.start()
    return page
  }

  it('turning it on shows its setup; 安装 makes it ready', async () => {
    const page = await openSettings()
    expect(await page.getByRole('heading', { name: '看图拆区域' }).count()).toBe(0)
    await page.getByRole('switch', { name: '看图拆区域' }).click()
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ gbcEnabled: true })
    await page.getByRole('heading', { name: '看图拆区域' }).waitFor()

    // Only models that can read pictures are offered.
    const model = page.getByRole('combobox', { name: '看图的模型' })
    await expect.poll(() => model.locator('option').allTextContents()).toEqual(['Claude · claude-sonnet', 'GPT · gpt-x'])
    await model.selectOption('gpt')
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ gbcProviderId: 'gpt' })

    await page.getByRole('button', { name: '安装' }).waitFor()
    await app.screenshot('gbc-settings-light')
    await page.getByRole('button', { name: '安装' }).click()
    await page.getByText('可以用', { exact: true }).waitFor()
    expect(await app.calls('gbc:setup')).toHaveLength(1)

    await page.getByRole('button', { name: /^高级/ }).click()
    await expect.poll(() => page.getByText('正在使用').isVisible()).toBe(true)
    await page.getByRole('combobox', { name: '找物体的方式' }).selectOption('sam3')
    await expect.poll(() => app.calls('settings:update').then((calls) => calls.at(-1))).toEqual({ gbcDetector: 'sam3' })
  })

  it('says to add a model first when the 助手 has none that reads pictures', async () => {
    const page = await app.open({ route: '/settings/features', settings: { gbcEnabled: true }, theme: 'dark' })
    await page.getByText('先在助手里添加一个 OpenAI 兼容或 Anthropic 的模型，并填好 API Key。').waitFor()
    expect(await page.getByRole('combobox', { name: '看图的模型' }).count()).toBe(0)
    await app.screenshot('gbc-settings-dark')
  })
})
