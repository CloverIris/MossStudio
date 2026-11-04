/**
 * 作品: the list and its filters, the detail panel with ← →, 在创作中复用 and 删除.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash)

describe('library', () => {
  const app = useApp()

  async function openLibrary(): Promise<Page> {
    const page = await app.open({ scenario: 'ready', route: '/library', theme: 'light', defer: true })
    await page.evaluate(() => {
      const { galleryItemFixture } = window.__mock.fixtures
      window.__mock.state.gallery = [0, 1, 2, 3].map((index) => galleryItemFixture(index, {
        prompt: ['海边的灯塔', '雨夜街道', '森林小径', '雪山湖泊'][index],
        seed: 1000 + index,
        projectId: index < 2 ? 'project-1' : undefined,
      }))
      window.__mock.state.projects = [window.__mock.fixtures.projectFixture({ id: 'project-1', name: '风景' })]
    })
    await app.start()
    await page.getByRole('heading', { name: '作品' }).waitFor()
    return page
  }

  const tiles = (page: Page) => page.locator('[data-library-item]')

  it('lists images and filters them by text, project and time', async () => {
    const page = await openLibrary()
    await expect.poll(() => tiles(page).count()).toBe(4)
    await expect.poll(() => page.getByText('4 张').isVisible()).toBe(true)

    await page.getByRole('searchbox').fill('雨夜')
    await expect.poll(() => tiles(page).count()).toBe(1)
    await expect.poll(() => app.calls<{ query?: string }>('gallery:list').then((calls) => calls.at(-1)?.query)).toBe('雨夜')

    // Nothing matches: say so and offer to clear.
    await page.getByRole('searchbox').fill('不存在的图片')
    await expect.poll(() => tiles(page).count()).toBe(0)
    await page.getByRole('button', { name: '清除筛选' }).click()
    await expect.poll(() => tiles(page).count()).toBe(4)

    await page.getByRole('combobox', { name: '按项目筛选' }).selectOption({ label: '风景' })
    await expect.poll(() => app.calls<{ projectId?: string }>('gallery:list').then((calls) => calls.at(-1)?.projectId)).toBe('project-1')
    await expect.poll(() => tiles(page).count()).toBe(2)
    await page.getByRole('combobox', { name: '按项目筛选' }).selectOption({ label: '全部项目' })

    const times = await page.getByRole('combobox', { name: '按时间筛选' }).locator('option').allTextContents()
    expect(times.length).toBeGreaterThan(1)
    await page.getByRole('combobox', { name: '按时间筛选' }).selectOption({ index: 1 })
    await expect.poll(() => app.calls<{ since?: number }>('gallery:list').then((calls) => typeof calls.at(-1)?.since)).toBe('number')
  })

  it('steps through the detail panel with ← → and the buttons', async () => {
    const page = await openLibrary()
    await tiles(page).first().click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    await expect.poll(() => detail.getByText('1 / 4').isVisible()).toBe(true)
    await expect.poll(() => detail.getByText('海边的灯塔').count()).toBeGreaterThan(0)
    await app.screenshot('library-detail-light')

    await page.keyboard.press('ArrowRight')
    await expect.poll(() => detail.getByText('2 / 4').isVisible()).toBe(true)
    await expect.poll(() => detail.getByText('雨夜街道').count()).toBeGreaterThan(0)
    await detail.getByRole('button', { name: '下一张（→）' }).click()
    await expect.poll(() => detail.getByText('3 / 4').isVisible()).toBe(true)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => detail.getByText('2 / 4').isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => detail.count()).toBe(0)
  })

  it('reuses an image in 创作 as a new, prefilled canvas', async () => {
    const page = await openLibrary()
    // Visit 创作 first so it has a project with one canvas.
    await page.getByRole('button', { name: '创作' }).click()
    await page.locator('[data-project-switcher]').waitFor()
    const cards = page.locator('article[data-canvas-card]')
    const before = await cards.count()
    await page.getByRole('button', { name: '作品' }).click()

    await tiles(page).nth(1).click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    const reuse = detail.getByRole('button', { name: '在创作中复用' })
    await expect.poll(() => reuse.isEnabled()).toBe(true)
    await reuse.click()
    await expect.poll(() => hash(page)).toBe('#/studio')
    await expect.poll(() => cards.count()).toBe(before + 1)
    await expect.poll(() => page.getByRole('textbox', { name: '描述', exact: true }).inputValue()).toBe('雨夜街道')
    // The new canvas is the selected one, with the image's seed kept.
    expect(await page.locator('article[data-canvas-card][aria-current="true"]').count()).toBe(1)
    await page.getByRole('button', { name: /高级/ }).click()
    await expect.poll(() => page.getByRole('textbox', { name: '种子' }).inputValue()).toBe('1001')
  })

  it('deletes after confirmation, moving the file to the trash', async () => {
    const page = await openLibrary()
    await tiles(page).nth(2).click()
    const detail = page.getByRole('complementary', { name: '作品详情' })
    await detail.getByRole('button', { name: '删除' }).click()
    const confirm = page.getByRole('dialog')
    await expect.poll(() => confirm.getByText('删除这张图片？').isVisible()).toBe(true)
    await app.screenshot('library-delete-confirm-light')
    // 取消 leaves it alone.
    await confirm.getByRole('button', { name: '取消' }).click()
    expect(await app.calls('gallery:trash')).toEqual([])

    await detail.getByRole('button', { name: '删除' }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^移到/ }).click()
    await expect.poll(() => app.calls<{ path: string }>('gallery:trash')).toEqual([{ path: '/fixture/outputs/moss_0002.png' }])
    await expect.poll(() => tiles(page).count()).toBe(3)
    await expect.poll(() => page.getByText('3 张').isVisible()).toBe(true)
  })
})
