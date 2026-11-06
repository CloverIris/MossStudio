/**
 * 模型: the recommended model as one entry with one action, download progress,
 * LoRA, components only under 高级, and the location switcher only with 远程主机.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { useApp } from '../support/app'

describe('models', () => {
  const app = useApp()
  const featured = (page: Page) => page.locator('[data-oobe="model"]')

  it('downloads the recommended model with one action and shows its progress', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', theme: 'light' })
    const card = featured(page)
    await expect.poll(() => card.getByText('推荐模型').isVisible()).toBe(true)
    await expect.poll(() => card.getByRole('heading', { name: 'MOSS-Image SFT' }).isVisible()).toBe(true)
    // One entry, one action; the parts it is made of are not listed here.
    expect(await card.getByRole('button').count()).toBe(1)
    await card.getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft' }])
    expect(await page.evaluate(() => window.__mock.state.downloads.length)).toBe(4)

    await page.evaluate(() => {
      for (const task of window.__mock.state.downloads) {
        window.__mock.emit(window.__mock.Events.download, {
          ...task,
          state: 'running',
          bytes: Math.floor(task.totalBytes / 2),
          speedBps: 40_000_000,
        })
      }
    })
    await expect.poll(() => card.getByText(/下载中 \d+%/).isVisible()).toBe(true)
    await expect.poll(() => card.getByRole('progressbar').isVisible()).toBe(true)
    expect(await card.getByRole('button', { name: '暂停' }).isVisible()).toBe(true)
    await app.screenshot('models-downloading-light')

    await page.evaluate(() => {
      for (const task of [...window.__mock.state.downloads]) window.__mock.playDownload(task)
    })
    await expect.poll(() => card.getByText('可以使用').isVisible()).toBe(true)
    await expect.poll(() => card.getByRole('button', { name: '去创作' }).isVisible()).toBe(true)
  })

  it('pauses and resumes a download', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models' })
    const card = featured(page)
    await card.getByRole('button', { name: '下载' }).click()
    await page.evaluate(() => {
      for (const task of window.__mock.state.downloads) {
        window.__mock.emit(window.__mock.Events.download, {
          ...task,
          state: 'running',
          bytes: Math.floor(task.totalBytes / 3),
          speedBps: 1,
        })
      }
    })
    await card.getByRole('button', { name: '暂停' }).click()
    await expect.poll(() => app.calls<{ taskId: string }>('models:pause').then((calls) => calls.length)).toBeGreaterThan(0)
  })

  it('lists LoRA on its own tab and downloads one', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', theme: 'light' })
    await page.getByRole('tab', { name: 'LoRA' }).click()
    const adapter = await page.evaluate(() => window.__mock.state.catalog.adapters[0]!)
    await expect.poll(() => page.getByText(adapter.name).first().isVisible()).toBe(true)
    await app.screenshot('models-lora-light')
    await page.getByText(adapter.name).first().locator('xpath=ancestor::*[.//button][1]').getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:download')).toEqual([{ kind: 'adapter', id: adapter.id }])
  })

  it('keeps components under 高级', async () => {
    const page = await app.open({ scenario: 'ready', route: '/models', theme: 'light' })
    const textEncoder = await page.evaluate(() => window.__mock.state.catalog.models.find((model) => model.role === 'text_encoder')!.name)
    // Collapsed 高级 keeps its content inert and out of the accessibility tree.
    const hidden = (text: string) =>
      page
        .getByText(text, { exact: true })
        .first()
        .evaluate((element) => Boolean(element.closest('[inert][aria-hidden="true"]')))
    await expect.poll(() => hidden('单独的部件')).toBe(true)
    expect(await hidden(textEncoder)).toBe(true)
    await page.getByRole('button', { name: /高级/ }).click()
    await expect.poll(() => hidden('单独的部件')).toBe(false)
    expect(await hidden(textEncoder)).toBe(false)
    await page.getByText('单独的部件', { exact: true }).scrollIntoViewIfNeeded()
    await app.screenshot('models-advanced-light')
  })

  it('高级: uses an existing model folder where it is (no copy), and says so', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', theme: 'light', defer: true })
    await page.evaluate(() => {
      window.__mock.state.localModelFolder = {
        path: '/workspace/Models/MOSS-Image/sft',
        name: 'MOSS-Image SFT（sft）',
        bundleId: 'moss-sft',
      }
    })
    await app.start()
    await page.getByRole('button', { name: /高级/ }).click()
    // The action says what it does: nothing is copied.
    expect(await page.getByText('复制模型文件夹到模型库').count()).toBe(0)
    const row = page.getByText('在原位置使用这个模型文件夹', { exact: true })
    await row.scrollIntoViewIfNeeded()
    await expect.poll(() => row.isVisible()).toBe(true)
    await page.getByRole('button', { name: '选择文件夹' }).last().click()
    await expect.poll(() => app.calls('models:import-folder').then((calls) => calls.length)).toBe(1)
    await expect.poll(() => page.getByText('已在原位置使用 MOSS-Image SFT（sft）').isVisible()).toBe(true)
  })

  it('shows where models live only when 远程主机 is on', async () => {
    let page = await app.open({ scenario: 'remoteHost', route: '/models' })
    await page.getByRole('heading', { name: '模型' }).first().waitFor()
    expect(await page.getByRole('group', { name: '模型所在的电脑' }).count()).toBe(0)
    expect(await app.calls('hosts:list')).toEqual([])

    page = await app.open({ scenario: 'remoteHost', route: '/models', theme: 'dark', settings: { remoteHostsEnabled: true } })
    const picker = page.getByRole('group', { name: '模型所在的电脑' })
    await expect.poll(() => picker.isVisible()).toBe(true)
    await picker.getByRole('button', { name: 'Linux GPU' }).click()
    await expect.poll(() => app.calls<{ hostId: string }>('models:remote-inventory').then((calls) => calls.at(-1)?.hostId)).toBe('ssh-gpu')
    await expect.poll(() => page.getByText(/模型保存在 Linux GPU 上/).isVisible()).toBe(true)
    await app.screenshot('models-remote-dark')
  })
})
