/**
 * 模型: every engine-certified model under 推荐模型 with the best one for this
 * computer featured (one entry, one action), download progress, LoRA,
 * components only under 高级, and the location switcher only with 远程主机.
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
    await expect.poll(() => page.getByRole('heading', { name: '推荐模型' }).isVisible()).toBe(true)
    // An RTX 4090 has VRAM to spare: the official model is the best pick.
    await expect.poll(() => card.getByText('最适合这台电脑').isVisible()).toBe(true)
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

  it('lists every certified model under 推荐模型 and the unverified ones under 其他模型', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', theme: 'light' })
    const section = (title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    const recommended = section('推荐模型')
    await expect.poll(() => recommended.isVisible()).toBe(true)
    for (const name of [
      'MOSS-Image SFT',
      'MOSS-Image Base',
      'SFT · INT8',
      'SFT · NVFP4',
      'SFT · INT4',
      'SFT Turbo · INT8 8 步',
      'Base · INT8',
    ]) {
      expect(await recommended.getByText(name, { exact: true }).count()).toBe(1)
    }
    expect(await recommended.getByText('显存占用约减四成，速度约快 2.5 倍，日常首选。', { exact: false }).count()).toBe(1)
    const others = section('其他模型')
    expect(await others.getByText('引擎没有验证过', { exact: false }).count()).toBeGreaterThan(0)
    expect(await others.getByText('SFT · FP16-fixed', { exact: true }).count()).toBe(1)
    expect(await recommended.getByText('SFT · FP16-fixed', { exact: true }).count()).toBe(0)
    await app.screenshot('models-certified-light')

    // NVFP4 runs only on RTX 50: this RTX 4090 says why and offers no download.
    const nvfp4 = recommended
      .getByText('SFT · NVFP4', { exact: true })
      .locator('xpath=ancestor::*[.//button or .//span[text()="用不了"]][1]')
    await expect.poll(() => nvfp4.getByText('只能在 RTX 50 系列显卡上运行').isVisible()).toBe(true)
    expect(await nvfp4.getByText('用不了', { exact: true }).isVisible()).toBe(true)
    expect(await nvfp4.getByRole('button', { name: '下载' }).count()).toBe(0)

    // A single-file model downloads its four files in one action.
    const int8 = recommended.getByText('SFT · INT8', { exact: true }).locator('xpath=ancestor::*[.//button][1]')
    await int8.getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft-int8' }])
    expect(await page.evaluate(() => window.__mock.state.downloads.map((task) => task.targetId))).toEqual([
      'moss-sft-comfy-int8_convrot',
      'qwen35-comfy-int8_convrot',
      'flux2-vae-comfy-small',
      'moss-runtime-config',
    ])
  })

  it('features the NVFP4 model on an RTX 50 card', async () => {
    const page = await app.open({ scenario: 'modelMissingRtx50', route: '/models', theme: 'dark' })
    const card = featured(page)
    await expect.poll(() => card.getByRole('heading', { name: 'SFT · NVFP4' }).isVisible()).toBe(true)
    expect(await card.getByText('最适合这台电脑').isVisible()).toBe(true)
    expect(await card.getByText(/RTX 5090 这类显卡做的版本/).isVisible()).toBe(true)
    await card.getByRole('button', { name: '下载' }).click()
    await expect.poll(() => app.calls('models:install-bundle')).toEqual([{ id: 'moss-sft-nvfp4' }])
    await app.screenshot('models-rtx50-dark')
  })

  it('offers only the official models when the GPU runs 兼容模式', async () => {
    const page = await app.open({ scenario: 'engineInstalledModelMissing', route: '/models', defer: true })
    await page.evaluate(() => {
      const gpu = window.__mock.state.gpuInventory.devices[0]!
      window.__mock.state.engineReadiness = {
        ...window.__mock.state.engineReadiness,
        devices: [{ deviceUuid: gpu.uuid, name: gpu.name, packageId: 'vulkan', path: null }],
      }
    })
    await app.start()
    const card = featured(page)
    await expect.poll(() => card.getByRole('heading', { name: 'MOSS-Image SFT' }).isVisible()).toBe(true)
    expect(await card.getByText('上的引擎只能运行官方模型', { exact: false }).isVisible()).toBe(true)
    const int8 = page.getByText('SFT · INT8', { exact: true }).locator('xpath=ancestor::*[.//span[text()="用不了"]][1]')
    await expect.poll(() => int8.getByText('上的引擎只能运行官方模型', { exact: false }).isVisible()).toBe(true)
    expect(await int8.getByRole('button', { name: '下载' }).count()).toBe(0)
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
    const row = page.getByText('添加整个模型文件夹', { exact: true })
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
    // Single files load only on this computer: offered there, not on the SSH host.
    await expect.poll(() => page.getByText('只能在这台电脑上使用，其他电脑请用官方模型').first().isVisible()).toBe(true)
    const int8 = page.getByText('SFT · INT8', { exact: true }).locator('xpath=ancestor::*[.//span[text()="用不了"]][1]')
    expect(await int8.getByRole('button', { name: '下载' }).count()).toBe(0)
    await app.screenshot('models-remote-dark')
  })
})
